// Particles carried by the air: released wherever outdoor air comes in (in proportion to its flow),
// moved through each room by the room flow field (src/solver/roomflow.js), stopped by walls, passed
// to the next zone only through openings air flows out by, and let go outdoors as a short jet.
// Inside rooms the field is ideal flow: it shows where air goes, not buoyant plumes or eddies.

import * as THREE from 'three';
import { cellAt, cellCentre, DIRS, neighbour } from '../src/solver/roomflow.js';

const CAPACITY = 20000;
const TARGET = 6000; // particles in view under the first conditions shown, at density x1
const MAX_AGE = 900; // s; air that lingers longer in a still corner is let go
const MIX_TIME = 60; // s; how quickly a particle's colour takes on its room's temperature
const RHO = 1.2;

// Blue (cool) through pale grey to red (warm), centred on 22 degC; saturated enough to read
// against the model's light surfaces.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#E4E9EE'), WARM = new THREE.Color('#E0401F');
const TRAIL = 6; // s of real time each particle's trail covers
const HISTORY = 8; // positions kept per particle for its trail
export function temperatureColor(t, out = new THREE.Color()) {
  const x = Math.max(-1, Math.min(1, (t - 22) / 8));
  return x < 0 ? out.copy(MID).lerp(COOL, -x) : out.copy(MID).lerp(WARM, x);
}

// Air speed on a log scale from 0.01 to 2 m/s: pale (still) through yellow and orange to deep red.
const SPEED_STOPS = ['#DCE3EA', '#F2C14E', '#E0701F', '#B3261E', '#5E1235'].map((c) => new THREE.Color(c));
export const SPEED_RANGE = [0.01, 2];
export function speedColor(v, out = new THREE.Color()) {
  const x = Math.max(0, Math.min(1, Math.log(Math.max(v, SPEED_RANGE[0]) / SPEED_RANGE[0]) / Math.log(SPEED_RANGE[1] / SPEED_RANGE[0])));
  const f = x * (SPEED_STOPS.length - 1), i = Math.min(SPEED_STOPS.length - 2, Math.floor(f));
  return out.copy(SPEED_STOPS[i]).lerp(SPEED_STOPS[i + 1], f - i);
}

