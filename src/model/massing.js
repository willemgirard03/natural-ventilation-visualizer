// A building modelled from scratch as storeys of rectangular floor plates, each storey one zone
// ("pancake" massing), written out as a complete EnergyPlus .epJSON in ClimateStudio's manner, so the
// tool reads it as it reads a ClimateStudio model and EnergyPlus runs it as it is.
//
// The storeys and their windows follow the shading tool's massing: a storey is a plate (width along x,
// depth along y, centred on its offset) of a height; each side (N, E, S, W) carries a window array, set
// out by number (the side divided into equal bays) or by spacing (bays of a pitch, centred on the side);
// any window of an array can be broken out and given its own size, sill and place in its bay.
//
// What is written, as ClimateStudio writes it (CLIMATESTUDIO.md):
//  - zones `<name>_<index>`; surfaces `<zone>:f<n>`; windows `<zone>:f<n>:w<k>`;
//  - facades gross, windows as their subsurfaces; corners counterclockwise seen from outside;
//  - a plate over another: the overlap a floor and ceiling pair (the floor with the _FLIPPED assembly),
//    the rest of the upper floor exposed (External Floor), the rest of the lower ceiling a roof;
//  - the ground floor on the ground; every assembly with its _FLIPPED twin;
//  - natural ventilation by ZoneVentilation:WindandStackOpenArea: a wind object per window (its operable
//    area, facing its azimuth) and a stack object per zone (all its operable area, a quarter of the
//    window height), opening above the zone's set point, outdoor air 10 to 27 °C, scheduled by
//    NatVentAvail_<zone>, worked out from the weather file (at most 90% humidity) when one is given;
//  - an ideal-loads system per zone with heating and cooling off (free running) and mechanical
//    ventilation on the occupancy schedule; people, lights and equipment by floor area.
// The default loads and schedules are those of an office (public ASHRAE 90.1 / DOE prototype values).

import { LAYER_FIELDS } from './constructions.js';

export const SIDES = ['S', 'E', 'N', 'W']; // in the order the faces are numbered
export const SIDE_AZIMUTH = { N: 0, E: 90, S: 180, W: 270 };
export const WINDOW_EDGE = 0.02; // m, kept between a window and its wall's edges or the next window

export const WINDOWS0 = () => ({ winBy: 'number', winN: 4, winSp: 4.5, winW: 2.0, winH: 1.6, sill: 0.9, fillW: false, fillH: false, broken: {} });
export const storey0 = (h = 3.5, w = 20, d = 10) => ({ name: null, h, w, d, ox: 0, oy: 0, slab: 0.3, sides: { N: WINDOWS0(), E: WINDOWS0(), S: WINDOWS0(), W: WINDOWS0() } });

export const MASSING_SETTINGS0 = () => ({
  peoplePerArea: 0.0565, activity: 125.28, lightsPerArea: 6.57, equipmentPerArea: 10.33,
  outdoorAirPerPerson: 0.0025, outdoorAirPerArea: 0.0003, infiltrationAch: 0.1,
  operableFraction: 0.8, ventSetpoint: 25, ventMinOutdoor: 10, ventMaxOutdoor: 27, ventMaxHumidity: 90,
});

export function massing0() {
  return { name: 'Floor', rot: 0, storeys: [storey0(), storey0()], settings: MASSING_SETTINGS0() };
}

// ---------- the window arrays (as the shading tool's cells) ----------

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// A window's glass in a bay of `pitch`: the bay, or its own width held to it.
export const glassWidth = (g, pitch) => (g.fillW ? pitch : Math.min(Math.max(0.05, g.winW), pitch));

// How the windows are set out along a side of length `len`: by number, they divide it evenly; by
// spacing, they stand at that pitch, centred on the side, each wholly on it. The count, the pitch and
// the centre of the first, from the middle of the side.
export function unitLayout(g, len) {
  if (g.winBy !== 'spacing') {
    const n = Math.max(1, Math.round(g.winN));
    return { n, pitch: len / n, first: -len / 2 + len / n / 2 };
  }
  const sp = Math.max(0.3, g.winSp), w = glassWidth(g, sp);
  const n = Math.max(0, Math.floor((len - w) / sp + 1e-9) + 1);
  return { n, pitch: sp, first: -((n - 1) * sp) / 2 };
}

