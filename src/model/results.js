// Zone conditions, hour by hour, from an EnergyPlus results file (.eso) such as the one in every
// ClimateStudio results folder: air temperature, humidity and whether the zone's natural ventilation
// was running. Hourly values are used where reported; finer ones are averaged to hours.

import { readEsoStream } from './eso.js';
import { humidityRatioFromRH } from './weather.js';

const WANTED = [
  'Zone Mean Air Temperature', 'Zone Air Humidity Ratio', 'Zone Air Relative Humidity',
  'Zone Ventilation Total Heat Loss Energy', 'Zone Ventilation Total Heat Gain Energy',
  'AFN Zone Ventilation Air Change Rate',
];
export const keepZoneResults = (key, variable) => WANTED.includes(variable);

export const readZoneResultsStream = (stream, model, onProgress) =>
  readEsoStream(stream, keepZoneResults, onProgress).then((eso) => zoneResults(eso, model));

// Hourly series (the last 8,760 values, after any sizing periods) for one zone and variable.
function hourly(eso, variable, zone) {
  const h = eso.find(variable, zone, 'Hourly');
  if (h && h.length >= 8760) return h.slice(-8760);
  const t = eso.find(variable, zone, 'TimeStep');
  if (!t || t.length < 8760 || t.length % 8760) return null;
  const per = t.length / 8760, v = t.slice(-8760 * per), out = new Array(8760);
  for (let i = 0; i < 8760; i++) {
    let s = 0;
    for (let k = 0; k < per; k++) s += v[i * per + k];
    out[i] = s / per;
  }
  return out;
}

// { zones: { [model zone]: { t, w?, rh?, vent? } (8,760 values each) }, missing: [zone names] }
export function zoneResults(eso, model) {
  const zones = {}, missing = [];
  for (const name of Object.keys(model.zones)) {
    const t = hourly(eso, 'Zone Mean Air Temperature', name);
    if (!t) { missing.push(name); continue; }
    const loss = hourly(eso, 'Zone Ventilation Total Heat Loss Energy', name);
    const gain = hourly(eso, 'Zone Ventilation Total Heat Gain Energy', name);
    const ach = hourly(eso, 'AFN Zone Ventilation Air Change Rate', name);
    zones[name] = {
      t,
      w: hourly(eso, 'Zone Air Humidity Ratio', name),
      rh: hourly(eso, 'Zone Air Relative Humidity', name),
      // Ventilation ran in an hour if it moved any heat (simple airflow) or air (airflow network).
      vent: loss || gain || ach ? t.map((_, i) => (loss?.[i] || 0) + (gain?.[i] || 0) + (ach?.[i] || 0) > 0) : null,
    };
  }
  return { zones, missing };
}

// One zone's conditions at an hour index (0 to 8759); pressure (Pa) for humidity from relative humidity.
export function zoneAt(results, zone, i, pressure = 101325) {
  const z = results.zones[zone];
  if (!z) return null;
  const w = z.w ? z.w[i] : z.rh ? humidityRatioFromRH(z.t[i], z.rh[i], pressure) : 0.008;
  return { t: z.t[i], w, vent: z.vent ? z.vent[i] : null };
}
