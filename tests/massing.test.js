// Massing (src/model/massing.js): zones on levels written as a ClimateStudio-style .epJSON,
// read back as the tool reads any model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importEpJSON } from '../src/model/import-epjson.js';
import { enclosedVolume } from '../src/model/geometry.js';
import { massing0, massingEpJSON, massingGeometry, sideWindows, unitLayout, storey0, applyMassing, setWindowSize, setWindowFigure, breakWindow, applyToArray, dragPitch, addWindows, upgradeMassing, MASSING_SETTINGS0, zoneHeight, faceLength, moveLevel, pushFace, WINDOWS0,
  addZone, splitZone, reentrantCorners, setArraySpan, setJustify, arraySpan, bayExtents, splitFace, extrudeFace,
  moveZone, deleteZone, floatingZones, zoneFits, slideSeam, mergeZones, zoneSeams, removeWallSeam, mergeCells, mergeFaces, zoneName } from '../src/model/massing.js';
// A massing from older storeys (rectangular plates stacked), as the tool upgrades them.
const stack = (...storeys) => upgradeMassing({ name: 'Floor', rot: 0, storeys, settings: MASSING_SETTINGS0() });
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
  const m = stack(storey0(3.5, 20, 10), Object.assign(storey0(3.5, 12, 14), { ox: 4 }));
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
  m.levels.push({ name: 'Level 4', z: 10.5 }); m.zones.push({ ...structuredClone(m.zones[1]), id: 2, base: 2, top: 3 });
  m.zones[0].plate = [[-12, -5], [12, -5], [12, 5], [-12, 5]]; m.zones[0].faces[0].winN = 6;
  const e = edit(ep, (tx) => applyMassing(tx, m));
  let model = importEpJSON(ep);
  assert.deepEqual(Object.keys(model.zones), ['Floor1_0', 'Floor2_1', 'Floor3_2']);
  assert.equal(ep['BuildingSurface:Detailed']['Floor1_0:f1'].construction_name, 'Massing Roof');
  near(ep.People['People Floor2_1'].people_per_floor_area, 0.1);
  near(model.zones.Floor1_0.volume.value, 24 * 10 * 3.5, 1e-6);
  assert.equal(model.zones.Floor1_0.windows.length, 18);
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  // down to one storey: the others go with their own objects
  m.zones.length = 1; m.levels.length = 2;
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
  const m = stack(storey0(), Object.assign(storey0(), { rot: 30, ox: 6, w: 16, d: 8 }));
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
  assert.deepEqual(m.zones.map((z) => z.slab), [0.31, 0]);
  // a thicker floor above lowers the top of the walls below it
  const floor = Object.values(ep['BuildingSurface:Detailed']).find((o) => o.zone_name === massingGeometry(m)[1].name && o.surface_type === 'Floor').construction_name;
  const e = edit(ep, (tx) => { for (const n of Object.values(tx.epjson.Construction[floor])) tx.get('Material', n).thickness *= 2; applyMassing(tx, m); });
  assert.ok(e.changed); near(m.zones[0].slab, 0.62, 1e-9);
  // Offsets: a taller storey makes taller windows, the gap to the slab the same
  const g = m.zones[0].faces[0];
  setWindowSize(m, 0, 0, undefined, 'offset');
  const head = (x) => Math.max(...sideWindows(x.zones[0].faces[0], 20, zoneHeight(x, 0), x.zones[0].slab).map((w) => w.v1));
  const before = head(m);
  moveLevel(m, 1, 0.5);
  near(head(m) - before, 0.5, 1e-9);
  // Fixed: the window keeps its height
  setWindowSize(m, 0, 0, undefined, 'fixed');
  const fixed = head(m); moveLevel(m, 1, 0.5); near(head(m), fixed, 1e-9);
  // a figure set writes every form; a broken window's edits are its own until applied to the array
  setWindowFigure(m, 0, 0, 0, 'winW', 1.2); near(g.winW, 1.2, 1e-9); near(g.jamb, (unitLayout(g, 20).pitch - 1.2) / 2, 1e-9);
  breakWindow(g, 1); setWindowFigure(m, 0, 0, 1, 'winW', 0.8);
  near(g.winW, 1.2, 1e-9); near(g.broken[1].winW, 0.8, 1e-9);
  applyToArray(g, 1); near(g.winW, 0.8, 1e-9); assert.deepEqual(g.broken, {});
  // a window dragged along its side sets the pitch
  setWindowSize(m, 0, 0, undefined, 'fixed'); Object.assign(g, { winBy: 'spacing', winSp: 4 });
  const { first } = unitLayout(g, 20); dragPitch(m, 0, 0, 2, first + 2 * 3); near(g.winSp, 3, 1e-9);
  // a bare side given a window wall: glass from the floor up to the slab, bay to bay
  m.zones[0].faces[1] = null; addWindows(m, 0, 1, 'windowwall');
  const ws = sideWindows(m.zones[0].faces[1], faceLength(m, 0, 1), zoneHeight(m, 0), m.zones[0].slab);
  near(ws[0].v1, zoneHeight(m, 0) - m.zones[0].slab, 1e-9);
});

