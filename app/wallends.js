// A drawn wall standing free, selected in the 3D view: a grip at each end of its line, on its base
// level. A grip dragged moves that end, snapping as Draw wall does (walls' and zones' ends and middles,
// square onto a wall, along one; Shift: 45° steps from the other end); a space the wall then closes is
// made a zone. The figure beside it is the wall's length.

import * as THREE from 'three';
import { gripMark, line, label, CLICK_PX } from './handles.js';
import { moveWallEnd, turnPlan } from '../src/model/massing.js';

export class WallEnds3D {
  // view: the View3D; massing() -> the massing; selected() -> the selection's name; change(mutate, what);
  // tools: the ModelTools (their snaps)
  constructor(view, { massing, selected, change, tools }) {
    Object.assign(this, { view, massing, selected, change, tools });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles wallends');
    view.container.appendChild(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.drag = null;
  }
  // the selected free wall, or null
  wall() {
    const m = this.massing(), n = this.selected();
    if (!m || !String(n || '').startsWith('wall:')) return null;
    return m.walls?.find((w) => w.id === Number(n.slice(5))) || null;
  }
  // the point under the pointer on the level plane at height z (the massing's own plan axes)
  pointAt(e, z) {
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect(), o = v.origin || [0, 0, 0], m = this.massing();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z - o[2])), new THREE.Vector3());
    return hit ? turnPlan([hit.x + o[0], hit.y + o[1]], -(m?.rot || 0)) : null;
  }
  draw() {
    const w = this.wall(), v = this.view;
    const canvas = v.renderer.domElement, cr = canvas.getBoundingClientRect(), kr = v.container.getBoundingClientRect();
    Object.assign(this.svg.style, { left: `${cr.left - kr.left}px`, top: `${cr.top - kr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` });
    if (!w || this.tools.tool) { this.svg.innerHTML = ''; return; }
    const m = this.massing(), z = m.levels[w.base].z, P = (p) => this.tools.P3([p[0], p[1], z]), d = this.drag;
    const a = d?.end === 'a' && d.p ? d.p : w.a, b = d?.end === 'b' && d.p ? d.p : w.b, A = P(a), B = P(b);
    let g = '';
    if (d?.p) {
      g += line(A[0], A[1], B[0], B[1], { stroke: 'var(--glass)', w: 2 });
      g += this.tools.snapMark(d.end === 'a' ? A : B, d.kind);
      g += label((A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 12, `${Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1000)} mm`, { size: 9, fill: 'var(--glass)' });
    }
    g += `<g data-end="a" style="pointer-events:auto;cursor:move">${gripMark(A[0], A[1], 5)}</g><g data-end="b" style="pointer-events:auto;cursor:move">${gripMark(B[0], B[1], 5)}</g>`;
    this.svg.innerHTML = g;
  }
  down(e) {
    const g = e.target.closest('[data-end]'), w = this.wall();
    if (!g || !w || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const end = g.dataset.end, other = end === 'a' ? w.b : w.a, z = this.massing().levels[w.base].z, x0 = e.clientX, y0 = e.clientY;
    this.drag = { end, p: null, kind: null };
    const move = (ev) => {
      if (!this.drag.p && Math.hypot(ev.clientX - x0, ev.clientY - y0) < CLICK_PX) return;
      const raw = this.pointAt(ev, z);
      if (!raw) return;
      const s = this.tools.snapEnd(null, ev, this.massing(), raw, w, other);
      Object.assign(this.drag, { p: s.p, kind: s.kind });
      this.draw();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const p = this.drag.p;
      this.drag = null;
      if (p) this.change((x) => { if (moveWallEnd(x, w.id, end, p) === false) return false; }, 'wall end moved');
      this.draw();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
}
