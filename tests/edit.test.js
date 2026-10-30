// Edits to Example_02's .epJSON (src/model/edit.js): each is checked by reading the edited file again,
// as the tool does, and each undoes to the file as it was. Skipped when the example is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importEpJSON } from '../src/model/import-epjson.js';
import { dot, unitNormal } from '../src/model/geometry.js';
import { constructionProperties } from '../src/model/constructions.js';
import {
  edit, windowRect, rectProblem, clampRect, setWindowRect, setSurfaceConstruction, copyConstruction, setLayer,
  addLayer, removeLayer, layersOf, setZoneSetting, zoneSettings, outdoorAirSpec, toZone,
} from '../src/model/edit.js';
import { toBuilding } from '../src/model/geometry.js';
import * as lib from '../src/model/edit.js';

const FILE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'Example 02', 'Results', '2226_Emmenweid.epJSON');
const skip = !existsSync(FILE) && 'Example_02 is not on this computer';
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const fresh = () => { const epjson = JSON.parse(readFileSync(FILE, 'utf8')); return { epjson, model: importEpJSON(epjson) }; };
const WIN = '2F_Office_8:f4:w0';

test('zone coordinates go back and forth', () => {
  const zone = { x_origin: 3, y_origin: -2, z_origin: 1, direction_of_relative_north: 30 };
  const p = [[1, 2, 3], [-4, 5, 0]];
  toBuilding(toZone(p, zone), zone).forEach((q, i) => q.forEach((x, j) => near(x, p[i][j])));
});

test('a window moved in its wall stays in it, faces out, and undoes', { skip }, () => {
  const { epjson, model } = fresh();
  const before = JSON.stringify(epjson);
  const r = windowRect(model, WIN), w = model.windows[WIN];
  const moved = { s0: r.s0 - 0.3, s1: r.s1 - 0.3, z0: r.z0, z1: r.z1 - 0.4 };
  assert.equal(rectProblem(model, WIN, moved), null);
  const e = edit(epjson, (tx) => setWindowRect(tx, model, WIN, moved));
  const m2 = importEpJSON(epjson), w2 = m2.windows[WIN], r2 = windowRect(m2, WIN);
  near(r2.s0, moved.s0); near(r2.s1, moved.s1); near(r2.z1, moved.z1);
  assert.ok(dot(unitNormal(w2.vertices), unitNormal(m2.surfaces[w2.parent].vertices)) > 0.999, 'faces the way its wall does');
  assert.equal(m2.checks.filter((c) => c.objects.includes(WIN)).length, 0, 'no model check names it');
  // The opening area follows the glazing, so the operable fraction holds.
  near(m2.zones[w.zone].ventilation.operableFraction.value, model.zones[w.zone].ventilation.operableFraction.value, 1e-6);
  e.undo();
  assert.equal(JSON.stringify(epjson), before);
  e.redo();
  near(windowRect(importEpJSON(epjson), WIN).z1, moved.z1);
});

test('a window cannot leave its wall or overlap another', { skip }, () => {
  const { model } = fresh();
  const r = windowRect(model, WIN);
  assert.match(rectProblem(model, WIN, { ...r, z1: r.z1 + 50 }), /past its wall/);
  assert.match(rectProblem(model, WIN, { ...r, s1: r.s0 + 0.1 }), /at least/);
  const c = clampRect(model, WIN, { ...r, z0: r.z0 + 50, z1: r.z1 + 50 });
  assert.ok(c.z1 - c.z0 > r.z1 - r.z0 - 1e-9 && c.z1 < r.z1 + 50);
  const wall = model.surfaces[model.windows[WIN].parent];
  const other = wall.windows.find((n) => n !== WIN);
  if (other) assert.match(rectProblem(model, WIN, windowRect(model, other)), /overlap/);
});

test('a shared wall takes a construction on both sides, one reversed', { skip }, () => {
  const { epjson, model } = fresh();
  const s = Object.values(model.surfaces).find((x) => x.boundary === 'Surface' && x.surfaceType === 'Wall');
  const to = Object.keys(epjson.Construction).find((n) => !n.endsWith('_FLIPPED') && n !== s.construction.replace(/_FLIPPED$/, '') && !constructionProperties(epjson, n).glazing);
  const e = edit(epjson, (tx) => setSurfaceConstruction(tx, model, s.name, to));
  const m2 = importEpJSON(epjson), a = m2.surfaces[s.name].construction, b = m2.surfaces[s.adjacentSurface].construction;
  assert.deepEqual([a, b].map((x) => x.replace(/_FLIPPED$/, '')), [to, to]);
  assert.notEqual(a, b);
  assert.deepEqual(layersOf(epjson.Construction[to + '_FLIPPED']), layersOf(epjson.Construction[to]).reverse());
  assert.equal(m2.checks.filter((c) => c.level === 'error').length, 0);
  e.undo();
});

