// The air on the section planes: each plane's rooms coloured by air temperature, speed or CO2
// (transparent outside them), and particles moving with the air within that plane, trailing, as in the
// 2D section prototype. From the grid solver or ideal flow. Each plane's slice is sampled over its bounds at about half a cell's
// spacing, just behind the plane on the side it keeps, so the cut walls are drawn over it.
//
// A plane shaded with the air's temperature, speed or CO2 hides the 3D particles behind it but not
// the walls: the slice writes depth where there is air, is drawn after the building (so walls show
// through its colour) and before the particles (so they do not). An unshaded plane hides nothing.
//
// The particles in the planes are their own: moved within each plane by the air's velocity along it,
// separately from the 3D particles. Each plane has its own settings (p.air: what its slice is coloured
// by, whether it shows particles, and their colour, density and speed), set in its pop-up, so planes
// can show different things side by side. Pointing at a slice shows a crosshair there and the values
// of the air at that point (probe).

import * as THREE from 'three';
import { frameOf, removes as removesPoint } from './sections.js';
import { rampAt, placeOf, niceRange, DEFAULT_RAMP } from './ramps.js';

const FILL = 0.82; // the slices' opacity: a field to read, with the model still showing through
const TINT = new THREE.Color();
const DENSITY = 2.5; // particles per m2 of air in a plane, at density x1
const MAX_PER_PLANE = 1500;
const HISTORY = 8; // trail points, as the 3D particles
const TRAIL = 6; // s of air time a trail covers, as the 3D particles
const EVERY = TRAIL / (HISTORY - 1); // s of air time between remembered positions
const LIFE = [8, 16]; // s of air time a particle lives, before it starts again somewhere else
const NONE = new THREE.Color('#000000');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Temperature: blue through pale to red over the range given; speed: the particles' log scale.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#EEF1F4'), WARM = new THREE.Color('#E0401F');
export function rampTemperature(t, lo, hi, out = new THREE.Color()) {
  const x = hi > lo ? Math.max(0, Math.min(1, (t - lo) / (hi - lo))) * 2 - 1 : 0;
  return x < 0 ? out.copy(MID).lerp(COOL, -x) : out.copy(MID).lerp(WARM, x);
}

// A new plane's settings: its slice filled by temperature, with particles coloured the same way, at
// density x1 and real-time speed. field: the fill's data, 'temperature', 'speed', 'co2' or '' (none);
// color: the particles' data, the same or 'plain' (black), 'none' for no particles. Each has its
// gradient (fillRamp, partRamp: a name in ramps.js, null for the data's own) and its range
// (fillRange, partRange: [lo, hi], or null for the data's own lowest to highest on the cuts).
export const AIR_DEFAULT = { field: 'temperature', fillRamp: null, fillRange: null, particles: true, color: 'temperature', partRamp: null, partRange: null, density: 1, speed: 1, beyond: false };
// a plane's fill or particles' gradient, its own or its data's
export const rampOf = (a, which) => (which === 'fill' ? a.fillRamp || DEFAULT_RAMP[a.field] : a.partRamp || DEFAULT_RAMP[a.color]) || 'coolwarm';

export class FieldSlices {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    view.scene.add(this.group);
    this.visible = false;
    this.trails = new Map(); // by plane: its particles, kept across updates while the plane stays put
    this.running = false;
    // The probe: a crosshair in the plane pointed at, and the values there beside the pointer.
    this.cross = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#18211F', depthTest: false, transparent: true }));
    this.cross.renderOrder = 30;
    this.cross.visible = false;
    this.cross.userData.noSection = true;
    view.scene.add(this.cross);
    this.tag = document.createElement('div');
    this.tag.className = 'probetag';
    this.tag.hidden = true;
    view.container.appendChild(this.tag);
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
      for (const o of [t.lines, t.heads]) { o.geometry.dispose(); o.material.dispose(); this.view.scene.remove(o); }
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

