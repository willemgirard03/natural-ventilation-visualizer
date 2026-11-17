// The air in a plan or section view: its cut filled with the air's temperature, speed or CO2 where it
// passes through rooms, and particles moving with the air within the cut, trailing - as a clipping
// plane shows them in 3D (slices.js), with the same settings (AIR_DEFAULT: what the fill and the
// particles show, their gradients, ranges, caps, opacities, density), kept on the named view (v.air).
//
// Two canvases over the drawing (under the editor's layer): the fill, sampled over the part of the cut
// in sight at about half a cell (or 3 px), drawn over the drawing so its lines show through
// (multiplied); and the particles, moved every frame. The fill is redrawn when the air is (throttled
// by the page) or the drawing moves.
//
// new ViewAir(drawing, { speed }) ; .update(sample, grid) ; .dispose()
// drawing: the workspace's Drawing (host, item (the named view, with .air), frame(), toPx, fromPx);
// sample: the page's sampler of the air ({ inside, value(kind, x, y, z), velocity, temperature, co2 },
// model coordinates); origin: the 3D view's (model = view coordinates + origin).

import * as THREE from 'three';
import { rampOf } from './slices.js';
import { colourOf, niceRange, DEFAULT_RANGE } from './ramps.js';

const DENSITY = 2.5; // particles per m2 of air, at density x1 (as the planes')
const MAX = 1500;
const HISTORY = 8, TRAIL = 6, EVERY = TRAIL / (HISTORY - 1), LIFE = [8, 16]; // as the planes' particles
const TINT = new THREE.Color();

export class ViewAir {
  constructor(d, { speed = () => 1, origin = () => [0, 0, 0] } = {}) {
    Object.assign(this, { d, speed, origin });
    this.fill = document.createElement('canvas');
    this.parts = document.createElement('canvas');
    for (const c of [this.fill, this.parts]) { c.className = 'viewair'; d.host.insertBefore(c, d.ov); }
    this.fill.style.mixBlendMode = 'multiply';
    this.dots = null;
    this.running = false;
  }
  get air() { return this.d.item?.air || null; }
  dispose() { this.fill.remove(); this.parts.remove(); this.running = false; }
  hide() {
    for (const c of [this.fill, this.parts]) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    this.dots = null;
    if (this.d.item) this.d.item.shown = null;
  }

