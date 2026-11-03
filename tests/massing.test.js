// Massing (src/model/massing.js): storeys of floor plates written as a ClimateStudio-style .epJSON,
// read back as the tool reads any model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importEpJSON } from '../src/model/import-epjson.js';
import { enclosedVolume } from '../src/model/geometry.js';
import { massing0, massingEpJSON, massingGeometry, sideWindows, unitLayout, storey0 } from '../src/model/massing.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const volumes = (model) => Object.fromEntries(Object.keys(model.zones).map((z) => [z, enclosedVolume(model.zones[z].surfaces.map((s) => model.surfaces[s].vertices))]));

test('windows are set out by number and by spacing', () => {
  const byN = unitLayout({ winBy: 'number', winN: 4 }, 20);
  assert.equal(byN.n, 4); near(byN.pitch, 5); near(byN.first, -7.5);
  const bySp = unitLayout({ winBy: 'spacing', winSp: 4.5, winW: 2 }, 20);
  assert.equal(bySp.n, 5); near(bySp.first, -9);
  // a broken-out window keeps its own size and moves in its bay, held inside it
  const w = sideWindows({ winBy: 'number', winN: 2, winW: 2, winH: 1.6, sill: 0.9, broken: { 1: { winW: 1, offU: 9 } } }, 10, 3.5);
  near(w[0].u1 - w[0].u0, 2); near(w[1].u1 - w[1].u0, 1); near(w[1].u1, 5 - 0.02); // held clear of the corner
});

test('a two-storey pancake reads back closed, paired and ventilated', () => {
  const m = massing0();
  const model = importEpJSON(massingEpJSON(m));
  assert.deepEqual(Object.keys(model.zones), ['Floor1_0', 'Floor2_1']);
  for (const v of Object.values(volumes(model))) near(v, 20 * 10 * 3.5, 1e-6);
  const errors = model.checks.filter((c) => c.level === 'error');
  assert.deepEqual(errors, []);
  const floor = model.surfaces['Floor2_1:f0'], ceiling = model.surfaces[floor.adjacentSurface ?? 'Floor1_0:f5'];
  assert.equal(floor.boundary, 'Surface'); assert.equal(ceiling.zone, 'Floor1_0');
  assert.equal(Object.keys(model.windows).length, 32);
  for (const z of Object.values(model.zones)) near(z.ventilation.operableFraction.value, 0.8, 1e-6);
});

test('a set-back storey has a roof on the one below and an overhang has an exposed floor', () => {
  const m = massing0();
  m.storeys = [storey0(3.5, 20, 10), Object.assign(storey0(3.5, 12, 14), { ox: 4 })];
  const zones = massingGeometry(m), model = importEpJSON(massingEpJSON(m));
  assert.ok(zones[0].surfaces.some((s) => s.kind === 'roof'));
  assert.ok(zones[1].surfaces.some((s) => s.kind === 'exposed'));
  const v = volumes(model);
  near(v.Floor1_0, 20 * 10 * 3.5, 1e-6); near(v.Floor2_1, 12 * 14 * 3.5, 1e-6);
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
});
