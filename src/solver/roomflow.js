// Air movement inside rooms, for the particle view: the building is divided into cubic cells, and in
// each zone the air takes the smoothest path (ideal, or potential, flow) from where the network says
// it enters to where it leaves. It keeps to the room: it cannot cross walls, turns corners and runs
// along surfaces. It has no buoyancy, turbulence or recirculation; the grid solver adds those
// (PLAN.md, Physics roadmap). The flows through each opening are the network solver's.

import { triangulate, unitNormal, dot, insidePolygon } from '../model/geometry.js';

// Cells of the building: each is in one zone (its index) or outside (-1).
// cell: edge length (m); maxCells: the cell grows if the building would need more.
export function voxelize(model, { cell = 0.5, maxCells = 200000 } = {}) {
  const zones = Object.keys(model.zones);
  const tris = zones.map((z) => model.zones[z].surfaces.flatMap((n) => {
    const v = model.surfaces[n].vertices;
    return triangulate(v).map((t) => t.map((i) => v[i]));
  }));
  const all = tris.flat(2);
  const min = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])));
  let h = cell;
  const count = (s) => [0, 1, 2].reduce((n, k) => n * Math.ceil((max[k] - min[k]) / s), 1);
  while (count(h) > maxCells) h *= 1.15;
  const [nx, ny, nz] = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / h)));
  const zone = new Int16Array(nx * ny * nz).fill(-1);
  const zoneBox = tris.map((ts) => {
    const pts = ts.flat();
    return [0, 1].map((k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))]);
  });
  // For each vertical column, the heights where it crosses each zone's surfaces; inside between pairs.
  const jitter = h * 1.234e-4;
  for (let i = 0; i < nx; i++) {
    const x = min[0] + (i + 0.5) * h + jitter;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + (j + 0.5) * h + jitter * 0.7;
      zones.forEach((_, zi) => {
        const bx = zoneBox[zi];
        if (x < bx[0][0] || x > bx[0][1] || y < bx[1][0] || y > bx[1][1]) return;
        const hits = [];
        for (const [a, b, c] of tris[zi]) {
          const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          if (Math.abs(d) < 1e-12) continue; // vertical triangle
          const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
          const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
          const w3 = 1 - w1 - w2;
          if (w1 < 0 || w2 < 0 || w3 < 0) continue;
          hits.push(w1 * a[2] + w2 * b[2] + w3 * c[2]);
        }
        hits.sort((p, q) => p - q);
        for (let k = 0; k + 1 < hits.length; k += 2) {
          const k0 = Math.max(0, Math.ceil((hits[k] - min[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((hits[k + 1] - min[2]) / h - 0.5));
          for (let kk = k0; kk <= k1; kk++) zone[i + nx * (j + ny * kk)] = zi;
        }
      });
    }
  }
  return { h, min, nx, ny, nz, zone, zones };
}

export const cellIndex = (g, i, j, k) => i + g.nx * (j + g.ny * k);
export const cellCentre = (g, c) => {
  const i = c % g.nx, j = Math.floor(c / g.nx) % g.ny, k = Math.floor(c / (g.nx * g.ny));
  return [g.min[0] + (i + 0.5) * g.h, g.min[1] + (j + 0.5) * g.h, g.min[2] + (k + 0.5) * g.h];
};
export function cellAt(g, p) {
  const i = Math.floor((p[0] - g.min[0]) / g.h), j = Math.floor((p[1] - g.min[1]) / g.h), k = Math.floor((p[2] - g.min[2]) / g.h);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return -1;
  return cellIndex(g, i, j, k);
}
// The six neighbours: -x, +x, -y, +y, -z, +z.
export const DIRS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
export function neighbour(g, c, d) {
  const i = c % g.nx, j = Math.floor(c / g.nx) % g.ny, k = Math.floor(c / (g.nx * g.ny));
  const [di, dj, dk] = DIRS[d];
  const a = i + di, b = j + dj, e = k + dk;
  if (a < 0 || b < 0 || e < 0 || a >= g.nx || b >= g.ny || e >= g.nz) return -1;
  return cellIndex(g, a, b, e);
}

const RHO = 1.2; // kg/m3, converting the network's mass flows to volume flows

// The cell faces each link covers, seen from one of its zones: boundary faces of that zone, facing the
// way the link's surface does, lying within about a cell of its plane and inside its outline.
function linkFaces(g, cellsOf, link, z, taken) {
  const n = unitNormal(link.vertices), p0 = link.vertices[0];
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  const ul = Math.hypot(...u); u.forEach((x, i) => { u[i] = x / ul; });
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const flat = (p) => { const d = p.map((x, i) => x - p0[i]); return [dot(d, u), dot(d, v)]; };
  const poly = link.vertices.map(flat);
  const lo = [0, 1, 2].map((k) => Math.min(...link.vertices.map((p) => p[k])) - g.h);
  const hi = [0, 1, 2].map((k) => Math.max(...link.vertices.map((p) => p[k])) + g.h);
  // Facing: out of zone z, so along the surface normal on its own zone's side, against it on the other.
  const sign = z === link.n ? 1 : -1;
  const faces = [], near = [];
  for (const c of cellsOf[z]) {
    const centre = cellCentre(g, c);
    if (centre.some((x, k) => x < lo[k] || x > hi[k])) continue;
    for (let d = 0; d < 6; d++) {
      if (dot(DIRS[d], n) * sign < 0.7) continue;
      const nb = neighbour(g, c, d);
      if (nb >= 0 && g.zone[nb] === z) continue;
      const key = c * 6 + d;
      if (taken.has(key)) continue;
      const f = centre.map((x, k) => x + (DIRS[d][k] * g.h) / 2);
      const off = Math.abs(dot(f.map((x, k) => x - p0[k]), n));
      if (off > 0.75 * g.h) continue;
      near.push({ key, c, d, z: f[2], dist: off });
      if (insidePolygon(flat(f), poly)) faces.push({ key, c, d, z: f[2] });
    }
  }
  if (faces.length) return faces;
  // An opening smaller than a cell, or off the grid: the nearest few aligned faces stand in for it.
  const want = Math.max(1, Math.round(link.area / g.h ** 2));
  const centre = [0, 1, 2].map((k) => link.vertices.reduce((s, p) => s + p[k], 0) / link.vertices.length);
  return near.map((f) => ({ ...f, r: Math.hypot(...cellCentre(g, f.c).map((x, k) => x - centre[k])) }))
    .sort((a, b) => a.r - b.r).slice(0, want);
}

// Everything that depends only on the cells and the network, not on the flows: each zone's cells and
// their connections, and the faces each link covers from each of its zones. Done once per model.
export function prepareRoomFlow(g, net) {
  const N = g.zone.length, Z = g.zones.length;
  const cellsOf = Array.from({ length: Z }, () => []);
  for (let c = 0; c < N; c++) if (g.zone[c] >= 0) cellsOf[g.zone[c]].push(c);
  // Openings claim faces before the cracks of their walls.
  const taken = new Set(), faces = net.links.map(() => ({}));
  const order = net.links.map((l, i) => i).sort((a, b) => (net.links[a].type === 'opening' ? 0 : 1) - (net.links[b].type === 'opening' ? 0 : 1));
  const zIndex = Object.fromEntries(g.zones.map((z, i) => [z, i]));
  for (const i of order) {
    const l = net.links[i];
    for (const zName of [l.from, l.to]) {
      if (zName === null || zName === undefined) continue;
      const z = zIndex[zName];
      const fs = linkFaces(g, cellsOf, { ...l, n: zIndex[l.from], area: Math.abs(l.width * l.height) || 1 }, z, taken);
      fs.forEach((f) => taken.add(f.key));
      faces[i][z] = fs;
    }
  }
  // Each zone's connections in compressed rows: neighbours of local cell i are adj[start[i] .. start[i+1]).
  const local = new Int32Array(N).fill(-1);
  const zonesCSR = cellsOf.map((cells) => {
    cells.forEach((c, i) => { local[c] = i; });
    const start = new Int32Array(cells.length + 1), adj = [];
    cells.forEach((c, i) => {
      for (let d = 0; d < 6; d++) { const nb = neighbour(g, c, d); if (nb >= 0 && g.zone[nb] === g.zone[c]) adj.push(local[nb]); }
      start[i + 1] = adj.length;
    });
    return { cells, start, adj: Int32Array.from(adj) };
  });
  return { g, net, cellsOf, faces, zonesCSR, zIndex };
}

// The flow field for one network solution (flowStreams output). Returns cell-centre velocities
// (m/s, 3 per cell), the volume flow out of the cell through each opening face (key = cell * 6 +
// direction, m3/s; negative: in), and the faces where outdoor air enters, for releasing particles.
// previous: an earlier result for the same model, whose potential starts the solve.
// open: { [opening name]: open fraction } as solved (conditions.open), so partly open openings narrow.
export function roomFlow(prep, flows, { previous = null, open = null, tolerance = 1e-4, maxIterations = 3000 } = {}) {
  const { g, net, faces, zonesCSR, zIndex } = prep;
  const N = g.zone.length;
  const out = new Map(), entries = [];
  for (const s of flows.streams) {
    const l = net.links[s.link], zmin = Math.min(...l.vertices.map((p) => p[2])), H = l.height || 1;
    for (const [zone, sign] of [[s.from, 1], [s.to, -1]]) {
      if (zone < 0) continue;
      const z = zIndex[net.zones[zone]], all = faces[s.link][z] || [];
      if (!all.length) continue;
      let fs = all.filter((f) => f.z >= zmin + s.band[0] * H - 1e-9 && f.z <= zmin + s.band[1] * H + 1e-9);
      if (!fs.length) fs = all;
      // A partly open window or door passes its air through that share of its width, centred, as
      // EnergyPlus narrows a simple opening: so the air keeps its speed and the stream narrows.
      const share = l.type === 'opening' ? open?.[l.name] ?? l.openFactor : 1;
      if (share > 0 && share < 1 && fs.length > 1) fs = middleShare(g, fs, share);
      const q = (sign * s.rate) / RHO / fs.length;
      for (const f of fs) {
        out.set(f.key, (out.get(f.key) || 0) + q);
        if (sign < 0 && s.from < 0) entries.push({ key: f.key, c: f.c, d: f.d, q: -q, stream: s });
      }
    }
  }
  // Ideal flow in each zone: potential phi with sum over neighbours (phi_c - phi_n) = -(outflow at c) / h.
  const h = g.h, phi = previous ? Float64Array.from(previous.phi) : new Float64Array(N), velocity = new Float32Array(N * 3);
  let iterations = 0;
  for (const zone of zonesCSR) {
    const n = zone.cells.length;
    if (!n) continue;
    const b = new Float64Array(n);
    zone.cells.forEach((c, i) => { for (let d = 0; d < 6; d++) b[i] -= (out.get(c * 6 + d) || 0) / h; });
    let mean = 0;
    for (let i = 0; i < n; i++) mean += b[i];
    mean /= n;
    for (let i = 0; i < n; i++) b[i] -= mean; // exact balance (the network's is to 1e-10)
    iterations += conjugateGradient(zone, b, phi, tolerance, maxIterations);
  }
  // Velocity at each face (m/s, along the axis), averaged to cell centres.
  for (let c = 0; c < N; c++) {
    if (g.zone[c] < 0) continue;
    for (let axis = 0; axis < 3; axis++) {
      let sum = 0;
      for (const d of [2 * axis, 2 * axis + 1]) {
        const sgn = DIRS[d][axis], nb = neighbour(g, c, d), key = c * 6 + d;
        if (out.has(key)) sum += (sgn * out.get(key)) / (h * h);
        else if (nb >= 0 && g.zone[nb] === g.zone[c]) sum += (sgn * (phi[c] - phi[nb])) / h;
      }
      velocity[c * 3 + axis] = sum / 2;
    }
  }
  return { velocity, out, entries, phi, iterations };
}

// The faces in the middle `share` of an opening's width: faces sorted along the opening's horizontal
// direction (along z for a horizontal one), keeping the central ones, at least one.
function middleShare(g, faces, share) {
  const centres = faces.map((f) => cellCentre(g, f.c));
  const spread = [0, 1, 2].map((k) => Math.max(...centres.map((c) => c[k])) - Math.min(...centres.map((c) => c[k])));
  const axis = spread[0] >= spread[1] ? 0 : 1; // the opening's width runs along x or y
  const span = spread[axis] > 1e-9 ? axis : 2;
  const lo = Math.min(...centres.map((c) => c[span])), hi = Math.max(...centres.map((c) => c[span]));
  const mid = (lo + hi) / 2, half = ((hi - lo + g.h) * share) / 2;
  const kept = faces.filter((f, i) => Math.abs(centres[i][span] - mid) <= half);
  if (kept.length) return kept;
  const nearest = faces.map((f, i) => [Math.abs(centres[i][span] - mid), f]).sort((a, b) => a[0] - b[0]);
  return [nearest[0][1]];
}

// Jacobi-preconditioned conjugate gradients on one zone's graph Laplacian (singular, consistent),
// starting from the potential already in phi.
function conjugateGradient({ cells, start, adj }, b, phi, tolerance, maxIterations) {
  const n = b.length;
  const x = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n), deg = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = phi[cells[i]]; deg[i] = start[i + 1] - start[i] || 1; }
  const apply = (v, outv) => {
    for (let i = 0; i < n; i++) {
      let s = (start[i + 1] - start[i]) * v[i];
      for (let k = start[i]; k < start[i + 1]; k++) s -= v[adj[k]];
      outv[i] = s;
    }
  };
  apply(x, Ap);
  let norm0 = 0, rr = 0, rz = 0;
  for (let i = 0; i < n; i++) { norm0 += b[i] * b[i]; r[i] = b[i] - Ap[i]; rr += r[i] * r[i]; }
  norm0 = Math.sqrt(norm0) || 1;
  for (let i = 0; i < n; i++) { z[i] = r[i] / deg[i]; p[i] = z[i]; rz += r[i] * z[i]; }
  let it = 0;
  for (; it < maxIterations && Math.sqrt(rr) > tolerance * norm0; it++) {
    apply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (pAp <= 0) break;
    const alpha = rz / pAp;
    let rzNew = 0;
    rr = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rr += r[i] * r[i]; z[i] = r[i] / deg[i]; rzNew += r[i] * z[i]; }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  for (let i = 0; i < n; i++) phi[cells[i]] = x[i];
  return it;
}
