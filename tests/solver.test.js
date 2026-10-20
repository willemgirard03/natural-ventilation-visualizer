// The network solver: its parts against EnergyPlus's published behaviour, and the whole against
// an EnergyPlus run of Example_02 when that run is on this computer (runs/ is not in the repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, energyPlusCentroid, solveNetwork, windPressureTables } from '../src/solver/network.js';
import { windSpeedAt, weatherStation } from '../src/solver/air.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('wind pressure tables match the ones EnergyPlus printed for Example_02 (axis 84 deg, ratio 0.392)', () => {
  // From the .eio of the EnergyPlus run (AirflowNetwork Model:Wind Pressure Coefficients), 0 to 330 deg.
  const eio = [
    [-0.30, 0.16, 0.50, 0.59, 0.39, -1.44e-2, -0.50, -0.45, -0.20, -0.25, -0.24, -0.59],
    [-0.29, -0.54, -0.66, -0.29, 0.26, 0.52, 0.59, 0.45, 7.21e-2, -0.50, -0.68, -0.40],
    [-0.50, -0.45, -0.20, -0.25, -0.24, -0.59, -0.30, 0.16, 0.50, 0.59, 0.39, -1.44e-2],
    [0.59, 0.45, 7.21e-2, -0.50, -0.68, -0.40, -0.29, -0.54, -0.66, -0.29, 0.26, 0.52],
    [-0.43, -0.62, -0.72, -0.75, -0.69, -0.55, -0.43, -0.62, -0.72, -0.75, -0.69, -0.55],
  ];
  windPressureTables(84, 0.392).forEach((t, f) => t.vals.slice(0, 12).forEach((v, k) => near(v, eio[f][k], 0.006, `facade ${f + 1}, ${k * 30} deg`)));
});

test('centroids follow EnergyPlus: corner average from five corners, weighted triangles for four', () => {
  const L = [[0, 0, 0], [4, 0, 0], [4, 0, 1], [1, 0, 1], [1, 0, 3], [0, 0, 3]]; // L-shaped wall
  near(energyPlusCentroid(L)[2], (0 + 0 + 1 + 1 + 3 + 3) / 6, 1e-12, 'corner average');
  near(energyPlusCentroid([[0, 0, 3], [0, 0, 0], [5, 0, 0], [5, 0, 3]])[2], 1.5, 1e-12, 'rectangle centre');
  near(energyPlusCentroid([[0, 0, 3], [0, 0, 0], [2, 0, 0], [5, 0, 0], [5, 0, 3]])[2], 1.5, 1e-12, 'collinear corner dropped');
});

test('ClimateStudio weather station raises wind at the building by 40%', () => {
  const cs = weatherStation({ 'Site:WeatherStation': { a: { wind_sensor_height_above_ground: 10, wind_speed_profile_exponent: 0.22, wind_speed_profile_boundary_layer_thickness: 370 } } });
  near(windSpeedAt(6, 3, 'Suburbs', cs) / windSpeedAt(6, 3, 'Suburbs'), 1.395, 0.001);
});

const WEEK = path.join(REPO, 'runs', 'network', 'week', 'example02_afn_week.eso');
const EXAMPLE02 = path.join(REPO, '..', 'Example 02', 'Results', '2226_Emmenweid.epJSON');
test('Example_02 network week: the solver reproduces EnergyPlus within 0.01%', { skip: existsSync(WEEK) && existsSync(EXAMPLE02) ? false : 'EnergyPlus week run not on this computer' }, () => {
  const report = execFileSync(process.execPath, [path.join(REPO, 'tools', 'check_solver.mjs'), EXAMPLE02, WEEK], { encoding: 'utf8' });
  for (const kind of ['window', 'door', 'crack']) {
    const m = report.match(new RegExp(`${kind} +flow difference ([0-9.]+)%`));
    assert.ok(m && Number(m[1]) < 0.01, `${kind}: ${m && m[1]}% (${report})`);
  }
  assert.match(report, / 0 not converged/);
});

