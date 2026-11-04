// What a click would select, shown before the click. Under the pointer there are often several
// things that could be meant: a window, the wall it sits in, that wall's other side in the next zone
// (a shared wall is two surfaces, one per zone), and the zones on either side. The first is offered;
// Tab steps to the next (Shift+Tab back), and a click selects the one offered. It is outlined dotted,
// whole and through anything in front, the part a clipping plane removes included, with its name in
// a tag beside the pointer. The likeliest is offered as soon as the pointer is over it.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const LINE = '#2F6F68'; // --glass: the drawing style's colour for selection and editing
const WIDTH = 2.6; // px: heavier than the edges under it, so it reads over them

export class HoverPick {
  // candidatesAt(event) -> [{ kind, name, label, polys }] under the pointer, the likeliest first;
  // edgesOf(candidate) -> its outline as a flat list of segment ends (view coordinates).
  constructor(view, { candidatesAt, edgesOf }) {
    Object.assign(this, { view, candidatesAt, edgesOf });
    this.enabled = true;
    this.list = [];
    this.index = 0;
    this.at = null; // where the pointer was, in the page
    this.layer = document.createElement('div');
    this.layer.className = 'zlabels';
    view.container.appendChild(this.layer);
    this.tag = document.createElement('div');
    this.tag.className = 'ztag';
    this.tag.hidden = true;
    this.layer.appendChild(this.tag);
    this.outline = new THREE.Group();
    this.outline.userData.noSection = true; // drawn whole, through the cuts
    view.scene.add(this.outline);
    const el = view.renderer.domElement;
    let pending = false, last = null;
    el.addEventListener('pointermove', (e) => {
      last = e;
      if (pending || e.buttons) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this.hover(last); });
    });
    el.addEventListener('pointerleave', () => this.clear());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !this.list.length || e.target.closest?.('input, select, textarea')) return;
      e.preventDefault();
      this.index = (this.index + (e.shiftKey ? this.list.length - 1 : 1)) % this.list.length;
      this.show();
    });
  }

  setEnabled(on) { this.enabled = on; if (!on) this.clear(); }
  setLabels(on) { this.labels = on; this.show(); }

  // The pointer moved: what is under it now. The likeliest is offered (a window over its wall, the wall
  // between windows); a choice made with Tab holds only while the likeliest stays the same.
  hover(e) {
    if (!this.enabled || this.view.sections.placing || this.view.busy?.(e)) { this.clear(); return; }
    const list = this.candidatesAt(e), key = (c) => (c ? `${c.kind}:${c.name}` : '');
    const now = this.current, same = key(list[0]) === key(this.list[0]);
    const keep = same && now ? list.findIndex((c) => key(c) === key(now)) : -1;
    this.list = list;
    this.index = keep >= 0 ? keep : 0;
    this.at = [e.clientX, e.clientY];
    this.show();
  }

  get current() { return this.list[this.index] || null; }

  // The candidate a click at this point selects: the one offered, if the pointer has not moved off.
  pickFor(e) {
    if (!this.current || !this.at || Math.hypot(e.clientX - this.at[0], e.clientY - this.at[1]) > 4) return null;
    return this.current;
  }

  clear() {
    this.list = [];
    this.index = 0;
    this.show();
  }

  show() {
    for (const o of [...this.outline.children]) { o.geometry.dispose(); o.material.dispose(); this.outline.remove(o); }
    const c = this.current;
    if (!c) { this.tag.hidden = true; this.view.render(); return; }
    const g = new LineSegmentsGeometry().setPositions(this.edgesOf(c));
    const size = this.view.renderer.getSize(new THREE.Vector2());
    const line = new LineSegments2(g, new LineMaterial({ color: LINE, linewidth: WIDTH, dashed: true, dashSize: 0.3, gapSize: 0.18, depthTest: false, transparent: true, opacity: 0.95, resolution: size }));
    line.computeLineDistances();
    line.renderOrder = 16;
    this.outline.add(line);
    const r = this.view.container.getBoundingClientRect();
    this.tag.textContent = this.list.length > 1 ? `${c.label}  ·  Tab ${this.index + 1}/${this.list.length}` : c.label;
    this.tag.hidden = this.labels === false;
    this.tag.style.transform = `translate(${this.at[0] - r.left + 14}px, ${this.at[1] - r.top + 14}px)`;
    this.view.render();
  }
}
