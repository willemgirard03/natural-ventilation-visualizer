// Moves air parcels (the particle view's particles) through the room flow field of roomflow.js.
// Velocities are read from cell faces, as in a staggered (MAC) grid: each component is interpolated
// between the faces it crosses, and a wall face carries none. So parcels cannot push into walls; next
// to one they keep only their motion along it and glide. They pass to another zone, or outdoors,
// only through a face that air flows out by (an opening, or a leak in proportion to its flow).

import { cellAt, cellCentre, cellIndex, DIRS, neighbour } from './roomflow.js';

export const MAX_AGE = 900; // s; air lingering longer in a still corner is let go
const MIX_TIME = 60; // s; how quickly a parcel takes on its room's temperature
export const EXIT_TIME = 1.5; // s; how long a parcel is followed once it has left the building

export class Tracer {
  constructor(grid) { this.g = grid; }

  // A new field: roomFlow's result, each zone's temperature and the outdoor temperature (degC).
  setField(field, zoneT, outdoorT) {
    this.field = field;
    this.zoneT = zoneT;
    this.outdoorT = outdoorT;
    this.entryTotal = field.entries.reduce((s, e) => s + e.q, 0);
  }

  // Velocity (m/s) through face d of cell c, along the axis's positive direction, as seen from zone z.
  faceVelocity(c, d, z) {
    if (this.field.faceVelocityAt) return this.field.faceVelocityAt(c, d, z); // the grid solver's own faces
    const g = this.g, f = this.field, h = g.h, sgn = DIRS[d][(d / 2) | 0];
    if (c >= 0 && g.zone[c] === z) {
      const out = f.out.get(c * 6 + d);
      if (out !== undefined) return (sgn * out) / (h * h);
      const nb = neighbour(g, c, d);
      return nb >= 0 && g.zone[nb] === z ? (sgn * (f.phi[c] - f.phi[nb])) / h : 0;
    }
    const nb = c >= 0 ? neighbour(g, c, d) : -1;
    if (nb >= 0 && g.zone[nb] === z) { // the face seen from the other side
      const out = f.out.get(nb * 6 + (d ^ 1));
      return out !== undefined ? (-sgn * out) / (h * h) : 0;
    }
    return null; // not a face of this zone
  }

