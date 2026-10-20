// 3D view of an imported project model: zone surfaces, windows and shading, drawn from the
// corner points the importer stores. Coordinates are shifted so the building sits at the origin
// (models are often placed far from it, e.g. Example_01 near x = 1,550 m), which keeps the
// graphics card's single-precision numbers exact enough.
//
// Mouse: left click selects, right drag orbits, middle drag pans, wheel zooms.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { area, bounds, triangulate, unitNormal } from '../src/model/geometry.js';

// ClimateStudio's surface types, plus glazing and shading.
export const TYPE_COLORS = {
  Facade: '#D8C7A3',
  Roof: '#B9614F',
  Partition: '#C3CBC6',
  Slab: '#97A39D',
  'External Floor': '#7D8B9B',
  'Ground Slab': '#76654F',
  'Ground Wall': '#8E7C60',
  'Adiabatic Wall': '#B7A6CB',
  'Adiabatic Floor': '#A493BC',
  'Adiabatic Roof': '#9584AE',
  Unknown: '#E0559A',
  Glazing: '#5AA6E0',
  Shading: '#9AA3A8',
};
const INSIDE_SHADE = 0x9a9a9a; // inside faces (the side a surface does not face) are drawn this much darker
export const PROBLEM = '#D93025';
const SELECTED = '#F2A900';

export const zoneColor = (i) => new THREE.Color().setHSL(((i * 137.508) % 360) / 360, 0.38, 0.64);

