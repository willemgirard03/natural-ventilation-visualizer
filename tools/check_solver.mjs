// Checks the tool's network solver against EnergyPlus's airflow network, step by step.
// Each EnergyPlus timestep's inputs (weather, zone temperatures and humidity, window opening factors)
// go into src/solver/network.js; the flows through every crack, window and door are compared.
//
//   node tools/check_solver.mjs <model.epJSON> <EnergyPlus run .eso> [--no-doors]
//
// The .eso must come from toAirflowNetwork(model, { reporting: 'Timestep', checkOutputs: true }).
// Zone conditions are the network's own node temperatures and humidity ratios, which are the zone
// values of the previous timestep (EnergyPlus solves the network before updating the zones).
import { readFileSync } from 'node:fs';
import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { readEso } from './eso.mjs';

const args = process.argv.slice(2);
const [modelFile, esoFile] = args.filter((a) => !a.startsWith('--'));
const model = importEpJSON(JSON.parse(readFileSync(modelFile, 'utf8')));
const net = buildNetwork(model, { doors: !args.includes('--no-doors') });
const eso = readEso(esoFile);
const need = (v, k) => {
  const s = eso.find(v, k);
  if (!s) throw new Error(`${v} for ${k} is not in ${esoFile}`);
  return s;
};
const site = { elevation: 4.3, latitude: 49.19 }; // Vancouver International Airport (weather file header)
const out = ['Site Outdoor Air Drybulb Temperature', 'Site Outdoor Air Humidity Ratio', 'Site Outdoor Air Barometric Pressure', 'Site Wind Speed', 'Site Wind Direction'].map((v) => need(v, 'Environment'));
const zt = net.zones.map((z) => need('AFN Node Temperature', z)), zw = net.zones.map((z) => need('AFN Node Humidity Ratio', z));
const openings = net.links.filter((l) => l.type === 'opening' && l.control === 'zone');
const openSeries = Object.fromEntries(openings.map((l) => [l.name, need('AFN Surface Venting Window or Door Opening Factor', l.name)]));
const ref = net.links.map((l) => [need('AFN Linkage Node 1 to Node 2 Mass Flow Rate', l.name), need('AFN Linkage Node 2 to Node 1 Mass Flow Rate', l.name)]);
const steps = out[0].length;

const groups = { window: [0, 0], door: [0, 0], crack: [0, 0] }; // [sum |difference|, sum EnergyPlus]
const kind = (l) => (l.type === 'crack' ? 'crack' : l.door ? 'door' : 'window');
let unconverged = 0, worst = { err: 0 }, iterations = 0;
const t0 = Date.now();
for (let s = 0; s < steps; s++) {
  const zs = s;
  const conditions = {
    site,
    outdoor: { t: out[0][s], w: out[1][s], pressure: out[2][s], windSpeed: out[3][s], windDirection: out[4][s] },
    zones: Object.fromEntries(net.zones.map((z, i) => [z, { t: zt[i][zs], w: zw[i][zs] }])),
    open: Object.fromEntries(openings.map((l) => [l.name, openSeries[l.name][s]])),
  };
  const r = solveNetwork(net, conditions);
  iterations += r.iterations;
  if (!r.converged) unconverged++;
  let stepErr = 0, stepRef = 0;
  r.links.forEach((x, i) => {
    const e = Math.abs(x.forward - ref[i][0][s]) + Math.abs(x.backward - ref[i][1][s]);
    const g = groups[kind(net.links[i])];
    g[0] += e; g[1] += ref[i][0][s] + ref[i][1][s];
    stepErr += e; stepRef += ref[i][0][s] + ref[i][1][s];
  });
  if (stepErr / stepRef > worst.err) worst = { err: stepErr / stepRef, step: s, wind: out[3][s], open: Object.values(conditions.open).filter((x) => x > 0).length };
}
const ms = (Date.now() - t0) / steps;
console.log(`${steps} timesteps, ${net.links.length} links, ${net.zones.length} zones; ${ms.toFixed(2)} ms and ${(iterations / steps).toFixed(1)} iterations per solve; ${unconverged} not converged`);
for (const [k, [e, total]] of Object.entries(groups)) console.log(`${k.padEnd(7)} flow difference ${(100 * e / total).toFixed(3)}% of EnergyPlus's total (${(total / steps * 3600 / 1.2).toFixed(0)} m3/h on average)`);
console.log(`worst step ${worst.step}: ${(100 * worst.err).toFixed(2)}% (wind ${worst.wind} m/s, ${worst.open} windows open)`);
