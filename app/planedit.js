// A plan view made editable, as the 3D view is: zones, walls and windows picked in plan.
//  - Hovering a room outlines its zone, a wall's cut its wall, a window's its window (dashed, in glass,
//    as the 3D view's hover); a click selects it, in every view; a click on nothing lets go. Floors and
//    roofs are not picked here.
//  - A massing's zone selected: a grip on each of its walls at the cut; dragged, the wall moves for this
//    zone alone, so a wall it shared with another zone becomes two. A wall selected: one grip; dragged,
//    the wall moves for every zone sharing it, one growing as the other shrinks. 50 mm steps (100 mm
//    with Shift); a click on a grip types how far.
//  - The modelling tools work here too: the plan lends them its own projection, the zone and face
//    under the pointer, and a preview layer (ModelTools.register).
// Plan coordinates: u, v (m) on the cut, which for a plan are the view's x and y.

import { cutSolid, chain } from './caps.js';
import { gripMark, label, line, poly, inside, segDist, CLICK_PX } from './handles.js';
import { zoneLevels, turnPlan, faceAxes, faceLength, pushFace, pushWall } from '../src/model/massing.js';
import { askNumber } from './sections.js';

const NEAR_PX = 6; // a wall's or window's line this close is under the pointer (drawn thin)
const STEP = 0.05;

// api: { view, massing(), selected(), select(name), massingTarget(name), change(mutate, what), tools }
// d: the plan view's drawing (workspace.js): host, ov (this layer), tv (the tools' layer), toPx, fromPx,
//    frameNow(), key (changes when the drawing is cut again)
export class PlanEdit {
  constructor(d, api) {
    Object.assign(this, { d, api });
    this.hover = null;
    this.drag = null;
    this.ctx = {
      el: d.host, svg: d.tv,
      P: (p) => this.P(p),
      px: (e) => this.px(e),
      targetAt: (e) => this.targetAt(e),
    };
    this.unregister = api.tools.register(this.ctx);
  }

