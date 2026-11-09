// A massing's zone edited in the 3D view, with the Solar Shading Explorer's handles (handles.js, from
// the edit-handles skill), drawn as an SVG over the view. Zones stand on levels (src/model/massing.js):
// moving a zone's roof or floor moves its level, and so every zone on it.
//
// With its whole zone selected:
//  - a square grip on each face turned toward the eye pushes or pulls it: a face takes its edge of the
//    footprint (its neighbours keep their lines), the roof raises the zone's top level and every level
//    above. The floor's grip always shows (it faces away from a view from above): it moves the zone's
//    base level alone, into the zones below;
//  - a gumball on its floor, drawn at model size: red and green arrows along its own axes, the square
//    between them to move it freely on its floor, the arc between them to turn it; off the ground a blue
//    arrow raises it (its base level and every level above rise, the zones below growing to meet it).
//    On the ground it has the arc only;
//  - the length of each face turned toward the eye and its height dimensioned on the drawing, and its
//    turn beside the arc, each typed over (a face's length moves the face after it).
// With one surface selected: its own grip, and a grip on each of its edges that moves the face beyond
// that edge: a wall's top edge is the roof, its bottom the floor, its sides the faces either side.
// A wall's own grip moves it for every zone sharing it (one grows as the other shrinks); with the whole
// zone selected, its grips move its own faces alone, so a shared wall becomes two.
//
// A face selected (a wall, or a window of it) shows its windows' array as a dotted bracket over their
// heads, its number and spacing typed over (the facade-windows skill); not while a window is isolated.
// A window of an array pressed and moved 4 px is selected and dragged along its face: where the pointer
// is sets the array's pitch (by spacing) or its count (by number), the windows drawn as they will be.
// Windows broken out of their array are outlined dashed in the sun's colour whenever not selected.
//
// A press under 3 px is a click: an arrow, grip or arc then asks how far. Each drag or typed figure is
// one edit, made through onChange(mutate, what) when the pointer is let go; while dragging, the
// zones as they will be are drawn in outline.

import * as THREE from 'three';
import { askNumber } from './sections.js';
import { AXIS, CLICK_PX, gripMark, gripAt, cursorFor, dragLength, dragAngle, angleOf, dragOnPlane, screenDir, dim, label, line, head, path, poly, circle, arrayBracket } from './handles.js';
import { isSeam, slideSeam, moveZone, turnPlan, bayExtents, setArraySpan, zoneFrame, pushFace, pushWall, moveStorey, turnZone, unitLayout, unitOf, windowHeights, setCount, setSpacing, spreadSide, dragPitch, sideWindows, faceLength, zoneHeight, faceBearing, compassWord } from '../src/model/massing.js';

// A face named for the way it looks ('south face'), or the roof or floor.
const faceName = (m, i, f) => (f === 'roof' || f === 'floor' ? f : `${{ N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' }[compassWord(faceBearing(m, i, f))]} face`);
const unit2 = (d) => { const l = Math.hypot(d[0], d[1]); return l < 1e-9 ? [1, 0] : [d[0] / l, d[1] / l]; };

