// Writes a massing model as .epJSON, its natural-ventilation hours from a weather file.
//   node tools/write_massing.mjs <out.epJSON> [weather.epw] [massing.json]
// Without a massing file it writes the default: two storeys of 20 x 10 m, 3.5 m high, four windows a side.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEPW } from '../src/model/weather.js';
import { massing0, massingEpJSON } from '../src/model/massing.js';

const [out, epw, file] = process.argv.slice(2);
if (!out) { console.error('usage: node tools/write_massing.mjs <out.epJSON> [weather.epw] [massing.json]'); process.exit(1); }
const m = file ? JSON.parse(readFileSync(file, 'utf8')) : massing0();
const weather = epw ? parseEPW(readFileSync(epw, 'utf8')) : null;
writeFileSync(out, JSON.stringify(massingEpJSON(m, { weather }), null, 1));
console.log(`wrote ${out}`);
