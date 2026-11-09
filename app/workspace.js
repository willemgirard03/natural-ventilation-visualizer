// The views workspace (the view-layout skill): the building in 3D and any number of plan and section
// views, in rows. A + in any margin adds a view; a view's grip moves it; its – takes it off (Undo puts
// it back); the margins between views resize them. There is one 3D view, so the + offers it only
// while it is off the page.
//
// A plan or section view shows one of the building's named views (massing.views, made in the Views
// tab or from a clipping plane's pop-up), picked from its name in the bar. It owns its cut: a plan is
// a level and a height above it (or, made from a plane, an elevation of its own); a section, the frame
// of the plane it came from. While linked to a clipping plane (Cut 3D here, or made from one) the two
// follow each other. The wheel zooms about the pointer; a right (or Shift + right, or middle) drag
// pans; a double click fits. A plan is edited as the 3D view is (planedit.js): its zones, walls and
// windows picked and pushed, and the modelling tools at work on it.
//
// The rows scroll: one row fills the space; with more, each takes most of it, and a row's lower margin
// dragged gives it a height of its own (a double click gives back the default).

import * as THREE from 'three';
import { createLayout, viewShell, settle, RECENTRE, FS_IN, FS_OUT } from './views.js';
import { cutGeometry, drawSVG } from './drawings.js';

const KIND_LABEL = { '3d': 'Building in 3D', plan: 'Plan', section: 'Section' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));