// A window of the array: the array's own, or as it was broken out.
export const unitGlazing = (g, i) => (g.broken && g.broken[i] ? { ...g, ...g.broken[i] } : g);

// The windows of one side of a storey, in the side's own coordinates: u across from its middle (left
// to right seen from outside), v up from the storey's floor. Each stays inside its bay, under the slab
// and clear of the wall's edges and of its neighbours.
export function sideWindows(g, len, h, slab = 0.3) {
  if (!g || len <= 0) return [];
  const { n, pitch, first } = unitLayout(g, len), top = Math.max(0.1, h - clamp(slab, 0, h - 0.1)), out = [];
  for (let i = 0; i < n; i++) {
    const u = unitGlazing(g, i), c = first + i * pitch;
    // the room the window has: its bay, less half the gap to the next and the gap to a corner
    const lo = Math.max(c - pitch / 2 + WINDOW_EDGE / 2, -len / 2 + WINDOW_EDGE), hi = Math.min(c + pitch / 2 - WINDOW_EDGE / 2, len / 2 - WINDOW_EDGE);
    const w = Math.min(glassWidth(u, pitch), hi - lo), mid = clamp(c + (u.offU || 0), lo + w / 2, hi - w / 2);
    const sill = clamp(u.sill || 0, 0, Math.max(0, top - 0.05));
    const hh = u.fillH ? top - sill : Math.min(Math.max(0.05, u.winH), top - sill);
    const u0 = mid - w / 2, u1 = mid + w / 2;
    const v0 = Math.max(sill, WINDOW_EDGE), v1 = Math.min(sill + hh, h - WINDOW_EDGE);
    if (u1 - u0 > 0.05 && v1 - v0 > 0.05) out.push({ index: i, u0, u1, v0, v1 });
  }
  return out;
}

// ---------- geometry ----------

// The storeys' floor levels.
export function storeyBases(m) {
  const z = [0];
  for (const s of m.storeys) z.push(z[z.length - 1] + s.h);
  return z;
}
const plate = (s) => ({ x0: s.ox - s.w / 2, x1: s.ox + s.w / 2, y0: s.oy - s.d / 2, y1: s.oy + s.d / 2 });
const overlap = (a, b) => {
  const r = { x0: Math.max(a.x0, b.x0), x1: Math.min(a.x1, b.x1), y0: Math.max(a.y0, b.y0), y1: Math.min(a.y1, b.y1) };
  return r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6 ? r : null;
};
// A rectangle less another, as up to four rectangles (strips below and above, then left and right).
function minus(a, b) {
  const o = overlap(a, b);
  if (!o) return [a];
  const out = [
    { x0: a.x0, x1: a.x1, y0: a.y0, y1: o.y0 }, { x0: a.x0, x1: a.x1, y0: o.y1, y1: a.y1 },
    { x0: a.x0, x1: o.x0, y0: o.y0, y1: o.y1 }, { x0: o.x1, x1: a.x1, y0: o.y0, y1: o.y1 },
  ];
  return out.filter((r) => r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6);
}
// A rectangle at a height, its corners counterclockwise seen from above (up) or from below (down).
const flat = (r, z, up) => (up
  ? [[r.x0, r.y0, z], [r.x1, r.y0, z], [r.x1, r.y1, z], [r.x0, r.y1, z]]
  : [[r.x0, r.y0, z], [r.x0, r.y1, z], [r.x1, r.y1, z], [r.x1, r.y0, z]]);
// A side of a plate: from its left end to its right end seen from outside.
function sideLine(r, f) {
  return { S: [[r.x0, r.y0], [r.x1, r.y0]], E: [[r.x1, r.y0], [r.x1, r.y1]], N: [[r.x1, r.y1], [r.x0, r.y1]], W: [[r.x0, r.y1], [r.x0, r.y0]] }[f];
}

const zoneName = (m, s, i) => `${String(s.name || `${m.name || 'Floor'}${i + 1}`).replace(/[,;!]/g, ' ').trim()}_${i}`;

