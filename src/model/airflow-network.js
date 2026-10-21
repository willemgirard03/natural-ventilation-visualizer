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
  // A closed interior door leaks like a gap of about 1 cm under it: about 180 m3/h at 50 Pa for a
  // 0.9 x 2.1 m door, 30 m3/h per m of its edge.
  doorLeakage50: 30,
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


// The network's elements, shared by the EnergyPlus export and the tool's own solver so both use the
// same inputs. Each link joins the zone of its surface ("from") to the adjacent zone or, when "to"
// is null, to outdoors; flow from "from" to "to" is positive, as in EnergyPlus.
//   crack:   coefficient (kg/s at 1 Pa, reference conditions) and exponent
//   opening: a window or door; open over openFactor of its width, or a crack along its edges when closed.
//            control: 'zone' (follows the zone's venting control), 'open' (always) or 'closed' (never).
// options.states: { [opening name]: true (open) | false (closed) } overrides an opening's control.
// options.openFactors: { [window name]: fraction } overrides how far a window opens (its sash's limit).
export function networkElements(model, options = {}) {
  const o = { ...NETWORK_DEFAULTS, ...options };
  const links = [];
  for (const s of Object.values(model.surfaces)) {
    const interzone = s.boundary === 'Surface';
    if (!(s.boundary === 'Outdoors' || (interzone && s.name < s.adjacentSurface))) continue; // one of each pair
    links.push({
      name: s.name, type: 'crack', from: s.zone, to: interzone ? s.adjacentZone : null, vertices: s.vertices,
      coefficient: coefficient(o.surfaceLeakage50 * area(s.vertices), o.flowExponent), exponent: o.flowExponent,
    });
  }
  const opening = (link) => ({
    type: 'opening', closedCoefficient: coefficient(o.windowLeakage50, o.flowExponent), exponent: o.flowExponent,
    dischargeCoefficient: o.dischargeCoefficient, ...link,
  });
  for (const w of Object.values(model.windows)) {
    const parent = model.surfaces[w.parent];
    if (!parent || parent.boundary !== 'Outdoors') continue;
    const fraction = w.operableFraction?.value;
    links.push(opening({ name: w.name, from: w.zone, to: null, vertices: w.vertices, openFactor: fraction ? Math.min(1, fraction) : 1, control: fraction ? 'zone' : 'closed' }));
  }
  const doors = o.doors ? interiorDoors(model) : [];
  for (const d of doors) {
    links.push(opening({ name: d.name, from: d.zone, to: d.partnerZone, vertices: d.vertices, openFactor: 1, control: 'open', door: d, closedCoefficient: coefficient(o.doorLeakage50, o.flowExponent) }));
  }
  if (o.states) for (const l of links) if (l.type === 'opening' && l.name in o.states) l.control = o.states[l.name] ? 'open' : 'closed';
  if (o.openFactors) for (const l of links) if (l.type === 'opening' && l.name in o.openFactors) l.openFactor = o.openFactors[l.name];
  return { zones: Object.keys(model.zones), links, doors, options: o };
}

// Extra outputs for checking the tool's solver: the inputs it needs and the network's results.
const CHECK_OUTPUTS = [
  'Site Outdoor Air Drybulb Temperature', 'Site Outdoor Air Humidity Ratio', 'Site Outdoor Air Barometric Pressure',
  'Site Wind Speed', 'Site Wind Direction', 'Zone Mean Air Temperature', 'Zone Air Humidity Ratio',
  'AFN Linkage Node 1 to Node 2 Pressure Difference', 'AFN Node Temperature', 'AFN Node Humidity Ratio',
];
const NETWORK_OUTPUTS = [
  'AFN Linkage Node 1 to Node 2 Mass Flow Rate', 'AFN Linkage Node 2 to Node 1 Mass Flow Rate',
  'AFN Surface Venting Window or Door Opening Factor', 'AFN Node Total Pressure',
  'AFN Zone Infiltration Air Change Rate', 'AFN Zone Ventilation Air Change Rate',
];

