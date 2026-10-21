// The grid solver: air movement inside the building on the cells of roomflow.js, by fast fluid
// dynamics (Zuo and Chen), as in the 2D prototype: each step carries velocity and temperature along
// with the air (semi-Lagrangian), adds buoyancy (Boussinesq) and the heat of people, equipment and
// lights, then corrects pressure so no air piles up or vanishes. Velocities sit on cell faces
// (a staggered grid). Windows and leaks to outdoors bring in and take out the network's flows; open
// doors are openings in the grid, so flow between rooms, two-way exchange included, comes out of the
// solution. Each zone's mean temperature is held near its known value (results, or the indoor
// setting), so the solver adds the pattern within the room, not a different heat balance.

import { DIRS, neighbour, cellCentre, boundaryFluxes } from './roomflow.js';
import { hourlyValues } from '../model/schedules.js';

const G = 9.81, RHO = 1.2, CP = 1006; // m/s2, kg/m3, J/kg.K
const WALL = 0, OPEN = 1, SET = 2; // face kinds: no flow, solved, set by an opening's flow
export const HOLD_TIME = 30; // s; how quickly a zone's mean temperature is drawn to its known value

export class GridFlow {
  // prep: prepareRoomFlow(voxelize(model), net)
  constructor(prep, model) {
    this.prep = prep;
    this.model = model;
    const g = this.g = prep.g, N = g.zone.length;
    this.U = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; // through each cell's +x, +y, +z face
    this.T = new Float32Array(N);
    this.p = new Float64Array(N);
    this.kind = new Uint8Array(N * 6);
    this.setVel = new Float32Array(N * 6); // along the axis, for SET faces
    this.fluid = [];
    for (let c = 0; c < N; c++) if (g.zone[c] >= 0) this.fluid.push(c);
    this.fluid = Int32Array.from(this.fluid);
    this.zoneBottom = g.zones.map((z) => model.zones[z].bottom);
    this.time = 0;
    // Pressure solve tolerance: 1e-3 of the imbalance gives the same flow as 1e-5 on Example_02 (mean
    // and top speeds, door flows within 0.5%) at a third of the time.
    this.projectTolerance = 1e-3;
    // Precomputed: each face's neighbouring cell, each cell's centre, a snapshot of face velocities.
    this.nbr = new Int32Array(N * 6).fill(-1);
    this.cx = new Float32Array(N); this.cy = new Float32Array(N); this.cz = new Float32Array(N);
    for (const c of this.fluid) {
      for (let d = 0; d < 6; d++) this.nbr[c * 6 + d] = neighbour(g, c, d);
      [this.cx[c], this.cy[c], this.cz[c]] = cellCentre(g, c);
    }
    this.FV = new Float32Array(N * 6);
    this.ghostT = new Float32Array(N).fill(NaN);
  }

  // New conditions: the network's streams and conditions (with .open), the hour index for internal
  // gains, and each zone's known temperature (degC). Keeps the current flow as the starting point.
  setConditions(flows, conditions, { hour = 4800, open = conditions.open } = {}) {
    const { g, prep } = this, N = g.zone.length, h = g.h;
    this.outdoorT = conditions.outdoor.t;
    this.targetT = g.zones.map((z) => conditions.zones[z].t);
    if (!this.started) { for (const c of this.fluid) this.T[c] = this.targetT[g.zone[c]]; this.started = true; }
    // Openings to outdoors (and leaks) set the flow; doors between zones are solved; leaks between zones are left out.
    const skip = (l) => l.door || (l.type === 'crack' && l.to !== null);
    const { out, entries } = boundaryFluxes(prep, flows, { open, skip });
    this.out = out;
    this.entries = entries;
    const doorOpen = new Set();
    prep.net.links.forEach((l, i) => {
      if (!l.door || !((open?.[l.name] ?? l.openFactor) > 0)) return;
      for (const fs of Object.values(prep.faces[i])) for (const f of fs) {
        doorOpen.add(f.key);
        const nb = neighbour(g, f.c, f.d);
        if (nb >= 0) doorOpen.add(nb * 6 + (f.d ^ 1));
      }
    });
    this.kind.fill(WALL);
    this.setVel.fill(0);
    for (const c of this.fluid) {
      for (let d = 0; d < 6; d++) {
        const key = c * 6 + d, sgn = DIRS[d][(d / 2) | 0];
        if (out.has(key)) { this.kind[key] = SET; this.setVel[key] = (sgn * out.get(key)) / (h * h); continue; }
        const nb = neighbour(g, c, d);
        if (nb >= 0 && g.zone[nb] >= 0 && (g.zone[nb] === g.zone[c] || doorOpen.has(key))) this.kind[key] = OPEN;
      }
    }
    this.connect();
    this.gains(hour);
  }