// Two 4 x 4 x 3 m rooms side by side, each with a south window, sharing a wall.
function twoRooms() {
  const v = (x, y, z) => ({ vertex_x_coordinate: x, vertex_y_coordinate: y, vertex_z_coordinate: z });
  const surfaces = {};
  const add = (name, zone, type, pts, other) => {
    surfaces[name] = { zone_name: zone, surface_type: type, construction_name: 'C', outside_boundary_condition: other ? 'Surface' : type === 'Floor' ? 'Ground' : 'Outdoors', ...(other ? { outside_boundary_condition_object: other } : {}), vertices: pts.map((p) => v(...p)) };
  };
  for (const [zone, x0] of [['Room', 0], ['Hall', 4]]) {
    const x1 = x0 + 4;
    add(`${zone}:s`, zone, 'Wall', [[x0, 0, 3], [x0, 0, 0], [x1, 0, 0], [x1, 0, 3]]);
    add(`${zone}:n`, zone, 'Wall', [[x1, 4, 3], [x1, 4, 0], [x0, 4, 0], [x0, 4, 3]]);
    add(`${zone}:f`, zone, 'Floor', [[x0, 4, 0], [x1, 4, 0], [x1, 0, 0], [x0, 0, 0]]);
    add(`${zone}:r`, zone, 'Roof', [[x0, 0, 3], [x1, 0, 3], [x1, 4, 3], [x0, 4, 3]]);
  }
  add('Room:w', 'Room', 'Wall', [[0, 4, 3], [0, 4, 0], [0, 0, 0], [0, 0, 3]]);
  add('Hall:e', 'Hall', 'Wall', [[8, 0, 3], [8, 0, 0], [8, 4, 0], [8, 4, 3]]);
  add('Room:e', 'Room', 'Wall', [[4, 0, 3], [4, 0, 0], [4, 4, 0], [4, 4, 3]], 'Hall:w');
  add('Hall:w', 'Hall', 'Wall', [[4, 4, 3], [4, 4, 0], [4, 0, 0], [4, 0, 3]], 'Room:e');
  const win = (parent, x) => ({ building_surface_name: parent, construction_name: 'C', surface_type: 'Window', vertices: [v(x, 0, 2), v(x, 0, 1), v(x + 1, 0, 1), v(x + 1, 0, 2)] });
  const vent = (zone) => ({ zone_or_space_name: zone, opening_area: 0.5, opening_effectiveness: 0, discharge_coefficient_for_opening: 0.6 });
  return importEpJSON({
    Building: { B: { north_axis: 0, terrain: 'Suburbs' } },
    Zone: { Room: {}, Hall: {} },
    Construction: { C: { outside_layer: 'M' } },
    Material: { M: { thickness: 0.1, conductivity: 1, density: 1000, specific_heat: 1000 } },
    'BuildingSurface:Detailed': surfaces,
    'FenestrationSurface:Detailed': { 'Room:s:w': win('Room:s', 1.5), 'Hall:s:w': win('Hall:s', 5.5) },
    'ZoneVentilation:WindandStackOpenArea': { Rv: vent('Room'), Hv: vent('Hall') },
  });
}

test('the solver balances every zone, gives two-way flow when warm inside, and lets wind in on the windward side', () => {
  const net = buildNetwork(twoRooms(), { doors: false });
  const base = { site: { elevation: 0, latitude: 45 }, open: { 'Room:s:w': 0.5, 'Hall:s:w': 0.5 } };
  const warm = { Room: { t: 25, w: 0.008 }, Hall: { t: 25, w: 0.008 } };
  const calm = solveNetwork(net, { ...base, zones: warm, outdoor: { t: 15, w: 0.007, pressure: 101325, windSpeed: 0, windDirection: 0 } });
  assert.ok(calm.converged);
  for (const z of net.zones) {
    const balance = calm.links.reduce((s, l) => s + (l.from === z ? l.backward - l.forward : 0) + (l.to === z ? l.forward - l.backward : 0), 0);
    near(balance, 0, 1e-12, `${z} mass balance`);
  }
  const w = calm.links.find((l) => l.name === 'Room:s:w');
  assert.ok(w.forward > 0 && w.backward > 0, 'warm air out at the top, outdoor air in at the bottom');
  const windy = solveNetwork(net, { ...base, zones: warm, outdoor: { t: 25, w: 0.008, pressure: 101325, windSpeed: 5, windDirection: 180 } });
  const sw = windy.links.find((l) => l.name === 'Room:s:w');
  assert.ok(sw.backward > 10 * sw.forward, 'a south wind blows in through the south window');
});

test('flow streams: two-way windows bring cold air in at the bottom, and every zone sends on what it receives', async () => {
  const { flowStreams } = await import('../src/solver/paths.js');
  const net = buildNetwork(twoRooms(), { doors: false });
  const conditions = { site: { elevation: 0, latitude: 45 }, open: { 'Room:s:w': 0.5, 'Hall:s:w': 0.5 }, zones: { Room: { t: 26, w: 0.008 }, Hall: { t: 26, w: 0.008 } }, outdoor: { t: 16, w: 0.007, pressure: 101325, windSpeed: 0, windDirection: 0 } };
  const f = flowStreams(net, solveNetwork(net, conditions), conditions);
  const win = net.links.findIndex((l) => l.name === 'Room:s:w');
  const [inflow, outflow] = [f.streams.find((s) => s.link === win && s.from < 0), f.streams.find((s) => s.link === win && s.from >= 0)];
  assert.ok(inflow.band[1] <= outflow.band[0] + 1e-12 && inflow.band[0] === 0, 'outdoor air enters through the bottom band');
  net.zones.forEach((z, i) => near(f.outlets[i].reduce((s, x) => s + x.rate, 0), f.throughflow[i], 1e-9, `${z} sends on its inflow`));
});
