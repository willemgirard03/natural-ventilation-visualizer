// Turns an imported model into its EnergyPlus airflow network variant (AirflowNetwork objects),
// so EnergyPlus computes flow between zones as well as with outdoors. This is the reference the
// tool's own network solver is checked against (PLAN.md, EnergyPlus foundation).
//
// The settings follow ClimateStudio's simple airflow where the two overlap:
// - each exterior window is a simple opening with discharge coefficient 0.6, open over
//   (opening area / glazing area) of its area, the operable fraction ClimateStudio used;
// - a zone's windows open when the zone is above 25 degC and warmer than outdoors, and only in
//   hours ClimateStudio's availability schedule allows (it already applies the outdoor limits);
// - wind pressure coefficients come from EnergyPlus's surface-averaged formula for the building's
//   footprint, as ClimateStudio's network mode does by default.
// Leakage replaces the constant infiltration: every exterior and interzone surface has a crack
// sized by its area, and every window a crack along its edges when closed.
// Interior doors added by the tool (interior-doors.js) are written as door pairs and are always open.

import { area, fromBuilding } from './geometry.js';
import { interiorDoors } from './interior-doors.js';

export const NETWORK_DEFAULTS = {
  dischargeCoefficient: 0.6,
  ventSetpoint: 25, // degC
  // Leakage as volume flow at 50 Pa, the blower-door figure: m3/h per m2 of surface, per m of window edge.
  surfaceLeakage50: 1.0,
  windowLeakage50: 0.5,
  flowExponent: 0.65,
  doors: true, // add interior doors between rooms and circulation
};

const RHO = 1.2041; // kg/m3, air at 20 degC
// Mass flow coefficient at 1 Pa (kg/s/Pa^n) from a volume flow at 50 Pa (m3/h).
export const coefficient = (q50, n) => (RHO * q50) / 3600 / 50 ** n;

// Long axis of the footprint: the smallest rectangle around all surface corners in plan, tried at
// every degree. Returns its azimuth (degrees clockwise from north, 0-180) and short/long side ratio.
export function footprintAxis(model) {
  const pts = Object.values(model.surfaces).flatMap((s) => s.vertices);
  let best = null;
  for (let deg = 0; deg < 90; deg++) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const u = pts.map(([x, y]) => x * c + y * s), v = pts.map(([x, y]) => -x * s + y * c);
    const w = Math.max(...u) - Math.min(...u), h = Math.max(...v) - Math.min(...v);
    if (!best || w * h < best.area - 1e-9) best = { area: w * h, deg, w, h };
  }
  // The u axis points along (cos a, sin a) in model x, y; its azimuth from north is 90 - a.
  const along = best.w >= best.h ? 90 - best.deg : -best.deg;
  const azimuth = (((along + model.site.northAxis) % 180) + 180) % 180;
  return { azimuth, ratio: Math.min(best.w, best.h) / Math.max(best.w, best.h) };
}

