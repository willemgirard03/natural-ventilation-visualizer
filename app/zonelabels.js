// Zone tags in the 3D view. A zone that a plan or section plane cuts through shows its tag when the
// pointer is over it: near the pointer, not at the zone's middle, since a ring-shaped zone and a zone
// in its hole share a middle. The tag stays where it appeared while the pointer stays in that zone, so
// it can be reached and clicked: a click on the tag selects the whole zone; a click on a wall, floor
// or roof selects that surface (a double click on one selects its zone).
//
// The zone under the pointer, and the selected zone, are outlined dotted in full, the part a plane
// cuts away included, so a zone's extent reads in plan and section.

import * as THREE from 'three';
import { frameOf } from './sections.js';

const HOVER = '#4B5855', PICKED = '#F2A900';

// Each zone's edges once (view coordinates), for its dotted outline.
function zoneEdges(model, zone, origin) {
  const seen = new Set(), pos = [];
  const key = (p) => p.map((x) => x.toFixed(3)).join(',');
  for (const n of model.zones[zone].surfaces) {
    const v = model.surfaces[n].vertices;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length], k = [key(a), key(b)].sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      pos.push(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2], b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]);
    }
  }
  return pos;
}

export class ZoneLabels {
  // onPick(zone name) when a tag is clicked; zoneAt(event) -> the zone of the surface under the pointer.
  constructor(view, { onPick, zoneAt }) {
    this.view = view;
    this.zoneAt = zoneAt;
    this.visible = true;
    this.layer = document.createElement('div');
    this.layer.className = 'zlabels';
    view.container.appendChild(this.layer);
    this.tag = document.createElement('button');
    this.tag.type = 'button';
    this.tag.className = 'ztag';
    this.tag.hidden = true;
    this.layer.appendChild(this.tag);
    this.tag.addEventListener('click', () => { if (this.hovered) onPick(this.hovered); });
    this.tag.addEventListener('pointerenter', () => { this.onTag = true; clearTimeout(this.leave); });
    this.tag.addEventListener('pointerleave', () => { this.onTag = false; });
    this.outlines = new THREE.Group();
    this.outlines.userData.noSection = true; // drawn whole, through the cuts
    view.scene.add(this.outlines);
    const el = view.renderer.domElement;
    let pending = false, last = null;
    el.addEventListener('pointermove', (e) => {
      last = e;
      if (pending || e.buttons) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this.hover(last); });
    });
    el.addEventListener('pointerleave', () => { this.leave = setTimeout(() => { if (!this.onTag) this.setHover(null); }, 200); });
    this.hovered = null;
    this.selected = null;
  }

  setModel(model) {
    this.model = model;
    this.hovered = null;
    this.tag.hidden = true;
    this.cutCache = null;
    this.drawOutlines();
  }

  setVisible(on) { this.visible = on; if (!on) this.setHover(null); this.drawOutlines(); }

  select(zone) {
    this.selected = zone || null;
    this.drawOutlines();
  }

  // The zones a plane cuts through, within its bounds; recomputed when the planes change.
  cutZones() {
    const v = this.view, planes = v.sections.planes;
    const key = planes.map((p) => `${p.kind}${p.o.x.toFixed(2)},${p.o.y.toFixed(2)},${p.o.z.toFixed(2)},${p.yaw.toFixed(3)},${p.b.map((x) => x.toFixed(2))},${p.flip}`).join(';');
    if (this.cutCache?.key === key) return this.cutCache.zones;
    const zones = new Set(), o = v.origin, q = new THREE.Vector3();
    for (const zone of Object.keys(this.model?.zones || {})) {
      const pts = this.model.zones[zone].surfaces.flatMap((n) => this.model.surfaces[n].vertices);
      for (const p of planes) {
        const f = frameOf(p);
        let lo = Infinity, hi = -Infinity, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const x of pts) {
          q.set(x[0] - o[0], x[1] - o[1], x[2] - o[2]).sub(f.o);
          const d = q.dot(f.n), u = q.dot(f.u), w = q.dot(f.v);
          lo = Math.min(lo, d); hi = Math.max(hi, d); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, w); v1 = Math.max(v1, w);
        }
        if (lo < -1e-3 && hi > 1e-3 && u1 > p.b[0] && u0 < p.b[1] && v1 > p.b[2] && v0 < p.b[3]) { zones.add(zone); break; }
      }
    }
    this.cutCache = { key, zones };
    return zones;
  }

  // The pointer moved over the view: the tag of the cut zone under it, near the pointer.
  hover(e) {
    if (!this.visible || !this.model || this.view.sections.placing) return this.setHover(null);
    const zone = this.zoneAt(e);
    if (!zone || !this.cutZones().has(zone)) {
      if (!this.onTag) this.setHover(null);
      return;
    }
    const r = this.view.container.getBoundingClientRect();
    this.setHover(zone, [e.clientX - r.left, e.clientY - r.top]);
  }

  setHover(zone, at = null) {
    if (zone === this.hovered) return;
    this.hovered = zone;
    if (!zone) { this.tag.hidden = true; this.drawOutlines(); return; }
    this.tag.textContent = zone;
    this.tag.title = `Zone ${zone}: click to select the whole zone and see its settings (a click on a wall, floor or roof selects just that surface)`;
    this.tag.classList.toggle('on', zone === this.selected);
    this.tag.hidden = false;
    // Up and to the right of the pointer, where the zone was entered; it stays there while in the zone.
    this.tag.style.transform = `translate(${at[0] + 12}px, ${at[1] - 26}px)`;
    this.drawOutlines();
  }

  // Dotted outlines of the zone under the pointer and the selected zone, whole and through walls.
  drawOutlines() {
    for (const o of [...this.outlines.children]) { o.geometry.dispose(); o.material.dispose(); this.outlines.remove(o); }
    if (this.model) {
      const show = new Map();
      if (this.visible && this.hovered) show.set(this.hovered, HOVER);
      if (this.selected) show.set(this.selected, PICKED);
      for (const [zone, color] of show) {
        if (!this.model.zones[zone]) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(zoneEdges(this.model, zone, this.view.origin), 3));
        const line = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.18, depthTest: false, transparent: true, opacity: 0.9 }));
        line.computeLineDistances();
        line.renderOrder = 15;
        this.outlines.add(line);
      }
    }
    this.view.render();
  }

  update() {}
}
