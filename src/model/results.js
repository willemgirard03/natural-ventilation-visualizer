// Zone conditions, hour by hour, from an EnergyPlus results file (.eso) such as the one in every
// ClimateStudio results folder: air temperature, humidity and whether the zone's natural ventilation
// was running. Hourly values are used where reported; finer ones are averaged to hours.

import { readEsoStream } from './eso.js';
import { humidityRatioFromRH } from './weather.js';

const WANTED = [
  'Zone Mean Air Temperature', 'Zone Air Humidity Ratio', 'Zone Air Relative Humidity',
  'Zone Ventilation Total Heat Loss Energy', 'Zone Ventilation Total Heat Gain Energy',
  'AFN Zone Ventilation Air Change Rate', 'AFN Surface Venting Window or Door Opening Factor',
  'Surface Inside Face Temperature',
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

// { zones: { [model zone]: { t, w?, rh?, vent? } }, windows: { [WINDOW OR DOOR NAME]: open factor },
//   hours, missing: [zone names] }. hours: 8,760 for a year, or the run's length.
export function zoneResults(eso, model, { hours = 8760 } = {}) {
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
  return { zones, windows, surfaces, hours, missing };
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
  return { ...year, zones, windows: lay(part.windows, year.windows), surfaces: lay(part.surfaces, year.surfaces) };
}

// One zone's conditions at an hour index (0 to 8759); pressure (Pa) for humidity from relative humidity.
export function zoneAt(results, zone, i, pressure = 101325) {
  const z = results.zones[zone];
  if (!z) return null;
  const w = z.w?.[i] ?? (z.rh ? humidityRatioFromRH(z.t[i], z.rh[i], pressure) : 0.008);
  return { t: z.t[i], w, vent: z.vent ? z.vent[i] : null };
}

// A surface's inside temperature in the results at an hour index (degC), or null if not reported.
export const surfaceAt = (results, name, i) => results.surfaces?.[String(name).toUpperCase()]?.[i] ?? null;
