// Zone conditions, hour by hour, from an EnergyPlus results file (.eso) such as the one in every
// ClimateStudio results folder: air temperature, humidity, CO2 and whether the zone's natural
// ventilation was running. Hourly values are used where reported; finer ones are averaged to hours.
// A run reported at its timesteps (the tool's week reruns) also keeps them, averaged to the step asked
// (10 to 60 min), as `fine`; the values at any moment come from momentary readers (zoneAtTime and the
// rest), which interpolate between the steps' (or hours') means.

import { readEsoStream } from './eso.js';
import { humidityRatioFromRH } from './weather.js';

const WANTED = [
  'Zone Mean Air Temperature', 'Zone Air Humidity Ratio', 'Zone Air Relative Humidity',
  'Zone Ventilation Total Heat Loss Energy', 'Zone Ventilation Total Heat Gain Energy',
  'AFN Zone Ventilation Air Change Rate', 'AFN Surface Venting Window or Door Opening Factor',
  'Surface Inside Face Temperature', 'Zone Air CO2 Concentration',
];
export const keepZoneResults = (key, variable) => WANTED.includes(variable);

export const readZoneResultsStream = (stream, model, onProgress, options) =>
  readEsoStream(stream, keepZoneResults, onProgress).then((eso) => zoneResults(eso, model, options));

// How far a window or door was open in the results at an hour index (0 to 1), or null if not reported.
export const windowAt = (results, name, i) => results.windows?.[String(name).toUpperCase()]?.[i] ?? null;

// Hourly series for one zone (or surface) and variable: hourly values where reported, finer ones
// averaged to hours. A year-long run gives 8,760 (the last ones, after any sizing periods); a shorter
// run, its own hours.
function hourly(eso, variable, key, hours) {
  const h = eso.find(variable, key, 'Hourly');
  if (h && h.length >= hours) return h.slice(-hours);
  const t = eso.find(variable, key, 'TimeStep');
  if (!t || t.length < hours || t.length % hours) return null;
  const per = t.length / hours, v = t.slice(-hours * per), out = new Array(hours);
  for (let i = 0; i < hours; i++) {
    let s = 0;
    for (let k = 0; k < per; k++) s += v[i * per + k];
    out[i] = s / per;
  }
  return out;
}

// Timestep series averaged to `per` values an hour, over the run's last `hours`; null if the run did
// not report this one at its timesteps, or its timesteps do not divide into the steps asked.
function stepped(eso, variable, key, hours, per) {
  const t = eso.find(variable, key, 'TimeStep');
  if (!t || t.length < hours || t.length % hours) return null;
  const own = t.length / hours;
  if (own % per) return null;
  const k = own / per, v = t.slice(-hours * own), out = new Array(hours * per);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += v[i * k + j];
    out[i] = s / k;
  }
  return out;
}

