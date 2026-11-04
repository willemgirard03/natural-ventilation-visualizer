// A window edited in the 3D view, as the facade-windows skill's Edit window in 3D: grips on its sill, head
// and jambs (9 px squares), the glass drawn selected, and its figures on the drawing, typed over with a
// click. A jamb grows the window both ways about its middle, at twice the pointer's run; the sill moves
// with the head held, the head with the sill held. The glass itself drags across its wall.
//
// A window free to move (broken out of its array, or any window not in a massing's array) gets a gumball
// at its middle: a red arrow along its wall and a blue arrow up, each moving it along that axis only; a
// click on one types the move. The glass dragged moves along whichever axis the pointer takes first.
// A window of an array has none: dragged, it sets the array's pitch instead (massedit.js).
//
// A window of a massing has a Size (sizeOf): its figures are then those that Size keeps - Fixed: width,
// height, sill; Offsets: the gap to the slab, to its bay's edge, the sill; Proportional: shares of the
// bay and the wall - and its bay is drawn dashed. Any other window shows Fixed's. A drag commits a new
// outline (onCommit(name, rect)); a typed figure goes to onFigure(name, key, value) for a massing's
// window, else as an outline. While dragging, the outline is red where the wall will not take it.

import * as THREE from 'three';
import { askNumber } from './sections.js';
import { gripMark, label, poly, CLICK_PX, gumball3D, gripAt, AXIS } from './handles.js';

const GRIP_HIT = 11, SNAP = 0.005; // m: drags move in 5 mm steps, 100 mm with Shift
const BAD = '#C0442B';
const mm = (x) => Math.round(x * 1000);
const pc = (x) => `${Math.round(x * 100)}%`;