export function toAirflowNetwork(model, options = {}) {
  const o = { ...NETWORK_DEFAULTS, ...options };
  const ep = structuredClone(model.epjson);
  // Simple airflow objects are replaced by the network.
  delete ep['ZoneVentilation:WindandStackOpenArea'];
  delete ep['ZoneInfiltration:DesignFlowRate'];

  const axis = footprintAxis(model);
  ep['AirflowNetwork:SimulationControl'] = {
    'AFN Control': {
      airflownetwork_control: 'MultizoneWithoutDistribution',
      wind_pressure_coefficient_type: 'SurfaceAverageCalculation',
      height_selection_for_local_wind_pressure_calculation: 'OpeningHeight',
      building_type: 'LowRise',
      azimuth_angle_of_long_axis_of_building: Math.round(axis.azimuth * 10) / 10,
      ratio_of_building_width_along_short_axis_to_width_along_long_axis: Math.round(axis.ratio * 1000) / 1000,
    },
  };
  ep.ScheduleTypeLimits = { ...ep.ScheduleTypeLimits, 'AFN Temperature': { lower_limit_value: -60, upper_limit_value: 200, numeric_type: 'Continuous', unit_type: 'Temperature' } };
  ep['Schedule:Constant'] = { ...ep['Schedule:Constant'], 'AFN Vent Setpoint': { schedule_type_limits_name: 'AFN Temperature', hourly_value: o.ventSetpoint } };
  ep['AirflowNetwork:MultiZone:ReferenceCrackConditions'] = {
    'AFN Reference Conditions': { reference_temperature: 20, reference_barometric_pressure: 101325, reference_humidity_ratio: 0 },
  };

  const zones = {};
  for (const z of Object.values(model.zones)) {
    const vent = z.ventilation;
    zones[`AFN Zone ${z.name}`] = vent
      ? {
        zone_name: z.name,
        ventilation_control_mode: 'Temperature',
        ventilation_control_zone_temperature_setpoint_schedule_name: 'AFN Vent Setpoint',
        minimum_venting_open_factor: 0,
        ...(vent.schedule ? { venting_availability_schedule_name: vent.schedule } : {}),
      }
      : { zone_name: z.name, ventilation_control_mode: 'NoVent' };
  }
  ep['AirflowNetwork:MultiZone:Zone'] = zones;

  const cracks = {}, openings = {}, surfaces = {};
  for (const s of Object.values(model.surfaces)) {
    const interzone = s.boundary === 'Surface';
    if (!(s.boundary === 'Outdoors' || (interzone && s.name < s.adjacentSurface))) continue; // one of each pair
    const crack = `AFN Crack ${s.name}`;
    cracks[crack] = {
      air_mass_flow_coefficient_at_reference_conditions: coefficient(o.surfaceLeakage50 * area(s.vertices), o.flowExponent),
      air_mass_flow_exponent: o.flowExponent,
      reference_crack_conditions: 'AFN Reference Conditions',
    };
    surfaces[`AFN Surface ${s.name}`] = { surface_name: s.name, leakage_component_name: crack, window_door_opening_factor_or_crack_factor: 1 };
  }
  for (const w of Object.values(model.windows)) {
    const parent = model.surfaces[w.parent];
    if (!parent || parent.boundary !== 'Outdoors') continue;
    const component = `AFN Window ${w.name}`;
    openings[component] = {
      air_mass_flow_coefficient_when_opening_is_closed: coefficient(o.windowLeakage50, o.flowExponent),
      air_mass_flow_exponent_when_opening_is_closed: o.flowExponent,
      minimum_density_difference_for_two_way_flow: 0.0001,
      discharge_coefficient: o.dischargeCoefficient,
    };
    const fraction = w.operableFraction?.value;
    surfaces[`AFN Surface ${w.name}`] = {
      surface_name: w.name,
      leakage_component_name: component,
      window_door_opening_factor_or_crack_factor: fraction ? Math.min(1, fraction) : 1,
      ventilation_control_mode: fraction ? 'ZoneLevel' : 'NoVent',
    };
  }
  if (o.doors) addDoors(model, ep, surfaces, openings, o);
  ep['AirflowNetwork:MultiZone:Surface:Crack'] = cracks;
  ep['AirflowNetwork:MultiZone:Component:SimpleOpening'] = openings;
  ep['AirflowNetwork:MultiZone:Surface'] = surfaces;

  // Hourly network results: flow through every linkage, window opening, node pressure, zone air changes.
  const outputs = { ...ep['Output:Variable'] };
  for (const variable of ['AFN Linkage Node 1 to Node 2 Mass Flow Rate', 'AFN Linkage Node 2 to Node 1 Mass Flow Rate',
    'AFN Surface Venting Window or Door Opening Factor', 'AFN Node Total Pressure',
    'AFN Zone Infiltration Air Change Rate', 'AFN Zone Ventilation Air Change Rate']) {
    outputs[variable] = { key_value: '*', variable_name: variable, reporting_frequency: 'Hourly' };
  }
  ep['Output:Variable'] = outputs;
  return ep;
}

// Writes the tool's interior doors as door subsurfaces (one in each zone, pointing at each other),
// with an always-open simple opening on one of each pair.
function addDoors(model, ep, surfaces, openings, o) {
  const doors = interiorDoors(model);
  if (!doors.length) return;
  const rules = Object.values(ep.GlobalGeometryRules || {})[0] || {};
  const relative = String(rules.coordinate_system || 'Relative').toLowerCase() === 'relative';
  const local = (pts, zone) => (relative ? fromBuilding(pts, ep.Zone[zone]) : pts);
  ep.Material = { ...ep.Material, 'AFN Door Wood': { roughness: 'MediumSmooth', thickness: 0.04, conductivity: 0.15, density: 600, specific_heat: 1600 } };
  ep.Construction = { ...ep.Construction, 'AFN Interior Door': { outside_layer: 'AFN Door Wood' } };
  const fen = { ...ep['FenestrationSurface:Detailed'] };
  const write = (name, parent, other, pts, zone) => {
    const f = { surface_type: 'Door', construction_name: 'AFN Interior Door', building_surface_name: parent, outside_boundary_condition_object: other, multiplier: 1, number_of_vertices: 4 };
    local(pts, zone).forEach(([x, y, z], i) => Object.assign(f, { [`vertex_${i + 1}_x_coordinate`]: x, [`vertex_${i + 1}_y_coordinate`]: y, [`vertex_${i + 1}_z_coordinate`]: z }));
    fen[name] = f;
  };
  openings['AFN Interior Door'] = {
    air_mass_flow_coefficient_when_opening_is_closed: coefficient(o.windowLeakage50, o.flowExponent),
    air_mass_flow_exponent_when_opening_is_closed: o.flowExponent,
    minimum_density_difference_for_two_way_flow: 0.0001,
    discharge_coefficient: o.dischargeCoefficient,
  };
  for (const d of doors) {
    write(d.name, d.surface, d.partnerName, d.vertices, d.zone);
    write(d.partnerName, d.partnerSurface, d.name, d.partnerVertices, d.partnerZone);
    surfaces[`AFN Surface ${d.name}`] = { surface_name: d.name, leakage_component_name: 'AFN Interior Door', window_door_opening_factor_or_crack_factor: 1, ventilation_control_mode: 'Constant' };
  }
  ep['FenestrationSurface:Detailed'] = fen;
}