// opts:
//   host, view3dEl     the .views element, and the 3D view's element (kept, never rebuilt)
//   view               the View3D, whose geometry and clipping planes the drawings come from
//   views()            the named plan and section views ([] when none)
//   levels()           the building's levels [{ name, z }] (model z), or null
//   planeOf(id)        the clipping plane linked to a named view, if it still stands
//   onCut3d(id)        Cut 3D here: a plane made for the named view, or the linked one picked
//   onTake(record)     a view taken off the page: keep the record so Undo can put it back
//   editorFor(drawing) a plan's editor (planedit.js), or null; toolsHTML: the modelling tools' buttons
//   hasTools()         whether the tools apply (a massing is open)
export function workspace({ host, view3dEl, view, views, levels, planeOf, onCut3d, onTake, editorFor = () => null, toolsHTML = '', hasTools = () => false }) {
  const kinds = { ...KIND_LABEL };
  const drawings = new Set();
  let version = 0; // bumped when the geometry or a cut changes: the drawings cut again
  const target = document.createElement('div');
  target.className = 'droptarget'; target.hidden = true;
  document.body.appendChild(target);

  // the 3D view's bar takes the layout's grip and –
  const bar3d = view3dEl.querySelector('.vbarrow');
  if (!bar3d.querySelector('.grip')) {
    bar3d.insertAdjacentHTML('afterbegin', '<span class="grip" title="Drag to move this view: to a row\'s top or bottom edge for a row of its own, to a view\'s side to sit beside it, onto a view to swap">⠿</span>');
    bar3d.querySelector('.vbtns').insertAdjacentHTML('afterbegin', '<button type="button" class="minibtn vb" data-vclose title="Remove this view - the others in its row take its place; add one back with the + in any margin">–</button>');
  }

  const layout = createLayout({
    host, dropTarget: target, kinds,
    initial: [{ views: [{ type: '3d' }] }],
    key: null,
    make: (type, saved) => (type === '3d' ? { el: view3dEl } : new Drawing(type, saved?.pin ?? firstOf(type))),
    onChange: changed, onResize: sizeRows,
  });
  // each row its height: its own where dragged; else all the space for a single row, most of it for each of several
  function sizeRows() {
    const rows = [...host.querySelectorAll(':scope > .vrow')], H = host.clientHeight;
    if (!H) return;
    for (const r of rows) r.style.height = `${r.dataset.h ? +r.dataset.h : rows.length === 1 ? Math.max(300, H - 14) : Math.max(300, Math.round(H * 0.62))}px`;
  }
  addEventListener('resize', sizeRows);
  function changed() {
    sizeRows();
    if (host.contains(view3dEl)) delete kinds['3d']; else kinds['3d'] = KIND_LABEL['3d'];
    for (const d of drawings) if (!d.el.isConnected) drawings.delete(d);
  }
  layout.build(true);
  changed();

  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vclose]');
    if (!b) return;
    const el = b.closest('.view');
    if (el.classList.contains('full')) setFull(el, false);
    onTake?.(layout.take(el));
  });

  // the first view of a kind not shown already (else the first of it)
  const firstOf = (type) => {
    const shown = new Set([...drawings].filter((d) => d.el.isConnected).map((d) => d.pin)), of = views().filter((v) => v.kind === type);
    return (of.find((v) => !shown.has(v.id)) || of[0])?.id ?? null;
  };

  // ---------- a plan or section view ----------
  class Drawing {
    constructor(type, pin) {
      const shell = viewShell(type, { [type]: KIND_LABEL[type] }, {
        controls: '<button type="button" class="minibtn" data-cut3d>Cut 3D here</button>'
          + `<button type="button" class="minibtn vb iconbtn" data-fit title="Fit the drawing in the view">${RECENTRE}</button>`,
        info: type === 'plan'
          ? ['Plan', '<p>The building cut across at a height above a level, looking down. What the cut passes through is hatched; floors and walls below it, down to the level, are dotted.</p><p>Point at a room, a wall or a window and click to select it, as in 3D. A selected zone has a grip on each wall: dragged, the wall moves for this zone alone (a wall it shares becomes two). A selected wall has one grip: dragged, it moves for every zone sharing it. The modelling tools work here too.</p><p>Wheel: zoom; right drag (or middle): pan; double click on nothing: fit.</p>']
          : ['Section', '<p>The building cut by a clipping plane, seen from the side the plane removes. What the cut passes through is hatched (floors and roofs solid); what lies beyond is dotted, finer further away. The levels are marked.</p><p>Wheel: zoom; right drag (or middle): pan; double click: fit.</p>'],
      });
      Object.assign(this, shell, { pin, cam: null, geo: null, at: -1, key: '' });
      this.el.dataset.pin = pin ?? '';
      // the modelling tools, on a second row of the bar (plans only)
      this.bar.insertAdjacentHTML('beforeend', `<div class="vbarrow vtools mtools">${toolsHTML}</div>`);
      // over the drawing: the editor's layer (hover, selection, grips) and the tools' previews
      this.host.insertAdjacentHTML('beforeend', '<svg class="planov" xmlns="http://www.w3.org/2000/svg"></svg><svg class="planov" xmlns="http://www.w3.org/2000/svg"></svg>');
      [this.ov, this.tv] = this.host.querySelectorAll('svg.planov');
      this.sel = this.el.querySelector('.vtype');
      this.sel.title = 'Show another plan or section here';
      this.sel.addEventListener('change', () => { this.show(Number(this.sel.value)); });
      this.el.querySelector('[data-cut3d]').addEventListener('click', () => { if (this.pin !== null) onCut3d(this.pin); this.bar3d(); });
      this.el.querySelector('[data-fit]').addEventListener('click', () => { this.cam = null; this.paint(); });
      this.el.querySelector('[data-vfull]').addEventListener('click', () => setFull(this.el, !this.el.classList.contains('full')));
      this.host.classList.add('draw2d');
      this.wire();
      this.setEditor();
      new ResizeObserver(() => this.paint()).observe(this.host);
      drawings.add(this);
      this.options();
      settle(this);
    }
    get item() { return views().find((v) => v.id === this.pin) || null; }
    show(id) {
      this.pin = id; this.el.dataset.pin = id ?? ''; this.cam = null; this.at = -1;
      const v = this.item;
      if (v) this.el.dataset.type = this.type = v.kind;
      this.setEditor();
      this.options(); this.paint();
    }
    // a plan is edited; a section only looked at
    setEditor() {
      const want = this.type === 'plan';
      if (want && !this.editor) this.editor = editorFor(this);
      if (!want && this.editor) { this.editor.dispose(); this.editor = null; this.ov.innerHTML = ''; this.tv.innerHTML = ''; }
      this.el.querySelector('.vtools').hidden = !(want && hasTools());
    }
    // plan coordinates (m) to the drawing's pixels and back
    toPx(u, v) { const c = this.cam, w = this.host.clientWidth, h = this.host.clientHeight; return [w / 2 + (u - c.cx) * c.s, h / 2 - (v - c.cy) * c.s]; }
    fromPx(x, y) { const c = this.cam, w = this.host.clientWidth, h = this.host.clientHeight; return [(x - w / 2) / c.s + c.cx, -(y - h / 2) / c.s + c.cy]; }
    frameNow() { return this.frame(); }
    // the bar's name: every plan and section by name
    options() {
      const list = views(), group = (kind, label) => {
        const of = list.filter((v) => v.kind === kind);
        return of.length ? `<optgroup label="${label}">${of.map((v) => `<option value="${v.id}"${v.id === this.pin ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</optgroup>` : '';
      };
      this.sel.innerHTML = group('plan', 'Plans') + group('section', 'Sections') || `<option>${KIND_LABEL[this.type]}</option>`;
      if (!this.item) this.sel.insertAdjacentHTML('afterbegin', `<option selected disabled>${KIND_LABEL[this.type]}: none</option>`);
      this.el.querySelector('.vtools').hidden = !(this.type === 'plan' && hasTools());
      this.bar3d();
    }
    bar3d() {
      const b = this.el.querySelector('[data-cut3d]'), v = this.item, p = v && planeOf(v.id);
      b.hidden = !v;
      b.setAttribute('aria-pressed', String(!!p));
      b.textContent = p ? 'Cut in 3D' : 'Cut 3D here';
      b.title = p ? `Linked to ${p.name}: moving either moves the other. Click to pick the plane.` : 'Add a clipping plane in the 3D view at this cut, linked to it: moving either moves the other';
    }
    // the cut, as a frame in view coordinates, with how deep to draw beyond it
    frame() {
      const v = this.item, o3 = view.origin || [0, 0, 0];
      if (!v) return null;
      if (v.kind === 'plan') {
        const lv = levels(), z = Number.isInteger(v.level) && lv?.[v.level] ? lv[v.level].z + v.cut : v.elev;
        if (!Number.isFinite(z)) return null;
        const f = { o: new THREE.Vector3(0, 0, z - o3[2]), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(0, 0, 1) };
        return { f, depth: Number.isInteger(v.level) ? v.cut + 0.05 : 3.05 };
      }
      const s = v.frame;
      if (!s) return null;
      const q = new THREE.Quaternion().fromArray(s.q);
      const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q), vv = new THREE.Vector3(0, 1, 0).applyQuaternion(q), n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      if (s.flip) n.negate();
      return { f: { o: new THREE.Vector3(s.o[0] - o3[0], s.o[1] - o3[1], s.o[2] - o3[2]), u, v: vv, n }, depth: Infinity };
    }
    // the cut made again when the building or the cut changed
    cut() {
      const fr = this.frame();
      if (!fr) { this.geo = null; return; }
      const key = JSON.stringify([version, fr.f.o, fr.f.u, fr.f.v, fr.f.n]);
      if (this.geo && this.key === key) return;
      this.key = key;
      this.geo = cutGeometry(view, fr.f, { depth: fr.depth });
      this.marks = this.item.kind === 'plan' ? { labels: zoneLabels(fr.f, fr.depth) } : { levels: levelMarks(this.geo) };
    }
    paint() {
      const w = Math.floor(this.host.clientWidth), h = Math.floor(this.host.clientHeight);
      if (!w || !h || !this.el.isConnected) return;
      const v = this.item;
      this.foot.className = 'vtitle tblock';
      if (!v) {
        const none = !views().some((x) => x.kind === this.type);
        this.host.querySelector('svg.dwg')?.remove();
        this.ov.innerHTML = ''; this.tv.innerHTML = '';
        this.empty(none ? (this.type === 'plan' ? 'No plan views yet: create one in the Building window\'s Views tab (Create plan at level), or from a plan clipping plane\'s pop-up.' : 'No section views yet: create one from a section clipping plane\'s pop-up.') : 'Pick a view from the name in the bar.');
        this.foot.innerHTML = '';
        return;
      }
      this.empty(null);
      this.cut();
      if (!this.geo) return;
      const b = this.geo.box;
      if (!this.cam) {
        if (b) { const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]); this.cam = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s: Math.min((w - 48) / bw, (h - 48) / bh) }; } else this.cam = { cx: 0, cy: 0, s: 20 };
      }
      const svg = drawSVG(this.geo, { w, h, ...this.cam }, this.marks).replace('<svg ', '<svg class="dwg" ');
      const old = this.host.querySelector('svg.dwg');
      if (old) old.outerHTML = svg; else this.ov.insertAdjacentHTML('beforebegin', svg);
      for (const o of [this.ov, this.tv]) { o.setAttribute('width', w); o.setAttribute('height', h); }
      this.editor?.paint();
      this.editor && tools()?.redrawIn(this.editor.ctx);
      settle(this);
      const lv = levels(), p = planeOf(v.id);
      const where = v.kind === 'plan'
        ? (Number.isInteger(v.level) && lv?.[v.level] ? `<span class="m">${esc(lv[v.level].name)} <b>+ ${fmt(v.cut)} m</b></span>` : `<span class="m">cut at <b>${fmt(v.elev)} m</b></span>`)
        : '<span class="m">section</span>';
      this.foot.innerHTML = `<h3>${esc(v.name)}</h3>${where}${p ? `<span class="m">linked to <b>${esc(p.name)}</b></span>` : ''}<span class="m">1 m = <b>${fmt(this.cam.s, 0)} px</b></span>`;
    }
    empty(text) {
      let e = this.host.querySelector('.vempty');
      if (!text) { e?.remove(); return; }
      if (!e) { e = document.createElement('div'); e.className = 'vempty'; this.host.appendChild(e); }
      e.textContent = text;
    }
    // wheel zooms about the pointer, a drag pans, a double click fits
    wire() {
      const h = this.host;
      h.addEventListener('wheel', (e) => {
        if (!this.cam) return;
        e.preventDefault();
        const r = h.getBoundingClientRect(), k = Math.exp(-e.deltaY * 0.0015), c = this.cam;
        const mx = (e.clientX - r.left - r.width / 2) / c.s + c.cx, my = -(e.clientY - r.top - r.height / 2) / c.s + c.cy;
        const s = Math.max(0.5, Math.min(2000, c.s * k));
        this.cam = { s, cx: mx - (mx - c.cx) * c.s / s, cy: my - (my - c.cy) * c.s / s };
        this.paint();
      }, { passive: false });
      h.addEventListener('contextmenu', (e) => e.preventDefault());
      h.addEventListener('pointerdown', (e) => {
        if (!this.cam || e.target.closest('.vfloat, input')) return;
        if (e.button === 0) { this.editor?.down(e); return; }
        if (e.button !== 1 && e.button !== 2) return;
        e.preventDefault();
        const x0 = e.clientX, y0 = e.clientY, c0 = { ...this.cam };
        h.setPointerCapture(e.pointerId);
        h.classList.add('panning');
        const move = (m) => { this.cam = { ...c0, cx: c0.cx - (m.clientX - x0) / c0.s, cy: c0.cy + (m.clientY - y0) / c0.s }; this.paint(); };
        const up = () => { h.classList.remove('panning'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
      h.addEventListener('pointermove', (e) => { if (!h.classList.contains('panning')) this.editor?.move(e); });
      h.addEventListener('pointerup', (e) => { if (e.button === 0) this.editor?.up(e); });
      h.addEventListener('pointerleave', () => this.editor?.leave());
      h.addEventListener('dblclick', (e) => { if (!this.editor?.pickAt(e) && !tools()?.tool) { this.cam = null; this.paint(); } });
    }
  }

  // the zones a plan cuts, named at the middle of their floor
  function zoneLabels(f, depth) {
    const o3 = view.origin || [0, 0, 0], best = new Map();
    for (const s of view.surfaces || []) {
      if (!s.zone || s.vertices.length < 3) continue;
      const zs = s.vertices.map((p) => p[2] - o3[2]);
      if (Math.max(...zs) - Math.min(...zs) > 0.01) continue; // level only
      const z = zs[0], dz = f.o.z - z;
      if (dz < 0 || dz > depth) continue;
      const a = Math.abs(area2(s.vertices));
      if ((best.get(s.zone)?.a || 0) >= a) continue;
      const cx = s.vertices.reduce((t, p) => t + p[0], 0) / s.vertices.length - o3[0], cy = s.vertices.reduce((t, p) => t + p[1], 0) / s.vertices.length - o3[1];
      best.set(s.zone, { a, at: [cx, cy] });
    }
    return [...best].map(([name, { at }]) => [at[0], at[1], name]);
  }
  const area2 = (P) => P.reduce((t, p, i) => { const q = P[(i + 1) % P.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  // a section's levels: each a line at its height, where the section stands upright
  function levelMarks(g) {
    const lv = levels(), f = g.frame, o3 = view.origin || [0, 0, 0];
    if (!lv || Math.abs(f.v.z) < 0.99) return [];
    return lv.map((l) => [(l.z - o3[2] - f.o.z) * Math.sign(f.v.z), l.name, `${fmt(l.z)} m`]);
  }

  // ---------- full screen ----------
  function setFull(el, on) {
    el.classList.toggle('full', on);
    const b = el.querySelector('[data-vfull]');
    if (b) { b.innerHTML = on ? FS_OUT : FS_IN; b.title = on ? 'Leave full screen' : 'Full screen'; }
  }
  document.addEventListener('keydown', (e) => {
    const f = [...drawings].find((d) => d.el.classList.contains('full'));
    if (e.key === 'Escape' && f) { e.stopImmediatePropagation(); setFull(f.el, false); }
  });

  const tools = () => toolsRef;
  let toolsRef = null;
  let queued = false;
  const repaint = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; for (const d of drawings) d.paint(); }); };
  return {
    // A named view shown: brought forward where it already is, else put beside the 3D view (or in a
    // row of its own under it, where its row is full).
    open(id) {
      const v = views().find((x) => x.id === id);
      if (!v) return;
      const at = [...drawings].find((d) => d.pin === id && d.el.isConnected);
      if (at) { at.el.classList.remove('flash'); void at.el.offsetWidth; at.el.classList.add('flash'); return; }
      const d = new Drawing(v.kind, id), row3 = view3dEl.closest('.vrow');
      const row = row3 && row3.querySelectorAll(':scope > .view').length < 2 ? row3 : null;
      if (row) row.appendChild(d.el);
      else { const r = document.createElement('div'); r.className = 'vrow'; host.insertBefore(r, row3?.nextSibling || null); r.appendChild(d.el); }
      layout.margins(); changed();
      repaint();
    },
    // the list of named views changed: each view's name list, and a deleted one's view shows none
    listChanged() { for (const d of drawings) { if (d.pin !== null && !d.item) d.show(firstOf(d.type)); else d.options(); } repaint(); },
    // the building or a cut changed: every drawing cut again
    redraw() { version++; for (const d of drawings) { d.bar3d(); d.setEditor(); } repaint(); },
    // the selection changed: drawn again over each plan
    selection() { for (const d of drawings) d.editor?.paint(); },
    setTools(t) { toolsRef = t; },
    drawings: () => [...drawings],
    put: (rec) => layout.put(rec), take: (el) => layout.take(el),
    layout,
  };
}
