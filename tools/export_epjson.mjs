// Imports an .epJSON into the project model and writes it back out through the exporter.
// Used for the round-trip test: EnergyPlus results from the written file must match the original's.
// With --network, writes the airflow network variant instead (src/model/airflow-network.js).
//
//   node tools/export_epjson.mjs <input.epJSON> <output.epJSON> [--network]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importEpJSON } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { toAirflowNetwork } from '../src/model/airflow-network.js';

const network = process.argv.includes('--network');
const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!input || !output) {
  console.error('usage: node tools/export_epjson.mjs <input.epJSON> <output.epJSON> [--network]');
  process.exit(2);
}
const model = importEpJSON(JSON.parse(readFileSync(input, 'utf8')), { fileName: path.basename(input) });
mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
writeFileSync(output, serializeEpJSON(network ? toAirflowNetwork(model) : exportEpJSON(model)));
const counts = (o) => Object.keys(o).length;
console.log(`${counts(model.zones)} zones, ${counts(model.surfaces)} surfaces, ${counts(model.windows)} windows, ${model.checks.length} checks -> ${output}`);
