// Checks the tool's CO2 balance against EnergyPlus's, over the network reference week: each 10-minute
// step's flows come from the network solver fed EnergyPlus's own inputs (as check_solver.mjs does), the
// CO2 balance steps with them, and hourly means are compared with EnergyPlus's Zone Air CO2 Concentration.
//
//   node tools/check_co2.mjs <model.epJSON> <EnergyPlus run .eso> <first day of the run, 1-365>
import { readFileSync } from 'node:fs';
import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { co2Generation, outdoorAirSupply, outdoorCO2, stepCO2 } from '../src/solver/co2.js';
import { readEso } from './eso.mjs';

const [modelFile, esoFile, firstDay = '182'] = process.argv.slice(2);
const model = importEpJSON(JSON.parse(readFileSync(modelFile, 'utf8')));
const net = buildNetwork(model);
const eso = readEso(esoFile);
const need = (v, k, f) => { const s = eso.find(v, k, f); if (!s) throw new Error(`${v} for ${k} is not in ${esoFile}`); return s; };
const out = ['Site Outdoor Air Drybulb Temperature', 'Site Outdoor Air Humidity Ratio', 'Site Outdoor Air Barometric Pressure', 'Site Wind Speed', 'Site Wind Direction'].map((v) => need(v, 'Environment'));
const zt = net.zones.map((z) => need('AFN Node Temperature', z)), zw = net.zones.map((z) => need('AFN Node Humidity Ratio', z));
const openings = net.links.filter((l) => l.type === 'opening' && l.control === 'zone');
const openSeries = Object.fromEntries(openings.map((l) => [l.name, need('AFN Surface Venting Window or Door Opening Factor', l.name)]));
const ref = net.zones.map((z) => need('Zone Air CO2 Concentration', z, 'Hourly'));
const volumes = net.zones.map((z) => model.zones[z].volume.value);
const steps = out[0].length, perHour = steps / ref[0].length, dt = 3600 / perHour;
const hour0 = (Number(firstDay) - 1) * 24;

let C = ref.map((r) => r[0]); // start where EnergyPlus's first hour was
const sums = net.zones.map(() => 0), errors = net.zones.map(() => []);
for (let s = 0; s < steps; s++) {
  const conditions = {
    site: { elevation: 4.3, latitude: 49.19 },
    outdoor: { t: out[0][s], w: out[1][s], pressure: out[2][s], windSpeed: out[3][s], windDirection: out[4][s] },
    zones: Object.fromEntries(net.zones.map((z, i) => [z, { t: zt[i][s], w: zw[i][s] }])),
    open: Object.fromEntries(openings.map((l) => [l.name, openSeries[l.name][s]])),
  };
  const hour = hour0 + Math.floor(s / perHour);
  const solution = solveNetwork(net, conditions, { exactEnergyPlus: true });
  C = stepCO2(net, solution, C, dt, volumes, co2Generation(model, net.zones, hour), outdoorCO2(model, hour), outdoorAirSupply(model, net.zones, hour, 4.3));
  C.forEach((c, z) => { sums[z] += c; });
  if ((s + 1) % perHour === 0) {
    const h = (s + 1) / perHour - 1;
    sums.forEach((sum, z) => { errors[z].push(sum / perHour - ref[z][h]); sums[z] = 0; });
  }
}
let all = [];
console.log('zone'.padEnd(16), 'mean |diff| ppm', 'max |diff|', 'EnergyPlus mean', 'peak');
net.zones.forEach((z, i) => {
  const a = errors[i].map(Math.abs);
  all = all.concat(a);
  const mean = ref[i].reduce((x, y) => x + y, 0) / ref[i].length;
  console.log(z.padEnd(16), (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1).padStart(15), Math.max(...a).toFixed(0).padStart(10), mean.toFixed(0).padStart(15), Math.max(...ref[i]).toFixed(0).padStart(5));
});
console.log(`all zones: mean |difference| ${(all.reduce((x, y) => x + y, 0) / all.length).toFixed(1)} ppm, largest ${Math.max(...all).toFixed(0)} ppm`);
