// Plans and sections drawn from the 3D view's geometry, in the Solar Shading Explorer's 2D style (the
// drawing-style skill): what the cut passes through filled with the poche hatch and outlined in ink
// (floors and roofs cut solid, in --poche), glass cut as a thick pane, and what lies beyond the cut,
// up to a depth, in fine dotted --ink3 (near ones heavier than far ones). A plan also names the
// zones it cuts; a section marks the levels.
//
// cutGeometry() works in metres on the cut's plane (u right, v up, as seen from the side the cut
// removes); drawSVG() maps it to the pixels of a view, so line weights and the hatch stay true at any
// zoom.

import * as THREE from 'three';
import { cutSolid, chain } from './caps.js';

const r1 = (x) => Math.round(x * 10) / 10;

// The plane as seen: a frame { o, u, v, n } in view coordinates; the side n points to is removed, the
// eye is there, looking along -n. Seen from there, u runs right and v up when u x v = n; otherwise the
// drawing is mirrored so it is never seen from behind.
export function cutGeometry(view, f, { depth = Infinity, near = 4 } = {}) {
  const mirror = f.u.clone().cross(f.v).dot(f.n) < 0 ? -1 : 1;
  const P = (q) => [mirror * q.x, q.y]; // a point on the plane, (u, v) as seen
  const poche = [], slabs = [], lines = [], glass = [], beyond = [], far = [];
  // what the cut passes through: the walls, floors and roofs at their thickness
  const solids = view.solids?.length ? view.solids : null;
  if (solids) {
    for (const tris of solids) {
      const segs = cutSolid(tris, f);
      if (!segs.length) continue;
      const loops = chain(segs).map((L) => L.map(P));
      (horizontal(tris) ? slabs : poche).push(loops);
    }
  } else if (view.front?.geometry) {
    // drawn thin, as modelled: each surface cut is a line
    const g = view.front.geometry, tris = (g.index ? g.toNonIndexed() : g).getAttribute('position').array;
    for (const [a, b] of cutSolid(tris, f)) lines.push([P(a), P(b)]);
  }
  for (const m of [view.glass, view.sashMesh]) {
    if (!m?.geometry) continue;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    for (const [a, b] of cutSolid(g.getAttribute('position').array, f)) glass.push([P(a), P(b)]);
  }
  // beyond: the outlines behind the cut, to the depth asked for
  const e = view.edges?.geometry?.getAttribute('position')?.array || [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), eps = 1e-4;
  for (let i = 0; i < e.length; i += 6) {
    A.set(e[i], e[i + 1], e[i + 2]); B.set(e[i + 3], e[i + 4], e[i + 5]);
    let da = A.clone().sub(f.o).dot(f.n), db = B.clone().sub(f.o).dot(f.n);
    if (da > -eps && db > -eps) continue; // in front of the cut, or on it
    if (da > -eps || db > -eps) { // crossing it: the part behind
      const t = da / (da - db), C = A.clone().lerp(B, t);
      if (da > -eps) { A.copy(C); da = 0; } else { B.copy(C); db = 0; }
    }
    if (Math.min(-da, -db) > depth) continue;
    const ua = A.sub(f.o), ub = B.sub(f.o);
    const s = [P(new THREE.Vector2(ua.dot(f.u), ua.dot(f.v))), P(new THREE.Vector2(ub.dot(f.u), ub.dot(f.v)))];
    if (Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) < 1e-3) continue; // seen end on
    ((-da - db) / 2 < near ? beyond : far).push(s);
  }
  const all = [...poche.flat(2), ...slabs.flat(2), ...lines.flat(), ...glass.flat(), ...beyond.flat(), ...far.flat()];
  const box = all.length ? all.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) : null;
  return { poche, slabs, lines, glass, beyond, far, box, mirror, frame: f };
}

// A solid whose largest faces are level: a floor, a ceiling or a roof.
function horizontal(tris) {
  let level = 0, other = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 9) {
    a.fromArray(tris, i); b.fromArray(tris, i + 3); c.fromArray(tris, i + 6);
    const n = b.sub(a).cross(c.sub(a)), area = n.length();
    if (Math.abs(n.z) > 0.9 * area) level += area; else other += area;
  }
  return level > other;
}

