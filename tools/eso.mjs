// Reads an EnergyPlus .eso results file: every reported variable's values, in time order.
// A variable can be reported at several frequencies, so each series is keyed by key, variable and
// frequency. Returns { series: Map("KEY|Variable name|Frequency" -> number[]), find(variable, key, frequency) }.
import { readFileSync } from 'node:fs';

export function readEso(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const names = new Map();
  let i = 0;
  for (; i < lines.length && !lines[i].startsWith('End of Data Dictionary'); i++) {
    const m = lines[i].match(/^(\d+),\d+,([^,]*),([^[!]+?)\s*(?:\[[^\]]*\])?\s*!\s*(\w+)/);
    if (m && Number(m[1]) > 6) names.set(m[1], `${m[2].toUpperCase()}|${m[3].trim()}|${m[4]}`);
  }
  const series = new Map([...names.values()].map((n) => [n, []]));
  for (i++; i < lines.length; i++) {
    const c = lines[i].indexOf(',');
    if (c < 0) continue;
    const name = names.get(lines[i].slice(0, c));
    if (name) series.get(name).push(Number(lines[i].slice(c + 1).split(',')[0]));
  }
  const find = (variable, key, frequency = 'TimeStep') => series.get(`${String(key).toUpperCase()}|${variable}|${frequency}`);
  return { series, find };
}
