// Massing (src/model/massing.js): storeys of floor plates written as a ClimateStudio-style .epJSON,
// read back as the tool reads any model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importEpJSON } from '../src/model/import-epjson.js';
import { enclosedVolume } from '../src/model/geometry.js';
import { massing0, massingEpJSON, massingGeometry, sideWindows, unitLayout, storey0, applyMassing, setWindowSize, setWindowFigure, breakWindow, applyToArray, dragPitch, addWindows } from '../src/model/massing.js';
import { edit } from '../src/model/edit.js';

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

test('a massing changed keeps the edits made since, where they still apply, and undoes', async () => {
  const { edit, setZoneSetting } = await import('../src/model/edit.js');
  const { applyMassing } = await import('../src/model/massing.js');
  const m = massing0(), ep = massingEpJSON(m);
  ep['BuildingSurface:Detailed']['Floor1_0:f1'].construction_name = 'Massing Roof';
  edit(ep, (tx) => setZoneSetting(tx, 'Floor2_1', 'peoplePerArea', 0.1));
  const edited = JSON.stringify(ep);
  m.storeys.push(storey0()); m.storeys[0].w = 24; m.storeys[0].sides.S.winN = 6;
  const e = edit(ep, (tx) => applyMassing(tx, m));
  let model = importEpJSON(ep);
  assert.deepEqual(Object.keys(model.zones), ['Floor1_0', 'Floor2_1', 'Floor3_2']);
  assert.equal(ep['BuildingSurface:Detailed']['Floor1_0:f1'].construction_name, 'Massing Roof');
  near(ep.People['People Floor2_1'].people_per_floor_area, 0.1);
  near(model.zones.Floor1_0.volume.value, 24 * 10 * 3.5, 1e-6);
  assert.equal(model.zones.Floor1_0.windows.length, 18);
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  // down to one storey: the others go with their own objects
  m.storeys.length = 1;
  const e2 = edit(ep, (tx) => applyMassing(tx, m));
  model = importEpJSON(ep);
  assert.deepEqual(Object.keys(model.zones), ['Floor1_0']);
  assert.ok(!ep.People['People Floor2_1'] && !ep['ZoneHVAC:IdealLoadsAirSystem']['Floor2_1 Ideal Loads Air']);
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  e2.undo(); e.undo(); // back to the edited two storeys
  assert.deepEqual(JSON.parse(JSON.stringify(ep)), JSON.parse(edited));
});

test('a window dragged in its wall is broken out of its array where it was put', async () => {
  const { windowRect } = await import('../src/model/edit.js');
  const { breakOutWindow } = await import('../src/model/massing.js');
  for (const rot of [0, 30]) {
    const m = massing0();
    m.rot = rot;
    let model = importEpJSON(massingEpJSON(m));
    const name = 'Floor2_1:f2:w1', r0 = windowRect(model, name), wall = model.surfaces[model.windows[name].parent];
    const mid = wall.vertices.reduce((s, p) => s + p[0] * r0.frame.right[0] + p[1] * r0.frame.right[1], 0) / wall.vertices.length;
    const r = { s0: r0.s0 + 0.4, s1: r0.s1 + 0.1, z0: r0.z0 + 0.2, z1: r0.z1 + 0.3 };
    assert.ok(breakOutWindow(m, name, r, mid));
    model = importEpJSON(massingEpJSON(m));
    const r1 = windowRect(model, name);
    for (const k of ['s0', 's1', 'z0', 'z1']) near(r1[k], r[k], 2e-3);
  }
});

test('a storey turned on its own over the one below splits into convex slab, roof and exposed pieces', () => {
  const m = massing0();
  Object.assign(m.storeys[1], { rot: 30, ox: 6, w: 16, d: 8 });
  const model = importEpJSON(massingEpJSON(m)), v = volumes(model);
  near(v.Floor1_0, 20 * 10 * 3.5, 1e-4); near(v.Floor2_1, 16 * 8 * 3.5, 1e-4); // corners written to the micrometre
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  const zones = massingGeometry(m);
  // the lower roof and ceiling tile its plate; the upper floor's pieces tile the upper plate
  const areaOf = (z, kinds) => z.surfaces.filter((s) => kinds.includes(s.kind) && s.type !== 'Wall').reduce((a, s) => a + model.surfaces[s.name].area, 0);
  near(areaOf(zones[0], ['roof', 'slab']), 200, 1e-4); near(areaOf(zones[1], ['slab', 'exposed']), 128, 1e-4);
});

test('windows stay under the floor assembly above; Size keeps the glass as the storey changes', () => {
  const m = massing0(), ep = massingEpJSON(m);
  // the slab over the ground floor is the floor assembly above (screed 60 + concrete 250); the roof has none
  assert.deepEqual(m.storeys.map((s) => s.slab), [0.31, 0]);
  // a thicker floor above lowers the top of the walls below it
  const floor = Object.values(ep['BuildingSurface:Detailed']).find((o) => o.zone_name === massingGeometry(m)[1].name && o.surface_type === 'Floor').construction_name;
  const e = edit(ep, (tx) => { for (const n of Object.values(tx.epjson.Construction[floor])) tx.get('Material', n).thickness *= 2; applyMassing(tx, m); });
  assert.ok(e.changed); near(m.storeys[0].slab, 0.62, 1e-9);
  // Offsets: a taller storey makes taller windows, the gap to the slab the same
  const g = m.storeys[0].sides.S;
  setWindowSize(m, 0, 'S', undefined, 'offset');
  const head = (x) => Math.max(...sideWindows(x.storeys[0].sides.S, x.storeys[0].w, x.storeys[0].h, x.storeys[0].slab).map((w) => w.v1));
  const before = head(m);
  m.storeys[0].h += 0.5;
  near(head(m) - before, 0.5, 1e-9);
  // Fixed: the window keeps its height
  setWindowSize(m, 0, 'S', undefined, 'fixed');
  const fixed = head(m); m.storeys[0].h += 0.5; near(head(m), fixed, 1e-9);
  // a figure set writes every form; a broken window's edits are its own until applied to the array
  setWindowFigure(m, 0, 'S', 0, 'winW', 1.2); near(g.winW, 1.2, 1e-9); near(g.jamb, (unitLayout(g, 20).pitch - 1.2) / 2, 1e-9);
  breakWindow(g, 1); setWindowFigure(m, 0, 'S', 1, 'winW', 0.8);
  near(g.winW, 1.2, 1e-9); near(g.broken[1].winW, 0.8, 1e-9);
  applyToArray(g, 1); near(g.winW, 0.8, 1e-9); assert.deepEqual(g.broken, {});
  // a window dragged along its side sets the pitch
  setWindowSize(m, 0, 'S', undefined, 'fixed'); Object.assign(g, { winBy: 'spacing', winSp: 4 });
  const { first } = unitLayout(g, 20); dragPitch(m, 0, 'S', 2, first + 2 * 3); near(g.winSp, 3, 1e-9);
  // a bare side given a window wall: glass from the floor up to the slab, bay to bay
  m.storeys[0].sides.E = null; addWindows(m, 0, 'E', 'windowwall');
  const ws = sideWindows(m.storeys[0].sides.E, m.storeys[0].d, m.storeys[0].h, m.storeys[0].slab);
  near(ws[0].v1, m.storeys[0].h - m.storeys[0].slab, 1e-9);
});
