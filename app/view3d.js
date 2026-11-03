// 3D view of an imported project model: zone surfaces, windows and shading, drawn from the
// corner points the importer stores. Coordinates are shifted so the building sits at the origin
// (models are often placed far from it, e.g. Example_01 near x = 1,550 m), which keeps the
// graphics card's single-precision numbers exact enough.
//
// Mouse: left click selects, right drag orbits, middle drag pans, wheel zooms. The view orbits about
// the selection, or about the middle of the building's ground plane when nothing is selected. The
// camera can be perspective or parallel, and a view cube in the corner turns it to look from any side.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { area, bounds, triangulate, unitNormal } from '../src/model/geometry.js';
import { surfaceTriangles, envelopeSolids, faceOffsets } from './solids.js';
import { ViewCube } from './viewcube.js';
import { Sections } from './sections.js';
import { SectionCaps } from './caps.js';

// ClimateStudio's surface types, plus glazing and shading.
// The plain white drawing (Colour by: White), in the Solar Shading Explorer's colours.
const WHITE = { wall: '#E9EEEB', shade: '#DCE2DF', top: '#F6F8F7', floor: '#E6EAE8', edge: '#18211F', glass: '#C4D0D2' };

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
  Door: '#9A5B34',
  Shading: '#9AA3A8',
};
const INSIDE_SHADE = 0x9a9a9a; // inside faces (the side a surface does not face) are drawn this much darker
export const OPEN_WINDOW = '#1FA88E'; // an open window, in the airflow
export const PROBLEM = '#D93025';
const SELECTED = '#2F6F68'; // --glass: selection and editing, as in the shading tool's drawings

// CO2 (ppm): green at outdoor levels, amber at 1000 ppm where rooms start to feel stuffy, red from 1500.
export const CO2_SCALE = [400, 1000, 1500];
const CO2_STOPS = ['#3E8E5E', '#E0A526', '#C4372D'].map((c) => new THREE.Color(c));
export function co2Color(ppm, out = new THREE.Color()) {
  const [lo, mid, hi] = CO2_SCALE;
  const x = Math.min(Math.max(ppm, lo), hi);
  return x <= mid ? out.lerpColors(CO2_STOPS[0], CO2_STOPS[1], (x - lo) / (mid - lo))
    : out.lerpColors(CO2_STOPS[1], CO2_STOPS[2], (x - mid) / (hi - mid));
}
// People per m2 this hour: pale for an empty room, through to deep violet at the scale's top.
const EMPTY = new THREE.Color('#ECEAF2'), FULL = new THREE.Color('#5B3A8E');
export function peopleColor(density, top, out = new THREE.Color()) {
  return density <= 0 ? out.copy(EMPTY) : out.copy(EMPTY).lerp(FULL, 0.15 + 0.85 * Math.min(1, density / Math.max(1e-9, top)));
}
export const zoneColor = (i) => new THREE.Color().setHSL(((i * 137.508) % 360) / 360, 0.38, 0.64);

// Pressure difference across a surface (Pa, inside minus outside at its height): blue where air is
// pushed into the room, through pale grey, to red where it is pushed out. range: the scale's end (Pa).
// Square-root scale, so a few pascals across a facade still show beside tens across a roof in wind.
const PUSHED_IN = new THREE.Color('#2F6DB5'), EVEN = new THREE.Color('#E4E7EA'), PUSHED_OUT = new THREE.Color('#C8402A');
export const NO_PRESSURE = '#8E979D';
export function pressureColor(dp, range, out = new THREE.Color()) {
  const x = Math.sign(dp) * Math.sqrt(Math.min(1, Math.abs(dp) / range));
  return x < 0 ? out.copy(EVEN).lerp(PUSHED_IN, -x) : out.copy(EVEN).lerp(PUSHED_OUT, x);
}

