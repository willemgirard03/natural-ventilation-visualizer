// A massing's storey edited in the 3D view. With its whole zone selected, each face has a push/pull
// arrow (a wall takes its side of the plate; the roof raises the storey and everything above; the
// floor lowers into the storey below) and a gumball on its floor moves it along its own x and y, up (the storey
// below grows to meet it, the storeys above follow) and turns it about its middle. With one surface
// selected, that face's arrow alone. A click on a handle without dragging types its figure; the
// storey's width, depth and height stay on the drawing to type over. Each drag or figure is one edit,
// made through onChange(mutate, what) when the pointer is let go; while dragging, the storeys as they
// will be are drawn in outline.

import * as THREE from 'three';
import { askNumber } from './sections.js';
import { storeyFrame, pushFace, moveStorey } from '../src/model/massing.js';

const AXIS_COLORS = { x: '#c2412d', y: '#2f8a4e', z: '#2d5fc2' };
const FACE_COLOR = '#2F6F68', LINE = '#F2A900';
const ARROW_PX = 46, GUMBALL_PX = 70; // on screen
const FACE_NAMES = { S: 'south wall', E: 'east wall', N: 'north wall', W: 'west wall', roof: 'roof', floor: 'floor' };

export class MassingEditor {
  // massing() -> the massing; onChange(mutate, what).
  constructor(view, { massing, onChange }) {
    Object.assign(this, { view, massing, onChange });
    this.target = null; // { storey, face }: face null for the whole zone
    this.layer = new THREE.Group();
    this.layer.userData.noSection = true;
    view.scene.add(this.layer);
    this.figures = document.createElement('div');
    this.figures.className = 'winfigs';
    this.figures.hidden = true;
    view.container.appendChild(this.figures);
    this.figures.addEventListener('click', (e) => { const f = e.target.closest('[data-fig]'); if (f) this.type(e, { type: 'figure', k: f.dataset.fig }); });
    this.wire();
  }

  get active() { return !!this.target; }

