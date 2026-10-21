// Surfaces drawn with their openings cut out, as thin planes or as solids of their construction's
// thickness. EnergyPlus surfaces have no thickness; the location line says where the modelled surface
// sits within the drawn wall: 'interior' finish (the solid grows outwards, away from its zone),
// 'centre', or 'exterior' finish (the solid grows into the zone). A surface shared by two zones is one
// of a pair of coinciding surfaces, so it is drawn once and centred.

import * as THREE from 'three';
import { unitNormal } from '../src/model/geometry.js';

// The plane of a polygon: origin, in-plane axes u, v and normal n (out of its zone).
function planeOf(points) {
  const n = unitNormal(points), p0 = points[0];
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = new THREE.Vector3().crossVectors(new THREE.Vector3(...ref), new THREE.Vector3(...n)).normalize();
  const v = new THREE.Vector3().crossVectors(new THREE.Vector3(...n), u);
  return { p0: new THREE.Vector3(...p0), u, v, n: new THREE.Vector3(...n) };
}

const flat = (pl, p) => { const d = new THREE.Vector3(...p).sub(pl.p0); return new THREE.Vector2(d.dot(pl.u), d.dot(pl.v)); };
const ccw = (pts) => (THREE.ShapeUtils.isClockWise(pts) ? [...pts].reverse() : pts);

// Triangles (flat array of xyz, view coordinates) for one surface with its holes.
// thickness 0: the plane itself, facing the surface's way. Otherwise a closed solid.
export function surfaceTriangles(points, holes, origin, thickness = 0, line = 'centre') {
  const pl = planeOf(points);
  const outline = ccw(points.map((p) => flat(pl, p)));
  const holes2 = holes.map((h) => ccw(h.map((p) => flat(pl, p))).reverse()); // holes run clockwise
  const o = new THREE.Vector3(...origin);
  const out = [];
  const put = (x, y, z) => {
    const p = pl.p0.clone().addScaledVector(pl.u, x).addScaledVector(pl.v, y).addScaledVector(pl.n, z).sub(o);
    out.push(p.x, p.y, p.z);
  };
  if (!(thickness > 0)) {
    const tris = THREE.ShapeUtils.triangulateShape(outline, holes2);
    const all = [...outline, ...holes2.flat()];
    // Keep each triangle facing the surface's way (counterclockwise in the plane).
    for (const t of tris) {
      const [a, b, c] = t.map((i) => all[i]);
      const turn = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      for (const i of turn >= 0 ? t : [t[0], t[2], t[1]]) put(all[i].x, all[i].y, 0);
    }
    return out;
  }
  const shape = new THREE.Shape(outline);
  shape.holes = holes2.map((h) => new THREE.Path(h));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1, curveSegments: 1 });
  const start = line === 'interior' ? 0 : line === 'exterior' ? -thickness : -thickness / 2;
  const pos = g.getAttribute('position');
  const ix = g.index;
  const n = ix ? ix.count : pos.count;
  for (let k = 0; k < n; k++) {
    const i = ix ? ix.getX(k) : k;
    put(pos.getX(i), pos.getY(i), pos.getZ(i) + start);
  }
  g.dispose();
  return out;
}

// Offsets (along the surface's own normal) of a solid's two faces for a location line.
export function faceOffsets(thickness, line) {
  if (line === 'interior') return [0, thickness];
  if (line === 'exterior') return [-thickness, 0];
  return [-thickness / 2, thickness / 2];
}

// The smallest move d with n_i . d = r_i for every plane meeting at a corner: the corner of an offset
// solid where its neighbours' offset faces meet. Parallel planes count once (the surface's own value).
function cornerMove(planes) {
  const uniq = [];
  for (const p of planes) if (!uniq.some((q) => Math.abs(q.n.dot(p.n)) > 0.999)) uniq.push(p);
  const N = uniq.map((p) => p.n), r = uniq.map((p) => p.r);
  if (N.length === 1) return N[0].clone().multiplyScalar(r[0]);
  if (N.length === 2) { // in the plane of the two normals
    const a = N[0].dot(N[0]), b = N[0].dot(N[1]), c = N[1].dot(N[1]), det = a * c - b * b;
    const l0 = (c * r[0] - b * r[1]) / det, l1 = (a * r[1] - b * r[0]) / det;
    return N[0].clone().multiplyScalar(l0).addScaledVector(N[1], l1);
  }
  // Three or more: least squares, n_i . d = r_i.
  const M = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0), rhs = new THREE.Vector3();
  const m = M.elements;
  N.forEach((n, i) => {
    const v = [n.x, n.y, n.z];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a + 3 * b] += v[a] * v[b];
    rhs.addScaledVector(n, r[i]);
  });
  if (Math.abs(M.determinant()) < 1e-9) return cornerMove(uniq.slice(0, 2));
  return rhs.applyMatrix3(M.invert());
}

