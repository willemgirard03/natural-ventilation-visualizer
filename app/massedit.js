// A massing's storey edited in the 3D view, with the Solar Shading Explorer's handles (handles.js, from
// the edit-handles skill), drawn as an SVG over the view.
//
// With its whole zone selected:
//  - a square grip on each face turned toward the eye pushes or pulls it: a wall takes its side of the
//    plate (the opposite side stays), the roof raises the storey and everything above. The floor's grip
//    always shows (it faces away from a view from above): it lowers the floor into the storey below;
//  - a gumball on its floor, drawn at model size: red and green arrows along its own axes, the square
//    between them to move it freely on its floor, the arc between them to turn it; on upper storeys a
//    blue arrow raises it (the storey below grows to meet it, the storeys above follow). The ground
//    floor has the arc only;
//  - its width, depth and height dimensioned on the drawing, and its turn beside the arc, each typed over.
// With one surface selected: its own grip, and a grip on each of its edges that moves the face beyond
// that edge, so the storey stays square: a wall's top edge is the roof, its sides the walls either side.
//
// A side selected (a wall, or a window of it) shows its windows' array as a dotted bracket over their
// heads, its number and spacing typed over (the facade-windows skill). Windows broken out of their
// array are outlined dashed in the sun's colour whenever they are not selected.
//
// A press under 3 px is a click: an arrow, grip or arc then asks how far. Each drag or typed figure is
// one edit, made through onChange(mutate, what) when the pointer is let go; while dragging, the
// storeys as they will be are drawn in outline.

import * as THREE from 'three';
import { askNumber } from './sections.js';
import { AXIS, CLICK_PX, gripMark, gripAt, cursorFor, dragLength, dragAngle, angleOf, dragOnPlane, screenDir, dim, label, line, head, path, poly, circle, arrayBracket } from './handles.js';
import { storeyFrame, pushFace, moveStorey, SIDES, unitLayout, unitOf, windowHeights, setCount, setSpacing, spreadSide } from '../src/model/massing.js';

const FACE_NAMES = { S: 'south wall', E: 'east wall', N: 'north wall', W: 'west wall', roof: 'roof', floor: 'floor' };
const unit2 = (d) => { const l = Math.hypot(d[0], d[1]); return l < 1e-9 ? [1, 0] : [d[0] / l, d[1] / l]; };