test('a layer made thicker changes only its own construction', { skip }, () => {
  const { epjson } = fresh();
  const name = Object.keys(epjson.Construction).find((n) => !n.endsWith('_FLIPPED') && layersOf(epjson.Construction[n]).some((m) => epjson.Material?.[m]));
  const i = layersOf(epjson.Construction[name]).findIndex((m) => epjson.Material?.[m]);
  const R0 = constructionProperties(epjson, name).R, m = layersOf(epjson.Construction[name])[i];
  const others = JSON.stringify(Object.fromEntries(Object.entries(epjson.Construction).filter(([n]) => n.replace(/_FLIPPED$/, '') !== name)));
  const t0 = epjson.Material[m].thickness;
  edit(epjson, (tx) => setLayer(tx, name, i, { thickness: t0 * 2 }));
  const R1 = constructionProperties(epjson, name).R;
  near(R1 - R0, t0 / epjson.Material[layersOf(epjson.Construction[name])[i]].conductivity, 1e-9);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(epjson.Construction).filter(([n]) => n.replace(/_FLIPPED$/, '') !== name))), others);
  if (epjson.Construction[name + '_FLIPPED']) assert.deepEqual(layersOf(epjson.Construction[name + '_FLIPPED']), layersOf(epjson.Construction[name]).reverse());
  // Layers added and removed, and a copy that does not share materials.
  const n0 = layersOf(epjson.Construction[name]).length;
  edit(epjson, (tx) => addLayer(tx, name, 0, m));
  assert.equal(layersOf(epjson.Construction[name]).length, n0 + 1);
  edit(epjson, (tx) => removeLayer(tx, name, 0));
  edit(epjson, (tx) => copyConstruction(tx, name, 'My wall'));
  assert.ok(layersOf(epjson.Construction['My wall']).every((x) => !layersOf(epjson.Construction[name]).includes(x)));
});

test('zone settings are written to the zone\'s own objects', { skip }, () => {
  const { epjson } = fresh();
  const zone = '2F_Office_8';
  assert.ok(outdoorAirSpec(epjson, zone));
  const e = edit(epjson, (tx) => {
    setZoneSetting(tx, zone, 'peoplePerArea', 0.1);
    setZoneSetting(tx, zone, 'lightsPerArea', 5);
    setZoneSetting(tx, zone, 'equipmentPerArea', 8);
    setZoneSetting(tx, zone, 'infiltrationAch', 0.3);
    setZoneSetting(tx, zone, 'outdoorAirPerPerson', 0.01);
    setZoneSetting(tx, zone, 'ventMinIndoor', 23);
  });
  const s = zoneSettings(epjson, zone);
  assert.deepEqual([s.peoplePerArea, s.lightsPerArea, s.equipmentPerArea, s.infiltrationAch, s.outdoorAirPerPerson, s.ventMinIndoor], [0.1, 5, 8, 0.3, 0.01, 23]);
  const m2 = importEpJSON(epjson).zones[zone];
  near(m2.people.density.value, 0.1); near(m2.infiltration.airChangesPerHour, 0.3);
  assert.equal(zoneSettings(epjson, 'GF_Office_1_0').peoplePerArea !== 0.1, true, 'other zones untouched');
  e.undo();
  assert.notEqual(zoneSettings(epjson, zone).peoplePerArea, 0.1);
});

test('the library: layers reordered, materials and assemblies made, renamed and removed', { skip }, () => {
  const { epjson } = fresh();
  const { moveLayer, newMaterial, newConstruction, rename, setMaterialField, removeMaterial, removeConstruction, constructionUses, materialUses, schedulesOfType } = lib;
  const name = Object.keys(epjson.Construction).find((n) => !n.endsWith('_FLIPPED') && layersOf(epjson.Construction[n]).length > 1);
  const l0 = layersOf(epjson.Construction[name]);
  edit(epjson, (tx) => moveLayer(tx, name, 0, 1));
  assert.deepEqual(layersOf(epjson.Construction[name]), [l0[1], l0[0], ...l0.slice(2)]);
  let m, c;
  edit(epjson, (tx) => { m = newMaterial(tx, 'Material', 'Hemp'); setMaterialField(tx, m, 'conductivity', 0.04); c = newConstruction(tx, 'Hemp wall', [m]); });
  assert.equal(materialUses(epjson, m), 1);
  edit(epjson, (tx) => rename(tx, 'material', m, 'Hempcrete'));
  assert.deepEqual(layersOf(epjson.Construction[c]), ['Hempcrete']);
  const used = Object.values(epjson['BuildingSurface:Detailed'])[0].construction_name.replace(/_FLIPPED$/, '');
  const n = constructionUses(epjson, used);
  edit(epjson, (tx) => rename(tx, 'construction', used, 'Renamed'));
  assert.equal(constructionUses(epjson, 'Renamed'), n);
  assert.equal(importEpJSON(epjson).checks.filter((x) => x.level === 'error').length, 0);
  assert.throws(() => edit(epjson, (tx) => removeConstruction(tx, 'Renamed')), /used by surfaces/);
  edit(epjson, (tx) => { removeConstruction(tx, c); removeMaterial(tx, 'Hempcrete'); });
  assert.equal(epjson.Material.Hempcrete, undefined);
  assert.ok(schedulesOfType(epjson, 'Fraction').every((x) => !Object.keys(epjson.Zone).some((z) => x.includes(z))));
});