test('zones side by side on a level share a pair of interior walls; an L-shaped zone reads back closed', () => {
  const m = massing0();
  // a 6 x 10 m zone against the ground floor's east face, and the upper zone made an L
  m.zones.push({ name: 'Annex', base: 0, top: 1, rot: 0, plate: [[10, -5], [16, -5], [16, 5], [10, 5]], faces: [WINDOWS0(), WINDOWS0(), null, null] });
  m.zones[1].plate = [[-10, -5], [10, -5], [10, 5], [0, 5], [0, 12], [-10, 12]];
  m.zones[1].faces = [WINDOWS0(), WINDOWS0(), null, WINDOWS0(), null, null];
  const zones = massingGeometry(m), model = importEpJSON(massingEpJSON(m));
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  const v = volumes(model);
  near(v.Floor1_0, 200 * 3.5, 1e-4); near(v.Annex_2, 60 * 3.5, 1e-4); near(v.Floor2_1, (200 + 70) * 3.5, 1e-4);
  // the east face of the ground floor and the annex's west face, back to back
  const inter = zones.flatMap((z) => z.surfaces.filter((s) => s.kind === 'inter'));
  assert.equal(inter.length, 2);
  assert.equal(inter[0].partner, inter[1].name);
  assert.ok(!zones[0].windows.some((w) => w.face === 1), 'no windows on a wall shared with another zone');
  // the L's wing over nothing has an exposed floor; the annex has a roof
  assert.ok(zones[1].surfaces.some((s) => s.kind === 'exposed'));
  assert.ok(zones[2].surfaces.some((s) => s.kind === 'roof'));
});

test('levels move the zones on them: a roof pushed lifts the levels above, a floor its own alone', () => {
  const m = stack(storey0(3.5), storey0(3.5), storey0(3.5));
  near(pushFace(m, 0, 'roof', 0.5), 0.5); assert.deepEqual(m.levels.map((l) => l.z), [0, 4, 7.5, 11]);
  near(pushFace(m, 1, 'floor', 0.3), 0.3); assert.deepEqual(m.levels.map((l) => l.z), [0, 3.7, 7.5, 11]);
  // never closer than 2 m: the floor stops
  near(pushFace(m, 1, 'floor', -5), -(7.5 - 2 - 3.7));
  // a face pushed out moves its edge; one pushed past folding is held
  near(pushFace(m, 0, 1, 2), 2); near(faceLength(m, 0, 0), 22, 1e-9);
  assert.ok(pushFace(m, 0, 1, -30) > -22);
});

