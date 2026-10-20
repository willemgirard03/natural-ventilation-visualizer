// Imports the two ClimateStudio examples and checks the model against EnergyPlus's own reading of
// the same files (the .eio report in each results folder) and against facts recorded in PLAN.md.
// The course files live outside the repository; these tests are skipped when they are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importEpJSON } from '../src/model/import-epjson.js';
import { area, dot, triangulate, unitNormal } from '../src/model/geometry.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { hourlyValues } from '../src/model/schedules.js';

const A2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLES = {
  example02: path.join(A2, 'Example 02', 'Results', '2226_Emmenweid'),
  example01: path.join(A2, 'Example 01', 'CS Results', 'Willem_Girard_CS_V3'),
};

const cache = {};
function load(key) {
  if (!cache[key]) {
    const base = EXAMPLES[key];
    const epjson = JSON.parse(readFileSync(base + '.epJSON', 'utf8'));
    cache[key] = { epjson, model: importEpJSON(structuredClone(epjson), { fileName: path.basename(base) + '.epJSON' }), eio: readEio(base + 'out.eio') };
  }
  return cache[key];
}

// Rows of the .eio report by record name, each keyed by zone name in upper case.
function readEio(file) {
  const rows = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('!')) continue;
    const cols = line.split(',').map((c) => c.trim());
    const record = cols[0];
    if (!['Zone Information', 'ZoneInfiltration Airflow Stats Nominal', 'People Internal Gains Nominal', 'Lights Internal Gains Nominal', 'ElectricEquipment Internal Gains Nominal'].includes(record)) continue;
    const zone = record === 'Zone Information' ? cols[1] : cols[3];
    (rows[record] ||= {})[zone.toUpperCase()] = cols;
  }
  return rows;
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs EnergyPlus ${b}`);

for (const key of Object.keys(EXAMPLES)) {
  const skip = existsSync(EXAMPLES[key] + '.epJSON') ? false : `${key} files not found in ${A2}`;

  test(`${key}: every zone matches EnergyPlus's own report`, { skip }, () => {
    const { model, eio } = load(key);
    const info = eio['Zone Information'];
    assert.equal(Object.keys(model.zones).length, Object.keys(info).length);
    // Surfaces the importer flags as reversed are left out of the extents: in Example_01,
    // GF_Circ_5:f9 is also 1.79 m longer than the zone, and EnergyPlus's extents ignore it.
    const flagged = new Set(model.checks.filter((c) => c.code === 'zone-surface-reversed').map((c) => c.objects[1]));
    for (const z of Object.values(model.zones)) {
      const e = info[z.name.toUpperCase()];
      const pts = z.surfaces.filter((n) => !flagged.has(n)).flatMap((n) => model.surfaces[n].vertices);
      const min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
      const max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
      for (let i = 0; i < 3; i++) {
        near(min[i], +e[12 + 2 * i], 0.006, `${z.name} min ${'xyz'[i]}`);
        near(max[i], +e[13 + 2 * i], 0.006, `${z.name} max ${'xyz'[i]}`);
      }
      near(z.volume.value, +e[19], 0.006, `${z.name} volume`);
      near(z.computedVolume, +e[19], 0.01 * +e[19], `${z.name} volume from surfaces`);
      near(z.floorArea.value, +e[22], 0.006, `${z.name} floor area`);
      near(z.glazingArea, +e[25], 0.006, `${z.name} window area`);
    }
  });

  test(`${key}: infiltration and internal gains match EnergyPlus's own report`, { skip }, () => {
    const { model, eio } = load(key);
    for (const z of Object.values(model.zones)) {
      const Z = z.name.toUpperCase();
      const inf = eio['ZoneInfiltration Airflow Stats Nominal']?.[Z];
      if (inf) near(z.infiltration.flowRate, +inf[6], 5e-4 * +inf[6], `${z.name} infiltration flow`); // .eio has 4 significant figures
      else assert.equal(z.infiltration, null, `${z.name} has infiltration EnergyPlus did not report`);
      const ppl = eio['People Internal Gains Nominal']?.[Z];
      if (ppl) near(z.people.density.value, +ppl[7], 5e-4, `${z.name} people per m2`);
      const lights = eio['Lights Internal Gains Nominal']?.[Z];
      if (lights) near(z.lights.powerDensity.value, +lights[7], 0.006, `${z.name} lighting W/m2`);
      const equip = eio['ElectricEquipment Internal Gains Nominal']?.[Z];
      if (equip) near(z.equipment.powerDensity.value, +equip[7], 0.006, `${z.name} equipment W/m2`);
    }
  });

  test(`${key}: export reproduces the input file exactly`, { skip }, () => {
    const { epjson, model } = load(key);
    assert.deepEqual(exportEpJSON(model), epjson);
    assert.deepEqual(JSON.parse(serializeEpJSON(exportEpJSON(model))), epjson);
  });
}

const skip02 = existsSync(EXAMPLES.example02 + '.epJSON') ? false : 'Example 02 not found';
const skip01 = existsSync(EXAMPLES.example01 + '.epJSON') ? false : 'Example 01 not found';
const ventilated = (m) => Object.values(m.zones).filter((z) => z.ventilation);

