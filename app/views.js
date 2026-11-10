/* Views on a page: drawings in rows, added and taken away, moved, resized,
   switched to another kind, put full screen - as the Solar Shading Explorer
   lays out its drawings. No dependencies; load views.css with it.

   The page holds rows; a row holds views side by side. Between the views of a
   row, and at each end of it, is a margin; between the rows, and above and
   below them all, another. Every margin shows a + at its middle when the
   pointer is over it: it adds a view there, of any kind - a column in the row,
   or a row of its own. The margins between two views, and between two rows,
   can be dragged: sideways to share the row's width, up and down to make a row
   taller or shorter (a double click gives it back its own height).

   Each view's bar carries a grip. Dragged, the view can be dropped near the top
   or bottom edge of a row (a row of its own), near the left or right edge of a
   view (a column beside it), or over the middle of another view (the two
   change places). Its bar's – takes it off the page: the others in its row
   close up, and a row left empty goes. Undo puts it back where it stood.

   The arrangement - which views, in which rows, at what widths and heights -
   is kept in the browser: it is how the page is looked at, not the design.  */

const clampN = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/* ---------- a view's shell: its bar, its drawing, its foot line ---------- */
/** the full-screen button's two faces: arrows apart to fill the screen, together to leave it */
export const FS_IN = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 12.5l9-9" stroke="currentColor" stroke-width="1.4"/><path d="M8.5 2.5h5v5M2.5 8.5v5h5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
export const FS_OUT = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 14l4.5-4.5M14 2L9.5 6.5" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 9.5h4v4M13.5 6.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
export const RECENTRE = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>';
let seq = 0;
/* A view of a kind. Its bar, left to right: the grip, the kind as a menu that
   reads as its name ("Show a different view here"), the kind's own controls,
   the i for what it shows, and pinned at the right end – and full screen.
   Controls marked iconbtn (a camera's Re-center, Zoom to selected) float at the
   drawing's top right instead, so the bar keeps to one row. Under the drawing
   is its foot line, for the view's figures.
   kinds = { type: label }; info = [title, html]; returns { id, type, el, bar, host, foot, floats } */
