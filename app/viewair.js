// The air in a plan or section view: the very cut its linked clipping plane shows in 3D (slices.js) -
// the same slice, its texture drawn over the view's drawing where the plane cuts it, and the same
// particles, drawn where they are at every frame - so the settings are the plane's, shared with 3D,
// and nothing is sampled again to draw it: panning and zooming only draw the same picture elsewhere.
// Pointing at the air shows its values there and outlines the room air's cell, as in 3D.
//
// Under the drawing: its cut walls and floors (filled) draw over the air, as the 3D view's walls do;
// its lines and the editor's layer over both.
//
// new ViewAir(drawing, { slices, plane, origin, busy }) ; .draw() ; .frame() ; .dispose()
// drawing: the workspace's Drawing (host, frame(), toPx, fromPx); plane(): the clipping plane linked
// to the view, or null; busy(e): whether the pointer is at other work (a tool, a drag).

export class ViewAir {
  constructor(d, { slices, plane, origin = () => [0, 0, 0], busy = () => false }) {
    Object.assign(this, { d, slices, plane, origin, busy });
    this.fill = document.createElement('canvas');
    this.parts = document.createElement('canvas');
    for (const c of [this.fill, this.parts]) c.className = 'viewair';
    this.probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.probe.setAttribute('class', 'viewprobe');
    this.tag = document.createElement('div');
    this.tag.className = 'probetag viewtag'; this.tag.hidden = true;
    d.host.append(this.fill, this.parts, this.probe, this.tag);
    this.cache = null; // the slice as an image, kept while its stamp holds
    this.onMove = (e) => this.probeAt(e);
    this.onLeave = () => this.hideProbe();
    d.host.addEventListener('pointermove', this.onMove);
    d.host.addEventListener('pointerleave', this.onLeave);
  }
  dispose() { for (const el of [this.fill, this.parts, this.probe, this.tag]) el.remove(); this.d.host.removeEventListener('pointermove', this.onMove); this.d.host.removeEventListener('pointerleave', this.onLeave); }

