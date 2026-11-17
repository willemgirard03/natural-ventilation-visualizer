// Airflow paths: the way the designer means air to go, drawn freehand over a plan. The stroke is
// simplified to a few control points (Ramer-Douglas-Peucker, to a tolerance set by its smoothness) and
// drawn as a smooth curve through them (centripetal Catmull-Rom). Where the curve crosses a zone's
// side on its level it makes an opening: a door where the side is a wall between two rooms, a window
// where it is outside. The openings belong to the path - drawn again wherever it crosses as its
// points move - until it is applied (its openings made the massing's own doors and windows, the path
// gone) or one is released. Each may be changed while it belongs to the path (its size, sill, and a
// slide along its wall from where the path crosses), or taken out.
//
// m.paths [{ id, level, raw: [[x, y]] (the stroke), smooth (0..1), pts: [[x, y]] (control points),
//   over: { [n]: { w, h, sill, du, removed } } (the n-th crossing's own settings) }]
// An opening of a path is known by its id `p<path>.<n>` among the massing's doors and windows.

export const PATH_SMOOTH = 0.5;
export const PATH_DOOR = { w: 0.9, h: 2.1 };
export const PATH_WINDOW = { w: 1.2, h: 1.5, sill: 0.9 };
const SAME = 0.1; // m: crossings closer than this are one (the two sides of a wall between rooms)
const R6 = (x) => Math.round(x * 1e6) / 1e6;

// the simplification's tolerance (m) at a smoothness of 0 (every bend kept) to 1 (only the broad way)
export const toleranceOf = (s) => 0.05 + Math.max(0, Math.min(1, s)) * 1.45;

// Ramer-Douglas-Peucker: the points that keep the stroke within tol of itself.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.map((p) => [...p]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - A[0], pts[i][1] - A[1]) : Math.abs(dx * (pts[i][1] - A[1]) - dy * (pts[i][0] - A[0])) / L;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => [R6(p[0]), R6(p[1])]);
}

