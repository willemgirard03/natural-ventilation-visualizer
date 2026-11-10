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
    id: i, name: s.name || null, base: i, top: i + 1, rot: s.rot || 0, plate: platePolygon(s), faces: SIDES.map((f) => s.sides?.[f] ?? null),
    slab: s.slab ?? 0, linkFaces: !!s.linkSides, linkAbove: !!s.linkAbove,
  }));
  const { storeys, ...rest } = m;
  return { ...rest, version: 2, levels, zones };
}

// A zone's floor and top elevations, and its height.
export const zoneLevels = (m, i) => [m.levels[m.zones[i].base].z, m.levels[m.zones[i].top].z];
export const zoneHeight = (m, i) => { const [a, b] = zoneLevels(m, i); return b - a; };
// A zone's name as written: its own or the massing's with its base level's number, and its index.
//   Its number is its own id, kept as zones are added, deleted and merged, so a zone keeps its name (and
// with it its settings in the model) whatever happens to the others; a zone without one goes by its place.
export const zoneName = (m, i) => { const z = m.zones[i]; return `${String(z.name || `${m.name || 'Floor'}${z.base + 1}`).replace(/[,;!]/g, ' ').trim()}_${z.id ?? i}`; };
// The id a new zone takes: one past the highest.
export const nextZoneId = (m) => m.zones.reduce((a, z, i) => Math.max(a, (z.id ?? i) + 1), 0);

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
// Generic assemblies, one for each kind of surface, of a single unspecified material at a default
// thickness: what drawn walls, and the zones they enclose, take until their assemblies are set (the
// model checks name them). The material's figures are placeholders: conductivity giving a middling
// RSI for its kind (W/m·K), density and specific heat of a medium-weight build.
const UNSPECIFIED = {
  'Unspecified wall 300mm': [0.3, 0.1, 1000, 1000], 'Unspecified partition 150mm': [0.15, 0.3, 1000, 1000],
  'Unspecified roof 300mm': [0.3, 0.06, 1000, 1000], 'Unspecified floor 300mm': [0.3, 0.3, 1000, 1000],
  'Unspecified ground slab 300mm': [0.3, 0.15, 1000, 1000], 'Unspecified exposed floor 300mm': [0.3, 0.1, 1000, 1000],
};
export const GENERIC_ASSEMBLIES = {
  facade: ['Generic Exterior Wall', ['Unspecified wall 300mm']],
  roof: ['Generic Roof', ['Unspecified roof 300mm']],
  slab: ['Generic Floor', ['Unspecified floor 300mm']],
  ground: ['Generic Ground Slab', ['Unspecified ground slab 300mm']],
  exposed: ['Generic Exposed Floor', ['Unspecified exposed floor 300mm']],
  partition: ['Generic Interior Wall', ['Unspecified partition 150mm']],
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
  for (const [n, [t, k, rho, c]] of Object.entries({ ...MATERIALS, ...UNSPECIFIED })) {
    ep.Material[n] = { roughness: 'MediumRough', thickness: t, conductivity: k, density: rho, specific_heat: c, thermal_absorptance: 0.9, solar_absorptance: 0.7, visible_absorptance: 0.7 };
  }
  const construction = (name, layers) => {
    ep.Construction[name] = Object.fromEntries(layers.map((l, i) => [LAYER_FIELDS[i], l]));
    ep.Construction[`${name}_FLIPPED`] = Object.fromEntries([...layers].reverse().map((l, i) => [LAYER_FIELDS[i], l]));
  };
  for (const [name, layers] of [...Object.values(MASSING_ASSEMBLIES), ...Object.values(GENERIC_ASSEMBLIES)]) construction(name, layers);
  // drawn walls' own assemblies, where they name one the model has (from ep, carried over)
  for (const w of m.walls || []) if (w.asm && !ep.Construction[w.asm] && from?.Construction?.[w.asm]) ep.Construction[w.asm] = structuredClone(from.Construction[w.asm]);
  ep['WindowMaterial:SimpleGlazingSystem'][MASSING_GLAZING[0]] = { ...MASSING_GLAZING[1] };
  construction(MASSING_GLAZING[0], [MASSING_GLAZING[0]]);

  // a zone enclosed by drawn walls takes the generic assemblies; a wall on a drawn wall, that wall's
  const asmOf = (zone) => (kind) => ((m.zones[zone.zone]?.generic ? GENERIC_ASSEMBLIES : MASSING_ASSEMBLIES)[kind][0]);
  for (const zone of zones) {
    const asm0 = asmOf(zone);
    const asm = (kind, s) => {
      if (s?.type === 'Wall' && (kind === 'facade' || kind === 'partition')) { const w = wallFor(m, zone.zone, s.face); if (w?.asm && ep.Construction[w.asm]) return w.asm; }
      return asm0(kind);
    };
    const Z = zone.name, floorArea = zone.area;
    ep.Zone[Z] = { direction_of_relative_north: 0, x_origin: 0, y_origin: 0, z_origin: 0, type: 1, multiplier: 1, floor_area: floorArea, volume: floorArea * (zone.z1 - zone.z0), zone_inside_convection_algorithm: 'TARP', zone_outside_convection_algorithm: 'DOE-2' };
    for (const s of zone.surfaces) {
      const o = { surface_type: s.type, zone_name: Z, number_of_vertices: s.vertices.length, vertices: vertexList(s.vertices) };
      if (s.kind === 'ground') Object.assign(o, { construction_name: asm('ground'), outside_boundary_condition: 'Ground', sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else if (s.kind === 'inter') Object.assign(o, { construction_name: asm('partition', s), outside_boundary_condition: 'Surface', outside_boundary_condition_object: s.partner, sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else if (s.kind === 'slab') Object.assign(o, { construction_name: s.type === 'Floor' ? `${asm('slab')}_FLIPPED` : asm('slab'), outside_boundary_condition: 'Surface', outside_boundary_condition_object: s.partner, sun_exposure: 'NoSun', wind_exposure: 'NoWind', view_factor_to_ground: 0 });
      else Object.assign(o, { construction_name: asm(s.kind, s), outside_boundary_condition: 'Outdoors', sun_exposure: 'SunExposed', wind_exposure: 'WindExposed', view_factor_to_ground: 'Autocalculate' });
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
  // a zone new to the model split from another (copyFrom: that zone's name as written) takes its
  // settings: its loads, outdoor air, opening controls and, surface by surface, its assemblies
  const copies = {};
  m.zones.forEach((z, i) => { const Z = zoneName(m, i); if (z.copyFrom && !ep.Zone?.[Z] && ep.Zone?.[z.copyFrom]) copies[Z] = z.copyFrom; });
  for (const [Z, S] of Object.entries(copies)) if (vent[S]) vent[Z] = vent[S];
  const assemblyFrom = (S, o) => Object.values(ep['BuildingSurface:Detailed'] || {}).find((x) => x.zone_name === S && x.surface_type === o.surface_type && x.outside_boundary_condition === o.outside_boundary_condition)?.construction_name;
  for (const type of GEOMETRY) {
    for (const n of Object.keys(ep[type] || {})) if (!fresh[type]?.[n]) tx.remove(type, n);
    for (const [n, o] of Object.entries(fresh[type] || {})) {
      const old = ep[type]?.[n], next = structuredClone(o);
      if (old && (type === 'BuildingSurface:Detailed' ? old.surface_type === o.surface_type && old.outside_boundary_condition === o.outside_boundary_condition : type === 'FenestrationSurface:Detailed')) next.construction_name = old.construction_name;
      else if (!old && type === 'BuildingSurface:Detailed' && copies[o.zone_name]) next.construction_name = assemblyFrom(copies[o.zone_name], o) ?? next.construction_name;
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
  for (const [Z, S] of Object.entries(copies)) {
    for (const type of ['People', 'Lights', 'ElectricEquipment', 'ZoneInfiltration:DesignFlowRate']) {
      const src = Object.values(ep[type] || {}).find((o) => zoneField(o) === S), mine = Object.keys(fresh[type] || {}).find((n) => zoneField(fresh[type][n]) === Z);
      if (!src || !mine) continue;
      const t = tx.get(type, mine), key = Object.keys(t).find((k) => t[k] === Z);
      Object.assign(t, structuredClone(src), { [key]: Z });
    }
    const oa = ep['DesignSpecification:OutdoorAir']?.[`${S}MinFreshAir`];
    if (oa && ep['DesignSpecification:OutdoorAir'][`${Z}MinFreshAir`]) Object.assign(tx.get('DesignSpecification:OutdoorAir', `${Z}MinFreshAir`), structuredClone(oa));
  }
  for (const z of m.zones) delete z.copyFrom;
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
  m.zones.push({ id: nextZoneId(m), name: null, base, top, rot: z.rot || 0, plate, faces: plate.map(() => null) });
  return m.zones.length - 1;
}

// Zone i cut in two by a vertical plane through plan points a and b (plate coordinates): the part to
// the left of a -> b stays zone i, the part to the right becomes a new zone on the same levels, with
// the same turn. Each face cut keeps, on each part, the windows wholly on that part (splitArray); the
// new faces along the cut are bare (they become the walls between the two). Returns the new zone's
// index, or -1 where the plane misses the zone or leaves a sliver.
//   From a corner (`fromCorner`: a is one of its corners, b along the cut), the cut runs only from that
// corner to the first face it meets, not on through the rest of the zone.
//   From a face (`fromFace`: a on it), likewise from there to the first face the cut meets; from inside
// (`within`: a in the zone, as on its roof), both ways from a to the faces the cut meets.
export function splitZone(m, i, a, b, { fromCorner = false, fromFace = false, within = false } = {}) {
  const z = m.zones[i], d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return -1;
  const D = [d[0] / l, d[1] / l], N = [D[1], -D[0]], far = 1e4;
  let left, right;
  if (fromCorner || fromFace || within) {
    let P = z.plate, from = a;
    if (within) {
      // back along the cut to the face behind the point: the cut starts there
      const back = rayExit(P, a, [-D[0], -D[1]]);
      if (!back) return -1;
      from = back.pt;
    }
    if (!P.some((p) => Math.hypot(p[0] - from[0], p[1] - from[1]) < 1e-6)) P = withPoint(P, from);
    const parts = P && chordSplit(P, from, D);
    if (!parts) return -1;
    [left, right] = parts.map((Q) => [Q]);
  } else {
    const half = (side) => {
      const o = [a[0] - D[0] * far, a[1] - D[1] * far], e = [a[0] + D[0] * far, a[1] + D[1] * far], s = side * far;
      return [o, e, [e[0] - N[0] * s, e[1] - N[1] * s], [o[0] - N[0] * s, o[1] - N[1] * s]];
    };
    left = intersect(z.plate, half(1)); right = intersect(z.plate, half(-1));
  }
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
  m.zones.push({ ...structuredClone(z), id: nextZoneId(m), name: null, plate: R, faces: fr, cells: undefined, linkFaces: false, linkAbove: false, copyFrom: zoneName(m, i) });
  Object.assign(z, { plate: L, faces: fl, cells: undefined });
  return m.zones.length - 1;
}

// Where a ray from a along D first leaves a footprint: the point and the face (index), passing over the
// faces a lies on. null when it meets none.
function rayExit(P, a, D) {
  const n = P.length;
  let best = null;
  for (let k = 0; k < n; k++) {
    const p = P[k], q = P[(k + 1) % n], e = [q[0] - p[0], q[1] - p[1]], den = D[0] * e[1] - D[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w = [p[0] - a[0], p[1] - a[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * D[1] - w[1] * D[0]) / den;
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && (!best || t < best.t)) best = { t, k, pt: [R6(a[0] + D[0] * t), R6(a[1] + D[1] * t)] };
  }
  return best;
}
// A footprint with point x put in as a corner on the face it lies on; null when it lies on none.
function withPoint(P, x) {
  const n = P.length;
  for (let k = 0; k < n; k++) {
    const p = P[k], q = P[(k + 1) % n], e = [q[0] - p[0], q[1] - p[1]], l2 = e[0] ** 2 + e[1] ** 2, u = ((x[0] - p[0]) * e[0] + (x[1] - p[1]) * e[1]) / (l2 || 1);
    if (u <= 1e-9 || u >= 1 - 1e-9) continue;
    if (Math.hypot(p[0] + e[0] * u - x[0], p[1] + e[1] * u - x[1]) < 1e-6) return [...P.slice(0, k + 1), [R6(x[0]), R6(x[1])], ...P.slice(k + 1)];
  }
  return null;
}
// A footprint cut from its corner at `a` along D to the first face the cut meets: the two outlines, or
// null when `a` is not a corner of it or the cut leaves it at once.
function chordSplit(P, a, D) {
  const n = P.length, ia = P.findIndex((p) => Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-6);
  if (ia < 0) return null;
  let best = null;
  for (let k = 0; k < n; k++) {
    if (k === ia || (k + 1) % n === ia) continue; // the faces from the corner itself
    const p = P[k], q = P[(k + 1) % n], e = [q[0] - p[0], q[1] - p[1]], den = D[0] * e[1] - D[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w = [p[0] - a[0], p[1] - a[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * D[1] - w[1] * D[0]) / den;
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && (!best || t < best.t)) best = { t, k, s };
  }
  if (!best) return null;
  // the cut must run inside: its middle within the footprint
  const mid = [a[0] + D[0] * best.t / 2, a[1] + D[1] * best.t / 2];
  if (!pc.intersection(geom(P), [[[mid[0] - 1e-3, mid[1] - 1e-3], [mid[0] + 1e-3, mid[1] - 1e-3], [mid[0] + 1e-3, mid[1] + 1e-3], [mid[0] - 1e-3, mid[1] + 1e-3]]]).length) return null;
  const q = [R6(a[0] + D[0] * best.t), R6(a[1] + D[1] * best.t)], walk = (from, to) => { const out = []; for (let j = from; ; j = (j + 1) % n) { out.push(P[j]); if (j === to) break; } return out; };
  const atStart = best.s < 1e-6, atEnd = best.s > 1 - 1e-6, k1 = (best.k + 1) % n;
  // one part: the corner round to the face met, then the point met; the other: from there back round
  const one = [...walk(ia, best.k), ...(atStart ? [] : [q])], two = [...(atEnd ? [] : [q]), ...walk(k1, ia)];
  return [one, two].map((R) => R.filter((p, j) => Math.hypot(p[0] - R[(j + 1) % R.length][0], p[1] - R[(j + 1) % R.length][1]) > 1e-9));
}

// Face k of zone i split at u m from its start: a seam there, two faces in line where there was one,
// each keeping the windows wholly on it where they were (splitArray). False when too near an end.
export function splitFace(m, i, k, u) {
  const z = m.zones[i], len = faceLength(m, i, k);
  if (u < EDGE_MIN - 1e-9 || u > len - EDGE_MIN + 1e-9) return false;
  const { A, U } = faceAxes(m, i, k), g = z.faces[k];
  z.plate.splice(k + 1, 0, [R6(A[0] + U[0] * u), R6(A[1] + U[1] * u)]);
  z.faces.splice(k, 1, splitArray(g, len, 0, u), splitArray(g, len, u, len));
  return true;
}

// Face k of zone i pushed out (or in, d < 0) by d m, square to itself, as a push/pull tool does: where
// it meets a face in line with it (a seam), it steps out from there, a new face joining the two, so the
// footprint becomes an L (or a notch); where it meets a corner, the face beside it stretches to meet it.
// Pushed back level with a face it stepped from, the face between them goes and the two are in line
// again (a seam): within EDGE_MIN of that it snaps there. The face keeps its windows; the new faces are
// bare. The footprint only (geometry checks; zoneFits says whether it may stand). False where it would
// fold, cross itself or leave a face under EDGE_MIN.
function extrudeRaw(m, i, k, d) {
  if (Math.abs(d) < 1e-6) return false;
  const z = m.zones[i], P = z.plate, n = P.length, { U, n: N } = faceAxes(m, i, k);
  const a = P[k], b = P[(k + 1) % n], prev = P[(k - 1 + n) % n], next = P[(k + 2) % n];
  const inLine = (p, q, r) => Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) < 1e-6 * Math.max(1, Math.hypot(r[0] - p[0], r[1] - p[1]));
  // level with the far end of a face square to this one beside it: snap there, and that face goes
  for (const [q, c] of [[prev, a], [next, b]]) {
    const e = [c[0] - q[0], c[1] - q[1]], l = Math.hypot(...e) || 1;
    if (Math.abs((e[0] * U[0] + e[1] * U[1]) / l) > 1e-6) continue; // not square to the face
    const flush = (q[0] - c[0]) * N[0] + (q[1] - c[1]) * N[1];
    if (Math.abs(d - flush) < EDGE_MIN) d = flush;
  }
  const a2 = [a[0] + N[0] * d, a[1] + N[1] * d], b2 = [b[0] + N[0] * d, b[1] + N[1] * d];
  // where the moved face's line meets the line p -> q
  const meet = (p, q) => {
    const e = [q[0] - p[0], q[1] - p[1]], den = U[0] * e[1] - U[1] * e[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p[0] - a2[0]) * e[1] - (p[1] - a2[1]) * e[0]) / den;
    return [a2[0] + U[0] * t, a2[1] + U[1] * t];
  };
  let ring = []; // [corner, the face from it to the next]
  for (let j = 0; j < n; j++) {
    if (j === k) {
      if (inLine(prev, a, b)) ring.push([a, null], [a2, z.faces[k]]);
      else { const p = meet(prev, a); if (!p) return false; ring.push([p, z.faces[k]]); }
    } else if (j === (k + 1) % n) {
      if (inLine(a, b, next)) ring.push([b2, null], [b, z.faces[j]]);
      else { const p = meet(b, next); if (!p) return false; ring.push([p, z.faces[j]]); }
    } else ring.push([P[j], z.faces[j]]);
  }
  ring = ring.map(([p, f]) => [[R6(p[0]), R6(p[1])], f]);
  // a face shrunk to nothing goes; the corner after it keeps the face that followed
  for (let again = true; again && ring.length > 3;) {
    again = false;
    for (let j = 0; j < ring.length; j++) {
      const q = ring[(j + 1) % ring.length];
      if (Math.hypot(q[0][0] - ring[j][0][0], q[0][1] - ring[j][0][1]) < 1e-6) { ring[j] = [ring[j][0], q[1]]; ring.splice((j + 1) % ring.length, 1); again = true; break; }
    }
  }
  const plate = ring.map(([p]) => p);
  if (!simpleOutline(plate, P)) return false;
  z.plate = plate;
  z.faces = ring.map(([, f]) => f);
  if (z.cells) delete z.cells;
  return true;
}
// An outline that may stand: as counterclockwise as the one it replaces, each face at least EDGE_MIN,
// and simple (polygon-clipping finds it one piece of the same area: it does not cross itself).
function simpleOutline(plate, was = plate) {
  if (plate.length < 3 || Math.sign(polyArea(plate)) !== Math.sign(polyArea(was))) return false;
  if (!plate.every((p, j) => Math.hypot(plate[(j + 1) % plate.length][0] - p[0], plate[(j + 1) % plate.length][1] - p[1]) >= EDGE_MIN - 1e-9)) return false;
  // no corner where the outline turns straight back on itself (a spike of no width)
  const n = plate.length;
  for (let j = 0; j < n; j++) {
    const a = plate[(j - 1 + n) % n], c = plate[j], b = plate[(j + 1) % n], u = [c[0] - a[0], c[1] - a[1]], v = [b[0] - c[0], b[1] - c[1]];
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * Math.hypot(...u) * Math.hypot(...v) && u[0] * v[0] + u[1] * v[1] < 0) return false;
  }
  let one;
  try { one = pieces(pc.union(geom(plate))); } catch { return false; }
  return one.length === 1 && Math.abs(Math.abs(polyArea(one[0])) - Math.abs(polyArea(plate))) < 1e-6;
}

// ---------- what may stand: zones never overlapping, always in touch ----------

const levelsOf = (m, z) => [m.levels[z.base].z, m.levels[z.top].z];
// Whether two zones on overlapping levels overlap in plan (more than a sliver).
function overlapping(m, a, b) {
  const [a0, a1] = levelsOf(m, a), [b0, b1] = levelsOf(m, b);
  if (a0 >= b1 - 1e-6 || a1 <= b0 + 1e-6) return false;
  return intersect(a.plate, b.plate).some((Q) => Math.abs(polyArea(Q)) > 1e-3);
}
// Whether two zones touch: one stands on the other where their footprints overlap, or a face of one
// runs along a face of the other, back to back, over some length, on levels they share.
export function touching(m, a, b) {
  if (a.top === b.base || a.base === b.top) return intersect(a.plate, b.plate).some((Q) => Math.abs(polyArea(Q)) > 1e-3);
  const [a0, a1] = levelsOf(m, a), [b0, b1] = levelsOf(m, b);
  if (a0 >= b1 - 1e-6 || a1 <= b0 + 1e-6) return false;
  return a.plate.some((A, k) => {
    const B = a.plate[(k + 1) % a.plate.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]), U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const off = (p) => (p[0] - A[0]) * U[1] - (p[1] - A[1]) * U[0], at = (p) => (p[0] - A[0]) * U[0] + (p[1] - A[1]) * U[1];
    return b.plate.some((C, q) => {
      const D = b.plate[(q + 1) % b.plate.length];
      if (Math.abs(off(C)) > 1e-4 || Math.abs(off(D)) > 1e-4) return false;
      const uc = at(C), ud = at(D);
      return ud < uc && Math.min(len, uc) - Math.max(0, ud) > 0.05;
    });
  });
}
// Whether zone i may stand as it is: a simple footprint, overlapping no zone on its levels. It may
// float (held up by nothing): such zones are shown hatched (floatingZones), not refused.
export function zoneFits(m, i) {
  const z = m.zones[i];
  if (!simpleOutline(z.plate)) return false;
  return !m.zones.some((y, j) => j !== i && overlapping(m, z, y));
}
// The zones held up by nothing: not standing on the ground, nor joined to it through zones they touch.
export function floatingZones(m) {
  const held = new Set(m.zones.map((z, i) => (z.base === 0 ? i : -1)).filter((i) => i >= 0)), todo = [...held];
  while (todo.length) {
    const i = todo.pop();
    m.zones.forEach((y, j) => { if (!held.has(j) && touching(m, m.zones[i], y)) { held.add(j); todo.push(j); } });
  }
  return m.zones.map((_, i) => i).filter((i) => !held.has(i));
}
// A change to zone i made as far as it can go: `act(trial, x)` makes it on a copy, for x the change
// asked for, scaled back (to a millimetre) until zone i fits - so a move stops where the zone would
// collide, cross itself or come away from the building. Returns the change made.
function limited(m, i, x, act) {
  const ids = Array.isArray(i) ? i : [i];
  const scale = (t) => (Array.isArray(x) ? x.map((v) => v * t) : x * t);
  const tryAt = (t) => { const trial = structuredClone(m); return act(trial, scale(t)) !== false && ids.every((j) => zoneFits(trial, j)) ? trial : null; };
  let best = tryAt(1), bt = 1;
  if (!best) {
    let lo = 0, hi = 1;
    bt = 0;
    const size = Array.isArray(x) ? Math.hypot(...x) : Math.abs(x);
    for (let n = 0; n < 24 && (hi - lo) * size > 5e-4; n++) {
      const mid = (lo + hi) / 2, t = tryAt(mid);
      if (t) { lo = mid; best = t; bt = mid; } else hi = mid;
    }
  }
  if (!best) return Array.isArray(x) ? [0, 0] : 0;
  m.levels = best.levels; m.zones = best.zones;
  return scale(bt);
}
// The pushed face, as far as it may go. Returns the distance taken.
export function extrudeFace(m, i, k, d) { return limited(m, i, d, (x, v) => extrudeRaw(x, i, k, v)); }

// The faces of other zones that share face k of zone i: in line with it, facing the other way, along
// some of its length, on levels it stands on too. [[zone, face], ...]
export function sharingFaces(m, i, k) {
  const P = m.zones[i].plate, a = P[k], b = P[(k + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const U = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], off = (p) => (p[0] - a[0]) * U[1] - (p[1] - a[1]) * U[0], along = (p) => (p[0] - a[0]) * U[0] + (p[1] - a[1]) * U[1];
  const [z0, z1] = levelsOf(m, m.zones[i]), out = [];
  m.zones.forEach((y, j) => {
    if (j === i) return;
    const [y0, y1] = levelsOf(m, y);
    if (Math.min(z1, y1) - Math.max(z0, y0) < 1e-6) return;
    y.plate.forEach((c, q) => {
      const d = y.plate[(q + 1) % y.plate.length];
      if (Math.abs(off(c)) > 1e-6 || Math.abs(off(d)) > 1e-6) return;
      const s0 = along(c), s1 = along(d);
      if (s1 >= s0) return; // running the same way: not facing it
      if (Math.min(L, s0) - Math.max(0, s1) > 1e-6) out.push([j, q]);
    });
  });
  return out;
}
// A wall moved square to itself by d (out of zone i), with every zone sharing it: the wall between two
// zones moves for both, one growing as the other shrinks. As far as they all may go; returns the
// distance taken.
export function pushWall(m, i, k, d) {
  const share = sharingFaces(m, i, k);
  if (!share.length) return extrudeFace(m, i, k, d);
  return limited(m, [i, ...share.map(([j]) => j)], d, (x, v) => extrudeRaw(x, i, k, v) !== false && share.every(([j, q]) => extrudeRaw(x, j, q, -v) !== false));
}

// A seam (corner v of zone i, between two faces in line) slid along them by du m: one face longer, the
// other shorter, as far as each stays EDGE_MIN long. Returns the distance taken.
export function slideSeam(m, i, v, du) {
  return limited(m, i, du, (x, t) => {
    const P = x.zones[i].plate, n = P.length, a = P[(v - 1 + n) % n], c = P[v], b = P[(v + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), U = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    if (Math.abs((c[0] - a[0]) * U[1] - (c[1] - a[1]) * U[0]) > 1e-6) return false; // not a seam
    P[v] = [R6(c[0] + U[0] * t), R6(c[1] + U[1] * t)];
  });
}
export const isSeam = (m, i, v) => {
  const P = m.zones[i].plate, n = P.length, a = P[(v - 1 + n) % n], c = P[v], b = P[(v + 1) % n];
  return Math.abs((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) < 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
};

// Zone i taken out of the massing; its levels stay, empty or not (a level is removed from the Levels
// tab). The last zone stays.
export function deleteZone(m, i) {
  if (m.zones.length < 2) return false;
  m.zones.splice(i, 1);
  return true;
}

// ---------- levels, as the shading tool's storey stack (the storey-stack skill) ----------
// Storey s is the space from level s up to level s + 1; the top level has none above it. Levels are
// kept as elevations, but every rule here works on heights: a storey put in lifts everything above it
// by its height, one taken out drops it.

export const STOREYS_MAX = 40;
const heightOf = (m, s) => m.levels[s + 1].z - m.levels[s].z;
// Levels still called by their number ("Level 3") renumbered after the stack changes; named ones keep
// their names. Names travel with the storey standing on the level, as plan views do (m.views: each plan
// view's `level`).
const DEFAULT_NAME = /^Level \d+$/;
function renumber(m) { m.levels.forEach((lv, L) => { if (!lv.name || DEFAULT_NAME.test(lv.name)) lv.name = levelName(L); }); }
const planViews = (m) => (m.views || []).filter((v) => v.kind === 'plan' && Number.isInteger(v.level));
// A storey put in above storey s (or below it), as tall as storey s (the storey under the top level
// where s is the top level). Blank: no zones; a copy: storey s's own zones (those standing on level s
// and reaching level s + 1) copied into it, taking their settings. Zones running through where it goes
// in grow by its height. Returns the new storey's index.
export function insertStorey(m, s, where = 'above', copy = false) {
  if (m.levels.length > STOREYS_MAX) return -1;
  const top = m.levels.length - 1, src = Math.max(0, Math.min(s, top - 1)), h = top > 0 ? heightOf(m, src) : 3;
  const at = Math.min(where === 'below' ? s : s + 1, top); // the new storey's index: from level `at` up
  const own = m.zones.filter((z) => z.base === src && z.top === src + 1);
  const H = m.levels.slice(1).map((lv, L) => lv.z - m.levels[L].z);
  H.splice(at, 0, h);
  // the storey from level `at` up, its name and its plans, moves up a level; level `at` is the new one
  const names = m.levels.map((lv) => lv.name), nAt = at === top ? top + 1 : at; // on top: a new top level
  names.splice(nAt, 0, levelName(nAt));
  m.levels.splice(at + 1, 0, { name: '', z: 0 });
  m.levels.forEach((lv, L) => { lv.name = names[L]; if (L > 0) lv.z = +(m.levels[L - 1].z + H[L - 1]).toFixed(6); });
  for (const z of [...m.zones, ...(m.walls || [])]) { if (z.base >= at) z.base++; if (z.top > at) z.top++; }
  for (const v of planViews(m)) if (v.level >= nAt) v.level++;
  renumber(m);
  if (copy) for (const z of own) m.zones.push({ ...structuredClone(z), id: nextZoneId(m), name: null, base: at, top: at + 1, copyFrom: zoneName(m, m.zones.indexOf(z)) });
  if (copy) for (const w of (m.walls || []).filter((x) => x.base === src + (src >= at ? 1 : 0) && x.top === src + 1 + (src >= at ? 1 : 0))) m.walls.push({ ...structuredClone(w), id: nextWallId(m), base: at, top: at + 1 });
  return at;
}
// Storey s and the one above it trade places, each taking its zones; their heights travel with them.
// Not where a zone runs through either of them into another.
export function swapStoreys(m, s) {
  if (s < 0 || s + 2 >= m.levels.length) return false;
  if (m.zones.some((z) => (z.base <= s && z.top > s + 1) || (z.base < s + 1 && z.top > s + 1 && !(z.base === s && z.top === s + 1)) || (z.base <= s + 1 && z.top > s + 2))) return false;
  const h0 = heightOf(m, s), h1 = heightOf(m, s + 1);
  for (const z of [...m.zones, ...(m.walls || [])]) {
    if (z.base === s && z.top === s + 1) { z.base = s + 1; z.top = s + 2; } else if (z.base === s + 1 && z.top === s + 2) { z.base = s; z.top = s + 1; }
  }
  m.levels[s + 1].z = +(m.levels[s].z + h1).toFixed(6);
  m.levels[s + 2].z = +(m.levels[s + 1].z + h0).toFixed(6);
  [m.levels[s].name, m.levels[s + 1].name] = [m.levels[s + 1].name, m.levels[s].name];
  for (const v of planViews(m)) if (v.level === s || v.level === s + 1) v.level = 2 * s + 1 - v.level;
  renumber(m);
  return true;
}
// Storey s taken out: its zones go, zones running through it lose its height, and everything above
// drops by its height. Never the last storey.
export function removeStorey(m, s) {
  if (m.levels.length <= 2 || s < 0 || s + 1 >= m.levels.length) return false;
  const h = heightOf(m, s);
  m.zones = m.zones.filter((z) => !(z.base === s && z.top === s + 1));
  if (m.walls) m.walls = m.walls.filter((w) => !(w.base === s && w.top === s + 1));
  for (const z of [...m.zones, ...(m.walls || [])]) { if (z.base > s) z.base--; if (z.top > s) z.top--; }
  // level s now carries the storey that stood on level s + 1, with its name; the removed storey's plans go
  if (s + 2 < m.levels.length) m.levels[s].name = m.levels[s + 1].name;
  if (m.views) m.views = m.views.filter((v) => !(v.kind === 'plan' && v.level === s && s + 2 < m.levels.length));
  for (const v of planViews(m)) if (v.level > s) v.level--;
  m.levels.splice(s + 1, 1);
  renumber(m);
  for (let L = s + 1; L < m.levels.length; L++) m.levels[L].z = +(m.levels[L].z - h).toFixed(6);
  return m.zones.length > 0;
}

// ---------- merging zones and faces, removing seams ----------

// The window arrays a new outline P takes from the faces of zones `from` it lies along: each edge the
// array of the face it overlaps most (the larger face's, where it spans several), set out on the new
// edge with its windows where they were (splitArray); the whole face's own where it is that face.
function carryArrays(m, from, P) {
  return P.map((p, q) => {
    const r = P[(q + 1) % P.length];
    let best = null;
    for (const i of from) {
      m.zones[i].plate.forEach((_, k) => {
        const { A, U } = faceAxes(m, i, k), len = faceLength(m, i, k), off = (x) => (x[0] - A[0]) * U[1] - (x[1] - A[1]) * U[0], at = (x) => (x[0] - A[0]) * U[0] + (x[1] - A[1]) * U[1];
        if (Math.abs(off(p)) > 1e-4 || Math.abs(off(r)) > 1e-4) return;
        const u0 = at(p), u1 = at(r), ov = Math.min(len, u1) - Math.max(0, u0);
        if (u1 > u0 && ov > 1e-6 && (!best || ov > best.ov)) best = { ov, g: m.zones[i].faces[k], len, u0, u1 };
      });
    }
    if (!best?.g) return null;
    return Math.abs(best.u0) < 1e-4 && Math.abs(best.u1 - best.len) < 1e-4 ? structuredClone(best.g) : splitArray(best.g, best.len, best.u0, best.u1);
  });
}
// An outline with every point of `pts` lying along one of its faces (not at its corners) put in as a
// corner: the seams where the faces of what was merged met.
function withSeams(P, pts) {
  const out = [];
  P.forEach((p, k) => {
    const q = P[(k + 1) % P.length], e = [q[0] - p[0], q[1] - p[1]], l2 = e[0] ** 2 + e[1] ** 2;
    out.push(p);
    const on = pts.map((x) => [x, ((x[0] - p[0]) * e[0] + (x[1] - p[1]) * e[1]) / (l2 || 1)])
      .filter(([x, u]) => u > 1e-6 && u < 1 - 1e-6 && Math.hypot(p[0] + e[0] * u - x[0], p[1] + e[1] * u - x[1]) < 1e-6)
      .sort((a, b) => a[1] - b[1]);
    for (const [x] of on) if (!out.some((y) => Math.hypot(y[0] - x[0], y[1] - x[1]) < 1e-6)) out.push([R6(x[0]), R6(x[1])]);
  });
  return out;
}
// Zones merged into the first of `list`: one zone over all their footprints, with the first's settings
// (its id, and so its name), the walls between them gone. Keeping seams, the faces that met in line
// stay two faces, and the floors and roofs stay the pieces they were (cells); without, the outline's
// faces in line are one face each (the larger one's windows) and the floor and roof one piece. They
// must stand on the same levels and make one outline. Returns the merged zone's index, or why not.
export function mergeZones(m, list, keepSeams = true) {
  if (list.length < 2) return 'Pick two or more zones.';
  const zs = list.map((i) => m.zones[i]), first = zs[0];
  if (zs.some((z) => z.base !== first.base || z.top !== first.top)) return 'Only zones on the same levels can be merged.';
  let union;
  try { union = pc.union(...zs.map((z) => geom(z.plate))); } catch { return 'These zones cannot be merged.'; }
  if (union.length !== 1) return 'The zones must meet along a face to be merged.';
  if (union[0].length > 1) return 'Merged, they would enclose a courtyard: not yet possible.';
  let P = pieces(union)[0];
  if (keepSeams) P = withSeams(P, zs.flatMap((z) => z.plate));
  // begin the outline at the corner nearest where the first zone's began, so its faces keep their order
  const q = P.reduce((b, p, j) => (Math.hypot(p[0] - first.plate[0][0], p[1] - first.plate[0][1]) < Math.hypot(P[b][0] - first.plate[0][0], P[b][1] - first.plate[0][1]) ? j : b), 0);
  P = [...P.slice(q), ...P.slice(0, q)];
  const faces = carryArrays(m, list, P), cells = keepSeams ? zs.flatMap(cellsOf).map((c) => c.map(([x, y]) => [R6(x), R6(y)])) : undefined;
  Object.assign(first, { plate: P, faces, cells });
  if (!cells) delete first.cells;
  for (const i of list.slice(1).sort((a, b) => b - a)) m.zones.splice(i, 1);
  return list[0] - list.slice(1).filter((i) => i < list[0]).length;
}
// A zone's seams: the corners where two of its faces meet in line (up its walls), and the edges where
// two of its floor and roof pieces meet (each [p, q] in plan).
export function zoneSeams(m, i) {
  const z = m.zones[i], walls = z.plate.map((_, v) => v).filter((v) => isSeam(m, i, v)), cells = [];
  const C = cellsOf(z);
  C.forEach((a, ia) => a.forEach((p, k) => {
    const q = a[(k + 1) % a.length];
    C.forEach((b, ib) => {
      if (ib <= ia) return;
      b.forEach((r, j) => {
        const t = b[(j + 1) % b.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]), U = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        const off = (x) => (x[0] - p[0]) * U[1] - (x[1] - p[1]) * U[0], at = (x) => (x[0] - p[0]) * U[0] + (x[1] - p[1]) * U[1];
        if (Math.abs(off(r)) > 1e-4 || Math.abs(off(t)) > 1e-4) return;
        const lo = Math.max(0, Math.min(at(r), at(t))), hi = Math.min(len, Math.max(at(r), at(t)));
        if (hi - lo > 1e-3) cells.push({ cells: [ia, ib], p: [p[0] + U[0] * lo, p[1] + U[1] * lo], q: [p[0] + U[0] * hi, p[1] + U[1] * hi] });
      });
    });
  }));
  return { walls, cells };
}
// A seam up a zone's walls (corner v, between two faces in line) taken out: one face, the larger
// one's windows set out along it where they were.
export function removeWallSeam(m, i, v) {
  if (!isSeam(m, i, v)) return false;
  const P = m.zones[i].plate.filter((_, j) => j !== v), faces = carryArrays(m, [i], P);
  Object.assign(m.zones[i], { plate: P, faces });
  return true;
}
// Two of a zone's floor and roof pieces made one (where they make one outline).
export function mergeCells(m, i, list) {
  const z = m.zones[i], C = cellsOf(z), pick = [...new Set(list)];
  if (pick.length < 2) return false;
  const one = pieces(pc.union(...pick.map((c) => geom(C[c]))));
  if (one.length !== 1) return false;
  const rest = C.filter((_, c) => !pick.includes(c));
  z.cells = [...rest, one[0]];
  if (z.cells.length === 1) delete z.cells;
  return true;
}
// Faces of a zone made one where they run in line one after another: the seams between them go.
export function mergeFaces(m, i, faces) {
  const z = m.zones[i], set = new Set(faces), n = z.plate.length;
  const drop = z.plate.map((_, v) => v).filter((v) => set.has((v - 1 + n) % n) && set.has(v) && isSeam(m, i, v));
  if (!drop.length) return false;
  const P = z.plate.filter((_, v) => !drop.includes(v)), arrays = carryArrays(m, [i], P);
  Object.assign(z, { plate: P, faces: arrays });
  return true;
}
// The floor or roof piece of a zone a plan point lies in.
export function cellAt(m, i, pt) {
  const C = cellsOf(m.zones[i]);
  return C.findIndex((c) => { let inside = false; for (let a = 0, b = c.length - 1; a < c.length; b = a++) if ((c[a][1] > pt[1]) !== (c[b][1] > pt[1]) && pt[0] < ((c[b][0] - c[a][0]) * (pt[1] - c[a][1])) / (c[b][1] - c[a][1]) + c[a][0]) inside = !inside; return inside; });
}
export { cellsOf };

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

// A face of zone i pushed or pulled by `dist` m along its outward normal: a face as the push/pull tool
// pushes it (extrudeFace), as far as it may go; the roof moves the zone's top level and every level
// above, the floor moves its base level alone (the zones below grow or shrink to meet it). Returns the
// distance taken.
export function pushFace(m, i, face, dist) {
  const z = m.zones[i];
  if (face === 'roof') return moveLevel(m, z.top, dist, true);
  if (face === 'floor') return z.base > 0 ? -moveLevel(m, z.base, -dist, false) : 0;
  return extrudeFace(m, i, face, dist);
}

// Zone i moved along its own x or y axis, or up ('z': its base level and every level above rise, the
// zones below growing to meet it); moved in plan only as far as it may go.
export function moveStorey(m, i, axis, dist) {
  const z = m.zones[i];
  if (axis === 'z') return z.base > 0 ? moveLevel(m, z.base, dist, true) : 0;
  const [dx, dy] = turnPlan(axis === 'x' ? [1, 0] : [0, 1], z.rot || 0);
  const [mx, my] = moveZone(m, i, [dx * dist, dy * dist]);
  return Math.hypot(mx, my) * Math.sign(dist);
}
// Zone i moved by [dx, dy] in plan (the building's axes before its turn), as far as it may go.
export function moveZone(m, i, d) {
  return limited(m, i, d, (x, [dx, dy]) => {
    const z = x.zones[i], move = (P) => P.map(([px, py]) => [R6(px + dx), R6(py + dy)]);
    z.plate = move(z.plate);
    if (z.cells) z.cells = z.cells.map(move);
  });
}

// Zone i turned to `deg` (clockwise, its own axes against the building's) about its middle, as far
// as it may go.
export function turnZone(m, i, deg) {
  const from = m.zones[i].rot || 0;
  return from + limited(m, i, deg - from, (x, d) => {
    const z = x.zones[i], c = centroid(z.plate), turn = (P) => P.map(([px, py]) => { const [u, v] = turnPlan([px - c[0], py - c[1]], d); return [R6(u + c[0]), R6(v + c[1])]; });
    z.plate = turn(z.plate);
    if (z.cells) z.cells = z.cells.map(turn);
    z.rot = from + d;
  });
}


// ---------- walls drawn in plan (the Draw wall tool) ----------
// A wall is a line in plan from a to b (the plate's coordinates) standing from a base level to a top
// level, with an assembly and a location line: where the drawn line sits in the wall's thickness
// ('centre', or the 'exterior' or 'interior' finish face, the exterior lying on the side `side` of the
// line: +1 its left looking from a to b, -1 its right). The location line is for drawing only; the
// thermal model takes the drawn line.
//  - A wall run across a zone, from face to face, splits it there (as Split zone).
//  - Walls (with the zones' own edges) that close a space on their levels make it a zone: its floor and
//    roof are made as any zone's, shared with zones above and below where they meet them.
//  - A wall that closes nothing stands free: drawn, not a surface of any zone.
export const WALL_LINES = [['centre', 'Centreline'], ['exterior', 'Exterior finish'], ['interior', 'Interior finish']];
export const nextWallId = (m) => (m.walls || []).reduce((a, w) => Math.max(a, w.id + 1), 0);
const TOL = 1e-3;
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const len2 = (a) => Math.hypot(a[0], a[1]);
// where p falls along a -> b (0 at a, 1 at b) and how far off the line it is
const along = (p, a, b) => { const d = sub2(b, a), l = len2(d) || 1; return [dot2(sub2(p, a), d) / (l * l), cross2(d, sub2(p, a)) / l]; };
const levelsOverlap = (m, x, y) => Math.min(m.levels[x.top].z, m.levels[y.top].z) - Math.max(m.levels[x.base].z, m.levels[y.base].z) > 1e-6;

// The drawn wall a zone's face lies on (in line with it and covering most of it), or null.
export function wallFor(m, i, k) {
  const z = m.zones[i], P = z?.plate;
  if (!P || !m.walls?.length) return null;
  const a = P[k], b = P[(k + 1) % P.length], L = len2(sub2(b, a));
  let best = null, cover = 0;
  for (const w of m.walls) {
    if (!levelsOverlap(m, w, z)) continue;
    const [ta, oa] = along(w.a, a, b), [tb, ob] = along(w.b, a, b);
    if (Math.abs(oa) > 0.01 || Math.abs(ob) > 0.01) continue;
    const c = (Math.min(1, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb))) * L;
    if (c > cover + 1e-6) { cover = c; best = w; }
  }
  return cover > 0.5 * L ? best : null;
}
// Where the surface on face k of zone i sits in its wall's thickness, from the drawn wall's location
// line ('centre', 'exterior': at its exterior finish, 'interior'), or null for the view's own setting.
export function wallLine(m, i, k) {
  const w = wallFor(m, i, k);
  if (!w || !w.line) return null;
  if (w.line === 'centre') return 'centre';
  const P = m.zones[i].plate, a = P[k], b = P[(k + 1) % P.length], d = sub2(b, a);
  // the face's outward side (the plate runs counterclockwise: outward is its right), seen along the wall
  const out = [d[1], -d[0]], wd = sub2(w.b, w.a), left = [-wd[1], wd[0]];
  const outIsExterior = Math.sign(dot2(out, left)) === Math.sign(w.side || 1);
  if (w.line === 'exterior') return outIsExterior ? 'exterior' : 'interior';
  return outIsExterior ? 'interior' : 'exterior';
}
// The parts of drawn walls on no zone's face: they stand free. [{ ...wall, a, b }]
export function freeWalls(m) {
  const out = [];
  for (const w of m.walls || []) {
    let spans = [[0, 1]];
    for (const z of m.zones) {
      if (!levelsOverlap(m, w, z)) continue;
      z.plate.forEach((p, k) => {
        const q = z.plate[(k + 1) % z.plate.length], [ta, oa] = along(p, w.a, w.b), [tb, ob] = along(q, w.a, w.b);
        if (Math.abs(oa) > 0.01 || Math.abs(ob) > 0.01) return;
        const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
        spans = spans.flatMap(([s0, s1]) => [[s0, Math.min(s1, lo)], [Math.max(s0, hi), s1]]).filter(([s0, s1]) => s1 - s0 > 1e-4);
      });
    }
    const at = (t) => [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t], L = len2(sub2(w.b, w.a));
    for (const [s0, s1] of spans) if ((s1 - s0) * L > 0.05) out.push({ ...w, a: at(s0), b: at(s1) });
  }
  return out;
}

// A wall added: it splits the zones it runs across, and closes any space it encloses into a zone.
// Returns { id, split, made } (the zones split, and the new zones' indices).
export function addWall(m, { a, b, base, top, asm = GENERIC_ASSEMBLIES.facade[0], line = 'centre', side = 1 }) {
  if (len2(sub2(b, a)) < 0.05 || top <= base) return null;
  m.walls ||= [];
  const w = { id: nextWallId(m), a: a.map(R6), b: b.map(R6), base, top, asm, line, side };
  m.walls.push(w);
  const split = splitByWall(m, w), made = enclose(m, base, top);
  return { id: w.id, split, made };
}

// The zones on the wall's levels it runs right across (between two of its faces) cut along it.
function splitByWall(m, w) {
  let n = 0;
  const D = sub2(w.b, w.a), L = len2(D), dir = [D[0] / L, D[1] / L];
  for (let i = 0; i < m.zones.length; i++) {
    const z = m.zones[i];
    if (!levelsOverlap(m, w, z)) continue;
    // where the wall crosses the zone's edges, along it
    const ts = [];
    z.plate.forEach((p, k) => {
      const q = z.plate[(k + 1) % z.plate.length], e = sub2(q, p), den = cross2(D, e);
      if (Math.abs(den) < 1e-12) return;
      const t = cross2(sub2(p, w.a), e) / den, u = cross2(sub2(p, w.a), D) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9 && t >= -TOL / L && t <= 1 + TOL / L) ts.push(Math.min(1, Math.max(0, t)));
    });
    ts.sort((x, y) => x - y);
    // each run between two crossings that lies inside the zone is a cut across it
    for (let j = 0; j + 1 < ts.length; j++) {
      const t0 = ts[j], t1 = ts[j + 1];
      if ((t1 - t0) * L < EDGE_MIN) continue;
      const mid = [w.a[0] + D[0] * (t0 + t1) / 2, w.a[1] + D[1] * (t0 + t1) / 2];
      if (!insidePlate(z.plate, mid)) continue;
      if (splitZone(m, i, mid, [mid[0] + dir[0], mid[1] + dir[1]], { within: true }) >= 0) { n++; break; }
    }
  }
  return n;
}
const insidePlate = (P, p) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > p[1]) !== (P[j][1] > p[1]) && p[0] < (P[j][0] - P[i][0]) * (p[1] - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };

// The spaces closed by the walls on levels base..top (with the edges of the zones standing on just
// those levels), less what zones there already hold, made zones of their own. Returns their indices.
export function enclose(m, base, top) {
  const segs = [];
  for (const w of m.walls || []) if (w.base === base && w.top === top) segs.push([w.a, w.b]);
  if (!segs.length) return [];
  for (const z of m.zones) if (z.base === base && z.top === top) z.plate.forEach((p, k) => segs.push([p, z.plate[(k + 1) % z.plate.length]]));
  const made = [];
  for (const face of planarFaces(segs)) {
    const others = m.zones.filter((z) => levelsOverlap(m, { base, top }, z)).map((z) => z.plate);
    for (const P of subtract(face, others)) {
      if (Math.abs(polyArea(P)) < 0.5 || !simpleOutline(P)) continue;
      m.zones.push({ id: nextZoneId(m), name: null, base, top, rot: 0, plate: P, faces: P.map(() => null), generic: true });
      made.push(m.zones.length - 1);
    }
  }
  return made;
}

// The bounded faces of the plane cut up by segments (each counterclockwise, without holes): segments
// split where they cross or touch, loose ends pruned, and each face traced keeping it on the left.
export function planarFaces(segs) {
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  // every segment split at every crossing and touching point
  const cuts = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [a, b] = segs[i], [c, d] = segs[j], r = sub2(b, a), s2 = sub2(d, c), den = cross2(r, s2);
    if (Math.abs(den) < 1e-12) { // in line: each one's ends on the other cut it
      if (Math.abs(cross2(r, sub2(c, a))) > 1e-6 * (len2(r) || 1)) continue;
      for (const p of [c, d]) { const t = dot2(sub2(p, a), r) / dot2(r, r); if (t > 1e-9 && t < 1 - 1e-9) cuts[i].push(t); }
      for (const p of [a, b]) { const t = dot2(sub2(p, c), s2) / dot2(s2, s2); if (t > 1e-9 && t < 1 - 1e-9) cuts[j].push(t); }
      continue;
    }
    const t = cross2(sub2(c, a), s2) / den, u = cross2(sub2(c, a), r) / den, e = 1e-9;
    if (t < -e || t > 1 + e || u < -e || u > 1 + e) continue;
    cuts[i].push(Math.min(1, Math.max(0, t))); cuts[j].push(Math.min(1, Math.max(0, u)));
  }
  const pts = new Map(), adj = new Map();
  const node = (p) => { const k = key(p); if (!pts.has(k)) { pts.set(k, [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]); adj.set(k, new Set()); } return k; };
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    for (let q = 0; q + 1 < ts.length; q++) {
      const p = [a[0] + (b[0] - a[0]) * ts[q], a[1] + (b[1] - a[1]) * ts[q]], r = [a[0] + (b[0] - a[0]) * ts[q + 1], a[1] + (b[1] - a[1]) * ts[q + 1]];
      const u = node(p), v = node(r);
      if (u !== v) { adj.get(u).add(v); adj.get(v).add(u); }
    }
  });
  // loose ends pruned, again and again
  for (let again = true; again;) {
    again = false;
    for (const [k, n] of adj) if (n.size < 2) { for (const o of n) adj.get(o)?.delete(k); adj.delete(k); again = true; }
  }
  // each node's neighbours by angle
  const order = new Map();
  for (const [k, n] of adj) { const p = pts.get(k); order.set(k, [...n].sort((x, y) => { const px = pts.get(x), py = pts.get(y); return Math.atan2(px[1] - p[1], px[0] - p[0]) - Math.atan2(py[1] - p[1], py[0] - p[0]); })); }
  const used = new Set(), faces = [];
  for (const [u, n] of adj) for (const v of n) {
    if (used.has(`${u}>${v}`)) continue;
    const loop = [];
    let a = u, b = v;
    for (let guard = 0; guard < 10000; guard++) {
      used.add(`${a}>${b}`);
      loop.push(pts.get(a));
      // at b, the next edge turning most to the left of the way back (the face kept on the left)
      const around = order.get(b), back = around.indexOf(a), c = around[(back - 1 + around.length) % around.length];
      a = b; b = c;
      if (a === u && b === v) break;
    }
    if (loop.length >= 3 && polyArea(loop) > 1e-6) faces.push(loop);
  }
  return faces;
}
