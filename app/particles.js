// Particles that follow the network solver's flows through the building: they enter wherever
// outdoor air comes in, cross each zone towards the openings air leaves by (chosen in proportion to
// their flow), and pass on to the next zone or back outdoors. This shows the paths the network
// computes, not the flow pattern inside rooms; that comes with the grid solver (PLAN.md).

import * as THREE from 'three';
import { area, bounds, triangulate, unitNormal } from '../src/model/geometry.js';

const CAPACITY = 8000;
const TARGET = 3000; // particles in view under the first conditions shown
const MAX_HOPS = 8;
const RHO = 1.2;

// Blue (cool) through pale grey to red (warm), centred on 22 degC; saturated enough to read
// against the model's light surfaces.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#B9BEC4'), WARM = new THREE.Color('#E0401F');
export function temperatureColor(t, out = new THREE.Color()) {
  const x = Math.max(-1, Math.min(1, (t - 22) / 8));
  return x < 0 ? out.copy(MID).lerp(COOL, -x) : out.copy(MID).lerp(WARM, x);
}

// A random point on a polygon, within a band of its height (fractions of its z extent).
function samplePoint(poly, band, tris) {
  const b = bounds(poly), h = b.max[2] - b.min[2];
  const lo = b.min[2] + band[0] * h, hi = b.min[2] + band[1] * h;
  let p;
  for (let k = 0; k < 24; k++) {
    let r = Math.random() * tris.total, t = tris.list[0];
    for (const x of tris.list) { if ((r -= x.a) <= 0) { t = x; break; } }
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    p = [0, 1, 2].map((i) => t.p[0][i] + u * (t.p[1][i] - t.p[0][i]) + v * (t.p[2][i] - t.p[0][i]));
    if (h < 1e-6 || (p[2] >= lo && p[2] <= hi)) return p;
  }
  p[2] = Math.min(hi, Math.max(lo, p[2]));
  return p;
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
      size: 0.2, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, clippingPlanes: view.clipping,
    }));
    this.points.renderOrder = 3;
    this.points.frustumCulled = false;
    view.scene.add(this.points);
    this.live = [];
    this.speed = 5; // display time runs this many times faster than real time
    // Particles released per kg of outdoor air; set once per model so more flow shows more particles.
    this.density = null;
    this.densityScale = 1; // the Particles slider
    this.spawnDebt = 0;
    this.flows = null;
  }

  // The network (from buildNetwork) for the model shown in the view.
  setNetwork(net, model) {
    this.net = net;
    this.live = [];
    this.flows = null;
    this.density = null;
    this.linkTris = net.links.map((l) => {
      const list = triangulate(l.vertices).map((t) => { const p = t.map((i) => l.vertices[i]); return { p, a: area(p) }; });
      return { list, total: list.reduce((s, x) => s + x.a, 0), normal: unitNormal(l.vertices) };
    });
    this.zoneBox = net.zones.map((z) => bounds(model.zones[z].surfaces.flatMap((n) => model.surfaces[n].vertices)));
    this.zoneVolume = net.zones.map((z) => model.zones[z].volume.value);
  }

  // New flows: streams from flowStreams() and the conditions they were solved for.
  setFlows(flows, conditions) {
    this.flows = flows;
    this.conditions = conditions;
    if (!flows.outdoorIn) return;
    // Particles in the building = release rate x time spent inside, averaged over sample routes.
    const sample = Array.from({ length: 200 }, () => this.route(this.pickEntry()).duration);
    const time = sample.reduce((s, x) => s + x, 0) / sample.length;
    if (this.density === null) this.density = TARGET / (flows.outdoorIn * time); // TARGET under these first conditions
    if (!this.live.length) {
      // Start with air already on its way, spread along the routes, rather than one packet at the windows.
      const n = Math.min(CAPACITY, Math.round(this.density * this.densityScale * flows.outdoorIn * time));
      for (let k = 0; k < n; k++) {
        const q = this.route(this.pickEntry());
        if (this.advance(q, Math.random() * q.duration)) this.live.push(q);
      }
    }
  }

  // An entry stream, chosen in proportion to its flow.
  pickEntry() {
    const entries = this.flows.entries;
    let r = Math.random() * this.flows.outdoorIn;
    for (const x of entries) { if ((r -= x.rate) <= 0) return x; }
    return entries[entries.length - 1];
  }

  // Moves a particle t seconds (real time) along its route; false once it has left the building.
  advance(q, t) {
    q.d += q.speeds[q.leg] * t;
    let len;
    while (q.leg < q.speeds.length && q.d >= (len = Math.hypot(...q.pts[q.leg + 1].map((x, i) => x - q.pts[q.leg][i])))) {
      q.d -= len; q.leg++;
      if (q.leg < q.speeds.length) q.d *= q.speeds[q.leg] / q.speeds[q.leg - 1];
    }
    q.len = len;
    return q.leg < q.speeds.length;
  }

  // A particle's route from an entry stream: waypoints (model coordinates), the speed along each leg
  // (m/s, real time) and the air temperature at each waypoint, for its colour.
  route(entry) {
    const { net, flows, conditions: c } = this;
    const zoneT = (z) => c.zones[net.zones[z]].t;
    const at = (s) => samplePoint(net.links[s.link].vertices, s.band, this.linkTris[s.link]);
    const along = (s) => { // from the stream's source side to its destination
      const n = this.linkTris[s.link].normal;
      return s.from === net.links[s.link].n ? n : n.map((x) => -x);
    };
    const inside = (z) => Math.min(1.5, Math.max(0.05, flows.throughflow[z] / RHO / this.zoneVolume[z] ** (2 / 3)));
    const through = (s) => { // speed through the opening's band; cracks seep at the zone's speed
      const l = net.links[s.link];
      if (l.type !== 'opening') return inside(s.to >= 0 ? s.to : s.from);
      const open = l.control === 'zone' ? (c.open?.[l.name] ?? 0) : l.openFactor;
      return Math.min(4, Math.max(0.1, s.rate / RHO / Math.max(0.02, area(l.vertices) * open * (s.band[1] - s.band[0]))));
    };
    const move = (p, d, k) => p.map((x, i) => x + d[i] * k);
    let s = entry, p = at(s);
    const pts = [move(p, along(s), -1), p], speeds = [through(s)], temps = [c.outdoor.t, c.outdoor.t];
    for (let hop = 0; hop < MAX_HOPS && s.to >= 0; hop++) {
      const z = s.to, outs = flows.outlets[z];
      const total = outs.reduce((t, x) => t + x.rate, 0);
      if (!total) break;
      let r = Math.random() * total, next = outs[0];
      for (const x of outs) { if ((r -= x.rate) <= 0) { next = x; break; } }
      const exit = at(next), box = this.zoneBox[z];
      const mid = [0, 1].map((i) => box.min[i] + (0.2 + 0.6 * Math.random()) * (box.max[i] - box.min[i]));
      mid.push((p[2] + exit[2]) / 2 + (Math.random() - 0.5) * 0.3 * (box.max[2] - box.min[2]));
      const t0 = temps[temps.length - 1];
      pts.push(mid, exit);
      temps.push((t0 + zoneT(z)) / 2, zoneT(z));
      speeds.push(inside(z), inside(z));
      if (next.to < 0) { pts.push(move(exit, along(next), 1)); temps.push(zoneT(z)); speeds.push(through(next)); }
      s = next; p = exit;
    }
    let duration = 0;
    for (let i = 0; i < speeds.length; i++) duration += Math.hypot(...pts[i + 1].map((x, k) => x - pts[i][k])) / speeds[i];
    return { pts, speeds, temps, leg: 0, d: 0, duration };
  }

  // Advances the particles by dt seconds of display time.
  tick(dt) {
    if (!this.flows) return;
    const sim = Math.min(dt, 0.1) * this.speed;
    // A steady release in proportion to each entry's flow; when full, new particles are skipped, not saved up.
    if (this.density && this.flows.outdoorIn > 0) {
      this.spawnDebt += this.density * this.densityScale * this.flows.outdoorIn * sim;
      for (; this.spawnDebt >= 1; this.spawnDebt--) if (this.live.length < CAPACITY) this.live.push(this.route(this.pickEntry()));
    }
    const o = this.view.origin, col = new THREE.Color();
    let n = 0;
    for (const q of this.live) {
      if (!this.advance(q, sim)) continue; // reached the end of its route
      const a = q.pts[q.leg], b = q.pts[q.leg + 1], f = q.len > 0 ? q.d / q.len : 0;
      for (let i = 0; i < 3; i++) this.positions[n * 3 + i] = a[i] + f * (b[i] - a[i]) - o[i];
      temperatureColor(q.temps[q.leg] + f * (q.temps[q.leg + 1] - q.temps[q.leg]), col);
      this.colors[n * 3] = col.r; this.colors[n * 3 + 1] = col.g; this.colors[n * 3 + 2] = col.b;
      this.live[n++] = q;
    }
    this.live.length = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
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
    this.view.render();
  }

  setVisible(on) { this.points.visible = on; this.view.render(); }
}
