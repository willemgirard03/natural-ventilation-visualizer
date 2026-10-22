// The air on the section planes: each plane's rooms coloured by air temperature, speed or CO2
// (transparent outside them), and particles moving with the air within that plane, trailing, as in the
// 2D section prototype. From the grid solver or ideal flow. Each plane's slice is sampled over its bounds at about half a cell's
// spacing, just behind the plane on the side it keeps, so the cut walls are drawn over it.
//
// Where a plane shows its air, it hides the particles behind it but not the walls: the slice writes
// depth only where there is air, is drawn after the building (so walls show through its colour) and
// before the particles (so they do not).

import * as THREE from 'three';
import { frameOf } from './sections.js';

const FILL = 0.82; // the slices' opacity: a field to read, with the model still showing through
const INK = new THREE.Color('#18211F');
const DENSITY = 2.5; // particles per m2 of air in a plane
const MAX_PER_PLANE = 1500;
const HISTORY = 10; // trail points
const LIFE = [3, 8]; // s of air time a particle lives, before it starts again somewhere else

// Temperature: blue through pale to red over the range given; speed: the particles' log scale.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#EEF1F4'), WARM = new THREE.Color('#E0401F');
export function rampTemperature(t, lo, hi, out = new THREE.Color()) {
  const x = hi > lo ? Math.max(0, Math.min(1, (t - lo) / (hi - lo))) * 2 - 1 : 0;
  return x < 0 ? out.copy(MID).lerp(COOL, -x) : out.copy(MID).lerp(WARM, x);
}