  // Regions of cells joined by open faces (rooms joined by open doors); each region's set flows are
  // balanced exactly (the network balances zones, but leaks between zones are left out here), and the
  // cells' connections for the pressure solve are listed.
  connect() {
    const { g } = this, N = g.zone.length, h = g.h;
    const region = new Int32Array(N).fill(-1);
    let regions = 0;
    for (const c0 of this.fluid) {
      if (region[c0] >= 0) continue;
      const stack = [c0];
      region[c0] = regions;
      while (stack.length) {
        const c = stack.pop();
        for (let d = 0; d < 6; d++) {
          if (this.kind[c * 6 + d] !== OPEN) continue;
          const nb = neighbour(g, c, d);
          if (region[nb] < 0) { region[nb] = regions; stack.push(nb); }
        }
      }
      regions++;
    }
    this.region = region;
    this.regions = regions;
    // Balance: scale each region's outflows to its inflows.
    const inflow = new Float64Array(regions), outflow = new Float64Array(regions);
    for (const [key, q] of this.out) {
      const r = region[(key / 6) | 0];
      if (r < 0) continue;
      if (q > 0) outflow[r] += q; else inflow[r] -= q;
    }
    for (const [key, q] of this.out) {
      const c = (key / 6) | 0, r = region[c];
      if (r < 0 || !(q > 0)) continue;
      const k = outflow[r] > 0 ? inflow[r] / outflow[r] : 0;
      const sgn = DIRS[key % 6][((key % 6) / 2) | 0];
      this.setVel[key] = (sgn * q * k) / (h * h);
    }
    // Connections over open faces, for the pressure solve.
    const local = new Int32Array(N).fill(-1);
    this.fluid.forEach((c, i) => { local[c] = i; });
    const start = new Int32Array(this.fluid.length + 1), adj = [];
    this.fluid.forEach((c, i) => {
      for (let d = 0; d < 6; d++) if (this.kind[c * 6 + d] === OPEN) adj.push(local[neighbour(g, c, d)]);
      start[i + 1] = adj.length;
    });
    this.csr = { start, adj: Int32Array.from(adj), local };
    // No flow through faces that are not open.
    for (const c of this.fluid) for (let a = 0; a < 3; a++) if (this.kind[c * 6 + 2 * a + 1] !== OPEN) this.U[a][c] = 0;
    // Outdoor air comes in at the outdoor temperature: the cells beyond inflow faces hold it.
    this.ghostT.fill(NaN);
    for (const [key, q] of this.out) if (q < 0) {
      const nb = neighbour(g, (key / 6) | 0, key % 6);
      if (nb >= 0 && g.zone[nb] < 0) this.ghostT[nb] = this.outdoorT;
    }
  }