  // sample: { inside(x, y, z) -> bool, value(field, x, y, z) -> number, velocity(x, y, z) -> [u, v, w],
  // temperature, co2 } in model coordinates; grid: the room cells, for their extent and spacing. Each
  // plane is drawn by its own settings (p.air): its fill and its particles each over its own range,
  // or (none set) over its data's lowest to highest on all the cuts showing it. Each plane is given
  // p.shown = { fill: { field, ramp, range, data }, part: { ... } } (data: the lowest and highest
  // there), for the legend and its pop-up; returns the planes shown.
  update(sample, colour, grid) {
    const v = this.view, o = v.origin;
    this.clear();
    this.sample = sample;
    this.grid = grid;
    const planes = v.sections.planes;
    for (const p of planes) p.air.particles = p.air.color !== 'none';
    this.clearTrails(new Set(planes.filter((p) => p.air.particles)));
    const out = [];
    // The grid's box in view coordinates: slices are cropped to it.
    const gmin = new THREE.Vector3(grid.min[0] - o[0], grid.min[1] - o[1], grid.min[2] - o[2]);
    const gmax = gmin.clone().add(new THREE.Vector3(grid.nx, grid.ny, grid.nz).multiplyScalar(grid.h));
    planes.forEach((p, i) => {
      const { field, particles } = p.air;
      if (p.off || (!field && !particles)) return;
      const f = frameOf(p);
      // The plane's bounds cropped to the grid's box, along u and v.
      const [u0, u1, v0, v1] = crop(p.b, f, gmin, gmax);
      if (!(u1 > u0 && v1 > v0)) return;
      const start = f.o.clone().addScaledVector(f.u, u0).addScaledVector(f.v, v0).addScaledVector(f.n, -0.02);
      const value = field ? (x, y, z) => sample.value(field, x, y, z) : () => 0;
      const s = this.paint(sample, value, start, f.u, f.v, u1 - u0, v1 - v0, grid.h / 2, i, !!field);
      // the particles' data on the slice, where it is not the fill's: sampled every other point
      let part = null;
      const by = p.air.color;
      if (s && p.air.particles && by !== 'plain') {
        if (by === field) part = s.values.filter((x) => x !== null);
        else {
          part = [];
          const step = grid.h, W = Math.ceil((u1 - u0) / step), H = Math.ceil((v1 - v0) / step);
          for (let j = 0; j < H; j++) for (let k = 0; k < W; k++) {
            const q = start.clone().addScaledVector(f.u, (k + 0.5) * step).addScaledVector(f.v, (j + 0.5) * step);
            const x = q.x + o[0], y = q.y + o[1], z = q.z + o[2];
            if (sample.inside(x, y, z)) part.push(sample.value(by, x, y, z));
          }
        }
      }
      if (s) out.push({ ...s, field, plane: p, part });
      if (particles) this.trailsFor(p, i, f, [u0, u1, v0, v1], s, grid.h / 2);
    });
    // Each kind of data's lowest and highest on all the cuts showing it (fills and particles alike),
    // rounded outwards: the range a plane's fill or particles take unless given their own.
    const lohi = (list) => { let a = Infinity, b = -Infinity; for (const x of list) { if (x < a) a = x; if (x > b) b = x; } return a <= b ? [a, b] : null; };
    const data = {};
    for (const s of out) {
      if (s.field) { const r = lohi(s.values.filter((x) => x !== null)); if (r) data[s.field] = data[s.field] ? [Math.min(data[s.field][0], r[0]), Math.max(data[s.field][1], r[1])] : r; s.fillData = r; }
      if (s.part) { const by = s.plane.air.color, r = lohi(s.part); if (r) data[by] = data[by] ? [Math.min(data[by][0], r[0]), Math.max(data[by][1], r[1])] : r; s.partData = r; }
    }
    const auto = Object.fromEntries(Object.entries(data).map(([k, r]) => [k, niceRange(k, r[0], r[1])]));
    for (const p of planes) p.shown = null;
    for (const s of out) {
      const a = s.plane.air;
      s.plane.shown = {
        fill: s.field ? { field: s.field, ramp: rampOf(a, 'fill'), range: a.fillRange || auto[s.field] || [0, 1], data: s.fillData, auto: !a.fillRange, suggest: s.fillData && niceRange(s.field, ...s.fillData) } : null,
        part: a.particles && a.color !== 'plain' ? { field: a.color, ramp: rampOf(a, 'part'), range: a.partRange || auto[a.color] || [0, 1], data: s.partData, auto: !a.partRange, suggest: s.partData && niceRange(a.color, ...s.partData) } : null,
      };
    }
    for (const s of out) {
      const data = s.texture.image.data, fill = s.plane.shown.fill;
      s.values.forEach((val, k) => {
        if (val === null) { data[k * 4 + 3] = 0; return; }
        if (!s.field) { data[k * 4 + 3] = 255; return; } // depth only: hides the particles behind
        const col = rampAt(fill.ramp, placeOf(s.field, val, fill.range[0], fill.range[1]), TINT);
        data[k * 4] = col.r * 255; data[k * 4 + 1] = col.g * 255; data[k * 4 + 2] = col.b * 255; data[k * 4 + 3] = FILL * 255;
      });
      s.texture.needsUpdate = true;
    }
    this.visible = out.length > 0;
    v.render();
    void colour;
    return out.map((s) => s.plane);
  }