export function viewShell(type, kinds, { controls = '', info = null } = {}) {
  const el = document.createElement('div');
  el.className = 'view'; el.dataset.type = type; el.id = 'w' + (++seq);
  el.innerHTML = `<div class="v3dbar"><div class="vbarrow">
      <span class="grip" title="Drag to move this view: to a row's top or bottom edge for a row of its own, to a view's side to sit beside it, onto a view to swap">⠿</span>
      <select class="vtype" title="Show a different view here">${Object.entries(kinds).map(([k, l]) => `<option value="${k}"${k === type ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      ${controls}
      ${info ? `<button type="button" class="info" data-info aria-expanded="false" title="What this view shows">i</button><div class="infopop" hidden><h4>${esc(info[0])}</h4>${info[1]}</div>` : ''}
      <span class="vbtns"><button type="button" class="minibtn vb" data-vclose title="Remove this view - the others in its row take its place; add one back with the + in any margin">–</button><button type="button" class="minibtn vb" data-vfull title="Full screen" aria-label="Full screen" aria-pressed="false">${FS_IN}</button></span>
    </div></div>
    <div class="vhost"></div><div class="vtitle"></div>`;
  const host = el.querySelector('.vhost'), floats = [];
  const icons = el.querySelectorAll('.vbarrow > .iconbtn');
  if (icons.length) {
    const tr = document.createElement('div'); tr.className = 'vfloat vfTR';
    icons.forEach(b => tr.appendChild(b));
    // a press on them is theirs, not the drawing's
    for (const ev of ['pointerdown', 'pointerup', 'wheel', 'dblclick']) tr.addEventListener(ev, e => e.stopPropagation());
    host.appendChild(tr); floats.push(tr);
  }
  return { id: el.id, type, el, bar: el.querySelector('.v3dbar'), host, foot: el.querySelector('.vtitle'), floats };
}
/** after a view's drawing is replaced: its floating buttons back on top of it, and its bar's height for them to sit under */
export function settle(v) {
  for (const f of v.floats) if (v.host.firstChild !== f) v.host.prepend(f);
  v.el.style.setProperty('--vbh', v.bar.offsetHeight + 'px');
}

/* The sheet a view is drawn on, in drawing units: its width over the height it
   may use, so the drawing's frame fills the view. A row given a height gives
   the drawing what its bar and foot line leave; full screen, the space under
   the bar; otherwise the view's width at the base proportion, never taller
   than most of the screen. */
export function sheetFor(el, sheet0 = [470, 500]) {
  if (!el || !el.isConnected) return sheet0;
  const host = el.querySelector('.vhost'), bar = el.querySelector('.v3dbar'), ttl = el.querySelector('.vtitle');
  if (el.classList.contains('full')) {
    const r = el.getBoundingClientRect(), b = bar.getBoundingClientRect();
    const aw = Math.max(200, r.width - 16), ah = Math.max(200, r.bottom - b.bottom - 12);
    return [Math.max(300, sheet0[1] * aw / ah), sheet0[1]];
  }
  const w = host.clientWidth || el.clientWidth;
  if (!w) return sheet0;
  const rh = el.parentElement && el.parentElement.dataset.h ? +el.parentElement.dataset.h : 0;
  if (rh) { const h = Math.max(160, rh - bar.offsetHeight - ttl.offsetHeight); return [Math.max(200, sheet0[1] * w / h), sheet0[1]]; }
  const h = Math.min(w * sheet0[1] / sheet0[0], Math.max(420, innerHeight * 0.78));
  return [Math.max(sheet0[0], sheet0[1] * w / h), sheet0[1]];
}

/* ---------- the layout ---------- */
/* opts:
     host        the element the rows go in (.views)
     dropTarget  an absolutely placed element that shows where a dragged view would go (.droptarget)
     kinds       { type: label }, for the + menu
     make(type, saved)  a new view shell for that kind ({ el, ... }); saved is what was kept of it
     initial     the first arrangement: [{ views: [{ type }, ...] }, ...]
     key         the browser storage key; null keeps nothing
     onChange()  after views are added, moved, removed or a resize is let go
     onResize()  while a margin is dragged (redraw cheaply) */
export function createLayout(opts) {
  const { host, dropTarget: tgt, kinds, make, initial, key = null, onChange = () => { }, onResize = () => { } } = opts;
  const rowsOf = () => [...host.querySelectorAll(':scope > .vrow')];
  const viewsOf = row => [...row.querySelectorAll(':scope > .view')];
  const newRow = () => { const r = document.createElement('div'); r.className = 'vrow'; return r; };

  /* a view joining a row takes the row's average share of its width: a row
     whose widths have been dragged holds shares in pixels, and a newcomer at
     the default share of 1 would all but vanish */
  function fitIn(el, row) {
    const others = viewsOf(row).filter(v => v !== el);
    if (!others.length) { el.style.flexGrow = ''; return; }
    el.style.flexGrow = others.reduce((a, v) => a + (+v.style.flexGrow || 1), 0) / others.length;
  }
  const snapshot = () => rowsOf().map(r => ({ h: r.dataset.h ? +r.dataset.h : null,
    views: viewsOf(r).map(v => ({ type: v.dataset.type, grow: +(v.style.flexGrow || 1), pin: v.dataset.pin || null })) }));
  function save() { if (key) try { localStorage.setItem(key, JSON.stringify(snapshot())); } catch (_) { } }

  /* ---- the margins: a + on each; the ones between can be dragged ---- */
  function margin(kind, end) {
    const d = document.createElement('div');
    d.className = (kind === 'col' ? 'vdiv' : 'hdiv') + (end ? ' end' : '');
    d.innerHTML = '<button type="button" class="vplus" title="Add a view here">+</button>';
    return d;
  }
  /** every margin taken out and put back where the rows and views now stand; an empty row goes */
  function margins() {
    host.querySelectorAll('.vdiv, .hdiv').forEach(d => d.remove());
    for (const r of rowsOf()) if (!r.querySelector('.view')) r.remove();
    const rows = rowsOf();
    rows.forEach((row, i) => {
      host.insertBefore(margin('row', i === 0), row);
      viewsOf(row).forEach((v, j) => row.insertBefore(margin('col', j === 0), v));
      row.appendChild(margin('col', true));
    });
    host.appendChild(margin('row', true));
    host.classList.toggle('empty', !rows.length);
  }

  /** the rows built afresh: from what was kept, or the first arrangement (fresh: forget what was kept) */
  function build(fresh = false) {
    let rows = null;
    if (key && !fresh) try { rows = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { rows = null; }
    if (key && fresh) try { localStorage.removeItem(key); } catch (_) { }
    // what was kept is used only if every view in it is a kind this page still has
    const ok = Array.isArray(rows) && rows.every(r => r && Array.isArray(r.views) && r.views.every(v => v && kinds[v.type]));
    if (!ok) rows = initial;
    host.innerHTML = '';
    for (const r of rows) {
      const row = newRow();
      if (r.h) row.dataset.h = r.h;
      for (const v of r.views) { const inst = make(v.type, v); if (v.grow) inst.el.style.flexGrow = v.grow; row.appendChild(inst.el); }
      host.appendChild(row);
    }
    margins();
  }

  /* ---- the list a + opens ---- */
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  function openMenu(btn, onPick) {
    closeMenu();
    const r = btn.getBoundingClientRect();
    menu = document.createElement('div'); menu.className = 'vmenu';
    menu.innerHTML = '<p>Add a view</p>' + Object.entries(kinds).map(([k, l]) => `<button type="button" data-add="${k}">${esc(l)}</button>`).join('');
    Object.assign(menu.style, { left: Math.round(r.left + r.width / 2 + scrollX) + 'px', top: Math.round(r.bottom + 4 + scrollY) + 'px' });
    document.body.appendChild(menu);
    // kept on screen: above the + when there is no room under it, and clear of the sides
    const h = menu.offsetHeight, w = menu.offsetWidth;
    if (r.bottom + 4 + h > innerHeight - 8) menu.style.top = Math.round(Math.max(8, r.top - 4 - h) + scrollY) + 'px';
    const left = menu.getBoundingClientRect().left;
    if (left + w > innerWidth - 8) menu.style.left = Math.round(parseFloat(menu.style.left) - (left + w - innerWidth + 8)) + 'px';
    menu.addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) { closeMenu(); onPick(b.dataset.add); } });
  }
  host.addEventListener('click', e => {
    const b = e.target.closest('.vplus');
    if (!b) return;
    e.stopPropagation();
    const d = b.parentElement;
    openMenu(b, type => {
      const inst = make(type);
      // a column margin: beside its neighbours, at their average share; a row margin: a row of its own
      if (d.classList.contains('vdiv')) { d.parentElement.insertBefore(inst.el, d); fitIn(inst.el, inst.el.parentElement); }
      else { const row = newRow(); row.appendChild(inst.el); host.insertBefore(row, d); }
      margins(); save(); onChange();
    });
  });
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !e.target.closest('.vplus')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  /* ---- where a dragged view would go ---- */
  function dropAt(x, y, dragged) {
    for (const row of rowsOf()) {
      const rr = row.getBoundingClientRect();
      if (y < rr.top - 8 || y > rr.bottom + 8) continue;
      // a band along the row's top and bottom edge: a row of its own, above or below
      const edge = Math.min(46, rr.height * 0.18);
      if (y < rr.top + edge) return { kind: 'row', row, side: 'before', rect: [rr.left, rr.top - 4, rr.width, 8] };
      if (y > rr.bottom - edge) return { kind: 'row', row, side: 'after', rect: [rr.left, rr.bottom - 4, rr.width, 8] };
      for (const v of viewsOf(row)) {
        const vr = v.getBoundingClientRect();
        if (x < vr.left - 6 || x > vr.right + 6) continue;
        // a band along a view's sides: a column beside it; its middle: the two change places
        const m = Math.min(90, vr.width * 0.25);
        if (x < vr.left + m) return { kind: 'col', view: v, side: 'before', rect: [vr.left - 4, vr.top, 8, vr.height] };
        if (x > vr.right - m) return { kind: 'col', view: v, side: 'after', rect: [vr.right - 4, vr.top, 8, vr.height] };
        if (v === dragged) return null;
        return { kind: 'swap', view: v, rect: [vr.left, vr.top, vr.width, vr.height] };
      }
    }
    return null;
  }
  function drop(t, v) {
    if (!t) return false;
    if (t.kind === 'row') {
      const row = newRow();
      t.row.parentElement.insertBefore(row, t.side === 'before' ? t.row : t.row.nextSibling);
      v.style.flexGrow = ''; row.appendChild(v);
    } else if (t.kind === 'col') {
      if (t.view === v) return false;
      t.view.parentElement.insertBefore(v, t.side === 'before' ? t.view : t.view.nextSibling);
      fitIn(v, v.parentElement);
    } else {
      const mark = document.createElement('span');
      v.parentElement.insertBefore(mark, v);
      t.view.parentElement.insertBefore(v, t.view);
      mark.parentElement.insertBefore(t.view, mark);
      mark.remove();
    }
    margins();
    return true;
  }

  /* ---- dragging: a margin to resize, a grip to move ---- */
  let drag = null, size = null;
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.target.closest) return;
    const m = e.target.closest('.vdiv:not(.end), .hdiv:not(.end)');
    if (m && !e.target.closest('.vplus') && host.contains(m)) {
      if (m.classList.contains('vdiv')) {
        /* the row's shares taken in pixels, so the two either side trade exactly
           what the pointer moves - every width measured before any is set, or
           the first set reflows the row and the rest are read wrong */
        const vs = viewsOf(m.parentElement), ws = vs.map(v => v.getBoundingClientRect().width);
        vs.forEach((v, k) => { v.style.flexGrow = Math.max(1, ws[k]); });
        const L = m.previousElementSibling, R = m.nextElementSibling;
        size = { kind: 'col', L, R, x: e.clientX, l: +L.style.flexGrow, r: +R.style.flexGrow };
      } else {
        const row = m.previousElementSibling;
        size = { kind: 'row', row, y: e.clientY, h: row.getBoundingClientRect().height };
      }
      document.body.classList.add(size.kind === 'col' ? 'sizingc' : 'sizingr');
      e.preventDefault(); return;
    }
    const g = e.target.closest('.grip'), v = g && g.closest('.view');
    if (!v || !host.contains(v) || v.classList.contains('full')) return;
    drag = { v, x: e.clientX, y: e.clientY, on: false };
    e.preventDefault();
  });
  addEventListener('pointermove', e => {
    if (size) {
      if (size.kind === 'col') {
        const dx = e.clientX - size.x, min = 180;
        const l = Math.max(min, size.l + dx), r = Math.max(min, size.r - (l - size.l));
        size.L.style.flexGrow = l; size.R.style.flexGrow = r;
      } else size.row.dataset.h = Math.round(Math.max(260, size.h + e.clientY - size.y));
      onResize(); return;
    }
    if (!drag) return;
    // a grip pressed moves the view only once it has been dragged 5 px
    if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.on = true;
    drag.v.classList.add('dragging'); document.body.classList.add('moving');
    const t = drag.t = dropAt(e.clientX, e.clientY, drag.v);
    if (!t) { tgt.hidden = true; return; }
    const [l, tp, w, h] = t.rect;
    Object.assign(tgt.style, { left: l + scrollX + 'px', top: tp + scrollY + 'px', width: w + 'px', height: h + 'px' });
    tgt.className = 'droptarget ' + t.kind; tgt.hidden = false;
  });
  const end = () => {
    if (size) { size = null; document.body.classList.remove('sizingc', 'sizingr'); save(); onChange(); return; }
    if (!drag) return;
    const d = drag; drag = null;
    tgt.hidden = true; document.body.classList.remove('moving'); d.v.classList.remove('dragging');
    if (d.on && drop(d.t, d.v)) { save(); onChange(); }
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
  host.addEventListener('dblclick', e => {
    const m = e.target.closest('.hdiv:not(.end)');
    if (m && m.previousElementSibling) { delete m.previousElementSibling.dataset.h; save(); onChange(); }
  });

  /* ---- switching a view's kind, taking it off, putting it back ---- */
  /** another kind of view in the same place, at the same width */
  function switchKind(old, type) {
    const n = make(type);
    n.el.style.flexGrow = old.style.flexGrow;
    old.replaceWith(n.el); margins(); save(); onChange();
    return n;
  }
  /* A view taken off is kept, with where it stood - so Undo puts it back, its
     camera and all. Returns the record to keep on the undo stack. */
  function take(v) {
    const row = v.parentElement;
    let nextView = v.nextElementSibling; while (nextView && !nextView.classList.contains('view')) nextView = nextView.nextElementSibling;
    let nextRow = row.nextElementSibling; while (nextRow && !nextRow.classList.contains('vrow')) nextRow = nextRow.nextElementSibling;
    const rec = { el: v, row, nextView, nextRow };
    v.remove(); margins(); save(); onChange();
    return rec;
  }
  function put(rec) {
    if (!rec.row.isConnected) host.insertBefore(rec.row, rec.nextRow && rec.nextRow.isConnected ? rec.nextRow : null);
    rec.row.insertBefore(rec.el, rec.nextView && rec.nextView.parentElement === rec.row ? rec.nextView : null);
    margins(); save(); onChange();
  }
  host.addEventListener('change', e => {
    const s = e.target.closest('.vtype');
    if (s && opts.onSwitch) opts.onSwitch(s.closest('.view'), s.value);
  });
  return { build, save, margins, switchKind, take, put, views: () => [...host.querySelectorAll('.view')] };
}

/* ---------- full screen ---------- */
/* Full screen lays one view over the drawings only: the settings bar (and a
   side panel, if the page has one) stay, and so does the dock, collapsed or
   open. The view draws its sheet at the shape of that space. Esc, or its
   button again, leaves it. fit() keeps it under the settings bar as the page
   is resized. */
export function fullScreen({ settingsBar, sidePanel = null, onChange = () => { } }) {
  const root = document.documentElement.style;
  function fit() {
    const v = document.querySelector('.view.full');
    let bar = settingsBar.getBoundingClientRect();
    // the settings bar taken to the top of the window first, so the view has all the height under it
    if (v && Math.abs(bar.top) > 1) { scrollTo(0, Math.max(0, bar.top + scrollY)); bar = settingsBar.getBoundingClientRect(); }
    const side = sidePanel && sidePanel.offsetWidth && sidePanel.getBoundingClientRect().width < innerWidth * 0.6;
    root.setProperty('--fullL', (side ? Math.max(0, sidePanel.getBoundingClientRect().right) : 0) + 'px');
    root.setProperty('--fullT', clampN(bar.bottom, 0, Math.max(0, innerHeight - 240)) + 'px');
  }
  const face = (b, full) => { if (!b) return; b.innerHTML = full ? FS_OUT : FS_IN; b.title = full ? 'Leave full screen' : 'Full screen'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(full)); };
  function set(v, on) {
    document.querySelectorAll('.view.full').forEach(x => { x.classList.remove('full'); face(x.querySelector('[data-vfull]'), false); });
    if (on && v) { v.classList.add('full'); face(v.querySelector('[data-vfull]'), true); }
    document.body.classList.toggle('hasfull', !!(on && v));
    fit(); onChange();
  }
  // Esc steps back one level: out of full screen, and nothing else this time
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.view.full')) { e.stopImmediatePropagation(); set(null, false); } });
  addEventListener('resize', fit);
  return { set, fit, toggle: v => set(v, !v.classList.contains('full')) };
}

/* ---------- the i: one note open at a time, closed by a click anywhere else ---------- */
export function wireInfo() {
  document.addEventListener('pointerdown', e => {
    for (const p of document.querySelectorAll('.infopop:not([hidden])'))
      if (!p.contains(e.target) && !(e.target.closest('[data-info]') && e.target.closest('.view') === p.closest('.view'))) {
        p.hidden = true; p.closest('.view').querySelector('[data-info]').setAttribute('aria-expanded', 'false');
      }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-info]');
    if (!b) return;
    const p = b.closest('.view').querySelector('.infopop'), open = p.hidden;
    document.querySelectorAll('.infopop').forEach(x => { x.hidden = true; });
    p.hidden = !open; b.setAttribute('aria-expanded', String(open));
  });
}

/* ---------- the sticky stack ---------- */
/* The settings bar is sticky at the top of the window; each view's bar sticks
   under it (--cbh, the settings bar's height), and a view's floating buttons
   under its bar (--vbh). Keep --cbh true as the settings bar wraps. */
export function stickUnder(settingsBar) {
  const set = () => document.documentElement.style.setProperty('--cbh', settingsBar.offsetHeight + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(settingsBar);
  addEventListener('resize', set);
}

/* ---------- the dock: a panel along the foot of the views ---------- */
/* Its top edge is dragged to resize it (140 px up to the window less 140);
   ▾ collapses it to its bar, the full-screen button lays it over the views
   under the settings bar. --dockVis is how much of the window it covers, so
   the page and the pop-ups keep clear of it. How it was left is kept. */
export function dock({ el, grip, minBtn, fullBtn, settingsBar, key = null, startMin = true }) {
  const root = document.documentElement.style, d = { h: Math.round(innerHeight * 0.38), min: startMin, full: false };
  if (key) try { Object.assign(d, JSON.parse(localStorage.getItem(key) || '{}'), { full: false, min: startMin }); } catch (_) { }
  function fit() {
    root.setProperty('--dockH', clampN(d.h, 140, Math.max(160, innerHeight - 140)) + 'px');
    root.setProperty('--dockT', clampN(settingsBar.getBoundingClientRect().bottom, 0, innerHeight - 200) + 'px');
    el.classList.toggle('min', d.min); el.classList.toggle('full', d.full);
    minBtn.textContent = d.min ? '▴' : '▾'; minBtn.title = d.min ? 'Expand' : 'Collapse';
    fullBtn.innerHTML = d.full ? FS_OUT : FS_IN; fullBtn.title = d.full ? 'Leave full screen' : 'Full screen';
    root.setProperty('--dockVis', (d.full ? 0 : el.getBoundingClientRect().height) + 'px');
    if (key) try { localStorage.setItem(key, JSON.stringify({ h: d.h, min: d.min })); } catch (_) { }
  }
  minBtn.addEventListener('click', () => { d.min = !d.min; if (d.min) d.full = false; fit(); });
  fullBtn.addEventListener('click', () => { d.full = !d.full; if (d.full) d.min = false; fit(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && d.full) { e.stopImmediatePropagation(); d.full = false; fit(); } });
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const move = ev => { d.h = innerHeight - ev.clientY; fit(); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  addEventListener('resize', fit);
  fit();
  return { fit };
}
