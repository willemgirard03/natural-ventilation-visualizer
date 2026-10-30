// A window edited in the 3D view, as in the Solar Shading Explorer's Edit window in 3D: its sill, head
// and jambs get handles that push or pull them, and the glass itself drags across its wall. A click on
// a handle (without dragging) types its figure: the sill or head height above the floor, or the width.
// The window's figures stay on the drawing beside it. Each drag or typed figure is one edit, made
// through onCommit(name, rect) once the pointer is let go; while dragging, the new outline is drawn,
// red where the wall will not take it.

import * as THREE from 'three';
import { askNumber, gripTexture } from './sections.js';

const GRIP_PX = 9, GRIP_HIT = 11, SNAP = 0.01; // m: drags move in 10 mm steps, 100 mm with Shift
const LINE = '#F2A900', BAD = '#D93025';

export class WindowEditor {
  // rectOf(name) -> { s0, s1, z0, z1, frame: { right, out, plane } } in building coordinates;
  // problem(name, rect) -> null or why the wall will not take it; clamp(name, rect) -> rect kept in the
  // wall's bounds; floorOf(name) -> the height of its room's floor; onCommit(name, rect).
  constructor(view, { rectOf, problem, clamp, floorOf, onCommit }) {
    Object.assign(this, { view, rectOf, problem, clamp, floorOf, onCommit });
    this.name = null;
    this.layer = new THREE.Group();
    this.layer.userData.noSection = true;
    view.scene.add(this.layer);
    this.figures = document.createElement('div');
    this.figures.className = 'winfigs';
    this.figures.hidden = true;
    view.container.appendChild(this.figures);
    this.figures.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fig]');
      if (f) this.type(e, f.dataset.fig);
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
    this.clear();
    this.figures.hidden = true;
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

  clear() {
    for (const o of [...this.layer.children]) { o.geometry?.dispose(); o.material?.dispose(); this.layer.remove(o); }
  }

  // A point in the wall's frame (s along it, z up) in view coordinates, just proud of the wall.
  at(s, z) {
    const { right, out, plane } = this.rect.frame, o = this.view.origin, d = plane + 0.04;
    return new THREE.Vector3(right[0] * s + out[0] * d - o[0], right[1] * s + out[1] * d - o[1], z - o[2]);
  }

  grips(r = this.draft || this.rect) {
    const sm = (r.s0 + r.s1) / 2, zm = (r.z0 + r.z1) / 2;
    return [
      { k: 'sill', at: this.at(sm, r.z0) },
      { k: 'head', at: this.at(sm, r.z1) },
      { k: 'left', at: this.at(r.s0, zm) },
      { k: 'right', at: this.at(r.s1, zm) },
    ];
  }