export class WindowEditor {
  // rectOf(name) -> { s0, s1, z0, z1, frame: { right, out, plane } } in building coordinates;
  // problem(name, rect) -> null or why the wall will not take it; clamp(name, rect) -> rect kept in the
  // wall's bounds; floorOf(name) -> the height of its room's floor; depthOf(name) -> how far the glass
  // is drawn from the wall's modelled plane; sizeOf(name) -> null, or for a massing's window
  // { size, bay: [s0, s1], top, slab }; onCommit(name, rect); onFigure(name, key, value).
  constructor(view, { rectOf, problem, clamp, floorOf, depthOf = () => 0, sizeOf = () => null, onCommit, onFigure = null }) {
    Object.assign(this, { view, rectOf, problem, clamp, floorOf, depthOf, sizeOf, onCommit, onFigure });
    this.name = null;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles');
    view.container.appendChild(this.svg);
    // taken on press: the overlay is redrawn with every frame while the air moves
    this.svg.addEventListener('pointerdown', (e) => {
      const f = e.target.closest('[data-edit]');
      if (!f || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.type(e, f.dataset.edit);
    });
    this.wire();
  }

  get active() { return !!this.name; }

  start(name) {
    const r = this.rectOf(name);
    if (!r) return false;
    this.name = name;
    this.rect = r;
    this.draft = null;
    this.draw();
    return true;
  }

  stop() {
    this.name = null;
    this.draft = null;
    this.svg.innerHTML = this.shown = '';
    this.view.renderer.domElement.style.cursor = '';
    this.view.render();
  }

  // The model changed under it (an edit, undo or redo): its window as it is now, or done when gone.
  refresh() {
    if (!this.name) return;
    const r = this.rectOf(this.name);
    if (!r) { this.stop(); return; }
    this.rect = r;
    this.draft = null;
    this.draw();
  }

  // A point in the wall's frame (s along it, z up) in view coordinates, on the glass as drawn.
  at(s, z) {
    const { right, out, plane } = this.rect.frame, o = this.view.origin, d = plane + this.depthOf(this.name) + 0.03;
    return new THREE.Vector3(right[0] * s + out[0] * d - o[0], right[1] * s + out[1] * d - o[1], z - o[2]);
  }
  // ... on the wall's face (the bay's outline).
  onWall(s, z) {
    const { right, out, plane } = this.rect.frame, o = this.view.origin;
    return new THREE.Vector3(right[0] * s + out[0] * (plane + 0.03) - o[0], right[1] * s + out[1] * (plane + 0.03) - o[1], z - o[2]);
  }
  P = (v) => { const s = this.view.sections.screen(v); return [s.x, s.y]; };

  grips(r = this.draft || this.rect) {
    const sm = (r.s0 + r.s1) / 2, zm = (r.z0 + r.z1) / 2;
    return [
      { k: 'sill', at: this.at(sm, r.z0) },
      { k: 'head', at: this.at(sm, r.z1) },
      { k: 'left', at: this.at(r.s0, zm) },
      { k: 'right', at: this.at(r.s1, zm) },
    ];
  }

  // The window drawn selected (glass at 0.42, a 3 px outline, a dashed inner line), its bay under
  // Offsets and Proportional, its grips and its figures.
  draw(render = true) {
    if (!this.name) return;
    const canvas = this.view.renderer.domElement, cr = canvas.getBoundingClientRect(), kr = this.view.container.getBoundingClientRect();
    Object.assign(this.svg.style, { left: `${cr.left - kr.left}px`, top: `${cr.top - kr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` });
    const r = this.draft || this.rect, bad = this.draft && this.problem(this.name, this.draft), sz = this.sizeOf(this.name), P = this.P;
    const col = bad ? BAD : 'var(--glass)', floor = this.floorOf(this.name);
    const c = [this.at(r.s0, r.z0), this.at(r.s1, r.z0), this.at(r.s1, r.z1), this.at(r.s0, r.z1)].map(P);
    let g = '';
    if (sz && sz.size !== 'fixed') {
      const b = [this.onWall(sz.bay[0], floor), this.onWall(sz.bay[1], floor), this.onWall(sz.bay[1], sz.top), this.onWall(sz.bay[0], sz.top)].map(P);
      g += poly(b, { stroke: 'var(--glass)', w: 0.8, dash: '3 3' });
    }
    g += poly(c, { fill: col, op: 0.42 }) + poly(c, { stroke: col, w: 3 }) + poly(c, { stroke: 'var(--panel)', w: 1.2, dash: '3 2.5' });
    for (const q of this.grips(r)) { const p = P(q.at); g += gripMark(p[0], p[1]); }
    this.gum = [];
    if (!sz || sz.free) {
      const mid = this.at((r.s0 + r.s1) / 2, (r.z0 + r.z1) / 2), O = P(mid), right = new THREE.Vector3(...this.rect.frame.right);
      const run = (v) => { const a = this.view.sections.screen(mid), b = this.view.sections.screen(mid.clone().add(v)); return [b.x - a.x, b.y - a.y]; };
      g += gumball3D(this.gum, O, [{ key: 'along', from: 0, dir: run(right), col: AXIS.x }, { key: 'up', from: 0, dir: run(new THREE.Vector3(0, 0, 1)), col: AXIS.z }]);
      this.gum = this.gum.filter((x) => x.arrow);
    }
    g += this.figures(r, sz, floor, c);
    if (bad) { const p = P(this.at((r.s0 + r.s1) / 2, r.z1)); g += label(p[0], p[1] - 22, bad, { fill: BAD }); }
    if (this.shown !== g) this.svg.innerHTML = this.shown = g;
    if (render) this.view.render();
  }

  // The figures its Size keeps, each typed over: below the sill (18 px), above the head (12 px), right of
  // the right jamb, and at the lower left corner.
  figures(r, sz, floor, c) {
    const size = sz?.size || 'fixed', P = this.P, w = r.s1 - r.s0, f = [];
    const below = P(this.at((r.s0 + r.s1) / 2, r.z0)), above = P(this.at((r.s0 + r.s1) / 2, r.z1)), right = P(this.at(r.s1, (r.z0 + r.z1) / 2));
    const corner = c[0], o = { size: 9 };
    if (size === 'fixed') {
      f.push(label(below[0], below[1] + 18, `w ${mm(w)} mm`, { ...o, edit: 'winW' }));
      f.push(label(right[0] + 34, right[1] + 3, `h ${mm(r.z1 - r.z0)} mm`, { ...o, edit: 'winH' }));
    } else if (size === 'offset') {
      f.push(label(above[0], above[1] - 12, `to ${sz.slab ? 'slab' : 'roof'} ${mm(sz.top - r.z1)} mm`, { ...o, edit: 'headGap' }));
      f.push(label(right[0] + 44, right[1] + 3, `to bay ${mm(sz.bay[1] - r.s1)} mm`, { ...o, edit: 'jamb' }));
    } else {
      f.push(label(below[0], below[1] + 18, `w ${pc(w / (sz.bay[1] - sz.bay[0]))} of bay`, { ...o, edit: 'widthR' }));
      f.push(label(above[0], above[1] - 12, `head ${pc((r.z1 - floor) / (sz.top - floor))}`, { ...o, edit: 'headR' }));
    }
    const sill = size === 'ratio' ? `sill ${pc((r.z0 - floor) / (sz.top - floor))}` : `sill ${mm(r.z0 - floor)} mm`;
    f.push(label(corner[0] - 6, corner[1] + 14, sill, { ...o, anchor: 'end', edit: size === 'ratio' ? 'sillR' : 'sill' }));
    return f.join('');
  }

  // Before each render: redrawn where the camera now puts it.
  beforeRender() { if (this.name) this.draw(false); }

  screen(point) { return this.view.sections.screen(point); }

  // A grip under the pointer, or the window's glass: { type: 'grip', k } or { type: 'body' }.
  handleAt(e) {
    if (!this.name) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect(), m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    // the gumball's arrows first, but a grip's own square (the right jamb's can sit on the red arrow) wins
    const near = this.grips().find((g) => this.screen(g.at).distanceTo(m) < 6);
    const arrow = !near && this.gum?.length && gripAt(this.gum, [m.x, m.y]);
    if (arrow) return { type: 'axis', axis: arrow.key };
    for (const g of this.grips()) if (this.screen(g.at).distanceTo(m) < GRIP_HIT) return { type: 'grip', k: g.k };
    const R = this.rect, c = [this.at(R.s0, R.z0), this.at(R.s1, R.z0), this.at(R.s1, R.z1), this.at(R.s0, R.z1)].map((p) => this.screen(p));
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      if ((c[i].y > m.y) !== (c[j].y > m.y) && m.x < ((c[j].x - c[i].x) * (m.y - c[i].y)) / (c[j].y - c[i].y) + c[i].x) inside = !inside;
    }
    return inside ? { type: 'body' } : null;
  }

