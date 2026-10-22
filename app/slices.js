// The air on the section planes: each plane's rooms coloured by air temperature or speed (transparent
// outside them), and arrows for the air's movement in that plane, as in the 2D section prototype. From
// the grid solver or ideal flow. Each plane's slice is sampled over its bounds at about half a cell's
// spacing, just behind the plane on the side it keeps, so the cut walls are drawn over it.
//
// Where a plane shows its air, it hides the particles behind it but not the walls: the slice writes
// depth only where there is air, is drawn after the building (so walls show through its colour) and
// before the particles (so they do not).

import * as THREE from 'three';
import { frameOf } from './sections.js';

const FILL = 0.82; // the slices' opacity: a field to read, with the model still showing through
const ARROW_STEP = 0.8; // m between arrows, as in the 2D prototype
const ARROW_INK = '#18211F';

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
  }

  hide() {
    this.clear();
    this.visible = false;
    this.view.render();
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
  // model coordinates; field: 'temperature', 'speed' or '' (arrows only); arrows: draw them; colour(v,
  // range): a THREE.Color; grid: the room cells, for their extent and spacing. Returns the values'
  // range on the slices.
  update(sample, field, colour, grid, arrows) {
    const v = this.view, o = v.origin;
    this.clear();
    const planes = v.sections.planes;
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
      if (arrows) this.arrows(sample, f, [u0, u1, v0, v1], i);
    });
    // Colour with a common range, then show.
    const all = out.flatMap((s) => s.values.filter((x) => x !== null));
    const range = field === 'speed' ? null : all.length ? [Math.min(...all), Math.max(...all)] : [20, 24];
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
    return { texture, values };
  }

  // Arrows for the air's movement within a plane: its velocity's part along the plane, every
  // ARROW_STEP, as long as that step at 1 m/s or more.
  arrows(sample, f, [u0, u1, v0, v1], i) {
    const o = this.view.origin, pts = [];
    const L = ARROW_STEP * 0.85, vmax = 1;
    for (let b = v0 + ARROW_STEP / 2; b < v1; b += ARROW_STEP) {
      for (let a = u0 + ARROW_STEP / 2; a < u1; a += ARROW_STEP) {
        const p = f.o.clone().addScaledVector(f.u, a).addScaledVector(f.v, b).addScaledVector(f.n, -0.01);
        const x = p.x + o[0], y = p.y + o[1], z = p.z + o[2];
        if (!sample.inside(x, y, z)) continue;
        const vel = new THREE.Vector3(...sample.velocity(x, y, z));
        const du = vel.dot(f.u), dv = vel.dot(f.v), sp = Math.hypot(du, dv);
        if (sp < 0.02) continue;
        const len = Math.min(1, sp / vmax) * L, dir = f.u.clone().multiplyScalar(du / sp).addScaledVector(f.v, dv / sp);
        const side = f.n.clone().cross(dir); // in the plane, across the arrow
        const tail = p.clone().addScaledVector(dir, -len / 2), tip = p.clone().addScaledVector(dir, len / 2);
        const hl = Math.min(0.18, len * 0.4);
        const back = tip.clone().addScaledVector(dir, -hl * 0.85);
        pts.push(tail, tip, tip, back.clone().addScaledVector(side, hl * 0.5), tip, back.clone().addScaledVector(side, -hl * 0.5));
      }
    }
    if (!pts.length) return;
    const material = new THREE.LineBasicMaterial({ color: ARROW_INK, transparent: true, opacity: 0.8 });
    this.view.sections.patch(material, i);
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), material);
    lines.renderOrder = 4;
    this.group.add(lines);
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