export class AirflowParticles {
  constructor(view) {
    this.view = view;
    this.positions = new Float32Array(CAPACITY * 3);
    this.colors = new Float32Array(CAPACITY * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.24, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, clippingPlanes: view.clipping,
    }));
    this.points.renderOrder = 3;
    this.points.frustumCulled = false;
    view.scene.add(this.points);
    // A streak behind each particle, along its velocity: direction and speed at a glance.
    // A trail behind each particle through its last positions: the path it took, bends included.
    this.trail = new Float32Array(CAPACITY * HISTORY * 6);
    this.trailColors = new Float32Array(CAPACITY * HISTORY * 6);
    const t = new THREE.BufferGeometry();
    t.setAttribute('position', new THREE.BufferAttribute(this.trail, 3));
    t.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    t.setDrawRange(0, 0);
    this.streaks = new THREE.LineSegments(t, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, clippingPlanes: view.clipping }));
    this.streaks.renderOrder = 3;
    this.streaks.frustumCulled = false;
    view.scene.add(this.streaks);
    this.live = [];
    this.speed = 5; // display time runs this many times faster than real time
    this.densityScale = 1; // the Particles slider
    this.colorBy = 'temperature'; // or 'speed'
    this.density = null; // particles released per kg of outdoor air; fixed per model
    this.spawnDebt = 0;
    this.field = null;
  }

  // The cells (voxelize) and the model's total volume, for a new model.
  setGrid(grid, volume) {
    this.grid = grid;
    this.volume = volume;
    this.live = [];
    this.field = null;
    this.density = null;
  }

  // A new flow field (roomFlow) with the network flows and conditions it came from.
  setField(field, flows, conditions) {
    this.field = field;
    this.flows = flows;
    this.zoneT = this.grid.zones.map((z) => conditions.zones[z].t);
    this.outdoorT = conditions.outdoor.t;
    this.entryTotal = field.entries.reduce((s, e) => s + e.q, 0);
    if (!(this.entryTotal > 0)) return;
    // Air spends about volume / flow in the building; release enough for TARGET particles at x1.
    const stay = Math.min(MAX_AGE, this.volume / this.entryTotal);
    if (this.density === null) this.density = TARGET / (this.entryTotal * RHO * stay);
    if (!this.live.length) this.prefill(stay);
  }

  // Starts with air already on its way through the building, rather than one packet at the windows.
  prefill(stay) {
    const n = Math.min(CAPACITY, Math.round(this.density * this.densityScale * this.entryTotal * RHO * stay));
    for (let k = 0; k < n; k++) {
      const q = this.release();
      const t = Math.random() * stay, steps = Math.min(60, Math.ceil(t / 2));
      let alive = true;
      for (let s = 0; s < steps && alive; s++) alive = this.step(q, t / steps);
      if (alive) this.live.push(q);
    }
  }

  // A new particle at an entry face, chosen in proportion to its flow.
  release() {
    const g = this.grid, entries = this.field.entries;
    let r = Math.random() * this.entryTotal, e = entries[entries.length - 1];
    for (const x of entries) { if ((r -= x.q) <= 0) { e = x; break; } }
    const c = cellCentre(g, e.c), axis = DIRS[e.d].findIndex((x) => x !== 0), sgn = DIRS[e.d][axis];
    const p = c.map((x, k) => (k === axis ? x + sgn * g.h * 0.48 : x + (Math.random() - 0.5) * g.h));
    return { p, zone: g.zone[e.c], t: this.outdoorT, age: 0, out: null, v: [0, 0, 0], hist: [], since: 0 };
  }

  // Air velocity at a point in a zone: trilinear between the cell centres of that zone around it.
  velocityAt(p, zone) {
    const g = this.grid, v = this.field.velocity;
    const fx = (p[0] - g.min[0]) / g.h - 0.5, fy = (p[1] - g.min[1]) / g.h - 0.5, fz = (p[2] - g.min[2]) / g.h - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    const out = [0, 0, 0];
    let wsum = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const i = i0 + a, j = j0 + b, k = k0 + c;
      if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) continue;
      const cell = i + g.nx * (j + g.ny * k);
      if (g.zone[cell] !== zone) continue;
      const w = (a ? fx - i0 : 1 - (fx - i0)) * (b ? fy - j0 : 1 - (fy - j0)) * (c ? fz - k0 : 1 - (fz - k0));
      out[0] += w * v[3 * cell]; out[1] += w * v[3 * cell + 1]; out[2] += w * v[3 * cell + 2];
      wsum += w;
    }
    return wsum > 1e-9 ? out.map((x) => x / wsum) : out;
  }

  // Moves a particle dt seconds (real time); false once it has gone.
  step(q, dt) {
    q.age += dt;
    if (q.out) { // leaving the building: a short straight jet
      q.out.life -= dt;
      for (let k = 0; k < 3; k++) q.p[k] += q.out.v[k] * dt;
      q.v = q.out.v;
      return q.out.life > 0;
    }
    if (q.age > MAX_AGE) return false;
    const g = this.grid;
    const v0 = this.velocityAt(q.p, q.zone);
    const speed = Math.hypot(...v0);
    const n = Math.min(8, Math.max(1, Math.ceil((speed * dt) / (0.4 * g.h))));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      const v1 = s ? this.velocityAt(q.p, q.zone) : v0;
      const mid = q.p.map((x, k) => x + (v1[k] * h) / 2);
      const v2 = this.velocityAt(mid, q.zone);
      const next = q.p.map((x, k) => x + v2[k] * h);
      q.v = v2;
      const c0 = cellAt(g, q.p), c1 = cellAt(g, next);
      if (c1 >= 0 && g.zone[c1] === q.zone) { q.p = next; continue; }
      // Leaving the zone's cells: through an opening face air flows out by, or not at all (a wall).
      const d = this.crossing(q.p, next);
      const flowOut = c0 >= 0 ? this.field.out.get(c0 * 6 + d) || 0 : 0;
      if (flowOut > 0) {
        const nb = neighbour(g, c0, d);
        if (nb >= 0 && g.zone[nb] >= 0 && g.zone[nb] !== q.zone) { q.zone = g.zone[nb]; q.p = next; continue; }
        const vOut = DIRS[d].map((x) => (x * flowOut) / (g.h * g.h));
        q.out = { v: vOut.map((x, k) => x + v2[k] * 0.3), life: Math.min(4, 1.2 / Math.max(0.05, Math.hypot(...vOut))) };
        return true;
      }
      // A wall: keep the movement along it, drop the movement into it.
      const axis = DIRS[d].findIndex((x) => x !== 0);
      const slide = next.map((x, k) => (k === axis ? q.p[k] : x));
      const c2 = cellAt(g, slide);
      if (c2 >= 0 && g.zone[c2] === q.zone) q.p = slide;
    }
    const tz = this.zoneT[q.zone];
    q.t += (tz - q.t) * (1 - Math.exp(-dt / MIX_TIME));
    return true;
  }

  // The face a move from a to b leaves a's cell by: the axis it crosses first.
  crossing(a, b) {
    const g = this.grid;
    let best = 0, bestT = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const da = b[axis] - a[axis];
      if (Math.abs(da) < 1e-12) continue;
      const cellLo = Math.floor((a[axis] - g.min[axis]) / g.h) * g.h + g.min[axis];
      const edge = da > 0 ? cellLo + g.h : cellLo;
      const t = (edge - a[axis]) / da;
      if (t < bestT) { bestT = t; best = 2 * axis + (da > 0 ? 1 : 0); }
    }
    return best;
  }

  // Advances the particles by dt seconds of display time.
  tick(dt) {
    if (!this.field || !(this.entryTotal > 0)) return;
    const sim = Math.min(dt, 0.1) * this.speed;
    this.spawnDebt += this.density * this.densityScale * this.entryTotal * RHO * sim;
    for (; this.spawnDebt >= 1; this.spawnDebt--) if (this.live.length < CAPACITY) this.live.push(this.release());
    const o = this.view.origin, col = new THREE.Color(), every = TRAIL / (HISTORY - 1);
    let n = 0, segs = 0;
    for (const q of this.live) {
      if (!this.step(q, sim)) continue;
      // Remember a position every so often; the newest first.
      q.since += sim;
      if (q.since >= every || !q.hist.length) {
        q.since = 0;
        q.hist.unshift([...q.p]);
        if (q.hist.length > HISTORY) q.hist.length = HISTORY;
      }
      if (this.colorBy === 'speed') speedColor(Math.hypot(...q.v), col); else temperatureColor(q.t, col);
      for (let i = 0; i < 3; i++) this.positions[n * 3 + i] = q.p[i] - o[i];
      this.colors[n * 3] = col.r; this.colors[n * 3 + 1] = col.g; this.colors[n * 3 + 2] = col.b;
      // Trail: head to newest remembered position, then back through the rest, fading.
      let a = q.p;
      for (let j = 0; j < q.hist.length; j++) {
        const b = q.hist[j], f0 = 1 - (0.75 * j) / HISTORY, f1 = 1 - (0.75 * (j + 1)) / HISTORY, at = segs * 6;
        for (let i = 0; i < 3; i++) { this.trail[at + i] = a[i] - o[i]; this.trail[at + 3 + i] = b[i] - o[i]; }
        this.trailColors[at] = col.r * f0; this.trailColors[at + 1] = col.g * f0; this.trailColors[at + 2] = col.b * f0;
        this.trailColors[at + 3] = col.r * f1; this.trailColors[at + 4] = col.g * f1; this.trailColors[at + 5] = col.b * f1;
        segs++;
        a = b;
      }
      this.live[n++] = q;
    }
    this.live.length = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    const s = this.streaks.geometry;
    s.setDrawRange(0, segs * 2);
    s.attributes.position.needsUpdate = true;
    s.attributes.color.needsUpdate = true;
  }

  // Runs the animation until stopped.
  play() {
    if (this.playing) return;
    this.playing = true;
    let last = performance.now();
    const frame = (now) => {
      if (!this.playing) return;
      this.tick((now - last) / 1000);
      last = now;
      this.view.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop() { this.playing = false; }

  clear() {
    this.live = [];
    this.points.geometry.setDrawRange(0, 0);
    this.streaks.geometry.setDrawRange(0, 0);
    this.view.render();
  }

  setVisible(on) { this.points.visible = on; this.streaks.visible = on; this.view.render(); }
}
