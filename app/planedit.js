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
import { gripMark, label, line, poly, inside, segDist, CLICK_PX } from './handles.js';
import { zoneLevels, turnPlan, faceAxes, faceLength, pushFace, pushWall, moveWallEnd, moveWall, unitLayout, bayExtents, setArraySpan, setCount, setSpacing, spreadSide, dragPitch } from '../src/model/massing.js';
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
      pointAt: (e) => this.toMassing(e),
      // the level this plan is cut above (walls drawn here stand on it)
      level: () => { const v = this.d.item; return v?.kind === 'plan' && Number.isInteger(v.level) ? v.level : null; },
    };
    this.unregister = api.tools.register(this.ctx);
    // Tab over a wall: the walls chained to it (end to end) offered, and picked by the next click
    this.onKey = (e) => {
      if (e.key !== 'Tab' || !this.over || this.api.tools.tool || e.target.closest?.('input, select, textarea')) return;
      if (!this.hover || !['surface', 'wall'].includes(this.hover.kind)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.chain = this.chain ? null : this.chainOf(this.hover.name);
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
    // the drawn walls standing free that the cut passes through: their footprint at their thickness
    const free = [];
    for (const w of v.freeList || []) {
      if (!(w.z0 - o3[2] <= zc + 1e-6 && w.z1 - o3[2] > zc + 1e-6)) continue;
      const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], l = Math.hypot(dx, dy) || 1, n = [-dy / l, dx / l], s0 = w.off - w.t / 2, s1 = w.off + w.t / 2;
      const Q = (p, s) => [p[0] + n[0] * s - o3[0], p[1] + n[1] * s - o3[1]];
      free.push({ name: `wall:${w.id}`, id: w.id, seg: [Q(w.a, w.off), Q(w.b, w.off)], loops: [[Q(w.a, s0), Q(w.b, s0), Q(w.b, s1), Q(w.a, s1)]] });
    }
    this.cache = { key: this.d.key, walls, windows, free, zones: [...zones].map(([name, polys]) => ({ name, polys })) };
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
    for (const n of this.api.selection?.() || []) { if (n === sel) continue; const f = this.find(n); if (f) g += this.outline(f, { stroke: 'var(--glass)', w: 1.2 }); }
    if (selPick) g += this.outline(selPick, { stroke: 'var(--glass)', w: 1.5 });
    for (const n of this.chain || []) { const f = this.find(n); if (f) g += this.outline(f, { stroke: 'var(--glass)', w: 2.4, dash: '6 4' }); }
    for (const n of this.api.mergeAsk?.() || []) { const f = this.find(n); if (f) g += this.outline(f, { stroke: '#D9822B', w: 3 }); }
    if (this.box) {
      const b = this.box, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
      g += `<rect x="${x}" y="${y}" width="${Math.abs(b.x1 - b.x0)}" height="${Math.abs(b.y1 - b.y0)}" fill="var(--glass)" fill-opacity="0.06" stroke="var(--glass)" stroke-width="1"${b.x1 < b.x0 ? ' stroke-dasharray="5 3"' : ''}/>`;
    }
    if (this.hover && this.hover.name !== sel && !this.api.tools.tool) g += this.outline(this.hover, { stroke: 'var(--glass)', w: 2.6, dash: '6 4' });
    this.grips = [];
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
  find(name) {
    const c = this.picks();
    const w = c.windows.find((x) => x.name === name); if (w) return { kind: 'window', item: w };
    const s = c.walls.find((x) => x.name === name); if (s) return { kind: 'surface', item: s };
    const fw = c.free.find((x) => x.name === name); if (fw) return { kind: 'wall', item: fw };
    const z = c.zones.find((x) => x.name === name); if (z) return { kind: 'zone', item: z };
    return null;
  }
  outline({ kind, item }, o) {
    const T = (p) => this.d.toPx(p[0], p[1]);
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
    const [a, b] = item.seg.map(T), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, h = kind === 'window' ? 4 : 3, nx = -dy / l * h, ny = dx / l * h;
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
    // a window: a grip at each jamb, dragged outward or in, the width growing about its middle (as Edit
    // window in 3D's jambs); its width written beside it, a click types it
    const win = sel && this.api.windowWidth && this.picks()?.windows.find((w) => w.name === sel);
    if (win) {
      const [A, B] = win.seg.map((p) => this.d.toPx(p[0], p[1])), W = Math.hypot(win.seg[1][0] - win.seg[0][0], win.seg[1][1] - win.seg[0][1]);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
      let g = '';
      [[A, [-u[0], -u[1]]], [B, u]].forEach(([p, dir]) => { this.grips.push({ p, dir, win: sel, W, pxm: L / (W || 1), A, B }); g += gripMark(p[0], p[1], 4.5); });
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
      return g;
    }
    const t = m && sel && this.api.massingTarget(sel);
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
  // the array's number or spacing under the pointer: { key, el } (or a window's width)
  figAt(e) {
    if (!this.figs && !this.winFig) return null;
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
      // the window as wide as it is being dragged, about its middle
      const c = [(r.A[0] + r.B[0]) / 2, (r.A[1] + r.B[1]) / 2], u = [(r.B[0] - r.A[0]) / 2, (r.B[1] - r.A[1]) / 2], k = (r.w ?? r.W) / (r.W || 1);
      const a = [c[0] - u[0] * k, c[1] - u[1] * k], b = [c[0] + u[0] * k, c[1] + u[1] * k], L = Math.hypot(u[0], u[1]) || 1, n = [-u[1] / L, u[0] / L];
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
      if (r.win) { const run = (dx * r.dir[0] + dy * r.dir[1]) / r.pxm; r.w = Math.max(0.3, Math.round((r.W + 2 * run) / 0.005) * 0.005); this.paint(); return; }
      if (r.fig) { const along = dx * this.figs.ud[0] + dy * this.figs.ud[1]; r.steps = Math.round(along / 12); this.paint(); return; }
      if (r.pitch) {
        const m = this.api.massing(), { A, U } = faceAxes(m, r.zone, r.face), len = faceLength(m, r.zone, r.face), q = this.toMassing(e);
        r.u = (q[0] - A[0] - U[0] * len / 2) * U[0] + (q[1] - A[1] - U[1] * len / 2) * U[1];
        this.paint();
        return;
      }
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
    // the selected window pressed again: dragged along its wall, it sets the spacing
    const sel = this.api.selected(), h = this.pickAt(e), t = sel && h?.kind === 'window' && h.name === sel && this.api.massingTarget(sel);
    if (t && Number.isInteger(t.window)) {
      this.drag = { pitch: true, zone: t.zone, face: t.face, index: t.window, u: 0, x0: e.clientX, y0: e.clientY, moved: false };
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
        if (r.moved && r.w && Math.abs(r.w - r.W) > 1e-6) this.api.windowWidth(r.win, r.w);
        else if (!r.moved) askNumber(this.d.host, e, `width mm, now ${Math.round(r.W * 1000)}`, (x) => { if (x >= 300) this.api.windowWidth(r.win, x / 1000); this.paint(); });
        this.paint();
        return;
      }
      if (r.free !== undefined) {
        if (r.dv[0] || r.dv[1]) this.api.change((m) => { moveWall(m, r.free, r.dv); }, 'wall moved');
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