  start(target) { this.target = target; this.draft = null; this.draw(); }
  stop() {
    if (!this.target) return;
    this.target = null; this.draft = null;
    this.clear();
    this.figures.hidden = true;
    this.view.render();
  }
  // The massing changed (an edit, undo or redo): the handles as it is now.
  refresh() {
    const m = this.massing();
    if (!this.target) return;
    if (!m || this.target.storey >= m.storeys.length) { this.stop(); return; }
    this.draft = null;
    this.draw();
  }
  clear() { for (const o of [...this.layer.children]) { o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); }); this.layer.remove(o); } }

  v(p) { const o = this.view.origin; return new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2]); }

  draw() {
    this.clear();
    const m = this.draft || this.massing();
    if (!this.target || !m) return;
    const { storey: i, face } = this.target, fr = storeyFrame(m, i);
    if (this.draft) {
      // the storeys as they will be, in outline
      const pos = [];
      for (let k = 0; k < m.storeys.length; k++) {
        const f = storeyFrame(m, k);
        for (let j = 0; j < 4; j++) {
          const a = f.corners[j], b = f.corners[(j + 1) % 4];
          for (const z of [f.z0, f.z1]) pos.push(this.v([a[0], a[1], z]), this.v([b[0], b[1], z]));
          pos.push(this.v([a[0], a[1], f.z0]), this.v([a[0], a[1], f.z1]));
        }
      }
      const g = new THREE.BufferGeometry().setFromPoints(pos);
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: LINE, depthTest: false, transparent: true }));
      line.renderOrder = 22;
      this.layer.add(line);
    }
    this.handles = [];
    for (const f of fr.faces) if (!face || f.key === face) this.addArrow(this.v(f.at), new THREE.Vector3(...f.normal), FACE_COLOR, { type: 'face', k: f.key, normal: f.normal }, ARROW_PX);
    if (!face) {
      // on the storey's floor, clear of the roof's arrow (the floor's points down, the gumball's up)
      const c = this.v([fr.centre[0], fr.centre[1], fr.z0]), g = new THREE.Group();
      g.position.copy(c);
      g.userData.px = GUMBALL_PX;
      this.layer.add(g);
      this.gumball = g;
      this.addArrow(new THREE.Vector3(), new THREE.Vector3(...fr.x), AXIS_COLORS.x, { type: 'move', k: 'x', dir: fr.x }, null, g);
      this.addArrow(new THREE.Vector3(), new THREE.Vector3(...fr.y), AXIS_COLORS.y, { type: 'move', k: 'y', dir: fr.y }, null, g);
      if (i > 0) this.addArrow(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), AXIS_COLORS.z, { type: 'move', k: 'z', dir: [0, 0, 1] }, null, g);
      // the turning ring, level, about the storey's middle
      const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLORS.z, depthTest: false, transparent: true });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.016, 6, 64), mat);
      const hit = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.08, 6, 32), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.handle = { type: 'turn', k: 'turn' };
      this.handles.push(hit);
      g.add(ring, hit);
      g.traverse((o) => { o.renderOrder = 20; });
    } else this.gumball = null;
    this.figuresFor(m, fr);
    this.beforeRender();
    this.view.render();
  }

  // An arrow from `at` along `dir`: in its own group sized to the screen (px), or inside `parent`.
  addArrow(at, dir, color, handle, px, parent = null) {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    const a = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.78, 8), mat);
    shaft.position.y = 0.47;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 16), mat);
    tip.position.y = 0.9;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.55;
    hit.userData.handle = handle;
    this.handles.push(hit);
    a.add(shaft, tip, hit);
    a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    a.position.copy(at);
    a.traverse((o) => { o.renderOrder = 21; });
    if (parent) parent.add(a);
    else { a.userData.px = px; this.layer.add(a); }
  }

  // The storey's figures: width, depth and height, beside its edges; a click types one.
  figuresFor(m, fr) {
    const s = m.storeys[this.target.storey], mm = (x) => Math.round(x * 1000);
    const c = fr.corners;
    this.spots = {
      w: this.v([(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2, fr.z0]),
      d: this.v([(c[1][0] + c[2][0]) / 2, (c[1][1] + c[2][1]) / 2, fr.z0]),
      h: this.v([c[1][0], c[1][1], (fr.z0 + fr.z1) / 2]),
    };
    this.figures.innerHTML = [['w', `W ${mm(s.w)}`, 'Width, mm, along the storey’s south side: click to type it (the east side moves)'],
      ['d', `D ${mm(s.d)}`, 'Depth, mm, along its east side: click to type it (the north side moves)'],
      ['h', `H ${mm(s.h)}`, 'Floor-to-floor height, mm: click to type it (the storeys above move with the roof)'],
      ...(s.rot ? [['rot', `${+s.rot.toFixed(1)}°`, 'Turned clockwise, degrees, about its middle: click to type it']] : [])]
      .map(([k, t, tip]) => `<button type="button" class="wfig" data-fig="${k}" title="${tip}">${t}</button>`).join('');
    this.spots.rot = this.v(fr.centre);
    this.figures.hidden = false;
  }

  screen(p) { return this.view.sections.screen(p); }

  // Before each render: handles keep their size on screen, figures follow the storey.
  beforeRender() {
    if (!this.target) return;
    const sec = this.view.sections;
    for (const o of this.layer.children) if (o.userData.px) o.scale.setScalar(sec.scaleAt(o.position) * o.userData.px);
    if (this.figures.hidden) return;
    const off = { w: [0, 18], d: [26, 12], h: [36, 0], rot: [0, -26] };
    for (const el of this.figures.querySelectorAll('[data-fig]')) {
      const k = el.dataset.fig, p = this.screen(this.spots[k]), [dx, dy] = off[k];
      el.style.transform = `translate(${p.x + dx}px, ${p.y + dy}px) translate(-50%, -50%)`;
    }
  }

  handleAt(e) {
    if (!this.target || !this.handles?.length) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.view.camera);
    this.layer.updateMatrixWorld(true);
    return ray.intersectObjects(this.handles, false)[0]?.object.userData.handle || null;
  }

  // The pointer's angle about the storey's middle, in the level plane through it.
  angleAt(e, centre) {
    const r = this.view.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.view.camera);
    if (Math.abs(ray.ray.direction.z) < 0.12) return null;
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -centre.z), new THREE.Vector3());
    return hit ? Math.atan2(hit.y - centre.y, hit.x - centre.x) : null;
  }

  // The massing as it would be with a handle moved by `x` (m, or degrees for the turn).
  apply(m, h, x) {
    const i = this.target.storey;
    if (h.type === 'face') pushFace(m, i, h.k, x);
    else if (h.type === 'move') moveStorey(m, i, h.k, x);
    else if (h.type === 'turn') m.storeys[i].rot = +(((m.storeys[i].rot || 0) + x + 540) % 360 - 180).toFixed(3);
    return m;
  }
  what(h) {
    const s = `storey ${this.target.storey + 1}`;
    return h.type === 'face' ? `${s} ${FACE_NAMES[h.k]} pushed or pulled` : h.type === 'move' ? `${s} moved` : `${s} turned`;
  }

  wire() {
    const el = this.view.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.target) return;
      const h = this.handleAt(e);
      if (!h) return;
      e.stopImmediatePropagation();
      el.setPointerCapture(e.pointerId);
      const fr = storeyFrame(this.massing(), this.target.storey);
      drag = { h, x: e.clientX, y: e.clientY, moved: false, from: this.v(h.type === 'face' ? fr.faces.find((f) => f.key === h.k).at : fr.centre), centre: this.v([fr.centre[0], fr.centre[1], fr.z0]) };
      if (h.type === 'turn') drag.a0 = this.angleAt(e, drag.centre);
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!this.target) return;
      if (!drag) {
        const h = this.handleAt(e);
        if (h) el.style.cursor = h.type === 'turn' ? 'grab' : 'move';
        else if (el.style.cursor === 'grab' || el.style.cursor === 'move') el.style.cursor = '';
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      e.stopImmediatePropagation();
      let x;
      if (drag.h.type === 'turn') {
        const a = this.angleAt(e, drag.centre);
        if (a == null || drag.a0 == null) return;
        const step = e.shiftKey ? 15 : 1;
        x = Math.round((-(a - drag.a0) * 180) / Math.PI / step) * step; // clockwise in plan
      } else {
        const dir = new THREE.Vector3(...(drag.h.normal || drag.h.dir)), s = this.view.sections.screenAxis(drag.from, dir);
        const step = e.shiftKey ? 0.5 : 0.05;
        x = s.lengthSq() > 1e-6 ? Math.round(new THREE.Vector2(dx, dy).dot(s) / s.lengthSq() / step) * step : 0;
      }
      drag.x1 = x;
      this.draft = this.apply(structuredClone(this.massing()), drag.h, x);
      this.draw();
    }, true);
    const end = (e) => {
      if (!drag) return;
      el.releasePointerCapture?.(e.pointerId);
      const d = drag;
      drag = null;
      this.draft = null;
      if (d.moved) {
        if (d.x1) this.onChange((m) => this.apply(m, d.h, d.x1), this.what(d.h));
        else this.draw();
        return;
      }
      this.type(e, d.h);
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  // A handle clicked, or a figure: a distance or angle to type.
  type(e, h) {
    const m = this.massing(), i = this.target.storey, s = m.storeys[i], mm = (x) => Math.round(x * 1000);
    if (h.type === 'figure') {
      const k = h.k;
      if (k === 'rot') { askNumber(this.view.container, e, `turn °, now ${+(s.rot || 0).toFixed(1)}`, (x) => this.onChange((mm2) => { mm2.storeys[i].rot = x; }, `storey ${i + 1} turned`), true); return; }
      const face = { w: 'E', d: 'N', h: 'roof' }[k];
      askNumber(this.view.container, e, `${{ w: 'width', d: 'depth', h: 'height' }[k]} mm, now ${mm(s[k])}`, (x) => this.onChange((m2) => pushFace(m2, i, face, x / 1000 - m2.storeys[i][k]), `storey ${i + 1} ${{ w: 'width', d: 'depth', h: 'height' }[k]} set`));
      return;
    }
    const label = h.type === 'turn' ? 'turn °, clockwise' : h.type === 'move' ? `move mm along ${h.k}` : `push or pull the ${FACE_NAMES[h.k]}, mm`;
    askNumber(this.view.container, e, label, (x) => this.onChange((m2) => this.apply(m2, h, h.type === 'turn' ? x : x / 1000), this.what(h)));
  }
}