  // Air velocity at point p in zone z: each component interpolated over the faces normal to it.
  velocityAt(p, z) {
    const g = this.g, v = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3, c2 = (a + 2) % 3;
      const fa = (p[a] - g.min[a]) / g.h; // faces of axis a sit at whole numbers
      const fb = (p[b] - g.min[b]) / g.h - 0.5, fc = (p[c2] - g.min[c2]) / g.h - 0.5;
      const ia = Math.floor(fa), ib = Math.floor(fb), ic = Math.floor(fc);
      let sum = 0, wsum = 0;
      for (let da = 0; da < 2; da++) for (let db = 0; db < 2; db++) for (let dc = 0; dc < 2; dc++) {
        const idx = [0, 0, 0];
        idx[a] = ia + da; idx[b] = ib + db; idx[c2] = ic + dc;
        // The face at whole number idx[a] is the -a face of cell idx (or the +a face of the cell below).
        const below = [...idx]; below[a] -= 1;
        const inGrid = (q) => q[0] >= 0 && q[1] >= 0 && q[2] >= 0 && q[0] < g.nx && q[1] < g.ny && q[2] < g.nz;
        let val = null;
        if (inGrid(idx)) val = this.faceVelocity(cellIndex(g, ...idx), 2 * a, z);
        if (val === null && inGrid(below)) val = this.faceVelocity(cellIndex(g, ...below), 2 * a + 1, z);
        if (val === null) continue;
        const w = (da ? fa - ia : 1 - (fa - ia)) * (db ? fb - ib : 1 - (fb - ib)) * (dc ? fc - ic : 1 - (fc - ic));
        sum += w * val; wsum += w;
      }
      v[a] = wsum > 1e-9 ? sum / wsum : 0;
    }
    return v;
  }

  // A new parcel at an entry face, chosen in proportion to its flow, just inside the zone.
  release(random = Math.random) {
    const g = this.g, entries = this.field.entries;
    let r = random() * this.entryTotal, e = entries[entries.length - 1];
    for (const x of entries) { if ((r -= x.q) <= 0) { e = x; break; } }
    const c = cellCentre(g, e.c), axis = (e.d / 2) | 0, sgn = DIRS[e.d][axis];
    const p = c.map((x, k) => (k === axis ? x + sgn * g.h * 0.45 : x + (random() - 0.5) * g.h * 0.98));
    return { p, zone: g.zone[e.c], t: this.outdoorT, age: 0, out: null, v: [0, 0, 0] };
  }

  // Moves a parcel dt seconds (real time). Returns false once it has gone.
  step(q, dt) {
    q.age += dt;
    if (q.out) { // left the building: followed briefly along its exit velocity
      q.out.left -= dt;
      for (let k = 0; k < 3; k++) q.p[k] += q.v[k] * dt;
      return q.out.left > 0;
    }
    if (q.age > MAX_AGE) return false;
    const g = this.g;
    let v = this.velocityAt(q.p, q.zone);
    const n = Math.min(10, Math.max(1, Math.ceil((Math.hypot(...v) * dt) / (0.3 * g.h))));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      if (s) v = this.velocityAt(q.p, q.zone);
      const mid = q.p.map((x, k) => x + (v[k] * h) / 2);
      const v2 = this.velocityAt(mid, q.zone);
      const next = q.p.map((x, k) => x + v2[k] * h);
      q.v = v2;
      const c0 = cellAt(g, q.p), c1 = cellAt(g, next);
      if (c1 >= 0 && g.zone[c1] === q.zone) { q.p = next; continue; }
      if (this.cross(q, c0, next, v2)) { if (q.out) return true; continue; }
      // Blocked (a wall, or a corner between two walls): keep whatever part of the move stays inside.
      for (let a = 0; a < 3; a++) {
        const tryP = [...q.p];
        tryP[a] = next[a];
        const ct = cellAt(g, tryP);
        if (ct >= 0 && g.zone[ct] === q.zone) q.p = tryP;
      }
    }
    // The grid solver has a temperature field; otherwise parcels take on their room's over MIX_TIME.
    if (this.field.temperatureAt) q.t = this.field.temperatureAt(q.p[0], q.p[1], q.p[2]);
    else q.t += (this.zoneT[q.zone] - q.t) * (1 - Math.exp(-dt / MIX_TIME));
    return true;
  }

  // Tries to take a parcel out of its zone's cell c0 to `next`, through the face it crosses first.
  // Possible only where air flows out of the zone; true if it went (to another zone, or outdoors).
  cross(q, c0, next, v) {
    if (c0 < 0) return false;
    const g = this.g, d = this.crossing(q.p, next);
    // Through an open face of the grid solver (an open door) into the next zone.
    if (this.field.isOpenFace?.(c0, d)) {
      const nb = neighbour(g, c0, d);
      if (nb >= 0 && g.zone[nb] >= 0) { q.zone = g.zone[nb]; q.p = next; return true; }
    }
    const flowOut = this.field.out.get(c0 * 6 + d) || 0;
    if (flowOut <= 0) return false;
    const nb = neighbour(g, c0, d);
    if (nb >= 0 && g.zone[nb] >= 0 && g.zone[nb] !== q.zone) {
      q.zone = g.zone[nb];
      q.p = next;
      if (cellAt(g, q.p) !== nb) q.p = cellCentre(g, nb).map((x, k) => (k === ((d / 2) | 0) ? x - DIRS[d][k] * g.h * 0.45 : q.p[k]));
      return true;
    }
    // Outdoors: carried away at the opening's speed at least, then let go.
    const axis = (d / 2) | 0, normal = (DIRS[d][axis] * flowOut) / (g.h * g.h);
    q.v = v.map((x, k) => (k === axis ? (Math.abs(x) > Math.abs(normal) ? x : normal) : x));
    q.p = next;
    q.out = { left: EXIT_TIME };
    return true;
  }

  // The face a move from a to b leaves a's cell by: the axis it crosses first.
  crossing(a, b) {
    const g = this.g;
    let best = 0, bestT = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const d = b[axis] - a[axis];
      if (Math.abs(d) < 1e-12) continue;
      const lo = Math.floor((a[axis] - g.min[axis]) / g.h) * g.h + g.min[axis];
      const t = ((d > 0 ? lo + g.h : lo) - a[axis]) / d;
      if (t < bestT) { bestT = t; best = 2 * axis + (d > 0 ? 1 : 0); }
    }
    return best;
  }
}