  // Heat from people, equipment and lights at an hour, by zone: people and equipment spread through the
  // occupied height (0.1 to 1.8 m above the floor), lights in the top layer of cells. Taken as all
  // sensible and convective, an upper bound on the plumes they drive.
  gains(hour) {
    const { g, model } = this;
    const sched = (name) => (name ? hourlyValues(model.epjson, name)?.[hour] ?? 1 : 1);
    this.sources = g.zones.map((zName, zi) => {
      const z = model.zones[zName], area = z.floorArea.value;
      const people = z.people ? z.people.density.value * area * (z.people.activityLevel?.value ?? 120) * sched(z.people.schedule) : 0;
      const equipment = z.equipment?.powerDensity ? z.equipment.powerDensity.value * area * sched(z.equipment.schedule) : 0;
      const lights = z.lights?.powerDensity ? z.lights.powerDensity.value * area * sched(z.lights.schedule) : 0;
      const cells = [...this.fluid].filter((c) => g.zone[c] === zi);
      const heightOf = (c) => cellCentre(g, c)[2] - this.zoneBottom[zi];
      const top = Math.max(...cells.map(heightOf));
      const occupied = cells.filter((c) => heightOf(c) >= 0.1 && heightOf(c) <= 1.8);
      const ceiling = cells.filter((c) => heightOf(c) > top - g.h / 2);
      return { occupied: Int32Array.from(occupied.length ? occupied : cells), ceiling: Int32Array.from(ceiling), lower: people + equipment, upper: lights, cells: Int32Array.from(cells) };
    });
  }

  // Velocity (m/s, along the axis) through face d of fluid cell c.
  faceVal(c, d) {
    const key = c * 6 + d, k = this.kind[key];
    if (k === SET) return this.setVel[key];
    if (k !== OPEN) return 0;
    return d & 1 ? this.U[d >> 1][c] : this.U[d >> 1][this.nbr[key]];
  }

  // A copy of every fluid cell's six face velocities, read by the interpolation during a step.
  snapshot() {
    const F = this.FV;
    for (const c of this.fluid) for (let d = 0; d < 6; d++) F[c * 6 + d] = this.faceVal(c, d);
  }

