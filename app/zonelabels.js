// Zone labels in the 3D view: a tag at each zone's middle, drawn over the building, that selects the
// whole zone; a click on a wall, floor or roof selects that surface instead. Tags of zones a plan cut
// leaves below it are put away, so a plan shows its own storey's names; tags in removed space go too.

import * as THREE from 'three';
import { triangulate } from '../src/model/geometry.js';
import { removes } from './sections.js';

// A zone's floor centre (area-weighted), at the given height above its floor; building coordinates.
function anchorOf(model, zone, above = 1.2) {
  const z = model.zones[zone];
  const floors = z.surfaces.map((n) => model.surfaces[n]).filter((s) => s.surfaceType === 'Floor');
  let ax = 0, ay = 0, total = 0;
  for (const f of floors.length ? floors : z.surfaces.map((n) => model.surfaces[n])) {
    for (const [i, j, k] of triangulate(f.vertices)) {
      const [a, b, c] = [f.vertices[i], f.vertices[j], f.vertices[k]];
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      ax += ((a[0] + b[0] + c[0]) / 3) * area; ay += ((a[1] + b[1] + c[1]) / 3) * area; total += area;
    }
  }
  return [ax / (total || 1), ay / (total || 1), z.bottom + Math.min(above, z.height / 2)];
}

export class ZoneLabels {
  // onPick(zone name) when a tag is clicked.
  constructor(view, onPick) {
    this.view = view;
    this.visible = true;
    this.layer = document.createElement('div');
    this.layer.className = 'zlabels';
    view.container.appendChild(this.layer);
    this.layer.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-zone]');
      if (!b) return;
      const r = view.container.getBoundingClientRect();
      view.lastPick = [e.clientX - r.left, e.clientY - r.top];
      onPick(b.dataset.zone);
    });
    // A drag that starts on a tag still orbits or pans the view.
    this.layer.addEventListener('pointerdown', (e) => { if (e.button !== 0) view.renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', e)); });
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    this.tags = [];
  }

  setModel(model) {
    this.model = model;
    this.layer.innerHTML = '';
    this.tags = Object.keys(model.zones).map((zone) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ztag';
      el.dataset.zone = zone;
      el.textContent = zone;
      el.title = `Zone ${zone}: click to select the whole zone and see its settings`;
      this.layer.appendChild(el);
      return { zone, el, at: anchorOf(model, zone), top: model.zones[zone].top };
    });
    this.select(this.selected);
    this.update();
  }

  setVisible(on) { this.visible = on; this.layer.hidden = !on; this.update(); }

  select(zone) {
    this.selected = zone || null;
    for (const t of this.tags) t.el.classList.toggle('on', t.zone === this.selected);
  }

  // After each frame: each tag at its zone's middle on screen, or put away.
  update() {
    if (!this.visible || !this.model) return;
    const v = this.view, o = v.origin, r = v.renderer.domElement, w = r.clientWidth, h = r.clientHeight;
    const plans = v.sections.planes.filter((p) => p.kind === 'plan' && !p.flip);
    const p = new THREE.Vector3();
    for (const t of this.tags) {
      p.set(t.at[0] - o[0], t.at[1] - o[1], t.at[2] - o[2]);
      // Below a plan cut that covers it: a storey under the one the plan shows.
      const under = plans.some((pl) => t.top - o[2] < pl.o.z - 0.05 && removes(pl, new THREE.Vector3(p.x, p.y, pl.o.z + 0.01)));
      let show = !under && !v.sections.removed(p);
      if (show) {
        p.project(v.camera);
        show = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
        if (show) t.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
      }
      t.el.hidden = !show;
    }
  }
}