// The curve through control points (centripetal Catmull-Rom, its ends held straight), as a polyline
// with a point about every `step` m.
export function curveOf(ctrl, step = 0.1) {
  if (ctrl.length < 3) return ctrl.map((p) => [...p]);
  const P = [[2 * ctrl[0][0] - ctrl[1][0], 2 * ctrl[0][1] - ctrl[1][1]], ...ctrl, [2 * ctrl.at(-1)[0] - ctrl.at(-2)[0], 2 * ctrl.at(-1)[1] - ctrl.at(-2)[1]]];
  const out = [[...ctrl[0]]];
  for (let i = 1; i + 2 < P.length; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const t = (a, b) => Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
    const t0 = 0, t1 = t0 + t(p0, p1), t2 = t1 + t(p1, p2), t3 = t2 + t(p2, p3);
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let s = 1; s <= n; s++) {
      const u = t1 + ((t2 - t1) * s) / n, lerp = (a, b, ta, tb) => [0, 1].map((k) => ((tb - u) * a[k] + (u - ta) * b[k]) / (tb - ta));
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  return out;
}
export const pathCurve = (path) => curveOf(path.pts);

// A path drawn: the stroke kept, simplified to its smoothness. Returns it.
export function addPath(m, { raw, level, smooth = PATH_SMOOTH }) {
  m.paths ||= [];
  const id = m.paths.reduce((a, p) => Math.max(a, p.id + 1), 0);
  const path = { id, level, raw: raw.map((p) => [R6(p[0]), R6(p[1])]), smooth, pts: [], over: {} };
  path.pts = simplify(path.raw, toleranceOf(smooth));
  if (path.pts.length < 2) return null;
  m.paths.push(path);
  return path;
}
export const pathOf = (m, id) => (m.paths || []).find((p) => p.id === id) || null;
export function deletePath(m, id) { if (m.paths) m.paths = m.paths.filter((p) => p.id !== id); }
// Its smoothness set: the stroke simplified again (control points moved by hand go).
export function setPathSmooth(m, id, s) {
  const p = pathOf(m, id);
  if (!p) return false;
  p.smooth = Math.max(0, Math.min(1, s));
  const pts = simplify(p.raw, toleranceOf(p.smooth));
  if (pts.length >= 2) p.pts = pts;
  return true;
}
export function movePathPoint(m, id, i, q) {
  const p = pathOf(m, id);
  if (!p || !p.pts[i]) return false;
  p.pts[i] = [R6(q[0]), R6(q[1])];
  return true;
}

// Where the path crosses the sides of the zones standing on its level, along it: [{ n, s (m along it),
// p (plan point), U (the side's direction), door (between two rooms), zones }].
export function pathCrossings(m, path) {
  const line = pathCurve(path), sides = [];
  m.zones.forEach((z, i) => { if (z.base === path.level) z.plate.forEach((a, k) => sides.push({ i, a, b: z.plate[(k + 1) % z.plate.length] })); });
  const hits = [];
  let s0 = 0;
  for (let j = 0; j + 1 < line.length; j++) {
    const P = line[j], Q = line[j + 1], r = [Q[0] - P[0], Q[1] - P[1]], len = Math.hypot(...r);
    for (const f of sides) {
      const e = [f.b[0] - f.a[0], f.b[1] - f.a[1]], den = r[0] * e[1] - r[1] * e[0];
      if (Math.abs(den) < 1e-12) continue;
      const w = [f.a[0] - P[0], f.a[1] - P[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
      if (t < 0 || t >= 1 || u < 0 || u > 1) continue;
      const L = Math.hypot(...e) || 1;
      hits.push({ s: s0 + t * len, p: [P[0] + r[0] * t, P[1] + r[1] * t], U: [e[0] / L, e[1] / L], zone: f.i });
    }
    s0 += len;
  }
  hits.sort((a, b) => a.s - b.s);
  const out = [];
  for (const h of hits) {
    const same = out.find((o) => Math.hypot(o.p[0] - h.p[0], o.p[1] - h.p[1]) < SAME);
    if (same) { if (!same.zones.includes(h.zone)) same.zones.push(h.zone); continue; }
    out.push({ s: h.s, p: h.p, U: h.U, zones: [h.zone] });
  }
  return out.map((c, n) => ({ ...c, n, door: c.zones.length > 1 }));
}

// Every path's openings, as the massing's own are kept: { doors: [{ id, p, level, w, h, path, n }],
// openings: [{ id, p, level, w, h, sill, path, n }] }.
export function pathOpenings(m) {
  const doors = [], openings = [];
  for (const path of m.paths || []) {
    for (const c of pathCrossings(m, path)) {
      const o = path.over?.[c.n] || {};
      if (o.removed) continue;
      const du = o.du || 0, p = [R6(c.p[0] + c.U[0] * du), R6(c.p[1] + c.U[1] * du)], id = `p${path.id}.${c.n}`;
      if (c.door) doors.push({ id, p, level: path.level, w: o.w ?? PATH_DOOR.w, h: o.h ?? PATH_DOOR.h, path: path.id, n: c.n });
      else openings.push({ id, p, level: path.level, w: o.w ?? PATH_WINDOW.w, h: o.h ?? PATH_WINDOW.h, sill: o.sill ?? PATH_WINDOW.sill, path: path.id, n: c.n });
    }
  }
  return { doors, openings };
}
export const isPathOpening = (id) => typeof id === 'string' && /^p\d+\.\d+$/.test(id);
const parse = (id) => { const [a, b] = id.slice(1).split('.').map(Number); return { path: a, n: b }; };
// An opening of a path changed while it stays the path's: its middle now at plan point q (slid along
// its wall from where the path crosses), and its size.
export function setPathOpening(m, id, q, { w, h, sill } = {}) {
  const { path, n } = parse(id), P = pathOf(m, path), c = P && pathCrossings(m, P).find((x) => x.n === n);
  if (!c) return false;
  const du = (q[0] - c.p[0]) * c.U[0] + (q[1] - c.p[1]) * c.U[1];
  P.over[n] = { ...P.over[n], du: R6(du), ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}), ...(sill !== undefined ? { sill } : {}) };
  return true;
}
// An opening of a path taken out (the path makes it no more until it is put back).
export function removePathOpening(m, id) {
  const { path, n } = parse(id), P = pathOf(m, path);
  if (!P) return false;
  P.over[n] = { ...P.over[n], removed: true };
  return true;
}
// Openings made the massing's own (all a path's, or one): they stay where they are as the path moves.
function own(m, list) {
  m.doors ||= []; m.openings ||= [];
  let d = m.doors.reduce((a, x) => Math.max(a, (Number.isInteger(x.id) ? x.id : -1) + 1), 0), o = m.openings.reduce((a, x) => Math.max(a, (Number.isInteger(x.id) ? x.id : -1) + 1), 0);
  for (const x of list.doors) m.doors.push({ id: d++, p: x.p, level: x.level, w: x.w, h: x.h });
  for (const x of list.openings) m.openings.push({ id: o++, p: x.p, level: x.level, w: x.w, h: x.h, sill: x.sill });
}
// The path applied: its openings the massing's own, the path gone.
export function applyPath(m, id) {
  const all = pathOpenings(m), mine = (x) => x.path === id;
  own(m, { doors: all.doors.filter(mine), openings: all.openings.filter(mine) });
  deletePath(m, id);
}
// One opening released from its path: the massing's own, and no longer made by the path.
export function releasePathOpening(m, id) {
  const all = pathOpenings(m), one = (x) => x.id === id;
  own(m, { doors: all.doors.filter(one), openings: all.openings.filter(one) });
  removePathOpening(m, id);
}