test('a zone added against a face or on a roof abuts, and never overlaps one on its levels', () => {
  const m = massing0();
  const j = addZone(m, 0, 1, { u: 5 });
  assert.deepEqual(m.zones[j].plate, [[10, -1.5], [13, -1.5], [13, 1.5], [10, 1.5]]);
  assert.deepEqual([m.zones[j].base, m.zones[j].top], [0, 1]);
  assert.equal(addZone(m, 0, 1, { u: 5 }), -1, 'a second one there would overlap it');
  // on the top roof: a new level 3 m up
  const r = addZone(m, 1, 'roof', { at: [0, 0] });
  assert.deepEqual(m.levels.map((l) => l.z), [0, 3.5, 7, 10]);
  assert.deepEqual([m.zones[r].base, m.zones[r].top], [2, 3]);
  const model = importEpJSON(massingEpJSON(m));
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  near(volumes(model)[`Floor1_${j}`], 9 * 3.5, 1e-4);
});

test('a zone split keeps each window wholly on one part where it was, and pairs the new walls', () => {
  const m = massing0();
  const before = massingGeometry(m)[0].windows.filter((w) => w.face === 0).map((w) => w.vertices[0][0]);
  const n = splitZone(m, 0, [3, -10], [3, 10]);
  assert.ok(n > 0);
  const g = massingGeometry(m), after = [...g[0].windows, ...g[n].windows].filter((w) => w.vertices[0][1] < -4.9).map((w) => w.vertices[0][0]).sort((a, b) => a - b);
  // the window across the cut (1.5 to 3.5 m) is gone, the others stay put
  assert.deepEqual(after.map((x) => +x.toFixed(6)), before.filter((x) => x + 2 <= 3 || x >= 3).map((x) => +x.toFixed(6)));
  const model = importEpJSON(massingEpJSON(m));
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  const v = volumes(model);
  near(v.Floor1_0 + v[`Floor1_${n}`], 200 * 3.5, 1e-4);
  // a split that misses the zone is refused
  assert.equal(splitZone(m, 0, [50, -10], [50, 10]), -1);
  // an L's re-entrant corner, and the faces meeting there pointing in
  const L = { zones: [{ plate: [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]] }] };
  assert.deepEqual(reentrantCorners(L, 0).map((c) => c.p), [[5, 5]]);
});

test('an array has a length of its own, justified on its face; its bays are what its bracket spans', () => {
  const m = massing0(), g = m.zones[0].faces[0]; // 4 by number on 20 m
  assert.deepEqual(bayExtents(g, 20), [0, 20]);
  setArraySpan(m, 0, 0, 2, 12); // by number: 4 windows over 10 m from 2 m in
  assert.deepEqual(arraySpan(g, 20), [2, 12]);
  setJustify(m, 0, 0, 'right'); assert.deepEqual(arraySpan(g, 20), [2, 12]); // the stretch stays where it is
  near(g.off, 8, 1e-9);
  Object.assign(g, { winBy: 'spacing', winSp: 3 });
  setArraySpan(m, 0, 0, 2, 12.4); // by spacing: whole bays
  const [a, b] = arraySpan(g, 20); near(b - a, 9, 1e-9);
  near(bayExtents(g, 20)[1] - bayExtents(g, 20)[0], 9, 1e-9);
  setArraySpan(m, 0, 0, -5, 30); assert.ok(!('len' in g), 'the whole face again');
});

test('a face split keeps its windows where they were; pushed out from the split it makes an L', () => {
  const m = massing0();
  const xs = (i) => massingGeometry(m)[i].windows.filter((w) => w.vertices[0][1] < -4.99).map((w) => +w.vertices[0][0].toFixed(6)).sort((a, b) => a - b);
  const before = xs(1);
  assert.ok(splitFace(m, 1, 0, 12));
  assert.deepEqual(xs(1), before.filter((x) => x + 2 <= 2 || x >= 2)); // the window across the seam (1.5 to 3.5) is gone
  assert.ok(extrudeFace(m, 1, 1, 3));
  assert.deepEqual(m.zones[1].plate, [[-10, -5], [2, -5], [2, -8], [10, -8], [10, 5], [-10, 5]]);
  const model = importEpJSON(massingEpJSON(m));
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  near(volumes(model).Floor2_1, 224 * 3.5, 1e-4);
  // pushed back in, it stops level with the face it stepped from, the step gone and the seam back
  near(extrudeFace(m, 1, 2, -3), -3); // the face that stepped out (face 1 is now the step beside it)
  assert.deepEqual(m.zones[1].plate, [[-10, -5], [2, -5], [10, -5], [10, 5], [-10, 5]]);
  // pushed in past the far side it would fold: it stops short
  const t = extrudeFace(m, 1, 0, -20);
  assert.ok(t < 0 && t > -10);
  // a face meeting corners at both ends stretches its neighbours instead
  const m2 = massing0();
  assert.ok(extrudeFace(m2, 0, 1, 2));
  assert.deepEqual(m2.zones[0].plate, [[-10, -5], [12, -5], [12, 5], [-10, 5]]);
});