  // One velocity component at (x, y, z), interpolated over the faces normal to it: faces of axis a sit
  // at whole cell positions along a and at cell centres across it. Faces with no air on either side
  // are left out.
  component(a, x, y, z) {
    const g = this.g, h = g.h, Z = g.zone, F = this.FV, nx = g.nx, ny = g.ny, nz = g.nz;
    const fx = (x - g.min[0]) / h - (a === 0 ? 0 : 0.5);
    const fy = (y - g.min[1]) / h - (a === 1 ? 0 : 0.5);
    const fz = (z - g.min[2]) / h - (a === 2 ? 0 : 0.5);
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    const stride = a === 0 ? 1 : a === 1 ? nx : nx * ny, na = a === 0 ? nx : a === 1 ? ny : nz;
    const below = 2 * a, above = 2 * a + 1;
    let sum = 0, wsum = 0;
    for (let dk = 0; dk < 2; dk++) {
      const k = k0 + dk, wz = dk ? tz : 1 - tz;
      if (a !== 2 && (k < 0 || k >= nz)) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj, wy = dj ? ty : 1 - ty;
        if (a !== 1 && (j < 0 || j >= ny)) continue;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di, w = (di ? tx : 1 - tx) * wy * wz;
          if (w === 0 || (a !== 0 && (i < 0 || i >= nx))) continue;
          const ia = a === 0 ? i : a === 1 ? j : k, c = i + nx * (j + ny * k);
          if (ia >= 0 && ia < na && Z[c] >= 0) { sum += w * F[c * 6 + below]; wsum += w; continue; }
          if (ia - 1 >= 0 && ia - 1 < na && Z[c - stride] >= 0) { sum += w * F[(c - stride) * 6 + above]; wsum += w; }
        }
      }
    }
    return wsum > 1e-9 ? sum / wsum : 0;
  }

  velocityAt(p) { return [this.component(0, p[0], p[1], p[2]), this.component(1, p[0], p[1], p[2]), this.component(2, p[0], p[1], p[2])]; }

  // Temperature at (x, y, z): trilinear over fluid cell centres and the outdoor air beyond inflows.
  temperatureAt(x, y, z) {
    if (Array.isArray(x)) [x, y, z] = x;
    const g = this.g, Z = g.zone, T = this.T, ghost = this.ghostT;
    const fx = (x - g.min[0]) / g.h - 0.5, fy = (y - g.min[1]) / g.h - 0.5, fz = (z - g.min[2]) / g.h - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    let sum = 0, wsum = 0;
    for (let dk = 0; dk < 2; dk++) {
      const k = k0 + dk;
      if (k < 0 || k >= g.nz) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= g.ny) continue;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di;
          if (i < 0 || i >= g.nx) continue;
          const c = i + g.nx * (j + g.ny * k);
          const t = Z[c] >= 0 ? T[c] : ghost[c];
          if (Number.isNaN(t)) continue;
          const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
          sum += w * t; wsum += w;
        }
      }
    }
    return wsum > 1e-9 ? sum / wsum : this.outdoorT;
  }

  // Where air at (x, y, z) came from dt seconds ago, written into out: one step back along the local
  // velocity, enough while a step moves air less than a cell (stableDt), as fast fluid dynamics does.
  back(x, y, z, dt, out) {
    out[0] = x - this.component(0, x, y, z) * dt;
    out[1] = y - this.component(1, x, y, z) * dt;
    out[2] = z - this.component(2, x, y, z) * dt;
    return out;
  }

  // A time step fit for the current flow: air moves at most about one cell.
  stableDt() {
    let top = 0.05;
    for (let a = 0; a < 3; a++) for (const c of this.fluid) top = Math.max(top, Math.abs(this.U[a][c]));
    for (const v of this.setVel) top = Math.max(top, Math.abs(v));
    return Math.min(1, (0.9 * this.g.h) / top);
  }

  // Advances the flow by dt seconds.
  step(dt = this.stableDt()) {
    const { g } = this, h = g.h;
    // 1. Carry velocity and temperature along with the air.
    this.snapshot();
    const U2 = this.U.map((u) => Float32Array.from(u)), T2 = Float32Array.from(this.T), b = new Float64Array(3);
    for (const c of this.fluid) {
      const cx = this.cx[c], cy = this.cy[c], cz = this.cz[c];
      for (let a = 0; a < 3; a++) {
        if (this.kind[c * 6 + 2 * a + 1] !== OPEN) continue;
        this.back(cx + (a === 0 ? h / 2 : 0), cy + (a === 1 ? h / 2 : 0), cz + (a === 2 ? h / 2 : 0), dt, b);
        U2[a][c] = this.component(a, b[0], b[1], b[2]);
      }
      this.back(cx, cy, cz, dt, b);
      T2[c] = this.temperatureAt(b[0], b[1], b[2]);
    }
    this.U = U2;
    this.T = T2;
    // 2. Heat from people, equipment and lights.
    this.sources.forEach((s) => {
      const add = (cells, watts) => { if (cells.length && watts) { const dT = (watts * dt) / (RHO * CP * h ** 3 * cells.length); for (const c of cells) this.T[c] += dT; } };
      add(s.occupied, s.lower);
      add(s.ceiling, s.upper);
    });
    // 3. Each zone's mean temperature drawn to its known value; the pattern within it kept.
    const pull = 1 - Math.exp(-dt / HOLD_TIME);
    this.sources.forEach((s, zi) => {
      if (!s.cells.length) return;
      let mean = 0;
      for (const c of s.cells) mean += this.T[c];
      const shift = (this.targetT[zi] - mean / s.cells.length) * pull;
      for (const c of s.cells) this.T[c] += shift;
    });
    // 4. Buoyancy on vertical faces, against each region's mean temperature.
    const sum = new Float64Array(this.regions), count = new Float64Array(this.regions);
    for (const c of this.fluid) { sum[this.region[c]] += this.T[c]; count[this.region[c]]++; }
    const ref = Array.from(sum, (x, r) => x / count[r]);
    for (const c of this.fluid) {
      if (this.kind[c * 6 + 5] !== OPEN) continue;
      const up = this.nbr[c * 6 + 5], tr = ref[this.region[c]];
      this.U[2][c] += (dt * G * (0.5 * (this.T[c] + this.T[up]) - tr)) / (tr + 273.15);
    }
    // 5. Pressure: remove what would pile up or vanish.
    this.project({ tolerance: this.projectTolerance });
    this.snapshot();
    this.time += dt;
    return dt;
  }

  // Pressure correction: solve sum over open faces (p_c - p_n) = -(net outflow of c) / h, then add
  // (p_c - p_n) / h to each open face, which leaves every cell balanced. Starts from the last pressure.
  project({ tolerance = 1e-5, maxIterations = 400 } = {}) {
    const { g } = this, h = g.h, h2 = h * h, cells = this.fluid, n = cells.length;
    const { start, adj } = this.csr;
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      let div = 0;
      for (let a = 0; a < 3; a++) div += (this.faceVal(c, 2 * a + 1) - this.faceVal(c, 2 * a)) * h2;
      b[i] = -div / h;
    }
    // Each region's right-hand side sums to zero (balanced flows); remove rounding.
    const rs = new Float64Array(this.regions), rc = new Float64Array(this.regions);
    for (let i = 0; i < n; i++) { rs[this.region[cells[i]]] += b[i]; rc[this.region[cells[i]]]++; }
    for (let i = 0; i < n; i++) b[i] -= rs[this.region[cells[i]]] / rc[this.region[cells[i]]];
    const x = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), q = new Float64Array(n), Aq = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = this.p[cells[i]];
    const apply = (v, out) => {
      for (let i = 0; i < n; i++) {
        let s2 = (start[i + 1] - start[i]) * v[i];
        for (let k = start[i]; k < start[i + 1]; k++) s2 -= v[adj[k]];
        out[i] = s2;
      }
    };
    apply(x, Aq);
    let bb = 0, rr = 0, rz = 0;
    for (let i = 0; i < n; i++) { bb += b[i] * b[i]; r[i] = b[i] - Aq[i]; rr += r[i] * r[i]; }
    const stop = tolerance * Math.sqrt(bb || 1);
    for (let i = 0; i < n; i++) { z[i] = r[i] / (start[i + 1] - start[i] || 1); q[i] = z[i]; rz += r[i] * z[i]; }
    let it = 0;
    for (; it < maxIterations && Math.sqrt(rr) > stop; it++) {
      apply(q, Aq);
      let qAq = 0;
      for (let i = 0; i < n; i++) qAq += q[i] * Aq[i];
      if (qAq <= 0) break;
      const alpha = rz / qAq;
      let rzNew = 0;
      rr = 0;
      for (let i = 0; i < n; i++) { x[i] += alpha * q[i]; r[i] -= alpha * Aq[i]; rr += r[i] * r[i]; z[i] = r[i] / (start[i + 1] - start[i] || 1); rzNew += r[i] * z[i]; }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) q[i] = z[i] + beta * q[i];
    }
    for (let i = 0; i < n; i++) this.p[cells[i]] = x[i];
    for (const c of cells) for (let a = 0; a < 3; a++) {
      if (this.kind[c * 6 + 2 * a + 1] !== OPEN) continue;
      this.U[a][c] += (this.p[c] - this.p[this.nbr[c * 6 + 2 * a + 1]]) / h;
    }
    this.iterations = it;
    return it;
  }

  // Net outflow of a cell (m3/s): zero after a projection, for checking.
  divergence(c) {
    let div = 0;
    for (let a = 0; a < 3; a++) div += (this.faceVal(c, 2 * a + 1) - this.faceVal(c, 2 * a)) * this.g.h ** 2;
    return div;
  }

  // For the particle tracer (tracer.js): the velocity through face d of cell c along its axis (null
  // when neither side is air), and whether air may cross the face. Walls between zones carry no flow,
  // so the zone a particle is in does not matter here.
  faceVelocityAt(c, d) {
    const g = this.g;
    if (c >= 0 && g.zone[c] >= 0) return this.faceVal(c, d);
    const nb = c >= 0 ? neighbour(g, c, d) : -1;
    if (nb >= 0 && g.zone[nb] >= 0) return this.faceVal(nb, d ^ 1);
    return null;
  }
  isOpenFace(c, d) { return this.kind[c * 6 + d] === OPEN; }

  // Cell-centre velocities (m/s, three per cell), for colouring and checks.
  get velocity() {
    const v = new Float32Array(this.g.zone.length * 3);
    for (const c of this.fluid) for (let a = 0; a < 3; a++) v[c * 3 + a] = (this.faceVal(c, 2 * a) + this.faceVal(c, 2 * a + 1)) / 2;
    return v;
  }
}