export class MassingEditor {
  // massing() -> the massing; onChange(mutate, what).
  // brokenWindows() -> the outlines (model points) of the windows broken out of their arrays, unselected.
  constructor(view, { massing, onChange, brokenWindows = () => [] }) {
    Object.assign(this, { view, massing, onChange, brokenWindows });
    this.target = null; // { storey, face }: face null for the whole zone
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
    if (!m || this.target.storey >= m.storeys.length) { this.stop(); return; }
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
    const { storey: i, face } = this.target, fr = storeyFrame(m, i);
    if (this.draft) { // the storeys as they will be
      for (let k = 0; k < m.storeys.length; k++) {
        const f = storeyFrame(m, k), lo = f.corners.map((c) => P([c[0], c[1], f.z0])), hi = f.corners.map((c) => P([c[0], c[1], f.z1]));
        g += poly(lo, { stroke: 'var(--glass)', w: 1.2 }) + poly(hi, { stroke: 'var(--glass)', w: 1.2 });
        for (let j = 0; j < 4; j++) g += line(lo[j][0], lo[j][1], hi[j][0], hi[j][1], { stroke: 'var(--glass)', w: 1.2 });
      }
    }
    const faceGrip = (f, half = 5, low = false) => {
      const p = P(f.at);
      grips.push({ p, key: { kind: 'face', face: f.key }, from: 0, dir: screenDir(P, f.at, f.normal), low });
      return gripMark(p[0], p[1], half);
    };
    if (this.target.window !== undefined) g += this.bracket(m, i, face); // a window: its array alone
    else if (!face) {
      // the floor: its gumball, and the floor's own grip in the quarter the gumball leaves free
      const C = [fr.centre[0], fr.centre[1], fr.z0], ex = fr.x, ey = fr.y;
      const s = m.storeys[i], GL = Math.min(10, Math.max(2, Math.min(s.w, s.d) / 4));
      g += this.gumball(grips, C, ex, ey, GL, i > 0, s.rot || 0);
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
        if (SIDES.includes(face)) g += this.bracket(m, i, face);
      }
    }
    this.grips = grips;
    if (this.shown !== g) this.svg.innerHTML = this.shown = g; // only when it changed
    if (render) this.view.render();
  }

  // The floor gumball (handles.js floorGumball's), with a blue arrow up on upper storeys and the arc
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
  // the storey less 150 mm or 450 mm over the heads, a tick at each window, its number and spacing.
  bracket(m, i, f) {
    const s = m.storeys[i], g = s.sides[f];
    if (!g) return '';
    const fr = storeyFrame(m, i), k = SIDES.indexOf(f), A = fr.corners[k], B = fr.corners[(k + 1) % 4], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const lay = unitLayout(g, len);
    if (!lay.n) return '';
    const U = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], n = fr.faces.find((x) => x.key === f).normal, mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const top = s.h - (s.slab || 0), heads = Array.from({ length: lay.n }, (_, j) => windowHeights(unitOf(g, j), top).head);
    const v = Math.min(s.h - 0.15, Math.max(...heads) + 0.45);
    const pts = Array.from({ length: lay.n }, (_, j) => { const u = lay.first + j * lay.pitch; return this.P([mid[0] + U[0] * u + n[0] * 0.6, mid[1] + U[1] * u + n[1] * 0.6, fr.z0 + v]); });
    return arrayBracket(pts, true, lay.n, lay.pitch, 'window');
  }

  // The storey's width, depth and height dimensioned along the edges nearest the eye, about 1 m out.
  dims(m, fr, i) {
    const P = this.P, c = fr.corners, s = m.storeys[i], mm = (x) => `${Math.round(x * 1000)} mm`;
    const edge = (k) => ({ a: c[k], b: c[(k + 1) % 4], n: fr.faces[k].normal, at: fr.faces[k].at });
    const pick = (k1, k2) => (this.facing(edge(k1).at, edge(k1).n) ? edge(k1) : edge(k2));
    const along = (e, z, text, key) => {
      const out = (p) => [p[0] + e.n[0], p[1] + e.n[1], z];
      const a = P(out(e.a)), b = P(out(e.b));
      return dim(a[0], a[1], b[0], b[1], text, 0, key);
    };
    let g = along(pick(0, 2), fr.z0, mm(s.w), 'w') + along(pick(1, 3), fr.z0, mm(s.d), 'd');
    // height: up the corner nearest the eye
    const cam = this.view.camera.position, o = this.view.origin;
    const near = c.map((p, k) => [k, Math.hypot(p[0] - o[0] - cam.x, p[1] - o[1] - cam.y)]).sort((x, y) => x[1] - y[1])[0][0];
    const p = c[near], out = unit2([p[0] - fr.centre[0], p[1] - fr.centre[1]]), q = [p[0] + out[0], p[1] + out[1]];
    const a = P([q[0], q[1], fr.z0]), b = P([q[0], q[1], fr.z1]);
    g += dim(a[0], a[1], b[0], b[1], mm(s.h), 0, 'h');
    return g;
  }

  // A selected face's edges, each with a grip that moves the face beyond it.
  edges(grips, fr, face, i) {
    const P = this.P, c = fr.corners, z0 = fr.z0, z1 = fr.z1;
    const byKey = Object.fromEntries(fr.faces.map((f) => [f.key, f]));
    const list = [];
    if (SIDES.includes(face)) {
      const k = SIDES.indexOf(face), A = c[k], B = c[(k + 1) % 4];
      list.push([[A[0], A[1], z1], [B[0], B[1], z1], 'roof']);
      if (i > 0) list.push([[A[0], A[1], z0], [B[0], B[1], z0], 'floor']);
      list.push([[A[0], A[1], z0], [A[0], A[1], z1], SIDES[(k + 3) % 4]]);
      list.push([[B[0], B[1], z0], [B[0], B[1], z1], SIDES[(k + 1) % 4]]);
    } else {
      const z = face === 'roof' ? z1 : z0;
      SIDES.forEach((f, k) => list.push([[c[k][0], c[k][1], z], [c[(k + 1) % 4][0], c[(k + 1) % 4][1], z], f]));
    }
    let g = '';
    for (const [a, b, beyond] of list) {
      const f = byKey[beyond];
      if (!f) continue;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], pa = P(a), pb = P(b), pm = P(mid);
      g += line(pa[0], pa[1], pb[0], pb[1], { stroke: 'var(--glass)', w: 1.6 });
      grips.push({ p: pm, key: { kind: 'face', face: beyond }, from: 0, dir: screenDir(P, mid, f.normal) });
      g += gripMark(pm[0], pm[1], 4.5);
    }
    return g;
  }

  sheet(e) { const r = this.view.renderer.domElement.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  handleAt(e) { return this.target ? gripAt(this.grips, this.sheet(e)) : null; }

  // The massing as it would be with a handle moved by x (m; [a, b] m for a free move; degrees for a turn).
  apply(m, key, x) {
    const i = this.target.storey;
    if (key.kind === 'face') pushFace(m, i, key.face, x);
    else if (key.kind === 'move') moveStorey(m, i, key.axis, x);
    else if (key.kind === 'free') { moveStorey(m, i, 'x', x[0]); moveStorey(m, i, 'y', x[1]); }
    else if (key.kind === 'rot') m.storeys[i].rot = +((((m.storeys[i].rot || 0) - x + 540) % 360) - 180).toFixed(3); // the arc runs from x toward y: anticlockwise
    return m;
  }
  what(key) {
    const s = `storey ${this.target.storey + 1}`;
    return key.kind === 'face' ? `${s} ${FACE_NAMES[key.face]} pushed or pulled` : key.kind === 'rot' ? `${s} turned` : `${s} moved`;
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
    const label = key.kind === 'rot' ? 'turn °, anticlockwise' : key.kind === 'move' ? `move mm along ${key.axis}` : `push or pull the ${FACE_NAMES[key.face]}, mm`;
    askNumber(this.view.container, e, label, (x) => this.onChange((m) => this.apply(m, key, key.kind === 'rot' ? x : x / 1000), this.what(key)));
  }

  // A figure on the drawing typed over: width, depth or height (mm), or the turn (degrees clockwise).
  typeFigure(e, k) {
    const i = this.target.storey, s = this.massing().storeys[i], f = this.target.face;
    if (k === 'a.count' || k === 'a.spacing') {
      const g = s.sides[f], lay = unitLayout(g, f === 'N' || f === 'S' ? s.w : s.d);
      if (k === 'a.count') askNumber(this.view.container, e, `windows, now ${lay.n}`, (x) => this.onChange((m) => { setCount(m.storeys[i].sides[f], x); spreadSide(m, i, f); }, `${f} side: ${Math.round(x)} windows`));
      else askNumber(this.view.container, e, `spacing mm, now ${Math.round(lay.pitch * 1000)}`, (x) => this.onChange((m) => { setSpacing(m.storeys[i].sides[f], x / 1000); spreadSide(m, i, f); }, `${f} side: windows at ${Math.round(x)} mm`));
      return;
    }
    if (k === 'rot') {
      askNumber(this.view.container, e, `turn °, now ${+(s.rot || 0).toFixed(1)}`, (x) => this.onChange((m) => { m.storeys[i].rot = x; }, `storey ${i + 1} turned`), true);
      return;
    }
    const name = { w: 'width', d: 'depth', h: 'height' }[k], face = { w: 'E', d: 'N', h: 'roof' }[k];
    askNumber(this.view.container, e, `${name} mm, now ${Math.round(s[k] * 1000)}`, (x) => this.onChange((m) => pushFace(m, i, face, x / 1000 - m.storeys[i][k]), `storey ${i + 1} ${name} set`));
  }
}
