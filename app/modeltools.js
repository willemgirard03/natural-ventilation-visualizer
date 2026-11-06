// The modelling tools for a massing (src/model/massing.js), in the 3D view's toolbar. One tool is on at
// a time; Esc, or its button again, goes back to selecting. While one is on, a click does that tool's
// work and the view's own selecting and handles wait.
//
//  - Add zone: dragged in from its button, or its button clicked and then the view. Over a zone's face
//    it shows a 3 x 3 m zone against that face on the same levels; over a roof, one standing on it, up
//    to the next level (a new one 3 m up when it is the top). Elsewhere nothing, as a zone may not
//    float or overlap another on its levels. Let go or click to place it, selected; the tool ends.
//  - Split zone: over a zone's face, a vertical cut square to the face through the pointer (to the
//    nearest 50 mm along it, its distances to the face's ends shown); near one of the zone's re-entrant
//    corners, a cut through that corner along either face meeting there or at 45° between them, Space
//    stepping through them; over its roof, a cut along the zone's own x or y through the pointer, Space
//    switching. Click to cut the zone in two (the new part takes the zone's settings); the tool stays on.
//  - Split face: over a face, a vertical seam through the pointer (to the nearest 50 mm, its distances
//    to the face's ends shown). Click to split the face in two, each keeping the windows wholly on it.
//  - Push/pull: over a face, the face outlined; dragged, it moves square to itself by 50 mm steps
//    (100 mm with Shift), stepping out from a seam to make an L or in to make a notch, its neighbours
//    stretching where it meets a corner; a click types how far. The tool stays on.

import * as THREE from 'three';
import { label, line, poly } from './handles.js';
import { addZone, splitZone, splitFace, extrudeFace, reentrantCorners, faceAxes, faceLength, zoneLevels, turnPlan, zoneFrame } from '../src/model/massing.js';
import { askNumber } from './sections.js';

const SNAP = 0.05; // m along a face
const CORNER_PX = 14; // a re-entrant corner this close on screen takes the cut

export class ModelTools {
  // massing() -> the massing; targetAt(e) -> { zone, face, point } under the pointer: a massing's zone,
  // the face hit (an index, 'roof' or 'floor') and the point hit in the plan's own coordinates (before
  // the building's turn), or null; onChange(mutate, what) -> true when made; onAdded(zoneIndex).
  constructor(view, { massing, targetAt, onChange, onAdded, onTool = () => {} }) {
    Object.assign(this, { view, massing, targetAt, onChange, onAdded, onTool });
    this.tool = null;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles');
    view.container.appendChild(this.svg);
    this.dir = 0; // which cut at a corner, stepped by Space
  }

  get active() { return !!this.tool; }

  // A model point (the plan's own coordinates and a height) on the sheet.
  P = (p) => {
    const m = this.massing(), o = this.view.origin, [x, y] = turnPlan([p[0], p[1]], m?.rot || 0);
    const s = this.view.sections.screen(new THREE.Vector3(x - o[0], y - o[1], p[2] - o[2]));
    return [s.x, s.y];
  };

