// The Zones window (Model ▸ Zones): every zone of the model, and the settings of the one picked, in the
// order ClimateStudio sets a zone (its Space use, its Construction, its windows):
//  - the zones listed by the level they stand on, with their floor area; for a massing, the levels each
//    stands on and reaches, and their windows; a zone picked (anywhere on its row) is selected in the
//    views too;
//  - the picked zone's space use and ventilation, and its assemblies by surface class (zoneExtra, from
//    the app: the same rows as its pop-up);
//  - for a massing, its windows face by face (the facade-windows skill's array settings).
// Levels are edited in the views (levels.js), plan and section views from the View tab (viewsbar.js).
// A change to the massing goes through `change`, which rewrites the model from it as one undoable edit.

import { deleteZone, massingGeometry, WINDOWS0, unitLayout, sideWindows, setWindowFigure, setWindowSize, spreadSide, faceLength, zoneHeight, faceBearing, compassWord, polyArea, levelName } from '../src/model/massing.js';
import { SIZES } from '../src/model/windows.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));
const GLAZING = [
  ['winW', 'Width', 'm', 'Each window’s width, held to its bay', 0.2],
  ['winH', 'Height', 'm', 'Each window’s height, held under the slab', 0.2],
  ['sill', 'Sill', 'm', 'Height of the sill above the zone’s floor', 0],
];