// { zones: { [model zone]: { t, w?, rh?, co2?, vent? } }, windows: { [WINDOW OR DOOR NAME]: open factor },
//   hours, missing: [zone names], fine? }. hours: 8,760 for a year, or the run's length.
// step (min): below 60, the timestep values averaged to steps of this length are kept too, as
//   fine: { per (steps an hour), hours, zones, windows, surfaces }, the same shapes per step.
export function zoneResults(eso, model, { hours = 8760, step = 60 } = {}) {
  const zones = {}, missing = [];
  for (const name of Object.keys(model.zones)) {
    const t = hourly(eso, 'Zone Mean Air Temperature', name, hours);
    if (!t) { missing.push(name); continue; }
    const loss = hourly(eso, 'Zone Ventilation Total Heat Loss Energy', name, hours);
    const gain = hourly(eso, 'Zone Ventilation Total Heat Gain Energy', name, hours);
    const ach = hourly(eso, 'AFN Zone Ventilation Air Change Rate', name, hours);
    zones[name] = {
      t,
      w: hourly(eso, 'Zone Air Humidity Ratio', name, hours),
      rh: hourly(eso, 'Zone Air Relative Humidity', name, hours),
      co2: hourly(eso, 'Zone Air CO2 Concentration', name, hours),
      // Ventilation ran in an hour if it moved any heat (simple airflow) or air (airflow network).
      vent: loss || gain || ach ? t.map((_, i) => (loss?.[i] || 0) + (gain?.[i] || 0) + (ach?.[i] || 0) > 0) : null,
    };
  }
  // An airflow network run also reports how far each window and door was open, hour by hour; the
  // tool's reruns, every surface's inside temperature.
  const windows = {}, surfaces = {};
  for (const key of eso.series.keys()) {
    const [name, variable] = key.split('|');
    if (variable === 'AFN Surface Venting Window or Door Opening Factor') { const f = hourly(eso, variable, name, hours); if (f) windows[name] = f; }
    if (variable === 'Surface Inside Face Temperature') { const f = hourly(eso, variable, name, hours); if (f) surfaces[name] = f; }
  }
  const out = { zones, windows, surfaces, hours, missing };
  if (step < 60) {
    const per = Math.round(60 / step), fz = {}, fw = {}, fs = {};
    for (const name of Object.keys(zones)) {
      const t = stepped(eso, 'Zone Mean Air Temperature', name, hours, per);
      if (!t) continue;
      const loss = stepped(eso, 'Zone Ventilation Total Heat Loss Energy', name, hours, per);
      const gain = stepped(eso, 'Zone Ventilation Total Heat Gain Energy', name, hours, per);
      const ach = stepped(eso, 'AFN Zone Ventilation Air Change Rate', name, hours, per);
      fz[name] = {
        t,
        w: stepped(eso, 'Zone Air Humidity Ratio', name, hours, per),
        rh: stepped(eso, 'Zone Air Relative Humidity', name, hours, per),
        co2: stepped(eso, 'Zone Air CO2 Concentration', name, hours, per),
        vent: loss || gain || ach ? t.map((_, i) => (loss?.[i] || 0) + (gain?.[i] || 0) + (ach?.[i] || 0) > 0) : null,
      };
    }
    for (const key of eso.series.keys()) {
      const [name, variable] = key.split('|');
      if (variable === 'AFN Surface Venting Window or Door Opening Factor') { const f = stepped(eso, variable, name, hours, per); if (f) fw[name] = f; }
      if (variable === 'Surface Inside Face Temperature') { const f = stepped(eso, variable, name, hours, per); if (f) fs[name] = f; }
    }
    if (Object.keys(fz).length) out.fine = { per, hours, zones: fz, windows: fw, surfaces: fs };
  }
  return out;
}

// A shorter run's results laid over a year's from hour index `start` on: zone conditions and window
// openings for those hours are replaced; the rest of the year is kept.
export function mergeResults(year, part, start) {
  const zones = {};
  for (const [name, z] of Object.entries(year.zones)) {
    const p = part.zones[name];
    zones[name] = Object.fromEntries(Object.entries(z).map(([k, arr]) => {
      if (!arr || !p?.[k]) return [k, arr];
      const out = arr.slice();
      p[k].forEach((x, i) => { if (start + i < out.length) out[start + i] = x; });
      return [k, out];
    }));
    // A year without humidity ratio keeps relative humidity; where the part has a ratio, use it there.
    if (p?.w && !z.w) zones[name].w = z.t.map((_, i) => (i >= start && i < start + p.w.length ? p.w[i - start] : null));
  }
  const lay = (from, into) => {
    const out = {};
    for (const [name, f] of Object.entries(from || {})) {
      const arr = (into?.[name] || new Array(year.hours).fill(null)).slice();
      f.forEach((x, i) => { if (start + i < arr.length) arr[start + i] = x; });
      out[name] = arr;
    }
    return { ...into, ...out };
  };
  // a part's finer steps, from its start (they replace any earlier rerun's)
  const fine = part.fine ? { ...part.fine, start } : year.fine;
  return { ...year, zones, windows: lay(part.windows, year.windows), surfaces: lay(part.surfaces, year.surfaces), fine };
}