  start(tool, dragged = false) {
    this.stop();
    this.tool = tool;
    this.dragged = dragged;
    this.dir = 0;
    document.body.classList.add(dragged ? 'placedrag' : 'placing');
    const el = this.view.renderer.domElement;
    const move = (e) => { this.last = e; if (this.pushing) this.dragPush(e); else this.preview(e); };
    const down = (e) => {
      if (e.button !== 0 || this.dragged) return;
      e.stopImmediatePropagation();
      if (this.tool === 'push') { this.pressPush(e); return; }
      this.commit(e);
    };
    const up = (e) => {
      if (this.pushing) { this.releasePush(e); return; }
      if (this.dragged) { this.commit(e); this.stop(); }
    };
    const key = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.stop(); }
      if (e.key === ' ' && this.tool === 'split') { e.preventDefault(); e.stopImmediatePropagation(); this.dir++; if (this.last) this.preview(this.last); }
    };
    window.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    this.off = () => {
      window.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
    this.onTool(tool);
  }

  stop() {
    if (!this.tool) return;
    this.off?.();
    this.tool = null; this.plan = null;
    document.body.classList.remove('placedrag', 'placing');
    this.svg.innerHTML = '';
    this.onTool(null);
    this.view.render();
  }

  // What the tool would do here: { what, mutate, draw } or null.
  planAt(e) {
    const m = this.massing(), t = m && this.targetAt(e);
    if (!t) return null;
    if (this.tool === 'add') return this.addAt(m, t);
    if (this.tool === 'face') return this.faceAt(m, t);
    if (this.tool === 'push') return this.pushAt(m, t);
    return this.splitAt(m, t, e);
  }

  addAt(m, t) {
    if (t.face === 'floor') return null;
    let opts;
    if (t.face === 'roof') opts = { at: t.point.map((x) => Math.round(x / 0.1) * 0.1) };
    else {
      const { A, U } = faceAxes(m, t.zone, t.face);
      opts = { u: Math.round(((t.point[0] - A[0]) * U[0] + (t.point[1] - A[1]) * U[1]) / 0.1) * 0.1 };
    }
    const trial = structuredClone(m), j = addZone(trial, t.zone, t.face, opts);
    if (j < 0) return null;
    const [z0, z1] = zoneLevels(trial, j), plate = trial.zones[j].plate;
    return {
      what: t.face === 'roof' ? 'zone added on a roof' : 'zone added against a face',
      mutate: (x) => addZone(x, t.zone, t.face, opts),
      draw: () => this.box(plate, z0, z1),
    };
  }

  splitAt(m, t, e) {
    if (t.face === 'roof') return this.splitFromRoof(m, t);
    if (!Number.isInteger(t.face)) return null;
    const i = t.zone, [z0, z1] = zoneLevels(m, i), r = this.view.renderer.domElement.getBoundingClientRect(), px = [e.clientX - r.left, e.clientY - r.top];
    // a re-entrant corner near the pointer takes the cut: along either face meeting there, or at 45°
    const corner = reentrantCorners(m, i).find((c) => {
      const a = this.P([...c.p, z0]), b = this.P([...c.p, z1]), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const s = Math.max(0, Math.min(1, ((px[0] - a[0]) * dx + (px[1] - a[1]) * dy) / l2));
      return Math.hypot(px[0] - a[0] - s * dx, px[1] - a[1] - s * dy) < CORNER_PX;
    });
    let a, d, note;
    if (corner) {
      const [u, v] = corner.dirs, bis = [u[0] + v[0], u[1] + v[1]], lb = Math.hypot(...bis);
      const options = [u, v, [bis[0] / lb, bis[1] / lb]];
      d = options[this.dir % 3];
      a = corner.p;
      note = ['along one face', 'along the other face', 'at 45°'][this.dir % 3] + ' · Space for the next';
    } else {
      // square to the face through the pointer, to the nearest 50 mm along it
      const { A, U, n } = faceAxes(m, i, t.face), len = faceLength(m, i, t.face);
      const s = Math.min(len - SNAP, Math.max(SNAP, Math.round(((t.point[0] - A[0]) * U[0] + (t.point[1] - A[1]) * U[1]) / SNAP) * SNAP));
      a = [A[0] + U[0] * s, A[1] + U[1] * s];
      d = [-n[0], -n[1]];
      note = `${Math.round(s * 1000)} | ${Math.round((len - s) * 1000)} mm`;
    }
    const b = [a[0] + d[0], a[1] + d[1]], trial = structuredClone(m), j = splitZone(trial, i, a, b);
    if (j < 0) return null;
    // the cut drawn where it runs through the zone: the edge the two parts now share
    const shared = this.sharedEdges(trial, i, j);
    return {
      what: 'zone split',
      mutate: (x) => splitZone(x, i, a, b),
      draw: () => this.box(m.zones[i].plate, z0, z1, true) + shared.map(([p, q]) => this.cut(p, q, z0, z1)).join('') + this.note(a, z1, note),
    };
  }

  // A cut seen from above: along the zone's own x or y (Space switches) through the pointer, to 50 mm.
  splitFromRoof(m, t) {
    const i = t.zone, z = m.zones[i], [z0, z1] = zoneLevels(m, i), along = this.dir % 2;
    const d = turnPlan(along ? [0, 1] : [1, 0], z.rot || 0), q = [d[1], -d[0]]; // the cut's run, and square to it
    const off = Math.round((t.point[0] * q[0] + t.point[1] * q[1]) / SNAP) * SNAP, s = t.point[0] * d[0] + t.point[1] * d[1];
    const a = [q[0] * off + d[0] * s, q[1] * off + d[1] * s], b = [a[0] + d[0], a[1] + d[1]];
    const trial = structuredClone(m), j = splitZone(trial, i, a, b);
    if (j < 0) return null;
    const shared = this.sharedEdges(trial, i, j);
    return {
      what: 'zone split',
      mutate: (x) => splitZone(x, i, a, b),
      draw: () => this.box(z.plate, z0, z1, true) + shared.map(([p, r]) => this.cut(p, r, z0, z1)).join('') + this.note(a, z1, `along ${along ? 'y' : 'x'} · Space for ${along ? 'x' : 'y'}`),
    };
  }
  // The edges two zones (after a split) share: where the cut runs.
  sharedEdges(trial, i, j) {
    return trial.zones[i].plate.map((p, k, P) => [p, P[(k + 1) % P.length]])
      .filter(([p, q]) => trial.zones[j].plate.some((x, k, P) => Math.hypot(x[0] - q[0], x[1] - q[1]) < 1e-6 && Math.hypot(P[(k + 1) % P.length][0] - p[0], P[(k + 1) % P.length][1] - p[1]) < 1e-6));
  }

  // A seam through the pointer on a face, to 50 mm.
  faceAt(m, t) {
    if (!Number.isInteger(t.face)) return null;
    const i = t.zone, k = t.face, [z0, z1] = zoneLevels(m, i), { A, U } = faceAxes(m, i, k), len = faceLength(m, i, k);
    const u = Math.round(((t.point[0] - A[0]) * U[0] + (t.point[1] - A[1]) * U[1]) / SNAP) * SNAP;
    const trial = structuredClone(m);
    if (!splitFace(trial, i, k, u)) return null;
    const p = [A[0] + U[0] * u, A[1] + U[1] * u], a = this.P([...p, z0]), b = this.P([...p, z1]);
    return {
      what: 'face split',
      mutate: (x) => splitFace(x, i, k, u),
      draw: () => this.face(m, i, k, true) + line(a[0], a[1], b[0], b[1], { stroke: 'var(--glass)', w: 2.2 }) + this.note(p, z1, `${Math.round(u * 1000)} | ${Math.round((len - u) * 1000)} mm`),
    };
  }

  // A face outlined, to push or pull; dragging draws the zone as it will be.
  pushAt(m, t) {
    if (!Number.isInteger(t.face)) return null;
    return { what: '', mutate: null, target: t, draw: () => this.face(m, t.zone, t.face) };
  }
  pressPush(e) {
    const m = this.massing(), plan = this.planAt(e);
    if (!plan?.target) return;
    const { zone: i, face: k } = plan.target, fr = zoneFrame(m, i), f = fr.faces[k], at = [...f.at], n = f.normal;
    // the face's normal on the sheet: pixels per metre, in the model's axes (the building turned)
    const P = (p) => { const o = this.view.origin, q = this.view.sections.screen(new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2])); return [q.x, q.y]; };
    const a = P(at), b = P([at[0] + n[0], at[1] + n[1], at[2]]);
    this.pushing = { i, k, x0: e.clientX, y0: e.clientY, dir: [b[0] - a[0], b[1] - a[1]], d: 0, moved: false };
    this.view.renderer.domElement.setPointerCapture?.(e.pointerId);
  }
  dragPush(e) {
    const p = this.pushing, dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    if (!p.moved && Math.hypot(dx, dy) < 3) return;
    p.moved = true;
    const l2 = p.dir[0] ** 2 + p.dir[1] ** 2 || 1, step = e.shiftKey ? 0.1 : SNAP, m = this.massing();
    p.d = Math.round(((dx * p.dir[0] + dy * p.dir[1]) / l2) / step) * step;
    const trial = structuredClone(m), ok = extrudeFace(trial, p.i, p.k, p.d), [z0, z1] = zoneLevels(m, p.i);
    p.ok = ok;
    this.svg.innerHTML = (ok ? this.box(trial.zones[p.i].plate, z0, z1) : this.face(m, p.i, p.k)) + this.note(m.zones[p.i].plate[p.k], z1, `${p.d > 0 ? '+' : ''}${Math.round(p.d * 1000)} mm`);
  }
  releasePush(e) {
    const p = this.pushing;
    this.pushing = null;
    this.view.renderer.domElement.releasePointerCapture?.(e.pointerId);
    if (!p.moved) {
      askNumber(this.view.container, e, 'push out (+) or in (−), mm', (x) => this.onChange((m) => extrudeFace(m, p.i, p.k, x / 1000), 'face pushed or pulled'), true);
      return;
    }
    if (p.ok && p.d) this.onChange((m) => extrudeFace(m, p.i, p.k, p.d), `face ${p.d > 0 ? 'pushed out' : 'pulled in'} ${Math.round(Math.abs(p.d) * 1000)} mm`);
    if (this.last) this.preview(this.last);
  }

  // A face of a zone outlined, filled when it is the one acted on.
  face(m, i, k, quiet = false) {
    const [z0, z1] = zoneLevels(m, i), P = m.zones[i].plate, a = P[k], b = P[(k + 1) % P.length];
    const c = [this.P([...a, z0]), this.P([...b, z0]), this.P([...b, z1]), this.P([...a, z1])];
    return (quiet ? '' : poly(c, { fill: 'var(--glass)', op: 0.18 })) + poly(c, { stroke: 'var(--glass)', w: quiet ? 1.2 : 2, dash: quiet ? '4 3' : undefined });
  }

  // A zone as a box outlined in glass, its footprint at both levels and its corners.
  box(plate, z0, z1, quiet = false) {
    const lo = plate.map((p) => this.P([...p, z0])), hi = plate.map((p) => this.P([...p, z1])), o = { stroke: 'var(--glass)', w: quiet ? 1 : 1.6, dash: quiet ? '4 3' : undefined };
    return poly(lo, o) + poly(hi, o) + lo.map((p, k) => line(p[0], p[1], hi[k][0], hi[k][1], o)).join('');
  }
  // The cut: a vertical rectangle, filled.
  cut(p, q, z0, z1) {
    const c = [this.P([...p, z0]), this.P([...q, z0]), this.P([...q, z1]), this.P([...p, z1])];
    return poly(c, { fill: 'var(--glass)', op: 0.18 }) + poly(c, { stroke: 'var(--glass)', w: 2 });
  }
  note(p, z, text) { const q = this.P([...p, z]); return label(q[0], q[1] - 12, text, { size: 9, fill: 'var(--glass)' }); }

  preview(e) {
    if (!this.tool) return;
    const canvas = this.view.renderer.domElement, cr = canvas.getBoundingClientRect(), kr = this.view.container.getBoundingClientRect();
    Object.assign(this.svg.style, { left: `${cr.left - kr.left}px`, top: `${cr.top - kr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` });
    this.plan = this.planAt(e);
    this.svg.innerHTML = this.plan ? this.plan.draw() : '';
  }

  commit(e) {
    const plan = this.planAt(e);
    if (!plan?.mutate) return;
    let made = -1;
    if (this.onChange((x) => { made = plan.mutate(x); }, plan.what) && this.tool === 'add' && made >= 0) this.onAdded(made);
    if (this.tool === 'add') this.stop();
    else if (this.last) this.preview(this.last);
  }

  // Redrawn with the view (the camera moves under a preview).
  beforeRender() { if (this.tool && this.last && this.plan && !this.pushing) this.svg.innerHTML = this.plan.draw(); }
}