test('example02: facts recorded in PLAN.md', { skip: skip02 }, () => {
  const { epjson, model } = load('example02');
  assert.equal(Object.keys(model.zones).length, 12);
  assert.equal(Object.keys(model.windows).length, 60);
  assert.equal(ventilated(model).length, 5);
  for (const z of ventilated(model)) near(z.ventilation.operableFraction.value, 0.8, 1e-3, `${z.name} operable fraction`);
  const office = model.zones['2F_Office_8'];
  near(office.height, 8, 1e-6, 'double-height office');
  near(office.glazingArea, 102, 0.5, 'double-height office window area');
  const stair = model.zones.GF_Stairwell_6;
  near(stair.height, 12, 1e-6, 'stairwell height');
  assert.equal(stair.windows.length, 0);
  assert.ok(Object.values(model.windows).every((w) => model.surfaces[w.parent].csType === 'Facade'));
  assert.equal(office.people.co2GenerationRate.value, 3.82e-8);
  // One wind object per window in this model, each facing that window's direction
  assert.equal(office.ventilation.wind.length, office.windows.length);
  assert.deepEqual(model.checks, []);
  const occ = hourlyValues(epjson, office.people.schedule);
  near(Math.max(...occ), 0.95, 1e-9, 'occupancy peak');
});

test('example01: facts recorded in PLAN.md', { skip: skip01 }, () => {
  const { epjson, model } = load('example01');
  assert.equal(Object.keys(model.zones).length, 46);
  assert.equal(Object.keys(model.windows).length, 92);
  assert.equal(ventilated(model).length, 31);
  for (const z of ventilated(model)) near(z.ventilation.operableFraction.value, 0.8, 1e-3, `${z.name} operable fraction`);
  const maker = model.zones.GF_Maker_0;
  near(maker.people.density.value, 0.0565, 1e-4, 'people density');
  near(maker.people.activityLevel.value, 125.28, 1e-9, 'activity level');
  near(maker.lights.powerDensity.value, 6.57, 0.01, 'lighting');
  near(maker.equipment.powerDensity.value, 10.33, 0.01, 'equipment');
  // Constructions table in PLAN.md: thickness m, R m2.K/W, C kJ/m2.K
  const table = {
    '2226 Exterior Wall': [0.795, 7.39, 609],
    'NECB-2020 Non-residential Library CZ 8 Exterior Roof (Mass)': [0.509, 8.95, 479],
    '200mmConcrete': [0.2, 0.1, 456],
    '300mmConcrete 80mmInsulation 80mmScreed': [0.46, 2.56, 848],
    '300mmInsulation 200mmConcrete': [0.5, 8.92, 471],
    defaultConstruction: [0.25, 0.11, 504],
  };
  for (const [name, [t, R, C]] of Object.entries(table)) {
    const c = model.constructions[name];
    near(c.thickness, t, 5e-4, `${name} thickness`);
    near(c.R, R, 0.005, `${name} R`);
    near(c.C / 1000, C, 0.5, `${name} C`);
  }
  assert.equal(model.constructions.TriplePaneLoE.uFactor, 0.785);
  // The two reversed surfaces EnergyPlus also warns about, and the default external floors
  const codes = model.checks.map((c) => `${c.code}:${c.objects.join('|')}`);
  assert.ok(codes.includes('zone-surface-reversed:3F_Workspace_2_25|3F_Workspace_2_25:f8'));
  assert.ok(codes.includes('zone-surface-reversed:GF_Circ_5|GF_Circ_5:f9'));
  assert.ok(codes.includes('surface-upside-down:3F_Workspace_2_25:f8'));
  assert.equal(model.checks.find((c) => c.code === 'default-construction').objects.length, 8);
  const avail = hourlyValues(epjson, maker.ventilation.schedule);
  near(avail.reduce((a, b) => a + b) / 8760, 0.47, 0.01, 'window availability');
});

for (const key of Object.keys(EXAMPLES)) {
  const skip = existsSync(EXAMPLES[key] + '.epJSON') ? false : `${key} files not found in ${A2}`;
  test(`${key}: every polygon triangulates for the 3D view, area and facing kept`, { skip }, () => {
    const { model } = load(key);
    const polys = [...Object.values(model.surfaces), ...Object.values(model.windows), ...model.shading];
    for (const s of polys) {
      const tris = triangulate(s.vertices).map((t) => t.map((i) => s.vertices[i]));
      const covered = tris.reduce((a, t) => a + area(t), 0);
      near(covered, area(s.vertices), 1e-6 * Math.max(1, area(s.vertices)), `${s.name} triangle area`);
      const n = unitNormal(s.vertices);
      for (const t of tris) assert.ok(dot(unitNormal(t), n) > 0.999, `${s.name} triangle faces the wrong way`);
    }
  });
}

test('example02: interior doors join rooms, circulation and the stairwell on both floors', { skip: skip02 }, async () => {
  const { interiorDoors } = await import('../src/model/interior-doors.js');
  const { toAirflowNetwork } = await import('../src/model/airflow-network.js');
  const { model } = load('example02');
  const doors = interiorDoors(model);
  assert.equal(doors.length, 17);
  for (const d of doors) {
    const wall = model.surfaces[d.surface], other = model.surfaces[d.partnerSurface];
    assert.ok(dot(unitNormal(d.vertices), unitNormal(wall.vertices)) > 0.9999, `${d.name} faces like its wall`);
    assert.ok(dot(unitNormal(d.partnerVertices), unitNormal(other.vertices)) > 0.9999, `${d.partnerName} faces like its wall`);
  }
  const stair = doors.filter((d) => [d.zone, d.partnerZone].includes('GF_Stairwell_6'));
  assert.deepEqual([...new Set(stair.map((d) => Math.round(d.vertices[1][2])))].sort(), [0, 4]); // a door on each floor
  const ep = toAirflowNetwork(model);
  assert.equal(Object.values(ep['FenestrationSurface:Detailed']).filter((f) => f.surface_type === 'Door').length, 34);
});
