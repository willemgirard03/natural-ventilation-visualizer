// Edits to a model's .epJSON: windows moved and resized in their wall, assemblies swapped and their
// layers changed, zone settings (occupancy, lights, equipment, outdoor air, infiltration, natural
// ventilation). The .epJSON is the one model (PLAN.md, Modelling and editing): each edit changes its
// objects, and the tool reads it again (importEpJSON) to rebuild everything drawn and solved from it.
//
// Every edit runs in a transaction that keeps a copy of each object before its first change, so it
// can be undone: edit(epjson, (tx) => ...) returns { undo, redo }.

import { area, bounds, dot, unitNormal } from './geometry.js';
import { LAYER_FIELDS } from './constructions.js';

export function edit(epjson, change) {
  const before = new Map(); // "type\u0000name" -> the object as it was (undefined: it did not exist)
  const tx = {
    epjson,
    // The object, kept as it was before its first change in this edit; created when missing.
    get(type, name, create = false) {
      const key = `${type}\u0000${name}`;
      if (!before.has(key)) before.set(key, epjson[type]?.[name] === undefined ? undefined : structuredClone(epjson[type][name]));
      if (create && !epjson[type]?.[name]) (epjson[type] ||= {})[name] = {};
      return epjson[type]?.[name];
    },
    remove(type, name) { this.get(type, name); if (epjson[type]) delete epjson[type][name]; },
  };
  const result = change(tx);
  const after = new Map([...before.keys()].map((k) => { const [t, n] = k.split('\u0000'); return [k, epjson[t]?.[n] === undefined ? undefined : structuredClone(epjson[t][n])]; }));
  const put = (states) => {
    for (const [k, v] of states) {
      const [t, n] = k.split('\u0000');
      if (v === undefined) { if (epjson[t]) delete epjson[t][n]; } else (epjson[t] ||= {})[n] = structuredClone(v);
    }
  };
  return { result, undo: () => put(before), redo: () => put(after), changed: before.size > 0 };
}

// ---------- geometry ----------

// Building coordinates back to a zone's relative ones (the inverse of geometry.js toBuilding).
export function toZone(points, zone = {}) {
  const ox = zone.x_origin || 0, oy = zone.y_origin || 0, oz = zone.z_origin || 0;
  const r = ((zone.direction_of_relative_north || 0) * Math.PI) / 180;
  if (!ox && !oy && !oz && !r) return points;
  const c = Math.cos(r), s = Math.sin(r);
  return points.map(([x, y, z]) => { const X = x - ox, Y = y - oy; return [X * c - Y * s, X * s + Y * c, z - oz]; });
}

// Writes vertices into an object in the layout it already uses (a "vertices" list or numbered fields).
function writeVertices(obj, pts) {
  const r = (x) => Math.round(x * 1e6) / 1e6;
  if (Array.isArray(obj.vertices)) {
    obj.vertices = pts.map(([x, y, z]) => ({ vertex_x_coordinate: r(x), vertex_y_coordinate: r(y), vertex_z_coordinate: r(z) }));
  } else {
    for (let i = 1; obj[`vertex_${i}_x_coordinate`] !== undefined; i++) for (const a of 'xyz') delete obj[`vertex_${i}_${a}_coordinate`];
    pts.forEach(([x, y, z], i) => Object.assign(obj, { [`vertex_${i + 1}_x_coordinate`]: r(x), [`vertex_${i + 1}_y_coordinate`]: r(y), [`vertex_${i + 1}_z_coordinate`]: r(z) }));
  }
  if ('number_of_vertices' in obj) obj.number_of_vertices = pts.length;
}

// An upright wall's own frame: right (along the wall, to the right seen from outside), out (its
// outward normal, level) and where its plane is along out. null for walls that lean or lie flat.
export function wallFrame(vertices) {
  const n = unitNormal(vertices);
  if (Math.abs(n[2]) > 0.05) return null;
  const h = Math.hypot(n[0], n[1]), out = [n[0] / h, n[1] / h, 0];
  const right = [-out[1], out[0], 0];
  return { right, out, plane: dot(vertices[0], out) };
}