  px(e) { const r = this.d.host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  // the cut's height in view coordinates
  get zc() { return this.d.frameNow()?.f.o.z; }

  // ---------- what can be picked, in plan coordinates; worked out again when the drawing is ----------
  picks() {
    const fr = this.d.frameNow();
    if (!fr) return null;
    if (this.cache?.key === this.d.key) return this.cache;
    const v = this.api.view, o3 = v.origin || [0, 0, 0], zc = fr.f.o.z, f = fr.f;
    const V = (p) => [p[0] - o3[0], p[1] - o3[1], p[2] - o3[2]];
    const walls = [], windows = [], zones = new Map(), extent = new Map();
    for (const s of v.surfaces || []) {
      if (!s.zone) continue;
      const P = s.vertices.map(V), zs = P.map((p) => p[2]);
      const e = extent.get(s.zone) || [Infinity, -Infinity];
      extent.set(s.zone, [Math.min(e[0], ...zs), Math.max(e[1], ...zs)]);
    }
    for (const s of v.surfaces || []) {
      if (!s.zone) continue;
      const P = s.vertices.map(V), n = newell(P);
      if (Math.abs(n[2]) < 0.2) { // a wall: its line at the cut, its solid's cut, which way it faces
        const seg = cutLine(P, zc);
        if (!seg) continue;
        const tris = v.solidOf?.get(s.name), loops = tris ? chain(cutSolid(tris, f)).map((L) => L.map((q) => [q.x, q.y])) : [];
        const h = Math.hypot(n[0], n[1]) || 1;
        walls.push({ name: s.name, zone: s.zone, seg, loops, n: [n[0] / h, n[1] / h] });
      } else if (n[2] < -0.9 * Math.hypot(...n)) { // a floor: the zone's footprint, where the zone spans the cut
        const [z0, z1] = extent.get(s.zone);
        if (!(z0 <= zc && z1 > zc) || Math.abs(P[0][2] - z0) > 0.01) continue;
        if (!zones.has(s.zone)) zones.set(s.zone, []);
        zones.get(s.zone).push(P.map((p) => [p[0], p[1]]));
      }
    }
    for (const w of v.windows || []) {
      const seg = cutLine(w.vertices.map(V), zc);
      if (seg) windows.push({ name: w.name, seg });
    }
    this.cache = { key: this.d.key, walls, windows, zones: [...zones].map(([name, polys]) => ({ name, polys })) };
    return this.cache;
  }

  // What is under the pointer: a window, a wall, then a zone's room.
  pickAt(e) {
    const c = this.picks();
    if (!c) return null;
    const [x, y] = this.px(e), q = this.d.fromPx(x, y), s = this.d.cam.s;
    const near = (seg) => segDist([x, y], this.d.toPx(...seg[0]), this.d.toPx(...seg[1]));
    const win = c.windows.map((w) => [w, near(w.seg)]).filter(([, dd]) => dd < NEAR_PX).sort((a, b) => a[1] - b[1])[0];
    if (win) return { kind: 'window', name: win[0].name, item: win[0] };
    // a wall: in its cut (drawn thick) or near its line; of a wall shared by two zones, the one on the
    // pointer's side
    const hits = c.walls.filter((w) => w.loops.some((L) => inside(L, q)) || near(w.seg) < NEAR_PX);
    if (hits.length) {
      const side = (w) => (q[0] - w.seg[0][0]) * w.n[0] + (q[1] - w.seg[0][1]) * w.n[1];
      const w = hits.sort((a, b) => (side(a) > 0) - (side(b) > 0) || near(a.seg) - near(b.seg))[0];
      return { kind: 'surface', name: w.name, item: w };
    }
    void s;
    const z = c.zones.find((zz) => zz.polys.some((P) => inside(P, q)));
    return z ? { kind: 'zone', name: z.name, item: z } : null;
  }

  // ---------- the massing's zones on this plan ----------
  // a massing point (its plan's own axes, and a height) on this drawing
  P(p) {
    const m = this.api.massing(), o3 = this.api.view.origin || [0, 0, 0], [x, y] = turnPlan([p[0], p[1]], m?.rot || 0);
    return this.d.toPx(x - o3[0], y - o3[1]);
  }
  // the massing point under the pointer (its plan's own axes)
  toMassing(e) {
    const m = this.api.massing(), o3 = this.api.view.origin || [0, 0, 0], [x, y] = this.px(e), [u, v] = this.d.fromPx(x, y);
    return turnPlan([u + o3[0], v + o3[1]], -(m?.rot || 0));
  }
  // the massing's zones standing where this plan cuts
  zonesHere(m) {
    const zc = this.zc + (this.api.view.origin?.[2] || 0);
    return m.zones.map((z, i) => i).filter((i) => { const [z0, z1] = zoneLevels(m, i); return z0 <= zc + 1e-6 && z1 > zc + 1e-6; });
  }
  // For the modelling tools: the zone under the pointer and its face near it (or 'roof' inside it, as
  // a plan looks down on the zone), and the point in the plan's own axes.
  targetAt(e) {
    const m = this.api.massing();
    if (!m) return null;
    const point = this.toMassing(e), [x, y] = this.px(e), here = this.zonesHere(m);
    let best = null;
    for (const i of here) {
      const P = m.zones[i].plate;
      P.forEach((a, k) => {
        const dd = segDist([x, y], this.P(a), this.P(P[(k + 1) % P.length]));
        if (dd < 10 && (!best || dd < best.dd)) best = { zone: i, face: k, dd, in: inside(P, point) };
      });
    }
    const within = here.find((i) => inside(m.zones[i].plate, point));
    if (best && (within === undefined || best.zone === within || !best.in)) return { zone: best.zone, face: best.face, point };
    if (within !== undefined) return { zone: within, face: 'roof', point };
    return null;
  }

  // ---------- drawn over the plan: the hover, the selection, the grips ----------
  paint() {
    const ov = this.d.ov;
    if (!ov || !this.picks()) { if (ov) ov.innerHTML = ''; return; }
    let g = '';
    const sel = this.api.selected(), selPick = sel && this.find(sel);
    if (selPick) g += this.outline(selPick, { stroke: 'var(--glass)', w: 1.5 });
    if (this.hover && this.hover.name !== sel && !this.api.tools.tool) g += this.outline(this.hover, { stroke: 'var(--glass)', w: 2.6, dash: '6 4' });
    this.grips = [];
    if (!this.api.tools.tool) g += this.drag ? this.dragDraw() : this.gripsFor(sel);
    ov.innerHTML = g;
  }
  find(name) {
    const c = this.picks();
    const w = c.windows.find((x) => x.name === name); if (w) return { kind: 'window', item: w };
    const s = c.walls.find((x) => x.name === name); if (s) return { kind: 'surface', item: s };
    const z = c.zones.find((x) => x.name === name); if (z) return { kind: 'zone', item: z };
    return null;
  }
  outline({ kind, item }, o) {
    const T = (p) => this.d.toPx(p[0], p[1]);
    if (kind === 'zone') return item.polys.map((P) => poly(P.map(T), o)).join('');
    if (kind === 'surface' && item.loops.length) return item.loops.map((L) => poly(L.map(T), o)).join('');
    // a line: a narrow box around it
    const [a, b] = item.seg.map(T), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, h = kind === 'window' ? 4 : 3, nx = -dy / l * h, ny = dx / l * h;
    return poly([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], o);
  }
  // the grips of a massing's selected zone (each wall) or wall (its own)
  gripsFor(sel) {
    const m = this.api.massing(), t = m && sel && this.api.massingTarget(sel);
    if (!t || (t.face !== null && !Number.isInteger(t.face)) || !this.zonesHere(m).includes(t.zone)) return '';
    const P = m.zones[t.zone].plate, faces = t.face === null ? P.map((_, k) => k) : [t.face];
    let g = '';
    for (const k of faces) {
      const { A, U, n } = faceAxes(m, t.zone, k), len = faceLength(m, t.zone, k), mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2];
      const p = this.P(mid), q = this.P([mid[0] + n[0], mid[1] + n[1]]);
      this.grips.push({ p, dir: [q[0] - p[0], q[1] - p[1]], zone: t.zone, face: k, shared: t.face !== null });
      g += gripMark(p[0], p[1], 5);
    }
    return g;
  }
  gripAt(e) { const [x, y] = this.px(e); return (this.grips || []).find((g) => Math.hypot(g.p[0] - x, g.p[1] - y) < 9) || null; }
  // the zones as they will be, while a grip is dragged
  dragDraw() {
    const r = this.drag, m = this.api.massing();
    if (!r || !m) return '';
    const trial = structuredClone(m), taken = r.d ? this.push(trial, r, r.d) : 0;
    r.taken = taken;
    let g = '';
    trial.zones.forEach((z, i) => { if (JSON.stringify(z.plate) !== JSON.stringify(m.zones[i].plate)) g += poly(z.plate.map((p) => this.P(p)), { stroke: 'var(--glass)', w: 1.6 }); });
    const a = m.zones[r.zone].plate[r.face];
    const p = this.P(a);
    return g + gripMark(r.p[0] + r.dir[0] * taken, r.p[1] + r.dir[1] * taken, 5) + label(p[0], p[1] - 12, `${taken > 0 ? '+' : ''}${Math.round(taken * 1000)} mm`, { size: 9, fill: 'var(--glass)' });
  }
  push(m, r, d) { return r.shared ? pushWall(m, r.zone, r.face, d) : pushFace(m, r.zone, r.face, d); }

