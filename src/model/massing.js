// A building modelled from scratch as zones standing on levels, written out as a complete EnergyPlus
// .epJSON in ClimateStudio's manner, so the tool reads it as it reads a ClimateStudio model and
// EnergyPlus runs it as it is.
//
// The model (version 2):
//  - levels: elevations, lowest first, the first the ground (z 0). Moving a level moves every zone that
//    stands on it or reaches up to it.
//  - zones: each a prism between a base and a top level over a footprint (`plate`: a polygon,
//    counterclockwise seen from above, in the building's coordinates before the building is turned by
//    `rot`). Each edge of the footprint is a face, carrying its own window array (faces[k], or null);
//    a corner on a straight run of the footprint is a seam between two faces. `cells`, when there are
//    any, divide the footprint into the pieces its floor and roof are made of (the seams left where
//    zones were merged); else the footprint is one piece. `rot` is the turn of the zone's own axes.
//  - an older massing (storeys of rectangular plates, one zone each) is read as levels and one zone a
//    storey (upgradeMassing), its zones and surfaces keeping their names.
// The windows follow the shading tool's massing: each face carries a window array, set out by number
// (the face divided into equal bays) or by spacing (bays of a pitch, centred on the face); any window
// of an array can be broken out and given its own size, sill and place in its bay.
//
// What is written, as ClimateStudio writes it (CLIMATESTUDIO.md):
//  - zones `<name>_<index>`; surfaces `<zone>:f<n>`; windows `<zone>:f<n>:w<k>`;
//  - facades gross, windows as their subsurfaces; corners counterclockwise seen from outside;
//  - zones stacked: where one stands over another, a floor and ceiling pair (the floor with the
//    _FLIPPED assembly), the rest of the upper floor exposed (External Floor), the rest of the lower
//    ceiling a roof; where two zones' faces meet on the same levels, a pair of interior walls;
//  - the ground floor on the ground; every assembly with its _FLIPPED twin;
//  - natural ventilation by ZoneVentilation:WindandStackOpenArea: a wind object per window (its operable
//    area, facing its azimuth) and a stack object per zone (all its operable area, a quarter of the
//    window height), opening above the zone's set point, outdoor air 10 to 27 °C, scheduled by
//    NatVentAvail_<zone>, worked out from the weather file (at most 90% humidity) when one is given;
//  - an ideal-loads system per zone with heating and cooling off (free running) and mechanical
//    ventilation on the occupancy schedule; people, lights and equipment by floor area.
// The default loads and schedules are those of an office (public ASHRAE 90.1 / DOE prototype values).

import pc from 'polygon-clipping';
import { LAYER_FIELDS } from './constructions.js';
import { glassWidth as unitWidth, glassHeights, setSize, setFigure, PRESETS, UNIT_KEYS } from './windows.js';

export const SIDES = ['S', 'E', 'N', 'W']; // a storey plate's sides, in the order its faces are numbered
export const WINDOW_EDGE = 0.02; // m, kept between a window and its wall's edges or the next window
export const LEVEL_MIN = 2; // m, the least height between two levels
export const EDGE_MIN = 0.3; // m, the shortest face a footprint may have

export const WINDOWS0 = () => ({ winBy: 'number', winN: 4, winSp: 4.5, winW: 2.0, winH: 1.6, sill: 0.9, size: 'fixed', broken: {} });
// An older massing's storey: a rectangular plate (width along x, depth along y, centred on its offset).
export const storey0 = (h = 3.5, w = 20, d = 10) => ({ name: null, h, w, d, ox: 0, oy: 0, rot: 0, slab: 0.3, sides: { N: WINDOWS0(), E: WINDOWS0(), S: WINDOWS0(), W: WINDOWS0() } });

export const MASSING_SETTINGS0 = () => ({
  peoplePerArea: 0.0565, activity: 125.28, lightsPerArea: 6.57, equipmentPerArea: 10.33,
  outdoorAirPerPerson: 0.0025, outdoorAirPerArea: 0.0003, infiltrationAch: 0.1,
  operableFraction: 0.8, ventSetpoint: 25, ventMinOutdoor: 10, ventMaxOutdoor: 27, ventMaxHumidity: 90,
});

export const levelName = (i) => `Level ${i + 1}`;
export function massing0() {
  return upgradeMassing({ name: 'Floor', rot: 0, storeys: [storey0(), storey0()], settings: MASSING_SETTINGS0() });
}

// An older massing's storeys as levels and zones: a level at each storey's floor and one over the top,
// a zone a storey over its plate, its four sides its faces (S, E, N, W). A version 2 massing as it is.
export function upgradeMassing(m) {
  if (!m?.storeys) return m;
  const levels = [{ name: levelName(0), z: 0 }];
  let z = 0;
  m.storeys.forEach((s, i) => { z += s.h; levels.push({ name: levelName(i + 1), z: +z.toFixed(6) }); });
  const zones = m.storeys.map((s, i) => ({
    name: s.name || null, base: i, top: i + 1, rot: s.rot || 0, plate: platePolygon(s), faces: SIDES.map((f) => s.sides?.[f] ?? null),
    slab: s.slab ?? 0, linkFaces: !!s.linkSides, linkAbove: !!s.linkAbove,
  }));
  const { storeys, ...rest } = m;
  return { ...rest, version: 2, levels, zones };
}

// A zone's floor and top elevations, and its height.
export const zoneLevels = (m, i) => [m.levels[m.zones[i].base].z, m.levels[m.zones[i].top].z];
export const zoneHeight = (m, i) => { const [a, b] = zoneLevels(m, i); return b - a; };
// A zone's name as written: its own or the massing's with its base level's number, and its index.
export const zoneName = (m, i) => { const z = m.zones[i]; return `${String(z.name || `${m.name || 'Floor'}${z.base + 1}`).replace(/[,;!]/g, ' ').trim()}_${i}`; };

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