  // The slice under the pointer: { plane, point (model coordinates) }, or null where the pointer is
  // off every slice, on a part another plane removes, outside the rooms, or behind the building.
  probeAt(e, hitDistance = Infinity) {
    if (!this.visible || !this.sample || !this.grid) return null;
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect(), o = v.origin;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    let best = null;
    for (const p of v.sections.planes) {
      if (p.off || (!p.air.field && !p.air.particles)) continue;
      const f = frameOf(p), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(f.n, f.o);
      if (ray.ray.direction.dot(f.n) >= 0) continue; // its cut is seen only from the side it removes
      const at = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!at) continue;
      const t = at.distanceTo(ray.ray.origin), d = at.clone().sub(f.o), u = d.dot(f.u), w = d.dot(f.v);
      if (t > hitDistance + 0.05 || (best && t > best.t) || u < p.b[0] || u > p.b[1] || w < p.b[2] || w > p.b[3]) continue;
      if (v.sections.planes.some((q) => q !== p && removesPoint(q, at))) continue;
      const m = at.clone().addScaledVector(f.n, -0.02);
      if (!this.sample.inside(m.x + o[0], m.y + o[1], m.z + o[2])) continue;
      best = { t, plane: p, f, at, point: [m.x + o[0], m.y + o[1], m.z + o[2]] };
    }
    return best;
  }

  // Shows the probe at a slice point found by probeAt (or hides it): a crosshair in its plane, and
  // the plane's own value first, then the others.
  showProbe(found, e) {
    if (!found) { if (this.cross.visible || !this.tag.hidden) { this.cross.visible = false; this.tag.hidden = true; this.view.render(); } return; }
    const { f, at, point, plane } = found, s = this.sample, len = this.view.sections.scaleAt(at) * 14;
    const ends = [at.clone().addScaledVector(f.u, -len), at.clone().addScaledVector(f.u, len), at.clone().addScaledVector(f.v, -len), at.clone().addScaledVector(f.v, len)];
    this.cross.geometry.setFromPoints(ends);
    this.cross.visible = true;
    const [x, y, z] = point, vel = s.velocity(x, y, z);
    const parts = { temperature: `${s.temperature(x, y, z).toFixed(1)} °C`, speed: `${Math.hypot(...vel).toFixed(2)} m/s`, co2: `${Math.round(s.co2(x, y, z))} ppm` };
    const first = plane.air.field || 'temperature';
    let html = `<b>${parts[first]}</b>${Object.entries(parts).filter(([k]) => k !== first).map(([, t]) => ` · ${t}`).join('')}`;
    // the zone the point is in: its air on average, and what is known of it
    const zi = s.zoneAt?.(x, y, z) ?? -1, zm = zi >= 0 && s.zoneMean(zi);
    if (zm) {
      const avg = { temperature: Number.isFinite(zm.temperature) ? `${zm.temperature.toFixed(1)} °C` : null, speed: `${zm.speed.toFixed(2)} m/s`, co2: zm.co2 !== null ? `${Math.round(zm.co2)} ppm` : null };
      html += `<br><span class="probezone">${esc(zm.name)} average: ${[first, ...Object.keys(avg).filter((k) => k !== first)].map((k) => avg[k]).filter(Boolean).join(' · ')}</span>`;
      const k = s.zoneKnown?.(zm.name);
      if (k) {
        const src = k.fromResults ? 'EnergyPlus' : 'Indoor setting';
        const co2 = k.co2Results !== null ? ` · ${Math.round(k.co2Results)} ppm` : k.co2Tool !== null ? ` · CO₂ by the tool's balance ${Math.round(k.co2Tool)} ppm` : '';
        if (k.t !== null) html += `<br><span class="probezone">${src}: ${k.t.toFixed(1)} °C${co2}</span>`;
      }
    }
    this.tag.innerHTML = html;
    const r = this.view.container.getBoundingClientRect();
    this.tag.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top - 30}px)`;
    this.tag.hidden = false;
    this.view.render();
  }

  // One slice: a rectangle from `start` along unit vectors u and w (view coordinates), sized su x sw,
  // sampled every step; plane index i (its own cut does not remove it). coloured: false for a slice
  // that only hides what is behind it.
  paint(sample, value, start, u, w, su, sw, step, i, coloured) {
    const o = this.view.origin;
    const W = Math.max(2, Math.ceil(su / step)), H = Math.max(2, Math.ceil(sw / step));
    const values = new Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let k = 0; k < W; k++) {
        const a = (k + 0.5) * step, b = (j + 0.5) * step;
        const x = start.x + u.x * a + w.x * b + o[0], y = start.y + u.y * a + w.y * b + o[1], z = start.z + u.z * a + w.z * b + o[2];
        values[k + j * W] = sample.inside(x, y, z) ? value(x, y, z) : null;
      }
    }
    const texture = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
    texture.magFilter = coloured ? THREE.LinearFilter : THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const corner = (a, b) => start.clone().addScaledVector(u, a).addScaledVector(w, b);
    const [c0, c1, c2, c3] = [corner(0, 0), corner(W * step, 0), corner(W * step, H * step), corner(0, H * step)];
    const geometry = new THREE.BufferGeometry().setFromPoints([c0, c1, c2, c0, c2, c3]);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    if (coloured) {
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, alphaTest: 0.5 });
      this.view.sections.patch(material, i);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 2;
      this.group.add(mesh);
    } else { texture.dispose(); geometry.dispose(); }
    return { texture, values, W, H, step };
  }

  // A plane's particles: made when it first shows them, started again when it has moved. Where air is
  // (the slice's samples that are inside a room) is where they start.
  trailsFor(p, i, f, bounds, slice, step) {
    const where = [];
    slice.values.forEach((val, k) => { if (val !== null) where.push(bounds[0] + ((k % slice.W) + 0.5) * step, bounds[2] + (Math.floor(k / slice.W) + 0.5) * step); });
    const key = [f.o.x, f.o.y, f.o.z, p.q.x, p.q.y, p.q.z, p.q.w, p.flip, ...p.b].map((x) => (typeof x === 'number' ? x.toFixed(3) : x)).join(',');
    let t = this.trails.get(p);
    if (t && t.key !== key) { this.clearTrails(new Set(this.view.sections.planes.filter((q) => q !== p))); t = null; }
    const n = Math.min(MAX_PER_PLANE, Math.round((where.length / 2) * step * step * DENSITY * p.air.density));
    if (t && t.n !== n) { this.clearTrails(new Set(this.view.sections.planes.filter((q) => q !== p))); t = null; }
    if (!t) {
      const segs = n * (HISTORY - 1);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 2 * 4), 4));
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
      const lines = new THREE.LineSegments(g, material);
      lines.renderOrder = 4;
      lines.frustumCulled = false;
      // A dot at each particle, as the 3D particles have: still air shows as dots, moving air as trails.
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      const heads = new THREE.Points(hg, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
      heads.renderOrder = 4;
      heads.frustumCulled = false;
      this.view.scene.add(lines, heads);
      t = { key, lines, heads, n, uv: new Float32Array(n * HISTORY * 2), age: new Float32Array(n), life: new Float32Array(n), since: new Float32Array(n), born: new Uint8Array(n), tint: new Float32Array(n * 3) };
      this.trails.set(p, t);
    }
    Object.assign(t, { p, f, i, bounds, where, step });
    this.view.sections.patch(t.lines.material, i);
    this.view.sections.patch(t.heads.material, i);
    if (!this.running) this.run();
  }

  // Moves every plane's particles on, frame by frame, while any plane shows them.
  run() {
    this.running = true;
    let last = performance.now();
    const frame = (now) => {
      if (!this.trails.size) { this.running = false; return; }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const t of this.trails.values()) this.advance(t, dt * t.p.air.speed); // each plane at its own speed
      this.view.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  advance(t, dt) {
    const { f, bounds, where, step, n } = t, o = this.view.origin, sample = this.sample;
    if (!where.length || !sample) return;
    const pos = t.lines.geometry.getAttribute('position').array, col = t.lines.geometry.getAttribute('color').array;
    const hpos = t.heads.geometry.getAttribute('position').array, hcol = t.heads.geometry.getAttribute('color').array;
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
          // Its colour: the air's temperature, speed or CO2 where it is, by the plane's gradient over its
          // range; or plain black.
          const by = t.p.air.color, sh = t.p.shown?.part;
          const v = by === 'speed' ? Math.hypot(vel[0], vel[1], vel[2]) : by === 'co2' ? sample.co2(x, y, z) : sample.temperature(x, y, z);
          const col = by === 'plain' || !sh ? NONE : rampAt(sh.ramp, placeOf(by, v, sh.range[0], sh.range[1]), TINT);
          t.tint[k * 3] = col.r; t.tint[k * 3 + 1] = col.g; t.tint[k * 3 + 2] = col.b;
          const du = vel[0] * f.u.x + vel[1] * f.u.y + vel[2] * f.u.z, dv = vel[0] * f.v.x + vel[1] * f.v.y + vel[2] * f.v.z;
          a += du * dt; b += dv * dt;
          if (a < bounds[0] || a > bounds[1] || b < bounds[2] || b > bounds[3]) start();
          else {
            // The head moves every frame; a position is remembered every EVERY seconds of air time.
            t.since[k] += dt;
            if (t.since[k] >= EVERY) { t.since[k] = 0; uv.copyWithin(at + 2, at, at + H2 - 2); }
            uv[at] = a; uv[at + 1] = b;
            t.age[k] += dt;
          }
        }
      }
      // Segments from the head back, fading out along the trail and in as a particle starts.
      const fadeIn = Math.min(1, t.age[k] / 0.6);
      hpos[k * 3] = base.x + f.u.x * uv[at] + f.v.x * uv[at + 1];
      hpos[k * 3 + 1] = base.y + f.u.y * uv[at] + f.v.y * uv[at + 1];
      hpos[k * 3 + 2] = base.z + f.u.z * uv[at] + f.v.z * uv[at + 1];
      hcol[k * 4] = t.tint[k * 3]; hcol[k * 4 + 1] = t.tint[k * 3 + 1]; hcol[k * 4 + 2] = t.tint[k * 3 + 2]; hcol[k * 4 + 3] = 0.95 * fadeIn;
      for (let h = 0; h < HISTORY - 1; h++) {
        const s = (k * (HISTORY - 1) + h) * 2;
        for (let e = 0; e < 2; e++) {
          const q = at + (h + e) * 2, p3 = (s + e) * 3, c4 = (s + e) * 4;
          const ua = uv[q], vb = uv[q + 1];
          pos[p3] = base.x + f.u.x * ua + f.v.x * vb; pos[p3 + 1] = base.y + f.u.y * ua + f.v.y * vb; pos[p3 + 2] = base.z + f.u.z * ua + f.v.z * vb;
          col[c4] = t.tint[k * 3]; col[c4 + 1] = t.tint[k * 3 + 1]; col[c4 + 2] = t.tint[k * 3 + 2];
          col[c4 + 3] = 0.85 * fadeIn * (1 - (h + e) / (HISTORY - 1));
        }
      }
    }
    for (const o of [t.lines, t.heads]) { o.geometry.getAttribute('position').needsUpdate = true; o.geometry.getAttribute('color').needsUpdate = true; }
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