export class MassingEditor {
  // massing() -> the massing; onChange(mutate, what).
  // brokenWindows() -> the outlines (model points) of the windows broken out of their arrays, unselected.
  // isolated() -> a window is being edited in 3D; windowAt(e) -> { zone, face, index, name } of a
  // massing's window under the pointer, or null; onPick(name) selects it.
  constructor(view, { massing, onChange, brokenWindows = () => [], isolated = () => false, windowAt = () => null, onPick = () => {} }) {
    Object.assign(this, { view, massing, onChange, brokenWindows, isolated, windowAt, onPick });
    this.target = null; // { zone, face }: face null for the whole zone, else an index, 'roof' or 'floor'
    this.grips = [];
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles');
    view.container.appendChild(this.svg);
    // A figure is taken on press: the overlay is redrawn with every frame while the air moves, so a
    // press and its release can land on two different copies of it and never make a click.
    this.svg.addEventListener('pointerdown', (e) => {
      const f = e.target.closest('[data-edit]');
      if (!f || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.typeFigure(e, f.dataset.edit);
    });
    this.wire();
    this.wirePitch();
  }

  get active() { return !!this.target; }
  start(target) { this.target = target; this.draft = null; this.draw(); }
  stop() {
    if (!this.target) return;
    this.target = null; this.draft = null; this.grips = [];
    this.svg.innerHTML = this.shown = '';
    this.view.render();
  }
  // The massing changed (an edit, undo or redo): the handles as it is now.
  refresh() {
    if (!this.target) return;
    const m = this.massing();
    if (!m || this.target.zone >= m.zones.length) { this.stop(); return; }
    this.draft = null;
    this.draw();
  }

  // A model point (the building's coordinates) on the sheet, in pixels over the canvas.
  P = (p) => {
    const o = this.view.origin, s = this.view.sections.screen(new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2]));
    return [s.x, s.y];
  };
  // Whether a face at `at` with normal n is turned toward the eye.
  facing(at, n) {
    const c = this.view.camera, o = this.view.origin;
    const eye = c.isOrthographicCamera ? c.getWorldDirection(new THREE.Vector3()).negate()
      : c.position.clone().sub(new THREE.Vector3(at[0] - o[0], at[1] - o[1], at[2] - o[2]));
    return eye.normalize().dot(new THREE.Vector3(...n)) > 0.05;
  }

  // Redrawn before every render, as the camera moves.
  beforeRender() { this.draw(false); }

  draw(render = true) {
    const m = this.draft || this.massing();
    const canvas = this.view.renderer.domElement, cr = canvas.getBoundingClientRect(), kr = this.view.container.getBoundingClientRect();
    Object.assign(this.svg.style, { left: `${cr.left - kr.left}px`, top: `${cr.top - kr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` });
    const P = this.P, grips = [];
    let g = m ? this.brokenWindows().map((v) => poly(v.map(P), { stroke: 'var(--sun)', w: 1.2, dash: '3 2' })).join('') : '';
    if (!this.target || !m) {
      this.grips = [];
      if (this.shown !== g) this.svg.innerHTML = this.shown = g;
      return;
    }
    const { zone: i, face } = this.target, fr = zoneFrame(m, i);
    if (this.draft) { // the zones as they will be
      for (let k = 0; k < m.zones.length; k++) {
        const f = zoneFrame(m, k), lo = f.corners.map((c) => P([c[0], c[1], f.z0])), hi = f.corners.map((c) => P([c[0], c[1], f.z1]));
        g += poly(lo, { stroke: 'var(--glass)', w: 1.2 }) + poly(hi, { stroke: 'var(--glass)', w: 1.2 });
        for (let j = 0; j < lo.length; j++) g += line(lo[j][0], lo[j][1], hi[j][0], hi[j][1], { stroke: 'var(--glass)', w: 1.2 });
      }
    }
    const faceGrip = (f, half = 5, low = false) => {
      const p = P(f.at);
      grips.push({ p, key: { kind: 'face', face: f.key }, from: 0, dir: screenDir(P, f.at, f.normal), low });
      return gripMark(p[0], p[1], half);
    };
    if (this.target.window !== undefined) g += this.isolated() ? '' : this.bracket(m, i, face, grips); // a window: its array alone
    else if (face === null) {
      // the floor: its gumball, and the floor's own grip in the quarter the gumball leaves free
      const C = [fr.centre[0], fr.centre[1], fr.z0], ex = fr.x, ey = fr.y;
      // the arrows a quarter of the footprint's smaller extent along its own axes, 2 to 10 m
      const ext = (ax) => { const d = fr.corners.map((c) => c[0] * ax[0] + c[1] * ax[1]); return Math.max(...d) - Math.min(...d); };
      const z = m.zones[i], GL = Math.min(10, Math.max(2, Math.min(ext(ex), ext(ey)) / 4));
      g += this.gumball(grips, C, ex, ey, GL, z.base > 0, z.rot || 0);
      for (const f of fr.faces) {
        if (f.key === 'floor') {
          const at = [C[0] - 0.45 * GL * (ex[0] + ey[0]), C[1] - 0.45 * GL * (ex[1] + ey[1]), C[2]];
          g += faceGrip({ ...f, at });
        } else if (this.facing(f.at, f.normal)) g += faceGrip(f);
      }
      g += this.dims(m, fr, i);
    } else {
      const f = fr.faces.find((x) => x.key === face);
      if (f) {
        g += this.edges(grips, fr, face, i);
        g += faceGrip(f);
        if (Number.isInteger(face)) g += this.bracket(m, i, face, grips);
      }
    }
    if (this.pitchDraft) g += this.sideOutlines(this.pitchDraft);
    this.grips = grips;
    if (this.shown !== g) this.svg.innerHTML = this.shown = g; // only when it changed
    if (render) this.view.render();
  }

  // The floor gumball (handles.js floorGumball's), with a blue arrow up on zones off the ground and the arc
  // alone on the ground floor; the turn typed beside the arc.
  gumball(grips, C, ex, ey, GL, arrows, rot) {
    const P = this.P, at = (u, v, w = 0) => P([C[0] + u * ex[0] + v * ey[0], C[1] + u * ex[1] + v * ey[1], C[2] + w]), o = at(0, 0);
    let g = '';
    const arc = [];
    for (let k = 0; k <= 16; k++) { const t = ((18 + (k / 16) * 54) * Math.PI) / 180; arc.push(at(GL * Math.cos(t), GL * Math.sin(t))); }
    g += path(arc, { stroke: 'var(--glass)', w: 1.8 });
    for (const [a, b] of [[arc[0], arc[2]], [arc[16], arc[14]]]) { const u = unit2([a[0] - b[0], a[1] - b[1]]); g += head(a[0] + u[0] * 3, a[1] + u[1] * 3, u[0], u[1], 'var(--glass)', 9, 4.5); }
    const floor = { H: o, A: screenDir(P, C, [ex[0], ex[1], 0]), B: screenDir(P, C, [ey[0], ey[1], 0]) };
    grips.push({ arc, rot: true, pivot: o, plane: floor, key: { kind: 'rot' }, from: 0 });
    const t = at(GL * 1.18 * Math.cos(Math.PI / 4), GL * 1.18 * Math.sin(Math.PI / 4));
    g += label(t[0], t[1], `${+rot.toFixed(1)}°`, { edit: 'rot' });
    if (arrows) {
      for (const [d, col, k, w] of [[[1, 0], AXIS.x, 'x', 0], [[0, 1], AXIS.y, 'y', 0], [[0, 0], AXIS.z, 'z', 1]]) {
        const q = at(d[0], d[1], w), s = [q[0] - o[0], q[1] - o[1]], u = unit2(s), tip = [o[0] + s[0] * GL, o[1] + s[1] * GL];
        if (Math.hypot(s[0], s[1]) < 1e-3) continue; // seen end on
        g += line(o[0], o[1], tip[0] - u[0] * 7, tip[1] - u[1] * 7, { stroke: col, w: 1.8 }) + head(tip[0], tip[1], u[0], u[1], col);
        grips.push({ p: tip, o, arrow: true, key: { kind: 'move', axis: k }, from: 0, dir: s, sgn: 1 });
      }
      const sq = [[0.32, 0.32], [0.62, 0.32], [0.62, 0.62], [0.32, 0.62]].map(([a, b]) => at(GL * a, GL * b));
      grips.push({ plane: sq, move: true, floor, key: { kind: 'free' } });
      g += poly(sq, { fill: 'var(--glass)', op: 0.35, stroke: 'var(--glass)', w: 1.2 });
    }
    return g + circle(o[0], o[1], 3, { fill: 'var(--ink2)' });
  }

  // A side's array bracketed: a dotted line through its windows' middles 0.6 m out from the facade, at
  // the zone's height less 150 mm or 450 mm over the heads, a tick at each window, its number and spacing.
  // Its line runs over the bays, end to end, a tick at each bay's edge; a grip at each end sets the
  // array's length (the other end held), and typed with a click.
  bracket(m, i, f, grips) {
    const z = m.zones[i], g = z.faces[f];
    if (!g) return '';
    const fr = zoneFrame(m, i), A = fr.corners[f], B = fr.corners[(f + 1) % fr.corners.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const lay = unitLayout(g, len);
    if (!lay.n) return '';
    const U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], n = fr.faces.find((x) => x.key === f).normal, mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const h = zoneHeight(m, i), top = h - (z.slab || 0), heads = Array.from({ length: lay.n }, (_, j) => windowHeights(unitOf(g, j), top).head);
    const v = Math.min(h - 0.15, Math.max(...heads) + 0.45);
    const at = (u) => [mid[0] + U[0] * u + n[0] * 0.6, mid[1] + U[1] * u + n[1] * 0.6, fr.z0 + v];
    const pts = Array.from({ length: lay.n + 1 }, (_, j) => this.P(at(lay.first + (j - 0.5) * lay.pitch)));
    let out = arrayBracket(pts, true, lay.n, lay.pitch, 'window');
    if (this.draft || !grips) return out;
    [lay.first - lay.pitch / 2, lay.first + (lay.n - 0.5) * lay.pitch].forEach((u, end) => {
      const p = this.P(at(u));
      grips.push({ p, key: { kind: 'span', end }, from: 0, dir: screenDir(this.P, at(u), [U[0], U[1], 0]) });
      out += gripMark(p[0], p[1]);
    });
    return out;
  }

  // A face's frame: its middle and its run (model axes) and the zone's floor level.
  side(m, i, f) {
    const fr = zoneFrame(m, i), A = fr.corners[f], B = fr.corners[(f + 1) % fr.corners.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    return { fr, len, U: [(B[0] - A[0]) / len, (B[1] - A[1]) / len], mid: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], n: fr.faces.find((x) => x.key === f).normal };
  }
  // The windows of a side as a dragged pitch would make them, outlined.
  sideOutlines({ m, zone: i, face: f }) {
    const z = m.zones[i], { fr, len, U, mid, n } = this.side(m, i, f), at = (u, v) => this.P([mid[0] + U[0] * u + n[0] * 0.05, mid[1] + U[1] * u + n[1] * 0.05, fr.z0 + v]);
    return sideWindows(z.faces[f], len, zoneHeight(m, i), z.slab).map((w) => poly([at(w.u0, w.v0), at(w.u1, w.v0), at(w.u1, w.v1), at(w.u0, w.v1)], { stroke: 'var(--glass)', w: 1.4, dash: '4 3' })).join('');
  }
  // Where the pointer is along a side, from its middle (m), on the side's plane.
  alongSide(e, i, f) {
    const m = this.massing(), { fr, U, mid, n } = this.side(m, i, f), o = this.view.origin, r = this.view.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.view.camera);
    const N = new THREE.Vector3(n[0], n[1], 0), P0 = new THREE.Vector3(mid[0] - o[0], mid[1] - o[1], fr.z0 - o[2]);
    const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(N, P0), new THREE.Vector3());
    return hit ? (hit.x - P0.x) * U[0] + (hit.y - P0.y) * U[1] : null;
  }
  wirePitch() {
    const el = this.view.renderer.domElement;
    let d = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const w = this.windowAt(e), m = this.massing();
      if (!w || !m) return;
      const g = m.zones[w.zone].faces[w.face];
      if (!g || unitLayout(g, faceLength(m, w.zone, w.face)).n < 2) return;
      d = { ...w, x: e.clientX, y: e.clientY, moved: false, id: e.pointerId }; // a click still selects
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!d) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
        d.moved = true;
        el.setPointerCapture(d.id);
        this.onPick(d.name);
      }
      e.stopImmediatePropagation();
      const u = this.alongSide(e, d.zone, d.face);
      if (u === null) return;
      const m = structuredClone(this.massing());
      dragPitch(m, d.zone, d.face, d.index, u);
      this.pitchDraft = { m, zone: d.zone, face: d.face, u };
      this.draw();
    }, true);
    const end = (e) => {
      if (!d) return;
      const w = d, p = this.pitchDraft;
      d = null; this.pitchDraft = null;
      if (!w.moved) return;
      e.stopImmediatePropagation();
      el.releasePointerCapture?.(e.pointerId);
      if (p) this.onChange((m) => { dragPitch(m, w.zone, w.face, w.index, p.u); spreadSide(m, w.zone, w.face); }, `${faceName(this.massing(), w.zone, w.face)}: windows set out by dragging`);
      else this.draw();
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  // The length of each face turned toward the eye, along it about 1 m out, and the zone's height up the
  // corner nearest the eye; each typed over (a face's length moves the face after it).
  dims(m, fr, i) {
    const P = this.P, c = fr.corners, n = c.length, mm = (x) => `${Math.round(x * 1000)} mm`;
    let g = '';
    for (let k = 0; k < n; k++) {
      const f = fr.faces[k];
      if (!this.facing(f.at, f.normal)) continue;
      const out = (p) => [p[0] + f.normal[0], p[1] + f.normal[1], fr.z0], a = P(out(c[k])), b = P(out(c[(k + 1) % n]));
      g += dim(a[0], a[1], b[0], b[1], mm(Math.hypot(c[(k + 1) % n][0] - c[k][0], c[(k + 1) % n][1] - c[k][1])), 0, `len:${k}`);
    }
    // height: up the corner nearest the eye
    const cam = this.view.camera.position, o = this.view.origin;
    const near = c.map((p, k) => [k, Math.hypot(p[0] - o[0] - cam.x, p[1] - o[1] - cam.y)]).sort((x, y) => x[1] - y[1])[0][0];
    const p = c[near], out = unit2([p[0] - fr.centre[0], p[1] - fr.centre[1]]), q = [p[0] + out[0], p[1] + out[1]];
    const a = P([q[0], q[1], fr.z0]), b = P([q[0], q[1], fr.z1]);
    g += dim(a[0], a[1], b[0], b[1], mm(fr.z1 - fr.z0), 0, 'h');
    return g;
  }

  // A selected face's edges, each with a grip that moves the face beyond it.
  edges(grips, fr, face, i) {
    const P = this.P, c = fr.corners, z0 = fr.z0, z1 = fr.z1;
    const byKey = Object.fromEntries(fr.faces.map((f) => [f.key, f]));
    const list = [];
    const n = c.length;
    if (Number.isInteger(face)) {
      const k = face, A = c[k], B = c[(k + 1) % n];
      list.push([[A[0], A[1], z1], [B[0], B[1], z1], 'roof']);
      list.push([[A[0], A[1], z0], [B[0], B[1], z0], 'floor']);
      // a side edge at a seam slides the seam along the face (in its plane); at a corner it pushes the
      // face beyond
      const U = [(B[0] - A[0]), (B[1] - A[1])], l = Math.hypot(...U) || 1;
      for (const [v, p, beyond, sgn] of [[k, A, (k + n - 1) % n, -1], [(k + 1) % n, B, (k + 1) % n, 1]]) {
        if (isSeam(this.massing(), i, v)) list.push([[p[0], p[1], z0], [p[0], p[1], z1], null, { kind: 'seam', vertex: v }, [(U[0] / l) * sgn, (U[1] / l) * sgn, 0]]);
        else list.push([[p[0], p[1], z0], [p[0], p[1], z1], beyond]);
      }
    } else {
      const z = face === 'roof' ? z1 : z0;
      c.forEach((_, k) => list.push([[c[k][0], c[k][1], z], [c[(k + 1) % n][0], c[(k + 1) % n][1], z], k]));
    }
    let g = '';
    for (const [a, b, beyond, own, out] of list) {
      const f = byKey[beyond];
      if (!f && !own) continue;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], pa = P(a), pb = P(b), pm = P(mid);
      g += line(pa[0], pa[1], pb[0], pb[1], { stroke: 'var(--glass)', w: 1.6 });
      // a seam's grip runs out along the face from its middle (a positive drag lengthens this face)
      grips.push(own ? { p: pm, key: own, from: 0, dir: screenDir(P, mid, out), sgn: out } : { p: pm, key: { kind: 'face', face: beyond }, from: 0, dir: screenDir(P, mid, f.normal) });
      g += gripMark(pm[0], pm[1], 4.5);
    }
    return g;
  }

  sheet(e) { const r = this.view.renderer.domElement.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  handleAt(e) { return this.target ? gripAt(this.grips, this.sheet(e)) : null; }

  // The massing as it would be with a handle moved by x (m; [a, b] m for a free move; degrees for a turn).
  apply(m, key, x) {
    const i = this.target.zone;
    // a wall selected moves for every zone sharing it; a zone's own grips move its face alone, leaving a
    // wall it shared standing for the other zone
    if (key.kind === 'face') { if (Number.isInteger(key.face) && key.face === this.target.face) pushWall(m, i, key.face, x); else pushFace(m, i, key.face, x); }
    else if (key.kind === 'span') {
      // an end of the array's bays dragged along its face, the other end held
      const f = this.target.face, [a, b] = bayExtents(m.zones[i].faces[f], faceLength(m, i, f));
      setArraySpan(m, i, f, key.end ? a : a + x, key.end ? b + x : b);
      spreadSide(m, i, f);
    }
    else if (key.kind === 'move') moveStorey(m, i, key.axis, x);
    else if (key.kind === 'free') moveZone(m, i, turnPlan(x, m.zones[i].rot || 0)); // along its own axes, as far as it may go
    else if (key.kind === 'seam') {
      // along the face from this one's middle: out lengthens it; the seam moves along its line
      const P = m.zones[i].plate, n = P.length, v = key.vertex, f = this.target.face, a = P[f], b = P[(f + 1) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]), dir = v === f ? -1 : 1;
      const prev = P[(v - 1 + n) % n], next = P[(v + 1) % n], run = [next[0] - prev[0], next[1] - prev[1]], lr = Math.hypot(...run);
      const along = ((b[0] - a[0]) * run[0] + (b[1] - a[1]) * run[1]) / (l * lr); // +1 when the face runs the seam's way
      slideSeam(m, i, v, x * dir * along);
    }
    else if (key.kind === 'rot') turnZone(m, i, +((((m.zones[i].rot || 0) - x + 540) % 360) - 180).toFixed(3)); // the arc runs from x toward y: anticlockwise
    return m;
  }
  what(key) {
    const s = `zone ${this.target.zone + 1}`;
    if (key.kind === 'span') return `${faceName(this.massing(), this.target.zone, this.target.face)}: window array length set`;
    if (key.kind === 'seam') return `zone ${this.target.zone + 1} seam moved`;
    return key.kind === 'face' ? `${s} ${faceName(this.massing(), this.target.zone, key.face)} pushed or pulled` : key.kind === 'rot' ? `${s} turned` : `${s} moved`;
  }

  wire() {
    const el = this.view.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.target) return;
      const v = this.sheet(e), g = gripAt(this.grips, v);
      if (!g) return;
      e.stopImmediatePropagation();
      el.setPointerCapture(e.pointerId);
      drag = { g, v0: v, moved: false, t0: g.rot ? angleOf(g, v) : 0 };
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!this.target) return;
      const v = this.sheet(e);
      if (!drag) {
        const g = gripAt(this.grips, v);
        if (g) el.style.cursor = cursorFor(g);
        else if (['grab', 'move', 'pointer', 'ew-resize', 'ns-resize'].includes(el.style.cursor)) el.style.cursor = '';
        return;
      }
      if (!drag.moved && Math.hypot(v[0] - drag.v0[0], v[1] - drag.v0[1]) < CLICK_PX) return;
      drag.moved = true;
      e.stopImmediatePropagation();
      const { g } = drag, k = g.key;
      let x;
      if (k.kind === 'rot') x = dragAngle(g, drag.t0, v, { step: e.shiftKey ? 15 : 1, min: -180, max: 180 }).value;
      else if (k.kind === 'free') x = dragOnPlane(g.floor, drag.v0, v).map((d) => Math.round(d / 0.1) * 0.1);
      else x = dragLength(g, drag.v0, v, { step: e.shiftKey ? 0.5 : k.kind === 'face' && !['roof', 'floor'].includes(k.face) ? 0.1 : 0.05 }).value;
      drag.x = x;
      this.draft = this.apply(structuredClone(this.massing()), k, x);
      this.draw();
    }, true);
    const end = (e) => {
      if (!drag) return;
      el.releasePointerCapture?.(e.pointerId);
      const d = drag;
      drag = null;
      this.draft = null;
      if (d.moved) {
        const zero = Array.isArray(d.x) ? !d.x[0] && !d.x[1] : !d.x;
        if (!zero) this.onChange((m) => this.apply(m, d.g.key, d.x), this.what(d.g.key));
        else this.draw();
        return;
      }
      this.typeHandle(e, d.g.key);
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  // A handle clicked rather than dragged: how far to push, move or turn.
  typeHandle(e, key) {
    if (key.kind === 'free') return;
    if (key.kind === 'span') {
      const i = this.target.zone, f = this.target.face, m0 = this.massing(), [a, b] = bayExtents(m0.zones[i].faces[f], faceLength(m0, i, f));
      askNumber(this.view.container, e, `array length mm, now ${Math.round((b - a) * 1000)}`, (x) => this.onChange((m) => {
        setArraySpan(m, i, f, key.end ? a : b - x / 1000, key.end ? a + x / 1000 : b);
        spreadSide(m, i, f);
      }, this.what(key)));
      return;
    }
    const label = key.kind === 'seam' ? 'lengthen this face by, mm (the seam moves)' : key.kind === 'rot' ? 'turn °, anticlockwise' : key.kind === 'move' ? `move mm along ${key.axis}` : `push or pull the ${faceName(this.massing(), this.target.zone, key.face)}, mm`;
    askNumber(this.view.container, e, label, (x) => this.onChange((m) => this.apply(m, key, key.kind === 'rot' ? x : x / 1000), this.what(key)));
  }

  // A figure on the drawing typed over: a face's length or the height (mm), the turn (degrees
  // clockwise), or a face's array's number or spacing.
  typeFigure(e, k) {
    const i = this.target.zone, m0 = this.massing(), z = m0.zones[i], f = this.target.face;
    if (k === 'a.count' || k === 'a.spacing') {
      const g = z.faces[f], lay = unitLayout(g, faceLength(m0, i, f)), word = faceName(m0, i, f);
      if (k === 'a.count') askNumber(this.view.container, e, `windows, now ${lay.n}`, (x) => this.onChange((m) => { setCount(m.zones[i].faces[f], x); spreadSide(m, i, f); }, `${word}: ${Math.round(x)} windows`));
      else askNumber(this.view.container, e, `spacing mm, now ${Math.round(lay.pitch * 1000)}`, (x) => this.onChange((m) => { setSpacing(m.zones[i].faces[f], x / 1000); spreadSide(m, i, f); }, `${word}: windows at ${Math.round(x)} mm`));
      return;
    }
    if (k === 'rot') {
      askNumber(this.view.container, e, `turn °, now ${+(z.rot || 0).toFixed(1)}`, (x) => this.onChange((m) => turnZone(m, i, x), `zone ${i + 1} turned`), true);
      return;
    }
    if (k === 'h') {
      askNumber(this.view.container, e, `height mm, now ${Math.round(zoneHeight(m0, i) * 1000)}`, (x) => this.onChange((m) => pushFace(m, i, 'roof', x / 1000 - zoneHeight(m, i)), `zone ${i + 1} height set`));
      return;
    }
    // a face's length: the face after it moves
    const q = Number(k.split(':')[1]), next = (q + 1) % z.plate.length;
    askNumber(this.view.container, e, `length mm, now ${Math.round(faceLength(m0, i, q) * 1000)}`, (x) => this.onChange((m) => pushFace(m, i, next, x / 1000 - faceLength(m, i, q)), `zone ${i + 1} ${faceName(m0, i, q)} length set`));
  }
}