// options beyond NETWORK_DEFAULTS:
//   reporting: 'Hourly' (default) or 'Timestep' for the network outputs
//   runPeriod: [beginMonth, beginDay, endMonth, endDay] to shorten the run
//   checkOutputs: true adds the solver's inputs (weather, zone temperatures) at the same frequency
//   skipSizing: true skips EnergyPlus's sizing runs when the ideal-loads equipment is switched off
//               (ClimateStudio's free-running models): a week then runs in 18 s instead of 29 s
export function toAirflowNetwork(model, options = {}) {
  const { links, doors, options: o } = networkElements(model, options);
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
  for (const l of links) {
    if (l.type === 'crack') {
      cracks[`AFN Crack ${l.name}`] = { air_mass_flow_coefficient_at_reference_conditions: l.coefficient, air_mass_flow_exponent: l.exponent, reference_crack_conditions: 'AFN Reference Conditions' };
      surfaces[`AFN Surface ${l.name}`] = { surface_name: l.name, leakage_component_name: `AFN Crack ${l.name}`, window_door_opening_factor_or_crack_factor: 1 };
      continue;
    }
    const component = l.door ? 'AFN Interior Door' : `AFN Window ${l.name}`;
    openings[component] = {
      air_mass_flow_coefficient_when_opening_is_closed: l.closedCoefficient,
      air_mass_flow_exponent_when_opening_is_closed: l.exponent,
      minimum_density_difference_for_two_way_flow: 0.0001,
      discharge_coefficient: l.dischargeCoefficient,
    };
    surfaces[`AFN Surface ${l.name}`] = {
      surface_name: l.name, leakage_component_name: component, window_door_opening_factor_or_crack_factor: l.openFactor,
      ventilation_control_mode: { zone: 'ZoneLevel', open: 'Constant', closed: 'NoVent' }[l.control],
    };
  }
  if (doors.length) writeDoors(ep, doors);
  ep['AirflowNetwork:MultiZone:Surface:Crack'] = cracks;
  ep['AirflowNetwork:MultiZone:Component:SimpleOpening'] = openings;
  ep['AirflowNetwork:MultiZone:Surface'] = surfaces;

  const frequency = o.reporting || 'Hourly';
  const outputs = { ...ep['Output:Variable'] };
  for (const v of [...NETWORK_OUTPUTS, ...(o.checkOutputs ? CHECK_OUTPUTS : [])]) {
    outputs[`AFN check ${v}`] = { key_value: '*', variable_name: v, reporting_frequency: frequency };
  }
  ep['Output:Variable'] = outputs;
  if (o.skipSizing) skipSizing(ep);
  if (o.runPeriod) {
    const [bm, bd, em, ed] = o.runPeriod;
    const [name, rp] = Object.entries(ep.RunPeriod || { 'Run Period 1': {} })[0];
    ep.RunPeriod = { [name]: { ...rp, begin_month: bm, begin_day_of_month: bd, end_month: em, end_day_of_month: ed } };
  }
  return ep;
}

// Sizing only sets the size of heating and cooling equipment. When every ideal-loads system has both
// switched off (an availability schedule that is constantly 0, or ClimateStudio's "Off"), its sizes
// are made unlimited and the sizing runs are skipped; the results are identical (checked to 0.0001 degC).
function skipSizing(ep) {
  const constant = (name) => {
    const c = Object.entries(ep['Schedule:Constant'] || {}).find(([k]) => k.toLowerCase() === String(name).toLowerCase());
    return c ? c[1].hourly_value : null;
  };
  const off = (name) => constant(name) === 0 || String(name).toLowerCase() === 'off';
  const systems = Object.values(ep['ZoneHVAC:IdealLoadsAirSystem'] || {});
  if (!systems.every((s) => off(s.heating_availability_schedule_name) && off(s.cooling_availability_schedule_name))) return;
  for (const s of systems) {
    for (const k of Object.keys(s)) if (String(s[k]).toLowerCase() === 'autosize') delete s[k];
    s.heating_limit = 'NoLimit';
    s.cooling_limit = 'NoLimit';
  }
  for (const c of Object.values(ep.SimulationControl || {})) {
    Object.assign(c, { do_zone_sizing_calculation: 'No', do_system_sizing_calculation: 'No', do_plant_sizing_calculation: 'No' });
  }
}

// Writes the tool's interior doors as door subsurfaces, one in each zone, pointing at each other.
// Corners follow the model's GlobalGeometryRules: EnergyPlus reads a rectangle's width and height
// from the corner order, so a door listed from the wrong corner would be read lying on its side.
function writeDoors(ep, doors) {
  const rules = Object.values(ep.GlobalGeometryRules || {})[0] || {};
  const relative = String(rules.coordinate_system || 'Relative').toLowerCase() === 'relative';
  const first = { upperleftcorner: 0, lowerleftcorner: 1, lowerrightcorner: 2, upperrightcorner: 3 }[String(rules.starting_vertex_position || 'UpperLeftCorner').toLowerCase()] ?? 0;
  const clockwise = String(rules.vertex_entry_direction || 'Counterclockwise').toLowerCase() === 'clockwise';
  // Door corners come upper left, lower left, lower right, upper right (counterclockwise from outside).
  const ordered = (pts) => {
    const r = [...pts.slice(first), ...pts.slice(0, first)];
    return clockwise ? [r[0], ...r.slice(1).reverse()] : r;
  };
  const local = (pts, zone) => ordered(relative ? fromBuilding(pts, ep.Zone[zone]) : pts);
  ep.Material = { ...ep.Material, 'AFN Door Wood': { roughness: 'MediumSmooth', thickness: 0.04, conductivity: 0.15, density: 600, specific_heat: 1600 } };
  ep.Construction = { ...ep.Construction, 'AFN Interior Door': { outside_layer: 'AFN Door Wood' } };
  const fen = { ...ep['FenestrationSurface:Detailed'] };
  const write = (name, parent, other, pts, zone) => {
    const f = { surface_type: 'Door', construction_name: 'AFN Interior Door', building_surface_name: parent, outside_boundary_condition_object: other, multiplier: 1, number_of_vertices: 4 };
    local(pts, zone).forEach(([x, y, z], i) => Object.assign(f, { [`vertex_${i + 1}_x_coordinate`]: x, [`vertex_${i + 1}_y_coordinate`]: y, [`vertex_${i + 1}_z_coordinate`]: z }));
    fen[name] = f;
  };
  for (const d of doors) {
    write(d.name, d.surface, d.partnerName, d.vertices, d.zone);
    write(d.partnerName, d.partnerSurface, d.name, d.partnerVertices, d.partnerZone);
  }
  ep['FenestrationSurface:Detailed'] = fen;
}
