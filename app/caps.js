// What a section plane cuts through, drawn as on a drawing: each wall, floor and roof solid's cut
// face filled with the Solar Shading Explorer's poche hatch (45 degrees, 5 px apart, 1 px lines in
// --ink3, on the panel colour) and outlined in --ink. Computed on the CPU from the view's solids (walls
// drawn at their thickness), cropped to each plane's bounds, and redrawn whenever a plane moves.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { frameOf } from './sections.js';

const PAPER = '#FDFDFC', INK = '#18211F';
const HATCH = [125 / 255, 138 / 255, 135 / 255]; // --ink3, as drawn
const SPACING = 5, LINE = 1, EDGE = 1.1; // CSS px

export class SectionCaps {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    view.scene.add(this.group);
  }

  clear() {
    for (const o of [...this.group.children]) { o.geometry?.dispose(); o.material?.dispose(); this.group.remove(o); }
  }

  update() {
    this.clear();
    const v = this.view, solids = v.solids || [];
    if (!solids.length) { v.render(); return; }
    const dpr = v.renderer.getPixelRatio(), size = v.renderer.getDrawingBufferSize(new THREE.Vector2());
    v.sections.planes.forEach((p, i) => {
      const f = frameOf(p), rect = p.b;
      const fill = [], edges = [];
      for (const tris of solids) {
        const segs = cutSolid(tris, f);
        if (!segs.length) continue;
        for (const loop of chain(segs)) {
          if (loop.length < 3) continue;
          let faces;
          try { faces = THREE.ShapeUtils.triangulateShape(loop, []); } catch { continue; }
          for (const t of faces) for (const piece of clipPolygon(t.map((k) => loop[k]), rect)) fill.push(piece);
        }
        for (const [a, b] of segs) { const c = clipSegment(a, b, rect); if (c) edges.push(c); }
      }
      const to3 = (q) => f.o.clone().addScaledVector(f.u, q.x).addScaledVector(f.v, q.y);
      if (fill.length) {
        const pts = [];
        for (const poly of fill) for (let k = 1; k + 1 < poly.length; k++) pts.push(to3(poly[0]), to3(poly[k]), to3(poly[k + 1]));
        const material = new THREE.MeshBasicMaterial({ color: PAPER, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        v.sections.patch(material, i, (shader) => {
          shader.uniforms.hatchPx = { value: dpr };
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float hatchPx;')
            .replace('#include <dithering_fragment>', `#include <dithering_fragment>
if (mod((gl_FragCoord.x + gl_FragCoord.y) * 0.70710678, ${SPACING.toFixed(1)} * hatchPx) < ${LINE.toFixed(1)} * hatchPx) gl_FragColor.rgb = vec3(${HATCH.map((x) => x.toFixed(4)).join(', ')});`);
        });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(pts), material);
        mesh.renderOrder = 1;
        this.group.add(mesh);
      }
      if (edges.length) {
        const g = new LineSegmentsGeometry().setPositions(edges.flatMap(([a, b]) => [...to3(a).toArray(), ...to3(b).toArray()]));
        const material = new LineMaterial({ color: INK, linewidth: EDGE * dpr, resolution: size });
        const lines = new LineSegments2(g, material);
        lines.userData.noSection = true; // a ShaderMaterial: cut by the patch it cannot take
        lines.renderOrder = 5;
        this.group.add(lines);
      }
    });
    v.render();
  }

  // The outlines' width is in pixels of the drawing buffer, which changes with the view's size.
  resize() {
    const size = this.view.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const o of this.group.children) if (o.material?.isLineMaterial) o.material.resolution.copy(size);
  }
}

// The segments where a closed solid (flat triangle array) crosses a plane, in the plane's u, v.
function cutSolid(tris, f) {
  const segs = [], P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], d = [0, 0, 0];
  for (let i = 0; i < tris.length; i += 9) {
    let pos = 0, neg = 0;
    for (let k = 0; k < 3; k++) {
      P[k].set(tris[i + 3 * k], tris[i + 3 * k + 1], tris[i + 3 * k + 2]).sub(f.o);
      d[k] = P[k].dot(f.n);
      if (d[k] === 0) d[k] = 1e-9; // on the plane counts as just in front
      if (d[k] > 0) pos++; else neg++;
    }
    if (!pos || !neg) continue;
    const ends = [];
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3;
      if ((d[a] > 0) === (d[b] > 0)) continue;
      const t = d[a] / (d[a] - d[b]);
      const q = P[a].clone().lerp(P[b], t);
      ends.push(new THREE.Vector2(q.dot(f.u), q.dot(f.v)));
    }
    if (ends.length === 2 && ends[0].distanceToSquared(ends[1]) > 1e-12) segs.push(ends);
  }
  return segs;
}

// Segments joined end to end into closed loops (points rounded to 0.1 mm to match).
function chain(segs) {
  const key = (p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const next = new Map();
  for (const [a, b] of segs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const k = key(x);
      if (!next.has(k)) next.set(k, []);
      next.get(k).push(y);
    }
  }
  const used = new Set(), loops = [];
  for (const [a] of segs) {
    const start = key(a);
    if (used.has(start)) continue;
    const loop = [];
    let p = a, prev = null;
    for (let guard = 0; guard < 100000; guard++) {
      const k = key(p);
      if (used.has(k)) break;
      used.add(k);
      loop.push(p);
      const options = (next.get(k) || []).filter((q) => !prev || key(q) !== key(prev));
      if (!options.length) break;
      prev = p;
      p = options.find((q) => !used.has(key(q))) || options[0];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// A polygon (u, v points) clipped to a rectangle [u0, u1, v0, v1] (Sutherland-Hodgman); [] or [polygon].
function clipPolygon(poly, [u0, u1, v0, v1]) {
  const edges = [[(p) => p.x - u0, 0, u0], [(p) => u1 - p.x, 0, u1], [(p) => p.y - v0, 1, v0], [(p) => v1 - p.y, 1, v1]];
  let out = poly;
  for (const [inside, axis, at] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const ia = inside(a) >= 0, ib = inside(b) >= 0;
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = axis === 0 ? (at - a.x) / (b.x - a.x) : (at - a.y) / (b.y - a.y);
        out.push(a.clone().lerp(b, t));
      }
    }
    if (!out.length) return [];
  }
  return out.length >= 3 ? [out] : [];
}

// A segment clipped to a rectangle (Liang-Barsky); null if outside.
function clipSegment(a, b, [u0, u1, v0, v1]) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - u0], [dx, u1 - a.x], [-dy, a.y - v0], [dy, v1 - a.y]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [a.clone().lerp(b, t0), a.clone().lerp(b, t1)];
}
