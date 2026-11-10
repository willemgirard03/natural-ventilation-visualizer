// The modelling tools for a massing (src/model/massing.js), in the 3D view's toolbar and each plan
// view's. A plan view lends the tools a context (register): its own projection, target under the
// pointer and preview layer, so the same tools work over a plan, where a zone's box is its footprint. One tool is on at
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
//  - Split wall: over a face, a vertical seam through the pointer (to the nearest 50 mm, its distances
//    to the face's ends shown). Click to split the face in two, each keeping the windows wholly on it.
//  - Merge zones: click zones to pick them, the first outlined orange (its settings are kept), the
//    others in glass; a second click lets one go; Enter merges them, the walls between going. With Keep
//    seams on, the faces and floor and roof pieces that met stay pieces; off, they become one.
//  - Merge walls: click faces of one zone running in line (or pieces of its roof or floor) to pick
//    them; Enter makes them one, the seams between them going.
//  - Remove seam: over a zone, the seam nearest the pointer (up a wall, or across its roof) outlined
//    orange; click to take it out.
//  - Draw wall (as Revit's): click the wall's start, then its end; with Chain on each end starts the
//    next wall, until Enter or Esc; off, the tool ends with the wall. Its assembly, base and top levels
//    and location line come from the Place wall tab. The pointer snaps to walls' ends and middles, square
//    onto a wall from the start, and along a wall it crosses; Shift holds the wall to 45° steps. Space
//    turns the location line to the other side, for the whole chain. A wall across a zone splits it;
//    walls closing a space make it a zone.
//  - Push/pull: over a face, the face outlined; dragged, it moves square to itself by 50 mm steps
//    (100 mm with Shift), stepping out from a seam to make an L or in to make a notch, its neighbours
//    stretching where it meets a corner; a click types how far. The tool stays on.

