// Section planes in the 3D view: vertical sections and horizontal plan cuts, as many as needed (up to
// MAX). Each removes what lies on one side of it, but only within its bounds, a rectangle in the
// plane, as a section in Revit is cropped. Every material in the scene is patched to discard what a
// plane removes, so walls, windows, particles and the air's slices are all cut alike.
//
// A plane is picked by its outline. Picked, it shows a gumball (arrows along the model's x, y and z,
// as in the Solar Shading Explorer, and an arc to turn it about the vertical) and a grip on each side
// of its bounds. Its outline drags it along its normal; a click on an arrow (without dragging) asks for
// a distance to move it by. Planes are kept in view coordinates (the model's, shifted by the view's
// origin).

import * as THREE from 'three';

export const MAX = 8;
const AXIS_COLORS = ['#c2412d', '#2f8a4e', '#2d5fc2']; // x, y, z
const GLASS = '#2F6F68', SUN = '#D9821A';
const GUMBALL_PX = 72; // arrow length on screen
const GRIP_PX = 9, PICK_PX = 7, GRIP_HIT = 11;
const SNAP = 0.05; // m, moves by arrow
const SQUARE_PULL = 10; // degrees: a turned plane snaps to the world's axes this close to them
const MARGIN = 1; // m, around the building for new bounds

// The plane's frame: normal n (towards the side removed), u along it, v across it (up for a section).
export function frameOf(p) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const u = new THREE.Vector3(c, s, 0);
  let v, n;
  if (p.kind === 'plan') { v = new THREE.Vector3(-s, c, 0); n = new THREE.Vector3(0, 0, 1); }
  else { v = new THREE.Vector3(0, 0, 1); n = new THREE.Vector3(s, -c, 0); }
  if (p.flip) n.negate();
  return { o: p.o, u, v, n };
}

// Whether a point (view coordinates) is removed by a plane.
export function removes(p, point) {
  const { o, u, v, n } = frameOf(p);
  const d = point.clone().sub(o);
  if (d.dot(n) <= 0) return false;
  const pu = d.dot(u), pv = d.dot(v);
  return pu > p.b[0] && pu < p.b[1] && pv > p.b[2] && pv < p.b[3];
}