// The stretch of a face of length `len` an array is set out on, from the face's start: the whole face,
// or the array's own length (`len`), justified to the face's left, centre or right (`just`, seen from
// outside) and moved `off` from there (in from the left or right end; to the right of the middle).
export const JUSTS = [['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']];
export function arraySpan(g, len) {
  const L = Math.min(len, g.len > 0 ? g.len : len), off = g.off || 0;
  const s0 = g.just === 'left' ? off : g.just === 'right' ? len - off - L : (len - L) / 2 + off;
  const a = clamp(s0, 0, len - L);
  return [a, a + L];
}
// How the windows are set out along a face of length `len`: within the array's stretch, by number
// they divide it evenly; by spacing, they stand at that pitch, centred on it, each wholly on it. The
// count, the pitch and the centre of the first, from the middle of the face.
export function unitLayout(g, len) {
  const [s0, s1] = arraySpan(g, len), L = s1 - s0, mid = (s0 + s1) / 2 - len / 2;
  if (g.winBy !== 'spacing') {
    const n = Math.max(1, Math.round(g.winN));
    return { n, pitch: L / n, first: mid - L / 2 + L / n / 2, span: [s0, s1] };
  }
  const sp = Math.max(0.3, g.winSp), w = glassWidth(g, sp);
  const n = Math.max(0, Math.floor((L - w) / sp + 1e-9) + 1);
  return { n, pitch: sp, first: mid - ((n - 1) * sp) / 2, span: [s0, s1] };
}
// Where an array's bays begin and end along its face, from the face's start: what its bracket spans.
export function bayExtents(g, len) {
  const { n, pitch, first } = unitLayout(g, len);
  return n ? [first - pitch / 2 + len / 2, first + (n - 0.5) * pitch + len / 2] : arraySpan(g, len);
}

// A window of the array: the array's own, or as it was broken out.
export const unitGlazing = (g, i) => (g.broken && g.broken[i] ? { ...g, ...g.broken[i] } : g);

// The windows of one face, in the face's own coordinates: u across from its middle (left to right seen
// from outside), v up from the zone's floor. Each stays inside its bay, under the slab and clear of the
// wall's edges and of its neighbours.
export function sideWindows(g, len, h, slab = 0.3) {
  if (!g || len <= 0) return [];
  const { n, pitch, first, span } = unitLayout(g, len), top = Math.max(0.1, h - clamp(slab, 0, h - 0.1)), out = [];
  const a = Math.max(span[0] - len / 2, -len / 2 + WINDOW_EDGE), b = Math.min(span[1] - len / 2, len / 2 - WINDOW_EDGE);
  for (let i = 0; i < n; i++) {
    const u = unitGlazing(g, i), c = first + i * pitch;
    // the room the window has: its bay, less half the gap to the next, kept inside the array's stretch
    // and clear of the face's corners
    const lo = Math.max(c - pitch / 2 + WINDOW_EDGE / 2, a), hi = Math.min(c + pitch / 2 - WINDOW_EDGE / 2, b);
    const w = Math.min(glassWidth(u, pitch), hi - lo), mid = clamp(c + (u.offU || 0), lo + w / 2, hi - w / 2);
    const { sill, head } = windowHeights(u, top);
    const u0 = mid - w / 2, u1 = mid + w / 2;
    const v0 = Math.max(sill, WINDOW_EDGE), v1 = Math.min(head, h - WINDOW_EDGE);
    if (u1 - u0 > 0.05 && v1 - v0 > 0.05) out.push({ index: i, u0, u1, v0, v1 });
  }
  return out;
}

// ---------- plans ----------