import * as THREE from 'three';
import { label, line, poly } from './handles.js';
import { addWall, WALL_LINES } from '../src/model/massing.js';
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
  // wallProps() -> { asm, base, top, line, chain } for Draw wall.
  constructor(view, { massing, targetAt, onChange, onAdded, onTool = () => {}, keepSeams = () => true, onMessage = () => {}, wallProps = () => ({}) }) {
    Object.assign(this, { view, massing, targetAt, onChange, onAdded, onTool, keepSeams, onMessage, wallProps });
    this.picked = [];
    this.tool = null;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles');
    view.container.appendChild(this.svg);
    this.dir = 0; // which cut at a corner, stepped by Space
    this.contexts = new Set(); // plan views lending their own drawing: { el, svg, P, px, targetAt }
    this.ctx = null; // the one the pointer is over, or null for the 3D view
  }
  register(ctx) { this.contexts.add(ctx); return () => { this.contexts.delete(ctx); if (this.ctx === ctx) this.ctx = null; }; }
  // the context under the pointer: a plan view's, or the 3D view's (null)
  ctxAt(e) { if (!(e.target instanceof Node)) return this.ctx; for (const c of this.contexts) if (c.el.isConnected && c.el.contains(e.target)) return c; return null; }
  get out() { return this.ctx?.svg || this.svg; }
  // the pointer on the sheet it is over
  px(e) {
    if (this.ctx) return this.ctx.px(e);
    const r = this.view.renderer.domElement.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  tgt(e) { return this.ctx ? this.ctx.targetAt(e) : this.targetAt(e); }

  get active() { return !!this.tool; }

  // A model point (the plan's own coordinates and a height) on the sheet: the plan view's, or the 3D view's.
  P = (p) => (this.ctx ? this.ctx.P(p) : this.P3(p));
  P3 = (p) => {
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
    this.wall = tool === 'wall' ? { start: null, chain: [], side: 1 } : null;
    document.body.classList.add(dragged ? 'placedrag' : 'placing');
    const el = this.view.renderer.domElement;
    const move = (e) => {
      this.last = e;
      if (this.pushing) { this.dragPush(e); return; }
      const c = this.ctxAt(e);
      if (c !== this.ctx) { this.out.innerHTML = ''; this.ctx = c; }
      this.preview(e);
    };
    const down = (e) => {
      if (e.button !== 0 || this.dragged) return;
      e.stopImmediatePropagation();
      this.press(e);
    };
    const up = (e) => {
      if (this.pushing) { this.releasePush(e); return; }
      if (this.dragged) { this.commit(e); this.stop(); }
    };
    const key = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.stop(); }
      if (e.key === 'Enter' && (this.tool === 'merge' || this.tool === 'mergefaces')) { e.preventDefault(); e.stopImmediatePropagation(); this.mergePicked(); }
      if (e.key === 'Enter' && this.tool === 'wall') { e.preventDefault(); e.stopImmediatePropagation(); this.stop(); }
      if (e.key === ' ' && this.tool === 'wall') { e.preventDefault(); e.stopImmediatePropagation(); this.flipWalls(); }
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

  // A press over the 3D view or a plan view: the tool's work there.
  press(e) {
    this.ctx = this.ctxAt(e);
    this.last = e;
    if (this.tool === 'wall') { this.wallClick(e); return; }
    if (this.tool === 'push') { this.pressPush(e); return; }
    if (this.tool === 'merge' || this.tool === 'mergefaces') { this.pick(e); return; }
    this.commit(e);
  }

  stop() {
    if (!this.tool) return;
    this.off?.();
    this.tool = null; this.plan = null;
    document.body.classList.remove('placedrag', 'placing');
    this.svg.innerHTML = '';
    for (const c of this.contexts) c.svg.innerHTML = '';
    this.onTool(null);
    this.view.render();
  }

  // What the tool would do here: { what, mutate, draw } or null.
  planAt(e) {
    if (this.tool === 'wall') return this.wallAt(e);
    const m = this.massing(), t = m && this.tgt(e);
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
    const i = t.zone, [z0, z1] = zoneLevels(m, i), px = this.px(e);
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
      what: 'wall split',
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
    const { zone: i, face: k } = plan.target, { A, U, n } = faceAxes(m, i, k), len = faceLength(m, i, k), [z0, z1] = zoneLevels(m, i);
    // the face's normal on the sheet: pixels per metre (the plan's own axes, drawn turned with the building)
    const mid = [A[0] + U[0] * len / 2, A[1] + U[1] * len / 2], zm = (z0 + z1) / 2, a = this.P([...mid, zm]), b = this.P([mid[0] + n[0], mid[1] + n[1], zm]);
    this.pushing = { i, k, x0: e.clientX, y0: e.clientY, dir: [b[0] - a[0], b[1] - a[1]], d: 0, moved: false, el: this.ctx?.el || this.view.renderer.domElement };
    this.pushing.el.setPointerCapture?.(e.pointerId);
  }
  dragPush(e) {
    const p = this.pushing, dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    if (!p.moved && Math.hypot(dx, dy) < 3) return;
    p.moved = true;
    const l2 = p.dir[0] ** 2 + p.dir[1] ** 2 || 1, step = e.shiftKey ? 0.1 : SNAP, m = this.massing();
    p.d = Math.round(((dx * p.dir[0] + dy * p.dir[1]) / l2) / step) * step;
    const trial = structuredClone(m), taken = extrudeFace(trial, p.i, p.k, p.d), ok = Math.abs(taken) > 1e-6, [z0, z1] = zoneLevels(m, p.i);
    p.ok = ok; p.d = taken; // as far as it may go
    this.out.innerHTML = (ok ? this.box(trial.zones[p.i].plate, z0, z1) : this.face(m, p.i, p.k)) + this.note(m.zones[p.i].plate[p.k], z1, `${p.d > 0 ? '+' : ''}${Math.round(p.d * 1000)} mm`);
  }
  releasePush(e) {
    const p = this.pushing;
    this.pushing = null;
    p.el.releasePointerCapture?.(e.pointerId);
    if (!p.moved) {
      askNumber(this.ctx?.el || this.view.container, e, 'push out (+) or in (−), mm', (x) => this.onChange((m) => extrudeFace(m, p.i, p.k, x / 1000), 'face pushed or pulled'), true);
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
  // ---------- drawing walls ----------

  // The point under the pointer on the level plane at height z (the plan's own axes): a plan view's, or
  // where the pointer's ray meets that plane in 3D.
  pointAt(e, z) {
    if (this.ctx) return this.ctx.pointAt?.(e) || null;
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect(), o = v.origin || [0, 0, 0], m = this.massing();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z - o[2])), new THREE.Vector3());
    return hit ? turnPlan([hit.x + o[0], hit.y + o[1]], -(m?.rot || 0)) : null;
  }
  // The point a wall would take: snapped to walls' (and zones' edges') ends and middles, square onto one
  // from the start, along one it crosses; with Shift, held to 45° steps from the start.
  wallSnap(m, raw, e, base, top) {
    const z = m.levels[base].z, P = (p) => this.P([p[0], p[1], z]), d = (p, q) => { const a = P(p), b = P(q); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
    const lvz = (L) => m.levels[L].z, over = (x) => Math.min(lvz(x.top), lvz(top)) - Math.max(lvz(x.base), lvz(base)) > 1e-6;
    const segs = [...(m.walls || []).filter(over).map((w) => [w.a, w.b])];
    for (const zz of m.zones) if (over(zz)) zz.plate.forEach((p, k) => segs.push([p, zz.plate[(k + 1) % zz.plate.length]]));
    const start = this.wall.start, foot = (p, [a, b]) => { const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1, t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2; return [t, [a[0] + ab[0] * t, a[1] + ab[1] * t]]; };
    if (e.shiftKey && start) {
      const ang = Math.round(Math.atan2(raw[1] - start[1], raw[0] - start[0]) / (Math.PI / 4)) * (Math.PI / 4), u = [Math.cos(ang), Math.sin(ang)];
      const t = (raw[0] - start[0]) * u[0] + (raw[1] - start[1]) * u[1];
      let p = [start[0] + u[0] * t, start[1] + u[1] * t], kind = 'angle';
      // where that line crosses a wall near the pointer
      for (const [a, b] of segs) {
        const r = [b[0] - a[0], b[1] - a[1]], den = u[0] * r[1] - u[1] * r[0];
        if (Math.abs(den) < 1e-9) continue;
        const s2 = ((a[0] - start[0]) * r[1] - (a[1] - start[1]) * r[0]) / den, w = ((a[0] - start[0]) * u[1] - (a[1] - start[1]) * u[0]) / den;
        if (w < 0 || w > 1 || s2 <= 0) continue;
        const q = [start[0] + u[0] * s2, start[1] + u[1] * s2];
        if (d(q, p) < 10) { p = q; kind = 'cross'; break; }
      }
      return { p, kind };
    }
    let best = null;
    const offer = (p, kind, px, rank) => { const dd = d(p, raw); if (dd < px && (!best || rank < best.rank || (rank === best.rank && dd < best.dd))) best = { p, kind, rank, dd }; };
    for (const [a, b] of segs) {
      offer(a, 'end', 10, 0); offer(b, 'end', 10, 0);
      offer([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'mid', 10, 1);
      if (start) { const [t, q] = foot(start, [a, b]); if (t > 0 && t < 1 && d(q, start) > 4) offer(q, 'perp', 10, 2); }
      const [t, q] = foot(raw, [a, b]);
      if (t >= 0 && t <= 1) offer(q, 'on', 8, 3);
    }
    return best ? { p: best.p, kind: best.kind } : { p: raw, kind: null };
  }
  // the snap's mark: a square at an end, a triangle at a middle, a square-to mark, a cross on a wall
  snapMark(q, kind) {
    const [x, y] = q, o = { stroke: 'var(--sun)', w: 1.6 };
    if (kind === 'end') return poly([[x - 5, y - 5], [x + 5, y - 5], [x + 5, y + 5], [x - 5, y + 5]], o);
    if (kind === 'mid') return poly([[x, y - 6], [x + 6, y + 4], [x - 6, y + 4]], o);
    if (kind === 'perp') return line(x - 6, y + 5, x + 6, y + 5, o) + line(x, y + 5, x, y - 6, o);
    if (kind === 'on' || kind === 'cross') return line(x - 5, y - 5, x + 5, y + 5, o) + line(x - 5, y + 5, x + 5, y - 5, o);
    return '';
  }
  wallAt(e) {
    const m = this.massing(), pr = this.wallProps();
    if (!m || !m.levels[pr.base] || !m.levels[pr.top]) return null;
    const z0 = m.levels[pr.base].z, z1 = m.levels[pr.top].z, raw = this.pointAt(e, z0);
    if (!raw) return null;
    const { p, kind } = this.wallSnap(m, raw, e, pr.base, pr.top), s0 = this.wall.start;
    const at = this.P([p[0], p[1], z0]);
    return {
      what: '', mutate: null, point: p,
      draw: () => {
        let g = this.snapMark(at, kind);
        if (s0) {
          const len = Math.hypot(p[0] - s0[0], p[1] - s0[1]), ang = (Math.atan2(p[1] - s0[1], p[0] - s0[0]) * 180) / Math.PI;
          g += this.box([s0, p], z0, z1, true);
          const a = this.P([s0[0], s0[1], z0]);
          g += line(a[0], a[1], at[0], at[1], { stroke: 'var(--glass)', w: 2.2 });
          // the side the exterior finish is drawn on, as a short tick off the line's middle
          if (pr.line !== 'centre' && len > 0.05) {
            const u = [(p[0] - s0[0]) / len, (p[1] - s0[1]) / len], side = this.wall.side, n = [-u[1] * side, u[0] * side], mid = [(s0[0] + p[0]) / 2, (s0[1] + p[1]) / 2];
            const q0 = this.P([mid[0], mid[1], z0]), q1 = this.P([mid[0] + n[0] * 0.6, mid[1] + n[1] * 0.6, z0]);
            g += line(q0[0], q0[1], q1[0], q1[1], { stroke: 'var(--glass)', w: 1.4, dash: '3 2' });
          }
          g += label((a[0] + at[0]) / 2, (a[1] + at[1]) / 2 - 12, `${Math.round(len * 1000)} mm · ${Math.round(((ang % 360) + 360) % 360)}°`, { size: 9, fill: 'var(--glass)' });
        }
        return g;
      },
    };
  }
  wallClick(e) {
    const plan = this.wallAt(e);
    if (!plan) return;
    const w = this.wall, p = plan.point;
    if (!w.start) { w.start = p; this.preview(e); return; }
    if (Math.hypot(p[0] - w.start[0], p[1] - w.start[1]) < 0.05) return;
    const pr = this.wallProps(), a = w.start;
    let made = null;
    this.onChange((x) => { made = addWall(x, { a, b: p, base: pr.base, top: pr.top, asm: pr.asm, line: pr.line, side: w.side }); if (!made) return false; }, 'wall drawn');
    if (made) w.chain.push(made.id);
    if (pr.chain) { w.start = p; this.preview(e); } else this.stop();
  }
  // Space: the location line to the other side, for the walls of this chain and those to come
  flipWalls() {
    const w = this.wall;
    w.side = -w.side;
    const ids = [...w.chain];
    if (ids.length) this.onChange((x) => { for (const y of x.walls || []) if (ids.includes(y.id)) y.side = -(y.side || 1); }, 'location line flipped');
    if (this.last) this.preview(this.last);
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
      this.onChange((x) => { if (!mergeFaces(x, list[0].zone, list.map((y) => y.face))) { why = 'Only faces in line, one after another, can be merged.'; return false; } }, `${list.length} walls merged`);
    } else {
      this.onChange((x) => { if (!mergeCells(x, list[0].zone, list.map((y) => y.cell))) { why = 'Only pieces that meet can be merged.'; return false; } }, `${list.length} roof or floor pieces merged`);
    }
    this.picked = [];
    if (why) this.flashMessage(why); else if (this.last) this.preview(this.last);
  }

  // Why something could not be done, shown beside the pointer for a moment.
  flashMessage(text) {
    const e = this.last;
    if (!e) return;
    const [x, y] = this.px(e);
    this.out.innerHTML = label(x, y - 16, text, { size: 9.5, fill: 'var(--bad, #C0442B)' });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (this.last && this.tool) this.preview(this.last); }, 2200);
  }

  // The seam of the zone under the pointer nearest it: up a wall (a corner between two faces in line),
  // or across its roof (where two of its pieces meet).
  seamAt(m, t, e) {
    const i = t.zone, [z0, z1] = zoneLevels(m, i), px = this.px(e);
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
    if (this.ctx) { this.plan = this.planAt(e); this.ctx.svg.innerHTML = this.plan ? this.plan.draw() : ''; return; }
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
  beforeRender() { if (this.tool && this.last && this.plan && !this.pushing && !this.ctx) this.svg.innerHTML = this.plan.draw(); }
  // a plan view zoomed or panned under a preview: drawn again there
  redrawIn(ctx) { if (this.tool && this.ctx === ctx && this.plan && !this.pushing) ctx.svg.innerHTML = this.plan.draw(); }
}
