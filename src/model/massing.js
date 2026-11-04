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
import { glassWidth as unitWidth, glassHeights, setSize, setFigure, PRESETS, UNIT_KEYS } from './windows.js';

export const SIDES = ['S', 'E', 'N', 'W']; // in the order the faces are numbered
export const SIDE_AZIMUTH = { N: 0, E: 90, S: 180, W: 270 };
export const WINDOW_EDGE = 0.02; // m, kept between a window and its wall's edges or the next window

export const WINDOWS0 = () => ({ winBy: 'number', winN: 4, winSp: 4.5, winW: 2.0, winH: 1.6, sill: 0.9, size: 'fixed', broken: {} });
export const storey0 = (h = 3.5, w = 20, d = 10) => ({ name: null, h, w, d, ox: 0, oy: 0, rot: 0, slab: 0.3, sides: { N: WINDOWS0(), E: WINDOWS0(), S: WINDOWS0(), W: WINDOWS0() } });

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
// A window's glass in a bay of `pitch`, by its Size (windows.js): its own width (Fixed), the bay less
// its jambs (Offsets) or a share of the bay (Proportional). An array saved before Size had Fill width
// and Fill height, read as Offsets of 0.
const legacy = (g) => (!g.size && (g.fillW || g.fillH) ? { ...g, size: 'offset', jamb: g.fillW ? 0 : undefined, headGap: g.fillH ? 0 : undefined } : g);
export const glassWidth = (g, pitch) => {
  const u = legacy(g);
  return u.size === 'offset' && u.jamb === undefined ? Math.min(Math.max(0.05, u.winW), pitch) : unitWidth(u, pitch);
};
// A window's sill and head on a wall `top` high (floor to the underside of the floor above).
export function windowHeights(g, top) {
  const u = legacy(g);
  if (u.size === 'offset' && u.headGap === undefined) { const { sill } = glassHeights({ ...u, size: 'fixed' }, top); return glassHeights({ ...u, headGap: top - sill - u.winH }, top); }
  return glassHeights(u, top);
}

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
    const { sill, head } = windowHeights(u, top);
    const u0 = mid - w / 2, u1 = mid + w / 2;
    const v0 = Math.max(sill, WINDOW_EDGE), v1 = Math.min(head, h - WINDOW_EDGE);
    if (u1 - u0 > 0.05 && v1 - v0 > 0.05) out.push({ index: i, u0, u1, v0, v1 });
  }
  return out;
}

// ---------- the top of the wall ----------

// How thick an assembly is, from its layers' materials (a layer without a thickness counts 0).
function assemblyThickness(ep, name) {
  const c = ep.Construction?.[name];
  if (!c) return null;
  return LAYER_FIELDS.reduce((t, f) => t + (c[f] ? ep.Material?.[c[f]]?.thickness || 0 : 0), 0);
}
// Each storey's slab: the band at the top of its walls the windows stay under. Floors hang below their
// level, so it is the thickness of the floor assembly of the storey above (from the model `ep` where it
// has one, else the massing's own slab). The top storey's roof stands on its walls: no band.
export function setSlabs(m, ep = null) {
  m.storeys.forEach((s, i) => {
    const above = m.storeys[i + 1];
    if (!above) { s.slab = 0; return; }
    const Z = zoneName(m, above, i + 1), floors = Object.values(ep?.['BuildingSurface:Detailed'] || {}).filter((o) => o.zone_name === Z && o.surface_type === 'Floor');
    const f = floors.find((o) => o.outside_boundary_condition === 'Surface') || floors[0];
    const t = f && assemblyThickness(ep, f.construction_name);
    s.slab = +(t ?? MASSING_ASSEMBLIES_SLAB_T).toFixed(4);
  });
  return m;
}

// ---------- geometry ----------