// ---------- the results at a moment ----------
// H: hours since 1 January 00:00, standard time (a fraction for a time within an hour). Each value in
// the results is the mean of its hour, or of its step in a rerun's finer steps (where those cover H),
// so it stands at the middle of its hour or step; between two middles values are interpolated in a
// straight line. Whether ventilation ran, and how far a window was open, are the hour's or step's own.
const mod = (i, n) => ((i % n) + n) % n;
const inFine = (f, t) => !!f && t >= f.start && t < f.start + f.hours;
// the mean holding moment t: the fine step's where there is one, else the hour's
function meanAt(results, hourly, fine, t) {
  const f = results.fine;
  if (fine && inFine(f, t)) return fine[Math.min(fine.length - 1, Math.floor((t - f.start) * f.per + 1e-9))] ?? null;
  return hourly ? hourly[mod(Math.floor(t + 1e-9), hourly.length)] ?? null : null;
}
// the steps (or hours) around moment H: their middles a and a + dt
function around(results, H) {
  const f = results.fine, fine = inFine(f, H), dt = fine ? 1 / f.per : 1, o = fine ? f.start : 0;
  const a = o + (Math.floor((H - o) / dt - 0.5 + 1e-9) + 0.5) * dt;
  return { a, dt, fine };
}
function lerpAt(results, hourly, fine, H) {
  const { a, dt } = around(results, H), va = meanAt(results, hourly, fine, a), vb = meanAt(results, hourly, fine, a + dt);
  if (va === null || vb === null) return va ?? vb;
  return va + (vb - va) * ((H - a) / dt);
}
// How the results stand at moment H: from the finer steps or the hours, and whether H is at a middle
// (a value as recorded) or between two (interpolated).
export function resultsTiming(results, H) {
  const { a, dt, fine } = around(results, H);
  const off = Math.min(H - a, a + dt - H);
  return { fine, minutes: Math.round(dt * 60), exact: off < 1 / 120 };
}
// A zone's conditions at moment H; pressure (Pa) for humidity from relative humidity.
export function zoneAtTime(results, zone, H, pressure = 101325) {
  const z = results.zones[zone];
  if (!z) return null;
  const f = results.fine?.zones?.[zone];
  const t = lerpAt(results, z.t, f?.t, H);
  if (t === null) return null;
  const w = z.w || f?.w ? lerpAt(results, z.w, f?.w, H) : null, rh = z.rh || f?.rh ? lerpAt(results, z.rh, f?.rh, H) : null;
  return {
    t, w: w ?? (rh !== null ? humidityRatioFromRH(t, rh, pressure) : 0.008),
    vent: z.vent || f?.vent ? meanAt(results, z.vent, f?.vent, H) : null,
    co2: z.co2 || f?.co2 ? lerpAt(results, z.co2, f?.co2, H) : null,
  };
}
// How far a window or door was open at moment H (0 to 1), or null if not reported.
export function windowAtTime(results, name, H) {
  const N = String(name).toUpperCase();
  return meanAt(results, results.windows?.[N], results.fine?.windows?.[N], H);
}
// A surface's inside temperature at moment H (degC), or null if not reported.
export function surfaceAtTime(results, name, H) {
  const N = String(name).toUpperCase();
  return lerpAt(results, results.surfaces?.[N], results.fine?.surfaces?.[N], H);
}

// One zone's conditions at an hour index (0 to 8759); pressure (Pa) for humidity from relative humidity.
export function zoneAt(results, zone, i, pressure = 101325) {
  const z = results.zones[zone];
  if (!z) return null;
  const w = z.w?.[i] ?? (z.rh ? humidityRatioFromRH(z.t[i], z.rh[i], pressure) : 0.008);
  return { t: z.t[i], w, vent: z.vent ? z.vent[i] : null, co2: z.co2?.[i] ?? null };
}

// A surface's inside temperature in the results at an hour index (degC), or null if not reported.
export const surfaceAt = (results, name, i) => results.surfaces?.[String(name).toUpperCase()]?.[i] ?? null;