test('a zone split from another takes its settings: loads, opening controls and assemblies', async () => {
  const { edit, setZoneSetting } = await import('../src/model/edit.js');
  const m = massing0(), ep = massingEpJSON(m);
  edit(ep, (tx) => { setZoneSetting(tx, 'Floor1_0', 'peoplePerArea', 0.2); applyMassing(tx, m); });
  ep['BuildingSurface:Detailed']['Floor1_0:f1'].construction_name = 'Massing Roof';
  const n = splitZone(m, 0, [3, -10], [3, 10]);
  edit(ep, (tx) => applyMassing(tx, m));
  const Z = `Floor1_${n}`;
  near(ep.People[`People ${Z}`].people_per_floor_area, 0.2);
  const s = Object.entries(ep['BuildingSurface:Detailed']).find(([, o]) => o.zone_name === Z && o.surface_type === 'Wall' && o.outside_boundary_condition === 'Outdoors');
  assert.equal(s[1].construction_name, 'Massing Roof');
  assert.ok(!m.zones[n].copyFrom, 'copied once');
});

test('zones never overlap or come away: moves stop at a collision, or where they would lose touch', () => {
  const m = massing0();
  const j = addZone(m, 0, 1); // a 3 x 3 m annex against the east face, x 10 to 13
  // slid along the face it stops where it would leave it (its far edge 0.05 m short of the corner, or level with it)
  const [, dy] = moveZone(m, j, [0, 20]);
  assert.ok(dy > 3 && dy < 7, `slid ${dy}`);
  assert.ok(zoneFits(m, j));
  // pulled away from the building it does not move; pushed into it, it does not either
  assert.deepEqual(moveZone(m, j, [5, 0]).map((x) => +x.toFixed(6)), [0, 0]);
  assert.deepEqual(moveZone(m, j, [-2, 0]).map((x) => +x.toFixed(6)), [0, 0]);
});

test('a zone deleted: where it was alone on its levels they close up and the zones above drop', () => {
  const m = massing0();
  addZone(m, 1, 'roof', { at: [0, 0] }); // a zone on the roof, levels 2 to 3
  assert.ok(deleteZone(m, 1)); // the upper storey, alone on its levels
  assert.deepEqual(m.levels.map((l) => l.z), [0, 3.5, 6.5]);
  assert.deepEqual(m.zones.map((z) => [z.base, z.top]), [[0, 1], [1, 2]]);
  // with nothing under it the roof zone would float; the ground zone holds it here
  assert.deepEqual(floatingZones(m), []);
  m.zones[1].plate = m.zones[1].plate.map(([x, y]) => [x + 30, y]);
  assert.deepEqual(floatingZones(m), [1]);
  assert.ok(!deleteZone(stack(storey0()), 0), 'the last zone stays');
});

