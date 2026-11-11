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

// The convex hull of points in a plane ([x, y]), counterclockwise.
function hull2(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p); }
  for (const p of P.reverse()) { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 1e-9) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// Edges (flat xyz pairs) less those inside a flat face: an edge with the same face on both sides of
// it - triangles of one plane, facing the same way, cover a point just either side - is a seam between
// coplanar pieces (two storeys' walls, a wall split around a slab) and is not drawn - unless the two
// sides are different surfaces of the same zone: a seam made on purpose (a face split in two), kept.
// tris: flat xyz; zoneOf(t), surfaceOf(t): triangle t's zone and surface.
// the model checks that find a fault in where or which way surfaces stand: painted in the view
const GEOMETRY_CHECKS = new Set(['surface-upside-down', 'interzone-not-opposite', 'interzone-not-reciprocal', 'interzone-partner-missing', 'zone-surface-reversed', 'zone-not-closed', 'zone-negative-volume', 'window-off-plane', 'surface-zone-missing']);

const WINDOW_SWING = 650; // ms a sash takes to swing to its new angle, drawn

// x with A x = b, A 3 x 3 (Cramer's rule)
function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return [0, 0, 0];
  return [0, 1, 2].map((k) => det(A.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))) / D);
}

function dropSeams(edges, tris, zoneOf = () => 0, surfaceOf = () => 0) {
  const planes = new Map(), v = (a, i) => new THREE.Vector3(a[i], a[i + 1], a[i + 2]);
  const f3 = (x) => { const s = x.toFixed(3); return s === '-0.000' ? '0.000' : s; };
  const keyOf = (n, d) => `${f3(n.x)},${f3(n.y)},${f3(n.z)},${f3(d)}`;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = v(tris, i), b = v(tris, i + 3), c = v(tris, i + 6), n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    const d = n.dot(a), key = keyOf(n, d);
    if (!planes.has(key)) planes.set(key, { n, d, t: [], key });
    const t = new THREE.Triangle(a, b, c);
    t.id = i / 9;
    planes.get(key).t.push(t);
  }
  // each plane's back: the plane facing the other way in the same place (a face against another)
  for (const pl of planes.values()) pl.back = planes.get(keyOf(pl.n.clone().negate(), -pl.d)) || null;
  const list = [...planes.values()], p = new THREE.Vector3(), q = new THREE.Vector3(), mid = new THREE.Vector3(), w = new THREE.Vector3(), x = new THREE.Vector3();
  const cover = (pl, pt) => pl.t.find((t) => t.containsPoint(pt))?.id ?? -1;
  const out = [];
  for (let i = 0; i + 5 < edges.length; i += 6) {
    p.set(edges[i], edges[i + 1], edges[i + 2]); q.set(edges[i + 3], edges[i + 4], edges[i + 5]);
    mid.addVectors(p, q).multiplyScalar(0.5);
    // An edge stays where it bounds a face that shows (one side of it covered, the other not, and the
    // covered side not against another face): as where a low zone's roof meets a taller zone's wall.
    // Otherwise it goes where it lies within faces in one plane: within one surface (its triangles'
    // seams), or between zones (one wall seen as one).
    let seam = false, edge = false;
    for (const pl of list) {
      if (Math.abs(pl.n.dot(p) - pl.d) > 1e-3 || Math.abs(pl.n.dot(q) - pl.d) > 1e-3) continue;
      w.subVectors(q, p).cross(pl.n).normalize().multiplyScalar(0.01);
      const a = cover(pl, x.copy(mid).add(w)), b = cover(pl, x.copy(mid).sub(w));
      if ((a < 0) !== (b < 0)) {
        const at = x.copy(mid).add(a < 0 ? w.negate() : w);
        if (!pl.back || cover(pl.back, at) < 0) { edge = true; break; }
        continue;
      }
      if (a >= 0 && b >= 0 && (surfaceOf(a) === surfaceOf(b) || zoneOf(a) !== zoneOf(b))) seam = true;
    }
    if (edge || !seam) out.push(edges[i], edges[i + 1], edges[i + 2], edges[i + 3], edges[i + 4], edges[i + 5]);
  }
  return out;
}

