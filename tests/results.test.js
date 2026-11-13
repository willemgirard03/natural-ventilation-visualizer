// Results at a moment (src/model/results.js) and the AirflowNetwork export's finer outputs and gradual
// opening (src/model/airflow-network.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mergeResults, resultsTiming, surfaceAtTime, windowAtTime, zoneAtTime } from '../src/model/results.js';
import { importEpJSON } from '../src/model/import-epjson.js';
import { toAirflowNetwork, GRADUAL_BAND } from '../src/model/airflow-network.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMMENWEID = path.join(REPO, 'data', 'Emmenweid 2226.epJSON');

// a year of hourly means: hour i holds i (so a value read at moment H is H - 0.5 between middles)
function year() {
  const t = Array.from({ length: 8760 }, (_, i) => i);
  return { zones: { Z: { t, w: t.map(() => 0.008), rh: null, co2: t.map(() => 500), vent: t.map((_, i) => i % 2 === 1) } }, windows: { 'W': t.map((_, i) => (i % 2 ? 1 : 0)) }, surfaces: { 'S': t.map(() => 20) }, hours: 8760, missing: [] };
}

test('results at a moment: hourly means stand at their middles, values between interpolated, windows the hour\'s own', () => {
  const r = year();
  near(zoneAtTime(r, 'Z', 100.5).t, 100, 1e-9, 'an hour\'s middle is its mean');
  near(zoneAtTime(r, 'Z', 101).t, 100.5, 1e-9, 'the hour\'s end is halfway to the next mean');
  near(zoneAtTime(r, 'Z', 100.75).t, 100.25, 1e-9, 'in a straight line');
  assert.equal(windowAtTime(r, 'w', 101.2), 1, 'the window as in the hour the moment falls in');
  assert.equal(windowAtTime(r, 'W', 100.9), 0);
  assert.equal(zoneAtTime(r, 'Z', 101.2).vent, true);
  near(surfaceAtTime(r, 'S', 3000.3), 20, 1e-9, 'surfaces too');
  assert.equal(resultsTiming(r, 100.5).exact, true);
  assert.equal(resultsTiming(r, 101).exact, false);
});

test('results at a moment: a rerun\'s finer steps where they cover it, the hours elsewhere', () => {
  const r = year();
  // a 2-hour part from hour 200 at 10-minute steps: step k holds 1000 + k; window open in step 3 only
  const per = 6, n = 2 * per, t = Array.from({ length: n }, (_, k) => 1000 + k);
  const part = { zones: { Z: { t: [1000, 1006] } }, windows: {}, surfaces: {}, hours: 2, missing: [],
    fine: { per, hours: 2, zones: { Z: { t, w: null, rh: null, co2: null, vent: t.map((_, k) => k === 3) } }, windows: { W: t.map((_, k) => (k === 3 ? 0.5 : 0)) }, surfaces: {} } };
  const m = mergeResults(r, part, 200);
  assert.equal(m.fine.start, 200);
  near(zoneAtTime(m, 'Z', 200 + 5 / 60).t, 1000, 1e-9, 'a step\'s middle is its mean');
  near(zoneAtTime(m, 'Z', 200 + 10 / 60).t, 1000.5, 1e-9, 'between two steps, halfway');
  assert.equal(windowAtTime(m, 'W', 200 + 35 / 60), 0.5, 'the window as in its step');
  assert.equal(windowAtTime(m, 'W', 200 + 45 / 60), 0);
  assert.equal(zoneAtTime(m, 'Z', 200 + 32 / 60).vent, true);
  const timing = resultsTiming(m, 200 + 5 / 60);
  assert.deepEqual([timing.fine, timing.minutes, timing.exact], [true, 10, true]);
  near(zoneAtTime(m, 'Z', 150.5).t, 150, 1e-9, 'hourly outside the part');
});

test('AirflowNetwork export: windows open or shut by default; gradual opening by an EMS program; timestep outputs', { skip: existsSync(EMMENWEID) ? false : 'example not here' }, () => {
  const model = importEpJSON(JSON.parse(readFileSync(EMMENWEID, 'utf8')));
  const plain = toAirflowNetwork(model, { runPeriod: [7, 13, 7, 15] });
  for (const z of Object.values(plain['AirflowNetwork:MultiZone:Zone'])) if (z.ventilation_control_mode === 'Temperature') assert.equal(z.minimum_venting_open_factor, 1, 'no modulation');
  assert.ok(!plain['EnergyManagementSystem:Program']?.AFN_Gradual);
  const ep = toAirflowNetwork(model, { runPeriod: [7, 13, 7, 15], gradual: true, reporting: 'Timestep', timestepsPerHour: 12 });
  const lines = ep['EnergyManagementSystem:Program'].AFN_Gradual.lines.map((l) => l.program_line);
  assert.ok(lines.some((l) => l.includes(`- 25) / ${GRADUAL_BAND}`)), 'opening in proportion to the excess over 25 °C');
  const acts = Object.values(ep['EnergyManagementSystem:Actuator']).filter((a) => a.actuated_component_type === 'AirFlow Network Window/Door Opening');
  assert.ok(acts.length > 0 && acts.every((a) => a.actuated_component_control_type === 'Venting Opening Factor' && model.windows[a.actuated_component_unique_name]));
  assert.ok(ep['EnergyManagementSystem:Sensor'].OutdoorTemp, 'the model\'s own EMS objects are kept');
  assert.equal(Object.values(ep.Timestep)[0].number_of_timesteps_per_hour, 12);
  const fine = Object.values(ep['Output:Variable']).filter((v) => v.reporting_frequency === 'Timestep').map((v) => v.variable_name);
  for (const v of ['Zone Mean Air Temperature', 'AFN Surface Venting Window or Door Opening Factor', 'Zone Air CO2 Concentration']) assert.ok(fine.includes(v), v);
});
