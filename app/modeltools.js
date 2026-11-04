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
//    stepping through them. Click to cut the zone in two; the tool stays on for the next.

import * as THREE from 'three';
import { label, line, poly } from './handles.js';
import { addZone, splitZone, reentrantCorners, faceAxes, faceLength, zoneLevels, turnPlan } from '../src/model/massing.js';

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
    const move = (e) => { this.last = e; this.preview(e); };
    const down = (e) => {
      if (e.button !== 0 || this.dragged) return;
      e.stopImmediatePropagation();
      this.commit(e);
    };
    const up = (e) => { if (this.dragged) { this.commit(e); this.stop(); } };
    const key = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.stop(); }
      if (e.key === ' ' && this.tool === 'split') { e.preventDefault(); this.dir++; if (this.last) this.preview(this.last); }
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
    return this.tool === 'add' ? this.addAt(m, t) : this.splitAt(m, t, e);
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
    const shared = trial.zones[i].plate.map((p, k, P) => [p, P[(k + 1) % P.length]])
      .filter(([p, q]) => trial.zones[j].plate.some((x, k, P) => Math.hypot(x[0] - q[0], x[1] - q[1]) < 1e-6 && Math.hypot(P[(k + 1) % P.length][0] - p[0], P[(k + 1) % P.length][1] - p[1]) < 1e-6));
    return {
      what: 'zone split',
      mutate: (x) => splitZone(x, i, a, b),
      draw: () => this.box(m.zones[i].plate, z0, z1, true) + shared.map(([p, q]) => this.cut(p, q, z0, z1)).join('') + this.note(a, z1, note),
    };
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
    if (!plan) return;
    let made = -1;
    if (this.onChange((x) => { made = plan.mutate(x); }, plan.what) && this.tool === 'add' && made >= 0) this.onAdded(made);
    if (this.tool === 'add') this.stop();
    else if (this.last) this.preview(this.last);
  }

  // Redrawn with the view (the camera moves under a preview).
  beforeRender() { if (this.tool && this.last && this.plan) this.svg.innerHTML = this.plan.draw(); }
}