// Where solids run into one another (a low zone's roof into a taller zone's wall, a wall's end into
// another's side), the line where their faces cross shows as an edge though it is no solid's own: each
// such line, where the solids about it make a corner (filled on one or three sides of it, or two across
// it), not a flat face. solids: triangle arrays (view coordinates). Returns segment positions.
function crossEdges(solids) {
  const E = 0.01, out = [];
  const S = solids.map((tris) => {
    const faces = new Map(), box = new THREE.Box3();
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const a = new THREE.Vector3(tris[i], tris[i + 1], tris[i + 2]), b = new THREE.Vector3(tris[i + 3], tris[i + 4], tris[i + 5]), c = new THREE.Vector3(tris[i + 6], tris[i + 7], tris[i + 8]);
      box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      const d = n.dot(a), key = `${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)},${d.toFixed(3)}`;
      if (!faces.has(key)) faces.set(key, { n, d, tris: [], box: new THREE.Box3() });
      const f = faces.get(key);
      f.tris.push([a, b, c]);
      f.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    }
    for (const f of faces.values()) f.box.expandByScalar(1e-3);
    box.expandByScalar(1e-3);
    return { tris, faces: [...faces.values()], box, mesh: null };
  });
  // inside a solid: an odd count of its faces crossed along a ray
  const ray = new THREE.Raycaster(), dir = new THREE.Vector3(0.5773, 0.6131, 0.5391).normalize();
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const inside = (pt) => S.some((s) => {
    if (!s.box.containsPoint(pt)) return false;
    if (!s.mesh) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(s.tris, 3)); s.mesh = new THREE.Mesh(g, mat); }
    ray.set(pt, dir);
    return ray.intersectObject(s.mesh, false).length % 2 === 1;
  });
  // the stretches [t0, t1] of the line p0 + t u within a face
  const within = (f, p0, u) => {
    const spans = [], q = new THREE.Vector3(), m = new THREE.Vector3(), g = new THREE.Vector3();
    for (const tri of f.tris) {
      let lo = -Infinity, hi = Infinity;
      g.copy(tri[0]).add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
      for (let k = 0; k < 3 && lo <= hi; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        m.subVectors(b, a).cross(f.n);
        if (m.dot(q.subVectors(g, a)) < 0) m.negate();
        const at0 = m.dot(q.subVectors(p0, a)), du = m.dot(u), tol = 1e-6 * m.length();
        if (Math.abs(du) < 1e-12) { if (at0 < -tol) hi = -Infinity; continue; }
        const t = (-tol - at0) / du;
        if (du > 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
      }
      if (hi - lo > 1e-6) spans.push([lo, hi]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const sp of spans) { const l = merged[merged.length - 1]; if (l && sp[0] <= l[1] + 1e-5) l[1] = Math.max(l[1], sp[1]); else merged.push([...sp]); }
    return merged;
  };
  const u = new THREE.Vector3(), p0 = new THREE.Vector3(), w = new THREE.Vector3(), pt = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  for (let i = 0; i < S.length; i++) {
    for (let j = i + 1; j < S.length; j++) {
      if (!S[i].box.intersectsBox(S[j].box)) continue;
      for (const fa of S[i].faces) {
        for (const fb of S[j].faces) {
          if (Math.abs(fa.n.dot(fb.n)) > 0.999 || !fa.box.intersectsBox(fb.box)) continue;
          u.crossVectors(fa.n, fb.n);
          const uu = u.lengthSq();
          // a point on both planes
          p0.copy(t1.crossVectors(fb.n, u).multiplyScalar(fa.d)).add(t2.crossVectors(u, fa.n).multiplyScalar(fb.d)).multiplyScalar(1 / uu);
          u.normalize();
          const A = within(fa, p0, u);
          if (!A.length) continue;
          const B = within(fb, p0, u);
          for (const [a0, a1] of A) {
            for (const [b0, b1] of B) {
              const s0 = Math.max(a0, b0), s1 = Math.min(a1, b1);
              if (s1 - s0 < 0.02) continue;
              // the four sides about the line's middle, filled or not
              const mid = pt.copy(p0).addScaledVector(u, (s0 + s1) / 2), fill = [];
              for (const [x, y] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) fill.push(inside(w.copy(mid).addScaledVector(fa.n, x * E).addScaledVector(fb.n, y * E)));
              const n = fill.filter(Boolean).length;
              if (n === 1 || n === 3 || (n === 2 && fill[0] === fill[2])) {
                const a = p0.clone().addScaledVector(u, s0), b = p0.clone().addScaledVector(u, s1);
                out.push(a.x, a.y, a.z, b.x, b.y, b.z);
              }
            }
          }
        }
      }
    }
  }
  for (const s of S) s.mesh?.geometry.dispose();
  mat.dispose();
  return out;
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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    // The sun's shadows, from where the sun stands at the hour picked. The light lights nothing (the
    // colours keep their fixed light); it only casts, onto a shadow-only skin over the building and a
    // shadow-only ground, so the shadows read the same in every colouring, White included.
    this.shadowLight = new THREE.DirectionalLight(0xffffff, 0);
    this.shadowLight.castShadow = true;
    this.shadowLight.shadow.mapSize.set(2048, 2048);
    this.shadowLight.shadow.bias = -0.0004;
    this.shadowLight.shadow.normalBias = 0.03;
    this.shadowLight.visible = false;
    this.scene.add(this.shadowLight, this.shadowLight.target);

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
      this.frames = (this.frames || 0) + 1;
    });
  }
  // Frames drawn a second, in the view's top left corner (the view draws only when something
  // changes or moves: idle, none).
  showFrameRate() {
    const box = document.createElement('div');
    box.className = 'fpsbox';
    box.title = 'Frames drawn a second. The view draws only when something changes or moves, so a still view draws none.';
    this.container.appendChild(box);
    let last = performance.now();
    setInterval(() => {
      const now = performance.now(), fps = ((this.frames || 0) * 1000) / (now - last);
      this.frames = 0; last = now;
      const text = fps >= 0.5 ? `${Math.round(fps)} fps` : 'idle';
      if (box.textContent !== text) box.textContent = text;
    }, 1000);
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
    if (!this.origin.every(Number.isFinite)) this.origin = [0, 0, 0]; // nothing modelled yet (a blank massing)
    this.zRange = Number.isFinite(b.min[2]) ? [b.min[2], b.max[2]] : [0, 0];

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
    this.shadowSkins();
    this.setFloating(this.floatZones);
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
      const own = this.surfaceLine?.(s.name); // a drawn wall's own location line
      if (own) return own;
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
    this.outerMemo = null;
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

  // Zones held up by nothing (named): their surfaces covered in a grey diagonal hatch, so a mass left
  // floating (its support deleted) shows. Kept, and redrawn, as the walls change.
  setFloating(zones = []) {
    this.floatZones = zones;
    if (this.floatMesh) { this.floatMesh.geometry.dispose(); this.floatMesh.material.dispose(); this.group.remove(this.floatMesh); this.floatMesh = null; }
    if (zones.length && this.front) {
      const set = new Set(zones), owner = this.front.geometry.userData.owner || [], pos = this.front.geometry.getAttribute('position').array, out = [];
      for (let t = 0; t < owner.length; t++) if (set.has(this.surfaces[owner[t]]?.zone)) for (let k = 0; k < 9; k++) out.push(pos[t * 9 + k]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
      const mat = new THREE.MeshBasicMaterial({ color: '#93A6AA', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const dpr = this.renderer.getPixelRatio();
      this.sections.patch(mat, -1, (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
if (mod((gl_FragCoord.x - gl_FragCoord.y) * 0.70710678, ${(6 * dpr).toFixed(2)}) < ${(1.4 * dpr).toFixed(2)}) gl_FragColor = vec4(0.294, 0.345, 0.333, 0.9);`);
      });
      this.floatMesh = new THREE.Mesh(g, mat);
      this.floatMesh.renderOrder = 4;
      this.floatMesh.raycast = () => {};
      this.group.add(this.floatMesh);
    }
    this.render();
  }

  // What the sun's shadows fall on: a skin over the surfaces that draws only shadow, and the ground
  // round the building (shadow #7E95A3 at 0.34, as the shading tool's ground shadow).
  shadowSkins() {
    const shade = { color: '#7E95A3', opacity: 0.34, transparent: true, depthWrite: false };
    this.skin = new THREE.Mesh(this.front.geometry, new THREE.ShadowMaterial({ ...shade, clippingPlanes: this.clipping, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    this.skin.receiveShadow = true;
    this.skin.raycast = () => {};
    this.skin.renderOrder = 2;
    const r = Math.max(10, this.footprintRadius() * 6);
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(r, 64), new THREE.ShadowMaterial(shade));
    this.ground.position.z = -0.005;
    this.ground.receiveShadow = true;
    this.ground.raycast = () => {};
    this.ground.userData.noSection = true;
    for (const m of [this.front, this.shading, this.doorMesh]) {
      m.castShadow = true; // glass lets the sun through
      // what the clipping planes remove casts no shadow
      m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      if (this.sections) this.sections.patch(m.customDepthMaterial);
    }
    this.group.add(this.skin, this.ground);
    this.setSun(this.sunAt ?? null);
  }

  // The sun's direction (unit, view axes) or null when it is down or its shadows are off.
  setSun(dir) {
    this.sunAt = dir;
    const L = this.shadowLight, on = !!dir && !!this.front;
    L.visible = on;
    if (this.skin) this.skin.visible = this.ground.visible = on;
    if (on) {
      const b = bounds(this.surfaces.flatMap((s) => s.vertices)), span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const reach = span * 3, c = new THREE.Vector3(0, 0, (b.max[2] - b.min[2]) / 2);
      L.target.position.copy(c);
      L.position.copy(c).addScaledVector(new THREE.Vector3(...dir), reach * 2);
      const cam = L.shadow.camera;
      Object.assign(cam, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.1, far: reach * 4 });
      cam.updateProjectionMatrix();
      L.target.updateMatrixWorld();
    }
    this.render();
  }

  // Walls standing free (drawn, closing nothing): solids of their thickness from z0 to z1 along a -> b
  // (model coordinates), the drawn line at `off` across them (from -t/2 on its right to t/2 on its left).
  // They are cut by the planes, and by plans and sections, as the other solids are. [{ a, b, z0, z1, t, off }]
  setFreeWalls(list = []) {
    if (this.freeMesh) { this.group.remove(this.freeMesh, this.freeEdges); this.freeMesh.geometry.dispose(); this.freeEdges.geometry.dispose(); this.freeMesh = this.freeEdges = null; }
    this.solids = (this.solids || []).filter((t) => !t.free);
    if (!list.length || !this.group) { this.render(); return; }
    const o = this.origin || [0, 0, 0], all = [], owner = [];
    this.freeList = list;
    for (const [wi, w] of list.entries()) {
      const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], l = Math.hypot(dx, dy) || 1, n = [-dy / l, dx / l];
      const s0 = w.off - w.t / 2, s1 = w.off + w.t / 2;
      const P = (p, s, z) => [p[0] + n[0] * s - o[0], p[1] + n[1] * s - o[1], z - o[2]];
      const c = [P(w.a, s0, w.z0), P(w.b, s0, w.z0), P(w.b, s1, w.z0), P(w.a, s1, w.z0), P(w.a, s0, w.z1), P(w.b, s0, w.z1), P(w.b, s1, w.z1), P(w.a, s1, w.z1)];
      const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      const tris = [];
      for (const [a, b, cc, d] of quads) tris.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
      const arr = new Float32Array(tris);
      arr.free = true;
      arr.wall = w.id;
      this.solids.push(arr);
      all.push(...tris);
      for (let t = 0; t < tris.length / 9; t++) owner.push(wi);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    g.computeVertexNormals();
    this.freeMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: TYPE_COLORS.Partition || '#C9C2B6', side: THREE.DoubleSide, clippingPlanes: this.clipping }));
    g.userData.owner = owner;
    this.freeMesh.userData = { kind: 'freewall', items: list.map((w) => ({ name: `wall:${w.id}`, id: w.id, wall: w })) };
    this.freeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: this.edgeColor, transparent: true, opacity: 0.45, clippingPlanes: this.clipping }));
    this.group.add(this.freeMesh, this.freeEdges);
    this.caps?.update();
    this.render();
  }

  // Outlines: of the modelled polygons when thin, of the solids' edges when thick.
  edgesGeometry() {
    // thick: each solid's own edges, so where two solids meet in line (a face split in two) the seam
    // between them is there to keep, which one merged outline would have smoothed away
    let e;
    if (this.walls && this.walls !== 'thin' && this.solids?.length) {
      const pos = [];
      for (const tris of this.solids) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
        const eg = new THREE.EdgesGeometry(g, 25);
        pos.push(...eg.getAttribute('position').array);
        g.dispose(); eg.dispose();
      }
      e = new THREE.BufferGeometry();
      e.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    } else e = this.walls && this.walls !== 'thin' ? new THREE.EdgesGeometry(this.front.geometry, 25) : edgeGeometry([...this.surfaces, ...this.windows, ...this.doors], this.origin);
    // coplanar faces read as one: the seams inside them dropped
    let kept;
    const owner = this.front.geometry.userData.owner || [];
    try { kept = dropSeams(e.getAttribute('position').array, this.front.geometry.getAttribute('position').array, (t) => this.surfaces[owner[t]]?.zone, (t) => owner[t]); } catch { return e; }
    e.dispose();
    // thick: where solids run into one another, the line they meet on
    if (this.walls && this.walls !== 'thin' && this.solids?.length) {
      kept = kept.concat(crossEdges(this.solids.filter((t) => !t.free)));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(kept, 3));
    return g;
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
    if (this.skin) this.skin.geometry = g;
    old.dispose();
    this.edges.geometry.dispose();
    this.edges.geometry = this.edgesGeometry();
    this.redrawWindows();
    this.setFloating(this.floatZones);
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

  // Surfaces named by a check of their geometry: red on both sides, with an arrow the way EnergyPlus takes
  // as outward (from the order of their corners), as such faults are found by which way surfaces face.
  // Checks of their settings (an assembly unspecified, say) are listed, not painted.
  problemLayer() {
    const layer = new THREE.Group();
    const flagged = new Set(this.model.checks.filter((c) => GEOMETRY_CHECKS.has(c.code)).flatMap((c) => c.objects).filter((n) => this.model.surfaces[n]));
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
  // The windows opened and closed as the air has them, each sash swinging to its new angle over a
  // moment (WINDOW_SWING ms, eased) rather than jumping there. Only the drawing moves: the air takes
  // the new opening at once. open: the open windows' names; sashes: name -> { type, hinge, angle }.
  showWindows(open, sashes = new Map()) {
    const from = this.sashNow || new Map(), to = new Map([...open].map((n) => [n, { sash: sashes.get(n), angle: sashes.get(n)?.angle || 0 }]));
    const names = new Set([...[...from].filter(([, v]) => v.angle > 0.01).map(([n]) => n), ...to.keys()]);
    const moves = [...names].some((n) => Math.abs((from.get(n)?.angle || 0) - (to.get(n)?.angle || 0)) > 0.5);
    cancelAnimationFrame(this.swingRaf);
    if (!moves || !this.glass) { this.sashNow = to; this.setOpenWindows(open, sashes); return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / WINDOW_SWING), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      if (k >= 1) { this.sashNow = to; this.setOpenWindows(open, sashes); return; }
      const cur = new Map(), shown = new Set(), sh = new Map();
      for (const n of names) {
        const a0 = from.get(n)?.angle || 0, a1 = to.get(n)?.angle || 0, sash = to.get(n)?.sash || from.get(n)?.sash, a = a0 + (a1 - a0) * e;
        cur.set(n, { sash, angle: a });
        if (open.has(n) || a > 0.01) { shown.add(n); if (sash) sh.set(n, { ...sash, angle: a }); }
      }
      this.sashNow = cur;
      this.setOpenWindows(shown, sh, false, true);
      this.swingRaf = requestAnimationFrame(step);
    };
    this.swingRaf = requestAnimationFrame(step);
  }

  // quick: a frame of a swing, the cuts left to its last
  setOpenWindows(open, sashes = new Map(), rebuild = false, quick = false) {
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
    if (!quick && key !== this.sashKey) { this.sashKey = key; if (this.sections?.planes.length) this.caps.update(); }
    this.render();
  }

  setShadingVisible(on) { if (this.shading) { this.shading.visible = on; this.render(); } }

  // Half the diagonal of the zones' footprint (m), for drawings placed around the building.
  footprintRadius() {
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
    return Number.isFinite(r) && r > 0 ? r : 8; // nothing modelled yet: a small building's
  }

  // The zones' footprint radius (as above) and height (m), for the sky's size.
  extent() {
    const b = bounds(this.surfaces.flatMap((s) => s.vertices));
    const h = b.max[2] - b.min[2];
    return { radius: this.footprintRadius(), height: Number.isFinite(h) && h > 0 ? h : 3.5 };
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
    // a drawn wall standing free: its pieces' solids
    if (String(name).startsWith('wall:')) {
      const id = Number(name.slice(5)), tris = (this.solids || []).filter((t) => t.free && t.wall === id);
      if (tris.length) return { kind: 'wall', item: { name, id, wall: this.freeList?.find((w) => w.id === id) }, polys: [], tris: tris.flatMap((t) => [...t]) };
    }
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

  // Only the outer bounds, for the hover preview: the edges where a zone's (or a surface's) faces meet,
  // each corner pushed out to the outside of the solids drawn, so openings, reveals and inner faces
  // drop out. Kept per name until the model or walls change.
  outerOutlineOf(name, polys) {
    const memo = (this.outerMemo ??= new Map());
    if (memo.has(name)) return memo.get(name);
    const o = this.origin, surfs = polys.filter((p) => this.model.surfaces[p.name]);
    // Each surface: its outward normal and how far its solid stands out past it.
    const info = surfs.map((p) => {
      const v = p.vertices, n = [0, 0, 0];
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const l = Math.hypot(...n) || 1, nn = n.map((x) => x / l), sol = this.thickOf(p);
      let t = 0;
      if (sol) for (let i = 0; i + 2 < sol.length; i += 3) t = Math.max(t, (sol[i] + o[0] - v[0][0]) * nn[0] + (sol[i + 1] + o[1] - v[0][1]) * nn[1] + (sol[i + 2] + o[2] - v[0][2]) * nn[2]);
      return { p, n: nn, t };
    });
    if (!info.length) { memo.set(name, null); return null; }
    // One surface: the outline of its solid's outer face at its fullest - out to the mitred corners -
    // the hull of the solid seen square to the face, at the outside of the solid.
    const sol = info.length === 1 && this.thickOf(info[0].p);
    if (sol) {
      const { n, t, p } = info[0], N = new THREE.Vector3(...n), up = Math.abs(n[2]) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const A = new THREE.Vector3().crossVectors(up, N).normalize(), B = new THREE.Vector3().crossVectors(N, A), O = new THREE.Vector3(...p.vertices[0].map((x, j) => x - o[j]));
      const pts = [];
      for (let i = 0; i + 2 < sol.length; i += 3) { const d = new THREE.Vector3(sol[i], sol[i + 1], sol[i + 2]).sub(O); pts.push([d.dot(A), d.dot(B)]); }
      const hull = hull2(pts), out = [];
      const at = ([x, y]) => O.clone().addScaledVector(A, x).addScaledVector(B, y).addScaledVector(N, t).toArray();
      hull.forEach((h, i) => out.push(...at(h), ...at(hull[(i + 1) % hull.length])));
      memo.set(name, out);
      return out;
    }
    // A corner pushed out by each way the faces meeting there face (each once, its furthest).
    const key = (q) => q.map((x) => x.toFixed(3)).join(), at = new Map();
    for (const f of info) for (const q of f.p.vertices) {
      const k = key(q), list = at.get(k) || at.set(k, []).get(k), same = list.find((g) => g.n[0] * f.n[0] + g.n[1] * f.n[1] + g.n[2] * f.n[2] > 0.99);
      if (same) same.t = Math.max(same.t, f.t); else list.push({ n: f.n, t: f.t });
    }
    // Each corner out to where the faces meeting there meet once each is set out by its solid: the
    // point nearest the corner on all their set-out planes (least squares, so two faces give their
    // edge's line and three or more their mitre). Adding each face's push, as before, overshot where
    // faces meet at angles other than square (a hipped roof's eaves).
    const moved = (q) => {
      const list = at.get(key(q)), A = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]], b = [0, 0, 0];
      for (const g of list) for (let r = 0; r < 3; r++) { b[r] += g.n[r] * g.t; for (let c = 0; c < 3; c++) A[r][c] += g.n[r] * g.n[c]; }
      const y = solve3(A, b);
      return [q[0] - o[0] + y[0], q[1] - o[1] + y[1], q[2] - o[2] + y[2]];
    };
    // The edges where faces meet at an angle, and the open ones: the zone's box, without its openings.
    const edges = new Map();
    for (const f of info) {
      const v = f.p.vertices;
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length], ka = key(a), kb = key(b), id = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        if (!edges.has(id)) edges.set(id, { a, b, on: [] });
        edges.get(id).on.push(f.n);
      }
    }
    const out = [];
    for (const { a, b, on } of edges.values()) {
      if (on.length > 1 && on.every((n) => n[0] * on[0][0] + n[1] * on[0][1] + n[2] * on[0][2] > 0.94)) continue;
      out.push(...moved(a), ...moved(b));
    }
    memo.set(name, out);
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
      const tris = [...solids.filter(Boolean).flat(), ...(found.tris || [])];
      if (tris.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
        h.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ ...tint, opacity: found.kind === 'window' ? 0.35 : 0.45 })));
      }
      const edges = found.tris ? null : this.outlineOf(found.polys);
      const eg = found.tris ? new THREE.EdgesGeometry(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(found.tris, 3)), 25)
        : edges ? new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(edges, 3)) : edgeGeometry(found.polys, this.origin);
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
    const targets = [this.front, this.back, this.glass, ...(this.sashMesh ? [this.sashMesh, this.openingPick] : []), this.doorMesh, ...(this.freeMesh ? [this.freeMesh] : []), ...(this.shading.visible ? [this.shading] : [])];
    const hits = ray.intersectObjects(targets, false).filter((h) => !this.sections.removed(h.point));
    const hit = hits.find((h) => h.object !== this.shading) || hits[0];
    if (!hit) return null;
    const { kind, items } = hit.object.userData;
    return { kind, item: items[hit.object.geometry.userData.owner[hit.faceIndex]], point: hit.point, dir: ray.ray.direction.clone(), distance: hit.distance };
  }

  // Whether a point (view coordinates) shows, not behind the building (as cut by the clipping planes).
  visibleAt(pt) {
    if (!this.front) return true;
    const ray = (this.occRay ||= new THREE.Raycaster());
    ray.setFromCamera(new THREE.Vector2().copy(pt.clone().project(this.camera)), this.camera);
    const d = ray.ray.origin.distanceTo(pt), targets = [this.front, this.back, this.doorMesh].filter(Boolean);
    const hit = ray.intersectObjects(targets, false).find((h) => !this.sections.removed(h.point));
    return !hit || hit.distance > d - 0.05;
  }
  // Where a ray from `from` toward `to` (view coordinates) first meets the building, or null.
  firstHit(from, to) {
    if (!this.front) return null;
    const ray = (this.occRay ||= new THREE.Raycaster()), dir = to.clone().sub(from), L = dir.length();
    ray.set(from, dir.normalize());
    ray.far = L;
    const hit = ray.intersectObjects([this.front, this.back, this.doorMesh].filter(Boolean), false).find((h) => !this.sections.removed(h.point));
    ray.far = Infinity;
    return hit ? hit.point : null;
  }

  pickAt(e) {
    this.clicked = true; // a click: a closed pop-up opens again on what it picks
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

  // The camera turned about the vertical through its target, by degrees anticlockwise seen from above.
  turnCamera(deg) {
    const t = this.controls.target, a = THREE.MathUtils.degToRad(deg);
    this.camera.position.sub(t).applyAxisAngle(new THREE.Vector3(0, 0, 1), a).add(t);
    this.camera.lookAt(t);
    this.controls.update();
  }

  // Points the camera at a set of polygons (the whole building by default), from the south-west.
  // The whole building also takes in what is drawn on the ground around it (the wind rose).
  frame(polys = this.surfaces, from = new THREE.Vector3(-0.55, -1, 0.75)) {
    let b = bounds(polys.flatMap((p) => p.vertices));
    if (!Number.isFinite(b.min[0])) b = { min: [-8, -8, 0], max: [8, 8, 3.5] }; // nothing modelled yet
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
