// Self-contained tests: a 5 x 4 x 3 m box zone with one south window, built in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { area, azimuth, enclosedVolume, tilt, triangulate } from '../src/model/geometry.js';
import { classifySurface, importEpJSON } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { hourlyValues } from '../src/model/schedules.js';
import { coefficient, footprintAxis, toAirflowNetwork } from '../src/model/airflow-network.js';
import { doorOnWall, isCirculation } from '../src/model/interior-doors.js';

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

test('airflow network variant: one opening per window, cracks sized by area, simple airflow removed', () => {
  const m = importEpJSON(boxModel());
  const ep = toAirflowNetwork(m);
  assert.equal(ep['ZoneVentilation:WindandStackOpenArea'], undefined);
  assert.equal(ep['ZoneInfiltration:DesignFlowRate'], undefined);
  assert.equal(m.epjson['ZoneVentilation:WindandStackOpenArea'] !== undefined, true, 'the imported model is left unchanged');
  const zone = ep['AirflowNetwork:MultiZone:Zone']['AFN Zone Room'];
  assert.equal(zone.ventilation_control_mode, 'Temperature');
  assert.equal(zone.venting_availability_schedule_name, 'Always');
  const surfaces = ep['AirflowNetwork:MultiZone:Surface'];
  // Five exterior surfaces (the ground floor has no crack) and the window.
  assert.equal(Object.keys(surfaces).length, 6);
  const win = surfaces['AFN Surface Room:south:w0'];
  near(win.window_door_opening_factor_or_crack_factor, 0.5); // 1.5 m2 opening / 3 m2 window
  assert.equal(ep['AirflowNetwork:MultiZone:Component:SimpleOpening'][win.leakage_component_name].discharge_coefficient, 0.6);
  // 1 m3/h per m2 at 50 Pa: the 15 m2 south wall leaks 15 m3/h at 50 Pa.
  const crack = ep['AirflowNetwork:MultiZone:Surface:Crack']['AFN Crack Room:south'];
  near(crack.air_mass_flow_coefficient_at_reference_conditions * 50 ** 0.65 * 3600 / 1.2041, 15, 1e-9);
  near(coefficient(15, 0.65), crack.air_mass_flow_coefficient_at_reference_conditions);
  // The 5 x 4 m footprint runs east-west, so its long axis is at 90 degrees from north.
  const axis = footprintAxis(m);
  near(axis.azimuth, 90);
  near(axis.ratio, 0.8);
});

test('interior door: centred at the foot of a wall, facing the same way, or none if it does not fit', () => {
  const door = doorOnWall(BOX.south); // 5 m wide, 3 m tall, facing south
  near(area(door), 0.9 * 2.1);
  near(azimuth(door), 180);
  near(Math.min(...door.map((p) => p[2])), 0.02);
  near((Math.min(...door.map((p) => p[0])) + Math.max(...door.map((p) => p[0]))) / 2, 2.5);
  assert.ok(door.every((p) => Math.abs(p[1]) < 1e-12), 'in the plane of the wall');
  assert.equal(doorOnWall([[0, 0, 2], [0, 0, 0], [0.8, 0, 0], [0.8, 0, 2]]), null); // too narrow and too low
  assert.equal(doorOnWall(BOX.floor), null);
  assert.ok(isCirculation('GF_Circ_1_4') && isCirculation('3F_Stair_2') && !isCirculation('Elevator_Stair_Core') && !isCirculation('Office'));
});

test('sashes: free area grows with the angle, awnings open through their side triangles, limits are reported', async () => {
  const { freeFraction, sashAngle } = await import('../src/model/sash.js');
  // A 1 x 1 m casement at 90 degrees: edge gap 1 x 2 sin 45 = 1.41 m2 plus a 0.5 m2 triangle: fully free.
  near(freeFraction('casement', 1, 1, 90), 1);
  near(freeFraction('casement', 1, 1, 10), Math.min(1, 2 * Math.sin((5 * Math.PI) / 180) + Math.sin((10 * Math.PI) / 180)), 1e-12);
  // The same tall window (1.3 x 2.4 m) needs a smaller angle as an awning than as a casement for 80%.
  const casement = sashAngle('casement', 1.3, 2.4, 0.8), awning = sashAngle('awning', 1.3, 2.4, 0.8);
  near(freeFraction('casement', 1.3, 2.4, casement.angle), 0.8, 1e-9);
  assert.ok(awning.angle < casement.angle, `awning ${awning.angle} vs casement ${casement.angle}`);
  // A short, wide hopper limited to 35 degrees cannot reach 80%.
  const hopper = sashAngle('hopper', 2, 0.5, 0.8);
  assert.equal(hopper.reachable, false);
  assert.equal(hopper.angle, 35);
  near(hopper.fraction, freeFraction('hopper', 2, 0.5, 35), 1e-12);
});