test('a split from a re-entrant corner runs only to the first face it meets', () => {
  const m = massing0();
  // a U: the cut from an inner corner along x stops at the arm's far face; a whole line would also
  // cut through the other arm
  m.zones[0].plate = [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]];
  m.zones[0].faces = m.zones[0].plate.map(() => null);
  assert.equal(splitZone(structuredClone(m), 0, [8, 4], [9, 4]), -1);
  const n = splitZone(m, 0, [8, 4], [9, 4], { fromCorner: true });
  assert.ok(n > 0);
  const areas = [m.zones[0], m.zones[n]].map((z) => Math.abs(z.plate.reduce((a, p, k, P) => a + p[0] * P[(k + 1) % P.length][1] - P[(k + 1) % P.length][0] * p[1], 0) / 2)).sort((a, b) => a - b);
  assert.deepEqual(areas, [24, 72]);
  // a face's seam slides along its line
  const m2 = massing0();
  splitFace(m2, 0, 0, 5);
  near(slideSeam(m2, 0, 1, 2), 2);
  assert.deepEqual(m2.zones[0].plate[1], [-3, -5]);
});

test('a cut from a face, or from the roof, runs only to the faces it meets: the arm of a U splits alone', () => {
  const U = () => { const m = massing0(); m.zones[0].plate = [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]]; m.zones[0].faces = m.zones[0].plate.map(() => null); return m; };
  const area = (z) => Math.abs(z.plate.reduce((a, p, k, P) => a + p[0] * P[(k + 1) % P.length][1] - P[(k + 1) % P.length][0] * p[1], 0) / 2);
  // square to the arm's inner face (x = 8, facing -x) at y = 7: across the arm only
  let m = U(), n = splitZone(m, 0, [8, 7], [9, 7], { fromFace: true });
  assert.ok(n > 0);
  assert.deepEqual([area(m.zones[0]), area(m.zones[n])].sort((a, b) => a - b), [12, 84]);
  // from the roof of the arm along x at y = 7: the same
  m = U(); n = splitZone(m, 0, [10, 7], [11, 7], { within: true });
  assert.deepEqual([area(m.zones[0]), area(m.zones[n])].sort((a, b) => a - b), [12, 84]);
});

test('zones merged: the wall between goes; with seams kept the faces and the roof stay pieces', () => {
  const m = massing0(), n = splitZone(m, 0, [0, -10], [0, 10]); // the ground floor in two halves
  const merged = mergeZones(m, [0, n], true);
  assert.equal(merged, 0);
  assert.equal(m.zones.length, 2);
  const g = massingGeometry(m)[0];
  assert.equal(g.surfaces.filter((s) => s.type === 'Wall').length, 6); // front and back each two, the ends one
  assert.equal(g.surfaces.filter((s) => s.type === 'Floor').length, 2);
  assert.equal(zoneSeams(m, 0).walls.length, 2);
  assert.equal(zoneSeams(m, 0).cells.length, 1);
  // a seam taken out: one face; the roof pieces made one
  assert.ok(removeWallSeam(m, 0, zoneSeams(m, 0).walls[0]));
  assert.ok(mergeCells(m, 0, zoneSeams(m, 0).cells[0].cells));
  assert.equal(massingGeometry(m)[0].surfaces.filter((s) => s.type === 'Floor').length, 1);
  // without seams: one face each way, the floor whole
  const m2 = massing0(), n2 = splitZone(m2, 0, [0, -10], [0, 10]);
  mergeZones(m2, [0, n2], false);
  assert.equal(m2.zones[0].plate.length, 4);
  assert.ok(!m2.zones[0].cells);
  const model = importEpJSON(massingEpJSON(m2));
  assert.deepEqual(model.checks.filter((c) => c.level === 'error'), []);
  // zones on different levels are not merged
  assert.equal(typeof mergeZones(massing0(), [0, 1]), 'string');
  // faces merged: the seam between two faces in line goes
  const m3 = massing0(); splitFace(m3, 0, 0, 5);
  assert.ok(mergeFaces(m3, 0, [0, 1]));
  assert.equal(m3.zones[0].plate.length, 4);
});

test('a zone keeps its name when another before it is deleted', () => {
  const m = massing0(), j = addZone(m, 0, 1);
  const name = zoneName(m, j);
  deleteZone(m, 1);
  assert.equal(zoneName(m, m.zones.length - 1), name);
});