  // ---------- the pointer (left button; the drawing pans with the others) ----------
  move(e) {
    if (this.drag) {
      const r = this.drag, dx = e.clientX - r.x0, dy = e.clientY - r.y0;
      if (!r.moved && Math.hypot(dx, dy) < CLICK_PX) return;
      r.moved = true;
      const l2 = r.dir[0] ** 2 + r.dir[1] ** 2 || 1, step = e.shiftKey ? 0.1 : STEP;
      r.d = Math.round(((dx * r.dir[0] + dy * r.dir[1]) / l2) / step) * step;
      this.paint();
      return;
    }
    if (this.api.tools.tool) return;
    const g = this.gripAt(e), h = g ? null : this.pickAt(e);
    this.d.host.style.cursor = g ? (Math.abs(g.dir[0]) > Math.abs(g.dir[1]) ? 'ew-resize' : 'ns-resize') : h ? 'pointer' : '';
    if ((h?.name || null) !== (this.hover?.name || null)) { this.hover = h; this.paint(); }
  }
  leave() { if (this.hover) { this.hover = null; this.paint(); } }
  down(e) {
    if (this.api.tools.tool) { this.api.tools.press(e); return; }
    const g = this.gripAt(e);
    if (g) {
      this.drag = { ...g, x0: e.clientX, y0: e.clientY, d: 0, moved: false };
      this.d.host.setPointerCapture?.(e.pointerId);
      return;
    }
    this.press = { x: e.clientX, y: e.clientY };
  }
  up(e) {
    const r = this.drag;
    if (r) {
      this.drag = null;
      this.d.host.releasePointerCapture?.(e.pointerId);
      const what = (d) => `${r.shared ? 'wall' : 'zone face'} ${d > 0 ? 'pushed out' : 'pulled in'} ${Math.round(Math.abs(d) * 1000)} mm`;
      if (!r.moved) askNumber(this.d.host, e, 'push out (+) or in (−), mm', (x) => this.api.change((m) => this.push(m, r, x / 1000), what(x / 1000)), true);
      else if (r.taken) this.api.change((m) => this.push(m, r, r.taken), what(r.taken));
      this.paint();
      return;
    }
    const p = this.press;
    this.press = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) return;
    const h = this.pickAt(e);
    this.api.select(h ? h.name : null);
  }
  dispose() { this.unregister?.(); }
}

// A polygon's normal (Newell), not normalised.
function newell(P) {
  const n = [0, 0, 0];
  P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
  return n;
}
// Where an upright polygon crosses the level z: the segment between its outermost crossings, or null.
function cutLine(P, z) {
  const pts = [];
  P.forEach((a, i) => {
    const b = P[(i + 1) % P.length], da = a[2] - z, db = b[2] - z;
    if (Math.abs(da) < 1e-9) pts.push([a[0], a[1]]);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  });
  if (pts.length < 2) return null;
  let best = null, far = -1;
  for (const p of pts) for (const q of pts) { const dd = Math.hypot(p[0] - q[0], p[1] - q[1]); if (dd > far) { far = dd; best = [p, q]; } }
  return far > 1e-4 ? best : null;
}