// A point in view coordinates on the drawing, as cutGeometry places it.
export function onPlane(g, q) {
  const d = q.clone().sub(g.frame.o);
  return [g.mirror * d.dot(g.frame.u), d.dot(g.frame.v)];
}

// The drawing as SVG for a view w x h px, its middle at (cx, cy) metres, s px to the metre. marks:
// { labels: [[u, v, text]], levels: [[v, name, figure]] } in metres on the plane.
export function drawSVG(g, { w, h, cx, cy, s }, marks = {}) {
  const X = (u) => r1(w / 2 + (u - cx) * s), Y = (v) => r1(h / 2 - (v - cy) * s);
  const path = (loops) => loops.map((L) => `M${L.map(([u, v]) => `${X(u)} ${Y(v)}`).join('L')}Z`).join('');
  const segs = (list) => list.map(([[a, b], [c, d]]) => `M${X(a)} ${Y(b)}L${X(c)} ${Y(d)}`).join('');
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>`
    + '<pattern id="poche2d" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="var(--panel)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink3)" stroke-width="1"/></pattern></defs>';
  // the levels, under everything: a fine line across with the level's name and height at the left
  // the levels: the one picked in glass; its name, its elevation, and the storey height up to the next
  const lvs = marks.levels || [];
  lvs.forEach(([v, name, fig, L, hgt]) => {
    const y = Y(v), on = L !== undefined && L === marks.sel, col = on ? 'var(--glass)' : 'var(--ink3)';
    if (y < -10 || y > h + 10) return;
    out += `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="${on ? 'var(--glass)' : 'var(--rule)'}" stroke-width="${on ? 1.4 : 0.6}" stroke-dasharray="9 3 2 3"/>`
      + `<text x="6" y="${y - 3}" font-size="8.5" fill="${col}" font-family="var(--mono)" data-lv="${L}"><tspan font-family="var(--sans)" font-weight="600" font-size="9.5" data-lvn="${L}">${esc(name)}</tspan> <tspan class="dfig" data-lv="${L}" data-fig="z">${fig}</tspan></text>`;
    const next = lvs.find((x) => x[3] === L + 1);
    if (hgt && next) { const ym = (y + Y(next[0])) / 2; out += `<text x="6" y="${ym + 3}" font-size="8.5" fill="var(--ink3)" font-family="var(--mono)" class="dfig" data-lv="${L}" data-fig="h">${hgt}</text>`; }
  });
  if (g.far.length) out += `<path d="${segs(g.far)}" fill="none" stroke="var(--ink3)" stroke-width="0.6" stroke-dasharray="1.5 2.5" opacity="0.6"/>`;
  if (g.beyond.length) out += `<path d="${segs(g.beyond)}" fill="none" stroke="var(--ink3)" stroke-width="0.7" stroke-dasharray="2 2.4" opacity="0.85"/>`;
  for (const loops of g.slabs) out += `<path d="${path(loops)}" fill="var(--poche)" fill-rule="evenodd" stroke="var(--ink)" stroke-width="0.7"/>`;
  for (const loops of g.poche) out += `<path d="${path(loops)}" fill="url(#poche2d)" fill-rule="evenodd" stroke="var(--ink)" stroke-width="0.85"/>`;
  if (g.lines.length) out += `<path d="${segs(g.lines)}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>`;
  // glass cut: a pane at least 3 px thick, --shade with an ink edge
  if (g.glass.length) out += `<path d="${segs(g.glass)}" fill="none" stroke="var(--ink)" stroke-width="4.6" stroke-linecap="butt"/><path d="${segs(g.glass)}" fill="none" stroke="var(--shade)" stroke-width="3" stroke-linecap="butt"/>`;
  for (const [u, v, text] of marks.labels || []) {
    const x = X(u), y = Y(v), tw = text.length * 9 * 0.58 + 6;
    out += `<rect x="${r1(x - tw / 2)}" y="${r1(y - 7.5)}" width="${r1(tw)}" height="13" fill="var(--panel)" opacity="0.85"/><text x="${x}" y="${r1(y + 3)}" text-anchor="middle" font-size="9" fill="var(--ink2)" font-family="var(--sans)">${esc(text)}</text>`;
  }
  if (!g.box) out += `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="12" fill="var(--ink3)">The cut passes nothing of the building</text>`;
  return out + `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="var(--rule2)" stroke-width="0.6"/></svg>`;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
