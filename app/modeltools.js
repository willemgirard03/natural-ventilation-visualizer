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
//  - Merge zones: click zones to pick them, the first outlined orange (its settings are kept), the
//    others in glass; a second click lets one go; Enter merges them, the walls between going. With Keep
//    seams on, the faces and floor and roof pieces that met stay pieces; off, they become one.
//  - Merge faces: click faces of one zone running in line (or pieces of its roof or floor) to pick
//    them; Enter makes them one, the seams between them going.
//  - Remove seam: over a zone, the seam nearest the pointer (up a wall, or across its roof) outlined
//    orange; click to take it out.
//  - Push/pull: over a face, the face outlined; dragged, it moves square to itself by 50 mm steps
//    (100 mm with Shift), stepping out from a seam to make an L or in to make a notch, its neighbours
//    stretching where it meets a corner; a click types how far. The tool stays on.

import * as THREE from 'three';
import { label, line, poly } from './handles.js';
import { addZone, splitZone, splitFace, extrudeFace, reentrantCorners, faceAxes, faceLength, zoneLevels, turnPlan, zoneFrame,
  mergeZones, mergeFaces, mergeCells, removeWallSeam, zoneSeams, cellAt, cellsOf } from '../src/model/massing.js';
import { askNumber } from './sections.js';

const SNAP = 0.05; // m along a face
const CORNER_PX = 14; // a re-entrant corner this close on screen takes the cut