// Triangles of a set of polygons as one geometry; owner[i] is the polygon of triangle i.
function polygonGeometry(polys, origin, colorOf, offset = 0) {
  const pos = [], col = [], owner = [];
  const c = new THREE.Color();
  polys.forEach((poly, k) => {
    const n = unitNormal(poly.vertices);
    const pts = poly.vertices.map((p) => [p[0] - origin[0] + n[0] * offset, p[1] - origin[1] + n[1] * offset, p[2] - origin[2] + n[2] * offset]);
    if (colorOf) c.set(colorOf(poly, k));
    for (const tri of triangulate(poly.vertices)) {
      for (const i of tri) { pos.push(...pts[i]); if (colorOf) col.push(c.r, c.g, c.b); }
      owner.push(k);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colorOf) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.userData.owner = owner;
  return g;
}

function edgeGeometry(polys, origin) {
  const pos = [];
  for (const { vertices: v } of polys) {
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      pos.push(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2], b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const centroid = (pts) => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);

export class View3D {
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // EnergyPlus: z up, y north
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 2.2));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-0.5, -1, 1.4); // from the south-west, above
    this.scene.add(this.sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.render());
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    this.cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), Infinity);
    this.clipping = [this.cutPlane];
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.highlight = null;
    this.colorBy = 'type';

    // A click is a left press and release without moving; a drag pans or orbits instead.
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 0) down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 5) this.pickAt(e);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.applyTheme();
  }

  applyTheme() {
    const css = getComputedStyle(this.container);
    this.scene.background = new THREE.Color(css.getPropertyValue('--panel').trim() || '#F3F5F4');
    this.edgeColor = css.getPropertyValue('--ink').trim() || '#1D2124';
    if (this.edges) this.edges.material.color.set(this.edgeColor);
    this.render();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  clear() {
    for (const obj of [...this.group.children]) {
      obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.group.remove(obj);
    }
    this.highlight = null;
  }

  setModel(model) {
    this.clear();
    this.model = model;
    this.surfaces = Object.values(model.surfaces);
    this.windows = Object.values(model.windows);
    this.zoneIndex = Object.fromEntries(Object.keys(model.zones).map((z, i) => [z, i]));
    // Centre on the zones, not the shading, which can reach hundreds of metres into the site.
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    this.origin = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
    this.zRange = [b.min[2], b.max[2]];

    // Surfaces, drawn in their colour on the side they face (out of the zone) and darker behind.
    // Paired interzone surfaces sit on top of each other facing opposite ways, so each side shows one.
    const geo = polygonGeometry(this.surfaces, this.origin, (s) => this.surfaceColor(s));
    const front = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, clippingPlanes: this.clipping });
    const back = new THREE.MeshLambertMaterial({ vertexColors: true, color: INSIDE_SHADE, side: THREE.BackSide, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.front = new THREE.Mesh(geo, front);
    this.back = new THREE.Mesh(geo, back);
    this.front.userData = this.back.userData = { kind: 'surface', items: this.surfaces };

    const glass = new THREE.MeshLambertMaterial({ color: TYPE_COLORS.Glazing, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.clipping });
    this.glass = new THREE.Mesh(polygonGeometry(this.windows, this.origin, null, 0.02), glass);
    this.glass.userData = { kind: 'window', items: this.windows };

    const shadeMat = new THREE.MeshLambertMaterial({ color: TYPE_COLORS.Shading, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.clipping });
    this.shading = new THREE.Mesh(polygonGeometry(model.shading, this.origin, null), shadeMat);
    this.shading.userData = { kind: 'shading', items: model.shading };
    this.shading.renderOrder = 1;

    this.edges = new THREE.LineSegments(edgeGeometry([...this.surfaces, ...this.windows], this.origin),
      new THREE.LineBasicMaterial({ color: this.edgeColor, transparent: true, opacity: 0.45, clippingPlanes: this.clipping }));

    this.group.add(this.front, this.back, this.glass, this.shading, this.edges, this.problemLayer());
    this.setCut(null);
    this.frame();
  }

  surfaceColor(s) {
    return this.colorBy === 'zone' ? zoneColor(this.zoneIndex[s.zone] ?? 0) : TYPE_COLORS[s.csType] || TYPE_COLORS.Unknown;
  }

  // Surfaces named by a model check: red on both sides, with an arrow the way EnergyPlus takes as outward.
  problemLayer() {
    const layer = new THREE.Group();
    const flagged = new Set(this.model.checks.flatMap((c) => c.objects).filter((n) => this.model.surfaces[n]));
    this.problems = [...flagged].map((n) => this.model.surfaces[n]);
    if (!this.problems.length) return layer;
    const mat = new THREE.MeshBasicMaterial({ color: PROBLEM, side: THREE.DoubleSide, transparent: true, opacity: 0.75, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    layer.add(new THREE.Mesh(polygonGeometry(this.problems, this.origin, null), mat));
    for (const s of this.problems) {
      // At the centre of a floor or roof; on a wall, 1 m above its base so a plan cut at 1.5 m keeps it.
      const c = centroid(s.vertices);
      if (s.tilt > 30 && s.tilt < 150) c[2] = Math.min(c[2], bounds(s.vertices).min[2] + 1);
      const len = Math.min(3, Math.max(0.8, Math.sqrt(area(s.vertices)) * 0.5));
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...unitNormal(s.vertices)),
        new THREE.Vector3(c[0] - this.origin[0], c[1] - this.origin[1], c[2] - this.origin[2]), len, PROBLEM, len * 0.3, len * 0.18);
      arrow.traverse((o) => { if (o.material) o.material.clippingPlanes = this.clipping; });
      layer.add(arrow);
    }
    return layer;
  }

  setColorBy(mode) {
    this.colorBy = mode;
    if (!this.front) return;
    const g = this.front.geometry, owner = g.userData.owner, col = g.getAttribute('color');
    const c = new THREE.Color();
    owner.forEach((k, t) => {
      c.set(this.surfaceColor(this.surfaces[k]));
      for (let j = 0; j < 3; j++) col.setXYZ(t * 3 + j, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
    this.render();
  }

  // Hides everything above a height in model coordinates (metres); null shows the whole building.
  setCut(z) {
    this.cutPlane.constant = z === null ? Infinity : z - this.origin[2];
    this.render();
  }

  setShadingVisible(on) { if (this.shading) { this.shading.visible = on; this.render(); } }

  find(name) {
    const m = this.model;
    if (m.surfaces[name]) return { kind: 'surface', item: m.surfaces[name], polys: [m.surfaces[name]] };
    if (m.windows[name]) return { kind: 'window', item: m.windows[name], polys: [m.windows[name]] };
    if (m.zones[name]) return { kind: 'zone', item: m.zones[name], polys: m.zones[name].surfaces.map((n) => m.surfaces[n]) };
    return null;
  }

  // Outlines and tints the named surface, window or zone; null clears the selection.
  select(name, { frame = false } = {}) {
    if (this.highlight) {
      this.highlight.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this.group.remove(this.highlight);
      this.highlight = null;
    }
    const found = name ? this.find(name) : null;
    if (found) {
      const h = new THREE.Group();
      h.add(new THREE.Mesh(polygonGeometry(found.polys, this.origin, null, found.kind === 'window' ? 0.03 : 0),
        new THREE.MeshBasicMaterial({ color: SELECTED, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })));
      h.add(new THREE.LineSegments(edgeGeometry(found.polys, this.origin), new THREE.LineBasicMaterial({ color: SELECTED, clippingPlanes: this.clipping })));
      h.renderOrder = 2;
      this.highlight = h;
      this.group.add(h);
      if (frame) this.frame(found.polys);
    }
    this.onSelect(found);
    this.render();
  }

  pickAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets = [this.front, this.back, this.glass, ...(this.shading.visible ? [this.shading] : [])];
    // Shading is drawn see-through, so the building behind it wins; shading is picked only on its own.
    const hits = ray.intersectObjects(targets, false).filter((h) => this.cutPlane.distanceToPoint(h.point) >= 0);
    const hit = hits.find((h) => h.object !== this.shading) || hits[0];
    if (!hit) return this.select(null);
    const { kind, items } = hit.object.userData;
    const item = items[hit.object.geometry.userData.owner[hit.faceIndex]];
    if (kind === 'shading') { this.select(null); return this.onSelect({ kind, item, polys: [item] }); }
    this.select(item.name);
  }

  // Shows a surface, window or zone in context: a plan cut 1.5 m above its lowest point (the usual
  // plan-drawing height), looking down at its zone from the south-west. Returns the cut height, or null.
  focus(name) {
    const found = this.find(name);
    if (!found) return null;
    const zone = this.model.zones[found.kind === 'zone' ? name : found.item.zone];
    const cut = bounds(found.polys.flatMap((p) => p.vertices)).min[2] + 1.5;
    const z = cut >= this.zRange[1] ? null : cut;
    this.setCut(z);
    this.select(name);
    this.frame(zone ? zone.surfaces.map((n) => this.model.surfaces[n]) : found.polys, new THREE.Vector3(-0.45, -0.8, 1.4));
    return z;
  }

  // Points the camera at a set of polygons (the whole building by default), from the south-west.
  frame(polys = this.surfaces, from = new THREE.Vector3(-0.55, -1, 0.75)) {
    const b = bounds(polys.flatMap((p) => p.vertices));
    const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2 - this.origin[i]));
    const radius = Math.max(1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const dir = from.clone().normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.05, dist / 2000);
    this.camera.far = dist * 20 + 2000;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.render();
  }
}