// Triangles of a set of polygons as one geometry; owner[i] is the polygon of triangle i.
function polygonGeometry(polys, origin, colorOf, offset = 0) {
  const pos = [], col = [], owner = [];
  const c = new THREE.Color();
  polys.forEach((poly, k) => {
    const n = unitNormal(poly.vertices), off = typeof offset === 'function' ? offset(poly) : offset;
    const pts = poly.vertices.map((p) => [p[0] - origin[0] + n[0] * off, p[1] - origin[1] + n[1] * off, p[2] - origin[2] + n[2] * off]);
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

// The sash of a window swung open: the rough opening's rectangle turned about its hinge edge by the
// angle, outwards for casements and awnings, inwards for hoppers. null for windows that are not
// upright rectangles (skylights), which stay drawn in place.
function sashPanel(w, sash, depth = 0) {
  if (!w || !sash) return null;
  const n = unitNormal(w.vertices);
  if (Math.abs(n[2]) > 0.05) return null;
  const h = Math.hypot(n[0], n[1]), out = [n[0] / h, n[1] / h, 0];
  const right = [-out[1], out[0], 0]; // to the right, seen from outside
  const along = w.vertices.map((p) => p[0] * right[0] + p[1] * right[1]);
  const s0 = Math.min(...along), s1 = Math.max(...along);
  const z0 = Math.min(...w.vertices.map((p) => p[2])), z1 = Math.max(...w.vertices.map((p) => p[2]));
  const plane = w.vertices[0][0] * out[0] + w.vertices[0][1] * out[1] + depth;
  const at = (s, z, o = 0) => [right[0] * s + out[0] * (plane + o), right[1] * s + out[1] * (plane + o), z];
  const a = (sash.angle * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const W = s1 - s0, H = z1 - z0;
  if (sash.type === 'casement') {
    const [hs, dir] = sash.hinge === 'right' ? [s1, -1] : [s0, 1];
    return [at(hs, z0), at(hs + dir * W * c, z0, W * sn), at(hs + dir * W * c, z1, W * sn), at(hs, z1)];
  }
  if (sash.type === 'awning') return [at(s0, z1), at(s1, z1), at(s1, z1 - H * c, H * sn), at(s0, z1 - H * c, H * sn)];
  if (sash.type === 'hopper') return [at(s0, z0), at(s1, z0), at(s1, z0 + H * c, -H * sn), at(s0, z0 + H * c, -H * sn)];
  return null;
}

export class View3D {
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.perspective = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.parallel = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    for (const c of [this.perspective, this.parallel]) c.up.set(0, 0, 1); // EnergyPlus: z up, y north
    this.camera = this.perspective;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 2.2));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-0.5, -1, 1.4); // from the south-west, above
    this.scene.add(this.sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null }; // orbiting is this view's own (orbit())
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.render());
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    // A middle click would also start the browser's autoscroll, fighting the pan.
    this.renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    this.renderer.domElement.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    // Cuts are section planes (sections.js), which patch every material; no three.js clipping planes.
    this.clipping = [];
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.highlight = null;
    this.colorBy = 'type';

    this.orbit();
    // A click is a left press and release without moving; a drag pans or orbits instead.
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 0) down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 5) this.pickAt(e);
    });

    this.cube = new ViewCube(this, (dir) => this.lookFrom(dir));
    this.sections = new Sections(this);
    this.caps = new SectionCaps(this);
    new ResizeObserver(() => this.resize()).observe(container);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.applyTheme();
  }

  // Right drag turns the camera about the pivot: the selection's middle, or the middle of the
  // building on the ground. Unlike OrbitControls, the pivot need not be at the middle of the screen,
  // so the view does not jump when the selection changes: the camera and its target turn together.
  orbit() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      drag = { x: e.clientX, y: e.clientY, pivot: this.pivot() };
      try { el.setPointerCapture(e.pointerId); } catch { /* a pointerdown passed on from a tag */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = this.camera, P = drag.pivot, k = 0.008;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * k);
      // Pitch about the camera's right, kept short of straight up or down.
      const fwd = c.getWorldDirection(new THREE.Vector3()), right = new THREE.Vector3().crossVectors(fwd, c.up).normalize();
      const now = Math.acos(THREE.MathUtils.clamp(fwd.z, -1, 1)), to = THREE.MathUtils.clamp(now + dy * k, 0.02, Math.PI - 0.02);
      const pitch = new THREE.Quaternion().setFromAxisAngle(right, now - to);
      const q = yaw.multiply(pitch);
      const turn = (v) => v.sub(P).applyQuaternion(q).add(P);
      turn(c.position);
      turn(this.controls.target);
      c.quaternion.premultiply(q);
      this.controls.update();
      this.render();
    });
    const end = (e) => { if (drag) { drag = null; try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ } } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // What the view orbits about (view coordinates): the selected thing's middle, a section plane
  // being moved, or the middle of the building's ground plane (the origin).
  pivot() {
    if (this.sections?.selected) return this.sections.centre(this.sections.selected);
    if (this.selectedPolys?.length) {
      const b = bounds(this.selectedPolys.flatMap((p) => p.vertices));
      return new THREE.Vector3(...[0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2 - this.origin[i]));
    }
    return new THREE.Vector3(0, 0, 0);
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
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.fitParallel(this.parallel.top);
    this.caps?.resize();
    this.render();
  }

  // Draws the scene at the next frame: many changes in one event (or one frame) draw it once.
  render() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.sections?.beforeRender();
      this.beforeRender?.();
      this.renderer.render(this.scene, this.camera);
      this.cube?.render();
      this.onRender?.();
    });
  }

  // The parallel camera's frustum for a half height (m, before its zoom), at the view's proportions.
  fitParallel(half) {
    const c = this.parallel, r = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    Object.assign(c, { top: half, bottom: -half, left: -half * r, right: half * r });
    c.updateProjectionMatrix();
  }

  // Perspective or parallel. The new camera shows the same extent at the target as the old one.
  setProjection(mode) {
    const to = mode === 'parallel' ? this.parallel : this.perspective;
    if (to === this.camera) return;
    const from = this.camera, target = this.controls.target, tan = Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    const dir = from.position.clone().sub(target);
    if (to === this.parallel) {
      this.fitParallel(dir.length() * tan);
      to.zoom = 1;
      to.position.copy(from.position);
    } else {
      const dist = this.parallel.top / this.parallel.zoom / tan;
      to.position.copy(target).addScaledVector(dir.normalize(), dist);
      to.near = Math.max(0.05, dist / 2000);
      to.far = dist * 20 + 2000;
    }
    to.quaternion.copy(from.quaternion);
    to.updateProjectionMatrix();
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.render();
  }

  // Turns the camera to look at the target from a direction (unit vector, model axes), keeping its
  // distance, over a third of a second. Straight down or up is nudged so north stays at the top.
  lookFrom(dir) {
    const d = dir.clone();
    if (Math.abs(d.z) > 0.999) d.set(0, -1e-3 * Math.sign(d.z), Math.sign(d.z)).normalize();
    const target = this.controls.target, start = this.camera.position.clone().sub(target);
    const dist = start.length(), a = start.clone().normalize(), t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 330), e = k * k * (3 - 2 * k);
      const q = new THREE.Quaternion().setFromUnitVectors(a, d);
      const v = a.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
      this.camera.position.copy(target).addScaledVector(v, dist);
      this.camera.lookAt(target);
      this.controls.update();
      this.render();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  clear() {
    for (const obj of [...this.group.children]) {
      obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.group.remove(obj);
    }
    this.highlight = null;
  }

  // doors: openings the tool adds (interior-doors.js), drawn on both sides of their wall. keep: the
  // same building edited, so the camera and the section planes stay as they are.
  setModel(model, { doors = [], walls = this.walls || 'thin', keep = false } = {}) {
    this.clear();
    this.model = model;
    this.doors = doors;
    this.walls = walls;
    this.swung = null;
    this.sashMesh = null;
    this.openingPick = null;
    this.surfaces = Object.values(model.surfaces);
    this.windows = Object.values(model.windows);
    this.zoneIndex = Object.fromEntries(Object.keys(model.zones).map((z, i) => [z, i]));
    // Centre on the zones, not the shading, which can reach hundreds of metres into the site.
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    this.origin = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
    this.zRange = [b.min[2], b.max[2]];

    // Surfaces, drawn in their colour on the side they face (out of the zone) and darker behind.
    // Paired interzone surfaces sit on top of each other facing opposite ways, so each side shows one.
    const geo = this.surfaceGeometry();
    const front = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, clippingPlanes: this.clipping });
    const back = new THREE.MeshLambertMaterial({ vertexColors: true, color: INSIDE_SHADE, side: THREE.BackSide, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.front = new THREE.Mesh(geo, front);
    this.back = new THREE.Mesh(geo, back);
    this.front.userData = this.back.userData = { kind: 'surface', items: this.surfaces };

    const glass = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.clipping });
    this.glass = new THREE.Mesh(polygonGeometry(this.windows, this.origin, () => TYPE_COLORS.Glazing, (w) => this.windowOffset(w)), glass);
    this.glass.userData = { kind: 'window', items: this.windows };

    const shadeMat = new THREE.MeshLambertMaterial({ color: TYPE_COLORS.Shading, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.clipping });
    this.shading = new THREE.Mesh(polygonGeometry(model.shading, this.origin, null), shadeMat);
    this.shading.userData = { kind: 'shading', items: model.shading };
    this.shading.renderOrder = 1;

    const doorMat = new THREE.MeshLambertMaterial({ color: TYPE_COLORS.Door, side: THREE.DoubleSide, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.doorMesh = new THREE.Mesh(polygonGeometry(doors, this.origin, null), doorMat);
    this.doorMesh.userData = { kind: 'door', items: doors };

    this.edges = new THREE.LineSegments(this.edgesGeometry(), new THREE.LineBasicMaterial({ color: this.edgeColor, transparent: true, opacity: 0.45, clippingPlanes: this.clipping }));

    this.group.add(this.front, this.back, this.glass, this.doorMesh, this.shading, this.edges, this.problemLayer());
    if (keep) {
      if (this.sections.planes.length) this.caps.update();
      this.render();
      return;
    }
    this.sections.clear();
    this.frame();
  }

  // Surfaces with their windows and doors cut out: thin, as modelled, or as solids of their
  // construction's thickness about the location line (this.walls: 'thin', 'interior', 'centre' or
  // 'exterior'). owner[i] is the index in this.surfaces of triangle i, for picking and colouring.
  surfaceGeometry() {
    const thick = this.walls && this.walls !== 'thin';
    const holes = new Map();
    const hole = (surface, pts) => holes.set(surface, [...(holes.get(surface) || []), pts]);
    for (const w of this.windows) hole(w.parent, w.vertices);
    for (const d of this.doors) { hole(d.surface, d.vertices); hole(d.partnerSurface, d.partnerVertices); }
    const thicknessOf = (s) => this.model.constructions[s.construction]?.thickness || 0.2;
    // Floors take their thickness below their level, whatever the location line: a floor facing down
    // grows outwards from its zone, a ceiling (the other side of a floor) into its zone. So a slab
    // between storeys, an exposed floor and a ground floor all hang from the floor level and meet.
    const lineOf = (s) => {
      const nz = unitNormal(s.vertices)[2];
      if (Math.abs(nz) > 0.9 && (nz < 0 || s.boundary === 'Surface')) return nz < 0 ? 'interior' : 'exterior';
      return s.boundary === 'Surface' ? 'centre' : this.walls;
    };
    // The envelope's solids are built together so their corners meet; shared surfaces are centred.
    const envelope = thick ? this.surfaces.map((s, k) => [s, k]).filter(([s]) => s.boundary !== 'Surface') : [];
    let solids = [];
    try {
      solids = envelopeSolids(envelope.map(([s]) => ({ vertices: s.vertices, holes: holes.get(s.name) || [], thickness: thicknessOf(s), zone: s.zone, line: lineOf(s) })), this.origin, this.walls);
    } catch { solids = envelope.map(() => []); }
    const solidOf = new Map(envelope.map(([, k], i) => [k, solids[i]]));
    const pos = [], col = [], owner = [], c = new THREE.Color();
    this.solids = []; // each thick surface's closed solid (triangles, view coordinates), for the cut caps
    this.solidOf = new Map(); // surface name -> its solid (both of a shared pair), for selection and hover
    this.surfaces.forEach((s, k) => {
      const shared = s.boundary === 'Surface' && s.adjacentSurface;
      if (thick && shared && s.name > s.adjacentSurface) return; // drawn once for the pair
      let tris = solidOf.get(k);
      if (!tris?.length) {
        const t = thick ? thicknessOf(s) : 0;
        try { tris = surfaceTriangles(s.vertices, holes.get(s.name) || [], this.origin, t, lineOf(s)); } catch { tris = []; }
      }
      if (thick && tris.length) {
        this.solids.push(tris);
        this.solidOf.set(s.name, tris);
        if (shared) this.solidOf.set(s.adjacentSurface, tris);
      }
      if (!tris.length) { // an outline the cutter cannot handle: drawn as before, without holes
        tris = [];
        for (const tri of triangulate(s.vertices)) for (const i of tri) tris.push(...s.vertices[i].map((x, j) => x - this.origin[j]));
      }
      c.set(this.surfaceColor(s));
      for (let i = 0; i < tris.length; i += 3) { pos.push(tris[i], tris[i + 1], tris[i + 2]); col.push(c.r, c.g, c.b); }
      for (let i = 0; i < tris.length / 9; i++) owner.push(k);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.userData.owner = owner;
    return g;
  }

  // Outlines: of the modelled polygons when thin, of the solids' edges when thick.
  edgesGeometry() {
    if (this.walls && this.walls !== 'thin') return new THREE.EdgesGeometry(this.front.geometry, 25);
    return edgeGeometry([...this.surfaces, ...this.windows, ...this.doors], this.origin);
  }

  // Draws the closed doors as panels; open ones leave their opening clear. open: a Set of door names.
  setOpenDoors(open) {
    if (!this.doorMesh) return;
    const closed = this.doors.filter((d) => !open.has(d.name));
    this.doorMesh.geometry.dispose();
    this.doorMesh.geometry = polygonGeometry(closed, this.origin, null);
    this.doorMesh.userData.items = closed;
    this.render();
  }

  // How far a window's glazing sits from its modelled plane (along the wall's outward normal): at the
  // drawn wall's exterior face, centre or interior face (this.windowDepth). Thin walls: in the plane.
  windowOffset(w) {
    const wall = this.model.surfaces[w.parent];
    if (!this.walls || this.walls === 'thin' || !wall) return 0.02;
    const t = this.model.constructions[wall.construction]?.thickness || 0.2;
    const [a, b] = faceOffsets(t, wall.boundary === 'Surface' ? 'centre' : this.walls);
    const depth = this.windowDepth || 'centre';
    return depth === 'exterior' ? b - 0.02 : depth === 'interior' ? a + 0.02 : (a + b) / 2;
  }

  // Places windows at the exterior face, centre or interior face of thick walls (drawing only).
  setWindowDepth(depth) {
    this.windowDepth = depth;
    this.redrawWindows();
  }

  redrawWindows() {
    if (!this.glass) return;
    const [open, sashes] = this.lastWindows || [new Set(), new Map()];
    this.setOpenWindows(open, sashes, true);
  }

  // Draws surfaces thin or with thickness: 'thin', 'interior', 'centre' or 'exterior' (the location line).
  setWalls(mode) {
    this.walls = mode;
    if (!this.front) return;
    const old = this.front.geometry;
    const g = this.surfaceGeometry();
    this.front.geometry = g;
    this.back.geometry = g;
    old.dispose();
    this.edges.geometry.dispose();
    this.edges.geometry = this.edgesGeometry();
    this.redrawWindows();
    this.caps.update();
  }

  surfaceColor(s) {
    if (this.colorBy === 'pressure') {
      const dp = this.pressures?.values[s.name];
      return dp === undefined ? NO_PRESSURE : pressureColor(dp, this.pressures.range);
    }
    if (this.colorBy === 'co2') {
      const c = this.co2?.[s.zone];
      return c === undefined ? NO_PRESSURE : co2Color(c);
    }
    if (this.colorBy === 'people') {
      const p = this.people?.values[s.zone];
      return p === undefined ? NO_PRESSURE : peopleColor(p, this.people.top);
    }
    if (this.colorBy === 'white') {
      // drawn without light, as the shading tool's axon: tops palest, walls toned by the way they face
      const n = unitNormal(s.vertices);
      if (Math.abs(n[2]) > 0.9) return n[2] > 0 ? WHITE.top : WHITE.floor;
      const h = Math.hypot(n[0], n[1]) || 1, t = 0.5 + 0.5 * ((n[0] * -0.6 + n[1] * -0.8) / h);
      return new THREE.Color(WHITE.shade).lerp(new THREE.Color(WHITE.wall), t);
    }
    return this.colorBy === 'zone' ? zoneColor(this.zoneIndex[s.zone] ?? 0) : TYPE_COLORS[s.csType] || TYPE_COLORS.Unknown;
  }

  // Pressure differences by surface name (Pa) and the colour scale's end, for colouring by pressure.
  setPressures(values, range) {
    this.pressures = { values, range };
    if (this.colorBy === 'pressure') this.setColorBy('pressure');
  }

  // People per m2 in each zone this hour (by zone name) and the scale's top, for colouring by occupancy.
  setPeople(values, top) {
    this.people = { values, top };
    if (this.colorBy === 'people') this.setColorBy('people');
  }

  // CO2 by zone name (ppm), for colouring by CO2.
  setCO2(values) {
    this.co2 = values;
    if (this.colorBy === 'co2') this.setColorBy('co2');
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
    // White: the Solar Shading Explorer's drawing, light fills under ink edges and pale glass.
    const white = mode === 'white';
    this.edges.material.color.set(white ? WHITE.edge : this.edgeColor);
    this.edges.material.opacity = white ? 0.8 : 0.45;
    // its fills flat, unlit
    this.flatFront ||= new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide, clippingPlanes: this.clipping });
    if (white !== (this.front.material === this.flatFront)) [this.front.material, this.litFront] = white ? [this.flatFront, this.front.material] : [this.litFront, this.front.material];
    this.redrawWindows();
    this.render();
  }

  // Hides everything above a height in model coordinates (metres); null shows the whole building.
  // Shows which windows are open (by name) in their own colour; null shows all as plain glazing.
  // Shows which windows are open, and how: open is a Set of window names, sashes a Map from window
  // name to { type: 'casement' | 'awning' | 'hopper', hinge: 'left' | 'right', angle (degrees) }.
  // An open window with a sash is drawn as its sash swung to that angle on its hinge, in the open
  // colour, with the rough opening left as an outline; other open windows are tinted in place.
  // rebuild: redraw the in-place glazing even if no sash changed (after the walls or window depth change).
  setOpenWindows(open, sashes = new Map(), rebuild = false) {
    if (!this.glass) return;
    this.lastWindows = [open, sashes];
    const swung = new Set([...(open || [])].filter((n) => sashes.get(n)?.angle > 0 && sashPanel(this.model.windows[n], sashes.get(n))));
    const c = new THREE.Color();
    // Swung windows leave the in-place glazing, which is rebuilt without them.
    if (rebuild || this.swung?.size || swung.size) {
      this.glass.geometry.dispose();
      this.glass.geometry = polygonGeometry(this.windows.filter((w) => !swung.has(w.name)), this.origin, () => TYPE_COLORS.Glazing, (w) => this.windowOffset(w));
      this.glass.userData.items = this.windows.filter((w) => !swung.has(w.name));
    }
    this.swung = swung;
    const g2 = this.glass.geometry, own2 = g2.userData.owner, col2 = g2.getAttribute('color'), items = this.glass.userData.items;
    own2.forEach((k, t) => {
      c.set(open?.has(items[k].name) ? OPEN_WINDOW : this.colorBy === 'white' ? WHITE.glass : TYPE_COLORS.Glazing);
      for (let j = 0; j < 3; j++) col2.setXYZ(t * 3 + j, c.r, c.g, c.b);
    });
    col2.needsUpdate = true;
    // The sashes themselves.
    if (this.sashGroup) {
      this.sashGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.group.remove(this.sashGroup);
    }
    this.sashGroup = new THREE.Group();
    const panels = [...swung].map((n) => ({ name: n, vertices: sashPanel(this.model.windows[n], sashes.get(n), this.windowOffset(this.model.windows[n])) }));
    if (panels.length) {
      const mat = new THREE.MeshLambertMaterial({ color: OPEN_WINDOW, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.clipping });
      const mesh = new THREE.Mesh(polygonGeometry(panels, this.origin, null), mat);
      mesh.userData = { kind: 'window', items: panels.map((p) => this.model.windows[p.name]) };
      // The rough openings stay clickable, unseen, so an inward-opening sash can be picked from outside.
      const openings = [...swung].map((n) => this.model.windows[n]);
      const pick = new THREE.Mesh(polygonGeometry(openings, this.origin, null, (w) => this.windowOffset(w)), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
      pick.userData = { kind: 'window', items: openings };
      this.sashMesh = mesh;
      this.openingPick = pick;
      this.sashGroup.add(mesh, pick, new THREE.LineSegments(edgeGeometry(panels, this.origin), new THREE.LineBasicMaterial({ color: this.edgeColor, transparent: true, opacity: 0.6, clippingPlanes: this.clipping })));
    } else { this.sashMesh = null; this.openingPick = null; }
    this.group.add(this.sashGroup);
    // The cuts redraw where they cross glass when sashes swing or close.
    const key = [...swung].map((n) => `${n}:${sashes.get(n)?.type}:${sashes.get(n)?.angle?.toFixed(1)}`).sort().join('|');
    if (key !== this.sashKey) { this.sashKey = key; if (this.sections?.planes.length) this.caps.update(); }
    this.render();
  }

  setShadingVisible(on) { if (this.shading) { this.shading.visible = on; this.render(); } }

  // Half the diagonal of the zones' footprint (m), for drawings placed around the building.
  footprintRadius() {
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
  }

  // The zones' footprint radius (as above) and height (m), for the sky's size.
  extent() {
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    return { radius: this.footprintRadius(), height: b.max[2] - b.min[2] };
  }

  // Something drawn on the ground around the building (the wind rose); null removes it.
  setGroundOverlay(obj) {
    if (this.overlay) {
      this.overlay.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); });
      this.scene.remove(this.overlay);
    }
    this.overlay = obj;
    if (obj) { obj.userData.noSection = true; this.scene.add(obj); }
    this.render();
  }

  find(name) {
    const m = this.model;
    if (m.surfaces[name]) return { kind: 'surface', item: m.surfaces[name], polys: [m.surfaces[name]] };
    if (m.windows[name]) return { kind: 'window', item: m.windows[name], polys: [m.windows[name]] };
    const door = this.doors.find((d) => d.name === name);
    if (door) return { kind: 'door', item: door, polys: [door] };
    if (m.zones[name]) return { kind: 'zone', item: m.zones[name], polys: m.zones[name].surfaces.map((n) => m.surfaces[n]) };
    return null;
  }

  // The solid a surface, window or door is drawn as when walls have thickness (triangles, view
  // coordinates): a surface's own, or for an opening the box of its hole through its wall. null when
  // drawn thin.
  thickOf(poly) {
    if (!this.walls || this.walls === 'thin') return null;
    if (this.solidOf?.has(poly.name)) return this.solidOf.get(poly.name);
    const wall = this.model.surfaces[poly.parent || poly.surface];
    if (!wall) return null;
    const t = this.model.constructions[wall.construction]?.thickness || 0.2;
    try { return surfaceTriangles(poly.vertices, [], this.origin, t, wall.boundary === 'Surface' ? 'centre' : this.walls); } catch { return null; }
  }

  // The edges to outline a selection or a hover by (flat xyz pairs, view coordinates): the solids' as
  // drawn with thickness, else the polygons'.
  outlineOf(polys) {
    const solids = polys.map((p) => this.thickOf(p));
    if (!solids.some(Boolean)) return null;
    const out = [];
    polys.forEach((p, i) => {
      if (!solids[i]) { out.push(...edgeGeometry([p], this.origin).getAttribute('position').array); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(solids[i], 3));
      const e = new THREE.EdgesGeometry(g, 25);
      out.push(...e.getAttribute('position').array);
      g.dispose(); e.dispose();
    });
    return out;
  }

  // Outlines and tints the named surface, window or zone; null clears the selection. With thickness,
  // the solids it is drawn as are tinted and outlined, not just its modelled plane.
  
  select(name, { frame = false } = {}) {
    if (this.highlight) {
      this.highlight.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this.group.remove(this.highlight);
      this.highlight = null;
    }
    const found = name ? this.find(name) : null;
    this.selectedPolys = found?.polys || null;
    if (found) {
      const h = new THREE.Group(), tint = { color: SELECTED, side: THREE.DoubleSide, transparent: true, opacity: 0.42, depthWrite: false, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
      const solids = found.polys.map((p) => this.thickOf(p));
      const flat = found.polys.filter((p, i) => !solids[i]);
      if (flat.length) h.add(new THREE.Mesh(polygonGeometry(flat, this.origin, null, found.kind === 'window' ? 0.03 : 0), new THREE.MeshBasicMaterial(tint)));
      const tris = solids.filter(Boolean).flat();
      if (tris.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
        h.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ ...tint, opacity: found.kind === 'window' ? 0.35 : 0.45 })));
      }
      const edges = this.outlineOf(found.polys);
      const eg = edges ? new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(edges, 3)) : edgeGeometry(found.polys, this.origin);
      h.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: SELECTED, clippingPlanes: this.clipping })));
      h.renderOrder = 2;
      this.highlight = h;
      this.group.add(h);
      if (frame) this.frame(found.polys);
    }
    this.onSelect(found);
    this.render();
  }

  // What is under the pointer: { kind, item, point (view coordinates), dir (the ray's), distance (along
  // the ray from its start: the camera, or the near plane of the parallel view) }, or null.
  // Shading is drawn see-through, so the building behind it wins; shading is found only on its own.
  hitAt(e) {
    if (!this.front) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets = [this.front, this.back, this.glass, ...(this.sashMesh ? [this.sashMesh, this.openingPick] : []), this.doorMesh, ...(this.shading.visible ? [this.shading] : [])];
    const hits = ray.intersectObjects(targets, false).filter((h) => !this.sections.removed(h.point));
    const hit = hits.find((h) => h.object !== this.shading) || hits[0];
    if (!hit) return null;
    const { kind, items } = hit.object.userData;
    return { kind, item: items[hit.object.geometry.userData.owner[hit.faceIndex]], point: hit.point, dir: ray.ray.direction.clone(), distance: hit.distance };
  }

  pickAt(e) {
    this.sections.select(null);
    const box = this.container.getBoundingClientRect();
    this.lastPick = [e.clientX - box.left, e.clientY - box.top]; // where the selection's pop-up opens
    // What the pointer offered (Tab steps through what is under it), else the nearest thing hit.
    const offered = this.offered?.(e);
    if (offered) {
      if (offered.kind === 'shading') { this.select(null); const item = this.model.shading.find((x) => x.name === offered.name); return this.onSelect({ kind: 'shading', item, polys: [item] }); }
      return this.select(offered.name);
    }
    const h = this.hitAt(e);
    if (!h) return this.select(null);
    if (h.kind === 'shading') { this.select(null); return this.onSelect({ kind: h.kind, item: h.item, polys: [h.item] }); }
    this.select(h.item.name);
  }

  // Shows a surface, window or zone in context: a plan cut 1.5 m above its lowest point (the usual
  // plan-drawing height), looking down at its zone from the south-west.
  focus(name) {
    const found = this.find(name);
    if (!found) return null;
    const zone = this.model.zones[found.kind === 'zone' ? name : found.item.zone];
    const cut = bounds(found.polys.flatMap((p) => p.vertices)).min[2] + 1.5;
    if (cut < this.zRange[1]) this.sections.planAt(cut - this.origin[2]);
    this.select(name);
    this.frame(zone ? zone.surfaces.map((n) => this.model.surfaces[n]) : found.polys, new THREE.Vector3(-0.45, -0.8, 1.4));
  }

  // Points the camera at a set of polygons (the whole building by default), from the south-west.
  // The whole building also takes in what is drawn on the ground around it (the wind rose).
  frame(polys = this.surfaces, from = new THREE.Vector3(-0.55, -1, 0.75)) {
    const b = bounds(polys.flatMap((p) => p.vertices));
    const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2 - this.origin[i]));
    let radius = Math.max(1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
    if (polys === this.surfaces && this.overlay) {
      const box = new THREE.Box3().setFromObject(this.overlay);
      if (!box.isEmpty()) {
        box.expandByPoint(centre);
        box.getCenter(centre);
        radius = Math.max(radius, box.getSize(new THREE.Vector3()).length() / 2);
      }
    }
    // With the sky shown, the whole building is framed with its dome, as the shading tool fits it.
    if (polys === this.surfaces && this.skyRadius) {
      centre.set(0, 0, this.skyRadius * 0.3);
      radius = Math.max(radius, this.skyRadius * 1.3); // with the compass figures outside the horizon
    }
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.perspective.fov / 2))) * 1.05;
    const dir = from.clone().normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    if (this.camera === this.parallel) {
      this.fitParallel(radius * 1.05);
      this.parallel.zoom = 1;
    } else {
      this.camera.near = Math.max(0.05, dist / 2000);
      this.camera.far = dist * 20 + 2000;
    }
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.render();
  }
}