export class Sections {
  // view: the View3D; onChange(): planes moved, added or removed; onSelect(plane or null).
  constructor(view, { onChange = () => {}, onSelect = () => {} } = {}) {
    this.view = view;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.planes = [];
    this.selected = null;
    this.count = 0; // planes ever made, for their names
    this.uniforms = {
      secCount: { value: 0 },
      secO: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
      secN: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
      secU: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
      secV: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
      secB: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) },
    };
    this.layer = new THREE.Group(); // outlines, grips and the gumball: never cut themselves
    this.layer.userData.noSection = true;
    view.scene.add(this.layer);
    this.gumball = this.makeGumball();
    this.layer.add(this.gumball);
    this.wire();
  }

  // ---------- the cut, in every material ----------

  // Makes a material discard what the planes remove; `skip` is a plane it ignores (its own, for a
  // slice or a cap drawn in that plane).
  // extra(shader): further changes to the shader (the caps' hatch).
  patch(material, skip = -1, extra = null) {
    if (material.userData.sectioned === skip) return;
    material.userData.sectioned = skip;
    const u = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSecW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSecW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vSecW;
uniform int secCount;
uniform vec3 secO[${MAX}]; uniform vec3 secN[${MAX}]; uniform vec3 secU[${MAX}]; uniform vec3 secV[${MAX}]; uniform vec4 secB[${MAX}];`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
for (int i = 0; i < ${MAX}; i++) {
  if (i >= secCount) break;
  if (i == ${skip}) continue;
  vec3 d = vSecW - secO[i];
  if (dot(d, secN[i]) > 0.0) {
    float pu = dot(d, secU[i]), pv = dot(d, secV[i]);
    if (pu > secB[i].x && pu < secB[i].y && pv > secB[i].z && pv < secB[i].w) discard;
  }
}`);
      extra?.(shader);
    };
    material.customProgramCacheKey = () => `sec${skip}`;
    material.needsUpdate = true;
  }

  // Patches every material in the scene not yet patched (called before each render), except what is
  // marked noSection (these handles, the wind rose).
  patchScene() {
    const visit = (o) => {
      if (o.userData.noSection) return;
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) if (m.userData.sectioned === undefined && m.onBeforeCompile && !m.isShaderMaterial) this.patch(m);
      for (const c of o.children) visit(c);
    };
    visit(this.view.scene);
  }

  // Whether any plane removes a point (view coordinates).
  removed(point) { return this.planes.some((p) => removes(p, point)); }

  // ---------- planes ----------

  // The building's box, view coordinates.
  box() {
    const o = this.view.origin, b = new THREE.Box3();
    for (const s of this.view.surfaces) for (const q of s.vertices) b.expandByPoint(new THREE.Vector3(q[0] - o[0], q[1] - o[1], q[2] - o[2]));
    return b;
  }

  // Bounds covering the building, with a margin, in a plane's frame.
  fullBounds(p) {
    const { o, u, v } = frameOf(p), b = this.box();
    const us = [], vs = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const d = new THREE.Vector3(x, y, z).sub(o);
      us.push(d.dot(u)); vs.push(d.dot(v));
    }
    return [Math.min(...us) - MARGIN, Math.max(...us) + MARGIN, Math.min(...vs) - MARGIN, Math.max(...vs) + MARGIN];
  }

  // A new plane through a point. A section runs along `along` (a horizontal direction: the normal of
  // the wall pointed at, so the section stands square to that wall) or else along the building's long
  // side or across it, whichever faces the camera more; it removes the side towards the camera. A plan
  // cut removes what is above it.
  make(kind, at, along = null) {
    const p = { kind, o: at.clone(), yaw: 0, flip: false, b: [0, 0, 0, 0] };
    const axis = this.view.longAxis || 0; // radians, the footprint's long side from model x
    const look = this.view.camera.position.clone().sub(at).setZ(0).normalize();
    const facing = (y) => Math.sin(y) * look.x - Math.cos(y) * look.y; // n = (sin yaw, -cos yaw) towards the camera
    if (kind === 'section') {
      const a = along ? Math.atan2(along.y, along.x) : null;
      const options = along ? [a, a + Math.PI] : [axis, axis + Math.PI / 2, axis + Math.PI, axis - Math.PI / 2];
      p.yaw = options.reduce((best, y) => (facing(y) > facing(best) ? y : best));
    } else p.yaw = axis;
    p.b = this.fullBounds(p);
    return p;
  }

  add(kind, at, along = null) {
    if (this.planes.length >= MAX) return null;
    const p = this.make(kind, at, along);
    p.id = ++this.count;
    p.name = `${kind === 'plan' ? 'Plan cut' : 'Section'} ${p.id}`;
    this.planes.push(p);
    this.select(p);
    this.changed();
    return p;
  }

  remove(p) {
    this.planes = this.planes.filter((q) => q !== p);
    if (this.selected === p) this.select(null);
    this.changed();
  }

  clear() {
    this.planes = [];
    this.select(null);
    this.changed();
  }

  select(p) {
    this.selected = p;
    this.draw();
    this.onSelect(p);
  }

  flip(p) {
    p.flip = !p.flip;
    this.changed();
  }

  // A plan cut at a height (view coordinates) over the whole building, made or moved: for the model
  // checks' "Show in 3D". Returns it.
  planAt(z) {
    let p = this.planes.find((q) => q.kind === 'plan' && q.forChecks);
    if (!p) {
      const c = this.box().getCenter(new THREE.Vector3());
      p = this.make('plan', c.setZ(z));
      p.id = ++this.count;
      p.name = `Plan cut ${p.id}`;
      p.forChecks = true;
      if (this.planes.length >= MAX) this.planes.shift();
      this.planes.push(p);
    }
    p.o.z = z;
    this.changed();
    return p;
  }

  changed() {
    const u = this.uniforms;
    u.secCount.value = this.planes.length;
    this.planes.forEach((p, i) => {
      const f = frameOf(p);
      u.secO.value[i].copy(f.o); u.secN.value[i].copy(f.n); u.secU.value[i].copy(f.u); u.secV.value[i].copy(f.v);
      u.secB.value[i].set(...p.b);
    });
    this.draw();
    this.view.caps?.update();
    this.onChange();
    this.view.render();
  }

  // ---------- what is drawn ----------

  corners(p, inset = 0) {
    const { o, u, v } = frameOf(p);
    const at = (a, b) => o.clone().addScaledVector(u, a).addScaledVector(v, b);
    const [u0, u1, v0, v1] = [p.b[0] + inset, p.b[1] - inset, p.b[2] + inset, p.b[3] - inset];
    return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  }

  // The bounds' four grips: the middle of each side, with the way it moves.
  grips(p) {
    const { o, u, v } = frameOf(p);
    const [u0, u1, v0, v1] = p.b, um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    const at = (a, b) => o.clone().addScaledVector(u, a).addScaledVector(v, b);
    return [
      { at: at(u0, vm), dir: u.clone().negate(), k: 0 },
      { at: at(u1, vm), dir: u.clone(), k: 1 },
      { at: at(um, v0), dir: v.clone().negate(), k: 2 },
      { at: at(um, v1), dir: v.clone(), k: 3 },
    ];
  }

  draw() {
    for (const o of [...this.layer.children]) {
      if (o === this.gumball) continue;
      o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); });
      this.layer.remove(o);
    }
    for (const p of this.planes) {
      const on = p === this.selected, color = p.kind === 'plan' ? SUN : GLASS;
      const c = this.corners(p);
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), on
        ? new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
        : new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.3, depthTest: false, transparent: true, opacity: 0.85 }));
      line.computeLineDistances();
      line.renderOrder = 10;
      const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: on ? 0.07 : 0.035, side: THREE.DoubleSide, depthWrite: false }));
      fill.renderOrder = 9;
      this.layer.add(line, fill);
      if (on) for (const g of this.grips(p)) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: gripTexture(), depthTest: false, transparent: true }));
        s.position.copy(g.at);
        s.renderOrder = 12;
        s.userData.grip = g;
        this.layer.add(s);
      }
    }
    this.gumball.visible = !!this.selected;
    if (this.selected) {
      this.gumball.position.copy(this.selected.o);
      this.gumball.userData.arc.rotation.z = this.selected.yaw;
    }
  }

  // Arrows along x, y and z and an arc about z, sized to a unit; scaled to GUMBALL_PX each frame.
  makeGumball() {
    const g = new THREE.Group();
    g.userData.noSection = true;
    const mat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    const hits = [];
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((d, i) => {
      const dir = new THREE.Vector3(...d);
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.78, 8), mat(AXIS_COLORS[i]));
      shaft.position.y = 0.47;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 16), mat(AXIS_COLORS[i]));
      tip.position.y = 0.89;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.95, 6), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.52;
      hit.userData.handle = { type: 'move', axis: dir };
      hits.push(hit);
      arrow.add(shaft, tip, hit);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.add(arrow);
    });
    // The turning arc, in the horizontal plane, between 18 and 72 degrees from the plane's u axis.
    const arc = new THREE.Group();
    const curve = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.016, 6, 40, THREE.MathUtils.degToRad(54)), mat(GLASS));
    curve.rotation.z = THREE.MathUtils.degToRad(18);
    const hit = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.09, 6, 24, THREE.MathUtils.degToRad(54)), new THREE.MeshBasicMaterial({ visible: false }));
    hit.rotation.z = THREE.MathUtils.degToRad(18);
    hit.userData.handle = { type: 'turn' };
    hits.push(hit);
    for (const a of [18, 72]) {
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 12), mat(GLASS));
      const r = THREE.MathUtils.degToRad(a);
      head.position.set(0.62 * Math.cos(r), 0.62 * Math.sin(r), 0);
      head.rotation.z = r + (a === 18 ? Math.PI : 0); // along the arc, outwards at each end
      arc.add(head);
    }
    arc.add(curve, hit);
    g.add(arc);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), mat('#4B5855'));
    g.add(knob);
    g.userData.arc = arc;
    g.userData.hits = hits;
    g.traverse((o) => { o.renderOrder = 20; });
    g.visible = false;
    return g;
  }

  // Metres per screen pixel at a point.
  scaleAt(point) {
    const v = this.view, c = v.camera, h = Math.max(1, v.container.clientHeight);
    if (c.isOrthographicCamera) return (c.top - c.bottom) / c.zoom / h;
    const d = point.clone().sub(c.position).dot(c.getWorldDirection(new THREE.Vector3()));
    return (2 * Math.max(0.01, d) * Math.tan(THREE.MathUtils.degToRad(c.fov / 2))) / h;
  }

  // Before each render: handles keep their size on screen.
  beforeRender() {
    this.patchScene();
    if (!this.planes.length && !this.ghost) return;
    if (this.gumball.visible) this.gumball.scale.setScalar(this.scaleAt(this.gumball.position) * GUMBALL_PX);
    for (const o of this.layer.children) if (o.isSprite) o.scale.setScalar(this.scaleAt(o.position) * GRIP_PX * 2);
  }

  // ---------- the mouse ----------

  screen(point) {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const p = point.clone().project(this.view.camera);
    return new THREE.Vector2((p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height);
  }

  // What is under the pointer: a gumball handle, a grip or a plane's outline.
  handleAt(e) {
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    if (this.selected && this.gumball.visible) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((m.x / r.width) * 2 - 1, -(m.y / r.height) * 2 + 1), v.camera);
      this.gumball.updateMatrixWorld(true);
      const hit = ray.intersectObjects(this.gumball.userData.hits, false)[0];
      if (hit) return { ...hit.object.userData.handle, plane: this.selected };
      for (const g of this.grips(this.selected)) if (this.screen(g.at).distanceTo(m) < GRIP_HIT) return { type: 'grip', grip: g, plane: this.selected };
    }
    // Outlines: the nearest within a few pixels.
    let best = null;
    for (const p of this.planes) {
      const c = this.corners(p).map((x) => this.screen(x));
      for (let i = 0; i < 4; i++) {
        const d = segmentDistance(m, c[i], c[(i + 1) % 4]);
        if (d < PICK_PX && (!best || d < best.d)) best = { type: 'slide', plane: p, d };
      }
    }
    return best;
  }

  // Pixels of screen per metre along a direction from a point, and that direction on screen.
  screenAxis(from, dir) {
    const a = this.screen(from), b = this.screen(from.clone().addScaledVector(dir, 1));
    return b.sub(a);
  }

  wire() {
    const el = this.view.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.placing) return;
      const h = this.handleAt(e);
      if (!h) return;
      e.stopImmediatePropagation();
      el.setPointerCapture(e.pointerId);
      const p = h.plane;
      if (p !== this.selected) this.select(p);
      drag = { h, p, x: e.clientX, y: e.clientY, o: p.o.clone(), yaw: p.yaw, b: [...p.b], moved: false };
      if (h.type === 'turn') drag.a0 = this.angleAt(e, p);
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!drag) { this.hover(e); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      const { h, p } = drag, delta = new THREE.Vector2(dx, dy);
      const along = (from, dir) => { const s = this.screenAxis(from, dir); return s.lengthSq() > 1e-6 ? delta.dot(s) / s.lengthSq() : 0; };
      if (h.type === 'move') {
        const t = Math.round(along(drag.o, h.axis) / SNAP) * SNAP;
        p.o.copy(drag.o).addScaledVector(h.axis, t);
      } else if (h.type === 'slide') {
        const n = frameOf(p).n;
        p.o.copy(drag.o).addScaledVector(n, along(drag.o, n));
      } else if (h.type === 'grip') {
        const t = Math.round(along(h.grip.at, h.grip.dir) / SNAP) * SNAP, k = h.grip.k;
        p.b[k] = drag.b[k] + (k % 2 ? t : -t);
        if (k < 2) p.b[k] = k ? Math.max(p.b[k], p.b[0] + 0.5) : Math.min(p.b[k], p.b[1] - 0.5);
        else p.b[k] = k === 3 ? Math.max(p.b[k], p.b[2] + 0.5) : Math.min(p.b[k], p.b[3] - 0.5);
      } else if (h.type === 'turn') {
        const a = this.angleAt(e, p);
        if (a !== null && drag.a0 !== null) {
          const step = e.shiftKey ? 15 : 1;
          let deg = Math.round(THREE.MathUtils.radToDeg(drag.yaw + a - drag.a0) / step) * step;
          const square = Math.round(deg / 90) * 90; // the world's axes pull within SQUARE_PULL
          if (Math.abs(deg - square) <= SQUARE_PULL) deg = square;
          p.yaw = THREE.MathUtils.degToRad(deg); // the bounds turn with it, about its origin
        }
      }
      this.changed();
    });
    const end = (e) => {
      if (!drag) return;
      el.releasePointerCapture?.(e.pointerId);
      const d = drag;
      drag = null;
      if (d.moved) return;
      const deg = THREE.MathUtils.radToDeg;
      if (d.h.type === 'move') this.ask(e, 'move mm', (x) => { d.p.o.addScaledVector(d.h.axis, x / 1000); });
      else if (d.h.type === 'slide') this.ask(e, 'move mm', (x) => { d.p.o.addScaledVector(frameOf(d.p).n, x / 1000); });
      else if (d.h.type === 'turn') this.ask(e, `angle °, now ${Math.round(deg(d.p.yaw))}`, (x) => { d.p.yaw = THREE.MathUtils.degToRad(x); }, true);
      else if (d.h.type === 'grip') {
        const k = d.h.grip.k, size = k < 2 ? d.p.b[1] - d.p.b[0] : d.p.b[3] - d.p.b[2];
        this.ask(e, `${k < 2 ? 'width' : 'height'} mm, now ${Math.round(size * 1000)}`, (x) => {
          if (!(x >= 500)) return;
          const grow = x / 1000 - size; // moves the side clicked, keeps the other
          if (k % 2) d.p.b[k] += grow; else d.p.b[k] -= grow;
        });
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.remove(this.selected); e.preventDefault(); }
      else if (e.key === 'Escape' && this.selected) this.select(null);
    });
  }

  // The pointer's angle about the plane's origin, in the horizontal plane through it.
  angleAt(e, p) {
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -p.o.z), new THREE.Vector3());
    return hit ? Math.atan2(hit.y - p.o.y, hit.x - p.o.x) : null;
  }

  hover(e) {
    const h = this.placing ? null : this.handleAt(e);
    const el = this.view.renderer.domElement;
    el.style.cursor = !h ? '' : h.type === 'turn' ? 'alias' : h.type === 'slide' ? 'move' : 'grab';
  }

  // A figure typed after a click on a handle, as in the Solar Shading Explorer: a move in mm on an
  // arrow or the outline, an angle on the arc, a size on a grip. apply(number) changes the plane;
  // zero is ignored unless zeroOk. Enter or leaving the box applies it, Esc cancels.
  ask(e, placeholder, apply, zeroOk = false) {
    const input = document.createElement('input');
    input.className = 'floatedit';
    input.placeholder = placeholder;
    const r = this.view.container.getBoundingClientRect();
    Object.assign(input.style, { left: `${e.clientX - r.left + 10}px`, top: `${e.clientY - r.top - 12}px` });
    this.view.container.appendChild(input);
    setTimeout(() => input.focus()); // after the click that opened it
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const text = input.value.trim(), x = Number(text.replace(',', '.'));
      input.remove();
      if (keep && text && Number.isFinite(x) && (x || zeroOk)) { apply(x); this.changed(); }
    };
    input.addEventListener('keydown', (k) => { if (k.key === 'Enter') finish(true); if (k.key === 'Escape') finish(false); k.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- placing a new plane: dragged in from the bar, or a click on the button then on the view ----------

  // What is under the pointer: { point, zone } on the building (zone: the model zone of the surface
  // hit), or else { point } on the ground; null off the view.
  pointAt(e) {
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const hit = ray.intersectObjects([v.front, v.back].filter(Boolean), false).find((h) => !this.removed(h.point));
    if (hit) {
      const item = hit.object.userData.items?.[hit.object.geometry.userData.owner?.[hit.faceIndex]];
      return { point: hit.point.clone(), zone: v.model?.zones[item?.zone], normal: hit.face?.normal.clone() };
    }
    const b = this.box();
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.min.z), new THREE.Vector3());
    return point ? { point } : null;
  }

  // Where a new plane goes for what is under the pointer, as [point, along]. On a wall: a section
  // through the pointer, square to the wall (so pointing at a building's short side gives a long
  // section), or a plan cut at the pointer's height. On a floor, a roof or the ground: a section facing
  // the camera, or a plan cut 1.5 m above the room's floor (the usual plan height).
  placeAt(kind, { point, zone, normal }) {
    const at = point.clone(), o = this.view.origin;
    const wall = normal && Math.hypot(normal.x, normal.y) > 0.7;
    if (kind === 'section') return [at, wall ? new THREE.Vector3(normal.x, normal.y, 0).normalize() : null];
    if (!wall) {
      let floor = point.z;
      if (zone) floor = Math.min(...zone.surfaces.flatMap((n) => this.view.model.surfaces[n].vertices.map((q) => q[2] - o[2])));
      at.z = floor + 1.5;
    }
    return [at, null];
  }

  // Starts placing: the ghost follows the pointer over the view until a click (or release, when
  // dragged in) puts the plane there. Esc cancels.
  startPlacing(kind, dragged) {
    this.stopPlacing();
    const el = this.view.renderer.domElement;
    this.placing = { kind };
    document.body.classList.add(dragged ? 'placedrag' : 'placing');
    const move = (e) => {
      const pt = this.pointAt(e);
      this.showGhost(pt ? this.make(kind, ...this.placeAt(kind, pt)) : null);
    };
    const put = (e) => {
      const pt = this.pointAt(e);
      this.stopPlacing();
      if (pt) this.add(kind, ...this.placeAt(kind, pt));
    };
    const down = (e) => { if (e.button === 0 && !dragged) { e.stopImmediatePropagation(); put(e); } };
    const up = (e) => { if (dragged) put(e); };
    const key = (e) => { if (e.key === 'Escape') this.stopPlacing(); };
    window.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    this.placing.off = () => {
      window.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
  }

  stopPlacing() {
    this.placing?.off?.();
    this.placing = null;
    document.body.classList.remove('placedrag', 'placing');
    this.showGhost(null);
  }

  showGhost(p) {
    if (this.ghost) { this.ghost.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); this.layer.remove(this.ghost); this.ghost = null; }
    if (p) {
      const c = this.corners(p), color = p.kind === 'plan' ? SUN : GLASS;
      const g = new THREE.Group();
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.3, depthTest: false, transparent: true }));
      line.computeLineDistances();
      const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      g.add(line, fill);
      g.traverse((o) => { o.renderOrder = 11; });
      this.ghost = g;
      this.layer.add(g);
    }
    this.view.render();
  }
}

function segmentDistance(p, a, b) {
  const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

// A grip: a square with the panel's fill and the editing colour's outline (9 px, as in the Solar
// Shading Explorer's sheets).
let gripTex = null;
function gripTexture() {
  if (gripTex) return gripTex;
  const c = document.createElement('canvas');
  c.width = c.height = 36;
  const g = c.getContext('2d');
  g.fillStyle = '#FDFDFC';
  g.fillRect(9, 9, 18, 18);
  g.strokeStyle = GLASS;
  g.lineWidth = 3;
  g.strokeRect(9, 9, 18, 18);
  gripTex = new THREE.CanvasTexture(c);
  return gripTex;
}
