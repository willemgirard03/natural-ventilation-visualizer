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
