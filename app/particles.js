// Particles carried by the air: released wherever outdoor air comes in (in proportion to its flow) and
// moved through the room flow field by the tracer (src/solver/tracer.js), which keeps them off walls
// and lets them through openings and leaks. Inside rooms the field is ideal flow: it shows where air
// goes, not buoyant plumes or eddies. Trails and leaving particles fade out by transparency.

import * as THREE from 'three';
import { Tracer, MAX_AGE, EXIT_TIME } from '../src/solver/tracer.js';
import { co2Color } from './view3d.js';

const CAPACITY = 20000;
const TARGET = 6000; // particles in view under the first conditions shown, at density x1
const RHO = 1.2;
const TRAIL = 6; // s of real time each trail covers
const HISTORY = 8; // positions kept per particle for its trail
const FADE = 1.5; // s over which a particle fades before it goes

// Blue (cool) through pale grey to red (warm), centred on 22 degC.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#E4E9EE'), WARM = new THREE.Color('#E0401F');
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

// Points or line segments with a colour and transparency per vertex.
function layer(view, count, perVertex, Kind, material) {
  const pos = new Float32Array(count * perVertex * 3), rgba = new Float32Array(count * perVertex * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  g.setDrawRange(0, 0);
  const obj = new Kind(g, material);
  obj.renderOrder = 3;
  obj.frustumCulled = false;
  view.scene.add(obj);
  return { obj, pos, rgba };
}

export class AirflowParticles {
  constructor(view) {
    this.view = view;
    const common = { vertexColors: true, transparent: true, depthWrite: false, clippingPlanes: view.clipping };
    this.heads = layer(view, CAPACITY, 1, THREE.Points, new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, ...common })); // px: the same in perspective and parallel
    this.trails = layer(view, CAPACITY, HISTORY * 2, THREE.LineSegments, new THREE.LineBasicMaterial(common));
    this.live = [];
    this.speed = 5; // display time runs this many times faster than real time
    this.densityScale = 1; // the Particles slider
    this.colorBy = 'temperature'; // or 'speed', or 'co2' (with co2At(p, zone index) -> ppm)
    this.co2At = null;
    this.density = null; // particles released per kg of outdoor air; fixed per model
    this.spawnDebt = 0;
    this.tracer = null;
  }

  // The cells (voxelize) and the model's total volume, for a new model.
  setGrid(grid, volume) {
    this.tracer = new Tracer(grid);
    this.volume = volume;
    this.live = [];
    this.density = null;
    this.ready = false;
  }

  // A new flow field (roomFlow) with the conditions it came from.
  setField(field, conditions) {
    const tr = this.tracer;
    tr.setField(field, tr.g.zones.map((z) => conditions.zones[z].t), conditions.outdoor.t);
    this.ready = tr.entryTotal > 0;
    if (!this.ready) return;
    // Air spends about volume / flow in the building; release enough for TARGET particles at x1.
    const stay = Math.min(MAX_AGE, this.volume / tr.entryTotal);
    if (this.density === null) this.density = TARGET / (tr.entryTotal * RHO * stay);
    if (!this.live.length) this.prefill(stay);
  }

  // Starts with air already on its way through the building, rather than one packet at the windows.
  prefill(stay) {
    const tr = this.tracer;
    const n = Math.min(CAPACITY, Math.round(this.density * this.densityScale * tr.entryTotal * RHO * stay));
    for (let k = 0; k < n; k++) {
      const q = this.newParticle();
      const t = Math.random() * stay, steps = Math.min(60, Math.ceil(t / 2));
      let alive = true;
      for (let s = 0; s < steps && alive; s++) alive = tr.step(q, t / steps);
      if (alive) this.live.push(q);
    }
  }

  newParticle() {
    const q = this.tracer.release();
    q.hist = [];
    q.since = 0;
    return q;
  }

  // Advances the particles by dt seconds of display time and redraws them.
  tick(dt) {
    if (!this.ready) return;
    const tr = this.tracer, sim = Math.min(dt, 0.1) * this.speed;
    this.spawnDebt += this.density * this.densityScale * tr.entryTotal * RHO * sim;
    for (; this.spawnDebt >= 1; this.spawnDebt--) if (this.live.length < CAPACITY) this.live.push(this.newParticle());
    const o = this.view.origin, col = new THREE.Color(), every = TRAIL / (HISTORY - 1);
    const H = this.heads, T = this.trails;
    let n = 0, segs = 0;
    for (const q of this.live) {
      if (!tr.step(q, sim)) continue;
      q.since += sim;
      if (q.since >= every || !q.hist.length) {
        q.since = 0;
        q.hist.unshift([...q.p]);
        if (q.hist.length > HISTORY) q.hist.length = HISTORY;
      }
      // Fully visible until it leaves the building or times out in a still corner, then fading.
      const alpha = q.out ? q.out.left / EXIT_TIME : Math.min(1, (MAX_AGE - q.age) / FADE);
      if (this.colorBy === 'speed') speedColor(Math.hypot(...q.v), col);
      else if (this.colorBy === 'co2') co2Color(this.co2At ? this.co2At(q.p, q.zone) : 400, col);
      else temperatureColor(q.t, col);
      for (let i = 0; i < 3; i++) H.pos[n * 3 + i] = q.p[i] - o[i];
      H.rgba.set([col.r, col.g, col.b, alpha * 0.95], n * 4);
      // Trail: head to newest remembered position, then back through the rest, fading to nothing.
      let a = q.p;
      for (let j = 0; j < q.hist.length; j++) {
        const b = q.hist[j];
        for (let i = 0; i < 3; i++) { T.pos[segs * 6 + i] = a[i] - o[i]; T.pos[segs * 6 + 3 + i] = b[i] - o[i]; }
        T.rgba.set([col.r, col.g, col.b, alpha * 0.85 * (1 - j / HISTORY), col.r, col.g, col.b, alpha * 0.85 * (1 - (j + 1) / HISTORY)], segs * 8);
        segs++;
        a = b;
      }
      this.live[n++] = q;
    }
    this.live.length = n;
    for (const [L, count] of [[H, n], [T, segs * 2]]) {
      const g = L.obj.geometry;
      g.setDrawRange(0, count);
      g.attributes.position.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
    }
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
    for (const L of [this.heads, this.trails]) L.obj.geometry.setDrawRange(0, 0);
    this.view.render();
  }

  setVisible(on) { this.heads.obj.visible = on; this.trails.obj.visible = on; this.view.render(); }
}