  // the canvases sized to the view and kept under the drawing (it is drawn again on every change)
  place() {
    const w = Math.floor(this.d.host.clientWidth), h = Math.floor(this.d.host.clientHeight), dwg = this.d.host.querySelector('svg.dwg');
    for (const c of [this.fill, this.parts]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (dwg && (this.parts.nextElementSibling !== dwg || this.fill.nextElementSibling !== this.parts)) { this.d.host.insertBefore(this.fill, dwg); this.d.host.insertBefore(this.parts, dwg); }
    return [w, h];
  }
  // A point of the view's cut (view coordinates, { x, y, z }) on the drawing (px). The drawing's (u, v)
  // are the cut's frame's, mirrored where it would be seen from behind (drawings.js).
  pxOf(q) {
    const f = this.d.frame()?.f;
    if (!f) return null;
    const mir = f.u.clone().cross(f.v).dot(f.n) < 0 ? -1 : 1, d = [q.x - f.o.x, q.y - f.o.y, q.z - f.o.z];
    return this.d.toPx(mir * (d[0] * f.u.x + d[1] * f.u.y + d[2] * f.u.z), d[0] * f.v.x + d[1] * f.v.y + d[2] * f.v.z);
  }
  // A point on the drawing (px) on the cut, in model coordinates (just behind the cut, as 3D probes).
  modelAt(x, y) {
    const f = this.d.frame()?.f, o = this.origin();
    if (!f) return null;
    const mir = f.u.clone().cross(f.v).dot(f.n) < 0 ? -1 : 1, [a, b] = this.d.fromPx(x, y);
    const p = f.o.clone().addScaledVector(f.u, mir * a).addScaledVector(f.v, b).addScaledVector(f.n, -0.02);
    return [p.x + o[0], p.y + o[1], p.z + o[2]];
  }

  // The plane's slice drawn where it lies on this view: its texture, stretched as the plane lays it.
  draw() {
    const [w, h] = this.place(), c = this.fill.getContext('2d'), p = this.plane();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    const s = p && !p.off && p.air.field ? p.slice : null;
    if (!s) return;
    if (!this.cache || this.cache.stamp !== s.stamp) {
      const img = new OffscreenCanvas(s.W, s.H);
      img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.data), s.W, s.H), 0, 0);
      this.cache = { stamp: s.stamp, img };
    }
    const at = (x, y) => this.pxOf({ x: s.start.x + (s.u.x * x + s.v.x * y) * s.step, y: s.start.y + (s.u.y * x + s.v.y * y) * s.step, z: s.start.z + (s.u.z * x + s.v.z * y) * s.step });
    const P0 = at(0, 0), PX = at(1, 0), PY = at(0, 1);
    if (!P0 || !PX || !PY) return;
    c.imageSmoothingEnabled = true;
    c.globalAlpha = p.air.fillOpacity ?? 0.82;
    c.setTransform(PX[0] - P0[0], PX[1] - P0[1], PY[0] - P0[0], PY[1] - P0[1], P0[0], P0[1]);
    c.drawImage(this.cache.img, 0, 0);
  }

  // The plane's particles where they are now (each frame of the 3D view's particles), trailing.
  frame() {
    const [w, h] = this.place(), c = this.parts.getContext('2d'), p = this.plane(), t = p && !p.off && p.air.particles ? this.slices.trails?.get(p) : null;
    c.clearRect(0, 0, w, h);
    if (!t?.uv || !t.n) return;
    const f = t.f, o = f.o, n = t.n, H2 = t.uv.length / n;
    const at = (a, b) => this.pxOf({ x: o.x + f.u.x * a + f.v.x * b, y: o.y + f.u.y * a + f.v.y * b, z: o.z + f.u.z * a + f.v.z * b });
    c.globalAlpha = p.air.partOpacity ?? 1;
    c.lineWidth = 1.2;
    for (let k = 0; k < n; k++) {
      if (!t.born[k]) continue;
      const i = k * H2, col = p.air.color === 'plain' ? '#18211F' : `rgb(${Math.round(t.tint[k * 3] * 255)},${Math.round(t.tint[k * 3 + 1] * 255)},${Math.round(t.tint[k * 3 + 2] * 255)})`;
      c.strokeStyle = col; c.fillStyle = col;
      c.beginPath();
      for (let j = 0; j < H2; j += 2) { const q = at(t.uv[i + j], t.uv[i + j + 1]); if (!q) return; if (j) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }
      c.stroke();
      const head = at(t.uv[i], t.uv[i + 1]);
      c.fillRect(head[0] - 1.2, head[1] - 1.2, 2.4, 2.4);
    }
  }

  // Pointing at the air: its values beside the pointer, and the room air's cell outlined where the cut
  // passes through it.
  probeAt(e) {
    const p = this.plane(), sl = this.slices;
    if (!p || p.off || (!p.air.field && !p.air.particles) || !sl.visible || !sl.sample || !sl.grid || e.buttons || this.busy(e)) { this.hideProbe(); return; }
    const r = this.d.host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, point = this.modelAt(x, y);
    if (!point || !sl.sample.inside(...point)) { this.hideProbe(); return; }
    const f = this.d.frame()?.f, o = this.origin();
    let outline = '';
    if (Math.abs(f?.n.z ?? 1) > 0.9) {
      // a plan cuts across the cells' columns: the cell's square where the cut passes through it
      const { lo, hi, back } = sl.cellAt(point), pts = [];
      for (const q of [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]) {
        const m = back([q[0], q[1], point[2]]), px = this.pxOf({ x: m[0] - o[0], y: m[1] - o[1], z: m[2] - o[2] });
        if (px) pts.push(px.map((v) => v.toFixed(1)).join(','));
      }
      outline = `<polygon points="${pts.join(' ')}" fill="none" stroke="#18211F" stroke-width="1.2"/>`;
    } else outline = `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#18211F" stroke-width="1.2"/>`;
    this.probe.setAttribute('width', r.width); this.probe.setAttribute('height', r.height);
    this.probe.innerHTML = outline;
    this.tag.innerHTML = sl.probeHTML({ point, plane: p });
    this.tag.style.transform = `translate(${x + 14}px, ${y - 30}px)`;
    this.tag.hidden = false;
  }
  hideProbe() { if (this.probe.innerHTML) this.probe.innerHTML = ''; this.tag.hidden = true; }
}