// Every zone's surfaces and windows, in building coordinates (the plan turned by `rot`, degrees
// clockwise), before they are written: the geometry the tests and the drawings read.
export function massingGeometry(m) {
  const z = storeyBases(m), a = ((m.rot || 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const turn = ([x, y, h]) => [x * c + y * sn, -x * sn + y * c, h];
  const zones = m.storeys.map((s, i) => ({ name: zoneName(m, s, i), storey: i, z0: z[i], z1: z[i + 1], plate: plate(s), surfaces: [], windows: [] }));
  const add = (zone, type, kind, pts, extra = {}) => {
    const name = `${zone.name}:f${zone.surfaces.length}`;
    zone.surfaces.push({ name, type, kind, vertices: pts.map(turn), ...extra });
    return name;
  };
  zones.forEach((zone, i) => {
    const s = m.storeys[i], below = zones[i - 1];
    // the floor: on the ground, or over the storey below where the plates overlap, exposed elsewhere
    if (!below) add(zone, 'Floor', 'ground', flat(zone.plate, zone.z0, false));
    else {
      const o = overlap(zone.plate, below.plate);
      if (o) zone.pairFloor = add(zone, 'Floor', 'slab', flat(o, zone.z0, false), { over: o });
      for (const r of minus(zone.plate, below.plate)) add(zone, 'Floor', 'exposed', flat(r, zone.z0, false));
    }
    // the walls, each with its windows
    for (const f of SIDES) {
      const [A, B] = sideLine(zone.plate, f), len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const wall = add(zone, 'Wall', 'facade', [[A[0], A[1], zone.z0], [B[0], B[1], zone.z0], [B[0], B[1], zone.z1], [A[0], A[1], zone.z1]], { side: f });
      const at = (u, v) => [mid[0] + U[0] * u, mid[1] + U[1] * u, zone.z0 + v];
      sideWindows(s.sides?.[f], len, s.h, s.slab).forEach((w, k) => zone.windows.push({
        name: `${wall}:w${k}`, wall, side: f, index: w.index, width: w.u1 - w.u0, height: w.v1 - w.v0,
        azimuth: (SIDE_AZIMUTH[f] + (m.rot || 0) + 360) % 360,
        vertices: [at(w.u0, w.v0), at(w.u1, w.v0), at(w.u1, w.v1), at(w.u0, w.v1)].map(turn),
      }));
    }
  });
  // the ceilings: under the storey above where they overlap (paired with its floor), a roof elsewhere
  zones.forEach((zone, i) => {
    const above = zones[i + 1];
    if (above?.pairFloor) {
      const o = overlap(zone.plate, above.plate);
      const name = add(zone, 'Ceiling', 'slab', flat(o, zone.z1, true), { partner: above.pairFloor });
      above.surfaces.find((x) => x.name === above.pairFloor).partner = name;
    }
    for (const r of above ? minus(zone.plate, above.plate) : [zone.plate]) add(zone, 'Roof', 'roof', flat(r, zone.z1, true));
  });
  return zones;
}

// ---------- materials, assemblies and schedules ----------

// Assemblies listed outside (or top) first, as ClimateStudio draws them; a floor over a zone takes the
// slab's _FLIPPED twin, its ceiling the slab itself. Generic materials (conductivity W/m·K, density
// kg/m³, specific heat J/kg·K).
const MATERIALS = {
  'Brick 100mm': [0.1, 0.89, 1920, 790], 'Mineral wool 120mm': [0.12, 0.035, 30, 840], 'Concrete 200mm': [0.2, 1.95, 2240, 900],
  'Gypsum board 13mm': [0.013, 0.16, 800, 1090], 'Roof membrane 10mm': [0.01, 0.16, 1120, 1460], 'Insulation board 200mm': [0.2, 0.035, 30, 1400],
  'Screed 60mm': [0.06, 1.4, 2100, 840], 'Concrete 250mm': [0.25, 1.95, 2240, 900], 'XPS 100mm': [0.1, 0.034, 35, 1400], 'Insulation board 150mm': [0.15, 0.035, 30, 1400],
};
export const MASSING_ASSEMBLIES = {
  facade: ['Massing Exterior Wall', ['Brick 100mm', 'Mineral wool 120mm', 'Concrete 200mm', 'Gypsum board 13mm']],
  roof: ['Massing Roof', ['Roof membrane 10mm', 'Insulation board 200mm', 'Concrete 200mm']],
  slab: ['Massing Interior Slab', ['Screed 60mm', 'Concrete 250mm']],
  ground: ['Massing Ground Slab', ['XPS 100mm', 'Concrete 250mm', 'Screed 60mm']],
  exposed: ['Massing Exposed Floor', ['Insulation board 150mm', 'Concrete 250mm', 'Screed 60mm']],
};
export const MASSING_GLAZING = ['Massing Double Glazing', { u_factor: 1.4, solar_heat_gain_coefficient: 0.4, visible_transmittance: 0.6 }];

// Office day profiles, hour by hour (public DOE prototype office shape).
const rep = (...runs) => runs.flatMap(([v, n]) => Array(n).fill(v));
const PROFILES = {
  'Office Occupancy': {
    weekday: rep([0, 6], [0.1, 1], [0.2, 1], [0.95, 4], [0.5, 1], [0.95, 4], [0.3, 1], [0.1, 4], [0.05, 2]),
    saturday: rep([0, 6], [0.1, 2], [0.3, 4], [0.1, 5], [0.05, 2], [0, 5]), sunday: rep([0, 24]),
  },
  'Office Lighting': {
    weekday: rep([0.05, 5], [0.1, 2], [0.3, 1], [0.9, 4], [0.8, 1], [0.9, 4], [0.5, 1], [0.3, 2], [0.2, 2], [0.1, 1], [0.05, 1]),
    saturday: rep([0.05, 6], [0.1, 2], [0.3, 4], [0.15, 5], [0.05, 7]), sunday: rep([0.05, 24]),
  },
  'Office Equipment': {
    weekday: rep([0.4, 7], [0.6, 1], [0.9, 4], [0.8, 1], [0.9, 4], [0.6, 1], [0.4, 6]),
    saturday: rep([0.3, 8], [0.5, 4], [0.35, 5], [0.3, 7]), sunday: rep([0.3, 24]),
  },
};
const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const hourly = (values) => Object.fromEntries(values.map((v, h) => [`hour_${h + 1}`, v]).concat([['schedule_type_limits_name', 'Fraction']]));
const dateOfDay = (d) => { let m = 0; while (d >= DAYS_IN_MONTH[m]) d -= DAYS_IN_MONTH[m++]; return [m + 1, d + 1]; };

// A schedule of the same days every week: Schedule:Year over one Schedule:Week:Daily.
function weeklySchedule(ep, name, { weekday, saturday, sunday }) {
  for (const [k, v] of Object.entries({ weekday, saturday, sunday })) ep['Schedule:Day:Hourly'][`${name} ${k}`] = hourly(v);
  const day = (k) => `${name} ${k}`;
  ep['Schedule:Week:Daily'][`${name} week`] = {
    sunday_schedule_day_name: day('sunday'), monday_schedule_day_name: day('weekday'), tuesday_schedule_day_name: day('weekday'),
    wednesday_schedule_day_name: day('weekday'), thursday_schedule_day_name: day('weekday'), friday_schedule_day_name: day('weekday'),
    saturday_schedule_day_name: day('saturday'), holiday_schedule_day_name: day('sunday'), summerdesignday_schedule_day_name: day('weekday'),
    winterdesignday_schedule_day_name: day('weekday'), customday1_schedule_day_name: day('weekday'), customday2_schedule_day_name: day('weekday'),
  };
  ep['Schedule:Year'][name] = { schedule_type_limits_name: 'Fraction', schedule_weeks: [{ schedule_week_name: `${name} week`, start_month: 1, start_day: 1, end_month: 12, end_day: 31 }] };
}

// A schedule of 8,760 hourly values (the year starting on a Sunday, as the run period says): a week
// schedule for every seven days, its days shared where they are the same.
function yearSchedule(ep, name, values) {
  const days = new Map(), weeks = [];
  const dayName = (d) => {
    const v = values.slice(d * 24, d * 24 + 24), key = v.join(',');
    if (!days.has(key)) { const n = `${name} day ${days.size}`; days.set(key, n); ep['Schedule:Day:Hourly'][n] = hourly(v); }
    return days.get(key);
  };
  for (let w = 0; w * 7 < 365; w++) {
    const d0 = w * 7, d1 = Math.min(364, d0 + 6), names = WEEK_DAYS.map((_, k) => dayName(Math.min(d0 + k, d1)));
    const week = `${name}_${w}`, o = Object.fromEntries(WEEK_DAYS.map((k, i) => [`${k}_schedule_day_name`, names[i]]));
    for (const k of ['holiday', 'summerdesignday', 'winterdesignday', 'customday1', 'customday2']) o[`${k}_schedule_day_name`] = names[1];
    ep['Schedule:Week:Daily'][week] = o;
    const [sm, sd] = dateOfDay(d0), [em, ed] = dateOfDay(d1);
    weeks.push({ schedule_week_name: week, start_month: sm, start_day: sd, end_month: em, end_day: ed });
  }
  ep['Schedule:Year'][name] = { schedule_type_limits_name: 'Fraction', schedule_weeks: weeks };
}

// ---------- the .epJSON ----------

const vertexList = (pts) => pts.map(([x, y, z]) => ({ vertex_x_coordinate: +x.toFixed(6), vertex_y_coordinate: +y.toFixed(6), vertex_z_coordinate: +z.toFixed(6) }));
const polygonArea = (pts) => {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    x += a[1] * b[2] - a[2] * b[1]; y += a[2] * b[0] - a[0] * b[2]; z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
};

// The model as EnergyPlus .epJSON. `weather` (parseEPW) makes the natural-ventilation schedules from
// its hours, as ClimateStudio does; without it they are always on (the outdoor limits still apply).
export function massingEpJSON(m, { weather = null, runPeriod = null } = {}) {
  const set = { ...MASSING_SETTINGS0(), ...(m.settings || {}) }, zones = massingGeometry(m);
  const ep = {
    Version: { 'Version 1': { version_identifier: '23.1' } },
    Building: { Building: { north_axis: 0, terrain: 'Suburbs', loads_convergence_tolerance_value: 0.04, temperature_convergence_tolerance_value: 0.25, solar_distribution: 'FullExterior', maximum_number_of_warmup_days: 25, minimum_number_of_warmup_days: 6 } },
    GlobalGeometryRules: { 'GlobalGeometryRules 1': { starting_vertex_position: 'LowerLeftCorner', vertex_entry_direction: 'Counterclockwise', coordinate_system: 'Relative' } },
    SimulationControl: { 'SimulationControl 1': { do_zone_sizing_calculation: 'No', do_system_sizing_calculation: 'No', do_plant_sizing_calculation: 'No', run_simulation_for_sizing_periods: 'No', run_simulation_for_weather_file_run_periods: 'Yes' } },
    Timestep: { 'Timestep 1': { number_of_timesteps_per_hour: 6 } },
    HeatBalanceAlgorithm: { 'HeatBalanceAlgorithm 1': { algorithm: 'ConductionTransferFunction' } },
    SurfaceConvectionAlgorithm: undefined,
    'SurfaceConvectionAlgorithm:Inside': { 'SurfaceConvectionAlgorithm:Inside 1': { algorithm: 'TARP' } },
    'SurfaceConvectionAlgorithm:Outside': { 'SurfaceConvectionAlgorithm:Outside 1': { algorithm: 'DOE-2' } },
    ShadowCalculation: { 'ShadowCalculation 1': { shading_calculation_method: 'PolygonClipping', shading_calculation_update_frequency_method: 'Periodic', shading_calculation_update_frequency: 20 } },
    RunPeriod: { 'Run Period 1': { begin_month: 1, begin_day_of_month: 1, end_month: 12, end_day_of_month: 31, day_of_week_for_start_day: 'Sunday', use_weather_file_holidays_and_special_days: 'No', use_weather_file_daylight_saving_period: 'No', apply_weekend_holiday_rule: 'No', use_weather_file_rain_indicators: 'Yes', use_weather_file_snow_indicators: 'Yes', ...(runPeriod || {}) } },
    'Site:GroundTemperature:BuildingSurface': { 'Site:GroundTemperature:BuildingSurface 1': Object.fromEntries(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].map((k) => [`${k}_ground_temperature`, 18])) },
    ZoneAirContaminantBalance: { 'ZoneAirContaminantBalance 1': { carbon_dioxide_concentration: 'Yes', outdoor_carbon_dioxide_schedule_name: 'Outdoor CO2' } },
    ScheduleTypeLimits: {
      Fraction: { lower_limit_value: 0, upper_limit_value: 1, numeric_type: 'Continuous' }, 'Any Number': {},
      Temperature: { lower_limit_value: -60, upper_limit_value: 200, numeric_type: 'Continuous' }, 'Control Type': { lower_limit_value: 0, upper_limit_value: 4, numeric_type: 'Discrete' },
    },
    'Schedule:Constant': {
      On: { schedule_type_limits_name: 'Fraction', hourly_value: 1 }, Off: { schedule_type_limits_name: 'Fraction', hourly_value: 0 },
      'Outdoor CO2': { schedule_type_limits_name: 'Any Number', hourly_value: 400 }, Activity: { schedule_type_limits_name: 'Any Number', hourly_value: set.activity },
      'Work Efficiency': { schedule_type_limits_name: 'Any Number', hourly_value: 0 }, 'Air Speed': { schedule_type_limits_name: 'Any Number', hourly_value: 0.1 },
      'Heating Setpoint': { schedule_type_limits_name: 'Temperature', hourly_value: 20 }, 'Cooling Setpoint': { schedule_type_limits_name: 'Temperature', hourly_value: 26 },
      'Dual Setpoint Control': { schedule_type_limits_name: 'Control Type', hourly_value: 4 },
    },
    'Schedule:Day:Hourly': {}, 'Schedule:Week:Daily': {}, 'Schedule:Year': {},
    Material: {}, 'WindowMaterial:SimpleGlazingSystem': {}, Construction: {},
    Zone: {}, 'BuildingSurface:Detailed': {}, 'FenestrationSurface:Detailed': {},
    People: {}, Lights: {}, ElectricEquipment: {}, 'ZoneInfiltration:DesignFlowRate': {}, 'ZoneVentilation:WindandStackOpenArea': {},
    'DesignSpecification:OutdoorAir': {}, 'ThermostatSetpoint:DualSetpoint': { 'Dual Setpoint': { heating_setpoint_temperature_schedule_name: 'Heating Setpoint', cooling_setpoint_temperature_schedule_name: 'Cooling Setpoint' } },
    'ZoneControl:Thermostat': {}, 'ZoneHVAC:IdealLoadsAirSystem': {}, 'ZoneHVAC:EquipmentList': {}, 'ZoneHVAC:EquipmentConnections': {}, NodeList: {},
    'Output:Diagnostics': { 'Output:Diagnostics 1': { diagnostics: [{ key: 'DisplayAdvancedReportVariables' }] } },
    'Output:Variable': {}, 'Output:VariableDictionary': { 'Output:VariableDictionary 1': { key_field: 'IDF' } },
  };
  delete ep.SurfaceConvectionAlgorithm;
  for (const [n, p] of Object.entries(PROFILES)) weeklySchedule(ep, n, p);

  // materials and assemblies, each with its _FLIPPED twin
  for (const [n, [t, k, rho, c]] of Object.entries(MATERIALS)) {
    ep.Material[n] = { roughness: 'MediumRough', thickness: t, conductivity: k, density: rho, specific_heat: c, thermal_absorptance: 0.9, solar_absorptance: 0.7, visible_absorptance: 0.7 };
  }
  const construction = (name, layers) => {
    ep.Construction[name] = Object.fromEntries(layers.map((l, i) => [LAYER_FIELDS[i], l]));
    ep.Construction[`${name}_FLIPPED`] = Object.fromEntries([...layers].reverse().map((l, i) => [LAYER_FIELDS[i], l]));
  };
  for (const [name, layers] of Object.values(MASSING_ASSEMBLIES)) construction(name, layers);
  ep['WindowMaterial:SimpleGlazingSystem'][MASSING_GLAZING[0]] = { ...MASSING_GLAZING[1] };
  construction(MASSING_GLAZING[0], [MASSING_GLAZING[0]]);

  const asm = (kind) => MASSING_ASSEMBLIES[kind][0];
  for (const zone of zones) {
    const Z = zone.name, r = zone.plate, floorArea = (r.x1 - r.x0) * (r.y1 - r.y0);
    ep.Zone[Z] = { direction_of_relative_north: 0, x_origin: 0, y_origin: 0, z_origin: 0, type: 1, multiplier: 1, floor_area: floorArea, volume: floorArea * (zone.z1 - zone.z0), zone_inside_convection_algorithm: 'TARP', zone_outside_convection_algorithm: 'DOE-2' };
    for (const s of zone.surfaces) {
      const o = { surface_type: s.type, zone_name: Z, number_of_vertices: s.vertices.length, vertices: vertexList(s.vertices) };
      if (s.kind === 'ground') Object.assign(o, { construction_name: asm('ground'), outside_boundary_condition: 'Ground', sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else if (s.kind === 'slab') Object.assign(o, { construction_name: s.type === 'Floor' ? `${asm('slab')}_FLIPPED` : asm('slab'), outside_boundary_condition: 'Surface', outside_boundary_condition_object: s.partner, sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else Object.assign(o, { construction_name: asm(s.kind), outside_boundary_condition: 'Outdoors', sun_exposure: 'SunExposed', wind_exposure: 'WindExposed', view_factor_to_ground: 'Autocalculate' });
      ep['BuildingSurface:Detailed'][s.name] = o;
    }
    let operable = 0, heights = 0;
    zone.windows.forEach((w, k) => {
      const o = { surface_type: 'Window', construction_name: MASSING_GLAZING[0], building_surface_name: w.wall, view_factor_to_ground: 'Autocalculate', multiplier: 1, number_of_vertices: 4 };
      w.vertices.forEach(([x, y, z], j) => Object.assign(o, { [`vertex_${j + 1}_x_coordinate`]: +x.toFixed(6), [`vertex_${j + 1}_y_coordinate`]: +y.toFixed(6), [`vertex_${j + 1}_z_coordinate`]: +z.toFixed(6) }));
      ep['FenestrationSurface:Detailed'][w.name] = o;
      const a = polygonArea(w.vertices) * set.operableFraction;
      operable += a; heights += a * w.height;
      ep['ZoneVentilation:WindandStackOpenArea'][`${Z}NatVent_Wind${k}`] = ventilation(Z, set, { opening_area: a, effective_angle: Math.round(w.azimuth), height_difference: 0, discharge_coefficient_for_opening: 0, opening_effectiveness: 'Autocalculate' });
    });
    if (operable > 0) ep['ZoneVentilation:WindandStackOpenArea'][`${Z}NatVent_Buoy`] = ventilation(Z, set, { opening_area: operable, effective_angle: 0, height_difference: heights / operable / 4, discharge_coefficient_for_opening: 0.6, opening_effectiveness: 0 });

    ep.People[`People ${Z}`] = { zone_or_zonelist_or_space_or_spacelist_name: Z, number_of_people_schedule_name: 'Office Occupancy', number_of_people_calculation_method: 'People/Area', people_per_floor_area: set.peoplePerArea, fraction_radiant: 0.3, sensible_heat_fraction: 'Autocalculate', activity_level_schedule_name: 'Activity', carbon_dioxide_generation_rate: 3.82e-8, work_efficiency_schedule_name: 'Work Efficiency', clothing_insulation_calculation_method: 'DynamicClothingModelASHRAE55', air_velocity_schedule_name: 'Air Speed', mean_radiant_temperature_calculation_type: 'ZoneAveraged', thermal_comfort_model_1_type: 'AdaptiveASH55', thermal_comfort_model_2_type: 'Fanger' };
    ep.Lights[`${Z} General lighting`] = { zone_or_zonelist_or_space_or_spacelist_name: Z, schedule_name: 'Office Lighting', design_level_calculation_method: 'Watts/Area', watts_per_zone_floor_area: set.lightsPerArea, return_air_fraction: 0, fraction_radiant: 0.42, fraction_visible: 0.18, fraction_replaceable: 1 };
    ep.ElectricEquipment[`${Z} Equipment`] = { zone_or_zonelist_or_space_or_spacelist_name: Z, schedule_name: 'Office Equipment', design_level_calculation_method: 'Watts/Area', watts_per_zone_floor_area: set.equipmentPerArea, fraction_latent: 0, fraction_radiant: 0.2, fraction_lost: 0 };
    ep['ZoneInfiltration:DesignFlowRate'][`${Z}Infiltration`] = { zone_or_zonelist_or_space_or_spacelist_name: Z, schedule_name: 'On', design_flow_rate_calculation_method: 'AirChanges/Hour', air_changes_per_hour: set.infiltrationAch, constant_term_coefficient: 1, temperature_term_coefficient: 0, velocity_term_coefficient: 0, velocity_squared_term_coefficient: 0 };

    // free running: an ideal-loads system with heating and cooling off, bringing the outdoor air
    ep['DesignSpecification:OutdoorAir'][`${Z}MinFreshAir`] = { outdoor_air_method: 'Sum', outdoor_air_flow_per_person: set.outdoorAirPerPerson, outdoor_air_flow_per_zone_floor_area: set.outdoorAirPerArea, outdoor_air_schedule_name: 'On' };
    ep['ZoneControl:Thermostat'][`${Z} Thermostat`] = { zone_or_zonelist_name: Z, control_type_schedule_name: 'Dual Setpoint Control', control_1_object_type: 'ThermostatSetpoint:DualSetpoint', control_1_name: 'Dual Setpoint' };
    ep['ZoneHVAC:IdealLoadsAirSystem'][`${Z} Ideal Loads Air`] = { zone_supply_air_node_name: `Node ${Z} In`, maximum_heating_supply_air_temperature: 35, minimum_cooling_supply_air_temperature: 12, maximum_heating_supply_air_humidity_ratio: 0.01, minimum_cooling_supply_air_humidity_ratio: 0.008, heating_limit: 'NoLimit', cooling_limit: 'NoLimit', heating_availability_schedule_name: 'Off', cooling_availability_schedule_name: 'Off', dehumidification_control_type: 'None', humidification_control_type: 'None', design_specification_outdoor_air_object_name: `${Z}MinFreshAir`, outdoor_air_inlet_node_name: `${Z}OutdoorInlet`, demand_controlled_ventilation_type: 'OccupancySchedule', outdoor_air_economizer_type: 'NoEconomizer', heat_recovery_type: 'None' };
    ep['ZoneHVAC:EquipmentList'][`${Z} Equipment`] = { load_distribution_scheme: 'SequentialLoad', equipment: [{ zone_equipment_object_type: 'ZoneHVAC:IdealLoadsAirSystem', zone_equipment_name: `${Z} Ideal Loads Air`, zone_equipment_cooling_sequence: 1, zone_equipment_heating_or_no_load_sequence: 1 }] };
    ep.NodeList[`${Z} Inlets`] = { nodes: [{ node_name: `Node ${Z} In` }] };
    ep['ZoneHVAC:EquipmentConnections'][`${Z} Connections`] = { zone_name: Z, zone_conditioning_equipment_list_name: `${Z} Equipment`, zone_air_inlet_node_or_nodelist_name: `${Z} Inlets`, zone_air_node_name: `Node ${Z} Zone`, zone_return_air_node_or_nodelist_name: `Node ${Z} Out` };
  }

  // when the windows may open: the hours whose outdoor air is within the limits (ClimateStudio's
  // NatVentAvail), one schedule for every zone here since they share their settings
  if (weather) {
    const v = weather.hours.map((h) => (h.t >= set.ventMinOutdoor && h.t <= set.ventMaxOutdoor && h.relativeHumidity <= set.ventMaxHumidity ? 1 : 0));
    yearSchedule(ep, 'NatVentAvail', v);
  } else ep['Schedule:Constant'].NatVentAvail = { schedule_type_limits_name: 'Fraction', hourly_value: 1 };

  const outputs = ['Zone Mean Air Temperature', 'Zone Operative Temperature', 'Zone Mean Radiant Temperature', 'Zone Air Relative Humidity', 'Zone Air CO2 Concentration',
    'Zone People Total Heating Energy', 'Zone Lights Electricity Energy', 'Electric Equipment Electricity Energy', 'Zone Windows Total Transmitted Solar Radiation Energy',
    'Zone Windows Total Heat Gain Energy', 'Zone Windows Total Heat Loss Energy', 'Zone Opaque Surface Inside Faces Total Conduction Heat Gain Energy', 'Zone Opaque Surface Inside Faces Total Conduction Heat Loss Energy',
    'Zone Infiltration Total Heat Loss Energy', 'Zone Infiltration Total Heat Gain Energy', 'Zone Ventilation Total Heat Loss Energy', 'Zone Ventilation Total Heat Gain Energy',
    'Zone Ventilation Air Change Rate', 'Zone Ideal Loads Outdoor Air Total Heating Energy', 'Zone Ideal Loads Outdoor Air Total Cooling Energy'];
  outputs.forEach((v, i) => { ep['Output:Variable'][`Output:Variable ${i + 1}`] = { key_value: '*', variable_name: v, reporting_frequency: 'Hourly' }; });
  return ep;
}

function ventilation(zone, set, o) {
  return {
    zone_or_space_name: zone, opening_area_fraction_schedule_name: 'NatVentAvail', minimum_indoor_temperature: set.ventSetpoint, maximum_indoor_temperature: 100,
    delta_temperature: 1, minimum_outdoor_temperature: set.ventMinOutdoor, maximum_outdoor_temperature: set.ventMaxOutdoor, maximum_wind_speed: 40, ...o,
  };
}