  draw() {
    this.clear();
    if (!this.name) return;
    const r = this.draft || this.rect, bad = this.draft && this.problem(this.name, this.draft);
    const c = [this.at(r.s0, r.z0), this.at(r.s1, r.z0), this.at(r.s1, r.z1), this.at(r.s0, r.z1)];
    const color = bad ? BAD : LINE;
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    line.renderOrder = 22; fill.renderOrder = 21;
    this.layer.add(fill, line);
    for (const g of this.grips(r)) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: gripTexture(), depthTest: false, transparent: true }));
      s.position.copy(g.at);
      s.renderOrder = 23;
      s.userData.grip = g;
      this.layer.add(s);
    }
    this.figuresFor(r, bad);
    this.view.render();
  }

  // The window's figures beside it: width under the sill, height beside the right jamb, sill height
  // under the left jamb. Each is typed over with a click.
  figuresFor(r, bad) {
    const mm = (x) => Math.round(x * 1000);
    const floor = this.floorOf(this.name);
    this.figures.innerHTML = [
      ['width', `W ${mm(r.s1 - r.s0)}`, 'Width, mm: click to type it (the right jamb moves)'],
      ['height', `H ${mm(r.z1 - r.z0)}`, 'Height, mm: click to type it (the head moves)'],
      ['sill', `Sill ${mm(r.z0 - floor)}`, 'Sill height above the floor, mm: click to type it (the window moves up or down)'],
    ].map(([k, t, tip]) => `<button type="button" class="wfig" data-fig="${k}" title="${tip}">${t}</button>`).join('')
      + (bad ? `<span class="wfig bad">${bad}</span>` : '');
    this.figures.hidden = false;
    this.placeFigures(r);
  }

  placeFigures(r = this.draft || this.rect) {
    if (!this.name || this.figures.hidden) return;
    const spot = { width: this.at((r.s0 + r.s1) / 2, r.z0), height: this.at(r.s1, (r.z0 + r.z1) / 2), sill: this.at(r.s0, r.z0) };
    const off = { width: [0, 16], height: [34, 0], sill: [-30, 16] };
    for (const el of this.figures.querySelectorAll('[data-fig]')) {
      const p = this.screen(spot[el.dataset.fig]), [dx, dy] = off[el.dataset.fig];
      el.style.transform = `translate(${p.x + dx}px, ${p.y + dy}px) translate(-50%, -50%)`;
    }
    const bad = this.figures.querySelector('.bad');
    if (bad) { const p = this.screen(this.at((r.s0 + r.s1) / 2, r.z1)); bad.style.transform = `translate(${p.x}px, ${p.y - 20}px) translate(-50%, -50%)`; }
  }

  // Before each render: handles keep their size on screen, figures follow the window.
  beforeRender() {
    if (!this.name) return;
    const sec = this.view.sections;
    for (const o of this.layer.children) if (o.isSprite) o.scale.setScalar(sec.scaleAt(o.position) * GRIP_PX * 2);
    this.placeFigures();
  }

  screen(point) { return this.view.sections.screen(point); }

  // A grip under the pointer, or the window's glass: { type: 'grip', k } or { type: 'body' }.
  handleAt(e) {
    if (!this.name) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect(), m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
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
        if (h) el.style.cursor = h.type === 'body' ? 'move' : h.k === 'sill' || h.k === 'head' ? 'ns-resize' : 'ew-resize';
        else if (el.style.cursor === 'move' || el.style.cursor.endsWith('-resize')) el.style.cursor = '';
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      e.stopImmediatePropagation();
      const step = e.shiftKey ? 0.1 : SNAP, delta = new THREE.Vector2(dx, dy), R = drag.r;
      const along = (from, dir) => { const s = this.view.sections.screenAxis(from, dir); return s.lengthSq() > 1e-6 ? delta.dot(s) / s.lengthSq() : 0; };
      const right = new THREE.Vector3(...this.rect.frame.right), up = new THREE.Vector3(0, 0, 1);
      const mid = this.at((R.s0 + R.s1) / 2, (R.z0 + R.z1) / 2);
      const ds = Math.round(along(mid, right) / step) * step, dz = Math.round(along(mid, up) / step) * step;
      let r = { ...R };
      if (drag.h.type === 'body') r = this.clamp(this.name, { s0: R.s0 + ds, s1: R.s1 + ds, z0: R.z0 + dz, z1: R.z1 + dz });
      else if (drag.h.k === 'sill') r.z0 = Math.min(R.z0 + dz, R.z1 - 0.2);
      else if (drag.h.k === 'head') r.z1 = Math.max(R.z1 + dz, R.z0 + 0.2);
      else if (drag.h.k === 'left') r.s0 = Math.min(R.s0 + ds, R.s1 - 0.2);
      else r.s1 = Math.max(R.s1 + ds, R.s0 + 0.2);
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
      if (d.h.type === 'grip') this.type(e, { sill: 'sill', head: 'head', left: 'width-left', right: 'width' }[d.h.k]);
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  // A figure typed: 'sill' or 'head' (mm above the floor), 'height' (mm, the head moves), 'width'
  // (mm, the right jamb moves) or 'width-left' (the left jamb moves).
  type(e, fig) {
    const R = this.rect, floor = this.floorOf(this.name), mm = (x) => Math.round(x * 1000);
    const now = { sill: R.z0 - floor, head: R.z1 - floor, height: R.z1 - R.z0, width: R.s1 - R.s0, 'width-left': R.s1 - R.s0 }[fig];
    const label = { sill: 'sill height', head: 'head height', height: 'height', width: 'width', 'width-left': 'width' }[fig];
    askNumber(this.view.container, e, `${label} mm, now ${mm(now)}`, (x) => {
      const v = x / 1000, r = { ...R };
      if (fig === 'sill') { r.z0 = floor + v; r.z1 = r.z0 + (R.z1 - R.z0); }
      else if (fig === 'head') r.z1 = floor + v;
      else if (fig === 'height') r.z1 = R.z0 + v;
      else if (fig === 'width') r.s1 = R.s0 + v;
      else r.s0 = R.s1 - v;
      const why = this.problem(this.name, r);
      if (why) { this.draft = r; this.draw(); setTimeout(() => { this.draft = null; this.draw(); }, 1600); return; }
      this.onCommit(this.name, r);
    }, fig === 'sill');
  }
}