  wire() {
    const el = this.view.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.name) return;
      const h = this.handleAt(e);
      if (!h) return;
      e.stopImmediatePropagation();
      el.setPointerCapture(e.pointerId);
      drag = { h, x: e.clientX, y: e.clientY, r: { ...this.rect }, moved: false };
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!this.name) return;
      if (!drag) {
        const h = this.handleAt(e);
        if (h) el.style.cursor = h.type === 'body' ? 'move' : h.type === 'axis' ? (h.axis === 'up' ? 'ns-resize' : 'ew-resize') : h.k === 'sill' || h.k === 'head' ? 'ns-resize' : 'ew-resize';
        else if (el.style.cursor === 'move' || el.style.cursor.endsWith('-resize')) el.style.cursor = '';
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < CLICK_PX) return;
      drag.moved = true;
      e.stopImmediatePropagation();
      const step = e.shiftKey ? 0.1 : SNAP, delta = new THREE.Vector2(dx, dy), R = drag.r;
      const along = (from, dir) => { const s = this.view.sections.screenAxis(from, dir); return s.lengthSq() > 1e-6 ? delta.dot(s) / s.lengthSq() : 0; };
      const right = new THREE.Vector3(...this.rect.frame.right), up = new THREE.Vector3(0, 0, 1);
      const mid = this.at((R.s0 + R.s1) / 2, (R.z0 + R.z1) / 2);
      const ds = Math.round(along(mid, right) / step) * step, dz = Math.round(along(mid, up) / step) * step;
      // A massing's window stops at its limits: the floor, the slab (or just under the roof) and its
      // bay's edges; any other window is held in its wall when dragged whole.
      const sz = this.sizeOf(this.name), floor = this.floorOf(this.name);
      const top = sz ? sz.top - (sz.slab ? 0 : 0.02) : Infinity, b0 = sz ? sz.bay[0] + 0.01 : -Infinity, b1 = sz ? sz.bay[1] - 0.01 : Infinity;
      const lim = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
      let r = { ...R };
      if (drag.h.type === 'body' || drag.h.type === 'axis') {
        // one axis at a time: the arrow's, or for the glass, the way the pointer first went
        if (drag.h.type === 'body' && !drag.axis && (ds || dz) && (!sz || sz.free)) drag.axis = Math.abs(ds) >= Math.abs(dz) ? 'along' : 'up';
        const axis = drag.h.type === 'axis' ? drag.h.axis : drag.axis;
        const s = axis === 'up' ? 0 : lim(ds, b0 - R.s0, b1 - R.s1), z = axis === 'along' ? 0 : lim(dz, (sz ? floor : -Infinity) - R.z0, top - R.z1);
        r = this.clamp(this.name, { s0: R.s0 + s, s1: R.s1 + s, z0: R.z0 + z, z1: R.z1 + z });
      } else if (drag.h.k === 'sill') r.z0 = lim(R.z0 + dz, sz ? floor : -Infinity, R.z1 - 0.2);
      else if (drag.h.k === 'head') r.z1 = lim(R.z1 + dz, R.z0 + 0.2, top);
      else {
        // a jamb: the window grows both ways about its middle, at twice the pointer's run, up to its bay
        const m = (R.s0 + R.s1) / 2, out = drag.h.k === 'right' ? ds : -ds, half = lim((R.s1 - R.s0) / 2 + out, 0.15, Math.min(m - b0, b1 - m));
        r.s0 = m - half; r.s1 = m + half;
      }
      this.draft = r;
      this.draw();
    }, true);
    const end = (e) => {
      if (!drag) return;
      el.releasePointerCapture?.(e.pointerId);
      const d = drag;
      drag = null;
      if (d.moved) {
        const r = this.draft;
        this.draft = null;
        if (r && !this.problem(this.name, r)) this.onCommit(this.name, r);
        else this.draw();
        return;
      }
      if (d.h.type === 'axis') {
        const along = d.h.axis === 'along';
        askNumber(this.view.container, e, along ? 'move along the wall, mm (+ right, seen from outside)' : 'move up, mm', (x) => {
          const v = x / 1000, R = this.rect, r = this.clamp(this.name, along ? { ...R, s0: R.s0 + v, s1: R.s1 + v } : { ...R, z0: R.z0 + v, z1: R.z1 + v });
          if (!this.problem(this.name, r)) this.onCommit(this.name, r);
        }, true);
        return;
      }
      if (d.h.type === 'grip') {
        const size = this.sizeOf(this.name)?.size || 'fixed';
        const key = { sill: size === 'ratio' ? 'sillR' : 'sill', head: { fixed: 'winH', offset: 'headGap', ratio: 'headR' }[size], left: { fixed: 'winW', offset: 'jamb', ratio: 'widthR' }[size] }[d.h.k] || { fixed: 'winW', offset: 'jamb', ratio: 'widthR' }[size];
        this.type(e, key);
      }
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  // A figure typed over: lengths in mm, shares in %. A massing's window takes it as its Size keeps it
  // (onFigure); any other window as a new outline, the width about its middle, a height keeping the sill.
  type(e, key) {
    const R = this.rect, floor = this.floorOf(this.name), sz = this.sizeOf(this.name), w = R.s1 - R.s0;
    const now = {
      winW: mm(w), winH: mm(R.z1 - R.z0), sill: mm(R.z0 - floor),
      headGap: sz && mm(sz.top - R.z1), jamb: sz && mm(sz.bay[1] - R.s1),
      widthR: sz && Math.round((100 * w) / (sz.bay[1] - sz.bay[0])), headR: sz && Math.round((100 * (R.z1 - floor)) / (sz.top - floor)), sillR: sz && Math.round((100 * (R.z0 - floor)) / (sz.top - floor)),
    }[key];
    const ratio = key.endsWith('R'), what = { winW: 'width', winH: 'height', sill: 'sill', headGap: `gap to the ${sz?.slab ? 'slab' : 'roof'}`, jamb: 'gap to the bay', widthR: 'width, % of the bay', headR: 'head, % of the wall', sillR: 'sill, % of the wall' }[key];
    askNumber(this.view.container, e, `${what}${ratio ? '' : ' mm'}, now ${now}${ratio ? '%' : ''}`, (x) => {
      const v = ratio ? x / 100 : x / 1000;
      if (sz && this.onFigure) { this.onFigure(this.name, key, v); return; }
      const r = { ...R }, m = (R.s0 + R.s1) / 2;
      if (key === 'sill') { r.z0 = floor + v; r.z1 = r.z0 + (R.z1 - R.z0); } else if (key === 'winH') r.z1 = R.z0 + v;
      else if (key === 'winW') { r.s0 = m - v / 2; r.s1 = m + v / 2; }
      const why = this.problem(this.name, r);
      if (why) { this.draft = r; this.draw(); setTimeout(() => { this.draft = null; this.draw(); }, 1600); return; }
      this.onCommit(this.name, r);
    }, key === 'sill' || key === 'headGap' || key === 'jamb');
  }
}