// get() -> the massing or null; model() -> the model; zoneExtra(name) -> the zone's settings rows (HTML);
// onPick(name): a zone picked here.
export function massingPanel(box, { get, model = () => null, change, zoneExtra = () => '', onPick = () => {} }) {
  let sel = 0, face = 0, allFaces = false, matchGlazing = false, picked = null; // picked: a model zone's name, with no massing

  function render() {
    const m = get(), mod = model();
    if ((!m && !mod) || box.hidden) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    let h = '<div class="pophd" title="Drag to move"><span class="popttl">Zones</span><span class="popbtns"><button type="button" data-pop="close" title="Close">×</button></span></div><div class="libbody">';
    h += m ? zonesTab(m) : modelZones(mod);
    box.innerHTML = h + '</div>';
  }

  const num = (act, f, v, title, min, d = 2) => `<input class="popnum" data-act="${act}" data-f="${f}" data-min="${min}" value="${fmt(v, d)}" title="${esc(title)}">`;
  const lvName = (m, L) => esc(m.levels[L]?.name || levelName(L));
  const lvOpts = (m, now, from = 0, to = m.levels.length - 1) => m.levels.map((lv, L) => (L >= from && L <= to ? `<option value="${L}"${L === now ? ' selected' : ''}>${lvName(m, L)}</option>` : '')).join('');
  const settings = (name) => `<div class="zset" data-zone-name="${esc(name)}">${zoneExtra(name)}</div>`;

  // a model opened from a file: its zones and the settings of the one picked
  function modelZones(mod) {
    // by the height each stands at: its floor's lowest point
    const base = (n) => { let lo = Infinity; for (const s of mod.zones[n].surfaces || []) for (const v of mod.surfaces[s]?.vertices || []) lo = Math.min(lo, v[2]); return Number.isFinite(lo) ? +lo.toFixed(2) : 0; };
    const names = Object.keys(mod.zones).map((n) => [n, base(n)]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], undefined, { numeric: true }));
    if (!names.some(([n]) => n === picked)) picked = names[0]?.[0];
    let h = '<table class="libtable mstable"><thead><tr><th title="Click a zone for its settings">Zone</th><th class="num">Floor<span class="unit"> m²</span></th><th class="num">Volume<span class="unit"> m³</span></th></tr></thead><tbody>', at = null;
    for (const [n, z0] of names) {
      const z = mod.zones[n];
      if (z0 !== at) { at = z0; h += `<tr class="mslevel"><th colspan="3">Floor at ${fmt(z0)} m</th></tr>`; }
      h += `<tr class="${n === picked ? 'on' : ''}" data-act="pickname" data-v="${esc(n)}" title="Its settings; selected in the views"><td>${esc(n)}</td><td class="num">${fmt(z.floorArea.value, 1)}</td><td class="num">${fmt(z.volume.value, 0)}</td></tr>`;
    }
    return h + '</tbody></table>' + (picked ? `<div class="msub">${esc(picked)}</div>${settings(picked)}` : '');
  }

  function zonesTab(m) {
    sel = Math.min(sel, m.zones.length - 1);
    const z = m.zones[sel];
    face = Math.min(face, z.plate.length - 1);
    const g = z.faces[face];
    const made = massingGeometry(m); // the windows as written: none where a face meets another zone
    const zoneLabel = (i) => esc(made[i]?.name || `${m.name || 'Floor'}${m.zones[i].base + 1}`);
    let h = `<div class="poprow"><span class="tipped" title="Zones are named after it, with their base level's number and their own: Floor1_0, Floor2_1 …, as ClimateStudio names zones">Name</span> <input class="libname short" data-act="name" value="${esc(m.name || '')}" placeholder="Floor">`
      + `<span class="tipped" title="The whole building turned clockwise in plan">Turn</span> ${num('rot', 'rot', m.rot || 0, 'Degrees clockwise', -Infinity, 1)}°</div>`;
    h += '<table class="libtable mstable"><thead><tr><th title="Click a zone for its settings">Zone</th><th title="The level it stands on">Base</th><th title="The level its roof reaches">Top</th>'
      + '<th class="num" title="Its floor area">Area<span class="unit"> m²</span></th><th class="num" title="Its windows, all faces">Windows</th><th></th></tr></thead><tbody>';
    // by the level each stands on
    const order = m.zones.map((x, i) => i).sort((a, b) => m.zones[a].base - m.zones[b].base || a - b);
    let at = null;
    order.forEach((i) => {
      const x = m.zones[i];
      if (x.base !== at) { at = x.base; h += `<tr class="mslevel"><th colspan="6">${lvName(m, x.base)}</th></tr>`; }
      h += `<tr class="${i === sel ? 'on' : ''}" data-zn="${i}" data-act="pick" data-v="${i}" title="Its settings; selected in the views"><td>${zoneLabel(i)}</td>`
        + `<td><select class="popsel" data-act="zone-base">${lvOpts(m, x.base, 0, x.top - 1)}</select></td><td><select class="popsel" data-act="zone-top">${lvOpts(m, x.top, x.base + 1)}</select></td>`
        + `<td class="num">${fmt(Math.abs(polyArea(x.plate)), 1)}</td><td class="num">${made[i].windows.length}</td>`
        + `<td>${m.zones.length > 1 ? `<button type="button" class="pbtn x" data-act="del" data-v="${i}" title="Remove this zone">×</button>` : ''}</td></tr>`;
    });
    h += '</tbody></table>';
    h += `<div class="msub">${zoneLabel(sel)}</div>${made[sel] ? settings(made[sel].name) : ''}`;
    // the picked zone's windows, face by face
    const word = (k) => compassWord(faceBearing(m, sel, k));
    h += `<div class="msub">Windows</div><div class="poprow">`
      + z.plate.map((_, k) => `<button type="button" class="pbtn side" data-act="face" data-v="${k}" aria-pressed="${k === face}" title="Face ${k + 1}, looking ${word(k)}, ${fmt(faceLength(m, sel, k))} m">${word(k)}${z.plate.filter((__, q) => word(q) === word(k)).length > 1 ? ` ${k + 1}` : ''}</button>`).join('')
      + `<label class="chk" title="Changes to the windows go to all the faces of this zone"><input type="checkbox" data-act="all-faces"${allFaces ? ' checked' : ''}> All faces</label>`
      + `<label class="chk" title="Changes to the windows go to the zones stacked above too, on their face looking the same way"><input type="checkbox" data-act="match-glazing"${matchGlazing ? ' checked' : ''}> Zones above match</label></div>`;
    h += `<div class="poprow"><label class="chk" title="Whether this face has windows"><input type="checkbox" data-act="has-win"${g ? ' checked' : ''}> Windows</label>`;
    if (g) {
      const len = faceLength(m, sel, face), lay = unitLayout(g, len), n = sideWindows(g, len, zoneHeight(m, sel), z.slab).length;
      h += `<select class="popsel" data-act="glz" data-f="winBy" title="By number: the face divided into equal bays, a window in each. By spacing: bays of a set pitch, centred on the face, plain wall left at the ends."><option value="number"${g.winBy !== 'spacing' ? ' selected' : ''}>By number</option><option value="spacing"${g.winBy === 'spacing' ? ' selected' : ''}>By spacing</option></select>`
        + (g.winBy === 'spacing' ? `<span class="tipped" title="Centre to centre">Spacing</span> ${num('glz', 'winSp', g.winSp, 'Spacing (m), centre to centre', 0.3)} m <span class="muted">${lay.n} windows</span>`
          : `<span>Count</span> ${num('glz', 'winN', g.winN, 'How many windows', 1, 0)} <span class="muted">${fmt(lay.pitch)} m bays</span>`) + '</div><div class="poprow">'
        + GLAZING.map(([f, l, u, t, min]) => `<span class="tipped" title="${esc(t)}">${l}</span> ${num('glz', f, g[f], `${l} (${u})`, min)} ${u}`).join(' ')
        + `<span class="tipped" title="How the windows' edges hold as the zone's height or the bay changes. Fixed: their own width and height. Offsets: the head a set distance under the slab, each jamb a set distance in from its bay (glass bay to bay, up to the slab, is Offsets of 0). Proportional: shares of the wall's height and the bay. Switching never moves the glass.">Size</span> <select class="popsel" data-act="glz-size">${SIZES.map(([v, l]) => `<option value="${v}"${(g.size || (g.fillW || g.fillH ? 'offset' : 'fixed')) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
      if (n < lay.n) h += `<div class="poprow muted">${lay.n - n} of the windows are too small to make.</div>`;
      const broken = Object.keys(g.broken || {}).map(Number).sort((a, b) => a - b);
      if (broken.length) {
        h += '<div class="poprow"><span class="tipped" title="Windows of this array given their own size and place, by dragging them in the view. Rejoin puts one back in the array.">Broken out</span> '
          + broken.map((i) => { const b = g.broken[i]; return `<span class="mbroken">${i + 1}: ${fmt(b.winW)} × ${fmt(b.winH)} m <button type="button" class="pbtn x" data-act="rejoin" data-v="${i}" title="Back into the array">↺</button></span>`; }).join(' ')
          + (broken.length > 1 ? ' <button type="button" class="pbtn" data-act="rejoin-all" title="Put every broken-out window on this face back into the array">Rejoin all</button>' : '') + '</div>';
      }
    } else h += '</div>';
    return h;
  }

  // The faces an edit to the selected face's windows goes to, [zone, face]; with "Zones above match",
  // carried up to the zones stacked above on their face looking the same way.
  const glazingTargets = (m) => {
    const out = [[sel, face]];
    if (allFaces) m.zones[sel].plate.forEach((_, k) => { if (k !== face) out.push([sel, k]); });
    return out;
  };
  const edit = (m, fn) => {
    for (const [i, k] of glazingTargets(m)) {
      fn(i, k);
      if (matchGlazing) { const z = m.zones[i], was = z.linkAbove, wasF = z.linkFaces; z.linkAbove = true; z.linkFaces = false; spreadSide(m, i, k); z.linkAbove = was; z.linkFaces = wasF; }
    }
  };
  function commit(el) {
    const act = el.dataset.act, f = el.dataset.f, m = get();
    if (!m) return;
    if (act === 'name') { const v = el.value.trim() || 'Floor'; if (v !== m.name) change((x) => { x.name = v; }, 'massing renamed'); return; }
    let v = Number(el.value);
    if (!Number.isFinite(v)) { render(); return; }
    v = Math.max(Number(el.dataset.min) || (el.dataset.min === '-Infinity' ? -Infinity : 0), v);
    if (act === 'rot') change((x) => { x.rot = v; }, 'building turned');
    else if (act === 'glz') change((x) => edit(x, (i, k) => {
      const g = x.zones[i].faces[k];
      if (!g) return;
      // a window's own figures go through its Size, so each way it keeps them stays true
      if (['winW', 'winH', 'sill'].includes(f)) setWindowFigure(x, i, k, undefined, f, v); else g[f] = f === 'winN' ? Math.round(v) : v;
    }), `windows ${f} set`);
  }

  box.addEventListener('change', (e) => {
    const el = e.target, act = el.dataset.act;
    if (!act || el.closest('.zset')) return;
    if (act === 'match-glazing') { matchGlazing = el.checked; return; }
    if (act === 'all-faces') { allFaces = el.checked; return; }
    if (act === 'zone-base' || act === 'zone-top') {
      const i = Number(el.closest('[data-zn]').dataset.zn), L = Number(el.value);
      change((x) => { x.zones[i][act === 'zone-base' ? 'base' : 'top'] = L; }, `zone ${i + 1} ${act === 'zone-base' ? 'base' : 'top'} level set`);
      return;
    }
    if (act === 'has-win') { change((x) => edit(x, (i, k) => { x.zones[i].faces[k] = el.checked ? (x.zones[i].faces[k] || WINDOWS0()) : null; }), el.checked ? 'windows added' : 'windows removed'); return; }
    if (act === 'glz-size') { change((x) => edit(x, (i, k) => { if (x.zones[i].faces[k]) setWindowSize(x, i, k, undefined, el.value); }), `windows sized ${el.value}`); return; }
    if (act === 'glz' && el.tagName === 'SELECT') { change((x) => edit(x, (i, k) => { if (x.zones[i].faces[k]) x.zones[i].faces[k].winBy = el.value; }), 'windows set out'); return; }
    commit(el);
  });
  box.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches('input') || el.closest('.zset')) return;
    if (e.key === 'Tab' && el.dataset.act === 'name' && !el.value) el.value = el.placeholder;
    if (e.key === 'Enter') el.blur();
    if (e.key === 'Escape') { el.blur(); render(); }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && el.classList.contains('popnum')) {
      e.preventDefault();
      const step = el.dataset.f === 'winN' ? 1 : e.shiftKey ? 1 : 0.1;
      el.value = fmt(Number(el.value) + (e.key === 'ArrowUp' ? step : -step));
      commit(el);
    }
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('input, select')) return;
    const b = e.target.closest('[data-act], [data-pop]');
    if (!b || b.disabled || b.closest('.zset')) return;
    if (b.dataset.pop === 'close') { box.hidden = true; return; }
    const act = b.dataset.act, i = Number(b.dataset.v), m = get();
    if (act === 'pick') { sel = i; face = 0; render(); const n = m && massingGeometry(m)[i]?.name; if (n) onPick(n); }
    else if (act === 'pickname') { picked = b.dataset.v; render(); onPick(picked); }
    else if (act === 'face') { face = i; render(); }
    else if (act === 'del') change((x) => { deleteZone(x, i); sel = Math.min(sel, x.zones.length - 1); }, 'zone deleted');
    else if (act === 'rejoin') change((x) => { delete x.zones[sel].faces[face].broken[i]; }, 'window rejoined its array');
    else if (act === 'rejoin-all') change((x) => { x.zones[sel].faces[face].broken = {}; }, 'windows rejoined their array');
  });
  box.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pophd') || e.target.closest('button') || e.button !== 0) return;
    const r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const move = (m) => Object.assign(box.style, { left: `${m.clientX - x0}px`, top: `${m.clientY - y0}px`, right: 'auto' });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });
  return {
    render,
    // The zone (and face) picked in a view: the window turns to it.
    show(zone, f = 0) { sel = zone; face = f; render(); },
    showName(name) { const m = get(); if (m) { const i = massingGeometry(m).findIndex((z) => z.name === name); if (i >= 0) { if (i !== sel) face = 0; sel = i; } } else picked = name; render(); },
    reset() { sel = 0; face = 0; picked = null; },
  };
}