// Turned clockwise in plan by a degrees, as a compass bearing turns.
export const turnPlan = ([x, y], a) => { const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; };
// An older storey's plate: its corners counterclockwise seen from above, from the south-west (before
// it is turned), so edge k is its side SIDES[k], left to right seen from outside.
export function platePolygon(s) {
  const hw = s.w / 2, hd = s.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map((p) => { const [x, y] = turnPlan(p, s.rot || 0); return [x + s.ox, y + s.oy]; });
}
export const polyArea = (P) => P.reduce((a, p, i) => { const q = P[(i + 1) % P.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
export const centroid = (P) => {
  let a = 0, x = 0, y = 0;
  P.forEach((p, i) => { const q = P[(i + 1) % P.length], c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; });
  return Math.abs(a) < 1e-12 ? [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length] : [x / (3 * a), y / (3 * a)];
};
// Repeated and collinear corners dropped; nothing left of a sliver.
function clean(P) {
  let out = P.filter((p, i) => Math.hypot(p[0] - P[(i + 1) % P.length][0], p[1] - P[(i + 1) % P.length][1]) > 1e-6);
  out = out.filter((p, i) => { const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length]; return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-9; });
  return out.length >= 3 && Math.abs(polyArea(out)) > 1e-4 ? out : [];
}
// Polygons for polygon-clipping, and its results back as simple polygons, counterclockwise and
// without holes (a piece with a hole is cut in two through the hole, as a surface can have none).
const R6 = (x) => Math.round(x * 1e6) / 1e6;
const geom = (P) => [P.map(([x, y]) => [R6(x), R6(y)])];
function pieces(multi) {
  const out = [];
  const take = (poly) => {
    if (poly.length > 1) {
      const h = poly[1], cx = h.reduce((s, p) => s + p[0], 0) / h.length, xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
      const lo = Math.min(...ys) - 1, hi = Math.max(...ys) + 1, x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1;
      for (const half of [[[x0, lo], [cx, lo], [cx, hi], [x0, hi]], [[cx, lo], [x1, lo], [x1, hi], [cx, hi]]]) for (const p of pc.intersection(poly, [half])) take(p);
      return;
    }
    const r = poly[0], last = r[r.length - 1], P = clean(last[0] === r[0][0] && last[1] === r[0][1] ? r.slice(0, -1) : r);
    if (P.length >= 3) out.push(polyArea(P) < 0 ? P.reverse() : P);
  };
  for (const poly of multi) take(poly);
  return out;
}
export const intersect = (A, B) => pieces(pc.intersection(geom(A), geom(B)));
export const subtract = (A, Bs) => (Bs.length ? pieces(pc.difference(geom(A), ...Bs.map(geom))) : pieces([geom(A)]));
export const unite = (Ps) => pieces(pc.union(...Ps.map(geom)));
// A plate at a height, its corners counterclockwise seen from above (up) or from below (down).
const flat = (P, z, up) => (up ? P : [...P].reverse()).map(([x, y]) => [x, y, z]);
// The cells a zone's floor and roof are made of: its own, or its footprint whole.
const cellsOf = (z) => (z.cells?.length ? z.cells : [z.plate]);

// ---------- the top of the wall ----------

// How thick an assembly is, from its layers' materials (a layer without a thickness counts 0).
function assemblyThickness(ep, name) {
  const c = ep.Construction?.[name];
  if (!c) return null;
  return LAYER_FIELDS.reduce((t, f) => t + (c[f] ? ep.Material?.[c[f]]?.thickness || 0 : 0), 0);
}
// Each zone's slab: the band at the top of its walls the windows stay under. Floors hang below their
// level, so it is the thickness of the floor assembly of a zone standing on it (from the model `ep`
// where it has one, else the massing's own slab). A zone with nothing on it: its roof stands on its
// walls, no band.
export function setSlabs(m, ep = null) {
  m.zones.forEach((z, i) => {
    const above = m.zones.map((y, j) => [y, j]).filter(([y]) => y.base === z.top && intersect(y.plate, z.plate).length);
    if (!above.length) { z.slab = 0; return; }
    let t = null;
    for (const [, j] of above) {
      const Z = zoneName(m, j), floors = Object.values(ep?.['BuildingSurface:Detailed'] || {}).filter((o) => o.zone_name === Z && o.surface_type === 'Floor');
      const f = floors.find((o) => o.outside_boundary_condition === 'Surface') || floors[0];
      t = f ? assemblyThickness(ep, f.construction_name) : null;
      if (t != null) break;
    }
    z.slab = +(t ?? MASSING_ASSEMBLIES_SLAB_T).toFixed(4);
  });
  return m;
}

// ---------- geometry ----------

// The walls along face k of zone i: the face split where other zones' faces meet it on the same levels
// (each such stretch an interior wall shared with that zone), the rest exterior. Pieces as spans along
// the face from its first corner (u0, u1) and heights (z0, z1), with the zone across (`other`) or null.
function wallPieces(info, i, k) {
  const Z = info[i], P = Z.plate, A = P[k], B = P[(k + 1) % P.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], near = [];
  info.forEach((Y, j) => {
    if (j === i || Y.z1 <= Z.z0 + 1e-6 || Y.z0 >= Z.z1 - 1e-6) return;
    Y.plate.forEach((C, q) => {
      const D = Y.plate[(q + 1) % Y.plate.length], off = (p) => (p[0] - A[0]) * U[1] - (p[1] - A[1]) * U[0];
      if (Math.abs(off(C)) > 1e-4 || Math.abs(off(D)) > 1e-4) return;
      const uc = (C[0] - A[0]) * U[0] + (C[1] - A[1]) * U[1], ud = (D[0] - A[0]) * U[0] + (D[1] - A[1]) * U[1];
      if (ud >= uc) return; // a face meeting this one runs the other way
      const a = Math.max(0, ud), b = Math.min(len, uc);
      if (b - a > 1e-4) near.push([j, a, b, Math.max(Z.z0, Y.z0), Math.min(Z.z1, Y.z1)]);
    });
  });
  const uniq = (xs) => [...new Set(xs.map(R6))].sort((a, b) => a - b);
  const us = uniq([0, len, ...near.flatMap((n) => [n[1], n[2]])]).filter((u) => u >= -1e-9 && u <= len + 1e-9);
  const zs = uniq([Z.z0, Z.z1, ...near.flatMap((n) => [n[3], n[4]])]).filter((z) => z >= Z.z0 - 1e-9 && z <= Z.z1 + 1e-9);
  const out = [];
  for (let b = 0; b + 1 < zs.length; b++) {
    const row = [];
    for (let a = 0; a + 1 < us.length; a++) {
      const um = (us[a] + us[a + 1]) / 2, zm = (zs[b] + zs[b + 1]) / 2;
      const other = near.find((x) => um > x[1] && um < x[2] && zm > x[3] && zm < x[4])?.[0] ?? null, last = row[row.length - 1];
      if (last && last.other === other) last.u1 = us[a + 1]; else row.push({ u0: us[a], u1: us[a + 1], z0: zs[b], z1: zs[b + 1], other });
    }
    // a piece the same as one in the band below, with the same zone across, joins it
    for (const r of row) {
      const below = out.find((o) => Math.abs(o.z1 - r.z0) < 1e-9 && Math.abs(o.u0 - r.u0) < 1e-9 && Math.abs(o.u1 - r.u1) < 1e-9 && o.other === r.other);
      if (below) below.z1 = r.z1; else out.push(r);
    }
  }
  return { A, U, len, pieces: out };
}

// Every zone's surfaces and windows, in building coordinates (the plan turned by `rot`, degrees
// clockwise), before they are written: the geometry the tests and the drawings read. Surfaces that
// meet another zone's (a floor on a ceiling, two walls back to back) are paired by `partner`.
export function massingGeometry(m) {
  m = upgradeMassing(m);
  const a = ((m.rot || 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const turn = ([x, y, h]) => [x * c + y * sn, -x * sn + y * c, h];
  const info = m.zones.map((z, i) => {
    const [z0, z1] = zoneLevels(m, i);
    return { name: zoneName(m, i), zone: i, z0, z1, plate: z.plate, area: Math.abs(polyArea(z.plate)), surfaces: [], windows: [] };
  });
  const pairs = new Map(); // where two surfaces meet: a key from their corners -> the surfaces there
  const keyOf = (pts) => pts.map((p) => p.map((x) => x.toFixed(3)).join(',')).sort().join('|');
  const add = (zone, type, kind, pts, extra = {}) => {
    const name = `${zone.name}:f${zone.surfaces.length}`, s = { name, type, kind, vertices: pts.map(turn), ...extra };
    zone.surfaces.push(s);
    if (kind === 'slab' || kind === 'inter') { const key = keyOf(pts); if (!pairs.has(key)) pairs.set(key, []); pairs.get(key).push(s); }
    return name;
  };
  info.forEach((zone, i) => {
    const z = m.zones[i], below = m.zones.filter((y) => y.top === z.base).flatMap(cellsOf), above = m.zones.filter((y) => y.base === z.top).flatMap(cellsOf);
    // the floor: on the ground, or over the zones below where they overlap, exposed elsewhere
    for (const cell of cellsOf(z)) {
      if (z.base === 0) { add(zone, 'Floor', 'ground', flat(cell, zone.z0, false)); continue; }
      for (const b of below) for (const o of intersect(cell, b)) add(zone, 'Floor', 'slab', flat(o, zone.z0, false));
      for (const r of subtract(cell, below)) add(zone, 'Floor', 'exposed', flat(r, zone.z0, false));
    }
    // the walls, face by face: exterior pieces with the face's windows, interior ones shared
    z.plate.forEach((_, k) => {
      const { A, U, len, pieces: ps } = wallPieces(info, i, k), at = (u, h) => [A[0] + U[0] * u, A[1] + U[1] * u, h];
      const walls = ps.map((p) => ({ ...p, name: add(zone, 'Wall', p.other === null ? 'facade' : 'inter', [at(p.u0, p.z0), at(p.u1, p.z0), at(p.u1, p.z1), at(p.u0, p.z1)], { face: k }) }));
      const az = ((Math.atan2(U[1], -U[0]) * 180) / Math.PI + (m.rot || 0) + 720) % 360;
      sideWindows(z.faces?.[k], len, zone.z1 - zone.z0, z.slab).forEach((w, n) => {
        // on the exterior piece that holds it whole; a window across a piece's edge is not made
        const u0 = w.u0 + len / 2, u1 = w.u1 + len / 2, v0 = zone.z0 + w.v0, v1 = zone.z0 + w.v1;
        const host = walls.find((p) => p.other === null && u0 >= p.u0 - 1e-9 && u1 <= p.u1 + 1e-9 && v0 >= p.z0 - 1e-9 && v1 <= p.z1 + 1e-9);
        if (!host) return;
        zone.windows.push({ name: `${host.name}:w${n}`, wall: host.name, face: k, index: w.index, width: w.u1 - w.u0, height: w.v1 - w.v0, azimuth: az, vertices: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map(turn) });
      });
    });
    // the ceiling: under the zones above where they overlap, a roof elsewhere
    for (const cell of cellsOf(z)) {
      for (const b of above) for (const o of intersect(cell, b)) add(zone, 'Ceiling', 'slab', flat(o, zone.z1, true));
      for (const r of subtract(cell, above)) add(zone, 'Roof', 'roof', flat(r, zone.z1, true));
    }
  });
  // each surface meeting another zone's paired with it; one left without (a near miss) stands alone, outside
  for (const list of pairs.values()) {
    if (list.length === 2 && list[0].name.split(':')[0] !== list[1].name.split(':')[0]) { list[0].partner = list[1].name; list[1].partner = list[0].name; continue; }
    for (const s of list) s.kind = s.type === 'Floor' ? 'exposed' : s.type === 'Wall' ? 'facade' : 'roof', s.type = s.type === 'Ceiling' ? 'Roof' : s.type;
  }
  return info;
}

// ---------- materials, assemblies and schedules ----------

// Assemblies listed outside (or top) first, as ClimateStudio draws them; a floor over a zone takes the
// slab's _FLIPPED twin, its ceiling the slab itself; a wall between zones the (symmetric) partition. Generic materials (conductivity W/m·K, density
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
  partition: ['Massing Interior Wall', ['Gypsum board 13mm', 'Mineral wool 120mm', 'Gypsum board 13mm']],
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
  m = upgradeMassing(m);
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
    const Z = zone.name, floorArea = zone.area;
    ep.Zone[Z] = { direction_of_relative_north: 0, x_origin: 0, y_origin: 0, z_origin: 0, type: 1, multiplier: 1, floor_area: floorArea, volume: floorArea * (zone.z1 - zone.z0), zone_inside_convection_algorithm: 'TARP', zone_outside_convection_algorithm: 'DOE-2' };
    for (const s of zone.surfaces) {
      const o = { surface_type: s.type, zone_name: Z, number_of_vertices: s.vertices.length, vertices: vertexList(s.vertices) };
      if (s.kind === 'ground') Object.assign(o, { construction_name: asm('ground'), outside_boundary_condition: 'Ground', sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else if (s.kind === 'inter') Object.assign(o, { construction_name: asm('partition'), outside_boundary_condition: 'Surface', outside_boundary_condition_object: s.partner, sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
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
  if (m.storeys) Object.assign(m, upgradeMassing(m)), delete m.storeys;
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

// Which window of which array a window of the written model is: its zone, face and place in the array
// (as massingGeometry numbers them), and the zone's floor level. null for a window the massing did not make.
export function massingWindow(m, name) {
  for (const zone of massingGeometry(m)) {
    const w = zone.windows.find((x) => x.name === name);
    if (w) return { zone: zone.zone, face: w.face, index: w.index, z0: zone.z0 };
  }
  return null;
}

// A window moved or resized in its wall (s along the wall to the right, z up, as edit.js's
// windowRect; `wallMid` the s of the face's middle) broken out of its array with that size and place.
export function breakOutWindow(m, name, r, wallMid) {
  const at = massingWindow(m, name);
  if (!at) return false;
  const g = m.zones[at.zone].faces[at.face], { first, pitch } = unitLayout(g, faceLength(m, at.zone, at.face));
  const mid = (r.s0 + r.s1) / 2 - wallMid;
  g.broken = { ...(g.broken || {}) };
  g.broken[at.index] = { ...unitOf(g, at.index), size: 'fixed', winW: +(r.s1 - r.s0).toFixed(3), winH: +(r.z1 - r.z0).toFixed(3), sill: +(r.z0 - at.z0).toFixed(3), offU: +(mid - (first + at.index * pitch)).toFixed(3) };
  return true;
}

// ---------- a face's windows, as the facade-windows skill edits them ----------
// A face's array stands in for the skill's system and its unit at once: winBy, winN and winSp set it
// out; winW, winH, sill, size and the edges' other forms (jamb, headGap, widthR, sillR, headR) are its
// window type. A broken window keeps a type of its own in broken[i], with offU along its bay.

// The length of face k of zone i, and the top of the zone's walls (under its slab).
export function faceLength(m, i, k) {
  const P = m.zones[i].plate, A = P[k], B = P[(k + 1) % P.length];
  return Math.hypot(B[0] - A[0], B[1] - A[1]);
}
const wallTop = (m, i) => { const h = zoneHeight(m, i); return Math.max(0.1, h - clamp(m.zones[i].slab ?? 0, 0, h - 0.1)); };
// A face's direction in plan (unit, building coordinates before the turn) and its outward normal.
export function faceAxes(m, i, k) {
  const P = m.zones[i].plate, A = P[k], B = P[(k + 1) % P.length], l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const U = [(B[0] - A[0]) / l, (B[1] - A[1]) / l];
  return { A, B, U, n: [U[1], -U[0]] };
}
// The compass word for the way a face looks: 'S', 'SE' ... from its outward normal, the building turned.
export function faceBearing(m, i, k) {
  const { n } = faceAxes(m, i, k);
  return (((Math.atan2(n[0], n[1]) * 180) / Math.PI + (m.rot || 0)) % 360 + 360) % 360;
}
export const compassWord = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
// The window type window i lays: its own when broken out, else the array's.
export function unitOf(g, i) {
  const b = g.broken?.[i], u = Object.fromEntries(UNIT_KEYS.filter((k) => k in g).map((k) => [k, g[k]]));
  return b ? { ...u, ...b } : u;
}
// Where window k's figures are measured from: its bay and the top of its wall.
export function windowContext(m, i, k) {
  const g = m.zones[i].faces[k], { pitch } = unitLayout(g, faceLength(m, i, k));
  return { pitch, top: wallTop(m, i), slab: m.zones[i].slab ?? 0 };
}
// A bare face given windows: one window in its middle, or a preset (punched, window wall, curtain wall).
export function addWindows(m, i, k, preset = null) {
  const z = m.zones[i], top = wallTop(m, i);
  if (preset) {
    const p = PRESETS[preset];
    z.faces[k] = { ...WINDOWS0(), winW: 1.5, winH: 1.8, sill: 0.9, ...p.sys, ...p.unit, broken: {} };
    delete z.faces[k].name;
    if (p.unit.size === 'offset') setSize(z.faces[k], 'offset', p.sys.winSp, top);
  } else {
    const winH = Math.max(0.6, Math.min(1.8, top - 0.9));
    z.faces[k] = { ...WINDOWS0(), winBy: 'number', winN: 1, winW: 1.5, winH, sill: 0.9 };
  }
}
// One window, or an array that repeats it at a spacing leaving wall between.
export const isArray = (g) => !!g && !(g.winBy !== 'spacing' && g.winN <= 1);
export function setArray(g, on) {
  if (on) Object.assign(g, { winBy: 'spacing', winSp: +Math.max(3, (g.winW || 1.5) + 1.2).toFixed(4) });
  else Object.assign(g, { winBy: 'number', winN: 1, broken: {} });
}
// Set out by number or by spacing, keeping the layout it has.
export function setBy(m, i, k, by) {
  const g = m.zones[i].faces[k];
  if (g.winBy === by) return;
  const lay = unitLayout(g, faceLength(m, i, k));
  g.winBy = by;
  if (by === 'number') g.winN = Math.max(1, lay.n); else g.winSp = +lay.pitch.toFixed(4);
}
export const setCount = (g, n) => Object.assign(g, { winBy: 'number', winN: clamp(Math.round(n), 1, 200) });
export const setSpacing = (g, sp) => Object.assign(g, { winBy: 'spacing', winSp: clamp(sp, 0.3, 60) });
// A window dragged along its face: the pitch the pointer implies (u from the face's middle), from the
// first window, or from the last when the first is dragged. By number, the nearest count.
export function dragPitch(m, i, k, idx, u) {
  const g = m.zones[i].faces[k], len = faceLength(m, i, k), { n, pitch, first, span } = unitLayout(g, len);
  if (n < 2) return;
  const last = first + (n - 1) * pitch, p = Math.max(0.3, idx > 0 ? (u - first) / idx : (last - u) / (n - 1));
  if (g.winBy !== 'spacing') g.winN = clamp(Math.round((span[1] - span[0]) / p), 1, 200); else g.winSp = Math.round(p / 0.05) * 0.05;
}
// An array's stretch set to run from a to b along its face (from the face's start), keeping its
// justification: its length, and its offset from the edge it is justified to. By spacing, its length
// is whole bays. A stretch the whole face long is the face again (no length of its own).
export function setArraySpan(m, i, k, a, b) {
  const g = m.zones[i].faces[k], len = faceLength(m, i, k);
  a = clamp(a, 0, len); b = clamp(b, 0, len);
  if (b < a) [a, b] = [b, a];
  let L = Math.max(0.3, b - a);
  if (g.winBy === 'spacing') { const n = Math.max(1, Math.round(L / g.winSp)); L = Math.min(n * g.winSp, len); }
  if (L >= len - 1e-6) { delete g.len; delete g.off; return; }
  a = clamp(a, 0, len - L);
  g.len = +L.toFixed(4);
  g.off = +(g.just === 'left' ? a : g.just === 'right' ? len - a - L : a + L / 2 - len / 2).toFixed(4);
}
// An array justified anew, its stretch kept where it is.
export function setJustify(m, i, k, just) {
  const g = m.zones[i].faces[k], len = faceLength(m, i, k), [a, b] = arraySpan(g, len);
  g.just = just;
  if (g.len > 0) g.off = +(just === 'left' ? a : just === 'right' ? len - b : (a + b) / 2 - len / 2).toFixed(4);
}
// The part of an array that stands on the stretch u0..u1 of its face (from the face's start), as an
// array of its own for that stretch as a face: the windows wholly on it keep their places (set out by
// spacing at the array's pitch, its bays from the first kept to the last, justified left of the new
// face), their broken-out types with them; none there, null. For a face split in two.
export function splitArray(g, len, u0, u1) {
  if (!g) return null;
  const { n, pitch, first } = unitLayout(g, len), keep = [];
  for (let j = 0; j < n; j++) {
    const c = first + j * pitch + len / 2, w = glassWidth(unitGlazing(g, j), pitch);
    if (c - w / 2 >= u0 - 1e-9 && c + w / 2 <= u1 + 1e-9) keep.push(j);
  }
  if (!keep.length) return null;
  const a = first + keep[0] * pitch + len / 2 - pitch / 2, b = first + keep[keep.length - 1] * pitch + len / 2 + pitch / 2;
  const s0 = clamp(a - u0, 0, u1 - u0), L = Math.min(b - a, u1 - u0 - s0);
  const out = { ...structuredClone(g), winBy: 'spacing', winSp: pitch, just: 'left', len: +L.toFixed(4), off: +s0.toFixed(4), broken: {} };
  keep.forEach((j, q) => { if (g.broken?.[j]) out.broken[q] = structuredClone(g.broken[j]); });
  if (Math.abs(L - (u1 - u0)) < 1e-6) { delete out.len; delete out.off; }
  return out;
}
// How the type's edges hold (Fixed, Offsets, Proportional), switched without moving the glass.
export function setWindowSize(m, i, k, w, mode) {
  const g = m.zones[i].faces[k], ctx = windowContext(m, i, k), u = g.broken?.[w] ? g.broken[w] : g;
  const was = legacy(u === g ? g : unitOf(g, w));
  if (u === g) { delete g.fillW; delete g.fillH; }
  const width = glassWidth(was, ctx.pitch), { sill, head } = windowHeights(was, ctx.top);
  Object.assign(u, { size: was.size || 'fixed', winW: width, sill, winH: head - sill });
  setSize(u, mode, ctx.pitch, ctx.top);
}
// One of window w's figures set ('winW', 'sill', 'head', 'winH', 'jamb', 'headGap', 'widthR', 'sillR',
// 'headR'): on its own type when broken out, else on the array's, so every window of it changes.
export function setWindowFigure(m, i, k, w, key, v) {
  const g = m.zones[i].faces[k], ctx = windowContext(m, i, k), u = g.broken?.[w] ? g.broken[w] : g;
  if (u === g && (g.fillW || g.fillH) && !g.size) setWindowSize(m, i, k, w, 'offset');
  setFigure(u, key, v, ctx);
}
// Broken out of its array: window w takes a copy of the array's type as its own.
export function breakWindow(g, w) { g.broken = { ...(g.broken || {}), [w]: { ...unitOf(g, w), offU: 0 } }; }
// Back into the array (revert); or its type given to the array (apply), the others broken out kept or
// bound back too.
export function revertWindow(g, w) { if (g.broken) delete g.broken[w]; }
export function applyToArray(g, w, others = 'keep') {
  const b = g.broken?.[w];
  if (!b) return;
  const { offU, ...unit } = b;
  for (const key of UNIT_KEYS) delete g[key];
  Object.assign(g, unit);
  delete g.fillW; delete g.fillH;
  delete g.broken[w];
  if (others === 'rebind') g.broken = {};
}
export const brokenOf = (g) => Object.keys(g?.broken || {}).map(Number).sort((a, b) => a - b);
// The links a zone keeps: its other faces follow face k (linkFaces), the zones stacked above it follow
// it (linkAbove) on their face looking the same way. After every edit to face k they take a copy of it.
export function spreadSide(m, i, k) {
  const z = m.zones[i], g = z.faces[k], to = [];
  if (z.linkFaces) z.plate.forEach((_, q) => { if (q !== k) to.push([i, q]); });
  if (z.linkAbove) {
    let below = [i];
    while (below.length) {
      const next = [];
      for (const b of below) {
        m.zones.forEach((y, j) => {
          if (y.base !== m.zones[b].top || !intersect(y.plate, m.zones[b].plate).length) return;
          next.push(j);
          if (z.linkFaces) y.plate.forEach((_, q) => to.push([j, q]));
          else {
            // its face looking the same way, nearest in line with this one
            const want = faceAxes(m, i, k), best = y.plate.map((_, q) => [q, faceAxes(m, j, q)]).filter(([, f]) => f.U[0] * want.U[0] + f.U[1] * want.U[1] > 0.999)
              .map(([q, f]) => [q, Math.abs((f.A[0] - want.A[0]) * want.n[0] + (f.A[1] - want.A[1]) * want.n[1])]).sort((a, b) => a[1] - b[1])[0];
            if (best) to.push([j, best[0]]);
          }
        });
      }
      below = next;
    }
  }
  for (const [j, q] of to) m.zones[j].faces[q] = g ? structuredClone(g) : null;
}

// ---------- zones added and split ----------

// A zone of `w` x `d` m added against face k of zone i, on its levels, the face's middle at `u` along it
// (from its start) where it fits: its own face against that face, out from it. Or stacked on zone i's
// roof (k 'roof'), centred at plate point `at`, its axes the zone's, from the zone's top level to the
// next one up (a new level `h` m higher when there is none). Its faces bare. Returns its index, or -1
// where it would overlap a zone on the same levels.
export function addZone(m, i, k, { u = null, at = null, w = 3, d = 3, h = 3 } = {}) {
  const z = m.zones[i];
  let plate, base = z.base, top = z.top;
  if (k === 'roof') {
    base = z.top;
    top = m.levels.findIndex((lv, L) => L > base);
    if (top < 0) { m.levels.push({ name: levelName(m.levels.length), z: +(m.levels[base].z + h).toFixed(6) }); top = m.levels.length - 1; }
    const c = at || centroid(z.plate);
    plate = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map((p) => { const [x, y] = turnPlan(p, z.rot || 0); return [R6(x + c[0]), R6(y + c[1])]; });
  } else {
    const { A, U, n } = faceAxes(m, i, k), len = faceLength(m, i, k), half = Math.min(w, len) / 2;
    const c = clamp(u ?? len / 2, half, len - half), a = [A[0] + U[0] * (c - half), A[1] + U[1] * (c - half)], b = [A[0] + U[0] * (c + half), A[1] + U[1] * (c + half)];
    // counterclockwise: out from the face, along, and back along it the other way
    plate = [a, [a[0] + n[0] * d, a[1] + n[1] * d], [b[0] + n[0] * d, b[1] + n[1] * d], b].map(([x, y]) => [R6(x), R6(y)]);
  }
  const lv = (L) => m.levels[L].z, overlaps = m.zones.some((y) => lv(y.base) < lv(top) - 1e-6 && lv(y.top) > lv(base) + 1e-6 && intersect(y.plate, plate).some((P) => Math.abs(polyArea(P)) > 1e-3));
  if (overlaps) return -1;
  m.zones.push({ name: null, base, top, rot: z.rot || 0, plate, faces: plate.map(() => null) });
  return m.zones.length - 1;
}

// Zone i cut in two by a vertical plane through plan points a and b (plate coordinates): the part to
// the left of a -> b stays zone i, the part to the right becomes a new zone on the same levels, with
// the same turn. Each face cut keeps, on each part, the windows wholly on that part (splitArray); the
// new faces along the cut are bare (they become the walls between the two). Returns the new zone's
// index, or -1 where the plane misses the zone or leaves a sliver.
export function splitZone(m, i, a, b) {
  const z = m.zones[i], d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return -1;
  const D = [d[0] / l, d[1] / l], N = [D[1], -D[0]], far = 1e4;
  const half = (side) => {
    const o = [a[0] - D[0] * far, a[1] - D[1] * far], e = [a[0] + D[0] * far, a[1] + D[1] * far], s = side * far;
    return [o, e, [e[0] - N[0] * s, e[1] - N[1] * s], [o[0] - N[0] * s, o[1] - N[1] * s]];
  };
  const left = intersect(z.plate, half(1)), right = intersect(z.plate, half(-1));
  if (left.length !== 1 || right.length !== 1 || Math.abs(polyArea(left[0])) < 0.5 || Math.abs(polyArea(right[0])) < 0.5) return -1;
  const facesOf = (P) => P.map((p, q) => {
    // the original face this edge lies on, and where along it: its windows carried over
    const r = P[(q + 1) % P.length];
    for (let k = 0; k < z.plate.length; k++) {
      const { A, U } = faceAxes(m, i, k), len = faceLength(m, i, k), off = (x) => (x[0] - A[0]) * U[1] - (x[1] - A[1]) * U[0], at = (x) => (x[0] - A[0]) * U[0] + (x[1] - A[1]) * U[1];
      if (Math.abs(off(p)) > 1e-4 || Math.abs(off(r)) > 1e-4) continue;
      const u0 = at(p), u1 = at(r);
      if (u1 <= u0 || u0 < -1e-4 || u1 > len + 1e-4) continue;
      return u0 < 1e-4 && u1 > len - 1e-4 ? structuredClone(z.faces[k]) : splitArray(z.faces[k], len, u0, u1);
    }
    return null;
  });
  const start = (P) => { // begin the footprint at the corner nearest where the old one began, so its faces keep their order
    const q = P.reduce((best, p, j) => (Math.hypot(p[0] - z.plate[0][0], p[1] - z.plate[0][1]) < Math.hypot(P[best][0] - z.plate[0][0], P[best][1] - z.plate[0][1]) ? j : best), 0);
    return [...P.slice(q), ...P.slice(0, q)].map(([x, y]) => [R6(x), R6(y)]);
  };
  const L = start(left[0]), R = start(right[0]);
  const fl = facesOf(L), fr = facesOf(R);
  m.zones.push({ ...structuredClone(z), name: null, plate: R, faces: fr, cells: undefined, linkFaces: false, linkAbove: false });
  Object.assign(z, { plate: L, faces: fl, cells: undefined });
  return m.zones.length - 1;
}

// A zone's re-entrant corners (inside angle over 180°): where a split can start. Plate points with the
// directions of the faces meeting there, pointing into the zone.
export function reentrantCorners(m, i) {
  const P = m.zones[i].plate, n = P.length, out = [];
  P.forEach((p, k) => {
    const a = P[(k - 1 + n) % n], b = P[(k + 1) % n], u = [p[0] - a[0], p[1] - a[1]], v = [b[0] - p[0], b[1] - p[1]];
    if (u[0] * v[1] - u[1] * v[0] >= -1e-9) return; // a right turn, counterclockwise, is a re-entrant corner
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    out.push({ k, p, dirs: [[u[0] / lu, u[1] / lu], [-v[0] / lv, -v[1] / lv]] });
  });
  return out;
}

// ---------- a zone's handles ----------

// A zone as the view draws its handles, in the model's coordinates (the building turned): its corners,
// floor and top levels, middle, own axes, and each face's middle and outward normal (faces by index,
// then 'roof', and 'floor' when it does not stand on the ground).
export function zoneFrame(m, i) {
  const z = m.zones[i], [z0, z1] = zoneLevels(m, i), B = m.rot || 0;
  const corners = z.plate.map((p) => turnPlan(p, B)), c = turnPlan(centroid(z.plate), B), axis = (v) => [...turnPlan(turnPlan(v, z.rot || 0), B), 0];
  const faces = corners.map((a, k) => {
    const b = corners[(k + 1) % corners.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { key: k, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (z0 + z1) / 2], normal: [(b[1] - a[1]) / d, -(b[0] - a[0]) / d, 0] };
  });
  faces.push({ key: 'roof', at: [c[0], c[1], z1], normal: [0, 0, 1] });
  if (z.base > 0) faces.push({ key: 'floor', at: [c[0], c[1], z0], normal: [0, 0, -1] });
  return { corners, z0, z1, centre: [c[0], c[1], (z0 + z1) / 2], x: axis([1, 0]), y: axis([0, 1]), faces };
}

// Level L moved by `dist` m, with every level above it (`above`) or alone, kept LEVEL_MIN from its
// neighbours. Returns the distance taken. The ground does not move.
export function moveLevel(m, L, dist, above = true) {
  if (L <= 0 || L >= m.levels.length) return 0;
  const lv = m.levels;
  dist = Math.max(dist, lv[L - 1].z + LEVEL_MIN - lv[L].z);
  if (!above && L + 1 < lv.length) dist = Math.min(dist, lv[L + 1].z - LEVEL_MIN - lv[L].z);
  for (let j = L; j < (above ? lv.length : L + 1); j++) lv[j].z = +(lv[j].z + dist).toFixed(6);
  return dist;
}

// A footprint with face k moved out by `dist` m along its normal, its neighbours keeping their lines;
// null when that would fold it or leave a face under EDGE_MIN.
function movedPlate(P, k, dist) {
  const n = P.length, A = P[k], B = P[(k + 1) % n], l = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const U = [(B[0] - A[0]) / l, (B[1] - A[1]) / l], N = [U[1], -U[0]];
  const A2 = [A[0] + N[0] * dist, A[1] + N[1] * dist], B2 = [B[0] + N[0] * dist, B[1] + N[1] * dist];
  // where the moved face's line meets a neighbour's (or, in line with it, just moved out)
  const meet = (p, q, fallback) => {
    const d = [q[0] - p[0], q[1] - p[1]], den = U[0] * d[1] - U[1] * d[0];
    if (Math.abs(den) < 1e-9) return fallback;
    const t = ((p[0] - A2[0]) * d[1] - (p[1] - A2[1]) * d[0]) / den;
    return [A2[0] + U[0] * t, A2[1] + U[1] * t];
  };
  const out = P.map((p) => [...p]);
  out[k] = meet(P[(k - 1 + n) % n], A, A2);
  out[(k + 1) % n] = meet(B, P[(k + 2) % n], B2);
  const ok = Math.sign(polyArea(out)) === Math.sign(polyArea(P)) && out.every((p, j) => Math.hypot(out[(j + 1) % n][0] - p[0], out[(j + 1) % n][1] - p[1]) >= EDGE_MIN - 1e-9);
  return ok ? out.map(([x, y]) => [R6(x), R6(y)]) : null;
}

// A face of zone i pushed or pulled by `dist` m along its outward normal: a face takes its edge of the
// footprint with it (its neighbours keep their lines), the roof moves the zone's top level and every
// level above, the floor moves its base level alone (the zones below grow or shrink to meet it).
// Returns the distance taken.
export function pushFace(m, i, face, dist) {
  const z = m.zones[i];
  if (face === 'roof') return moveLevel(m, z.top, dist, true);
  if (face === 'floor') return z.base > 0 ? -moveLevel(m, z.base, -dist, false) : 0;
  for (let t = dist, tries = 0; tries < 12; tries++, t /= 2) {
    const P = movedPlate(z.plate, face, t);
    if (P) { z.plate = P; return t; }
  }
  return 0;
}

// Zone i moved along its own x or y axis, or up ('z': its base level and every level above rise, the
// zones below growing to meet it).
export function moveStorey(m, i, axis, dist) {
  const z = m.zones[i];
  if (axis === 'z') return z.base > 0 ? moveLevel(m, z.base, dist, true) : 0;
  const [dx, dy] = turnPlan(axis === 'x' ? [1, 0] : [0, 1], z.rot || 0);
  const move = (P) => P.map(([x, y]) => [R6(x + dx * dist), R6(y + dy * dist)]);
  z.plate = move(z.plate);
  if (z.cells) z.cells = z.cells.map(move);
  return dist;
}

// Zone i turned to `deg` (clockwise, its own axes against the building's) about its middle.
export function turnZone(m, i, deg) {
  const z = m.zones[i], d = deg - (z.rot || 0), c = centroid(z.plate);
  z.plate = z.plate.map(([x, y]) => { const [u, v] = turnPlan([x - c[0], y - c[1]], d); return [R6(u + c[0]), R6(v + c[1])]; });
  if (z.cells) z.cells = z.cells.map((P) => P.map(([x, y]) => { const [u, v] = turnPlan([x - c[0], y - c[1]], d); return [R6(u + c[0]), R6(v + c[1])]; }));
  z.rot = deg;
}
