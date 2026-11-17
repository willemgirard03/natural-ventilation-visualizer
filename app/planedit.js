// A plan view made editable, as the 3D view is: zones, walls and windows picked in plan.
//  - Hovering a room outlines its zone, a wall's cut its wall, a window's its window (dashed, in glass,
//    as the 3D view's hover); a click selects it, in every view; a click on nothing lets go. Floors and
//    roofs are not picked here.
//  - A massing's zone selected: a grip on each of its walls at the cut; dragged, the wall moves for this
//    zone alone, so a wall it shared with another zone becomes two. A wall selected: one grip; dragged,
//    the wall moves for every zone sharing it, one growing as the other shrinks. 50 mm steps (100 mm
//    with Shift); a click on a grip types how far.
//  - A massing's window, or wall with windows, selected: its array bracketed outside the wall. A grip at
//    each end of the bracket sets the array's length (the other end held; a click types it); its number
//    and spacing slide with a drag along them (a click types them over); a selected window dragged
//    along its wall sets the spacing, as in 3D.
//  - A wall pressed and dragged moves, selected or not: a zone's wall for every zone sharing it, a free
//    wall whole. Pressed and let go, it is selected.
//  - A drawn wall standing free (it closes no zone) is picked as the others; selected, a grip at each
//    end, dragged to move that end, snapping as Draw wall does.
//  - The modelling tools work here too: the plan lends them its own projection, the zone and face
//    under the pointer, and a preview layer (ModelTools.register).
// Plan coordinates: u, v (m) on the cut, which for a plan are the view's x and y.

import { cutSolid, chain } from './caps.js';
import { pathCurve, movePathPoint } from '../src/model/airpath.js';
export const PATH_COLOR = '#2E86AB'; // an airflow path, as drawn
import { gripMark, label, line, poly, inside, segDist, CLICK_PX } from './handles.js';
import { zoneLevels, turnPlan, faceAxes, faceLength, pushFace, pushWall, moveWallEnd, moveWall, unitLayout, bayExtents, setArraySpan, setCount, setSpacing, spreadSide, dragPitch } from '../src/model/massing.js';
import { askNumber } from './sections.js';