// Solids for the building envelope (surfaces not shared by two zones), with mitred corners: each
// corner of a surface's two faces is where the faces of every envelope surface meeting there meet,
// each at its own thickness. With the interior finish as location line the solids grow outwards and
// wrap the corners; with the exterior finish they grow inwards and merge. Holes cut straight through.
// surfaces: [{ vertices, holes: [points], thickness, normal? }]; returns one triangle array per surface.
export function envelopeSolids(surfaces, origin, line) {
  const key = (p) => p.map((x) => Math.round(x * 1000)).join(',');
  const at = new Map();
  const info = surfaces.map((s, i) => {
    const n = new THREE.Vector3(...unitNormal(s.vertices));
    const [a, b] = faceOffsets(s.thickness, line);
    for (const p of s.vertices) at.set(key(p), [...(at.get(key(p)) || []), i]);
    return { n, a, b };
  });
  const o = new THREE.Vector3(...origin);
  return surfaces.map((s, i) => {
    const me = info[i];
    const corner = (p, side) => {
      const planes = (at.get(key(p)) || [i]).map((j) => ({ n: info[j].n, r: j === i ? me[side] : info[j][side] }));
      planes.sort((x, y) => (x.n.equals(me.n) ? -1 : y.n.equals(me.n) ? 1 : 0)); // own plane first, so it wins ties
      const d = cornerMove(planes);
      if (!Number.isFinite(d.x) || d.length() > 5 * Math.max(s.thickness, 0.1)) return new THREE.Vector3(...p).addScaledVector(me.n, me[side]);
      return new THREE.Vector3(...p).add(d);
    };
    const inner = s.vertices.map((p) => corner(p, 'a')), outer = s.vertices.map((p) => corner(p, 'b'));
    const holesIn = s.holes.map((h) => h.map((p) => new THREE.Vector3(...p).addScaledVector(me.n, me.a)));
    const holesOut = s.holes.map((h) => h.map((p) => new THREE.Vector3(...p).addScaledVector(me.n, me.b)));
    return solidTriangles(inner, outer, holesIn, holesOut, me.n, o);
  });
}

// Triangles of a slab between two parallel outlines (same corner order), with holes through it.
function solidTriangles(inner, outer, holesIn, holesOut, n, o) {
  const out = [];
  const tri = (a, b, c, facing) => {
    const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const [p, q, r] = nn.dot(facing) >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [p, q, r]) out.push(v.x - o.x, v.y - o.y, v.z - o.z);
  };
  // Caps, triangulated in the plane.
  const u = new THREE.Vector3().crossVectors(Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0), n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  for (const [ring, holes, facing] of [[inner, holesIn, n.clone().negate()], [outer, holesOut, n]]) {
    const flatOf = (p) => new THREE.Vector2(p.dot(u), p.dot(v));
    const outline = ring.map(flatOf), holes2 = holes.map((h) => h.map(flatOf));
    const all = [...ring, ...holes.flat()];
    const tris = THREE.ShapeUtils.triangulateShape(outline, holes2);
    for (const t of tris) tri(all[t[0]], all[t[1]], all[t[2]], facing);
  }
  // Sides: round the outline facing out of it, round each hole facing into the hole. An edge's outward
  // direction in the plane is edge x n for a ring running counterclockwise about n.
  const turn = (ring) => { // +1 if the ring runs counterclockwise about n
    const a = new THREE.Vector3();
    for (let k = 0; k < ring.length; k++) a.add(new THREE.Vector3().crossVectors(ring[k], ring[(k + 1) % ring.length]));
    return a.dot(n) >= 0 ? 1 : -1;
  };
  const band = (a, b, into) => {
    const sgn = turn(a) * (into ? -1 : 1);
    for (let k = 0; k < a.length; k++) {
      const k1 = (k + 1) % a.length;
      const facing = new THREE.Vector3().subVectors(a[k1], a[k]).cross(n).multiplyScalar(sgn);
      tri(a[k], a[k1], b[k1], facing);
      tri(a[k], b[k1], b[k], facing);
    }
  };
  band(inner, outer, false);
  holesIn.forEach((h, i) => band(h, holesOut[i], true));
  return out;
}
