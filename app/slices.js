// Plan and section slices of the air: the horizontal cut and the vertical section, coloured by air
// temperature or speed where they pass through rooms (transparent elsewhere), from the grid solver
// or ideal flow. Each slice is a plane with a texture sampled at about half a cell's spacing.

import * as THREE from 'three';

const FILL = 0.82; // the slices' opacity: a field to read, with the model still showing through

// Temperature: blue through pale to red over the range given; speed: the particles' log scale.
const COOL = new THREE.Color('#1F6FE0'), MID = new THREE.Color('#EEF1F4'), WARM = new THREE.Color('#E0401F');
export function rampTemperature(t, lo, hi, out = new THREE.Color()) {
  const x = hi > lo ? Math.max(0, Math.min(1, (t - lo) / (hi - lo))) * 2 - 1 : 0;
  return x < 0 ? out.copy(MID).lerp(COOL, -x) : out.copy(MID).lerp(WARM, x);
}

export class FieldSlices {
  constructor(view) {
    this.view = view;
    this.plan = this.layer();
    this.section = this.layer();
  }

  layer() {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    mesh.visible = false;
    mesh.renderOrder = 2;
    this.view.scene.add(mesh);
    return mesh;
  }

  hide() { this.plan.visible = false; this.section.visible = false; this.view.render(); }

  // sample: { inside(x, y, z) -> bool, value(x, y, z) -> number } in model coordinates; field:
  // 'temperature' or 'speed'; colour(v, range): a THREE.Color. Returns the values' range on the slices.
  update(sample, field, colour, grid) {
    const v = this.view, o = v.origin;
    const out = [];
    // Plan: at the horizontal cut, a little below it so it is not cut away itself.
    const cut = v.cutPlane.constant + o[2];
    if (Number.isFinite(v.cutPlane.constant)) {
      const z = cut - 0.02;
      out.push(this.paint(this.plan, sample, [grid.min[0], grid.min[1], z], [1, 0, 0], [0, 1, 0], grid.nx * grid.h, grid.ny * grid.h, grid.h / 2, [v.sectionPlane]));
    } else this.plan.visible = false;
    // Section: in the vertical plane, from the bottom of the grid to the top.
    const sp = v.sectionPlane;
    if (Number.isFinite(sp.constant)) {
      const n = sp.normal, along = [-n.y, n.x, 0];
      // A point on the plane (model coordinates), at the grid's centre, nudged to the kept side.
      const c = [grid.min[0] + (grid.nx * grid.h) / 2 - o[0], grid.min[1] + (grid.ny * grid.h) / 2 - o[1]];
      const d = -(n.x * c[0] + n.y * c[1] + sp.constant) + 0.02;
      const p0 = [c[0] + n.x * d + o[0], c[1] + n.y * d + o[1]];
      const half = Math.hypot(grid.nx, grid.ny) * grid.h / 2;
      const start = [p0[0] - along[0] * half, p0[1] - along[1] * half, grid.min[2]];
      out.push(this.paint(this.section, sample, start, along, [0, 0, 1], 2 * half, grid.nz * grid.h, grid.h / 2, [v.cutPlane]));
    } else this.section.visible = false;
    // Colour with a common range, then show.
    const all = out.flatMap((s) => s.values.filter((x) => x !== null));
    const range = field === 'speed' ? null : all.length ? [Math.min(...all), Math.max(...all)] : [20, 24];
    for (const s of out) {
      const data = s.texture.image.data;
      s.values.forEach((val, i) => {
        if (val === null) { data[i * 4 + 3] = 0; return; }
        const col = colour(val, range);
        data[i * 4] = col.r * 255; data[i * 4 + 1] = col.g * 255; data[i * 4 + 2] = col.b * 255; data[i * 4 + 3] = FILL * 255;
      });
      s.texture.needsUpdate = true;
    }
    v.render();
    return range;
  }

  // Fills one slice: a rectangle from `start` along unit vectors u and w, sized su x sw, sampled every step.
  paint(mesh, sample, start, u, w, su, sw, step, clip) {
    const W = Math.max(2, Math.ceil(su / step)), H = Math.max(2, Math.ceil(sw / step));
    const values = new Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const s = (i + 0.5) * step, t = (j + 0.5) * step;
        const x = start[0] + u[0] * s + w[0] * t, y = start[1] + u[1] * s + w[1] * t, z = start[2] + u[2] * s + w[2] * t;
        values[i + j * W] = sample.inside(x, y, z) ? sample.value(x, y, z) : null;
      }
    }
    let texture = mesh.material.map;
    if (!texture || texture.image.width !== W || texture.image.height !== H) {
      texture?.dispose();
      texture = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      mesh.material.map = texture;
      mesh.material.needsUpdate = true;
    }
    const o = this.view.origin;
    const corner = (s, t) => [start[0] + u[0] * s + w[0] * t - o[0], start[1] + u[1] * s + w[1] * t - o[1], start[2] + u[2] * s + w[2] * t - o[2]];
    const [a, b, c, d] = [corner(0, 0), corner(W * step, 0), corner(W * step, H * step), corner(0, H * step)];
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BufferGeometry();
    mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    mesh.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    mesh.material.clippingPlanes = clip;
    mesh.visible = true;
    return { texture, values };
  }
}
