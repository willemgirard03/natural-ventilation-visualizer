// Self-contained tests: a 5 x 4 x 3 m box zone with one south window, built in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { area, azimuth, enclosedVolume, tilt, triangulate } from '../src/model/geometry.js';
import { classifySurface, importEpJSON } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { hourlyValues } from '../src/model/schedules.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const v = (x, y, z) => ({ vertex_x_coordinate: x, vertex_y_coordinate: y, vertex_z_coordinate: z });

// Vertices counterclockwise seen from outside, starting at the upper left corner.
const BOX = {
  south: [[0, 0, 3], [0, 0, 0], [5, 0, 0], [5, 0, 3]],
  east: [[5, 0, 3], [5, 0, 0], [5, 4, 0], [5, 4, 3]],
  north: [[5, 4, 3], [5, 4, 0], [0, 4, 0], [0, 4, 3]],
  west: [[0, 4, 3], [0, 4, 0], [0, 0, 0], [0, 0, 3]],
  floor: [[0, 4, 0], [5, 4, 0], [5, 0, 0], [0, 0, 0]],
  roof: [[0, 0, 3], [5, 0, 3], [5, 4, 3], [0, 4, 3]],
};

function boxModel({ reverseFloor = false } = {}) {
  const surface = (type, pts, boundary = 'Outdoors') => ({
    zone_name: 'Room', surface_type: type, construction_name: 'Wall', outside_boundary_condition: boundary,
    number_of_vertices: pts.length, vertices: pts.map((p) => v(...p)),
  });
  const floor = reverseFloor ? [...BOX.floor].reverse() : BOX.floor;
  return {
    Version: { 'Version 1': { version_identifier: '23.1' } },
    Building: { Building: { north_axis: 0, terrain: 'Suburbs' } },
    GlobalGeometryRules: { 'GlobalGeometryRules 1': { coordinate_system: 'Relative', starting_vertex_position: 'UpperLeftCorner', vertex_entry_direction: 'Counterclockwise' } },
    RunPeriod: { Year: { begin_month: 1, begin_day_of_month: 1, end_month: 12, end_day_of_month: 31, day_of_week_for_start_day: 'Monday' } },
    Zone: { Room: { x_origin: 0, y_origin: 0, z_origin: 0 } },
    Material: { Brick: { thickness: 0.2, conductivity: 0.8, density: 1800, specific_heat: 900, roughness: 'Rough' } },
    'WindowMaterial:SimpleGlazingSystem': { Glass: { u_factor: 1.2, solar_heat_gain_coefficient: 0.5, visible_transmittance: 0.6 } },
    Construction: { Wall: { outside_layer: 'Brick' }, Window: { outside_layer: 'Glass' } },
    'BuildingSurface:Detailed': {
      'Room:south': surface('Wall', BOX.south), 'Room:east': surface('Wall', BOX.east),
      'Room:north': surface('Wall', BOX.north), 'Room:west': surface('Wall', BOX.west),
      'Room:floor': surface('Floor', floor, 'Ground'), 'Room:roof': surface('Roof', BOX.roof),
    },
    'FenestrationSurface:Detailed': {
      'Room:south:w0': {
        building_surface_name: 'Room:south', construction_name: 'Window', surface_type: 'Window', number_of_vertices: 4,
        vertex_1_x_coordinate: 1, vertex_1_y_coordinate: 0, vertex_1_z_coordinate: 2.5,
        vertex_2_x_coordinate: 1, vertex_2_y_coordinate: 0, vertex_2_z_coordinate: 1,
        vertex_3_x_coordinate: 3, vertex_3_y_coordinate: 0, vertex_3_z_coordinate: 1,
        vertex_4_x_coordinate: 3, vertex_4_y_coordinate: 0, vertex_4_z_coordinate: 2.5,
      },
    },
    'ZoneVentilation:WindandStackOpenArea': {
      Room_Buoy: { zone_or_space_name: 'Room', opening_area: 1.5, opening_effectiveness: 0, discharge_coefficient_for_opening: 0.6, height_difference: 0.375, minimum_indoor_temperature: 25, delta_temperature: 1, opening_area_fraction_schedule_name: 'Always' },
      Room_Wind0: { zone_or_space_name: 'Room', opening_area: 1.5, opening_effectiveness: 'Autocalculate', discharge_coefficient_for_opening: 0, effective_angle: 180, opening_area_fraction_schedule_name: 'Always' },
    },
    'ZoneInfiltration:DesignFlowRate': { Room_Inf: { zone_or_zonelist_or_space_or_spacelist_name: 'Room', design_flow_rate_calculation_method: 'AirChanges/Hour', air_changes_per_hour: 0.5, schedule_name: 'Always' } },
    'Schedule:Constant': { Always: { hourly_value: 1 } },
  };
}

test('geometry: area, orientation and volume of the box', () => {
  near(area(BOX.south), 15);
  near(azimuth(BOX.south), 180);
  near(azimuth(BOX.east), 90);
  near(azimuth(BOX.east, 30), 120); // building rotated 30 degrees from true north
  assert.equal(azimuth(BOX.roof), null);
  near(tilt(BOX.roof), 0);
  near(tilt(BOX.floor), 180);
  near(tilt(BOX.north), 90);
  near(enclosedVolume(Object.values(BOX)), 60);
});