  // Sampled again: the fill drawn, the range each shows worked out, the particles started where air is.
  update(sample, grid) {
    const a = this.air, fr = this.d.frame(), w = Math.floor(this.d.host.clientWidth), h = Math.floor(this.d.host.clientHeight);
    if (!a || !fr || !sample || !grid || !w || !h || (!a.field && !a.particles)) { this.hide(); return; }
    this.sample = sample;
    const f = fr.f, o = this.origin(), s = this.d.cam?.s || 20;
    // the drawing's (u, v), as the cut is drawn: mirrored where it would be seen from behind (drawings.js)
    const mir = f.u.clone().cross(f.v).dot(f.n) < 0 ? -1 : 1;
    for (const c of [this.fill, this.parts]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      if (c.nextElementSibling !== this.d.ov && c !== this.fill) this.d.host.insertBefore(c, this.d.ov); // over the drawing, drawn again
    }
    if (this.fill.nextElementSibling !== this.parts) this.d.host.insertBefore(this.fill, this.parts);
    // the part of the cut in sight, on a lattice of about half a cell (at least 3 px)
    const step = Math.max(grid.h / 2, 3 / s), [u0, v1] = this.d.fromPx(0, 0), [u1, v0] = this.d.fromPx(w, h);
    const W = Math.max(2, Math.ceil((u1 - u0) / step)), H = Math.max(2, Math.ceil((v1 - v0) / step));
    if (W * H > 400000) { this.hide(); return; }
    const at = (a2, b2) => [f.o.x + f.u.x * mir * a2 + f.v.x * b2 + o[0], f.o.y + f.u.y * mir * a2 + f.v.y * b2 + o[1], f.o.z + f.u.z * mir * a2 + f.v.z * b2 + o[2]];
    const values = new Array(W * H), where = [];
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < H; j++) for (let k = 0; k < W; k++) {
      const ua = u0 + (k + 0.5) * step, vb = v0 + (j + 0.5) * step, p = at(ua, vb);
      if (!sample.inside(...p)) { values[k + j * W] = null; continue; }
      where.push(ua, vb);
      const val = a.field ? sample.value(a.field, ...p) : 0;
      values[k + j * W] = val;
      if (val < lo) lo = val; if (val > hi) hi = val;
    }
    const data = lo <= hi ? [lo, hi] : null;
    this.d.item.shown = {
      fill: a.field ? { field: a.field, ramp: rampOf(a, 'fill'), flip: !!a.fillFlip, cap: a.fillCap, range: a.fillRange || DEFAULT_RANGE[a.field], data, suggest: data && niceRange(a.field, ...data) } : null,
      part: a.particles && a.color !== 'plain' ? { field: a.color, ramp: rampOf(a, 'part'), flip: !!a.partFlip, cap: a.partCap, range: a.partRange || DEFAULT_RANGE[a.color], data: null, suggest: null } : null,
    };
    // the fill: each sample a pixel of a small image, stretched over the view
    const fc = this.fill.getContext('2d');
    fc.clearRect(0, 0, w, h);
    if (a.field) {
      const img = new ImageData(W, H), sh = this.d.item.shown.fill;
      values.forEach((val, k) => {
        if (val === null) return;
        const col = colourOf(sh, a.field, val, TINT), x = k % W, y = H - 1 - Math.floor(k / W), q = (x + y * W) * 4;
        img.data[q] = col.r * 255; img.data[q + 1] = col.g * 255; img.data[q + 2] = col.b * 255; img.data[q + 3] = 255;
      });
      const off = new OffscreenCanvas(W, H);
      off.getContext('2d').putImageData(img, 0, 0);
      const [x0, y0] = this.d.toPx(u0, v0 + H * step), [x1, y1] = this.d.toPx(u0 + W * step, v0);
      fc.imageSmoothingEnabled = true;
      fc.globalAlpha = a.fillOpacity ?? 0.82;
      fc.drawImage(off, x0, y0, x1 - x0, y1 - y0);
    }
    // the particles: started where there is air, as many as its area and the density ask
    if (a.particles) {
      const n = Math.min(MAX, Math.round((where.length / 2) * step * step * DENSITY * Math.min(1, a.density ?? 1)));
      const key = JSON.stringify([f.o, f.u, f.v, n]);
      if (!this.dots || this.dots.key !== key) this.dots = { key, n, uv: new Float32Array(n * HISTORY * 2), age: new Float32Array(n), life: new Float32Array(n), born: new Uint8Array(n), since: new Float32Array(n) };
      Object.assign(this.dots, { where, step, f, mir, bounds: [u0, u0 + W * step, v0, v0 + H * step] });
      if (!this.running) this.run();
    } else { this.dots = null; this.parts.getContext('2d').clearRect(0, 0, w, h); }
  }

  run() {
    this.running = true;
    let last = performance.now();
    const frame = (now) => {
      if (!this.running || !this.dots || !this.d.host.isConnected) { this.running = false; return; }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.advance(dt * (this.speed() ?? 1));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  advance(dt) {
    const t = this.dots, a = this.air, sample = this.sample, o = this.origin();
    if (!t || !a || !sample || !t.where.length) return;
    const { f, where, step, bounds, n, mir } = t, H2 = HISTORY * 2;
    const world = (u, v) => [f.o.x + f.u.x * mir * u + f.v.x * v + o[0], f.o.y + f.u.y * mir * u + f.v.y * v + o[1], f.o.z + f.u.z * mir * u + f.v.z * v + o[2]];
    const c = this.parts.getContext('2d'), sh = this.d.item.shown?.part, by = a.color;
    c.clearRect(0, 0, this.parts.width, this.parts.height);
    c.globalAlpha = a.partOpacity ?? 1;
    c.lineWidth = 1.2;
    for (let k = 0; k < n; k++) {
      const at = k * H2, uv = t.uv;
      const start = () => {
        const w = 2 * Math.floor(Math.random() * (where.length / 2)), u = where[w] + (Math.random() - 0.5) * step, v = where[w + 1] + (Math.random() - 0.5) * step;
        for (let h = 0; h < H2; h += 2) { uv[at + h] = u; uv[at + h + 1] = v; }
        t.age[k] = 0; t.life[k] = LIFE[0] + Math.random() * (LIFE[1] - LIFE[0]); t.born[k] = 1; t.since[k] = 0;
      };
      if (!t.born[k] || t.age[k] > t.life[k]) { start(); continue; }
      let u = uv[at], v = uv[at + 1];
      const p = world(u, v);
      if (!sample.inside(...p)) { start(); continue; }
      const vel = sample.velocity(...p);
      u += mir * (vel[0] * f.u.x + vel[1] * f.u.y + vel[2] * f.u.z) * dt;
      v += (vel[0] * f.v.x + vel[1] * f.v.y + vel[2] * f.v.z) * dt;
      if (u < bounds[0] || u > bounds[1] || v < bounds[2] || v > bounds[3]) { start(); continue; }
      t.since[k] += dt;
      if (t.since[k] >= EVERY) { t.since[k] = 0; uv.copyWithin(at + 2, at, at + H2 - 2); }
      uv[at] = u; uv[at + 1] = v; t.age[k] += dt;
      // its colour where it is: the air's temperature, speed or CO2 by the gradient, or plain black
      const val = by === 'speed' ? Math.hypot(...vel) : by === 'co2' ? sample.co2(...p) : sample.temperature(...p);
      const col = by === 'plain' || !sh ? '#18211F' : `#${colourOf(sh, by, val, TINT).getHexString()}`;
      c.strokeStyle = col; c.fillStyle = col;
      c.beginPath();
      for (let h = 0; h < H2; h += 2) { const [x, y] = this.d.toPx(uv[at + h], uv[at + h + 1]); if (h) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke();
      const [hx, hy] = this.d.toPx(u, v);
      c.fillRect(hx - 1.2, hy - 1.2, 2.4, 2.4);
    }
  }
}