// The storeys' floor levels.
export function storeyBases(m) {
  const z = [0];
  for (const s of m.storeys) z.push(z[z.length - 1] + s.h);
  return z;
}
// Turned clockwise in plan by a degrees, as a compass bearing turns.
export const turnPlan = ([x, y], a) => { const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; };
// A storey's plate in building coordinates: its corners counterclockwise seen from above, from the
// south-west (before it is turned), so edge k is its side SIDES[k], left to right seen from outside.
export function platePolygon(s) {
  const hw = s.w / 2, hd = s.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map((p) => { const [x, y] = turnPlan(p, s.rot || 0); return [x + s.ox, y + s.oy]; });
}
const polyArea = (P) => P.reduce((a, p, i) => { const q = P[(i + 1) % P.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
// A convex polygon clipped to the inside (left) of the line a -> b, or to its outside.
function clipLine(P, a, b, inside = true) {
  const side = (p) => (inside ? 1 : -1) * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  const out = [];
  P.forEach((p, i) => {
    const q = P[(i + 1) % P.length], sp = side(p), sq = side(q);
    if (sp >= -1e-9) out.push(p);
    if ((sp > 1e-9 && sq < -1e-9) || (sp < -1e-9 && sq > 1e-9)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  });
  return clean(out);
}
// Repeated and collinear corners dropped.
function clean(P) {
  let out = P.filter((p, i) => Math.hypot(p[0] - P[(i + 1) % P.length][0], p[1] - P[(i + 1) % P.length][1]) > 1e-6);
  out = out.filter((p, i) => { const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length]; return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-9; });
  return out.length >= 3 && polyArea(out) > 1e-4 ? out : [];
}
// Where two convex plates overlap, or null.
const overlap = (A, B) => { let P = A; for (let i = 0; i < B.length && P.length; i++) P = clipLine(P, B[i], B[(i + 1) % B.length]); return P.length ? P : null; };
// A convex plate less another, as convex pieces: the part outside each of the other's sides in turn.
function minus(A, B) {
  if (!overlap(A, B)) return [A];
  const out = [];
  let rest = A;
  for (let i = 0; i < B.length && rest.length; i++) {
    const a = B[i], b = B[(i + 1) % B.length], piece = clipLine(rest, a, b, false);
    if (piece.length) out.push(piece);
    rest = clipLine(rest, a, b, true);
  }
  return out;
}
// A plate at a height, its corners counterclockwise seen from above (up) or from below (down).
const flat = (P, z, up) => (up ? P : [...P].reverse()).map(([x, y]) => [x, y, z]);

const zoneName = (m, s, i) => `${String(s.name || `${m.name || 'Floor'}${i + 1}`).replace(/[,;!]/g, ' ').trim()}_${i}`;

// Every zone's surfaces and windows, in building coordinates (the plan turned by `rot`, degrees
// clockwise), before they are written: the geometry the tests and the drawings read.
export function massingGeometry(m) {
  const z = storeyBases(m), a = ((m.rot || 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const turn = ([x, y, h]) => [x * c + y * sn, -x * sn + y * c, h];
  const zones = m.storeys.map((s, i) => ({ name: zoneName(m, s, i), storey: i, z0: z[i], z1: z[i + 1], plate: platePolygon(s), surfaces: [], windows: [] }));
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
    for (const [k, f] of SIDES.entries()) {
      const A = zone.plate[k], B = zone.plate[(k + 1) % 4], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const wall = add(zone, 'Wall', 'facade', [[A[0], A[1], zone.z0], [B[0], B[1], zone.z0], [B[0], B[1], zone.z1], [A[0], A[1], zone.z1]], { side: f });
      const at = (u, v) => [mid[0] + U[0] * u, mid[1] + U[1] * u, zone.z0 + v];
      sideWindows(s.sides?.[f], len, s.h, s.slab).forEach((w, k) => zone.windows.push({
        name: `${wall}:w${k}`, wall, side: f, index: w.index, width: w.u1 - w.u0, height: w.v1 - w.v0,
        azimuth: (SIDE_AZIMUTH[f] + (s.rot || 0) + (m.rot || 0) + 720) % 360,
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
const MASSING_ASSEMBLIES_SLAB_T = MASSING_ASSEMBLIES.slab[1].reduce((t, n) => t + MATERIALS[n][0], 0);
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
export function massingEpJSON(m, { weather = null, runPeriod = null, ep: from = null } = {}) {
  setSlabs(m, from);
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
    const Z = zone.name, floorArea = polyArea(zone.plate);
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

// ---------- a massing changed, in a model already edited ----------

// The objects a zone has of its own, besides those naming it in a zone field.
const ZONE_OWN = (Z) => [['DesignSpecification:OutdoorAir', `${Z}MinFreshAir`], ['ZoneHVAC:IdealLoadsAirSystem', `${Z} Ideal Loads Air`],
  ['ZoneHVAC:EquipmentList', `${Z} Equipment`], ['NodeList', `${Z} Inlets`]];
const zoneField = (o) => o && (o.zone_name ?? o.zone_or_zonelist_or_space_or_spacelist_name ?? o.zone_or_space_name ?? o.zone_or_zonelist_name);
const GEOMETRY = ['Zone', 'BuildingSurface:Detailed', 'FenestrationSurface:Detailed', 'ZoneVentilation:WindandStackOpenArea'];
const KEEP_VENT = ['minimum_indoor_temperature', 'maximum_indoor_temperature', 'delta_temperature', 'minimum_outdoor_temperature', 'maximum_outdoor_temperature', 'maximum_wind_speed', 'opening_area_fraction_schedule_name'];

// Rewrites a model's geometry from its massing, in an edit transaction (edit.js), keeping what was
// changed since where it still applies: a surface's or window's assembly while it is the same kind of
// surface, a zone's loads, systems and opening controls while the zone is there, and every material,
// assembly and schedule. Zones that are gone take their own objects with them; new ones start with
// the massing's settings. The operable fraction a zone's openings had is kept.
export function applyMassing(tx, m, opts = {}) {
  const fresh = massingEpJSON(m, { ...opts, ep: tx.epjson }), ep = tx.epjson, zones = new Set(Object.keys(fresh.Zone));
  for (const Z of Object.keys(ep.Zone || {})) {
    if (zones.has(Z)) continue;
    for (const [type, objs] of Object.entries(ep)) for (const [n, o] of Object.entries(objs || {})) if (zoneField(o) === Z && !GEOMETRY.includes(type)) tx.remove(type, n);
    for (const [type, n] of ZONE_OWN(Z)) if (ep[type]?.[n]) tx.remove(type, n);
  }
  // the operable fraction and controls each zone's openings have now
  const vent = {};
  for (const [n, v] of Object.entries(ep['ZoneVentilation:WindandStackOpenArea'] || {})) {
    const Z = v.zone_or_space_name;
    if (vent[Z] || !n.endsWith('_Buoy')) continue;
    const glazing = Object.values(ep['FenestrationSurface:Detailed'] || {}).filter((w) => ep['BuildingSurface:Detailed']?.[w.building_surface_name]?.zone_name === Z);
    const area = glazing.reduce((s, w) => s + windowArea(w), 0);
    vent[Z] = { fraction: area > 0 ? v.opening_area / area : null, controls: Object.fromEntries(KEEP_VENT.filter((k) => k in v).map((k) => [k, v[k]])) };
  }
  for (const type of GEOMETRY) {
    for (const n of Object.keys(ep[type] || {})) if (!fresh[type]?.[n]) tx.remove(type, n);
    for (const [n, o] of Object.entries(fresh[type] || {})) {
      const old = ep[type]?.[n], next = structuredClone(o);
      if (old && (type === 'BuildingSurface:Detailed' ? old.surface_type === o.surface_type && old.outside_boundary_condition === o.outside_boundary_condition : type === 'FenestrationSurface:Detailed')) next.construction_name = old.construction_name;
      if (type === 'ZoneVentilation:WindandStackOpenArea' && vent[o.zone_or_space_name]) {
        const v = vent[o.zone_or_space_name], f = m.settings?.operableFraction ?? MASSING_SETTINGS0().operableFraction;
        Object.assign(next, v.controls);
        if (v.fraction != null) next.opening_area = (o.opening_area * v.fraction) / f;
      }
      if (old && JSON.stringify(old) === JSON.stringify(next)) continue;
      const t = tx.get(type, n, true);
      for (const k of Object.keys(t)) delete t[k];
      Object.assign(t, next);
    }
  }
  for (const [type, objs] of Object.entries(fresh)) {
    if (GEOMETRY.includes(type)) continue;
    for (const [n, o] of Object.entries(objs)) if (!ep[type]?.[n]) Object.assign(tx.get(type, n, true), structuredClone(o));
  }
}
function windowArea(w) {
  const p = [1, 2, 3, 4].map((i) => [w[`vertex_${i}_x_coordinate`], w[`vertex_${i}_y_coordinate`], w[`vertex_${i}_z_coordinate`]]).filter((q) => q[0] != null);
  return p.length ? polygonArea(p) : 0;
}

// Which window of which array a window of the written model is: its storey, side and place in the
// array (as massingGeometry numbers them). null for a window the massing did not make.
export function massingWindow(m, name) {
  for (const zone of massingGeometry(m)) {
    const w = zone.windows.find((x) => x.name === name);
    if (w) return { storey: zone.storey, side: w.side, index: w.index, z0: zone.z0 };
  }
  return null;
}

// A window moved or resized in its wall (s along the wall to the right, z up, as edit.js's
// windowRect; `wallMid` the s of the wall's middle) broken out of its array with that size and place.
export function breakOutWindow(m, name, r, wallMid) {
  const at = massingWindow(m, name);
  if (!at) return false;
  const s = m.storeys[at.storey], g = s.sides[at.side];
  const len = at.side === 'N' || at.side === 'S' ? s.w : s.d, { first, pitch } = unitLayout(g, len);
  const mid = (r.s0 + r.s1) / 2 - wallMid;
  g.broken = { ...(g.broken || {}) };
  g.broken[at.index] = { ...unitOf(g, at.index), size: 'fixed', winW: +(r.s1 - r.s0).toFixed(3), winH: +(r.z1 - r.z0).toFixed(3), sill: +(r.z0 - at.z0).toFixed(3), offU: +(mid - (first + at.index * pitch)).toFixed(3) };
  return true;
}

// ---------- a side's windows, as the facade-windows skill edits them ----------
// A side's array stands in for the skill's system and its unit at once: winBy, winN and winSp set it
// out; winW, winH, sill, size and the edges' other forms (jamb, headGap, widthR, sillR, headR) are its
// window type. A broken window keeps a type of its own in broken[i], with offU along its bay.

const sideLength = (s, f) => (f === 'N' || f === 'S' ? s.w : s.d);
const top = (s) => Math.max(0.1, s.h - clamp(s.slab ?? 0, 0, s.h - 0.1));
// The window type window i lays: its own when broken out, else the array's.
export function unitOf(g, i) {
  const b = g.broken?.[i], u = Object.fromEntries(UNIT_KEYS.filter((k) => k in g).map((k) => [k, g[k]]));
  return b ? { ...u, ...b } : u;
}
// Where window i's figures are measured from: its bay and the top of its wall.
export function windowContext(m, i, f) {
  const s = m.storeys[i], g = s.sides[f], { pitch } = unitLayout(g, sideLength(s, f));
  return { pitch, top: top(s), slab: s.slab ?? 0 };
}
// A bare side given windows: one window in its middle, or a preset (punched, window wall, curtain wall).
export function addWindows(m, i, f, preset = null) {
  const s = m.storeys[i];
  if (preset) {
    const p = PRESETS[preset];
    s.sides[f] = { ...WINDOWS0(), winW: 1.5, winH: 1.8, sill: 0.9, ...p.sys, ...p.unit, broken: {} };
    delete s.sides[f].name;
    if (p.unit.size === 'offset') setSize(s.sides[f], 'offset', p.sys.winSp, top(s));
  } else {
    const winH = Math.max(0.6, Math.min(1.8, top(s) - 0.9));
    s.sides[f] = { ...WINDOWS0(), winBy: 'number', winN: 1, winW: 1.5, winH, sill: 0.9 };
  }
}
// One window, or an array that repeats it at a spacing leaving wall between.
export const isArray = (g) => !!g && !(g.winBy !== 'spacing' && g.winN <= 1);
export function setArray(g, on) {
  if (on) Object.assign(g, { winBy: 'spacing', winSp: +Math.max(3, (g.winW || 1.5) + 1.2).toFixed(4) });
  else Object.assign(g, { winBy: 'number', winN: 1, broken: {} });
}
// Set out by number or by spacing, keeping the layout it has.
export function setBy(m, i, f, by) {
  const s = m.storeys[i], g = s.sides[f];
  if (g.winBy === by) return;
  const lay = unitLayout(g, sideLength(s, f));
  g.winBy = by;
  if (by === 'number') g.winN = Math.max(1, lay.n); else g.winSp = +lay.pitch.toFixed(4);
}
export const setCount = (g, n) => Object.assign(g, { winBy: 'number', winN: clamp(Math.round(n), 1, 200) });
export const setSpacing = (g, sp) => Object.assign(g, { winBy: 'spacing', winSp: clamp(sp, 0.3, 60) });
// A window dragged along its side: the pitch the pointer implies (u from the side's middle), from the
// first window, or from the last when the first is dragged. By number, the nearest count.
export function dragPitch(m, i, f, idx, u) {
  const s = m.storeys[i], g = s.sides[f], len = sideLength(s, f), { n, pitch, first } = unitLayout(g, len);
  if (n < 2) return;
  const last = first + (n - 1) * pitch, p = Math.max(0.3, idx > 0 ? (u - first) / idx : (last - u) / (n - 1));
  if (g.winBy !== 'spacing') g.winN = clamp(Math.round(len / p), 1, 200); else g.winSp = Math.round(p / 0.05) * 0.05;
}
// How the type's edges hold (Fixed, Offsets, Proportional), switched without moving the glass.
export function setWindowSize(m, i, f, k, mode) {
  const g = m.storeys[i].sides[f], ctx = windowContext(m, i, f), u = g.broken?.[k] ? g.broken[k] : g;
  const was = legacy(u === g ? g : unitOf(g, k));
  if (u === g) { delete g.fillW; delete g.fillH; }
  const w = glassWidth(was, ctx.pitch), { sill, head } = windowHeights(was, ctx.top);
  Object.assign(u, { size: was.size || 'fixed', winW: w, sill, winH: head - sill });
  setSize(u, mode, ctx.pitch, ctx.top);
}
// One of window k's figures set ('winW', 'sill', 'head', 'winH', 'jamb', 'headGap', 'widthR', 'sillR',
// 'headR'): on its own type when broken out, else on the array's, so every window of it changes.
export function setWindowFigure(m, i, f, k, key, v) {
  const g = m.storeys[i].sides[f], ctx = windowContext(m, i, f), u = g.broken?.[k] ? g.broken[k] : g;
  if (u === g && (g.fillW || g.fillH) && !g.size) setWindowSize(m, i, f, k, 'offset');
  setFigure(u, key, v, ctx);
}
// Broken out of its array: window k takes a copy of the array's type as its own.
export function breakWindow(g, k) { g.broken = { ...(g.broken || {}), [k]: { ...unitOf(g, k), offU: 0 } }; }
// Back into the array (revert); or its type given to the array (apply), the others broken out kept or
// bound back too.
export function revertWindow(g, k) { if (g.broken) delete g.broken[k]; }
export function applyToArray(g, k, others = 'keep') {
  const b = g.broken?.[k];
  if (!b) return;
  const { offU, ...unit } = b;
  for (const key of UNIT_KEYS) delete g[key];
  Object.assign(g, unit);
  delete g.fillW; delete g.fillH;
  delete g.broken[k];
  if (others === 'rebind') g.broken = {};
}
export const brokenOf = (g) => Object.keys(g?.broken || {}).map(Number).sort((a, b) => a - b);
// The links a storey keeps: its other sides follow side f (linkSides), the storeys above follow it
// (linkAbove). After every edit to side f, they take a copy of it.
export function spreadSide(m, i, f) {
  const s = m.storeys[i], g = s.sides[f];
  const to = [];
  if (s.linkSides) for (const x of SIDES) if (x !== f) to.push([i, x]);
  if (s.linkAbove) for (let j = i + 1; j < m.storeys.length; j++) for (const x of s.linkSides ? SIDES : [f]) to.push([j, x]);
  for (const [j, x] of to) m.storeys[j].sides[x] = g ? structuredClone(g) : null;
}

// ---------- a storey's handles ----------

// A storey as the view draws its handles, in the model's coordinates (the building turned): its
// corners, floor and roof levels, middle, own axes, and each face's middle and outward normal
// ('S', 'E', 'N', 'W', 'roof', 'floor').
export function storeyFrame(m, i) {
  const s = m.storeys[i], z = storeyBases(m), z0 = z[i], z1 = z[i + 1], B = m.rot || 0;
  const corners = platePolygon(s).map((p) => turnPlan(p, B));
  const c = turnPlan([s.ox, s.oy], B), axis = (v) => [...turnPlan(turnPlan(v, s.rot || 0), B), 0];
  const faces = SIDES.map((f, k) => {
    const a = corners[k], b = corners[(k + 1) % 4], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { key: f, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (z0 + z1) / 2], normal: [(b[1] - a[1]) / d, -(b[0] - a[0]) / d, 0] };
  });
  faces.push({ key: 'roof', at: [c[0], c[1], z1], normal: [0, 0, 1] });
  if (i > 0) faces.push({ key: 'floor', at: [c[0], c[1], z0], normal: [0, 0, -1] });
  return { corners, z0, z1, centre: [c[0], c[1], (z0 + z1) / 2], x: axis([1, 0]), y: axis([0, 1]), faces };
}

const SIDE_NORMAL = { S: [0, -1], E: [1, 0], N: [0, 1], W: [-1, 0] };
export const STOREY_MIN = { h: 2, w: 1, d: 1 };

// A face of storey i pushed or pulled by `dist` m along its outward normal: a wall takes its side of
// the plate with it (the opposite side stays), the roof raises the storey and every storey above, the
// floor lowers this storey's floor and so the ceiling of the one below. Returns the distance taken.
export function pushFace(m, i, face, dist) {
  const s = m.storeys[i];
  if (face === 'roof') { const h = Math.max(STOREY_MIN.h, s.h + dist); dist = h - s.h; s.h = h; return dist; }
  if (face === 'floor') {
    const below = m.storeys[i - 1];
    if (!below) return 0;
    dist = Math.min(dist, below.h - STOREY_MIN.h);
    dist = Math.max(dist, STOREY_MIN.h - s.h);
    below.h -= dist; s.h += dist;
    return dist;
  }
  const k = face === 'E' || face === 'W' ? 'w' : 'd', v = Math.max(STOREY_MIN[k], s[k] + dist);
  dist = v - s[k];
  s[k] = v;
  const [dx, dy] = turnPlan(SIDE_NORMAL[face], s.rot || 0);
  s.ox += (dx * dist) / 2; s.oy += (dy * dist) / 2;
  return dist;
}

// Storey i moved along its own x or y axis, or up ('z': its floor and every storey above rise, the
// storey below growing to meet it).
export function moveStorey(m, i, axis, dist) {
  const s = m.storeys[i];
  if (axis === 'z') {
    const below = m.storeys[i - 1];
    if (!below) return 0;
    const h = Math.max(STOREY_MIN.h, below.h + dist);
    dist = h - below.h; below.h = h;
    return dist;
  }
  const [dx, dy] = turnPlan(axis === 'x' ? [1, 0] : [0, 1], s.rot || 0);
  s.ox += dx * dist; s.oy += dy * dist;
  return dist;
}