const SEL = '#2F6F68'; // the selection's colour and tint, as the 3D view's (view3d.js SELECTED)
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
      pointAt: (e) => this.toMassing(e),
      // the level this plan is cut above (walls drawn here stand on it)
      level: () => { const v = this.d.item; return v?.kind === 'plan' && Number.isInteger(v.level) ? v.level : null; },
    };
    this.unregister = api.tools.register(this.ctx);
    // Tab over a wall: the walls closing the smallest loop through it offered, Tab again all the walls
    // joined to it, again none; the next click picks those offered
    this.onKey = (e) => {
      if (e.key !== 'Tab' || !this.over || this.api.tools.tool || e.target.closest?.('input, select, textarea')) return;
      if (!this.hover || !['surface', 'wall'].includes(this.hover.kind)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const step = this.chain ? (this.chainStep || 0) + 1 : 0;
      const loop = step === 0 ? this.loopOf(this.hover.name) : null;
      if (step === 0 && loop) { this.chain = loop; this.chainStep = 0; }
      else if (step <= 1) { this.chain = this.chainOf(this.hover.name); this.chainStep = 1; }
      else { this.chain = null; this.chainStep = 0; }
      this.paint();
    };
    addEventListener('keydown', this.onKey, true);
  }
  // The walls (zone walls cut here, and drawn walls standing free) joined end to end with this one.
  chainOf(name) {
    const c = this.picks();
    if (!c) return [name];
    const all = [...c.walls, ...c.free], key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`, ends = (w) => [key(w.seg[0]), key(w.seg[1])];
    const seen = new Set([name]), todo = [all.find((w) => w.name === name)].filter(Boolean);
    while (todo.length) {
      const w = todo.pop(), [a, b] = ends(w);
      for (const o of all) if (!seen.has(o.name) && ends(o).some((k) => k === a || k === b)) { seen.add(o.name); todo.push(o); }
    }
    return [...seen];
  }
  // The walls closing the shortest loop through this one (end to end, back to where it began), or null
  // when it closes none. Walls back to back (two zones' sides of one wall) count as one way round.
  loopOf(name) {
    const c = this.picks();
    if (!c) return null;
    const all = [...c.walls, ...c.free], key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    const me = all.find((w) => w.name === name);
    if (!me) return null;
    // each line between two ends, with the walls standing on it
    const edges = new Map(), pt = new Map();
    for (const w of all) {
      const [a, b] = w.seg.map(key);
      if (a === b) continue;
      pt.set(a, w.seg[0]); pt.set(b, w.seg[1]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edges.has(k)) edges.set(k, { a, b, len: Math.hypot(w.seg[1][0] - w.seg[0][0], w.seg[1][1] - w.seg[0][1]), names: [] });
      edges.get(k).names.push(w.name);
    }
    const [s, t] = me.seg.map(key), start = s < t ? `${s}|${t}` : `${t}|${s}`;
    // the shortest way from one end to the other, not along the wall itself (Dijkstra)
    const adj = new Map();
    for (const [k, e] of edges) { if (k === start) continue; for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, e.len, k]); } }
    const dist = new Map([[t, 0]]), prev = new Map(), done = new Set();
    for (;;) {
      let u = null;
      for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u))) u = n;
      if (u === null || u === s) break;
      done.add(u);
      for (const [v, l, k] of adj.get(u) || []) { const d = dist.get(u) + l; if (!dist.has(v) || d < dist.get(v) - 1e-9) { dist.set(v, d); prev.set(v, [u, k]); } }
    }
    if (!dist.has(s)) return null;
    const names = [...edges.get(start).names];
    for (let n = s; prev.has(n); n = prev.get(n)[0]) names.push(...edges.get(prev.get(n)[1]).names);
    return names;
  }
  // A zone's walls cut by this plan.
  zoneWalls(zone) { return (this.picks()?.walls || []).filter((w) => w.zone === zone).map((w) => w.name); }
  // What a box holds (window: the box drawn to the right) or touches (crossing: to the left), on this
  // plan's level: each item's points all inside it, or any inside it or any of its edges crossing it.
  inBox(bx) {
    const c = this.picks();
    if (!c) return [];
    const [x0, y0] = this.d.fromPx(Math.min(bx.x0, bx.x1), Math.min(bx.y0, bx.y1)), [x1, y1] = this.d.fromPx(Math.max(bx.x0, bx.x1), Math.max(bx.y0, bx.y1));
    const lo = [Math.min(x0, x1), Math.min(y0, y1)], hi = [Math.max(x0, x1), Math.max(y0, y1)], crossing = bx.x1 < bx.x0;
    const inR = (p) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1];
    const R = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]];
    const cross = (a, b, c2, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c2) * o(a, b, d) < 0 && o(c2, d, a) * o(c2, d, b) < 0; };
    const touches = (loops) => loops.some((L) => L.some(inR) || L.some((p, i) => R.some((q, j) => cross(p, L[(i + 1) % L.length], q, R[(j + 1) % 4]))) || R.some((q) => inside(L, q)));
    const holds = (loops) => loops.every((L) => L.every(inR));
    const test = (loops) => (crossing ? touches(loops) : holds(loops));
    const out = [];
    for (const w of [...c.walls, ...c.free]) if (test(w.loops.length ? w.loops : [w.seg])) out.push(w.name);
    for (const w of c.windows) if (test([w.seg])) out.push(w.name);
    for (const d of c.doors || []) if (test([d.seg])) out.push(d.name);
    for (const z of c.zones) if (test(z.polys)) out.push(z.name);
    return out;
  }

  px(e) { const r = this.d.host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  // the cut's height in view coordinates
  get zc() { return this.d.frameNow()?.f.o.z; }

  // ---------- what can be picked, in plan coordinates; worked out again when the drawing is ----------
  picks() {
    const fr = this.d.frameNow();
    if (!fr) return null;
    if (this.cache?.key === this.d.key) return this.cache;
    // cut again (the building changed): what was under the pointer, and Tab's walls, are let go until
    // the pointer moves (else they would be drawn where they no longer are)
    if (this.cache) { this.hover = null; this.chain = null; }
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
    // doors (the model's own and those added), where the cut passes through them
    const doors = [];
    for (const d of v.doors || []) {
      const seg = cutLine(d.vertices.map(V), zc);
      if (seg) doors.push({ name: d.name, seg });
    }
    // the drawn walls standing free that the cut passes through: their footprint at their thickness
    const free = [];
    for (const w of v.freeList || []) {
      if (!(w.z0 - o3[2] <= zc + 1e-6 && w.z1 - o3[2] > zc + 1e-6)) continue;
      const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], l = Math.hypot(dx, dy) || 1, n = [-dy / l, dx / l], s0 = w.off - w.t / 2, s1 = w.off + w.t / 2;
      const Q = (p, s) => [p[0] + n[0] * s - o3[0], p[1] + n[1] * s - o3[1]];
      free.push({ name: `wall:${w.id}`, id: w.id, seg: [Q(w.a, w.off), Q(w.b, w.off)], loops: [[Q(w.a, s0), Q(w.b, s0), Q(w.b, s1), Q(w.a, s1)]] });
    }
    this.cache = { key: this.d.key, walls, windows, doors, free, zones: [...zones].map(([name, polys]) => ({ name, polys })) };
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
    // an open window or door by what is drawn of it: the sash or leaf where it has swung to
    for (const w of c.windows) {
      const sw = this.sashSeen(w.name);
      if (sw && (sw.arc ? segDist([x, y], sw.H, sw.T) < NEAR_PX : inside(sw.outline.map((p) => this.d.fromPx(...p)), q))) return { kind: 'window', name: w.name, item: w };
    }
    for (const d of c.doors) {
      const Lf = this.api.view.doorLeafNow?.(d.name), o3 = this.api.view.origin || [0, 0, 0];
      if (Lf && segDist([x, y], this.d.toPx(Lf.hinge[0] - o3[0], Lf.hinge[1] - o3[1]), this.d.toPx(Lf.tip[0] - o3[0], Lf.tip[1] - o3[1])) < NEAR_PX) return { kind: 'door', name: d.name, item: d };
    }
    const door = c.doors.map((d) => [d, near(d.seg)]).filter(([, dd]) => dd < NEAR_PX).sort((a, b) => a[1] - b[1])[0];
    if (door) return { kind: 'door', name: door[0].name, item: door[0] };
    const path = this.pathAt(e);
    if (path) return path;
    const fw = c.free.find((w) => w.loops.some((L) => inside(L, q)) || near(w.seg) < NEAR_PX);
    if (fw) return { kind: 'wall', name: fw.name, item: fw };
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
    for (const n of this.api.selection?.() || []) { if (n === sel) continue; const f = this.find(n); if (f) g += this.selMark(f, false); }
    if (selPick) g += this.selMark(selPick, true);
    for (const n of this.chain || []) { const f = this.find(n); if (f) g += this.outline(f, { stroke: 'var(--glass)', w: 2.4, dash: '6 4' }); }
    g += this.doorSwings() + this.windowSwings();
    for (const n of this.api.mergeAsk?.() || []) { const f = this.find(n); if (f) g += this.outline(f, { stroke: '#D9822B', w: 3 }); }
    if (this.box) {
      const b = this.box, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
      g += `<rect x="${x}" y="${y}" width="${Math.abs(b.x1 - b.x0)}" height="${Math.abs(b.y1 - b.y0)}" fill="var(--glass)" fill-opacity="0.06" stroke="var(--glass)" stroke-width="1"${b.x1 < b.x0 ? ' stroke-dasharray="5 3"' : ''}/>`;
      // what letting go now would select, shown as it will be
      for (const n of this.inBox(b)) { const f = this.find(n); if (f) g += this.selMark(f, false); }
    }
    // the hover as the plan is now (after an edit, the thing under the pointer may have moved or gone)
    if (this.hover) { const f = this.find(this.hover.name); this.hover = f ? { ...f, name: this.hover.name } : null; }
    if (this.hover && this.hover.name !== sel && !this.api.tools.tool) g += this.outline(this.hover, { stroke: 'var(--glass)', w: 2.6, dash: '6 4' });
    this.grips = [];
    g += this.pathsDrawn(sel);
    if (!this.drag) this.figs = null;
    const arrDrag = this.drag && (this.drag.span !== undefined || this.drag.fig || this.drag.pitch);
    if (!this.api.tools.tool) g += arrDrag ? this.dragDraw() : this.arrayFor(sel) + (this.drag ? this.dragDraw() : this.gripsFor(sel));
    // the window the Window tool would put: a pane on the wall's line, red where it does not fit
    if (this.api.placing?.() && this.offer) {
      const o3 = this.api.view.origin || [0, 0, 0], [a, b] = this.offer.ends.map((p) => this.d.toPx(p[0] - o3[0], p[1] - o3[1])), col = this.offer.problem ? '#C0442B' : 'var(--glass)';
      g += line(a[0], a[1], b[0], b[1], { stroke: col, w: 4 }) + label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 10, this.offer.problem || `${Math.round((this.offer.r.s1 - this.offer.r.s0) * 1000)} mm`, { size: 9, fill: col });
    }
    ov.innerHTML = g;
  }
  // The airflow paths drawn on this plan's level: each a curve with arrows the way the air is meant to
  // go and a dot where it starts; the one selected heavier, with its control points (grips, dragged).
  pathsDrawn(sel) {
    const m = this.api.massing(), L = this.ctx.level();
    if (!m?.paths?.length) return '';
    let g = '';
    for (const p of m.paths) {
      if (p.level !== L) continue;
      const on = sel === `path:${p.id}` || [...(this.api.selection?.() || [])].includes(`path:${p.id}`), dr = this.drag?.path === p.id && this.drag.q ? this.drag : null;
      const pts = dr ? p.pts.map((q, i) => (i === dr.idx ? dr.q : q)) : p.pts;
      const line = pathCurve({ pts }).map((q) => this.P(q));
      g += `<polyline points="${line.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${PATH_COLOR}" stroke-width="${on ? 3 : 2}" stroke-linecap="round" stroke-linejoin="round" opacity="${on ? 1 : 0.85}"/>`;
      // arrows about every 60 px along it, and a dot at its start
      let run = 0;
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        run += d;
        if (run < 60 || d < 1e-6) continue;
        run = 0;
        const u = [(b[0] - a[0]) / d, (b[1] - a[1]) / d], n = [-u[1], u[0]], s = 6;
        g += `<polyline points="${b[0] - u[0] * s + n[0] * s * 0.7},${b[1] - u[1] * s + n[1] * s * 0.7} ${b[0]},${b[1]} ${b[0] - u[0] * s - n[0] * s * 0.7},${b[1] - u[1] * s - n[1] * s * 0.7}" fill="none" stroke="${PATH_COLOR}" stroke-width="2"/>`;
      }
      g += `<circle cx="${line[0][0]}" cy="${line[0][1]}" r="${on ? 4.5 : 3.5}" fill="${PATH_COLOR}"/>`;
      if (on && !this.api.tools.tool) pts.forEach((q, i) => { const P = this.P(q); this.grips.push({ p: P, dir: [1, 0], path: p.id, idx: i }); g += gripMark(P[0], P[1], 4.5); });
    }
    return g;
  }
  // the airflow path under the pointer (within NEAR_PX of its curve), on this level
  pathAt(e) {
    const m = this.api.massing(), L = this.ctx.level();
    if (!m?.paths?.length) return null;
    const [x, y] = this.px(e);
    let best = null;
    for (const p of m.paths) {
      if (p.level !== L) continue;
      const line = pathCurve(p).map((q) => this.P(q));
      for (let i = 1; i < line.length; i++) { const d = segDist([x, y], line[i - 1], line[i]); if (d < NEAR_PX && (!best || d < best.d)) best = { d, id: p.id }; }
    }
    return best ? { kind: 'path', name: `path:${best.id}`, item: { id: best.id } } : null;
  }
  // Each open window's sash as a plan draws it: a side-hung sash its leaf and the arc of its edge, as a
  // door; one hung at its top or bottom the outline of the sash seen from above.
  windowSwings() {
    const c = this.picks(), v = this.api.view, o3 = v.origin || [0, 0, 0];
    let g = '';
    for (const w of c?.windows || []) {
      const sw = this.sashSeen(w.name);
      if (!sw) continue;
      if (sw.arc) {
        const { H, E, T } = sw, r = Math.hypot(E[0] - H[0], E[1] - H[1]), sweep = (E[0] - H[0]) * (T[1] - H[1]) - (E[1] - H[1]) * (T[0] - H[0]) > 0 ? 1 : 0;
        g += `<path d="M${E[0].toFixed(1)},${E[1].toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 ${sweep} ${T[0].toFixed(1)},${T[1].toFixed(1)}" fill="none" stroke="var(--ink3)" stroke-width="0.7" stroke-dasharray="3 2"/>`;
        g += line(H[0], H[1], T[0], T[1], { stroke: 'var(--glass)', w: 2 });
      } else g += poly(sw.outline, { stroke: 'var(--glass)', w: 1.2, fill: 'var(--glass)', op: 0.15 });
      void o3;
    }
    return g;
  }
  // An open window's sash on this plan (px): { arc: true, H (hinge), E (where its edge shuts), T (where
  // its edge is now) } for a side-hung one, else { outline }; null when it is shut.
  sashSeen(name) {
    const v = this.api.view, panel = v.swungPanel?.(name), w = v.model?.windows?.[name], o3 = v.origin || [0, 0, 0];
    if (!panel || !w) return null;
    const T = (p) => this.d.toPx(p[0] - o3[0], p[1] - o3[1]), sash = v.lastWindows?.[1]?.get(name);
    if (sash?.type === 'casement') {
      // seen from above, the sash and the window are each two points (their jambs); the hinge is the
      // sash's jamb on one of the window's, the tip its other
      const two = (P) => { const a = P[0], b = P.reduce((f, q) => (Math.hypot(q[0] - a[0], q[1] - a[1]) > Math.hypot(f[0] - a[0], f[1] - a[1]) ? q : f), a); return [a, b]; };
      const [j0, j1] = two(w.vertices), [s0, s1] = two(panel), d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const pairs = [[s0, s1, j0, j1], [s0, s1, j1, j0], [s1, s0, j0, j1], [s1, s0, j1, j0]].sort((x, y) => d(x[0], x[2]) - d(y[0], y[2]));
      const [hinge, tip, , shut] = pairs[0];
      return { arc: true, H: T(hinge), E: T(shut), T: T(tip) };
    }
    return { outline: panel.map(T) };
  }
  // Each open door cut here as a plan draws it: its leaf where it has swung to, and the arc its edge
  // swings through from shut.
  doorSwings() {
    const c = this.picks(), v = this.api.view, o3 = v.origin || [0, 0, 0];
    let g = '';
    for (const d of c?.doors || []) {
      const L = v.doorLeafNow?.(d.name);
      if (!L) continue;
      const T = (p) => this.d.toPx(p[0] - o3[0], p[1] - o3[1]), H = T(L.hinge), E = T(L.shut), P = T(L.tip), r = Math.hypot(E[0] - H[0], E[1] - H[1]);
      const sweep = (E[0] - H[0]) * (P[1] - H[1]) - (E[1] - H[1]) * (P[0] - H[0]) > 0 ? 1 : 0;
      g += `<path d="M${E[0].toFixed(1)},${E[1].toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 ${sweep} ${P[0].toFixed(1)},${P[1].toFixed(1)}" fill="none" stroke="var(--ink3)" stroke-width="0.7" stroke-dasharray="3 2"/>`;
      g += line(H[0], H[1], P[0], P[1], { stroke: '#9A5B34', w: 2 });
    }
    return g;
  }
  // A selected thing as the 3D view shows it: tinted in the selection's colour (walls and windows at
  // 0.42, a zone's floor lighter), outlined.
  selMark(f, strong) {
    const T = (p) => this.d.toPx(p[0], p[1]);
    let g = '';
    if (f.kind === 'zone') g += f.item.polys.map((P) => poly(P.map(T), { fill: SEL, op: 0.1 })).join('');
    else if ((f.kind === 'surface' || f.kind === 'wall') && f.item.loops.length) g += f.item.loops.map((L) => poly(L.map(T), { fill: SEL, op: 0.42 })).join('');
    else g += this.outline(f, { fill: SEL, op: 0.42 });
    return g + this.outline(f, { stroke: SEL, w: strong ? 1.6 : 1.2 });
  }
  // A wall's length as a dimension beside it (ticks at its ends, outward of the room), its figure typed
  // over with a click (in any unit): fig { kind: 'wall', id } or { kind: 'face', zone, face }, len (m).
  lengthDim(a, b, out, fig) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], o = 18;
    const A = [a[0] + out[0] * o, a[1] + out[1] * o], B = [b[0] + out[0] * o, b[1] + out[1] * o], tk = [(u[0] + out[0]) * 4, (u[1] + out[1]) * 4];
    this.lenFig = fig;
    let g = line(a[0] + out[0] * 4, a[1] + out[1] * 4, A[0] + out[0] * 4, A[1] + out[1] * 4, { stroke: 'var(--ink3)', w: 0.6, dash: '2 2' }) + line(b[0] + out[0] * 4, b[1] + out[1] * 4, B[0] + out[0] * 4, B[1] + out[1] * 4, { stroke: 'var(--ink3)', w: 0.6, dash: '2 2' });
    g += line(A[0], A[1], B[0], B[1], { stroke: 'var(--ink3)', w: 0.7 });
    for (const p of [A, B]) g += line(p[0] - tk[0], p[1] - tk[1], p[0] + tk[0], p[1] + tk[1], { stroke: 'var(--ink3)', w: 0.9 });
    const mid = [(A[0] + B[0]) / 2 + out[0] * 9, (A[1] + B[1]) / 2 + out[1] * 9 + 3];
    return g + label(mid[0], mid[1], `${Math.round(fig.len * 1000)} mm`, { size: 9, fill: 'var(--glass)', edit: 'w.len' });
  }
  // A wall's length typed: a drawn wall's far end moves along it; a zone's side grows or shrinks by its
  // far end's wall moving (square to it).
  setLength(f, L) {
    if (!(L > 0.05)) return;
    const what = `wall ${Math.round(L * 1000)} mm long`;
    if (f.kind === 'wall') {
      this.api.change((m) => { const w = m.walls.find((x) => x.id === f.id), d = [w.b[0] - w.a[0], w.b[1] - w.a[1]], l = Math.hypot(...d) || 1; moveWallEnd(m, f.id, 'b', [w.a[0] + (d[0] / l) * L, w.a[1] + (d[1] / l) * L]); }, what);
      return;
    }
    const m = this.api.massing(), n = m.zones[f.zone].plate.length, next = (f.face + 1) % n, u1 = faceAxes(m, f.zone, f.face).U, u2 = faceAxes(m, f.zone, next).U;
    if (Math.abs(u1[0] * u2[0] + u1[1] * u2[1]) > 0.05) return; // its far end not square to it: that wall is pushed instead
    this.api.change((x) => { pushWall(x, f.zone, next, L - f.len); }, what);
  }
  find(name) {
    const c = this.picks();
    const w = c.windows.find((x) => x.name === name); if (w) return { kind: 'window', item: w };
    const dr = c.doors.find((x) => x.name === name); if (dr) return { kind: 'door', item: dr };
    if (String(name).startsWith('path:')) return { kind: 'path', item: { id: Number(name.slice(5)) } };
    const s = c.walls.find((x) => x.name === name); if (s) return { kind: 'surface', item: s };
    const fw = c.free.find((x) => x.name === name); if (fw) return { kind: 'wall', item: fw };
    const z = c.zones.find((x) => x.name === name); if (z) return { kind: 'zone', item: z };
    return null;
  }
  outline({ kind, item }, o) {
    const T = (p) => this.d.toPx(p[0], p[1]);
    if (kind === 'path') return ''; // drawn heavier with its grips (pathsDrawn)
    // an open door: its leaf where it has swung to
    if (kind === 'door') {
      const Lf = this.api.view.doorLeafNow?.(item.name), o3 = this.api.view.origin || [0, 0, 0];
      if (Lf) item = { ...item, seg: [[Lf.hinge[0] - o3[0], Lf.hinge[1] - o3[1]], [Lf.tip[0] - o3[0], Lf.tip[1] - o3[1]]] };
    }
    // a zone: the outline of its floor as one, the seams between its pieces left out
    if (kind === 'zone') return outerEdges(item.polys).map(([a, b]) => { const A = T(a), B = T(b); return line(A[0], A[1], B[0], B[1], { stroke: o.stroke, w: o.w, dash: o.dash }); }).join('');
    // a window: where it stands now (an open sash where it has swung to)
    if (kind === 'window') {
      const panel = this.api.view.swungPanel?.(item.name), o3 = this.api.view.origin || [0, 0, 0];
      const seg = panel && cutLine(panel.map((p) => [p[0] - o3[0], p[1] - o3[1], p[2] - o3[2]]), this.zc);
      if (seg) item = { ...item, seg };
    }
    if ((kind === 'surface' || kind === 'wall') && item.loops.length) return item.loops.map((L) => poly(L.map(T), o)).join('');
    // a line: a narrow box around it
    // half as wide as a glazing unit or a door leaf is deep (50 mm) at the drawing's scale, so it keeps
    // to the pane as the plan is zoomed (as drawings.js draws the glass)
    const [a, b] = item.seg.map(T), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, h = Math.max(1.2, 0.05 * (this.d.cam?.s || 20)), nx = -dy / l * h, ny = dx / l * h;
    return poly([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], o);
  }
  // A massing's window, or wall with windows, selected: its array bracketed outside the wall, as in 3D -
  // a dotted line over the bays, a tick at each bay's edge (longer at the ends), their number and spacing.
  arrayFor(sel, m = this.api.massing(), grips = true) {
    const t = m && sel && this.api.massingTarget(sel);
    if (!t || !Number.isInteger(t.face) || !this.zonesHere(m).includes(t.zone)) return '';
    const g = m.zones[t.zone].faces[t.face], len = faceLength(m, t.zone, t.face), lay = g && unitLayout(g, len);
    if (!lay?.n) return '';
    const { A, U, n } = faceAxes(m, t.zone, t.face), mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2], OFF = 0.9;
    const at = (u, o = OFF) => this.P([mid[0] + U[0] * u + n[0] * o, mid[1] + U[1] * u + n[1] * o]);
    const pts = Array.from({ length: lay.n + 1 }, (_, j) => at(lay.first + (j - 0.5) * lay.pitch));
    const p0 = at(0), p1 = at(0, OFF + 1), dl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, tn = [(p1[0] - p0[0]) / dl, (p1[1] - p0[1]) / dl], col = 'var(--glass)';
    let out = line(pts[0][0], pts[0][1], pts[lay.n][0], pts[lay.n][1], { stroke: col, w: 1.2, dash: '2 3' });
    pts.forEach((p, j) => { const k = j === 0 || j === lay.n ? 6 : 3.5; out += line(p[0] - tn[0] * k, p[1] - tn[1] * k, p[0] + tn[0] * k, p[1] + tn[1] * k, { stroke: col }); });
    const q = at(lay.first + (lay.n / 2 - 0.5) * lay.pitch), lp = [q[0] + tn[0] * 14, q[1] + tn[1] * 14 + 3];
    out += label(lp[0] - 3, lp[1], `${lay.n} window${lay.n === 1 ? '' : 's'}`, { size: 9, fill: col, anchor: 'end', edit: 'a.count' });
    if (lay.n > 1) out += label(lp[0] + 3, lp[1], `@ ${Math.round(lay.pitch * 1000)} mm`, { size: 9, fill: col, anchor: 'start', edit: 'a.spacing' });
    if (!grips) return out;
    // the bracket's ends: grips that set the array's length; the figures: slid or typed
    const dir = [pts[lay.n][0] - pts[0][0], pts[lay.n][1] - pts[0][1]], dl2 = Math.hypot(...dir) || 1, ud = [dir[0] / dl2, dir[1] / dl2];
    const pxm = Math.hypot(at(1)[0] - at(0)[0], at(1)[1] - at(0)[1]) || 1; // px per metre along the face
    [0, lay.n].forEach((j, end) => {
      this.grips.push({ p: pts[j], dir: [ud[0] * pxm, ud[1] * pxm], span: end, zone: t.zone, face: t.face });
      out += gripMark(pts[j][0], pts[j][1], 4.5);
    });
    this.figs = { zone: t.zone, face: t.face, n: lay.n, pitch: lay.pitch, ud };
    return out;
  }
  // the grips of a massing's selected zone (each wall) or wall (its own); a selected window's jambs
  gripsFor(sel) {
    const m = this.api.massing();
    this.lenFig = null;
    // a window: a grip at each jamb, dragged outward or in, the width growing about its middle (as Edit
    // window in 3D's jambs); its width written beside it, a click types it
    const win = sel && this.api.windowWidth && this.picks()?.windows.find((w) => w.name === sel);
    if (win) {
      const [A, B] = win.seg.map((p) => this.d.toPx(p[0], p[1])), W = Math.hypot(win.seg[1][0] - win.seg[0][0], win.seg[1][1] - win.seg[0][1]);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
      let g = '';
      // a window of an array grows and shrinks about its middle (every window of the array alike); one
      // on its own moves the jamb dragged, the other staying (fixed: that one, view coordinates)
      const alone = !this.api.windowInArray?.(sel);
      [[A, [-u[0], -u[1]], 0], [B, u, 1]].forEach(([p, dir, jamb]) => { this.grips.push({ p, dir, win: sel, W, pxm: L / (W || 1), A, B, jamb, alone, fixed: win.seg[1 - jamb] }); g += gripMark(p[0], p[1], 4.5); });
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], nrm = [-u[1], u[0]];
      g += label(mid[0] + nrm[0] * 16, mid[1] + nrm[1] * 16 + 3, `w ${Math.round(W * 1000)} mm`, { size: 9, fill: 'var(--glass)', edit: 'w.width' });
      this.winFig = { name: sel, W };
      return g;
    }
    this.winFig = null;
    // a free wall: its two ends, where the cut passes through it
    if (m && String(sel || '').startsWith('wall:')) {
      const w = m.walls?.find((x) => x.id === Number(sel.slice(5)));
      if (!w || !this.picks()?.free.some((f) => f.id === w.id)) return '';
      let g = '';
      for (const end of ['a', 'b']) { const p = this.P(w[end]); this.grips.push({ p, dir: [1, 0], wall: w.id, end }); g += gripMark(p[0], p[1], 5); }
      const A = this.P(w.a), B = this.P(w.b), L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      g += this.lengthDim(A, B, [-(B[1] - A[1]) / L, (B[0] - A[0]) / L], { kind: 'wall', id: w.id, len: Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) });
      return g;
    }
    const t = m && sel && this.api.massingTarget(sel);
    if (!t || (t.face !== null && !Number.isInteger(t.face)) || !this.zonesHere(m).includes(t.zone)) return '';
    const P = m.zones[t.zone].plate, faces = t.face === null ? P.map((_, k) => k) : [t.face];
    let g = '';
    // one wall selected: its length, typed over
    if (t.face !== null) {
      const { A, U, n } = faceAxes(m, t.zone, t.face), len = faceLength(m, t.zone, t.face), a = this.P(A), b = this.P([A[0] + U[0] * len, A[1] + U[1] * len]);
      const mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2], p = this.P(mid), q = this.P([mid[0] + n[0], mid[1] + n[1]]), d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      g += this.lengthDim(a, b, [(q[0] - p[0]) / d, (q[1] - p[1]) / d], { kind: 'face', zone: t.zone, face: t.face, len });
    }
    for (const k of faces) {
      const { A, U, n } = faceAxes(m, t.zone, k), len = faceLength(m, t.zone, k), mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2];
      const p0 = this.P(mid), q = this.P([mid[0] + n[0], mid[1] + n[1]]), dir = [q[0] - p0[0], q[1] - p0[1]], L = Math.hypot(...dir) || 1;
      // a zone's handle stands 14 px inside it, off the wall (dragged, the wall moves for this zone
      // alone); a wall selected alone has its handle on it, moving it for every zone sharing it
      const inset = t.face === null ? 14 : 0, p = [p0[0] - (dir[0] / L) * inset, p0[1] - (dir[1] / L) * inset];
      this.grips.push({ p, dir, zone: t.zone, face: k, shared: t.face !== null });
      if (inset) g += line(p0[0], p0[1], p[0], p[1], { stroke: 'var(--glass)', w: 1 });
      g += gripMark(p[0], p[1], 5);
    }
    return g;
  }
  gripAt(e) { const [x, y] = this.px(e); return (this.grips || []).find((g) => Math.hypot(g.p[0] - x, g.p[1] - y) < 9) || null; }
  // the array's number or spacing under the pointer: { key, el } (or a window's width)
  figAt(e) {
    if (!this.figs && !this.winFig && !this.lenFig) return null;
    for (const el of this.d.ov.querySelectorAll('rect[data-edit]')) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) return { key: el.dataset.edit, el: el.nextElementSibling || el };
    }
    return null;
  }
  // the array as a drag would leave it (on a copy of the massing)
  arrayDraft(m, r) {
    const i = r.zone, f = r.face, g = m.zones[i].faces[f];
    if (!g) return;
    if (r.span !== undefined) { const [a, b] = bayExtents(g, faceLength(m, i, f)); setArraySpan(m, i, f, r.span ? a : a + r.d, r.span ? b + r.d : b); }
    else if (r.fig === 'a.count') setCount(g, Math.max(1, r.n0 + r.steps));
    else if (r.fig === 'a.spacing') setSpacing(g, Math.max(0.3, r.p0 + r.steps * 0.1));
    else if (r.pitch) dragPitch(m, i, f, r.index, r.u);
    spreadSide(m, i, f);
  }
  // the zones as they will be, while a grip is dragged
  dragDraw() {
    const r = this.drag, m = this.api.massing();
    if (!r || (!m && !r.win)) return '';
    if (r.win) {
      // the window as wide as it is being dragged: about its middle (in an array), or from its other jamb
      const c = [(r.A[0] + r.B[0]) / 2, (r.A[1] + r.B[1]) / 2], u = [(r.B[0] - r.A[0]) / 2, (r.B[1] - r.A[1]) / 2], k = (r.w ?? r.W) / (r.W || 1);
      let a = [c[0] - u[0] * k, c[1] - u[1] * k], b = [c[0] + u[0] * k, c[1] + u[1] * k];
      if (r.alone && r.jamb === 0) a = [r.B[0] - 2 * u[0] * k, r.B[1] - 2 * u[1] * k], b = r.B;
      if (r.alone && r.jamb === 1) a = r.A, b = [r.A[0] + 2 * u[0] * k, r.A[1] + 2 * u[1] * k];
      const L = Math.hypot(u[0], u[1]) || 1, n = [-u[1] / L, u[0] / L];
      return line(a[0], a[1], b[0], b[1], { stroke: 'var(--glass)', w: 3 }) + gripMark(a[0], a[1], 4.5) + gripMark(b[0], b[1], 4.5)
        + label(c[0] + n[0] * 16, c[1] + n[1] * 16 + 3, `w ${Math.round((r.w ?? r.W) * 1000)} mm`, { size: 9, fill: 'var(--glass)' });
    }
    if (r.span !== undefined || r.fig || r.pitch) {
      const trial = structuredClone(m);
      if (r.moved) this.arrayDraft(trial, r);
      return this.arrayFor(this.api.selected(), trial, false);
    }
    if (r.free !== undefined) {
      const w = m.walls?.find((x) => x.id === r.free);
      if (!w) return '';
      const A = this.P([w.a[0] + r.dv[0], w.a[1] + r.dv[1]]), B = this.P([w.b[0] + r.dv[0], w.b[1] + r.dv[1]]);
      return line(A[0], A[1], B[0], B[1], { stroke: 'var(--glass)', w: 2.4 }) + label((A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 12, `${Math.round(Math.hypot(...r.dv) * 1000)} mm`, { size: 9, fill: 'var(--glass)' });
    }
    if (r.path !== undefined) return '';
    if (r.end) {
      const w = m.walls?.find((x) => x.id === r.wall);
      if (!w) return '';
      const a = r.end === 'a' && r.p ? r.p : w.a, b = r.end === 'b' && r.p ? r.p : w.b, A = this.P(a), B = this.P(b);
      return line(A[0], A[1], B[0], B[1], { stroke: 'var(--glass)', w: 2 }) + (r.p ? this.api.tools.snapMark(r.end === 'a' ? A : B, r.kind) : '')
        + gripMark(A[0], A[1], 5) + gripMark(B[0], B[1], 5)
        + label((A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 12, `${Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1000)} mm`, { size: 9, fill: 'var(--glass)' });
    }
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
    this.over = true;
    if (this.press && !this.drag) {
      const dx = e.clientX - this.press.x, dy = e.clientY - this.press.y;
      if (!this.box && Math.hypot(dx, dy) > CLICK_PX) { const [x, y] = this.px({ clientX: this.press.x, clientY: this.press.y }); this.box = { x0: x, y0: y, x1: x, y1: y }; }
      if (this.box) { [this.box.x1, this.box.y1] = this.px(e); this.paint(); return; }
    }
    if (this.drag) {
      const r = this.drag, dx = e.clientX - r.x0, dy = e.clientY - r.y0;
      if (!r.moved && Math.hypot(dx, dy) < CLICK_PX) return;
      r.moved = true;
      if (r.free !== undefined) { const q = this.toMassing(e), step = e.shiftKey ? 0.1 : STEP; r.dv = [q[0] - r.q0[0], q[1] - r.q0[1]].map((v) => Math.round(v / step) * step); this.paint(); return; }
      if (r.win) { const run = (dx * r.dir[0] + dy * r.dir[1]) / r.pxm; r.w = Math.max(0.3, Math.round((r.W + (r.alone ? 1 : 2) * run) / 0.005) * 0.005); this.paint(); return; }
      if (r.fig) { const along = dx * this.figs.ud[0] + dy * this.figs.ud[1]; r.steps = Math.round(along / 12); this.paint(); return; }
      if (r.pitch) {
        const m = this.api.massing(), { A, U } = faceAxes(m, r.zone, r.face), len = faceLength(m, r.zone, r.face), q = this.toMassing(e);
        r.u = (q[0] - A[0] - U[0] * len / 2) * U[0] + (q[1] - A[1] - U[1] * len / 2) * U[1];
        this.paint();
        return;
      }
      if (r.path !== undefined) { r.q = this.toMassing(e); this.paint(); return; }
      if (r.end) {
        const m = this.api.massing(), w = m?.walls?.find((x) => x.id === r.wall);
        if (w) { const s = this.api.tools.snapEnd(this.ctx, e, m, this.toMassing(e), w, r.end === 'a' ? w.b : w.a); r.p = s.p; r.kind = s.kind; }
        this.paint();
        return;
      }
      const l2 = r.dir[0] ** 2 + r.dir[1] ** 2 || 1, step = e.shiftKey ? 0.1 : STEP;
      r.d = Math.round(((dx * r.dir[0] + dy * r.dir[1]) / l2) / step) * step;
      this.paint();
      return;
    }
    if (this.api.tools.tool) return;
    // the Window tool: a window offered on the wall under the pointer, where it would go
    if (this.api.placing?.()) {
      const h = this.pickAt(e), o3 = this.api.view.origin || [0, 0, 0], q = this.d.fromPx(...this.px(e));
      this.offer = h?.kind === 'surface' ? this.api.offerAt(h.name, [q[0] + o3[0], q[1] + o3[1], this.zc + o3[2]]) : null;
      this.d.host.style.cursor = this.offer ? 'copy' : 'not-allowed';
      this.paint();
      return;
    }
    const g = this.gripAt(e), h = g ? null : this.pickAt(e);
    const fg = !g && this.figAt(e);
    if (fg) { this.d.host.style.cursor = 'ew-resize'; return; }
    this.d.host.style.cursor = g ? (g.end || g.span !== undefined ? 'move' : Math.abs(g.dir[0]) > Math.abs(g.dir[1]) ? 'ew-resize' : 'ns-resize') : h ? 'pointer' : '';
    if ((h?.name || null) !== (this.hover?.name || null)) { this.hover = h; if (!this.chain?.includes(h?.name)) this.chain = null; this.paint(); }
  }
  leave() { this.over = false; if (this.hover || this.chain) { this.hover = null; this.chain = null; this.paint(); } }
  down(e) {
    if (this.api.tools.tool) { this.api.tools.press(e); return; }
    if (this.api.placing?.()) { if (this.offer && !this.offer.problem) this.api.placeOffer(this.offer); return; }
    const g = this.gripAt(e);
    if (g) {
      this.drag = { ...g, x0: e.clientX, y0: e.clientY, d: 0, moved: false };
      this.d.host.setPointerCapture?.(e.pointerId);
      return;
    }
    // the array's number or spacing: slid along the bracket, or clicked to type
    const fg = this.figAt(e);
    if (fg && fg.key === 'w.len') {
      const lf = this.lenFig;
      askNumber(this.d.host, { clientX: e.clientX, clientY: e.clientY, target: fg.el }, `length mm, now ${Math.round(lf.len * 1000)}`, (x) => { this.setLength(lf, x / 1000); this.paint(); });
      return;
    }
    if (fg && fg.key === 'w.width') {
      const wf = this.winFig;
      askNumber(this.d.host, { clientX: e.clientX, clientY: e.clientY, target: fg.el }, `width mm, now ${Math.round(wf.W * 1000)}`, (x) => { if (x >= 300) this.api.windowWidth(wf.name, x / 1000); this.paint(); });
      return;
    }
    if (fg) {
      const f = this.figs;
      this.drag = { fig: fg.key, el: fg.el, zone: f.zone, face: f.face, n0: f.n, p0: f.pitch, steps: 0, x0: e.clientX, y0: e.clientY, moved: false };
      this.d.host.setPointerCapture?.(e.pointerId);
      return;
    }
    // a window of an array pressed: dragged along its wall, it sets the spacing (it is selected, so its
    // array shows as it goes); let go where pressed, it is picked. This wins over a box.
    const h = this.pickAt(e), t = h?.kind === 'window' && this.api.massingTarget(h.name);
    if (t && Number.isInteger(t.window)) {
      if (this.api.selected() !== h.name && !e.shiftKey) this.api.selectNames([h.name]);
      this.drag = { pitch: true, zone: t.zone, face: t.face, index: t.window, u: 0, x0: e.clientX, y0: e.clientY, moved: false, press: h.name };
      this.d.host.setPointerCapture?.(e.pointerId);
      return;
    }
    // a wall pressed: dragged, it moves (for every zone sharing it); let go where pressed, it is picked
    const wt = h?.kind === 'surface' && this.api.massingTarget(h.name), m = this.api.massing();
    if (wt && Number.isInteger(wt.face) && this.zonesHere(m).includes(wt.zone)) {
      const { A, U, n } = faceAxes(m, wt.zone, wt.face), len = faceLength(m, wt.zone, wt.face), mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2];
      const p = this.P(mid), q = this.P([mid[0] + n[0], mid[1] + n[1]]);
      this.drag = { p, dir: [q[0] - p[0], q[1] - p[1]], zone: wt.zone, face: wt.face, shared: true, press: h.name, x0: e.clientX, y0: e.clientY, d: 0, moved: false };
      this.d.host.setPointerCapture?.(e.pointerId);
      return;
    }
    if (h?.kind === 'wall') {
      this.drag = { free: h.item.id, press: h.name, q0: this.toMassing(e), dv: [0, 0], x0: e.clientX, y0: e.clientY, moved: false };
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
      // pressed and let go where it was: picked
      if (r.press && !r.moved) { this.api.selectNames(this.chain?.includes(r.press) ? this.chain : [r.press], e.shiftKey); this.chain = null; this.paint(); return; }
      if (r.win) {
        const set = (w) => (r.alone && this.api.windowEdge ? this.api.windowEdge(r.win, r.fixed, w) : this.api.windowWidth(r.win, w));
        if (r.moved && r.w && Math.abs(r.w - r.W) > 1e-6) set(r.w);
        else if (!r.moved) askNumber(this.d.host, e, `width mm, now ${Math.round(r.W * 1000)}`, (x) => { if (x >= 300) set(x / 1000); this.paint(); });
        this.paint();
        return;
      }
      if (r.free !== undefined) {
        if (r.dv[0] || r.dv[1]) this.api.change((m) => { moveWall(m, r.free, r.dv); }, 'wall moved');
        this.paint();
        return;
      }
      if (r.path !== undefined) {
        if (r.moved && r.q) this.api.change((m) => { movePathPoint(m, r.path, r.idx, r.q); }, 'airflow path point moved');
        this.paint();
        return;
      }
      if (r.end) {
        if (r.p) this.api.change((m) => { moveWallEnd(m, r.wall, r.end, r.p); }, 'wall end moved');
        this.paint();
        return;
      }
      if (r.span !== undefined || r.fig || r.pitch) {
        const m0 = this.api.massing(), i = r.zone, f = r.face, g0 = m0.zones[i].faces[f];
        if (r.moved) this.api.change((m) => this.arrayDraft(m, r), r.pitch ? 'windows set out by dragging' : r.fig === 'a.count' ? 'window count set' : r.fig === 'a.spacing' ? 'window spacing set' : 'window array length set');
        else if (r.fig === 'a.count') askNumber(this.d.host, { clientX: e.clientX, clientY: e.clientY, target: r.el }, `windows, now ${r.n0}`, (x) => this.api.change((m) => { setCount(m.zones[i].faces[f], x); spreadSide(m, i, f); }, `${Math.round(x)} windows`));
        else if (r.fig === 'a.spacing') askNumber(this.d.host, { clientX: e.clientX, clientY: e.clientY, target: r.el }, `spacing mm, now ${Math.round(r.p0 * 1000)}`, (x) => this.api.change((m) => { setSpacing(m.zones[i].faces[f], x / 1000); spreadSide(m, i, f); }, `windows at ${Math.round(x)} mm`));
        else if (r.span !== undefined && g0) {
          const [a, b] = bayExtents(g0, faceLength(m0, i, f));
          askNumber(this.d.host, e, `array length mm, now ${Math.round((b - a) * 1000)}`, (x) => this.api.change((m) => { setArraySpan(m, i, f, r.span ? a : b - x / 1000, r.span ? a + x / 1000 : b); spreadSide(m, i, f); }, 'window array length set'));
        }
        this.paint();
        return;
      }
      const what = (d) => `${r.shared ? 'wall' : 'zone face'} ${d > 0 ? 'pushed out' : 'pulled in'} ${Math.round(Math.abs(d) * 1000)} mm`;
      if (!r.moved) askNumber(this.d.host, e, 'push out (+) or in (−), mm', (x) => this.api.change((m) => this.push(m, r, x / 1000), what(x / 1000)), true);
      else if (r.taken) this.api.change((m) => this.push(m, r, r.taken), what(r.taken));
      this.paint();
      return;
    }
    const p = this.press, box = this.box;
    this.press = null; this.box = null;
    // a box: what it holds (drawn to the right) or touches (to the left); Shift adds it
    if (box) { this.api.selectNames(this.inBox(box), e.shiftKey); this.paint(); return; }
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) return;
    const h = this.pickAt(e);
    // a zone comes with its walls; Tab's chain whole; Shift adds to what is selected
    const names = !h ? [] : this.chain?.includes(h.name) ? this.chain : h.kind === 'zone' ? [...this.zoneWalls(h.name), h.name] : [h.name];
    this.chain = null;
    this.api.selectNames(names, e.shiftKey);
  }
  dispose() { this.unregister?.(); removeEventListener('keydown', this.onKey, true); }
}

// The edges of polygons (plan points) that no other of them shares: their outline as one. Each edge is
// split where another's corner lies along it, so pieces meeting at a T-junction match up.
function outerEdges(polys) {
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`, corners = [...new Map(polys.flat().map((p) => [key(p), p])).values()], count = new Map();
  for (const P of polys) P.forEach((a, i) => {
    const b = P[(i + 1) % P.length], d = [b[0] - a[0], b[1] - a[1]], L2 = d[0] ** 2 + d[1] ** 2;
    if (!L2) return;
    const cut = corners.map((q) => [((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2, q]).filter(([t, q]) => t > 1e-4 && t < 1 - 1e-4 && Math.hypot(a[0] + d[0] * t - q[0], a[1] + d[1] * t - q[1]) < 0.002).sort((x, y) => x[0] - y[0]).map((c) => c[1]);
    const pts = [a, ...cut, b];
    for (let k = 0; k + 1 < pts.length; k++) {
      const ka = key(pts[k]), kb = key(pts[k + 1]), id = ka < kb ? ka + '|' + kb : kb + '|' + ka, e = count.get(id);
      if (e) e.n++; else count.set(id, { a: pts[k], b: pts[k + 1], n: 1 });
    }
  });
  return [...count.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
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