// A window as a rectangle in its wall's frame: s from left jamb to right jamb (m along right), z from
// sill to head. null when the wall or window is not upright.
export function windowRect(model, name) {
  const w = model.windows[name], wall = w && model.surfaces[w.parent];
  const f = wall && wallFrame(wall.vertices);
  if (!f) return null;
  const s = w.vertices.map((p) => dot(p, f.right)), z = w.vertices.map((p) => p[2]);
  return { s0: Math.min(...s), s1: Math.max(...s), z0: Math.min(...z), z1: Math.max(...z), frame: f };
}

// The wall's outline in its frame ([s, z] points), and the room it lets a window take.
function wallOutline(wall, f) {
  return wall.vertices.map((p) => [dot(p, f.right), p[2]]);
}
function inside2(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export const WINDOW_MIN = 0.2; // m, the smallest side of a window
export const WINDOW_EDGE = 0.02; // m, kept clear between a window and its wall's edges or another window

// Whether a rectangle fits its wall: inside its outline, clear of its edges and of the wall's other
// windows. Returns null when it fits, else why not.
export function rectProblem(model, name, r) {
  const w = model.windows[name], wall = model.surfaces[w.parent], f = wallFrame(wall.vertices);
  if (r.s1 - r.s0 < WINDOW_MIN - 1e-9 || r.z1 - r.z0 < WINDOW_MIN - 1e-9) return `A window is at least ${WINDOW_MIN * 1000} mm each way.`;
  const outline = wallOutline(wall, f), e = WINDOW_EDGE;
  const corners = [[r.s0 - e, r.z0 - e], [r.s1 + e, r.z0 - e], [r.s1 + e, r.z1 + e], [r.s0 - e, r.z1 + e]];
  if (!corners.every((c) => inside2(c, outline))) return 'The window would reach past its wall.';
  for (const other of wall.windows) {
    if (other === name) continue;
    const o = windowRect(model, other);
    if (o && r.s0 < o.s1 + e && r.s1 > o.s0 - e && r.z0 < o.z1 + e && r.z1 > o.z0 - e) return `The window would overlap ${other}.`;
  }
  return null;
}

// The rectangle moved or resized as far as the wall allows: each side held inside the wall's
// bounds (an outline that is not a rectangle is checked by rectProblem).
export function clampRect(model, name, r) {
  const w = model.windows[name], wall = model.surfaces[w.parent], f = wallFrame(wall.vertices);
  const b = bounds(wallOutline(wall, f).map(([s, z]) => [s, z, 0])), e = WINDOW_EDGE;
  const lo = [b.min[0] + e, b.min[1] + e], hi = [b.max[0] - e, b.max[1] - e];
  const fit = (a0, a1, min, max) => {
    const size = a1 - a0;
    if (size > max - min) return [min, max];
    if (a0 < min) return [min, min + size];
    if (a1 > max) return [max - size, max];
    return [a0, a1];
  };
  const [s0, s1] = fit(r.s0, r.s1, lo[0], hi[0]), [z0, z1] = fit(r.z0, r.z1, lo[1], hi[1]);
  return { s0, s1, z0, z1 };
}

// Sets a window to a rectangle in its wall (from windowRect's frame): its corners counterclockwise
// seen from outside from the lower left, in its zone's coordinates. The zone's natural-ventilation
// opening area follows its glazing, so the operable fraction stays as it was.
export function setWindowRect(tx, model, name, r) {
  const w = model.windows[name], rect = windowRect(model, name);
  if (!rect) throw new Error(`Window ${name} is not in an upright wall.`);
  const { right, out, plane } = rect.frame;
  const at = (s, z) => [right[0] * s + out[0] * plane, right[1] * s + out[1] * plane, z];
  const pts = [at(r.s0, r.z0), at(r.s1, r.z0), at(r.s1, r.z1), at(r.s0, r.z1)];
  const zoneFields = tx.epjson.Zone?.[w.zone] || {};
  const relative = String(Object.values(tx.epjson.GlobalGeometryRules || {})[0]?.coordinate_system || 'Relative').toLowerCase() === 'relative';
  writeVertices(tx.get('FenestrationSurface:Detailed', name), relative ? toZone(pts, zoneFields) : pts);
  const oldArea = w.area, newArea = area(pts) * (w.multiplier || 1);
  scaleOpenings(tx, w.zone, model.zones[w.zone].glazingArea, model.zones[w.zone].glazingArea - oldArea + newArea);
}

// A zone's natural-ventilation opening areas scaled with its glazing.
function scaleOpenings(tx, zone, before, after) {
  if (!(before > 0) || Math.abs(after - before) < 1e-9) return;
  for (const [name, v] of Object.entries(tx.epjson['ZoneVentilation:WindandStackOpenArea'] || {})) {
    if (v.zone_or_space_name !== zone || typeof v.opening_area !== 'number') continue;
    tx.get('ZoneVentilation:WindandStackOpenArea', name).opening_area = (v.opening_area * after) / before;
  }
}

// ---------- assemblies ----------

const FLIPPED = '_FLIPPED';
export const baseConstruction = (name) => String(name).replace(/_FLIPPED$/, '');

// A construction's layers, outside to inside.
export const layersOf = (c) => LAYER_FIELDS.map((f) => c[f]).filter(Boolean);
function setLayers(c, layers) {
  for (const f of LAYER_FIELDS) delete c[f];
  layers.forEach((l, i) => { c[LAYER_FIELDS[i]] = l; });
}

// The reversed construction a shared wall's other side uses, kept in step with its construction.
function syncFlipped(tx, name) {
  const flipped = name + FLIPPED;
  if (!tx.epjson.Construction?.[flipped]) return;
  setLayers(tx.get('Construction', flipped), layersOf(tx.epjson.Construction[name]).reverse());
}

// Gives a surface a construction. A surface shared by two zones takes it on this side and the
// reversed one on the other (made when missing), as ClimateStudio writes them.
export function setSurfaceConstruction(tx, model, surface, construction) {
  const s = model.surfaces[surface], base = baseConstruction(construction);
  if (!tx.epjson.Construction?.[base]) throw new Error(`No construction ${base}.`);
  const partner = s.boundary === 'Surface' && s.adjacentSurface && model.surfaces[s.adjacentSurface];
  if (!partner) { tx.get('BuildingSurface:Detailed', surface).construction_name = base; return; }
  if (!tx.epjson.Construction[base + FLIPPED]) {
    tx.get('Construction', base + FLIPPED, true);
    syncFlipped(tx, base);
  }
  // The side that had the reversed one keeps the reversed one.
  const mine = s.construction.endsWith(FLIPPED) ? base + FLIPPED : base, theirs = mine === base ? base + FLIPPED : base;
  tx.get('BuildingSurface:Detailed', surface).construction_name = mine;
  tx.get('BuildingSurface:Detailed', partner.name).construction_name = theirs;
}

// A copy of a construction (and its reversed one) under a new name, with materials of its own.
export function copyConstruction(tx, name, newName) {
  const base = baseConstruction(name);
  if (tx.epjson.Construction?.[newName]) throw new Error(`There is already a construction ${newName}.`);
  const layers = layersOf(tx.epjson.Construction[base]).map((m) => copyMaterial(tx, m, `${m} (${newName})`));
  setLayers(tx.get('Construction', newName, true), layers);
  if (tx.epjson.Construction[base + FLIPPED]) { tx.get('Construction', newName + FLIPPED, true); syncFlipped(tx, newName); }
  return newName;
}

const MATERIAL_TYPES = ['Material', 'Material:NoMass', 'Material:AirGap', 'WindowMaterial:SimpleGlazingSystem', 'WindowMaterial:Glazing', 'WindowMaterial:Gas'];
export function materialType(epjson, name) {
  return MATERIAL_TYPES.find((t) => epjson[t]?.[name]) || null;
}
function copyMaterial(tx, name, newName) {
  const type = materialType(tx.epjson, name);
  if (!type) return name;
  let n = newName, i = 2;
  while (materialType(tx.epjson, n)) n = `${newName} ${i++}`;
  Object.assign(tx.get(type, n, true), structuredClone(tx.epjson[type][name]));
  return n;
}

// Constructions (other than a construction and its reversed one) that use a material.
function otherUses(epjson, material, construction) {
  const base = baseConstruction(construction);
  return Object.entries(epjson.Construction || {}).filter(([n, c]) => baseConstruction(n) !== base && layersOf(c).includes(material)).map(([n]) => n);
}

// Changes one layer of a construction (index from outside): another material, and/or the material's
// thickness (m). A material other constructions also use is copied first, so they are not changed.
export function setLayer(tx, construction, index, { material, thickness } = {}) {
  const base = baseConstruction(construction), c = tx.get('Construction', base), layers = layersOf(c);
  if (index < 0 || index >= layers.length) throw new Error('No such layer.');
  if (material) {
    if (!materialType(tx.epjson, material)) throw new Error(`No material ${material}.`);
    layers[index] = material;
  }
  if (thickness !== undefined) {
    let m = layers[index];
    const type = materialType(tx.epjson, m);
    if (type !== 'Material') throw new Error('Only a layer with mass has a thickness to change.');
    if (!(thickness > 0)) throw new Error('A layer is thicker than 0.');
    if (otherUses(tx.epjson, m, base).length) layers[index] = m = copyMaterial(tx, m, `${m} (${base})`);
    tx.get('Material', m).thickness = thickness;
  }
  setLayers(c, layers);
  syncFlipped(tx, base);
}

// Adds a layer (a material) at an index from outside, or removes one.
export function addLayer(tx, construction, index, material) {
  const base = baseConstruction(construction), c = tx.get('Construction', base), layers = layersOf(c);
  if (layers.length >= LAYER_FIELDS.length) throw new Error(`A construction has at most ${LAYER_FIELDS.length} layers.`);
  if (!materialType(tx.epjson, material)) throw new Error(`No material ${material}.`);
  layers.splice(Math.max(0, Math.min(index, layers.length)), 0, material);
  setLayers(c, layers);
  syncFlipped(tx, base);
}
export function removeLayer(tx, construction, index) {
  const base = baseConstruction(construction), c = tx.get('Construction', base), layers = layersOf(c);
  if (layers.length <= 1) throw new Error('A construction keeps at least one layer.');
  layers.splice(index, 1);
  setLayers(c, layers);
  syncFlipped(tx, base);
}

// ---------- zone settings ----------

const zoneOf = (o) => o.zone_or_zonelist_or_space_or_spacelist_name || o.zone_or_space_name || o.zone_name;
const objectsOf = (epjson, type, zone) => Object.entries(epjson[type] || {}).filter(([, o]) => zoneOf(o) === zone);

// The outdoor-air specification a zone's ideal loads (or its sizing) uses.
// Through the zone's equipment list, as co2.js reads it; else its sizing.
export function outdoorAirSpec(epjson, zone) {
  const conn = Object.values(epjson['ZoneHVAC:EquipmentConnections'] || {}).find((c) => c.zone_name === zone);
  const list = epjson['ZoneHVAC:EquipmentList']?.[conn?.zone_conditioning_equipment_list_name];
  const item = (list?.equipment || []).find((e) => e.zone_equipment_object_type === 'ZoneHVAC:IdealLoadsAirSystem');
  const unit = (item && epjson['ZoneHVAC:IdealLoadsAirSystem']?.[item.zone_equipment_name])
    || Object.values(epjson['Sizing:Zone'] || {}).find((s) => s.zone_or_zonelist_name === zone);
  const name = unit?.design_specification_outdoor_air_object_name;
  return name && epjson['DesignSpecification:OutdoorAir']?.[name] ? name : null;
}

// Sets one of a zone's settings, in every object of the zone that carries it:
//   peoplePerArea (people/m2), peopleSchedule (name), lightsPerArea (W/m2), equipmentPerArea (W/m2),
//   outdoorAirPerPerson (m3/s per person), outdoorAirPerArea (m3/s per m2), infiltrationAch (1/h),
//   ventMinIndoor (degC: windows open above it).
export function setZoneSetting(tx, zone, key, value) {
  const ep = tx.epjson;
  const each = (type, fn) => { const list = objectsOf(ep, type, zone); for (const [n] of list) fn(tx.get(type, n)); return list.length; };
  const n = {
    peoplePerArea: () => each('People', (o) => { o.number_of_people_calculation_method = 'People/Area'; o.people_per_floor_area = value; delete o.number_of_people; delete o.floor_area_per_person; }),
    peopleSchedule: () => each('People', (o) => { o.number_of_people_schedule_name = value; }),
    lightsPerArea: () => each('Lights', (o) => { o.design_level_calculation_method = 'Watts/Area'; o.watts_per_zone_floor_area = value; delete o.lighting_level; delete o.watts_per_person; }),
    equipmentPerArea: () => each('ElectricEquipment', (o) => { o.design_level_calculation_method = 'Watts/Area'; o.watts_per_zone_floor_area = value; delete o.design_level; delete o.watts_per_person; }),
    infiltrationAch: () => each('ZoneInfiltration:DesignFlowRate', (o) => {
      o.design_flow_rate_calculation_method = 'AirChanges/Hour'; o.air_changes_per_hour = value;
      delete o.design_flow_rate; delete o.flow_rate_per_floor_area; delete o.flow_rate_per_exterior_surface_area;
    }),
    ventMinIndoor: () => each('ZoneVentilation:WindandStackOpenArea', (o) => { o.minimum_indoor_temperature = value; }),
    outdoorAirPerPerson: () => { const s = outdoorAirSpec(ep, zone); if (s) tx.get('DesignSpecification:OutdoorAir', s).outdoor_air_flow_per_person = value; return s ? 1 : 0; },
    outdoorAirPerArea: () => { const s = outdoorAirSpec(ep, zone); if (s) tx.get('DesignSpecification:OutdoorAir', s).outdoor_air_flow_per_zone_floor_area = value; return s ? 1 : 0; },
  }[key];
  if (!n) throw new Error(`No zone setting ${key}.`);
  if (!n()) throw new Error(`Zone ${zone} has nothing that sets ${key}.`);
}

// What a zone's settings are now, read from its objects (null where it has none).
export function zoneSettings(epjson, zone) {
  const first = (type) => objectsOf(epjson, type, zone)[0]?.[1] || null;
  const p = first('People'), l = first('Lights'), e = first('ElectricEquipment'), i = first('ZoneInfiltration:DesignFlowRate');
  const v = first('ZoneVentilation:WindandStackOpenArea'), oa = outdoorAirSpec(epjson, zone), s = oa && epjson['DesignSpecification:OutdoorAir'][oa];
  return {
    peopleMethod: p?.number_of_people_calculation_method ?? null,
    peoplePerArea: p?.number_of_people_calculation_method === 'People/Area' ? p.people_per_floor_area : null,
    peopleSchedule: p?.number_of_people_schedule_name ?? null,
    activitySchedule: p?.activity_level_schedule_name ?? null,
    lightsPerArea: l?.design_level_calculation_method === 'Watts/Area' ? l.watts_per_zone_floor_area : null,
    equipmentPerArea: e?.design_level_calculation_method === 'Watts/Area' ? e.watts_per_zone_floor_area : null,
    infiltrationAch: i?.design_flow_rate_calculation_method === 'AirChanges/Hour' ? i.air_changes_per_hour : null,
    ventMinIndoor: v ? v.minimum_indoor_temperature : null,
    outdoorAirPerPerson: s ? s.outdoor_air_flow_per_person ?? 0 : null,
    outdoorAirPerArea: s ? s.outdoor_air_flow_per_zone_floor_area ?? 0 : null,
  };
}

// The schedules a setting can pick from: those of the given limits type (e.g. "Fraction"), by name.
export function schedulesOfType(epjson, limits) {
  const names = [];
  for (const type of ['Schedule:Year', 'Schedule:Constant', 'Schedule:Compact']) {
    for (const [n, o] of Object.entries(epjson[type] || {})) {
      if (!limits || String(o.schedule_type_limits_name || '').toLowerCase().includes(limits.toLowerCase())) names.push(n);
    }
  }
  return names.sort();
}