export class ModelTools {
  // massing() -> the massing; targetAt(e) -> { zone, face, point } under the pointer: a massing's zone,
  // the face hit (an index, 'roof' or 'floor') and the point hit in the plan's own coordinates (before
  // the building's turn), or null; onChange(mutate, what) -> true when made; onAdded(zoneIndex).
  // keepSeams() -> whether Merge zones keeps the seams; onMessage(text) says why a merge is refused.
  constructor(view, { massing, targetAt, onChange, onAdded, onTool = () => {}, keepSeams = () => true, onMessage = () => {} }) {
    Object.assign(this, { view, massing, targetAt, onChange, onAdded, onTool, keepSeams, onMessage });
    this.picked = [];
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
    this.picked = [];
    document.body.classList.add(dragged ? 'placedrag' : 'placing');
    const el = this.view.renderer.domElement;
    const move = (e) => { this.last = e; if (this.pushing) this.dragPush(e); else this.preview(e); };
    const down = (e) => {
      if (e.button !== 0 || this.dragged) return;
      e.stopImmediatePropagation();
      if (this.tool === 'push') { this.pressPush(e); return; }
      if (this.tool === 'merge' || this.tool === 'mergefaces') { this.pick(e); return; }
      this.commit(e);
    };
    const up = (e) => {
      if (this.pushing) { this.releasePush(e); return; }
      if (this.dragged) { this.commit(e); this.stop(); }
    };
    const key = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.stop(); }
      if (e.key === 'Enter' && (this.tool === 'merge' || this.tool === 'mergefaces')) { e.preventDefault(); e.stopImmediatePropagation(); this.mergePicked(); }
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
    if (this.tool === 'merge') return this.mergeAt(m, t);
    if (this.tool === 'mergefaces') return this.mergeFacesAt(m, t);
    if (this.tool === 'seam') return this.seamAt(m, t, e);
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
    const i = t.zone, [z0, z1] = zoneLevels(m, i), r = this.view.renderer.domElement.getBoundingClientRect(), px = [e.clientX - r.left, e.clientY - r.top];
    // a re-entrant corner near the pointer (its edge up the walls, or its point on the roof) takes the
    // cut: along either face meeting there or at 45°, the one the pointer leans toward (Space steps
    // through them), running from the corner only as far as the first face it meets
    let best = null;
    for (const c of reentrantCorners(m, i)) {
      const a = this.P([...c.p, z0]), b = this.P([...c.p, z1]), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const s = Math.max(0, Math.min(1, ((px[0] - a[0]) * dx + (px[1] - a[1]) * dy) / l2)), dist = Math.hypot(px[0] - a[0] - s * dx, px[1] - a[1] - s * dy);
      if (dist < CORNER_PX * (t.face === 'roof' ? 2.5 : 1) && (!best || dist < best.dist)) best = { c, dist };
    }
    if (best) return this.splitAtCorner(m, t, best.c);
    if (t.face === 'roof') return this.splitFromRoof(m, t);
    if (!Number.isInteger(t.face)) return null;
    let a, d, note;
    {
      // square to the face through the pointer, to the nearest 50 mm along it
      const { A, U, n } = faceAxes(m, i, t.face), len = faceLength(m, i, t.face);
      const s = Math.min(len - SNAP, Math.max(SNAP, Math.round(((t.point[0] - A[0]) * U[0] + (t.point[1] - A[1]) * U[1]) / SNAP) * SNAP));
      a = [A[0] + U[0] * s, A[1] + U[1] * s];
      d = [-n[0], -n[1]];
      note = `${Math.round(s * 1000)} | ${Math.round((len - s) * 1000)} mm`;
    }
    const b = [a[0] + d[0], a[1] + d[1]], trial = structuredClone(m), j = splitZone(trial, i, a, b, { fromFace: true });
    if (j < 0) return null;
    // the cut drawn where it runs through the zone: the edge the two parts now share
    const shared = this.sharedEdges(trial, i, j);
    return {
      what: 'zone split',
      mutate: (x) => splitZone(x, i, a, b, { fromFace: true }),
      draw: () => this.box(m.zones[i].plate, z0, z1, true) + shared.map(([p, q]) => this.cut(p, q, z0, z1)).join('') + this.note(a, z1, note),
    };
  }

  // A cut from a re-entrant corner: its three ways (along each face meeting there, and at 45° between
  // them) drawn faintly, the one taken in full. The pointer's lean picks it until Space is pressed at
  // that corner; then Space steps through them.
  splitAtCorner(m, t, c) {
    const i = t.zone, [z0, z1] = zoneLevels(m, i), [u, v] = c.dirs, bis = [u[0] + v[0], u[1] + v[1]], lb = Math.hypot(...bis);
    const options = [u, v, [bis[0] / lb, bis[1] / lb]];
    if (this.corner !== `${i}:${c.k}`) { this.corner = `${i}:${c.k}`; this.spaced = this.dir; }
    let pick;
    if (this.dir !== this.spaced) pick = this.dir % 3;
    else {
      const w = [t.point[0] - c.p[0], t.point[1] - c.p[1]], lw = Math.hypot(...w) || 1;
      pick = options.map((o, q) => [q, (o[0] * w[0] + o[1] * w[1]) / lw]).sort((x, y) => y[1] - x[1])[0][0];
      this.dir = this.spaced = pick + 3 * Math.ceil(this.dir / 3);
    }
    const cutOf = (o) => { const trial = structuredClone(m), j = splitZone(trial, i, c.p, [c.p[0] + o[0], c.p[1] + o[1]], { fromCorner: true }); return j < 0 ? null : { trial, j }; };
    const cuts = options.map(cutOf), chosen = cuts[pick];
    if (!chosen) return null;
    const d = options[pick], b = [c.p[0] + d[0], c.p[1] + d[1]];
    const faint = cuts.map((x, q) => (x && q !== pick ? this.sharedEdges(x.trial, i, x.j).map(([p, r]) => { const P0 = this.P([...p, z1]), P1 = this.P([...r, z1]); return line(P0[0], P0[1], P1[0], P1[1], { stroke: 'var(--glass)', w: 1, dash: '3 3' }); }).join('') : '')).join('');
    return {
      what: 'zone split from a corner',
      mutate: (x) => splitZone(x, i, c.p, b, { fromCorner: true }),
      draw: () => this.box(m.zones[i].plate, z0, z1, true) + faint + this.sharedEdges(chosen.trial, i, chosen.j).map(([p, r]) => this.cut(p, r, z0, z1)).join('')
        + this.note(c.p, z1, `${['along one face', 'along the other face', 'at 45°'][pick]} · Space for the next`),
    };
  }

  // A cut seen from above: along the zone's own x or y (Space switches) through the pointer, to 50 mm.
  splitFromRoof(m, t) {
    const i = t.zone, z = m.zones[i], [z0, z1] = zoneLevels(m, i), along = this.dir % 2;
    const d = turnPlan(along ? [0, 1] : [1, 0], z.rot || 0), q = [d[1], -d[0]]; // the cut's run, and square to it
    const off = Math.round((t.point[0] * q[0] + t.point[1] * q[1]) / SNAP) * SNAP, s = t.point[0] * d[0] + t.point[1] * d[1];
    const a = [q[0] * off + d[0] * s, q[1] * off + d[1] * s], b = [a[0] + d[0], a[1] + d[1]];
    const trial = structuredClone(m), j = splitZone(trial, i, a, b, { within: true });
    if (j < 0) return null;
    const shared = this.sharedEdges(trial, i, j);
    return {
      what: 'zone split',
      mutate: (x) => splitZone(x, i, a, b, { within: true }),
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
    const trial = structuredClone(m), taken = extrudeFace(trial, p.i, p.k, p.d), ok = Math.abs(taken) > 1e-6, [z0, z1] = zoneLevels(m, p.i);
    p.ok = ok; p.d = taken; // as far as it may go
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
  box(plate, z0, z1, quiet = false, color = 'var(--glass)') {
    const lo = plate.map((p) => this.P([...p, z0])), hi = plate.map((p) => this.P([...p, z1])), o = { stroke: color, w: quiet ? 1 : 1.6, dash: quiet ? '4 3' : undefined };
    return poly(lo, o) + poly(hi, o) + lo.map((p, k) => line(p[0], p[1], hi[k][0], hi[k][1], o)).join('');
  }
  // ---------- merging and seams ----------

  // The zones picked so far (the first orange: its settings are kept; the others in glass), and the one
  // under the pointer.
  mergeAt(m, t) {
    const hover = t.zone;
    return {
      what: '', mutate: null, target: { zone: hover },
      draw: () => this.picked.map((i, q) => { const [z0, z1] = zoneLevels(m, i); return this.box(m.zones[i].plate, z0, z1, false, q ? 'var(--glass)' : 'var(--sun)'); }).join('')
        + (this.picked.includes(hover) ? '' : (() => { const [z0, z1] = zoneLevels(m, hover); return this.box(m.zones[hover].plate, z0, z1, true); })())
        + this.note(m.zones[hover].plate[0], zoneLevels(m, hover)[1], this.picked.length > 1 ? `Enter to merge ${this.picked.length} zones` : this.picked.length ? 'click the zones to merge with it' : 'click the zone whose settings to keep'),
    };
  }
  // A face of a zone, or a piece of its roof or floor, picked or under the pointer.
  mergeFacesAt(m, t) {
    const item = Number.isInteger(t.face) ? { zone: t.zone, face: t.face } : { zone: t.zone, cell: cellAt(m, t.zone, t.point), at: t.face };
    if (item.cell !== undefined && item.cell < 0) return null;
    return {
      what: '', mutate: null, target: item,
      draw: () => [...this.picked, item].map((x, q) => this.part(m, x, q < this.picked.length)).join('')
        + (this.picked.length > 1 ? this.note(m.zones[t.zone].plate[0], zoneLevels(m, t.zone)[1], `Enter to merge ${this.picked.length}`) : ''),
    };
  }
  part(m, x, picked) {
    const [z0, z1] = zoneLevels(m, x.zone);
    if (x.face !== undefined) return this.face(m, x.zone, x.face, !picked);
    const c = cellsOf(m.zones[x.zone])[x.cell], z = x.at === 'floor' ? z0 : z1, pts = c.map((p) => this.P([...p, z]));
    return poly(pts, { fill: picked ? 'var(--glass)' : 'none', op: picked ? 0.18 : undefined }) + poly(pts, { stroke: 'var(--glass)', w: picked ? 2 : 1.2, dash: picked ? undefined : '4 3' });
  }
  pick(e) {
    const m = this.massing(), plan = this.planAt(e);
    if (!plan?.target) return;
    const t = plan.target, same = (a) => (this.tool === 'merge' ? a === t.zone : JSON.stringify(a) === JSON.stringify(t)), at = this.picked.findIndex(same);
    if (at >= 0) this.picked.splice(at, 1);
    else if (this.tool === 'mergefaces' && this.picked.length && (this.picked[0].zone !== t.zone || ('face' in this.picked[0]) !== ('face' in t))) this.picked = [t]; // another zone, or faces and pieces mixed: start again
    else this.picked.push(this.tool === 'merge' ? t.zone : t);
    this.preview(e);
  }
  mergePicked() {
    const list = this.picked;
    if (list.length < 2) return;
    let why = null;
    if (this.tool === 'merge') {
      this.onChange((x) => { const r = mergeZones(x, list, this.keepSeams()); if (typeof r === 'string') { why = r; return false; } return r; }, `${list.length} zones merged`);
    } else if ('face' in list[0]) {
      this.onChange((x) => { if (!mergeFaces(x, list[0].zone, list.map((y) => y.face))) { why = 'Only faces in line, one after another, can be merged.'; return false; } }, `${list.length} faces merged`);
    } else {
      this.onChange((x) => { if (!mergeCells(x, list[0].zone, list.map((y) => y.cell))) { why = 'Only pieces that meet can be merged.'; return false; } }, `${list.length} roof or floor pieces merged`);
    }
    this.picked = [];
    if (why) this.flashMessage(why); else if (this.last) this.preview(this.last);
  }

  // Why something could not be done, shown beside the pointer for a moment.
  flashMessage(text) {
    const r = this.view.renderer.domElement.getBoundingClientRect(), e = this.last;
    if (!e) return;
    this.svg.innerHTML = label(e.clientX - r.left, e.clientY - r.top - 16, text, { size: 9.5, fill: 'var(--bad, #C0442B)' });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (this.last && this.tool) this.preview(this.last); }, 2200);
  }

  // The seam of the zone under the pointer nearest it: up a wall (a corner between two faces in line),
  // or across its roof (where two of its pieces meet).
  seamAt(m, t, e) {
    const i = t.zone, [z0, z1] = zoneLevels(m, i), r = this.view.renderer.domElement.getBoundingClientRect(), px = [e.clientX - r.left, e.clientY - r.top];
    const { walls, cells } = zoneSeams(m, i), P = m.zones[i].plate, near = [];
    const dist = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((px[0] - a[0]) * dx + (px[1] - a[1]) * dy) / l2)); return Math.hypot(px[0] - a[0] - u * dx, px[1] - a[1] - u * dy); };
    for (const v of walls) { const a = this.P([...P[v], z0]), b = this.P([...P[v], z1]); near.push({ d: dist(a, b), a, b, wall: v }); }
    for (const c of cells) for (const z of [z1, z0]) { const a = this.P([...c.p, z]), b = this.P([...c.q, z]); near.push({ d: dist(a, b), a, b, cells: c.cells }); }
    const best = near.sort((x, y) => x.d - y.d)[0];
    if (!best || best.d > 14) return null;
    return {
      what: best.wall !== undefined ? 'seam removed' : 'roof and floor seam removed',
      mutate: (x) => (best.wall !== undefined ? removeWallSeam(x, i, best.wall) : mergeCells(x, i, best.cells)),
      draw: () => line(best.a[0], best.a[1], best.b[0], best.b[1], { stroke: 'var(--sun)', w: 3 }),
    };
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