export class FieldSlices {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    view.scene.add(this.group);
    this.visible = false;
    this.trails = new Map(); // by plane: its particles, kept across updates while the plane stays put
    this.timeScale = 5; // as fast as the 3D particles
    this.running = false;
  }

  hide() {
    this.clear();
    this.clearTrails();
    this.visible = false;
    this.view.render();
  }

  clearTrails(keep = new Set()) {
    for (const [p, t] of this.trails) {
      if (keep.has(p)) continue;
      t.lines.geometry.dispose(); t.lines.material.dispose();
      this.view.scene.remove(t.lines);
      this.trails.delete(p);
    }
  }

  clear() {
    for (const o of [...this.group.children]) {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
      this.group.remove(o);
    }
  }

  // sample: { inside(x, y, z) -> bool, value(x, y, z) -> number, velocity(x, y, z) -> [u, v, w] } in
  // model coordinates; field: 'temperature', 'speed', 'co2' or '' (particles only); trails: particles
  // in the planes; colour(v, range): a THREE.Color; grid: the room cells, for their extent and spacing.
  // Returns the values' range on the slices.
  update(sample, field, colour, grid, trails) {
    const v = this.view, o = v.origin;
    this.clear();
    this.sample = sample;
    const planes = v.sections.planes;
    this.clearTrails(new Set(trails ? planes : []));
    const out = [];
    // The grid's box in view coordinates: slices are cropped to it.
    const gmin = new THREE.Vector3(grid.min[0] - o[0], grid.min[1] - o[1], grid.min[2] - o[2]);
    const gmax = gmin.clone().add(new THREE.Vector3(grid.nx, grid.ny, grid.nz).multiplyScalar(grid.h));
    planes.forEach((p, i) => {
      const f = frameOf(p);
      // The plane's bounds cropped to the grid's box, along u and v.
      const [u0, u1, v0, v1] = crop(p.b, f, gmin, gmax);
      if (!(u1 > u0 && v1 > v0)) return;
      const start = f.o.clone().addScaledVector(f.u, u0).addScaledVector(f.v, v0).addScaledVector(f.n, -0.02);
      const s = this.paint(sample, start, f.u, f.v, u1 - u0, v1 - v0, grid.h / 2, i, !!field);
      if (s) out.push(s);
      if (trails) this.trailsFor(p, i, f, [u0, u1, v0, v1], s, grid.h / 2);
    });
    // Colour with a common range, then show.
    const all = out.flatMap((s) => s.values.filter((x) => x !== null));
    const range = field === 'speed' || field === 'co2' ? null : all.length ? [Math.min(...all), Math.max(...all)] : [20, 24];
    for (const s of out) {
      const data = s.texture.image.data;
      s.values.forEach((val, k) => {
        if (val === null) { data[k * 4 + 3] = 0; return; }
        if (!field) { data[k * 4 + 3] = 255; return; } // depth only: hides the particles behind
        const col = colour(val, range);
        data[k * 4] = col.r * 255; data[k * 4 + 1] = col.g * 255; data[k * 4 + 2] = col.b * 255; data[k * 4 + 3] = FILL * 255;
      });
      s.texture.needsUpdate = true;
    }
    this.visible = planes.length > 0;
    v.render();
    return field ? range : null;
  }

  // One slice: a rectangle from `start` along unit vectors u and w (view coordinates), sized su x sw,
  // sampled every step; plane index i (its own cut does not remove it). coloured: false for a slice
  // that only hides what is behind it.
  paint(sample, start, u, w, su, sw, step, i, coloured) {
    const o = this.view.origin;
    const W = Math.max(2, Math.ceil(su / step)), H = Math.max(2, Math.ceil(sw / step));
    const values = new Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let k = 0; k < W; k++) {
        const a = (k + 0.5) * step, b = (j + 0.5) * step;
        const x = start.x + u.x * a + w.x * b + o[0], y = start.y + u.y * a + w.y * b + o[1], z = start.z + u.z * a + w.z * b + o[2];
        values[k + j * W] = sample.inside(x, y, z) ? sample.value(x, y, z) : null;
      }
    }
    const texture = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
    texture.magFilter = coloured ? THREE.LinearFilter : THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const corner = (a, b) => start.clone().addScaledVector(u, a).addScaledVector(w, b);
    const [c0, c1, c2, c3] = [corner(0, 0), corner(W * step, 0), corner(W * step, H * step), corner(0, H * step)];
    const geometry = new THREE.BufferGeometry().setFromPoints([c0, c1, c2, c0, c2, c3]);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, alphaTest: 0.5, colorWrite: coloured });
    this.view.sections.patch(material, i);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    return { texture, values, W, H, step };
  }

  // A plane's particles: made when it first shows them, started again when it has moved. Where air is
  // (the slice's samples that are inside a room) is where they start.
  trailsFor(p, i, f, bounds, slice, step) {
    const where = [];
    slice.values.forEach((val, k) => { if (val !== null) where.push(bounds[0] + ((k % slice.W) + 0.5) * step, bounds[2] + (Math.floor(k / slice.W) + 0.5) * step); });
    const key = [f.o.x, f.o.y, f.o.z, p.yaw, p.flip, ...p.b].map((x) => (typeof x === 'number' ? x.toFixed(3) : x)).join(',');
    let t = this.trails.get(p);
    if (t && t.key !== key) { this.clearTrails(new Set(this.view.sections.planes.filter((q) => q !== p))); t = null; }
    const n = Math.min(MAX_PER_PLANE, Math.round((where.length / 2) * step * step * DENSITY));
    if (!t) {
      const segs = n * (HISTORY - 1);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 2 * 4), 4));
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
      const lines = new THREE.LineSegments(g, material);
      lines.renderOrder = 4;
      lines.frustumCulled = false;
      this.view.scene.add(lines);
      t = { key, lines, n, uv: new Float32Array(n * HISTORY * 2), age: new Float32Array(n), life: new Float32Array(n), born: new Uint8Array(n) };
      this.trails.set(p, t);
    }
    Object.assign(t, { f, i, bounds, where, step });
    this.view.sections.patch(t.lines.material, i);
    if (!this.running) this.run();
  }

  // Moves every plane's particles on, frame by frame, while any plane shows them.
  run() {
    this.running = true;
    let last = performance.now();
    const frame = (now) => {
      if (!this.trails.size) { this.running = false; return; }
      const dt = Math.min(0.05, (now - last) / 1000) * this.timeScale;
      last = now;
      for (const t of this.trails.values()) this.advance(t, dt);
      this.view.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  advance(t, dt) {
    const { f, bounds, where, step, n } = t, o = this.view.origin, sample = this.sample;
    if (!where.length || !sample) return;
    const pos = t.lines.geometry.getAttribute('position').array, col = t.lines.geometry.getAttribute('color').array;
    const base = f.o.clone().addScaledVector(f.n, -0.01);
    const world = (a, b) => [base.x + f.u.x * a + f.v.x * b + o[0], base.y + f.u.y * a + f.v.y * b + o[1], base.z + f.u.z * a + f.v.z * b + o[2]];
    const H2 = HISTORY * 2;
    for (let k = 0; k < n; k++) {
      const uv = t.uv, at = k * H2;
      let a = uv[at], b = uv[at + 1];
      const start = () => {
        const w = 2 * Math.floor(Math.random() * (where.length / 2));
        a = where[w] + (Math.random() - 0.5) * step; b = where[w + 1] + (Math.random() - 0.5) * step;
        for (let h = 0; h < H2; h += 2) { uv[at + h] = a; uv[at + h + 1] = b; }
        t.age[k] = 0; t.life[k] = LIFE[0] + Math.random() * (LIFE[1] - LIFE[0]); t.born[k] = 1;
      };
      if (!t.born[k] || t.age[k] > t.life[k]) start();
      else {
        const [x, y, z] = world(a, b);
        if (!sample.inside(x, y, z)) start();
        else {
          const vel = sample.velocity(x, y, z);
          const du = vel[0] * f.u.x + vel[1] * f.u.y + vel[2] * f.u.z, dv = vel[0] * f.v.x + vel[1] * f.v.y + vel[2] * f.v.z;
          a += du * dt; b += dv * dt;
          if (a < bounds[0] || a > bounds[1] || b < bounds[2] || b > bounds[3]) start();
          else {
            uv.copyWithin(at + 2, at, at + H2 - 2); // the trail shifts back by one point
            uv[at] = a; uv[at + 1] = b;
            t.age[k] += dt;
          }
        }
      }
      // Segments from the head back, fading out along the trail and in as a particle starts.
      const fadeIn = Math.min(1, t.age[k] / 0.6);
      for (let h = 0; h < HISTORY - 1; h++) {
        const s = (k * (HISTORY - 1) + h) * 2;
        for (let e = 0; e < 2; e++) {
          const q = at + (h + e) * 2, p3 = (s + e) * 3, c4 = (s + e) * 4;
          const ua = uv[q], vb = uv[q + 1];
          pos[p3] = base.x + f.u.x * ua + f.v.x * vb; pos[p3 + 1] = base.y + f.u.y * ua + f.v.y * vb; pos[p3 + 2] = base.z + f.u.z * ua + f.v.z * vb;
          col[c4] = INK.r; col[c4 + 1] = INK.g; col[c4 + 2] = INK.b;
          col[c4 + 3] = 0.85 * fadeIn * (1 - (h + e) / (HISTORY - 1));
        }
      }
    }
    t.lines.geometry.getAttribute('position').needsUpdate = true;
    t.lines.geometry.getAttribute('color').needsUpdate = true;
  }
}

// A plane's bounds (u0, u1, v0, v1) cropped to a box: the range of the box's corners along u and v.
function crop(b, f, min, max) {
  const us = [], vs = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    const d = new THREE.Vector3(x, y, z).sub(f.o);
    us.push(d.dot(f.u)); vs.push(d.dot(f.v));
  }
  return [Math.max(b[0], Math.min(...us)), Math.min(b[1], Math.max(...us)), Math.max(b[2], Math.min(...vs)), Math.min(b[3], Math.max(...vs))];
}
