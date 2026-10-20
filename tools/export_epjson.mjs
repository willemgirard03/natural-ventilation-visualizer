// Imports an .epJSON into the project model and writes it back out through the exporter.
// Used for the round-trip test: EnergyPlus results from the written file must match the original's.
//
//   node tools/export_epjson.mjs <input.epJSON> <output.epJSON>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importEpJSON } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/export_epjson.mjs <input.epJSON> <output.epJSON>');
  process.exit(2);
}
const model = importEpJSON(JSON.parse(readFileSync(input, 'utf8')), { fileName: path.basename(input) });
mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
writeFileSync(output, serializeEpJSON(exportEpJSON(model)));
const counts = (o) => Object.keys(o).length;
console.log(`${counts(model.zones)} zones, ${counts(model.surfaces)} surfaces, ${counts(model.windows)} windows, ${model.checks.length} checks -> ${output}`);