test('surface classification follows ClimateStudio surface types', () => {
  assert.equal(classifySurface('Wall', 'Outdoors'), 'Facade');
  assert.equal(classifySurface('Wall', 'Surface'), 'Partition');
  assert.equal(classifySurface('Wall', 'GroundFCfactorMethod'), 'Ground Wall');
  assert.equal(classifySurface('Floor', 'Ground'), 'Ground Slab');
  assert.equal(classifySurface('Floor', 'Outdoors'), 'External Floor');
  assert.equal(classifySurface('Ceiling', 'Surface'), 'Slab');
  assert.equal(classifySurface('Roof', 'Outdoors'), 'Roof');
  assert.equal(classifySurface('Wall', 'Adiabatic'), 'Adiabatic Wall');
});

test('box zone imports with geometry, window, ventilation and constructions', () => {
  const m = importEpJSON(boxModel());
  const room = m.zones.Room;
  near(room.computedVolume, 60);
  near(room.computedFloorArea, 20);
  near(room.height, 3);
  assert.equal(room.volume.source, 'local'); // the file declares no volume, so the computed one is used
  const w = m.windows['Room:south:w0'];
  near(w.area, 3);
  near(w.azimuth, 180);
  near(w.height, 1.5);
  assert.equal(w.zone, 'Room');
  assert.equal(w.sashType.value, 'casement');
  near(w.operableFraction.value, 0.5);
  assert.equal(w.operableFraction.source, 'inherited');
  assert.equal(room.ventilation.stack.length, 1);
  assert.equal(room.ventilation.wind.length, 1);
  assert.equal(room.ventilation.controls.minIndoorTemperature.value, 25);
  near(room.infiltration.airChangesPerHour, 0.5);
  assert.equal(m.surfaces['Room:south'].csType, 'Facade');
  assert.equal(m.surfaces['Room:floor'].csType, 'Ground Slab');
  const wall = m.constructions.Wall;
  near(wall.R, 0.25);
  near(wall.C, 1800 * 900 * 0.2);
  near(wall.thickness, 0.2);
  assert.equal(m.constructions.Window.uFactor, 1.2);
  assert.deepEqual(m.checks, []);
});

test('a reversed floor is found and named', () => {
  const m = importEpJSON(boxModel({ reverseFloor: true }));
  const codes = m.checks.map((c) => c.code);
  assert.ok(codes.includes('surface-upside-down'));
  const reversed = m.checks.find((c) => c.code === 'zone-surface-reversed');
  assert.deepEqual(reversed.objects, ['Room', 'Room:floor']);
  near(m.zones.Room.computedVolume, 60);
});

test('schedules expand to 8,760 hours with the right weekdays', () => {
  const ep = {
    RunPeriod: { Y: { day_of_week_for_start_day: 'Monday' } },
    'Schedule:Day:Hourly': {
      Work: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [`hour_${h + 1}`, h >= 8 && h < 17 ? 1 : 0])),
      Off: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [`hour_${h + 1}`, 0])),
    },
    'Schedule:Week:Daily': {
      Week: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        .map((d) => [`${d}_schedule_day_name`, d === 'sunday' || d === 'saturday' ? 'Off' : 'Work'])),
    },
    'Schedule:Year': { Occ: { schedule_weeks: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31, schedule_week_name: 'Week' }] } },
  };
  const occ = hourlyValues(ep, 'Occ');
  assert.equal(occ.length, 8760);
  assert.equal(occ[9], 1); // Monday 1 January, 09:00-10:00
  assert.equal(occ[5 * 24 + 9], 0); // Saturday 6 January
  assert.equal(occ.reduce((a, b) => a + b), 261 * 9); // 261 weekdays in a year starting on Monday
  assert.equal(hourlyValues(ep, 'Missing'), null);
});

test('export returns the imported objects unchanged and separate from the model', () => {
  const ep = boxModel();
  const m = importEpJSON(structuredClone(ep));
  const out = exportEpJSON(m);
  assert.deepEqual(out, ep);
  out.Zone.Room.x_origin = 99;
  assert.equal(m.epjson.Zone.Room.x_origin, 0);
  assert.deepEqual(JSON.parse(serializeEpJSON(exportEpJSON(m))), ep);
});

test('triangulation covers concave and collinear outlines and keeps their facing', () => {
  // L-shaped wall facing south (-y), with an extra vertex along its bottom edge.
  const L = [[0, 0, 0], [2, 0, 0], [4, 0, 0], [4, 0, 1], [1, 0, 1], [1, 0, 3], [0, 0, 3]];
  const tris = triangulate(L);
  const triArea = tris.reduce((s, t) => s + area(t.map((i) => L[i])), 0);
  assert.ok(Math.abs(triArea - area(L)) < 1e-9, `triangles cover ${triArea} m2 of ${area(L)} m2`);
  for (const t of tris) assert.equal(Math.round(azimuth(t.map((i) => L[i]))), 180);
  assert.deepEqual(triangulate([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), [[0, 1, 2]]);
});
