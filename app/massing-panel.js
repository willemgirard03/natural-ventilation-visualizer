// The Building window: a building modelled as zones standing on levels (src/model/massing.js), in three
// tabs.
//  - Levels: each typed over (its name, its elevation, or the height to the next, which moves the levels
//    above), and for the one picked, the storey-stack actions on the storey standing on it: a blank
//    storey or a copy put in above or below, the storey moved up or down a level, Remove storey.
//  - Views: the plan and section views made so far (none at first), renamed, re-cut or deleted, and
//    Create plan at level.
//  - Zones: each between a base and a top level, and the selected zone's windows, face by face.
// A change to the building goes through `change`, which rewrites the model from the massing
// (applyMassing) as one undoable edit; a change to the views only through `changeViews`.

import { insertStorey, swapStoreys, removeStorey, STOREYS_MAX, deleteZone, massingGeometry, WINDOWS0, unitLayout, sideWindows, setWindowFigure, setWindowSize, spreadSide, moveLevel, faceLength, zoneHeight, faceBearing, compassWord, polyArea, levelName } from '../src/model/massing.js';
import { SIZES } from '../src/model/windows.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));
// the storey-stack icons (the storey-stack skill), in currentColor
const ICO = {
  ins: '<rect x="-5" y="-4" width="10" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-2.5 0H2.5M0 -2.5V2.5" stroke="currentColor" stroke-width="1.2"/>',
  dup: '<rect x="-6" y="-5" width="8" height="7" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="-2" y="-2" width="8" height="7" fill="var(--panel)" stroke="currentColor" stroke-width="1.1"/>',
  mov: '<rect x="-4" y="-2.5" width="8" height="5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M0 -3.5V-6.5M0 3.5V6.5" stroke="currentColor"/><path d="M0 -8.5L2.2 -6H-2.2ZM0 8.5L2.2 6H-2.2Z" fill="currentColor"/>',
};
const ico = (k) => `<svg class="stico" viewBox="-7 -9 14 18" width="14" height="16" aria-hidden="true">${ICO[k]}</svg>`;
const TABS = [['levels', 'Levels', 'The levels zones stand on, and the storeys between them'], ['views', 'Views', 'Plan and section views of the building'], ['zones', 'Zones', 'The zones, and their windows']];
const CUT0 = 1.2; // a plan's cut height above its level, as drawn by convention
const GLAZING = [
  ['winW', 'Width', 'm', 'Each window’s width, held to its bay', 0.2],
  ['winH', 'Height', 'm', 'Each window’s height, held under the slab', 0.2],
  ['sill', 'Sill', 'm', 'Height of the sill above the zone’s floor', 0],
];

// onOpenView(id) opens a view in the workspace.
export function massingPanel(box, { get, change, changeViews, onOpenView = () => {} }) {
  let note = null; // why the last action was refused, shown once
  let tab = 'levels', sel = 0, face = 0, allFaces = false, matchGlazing = false, level = 0;
  const make = { level: 0, cut: CUT0, name: '' }; // Create plan at level, as typed so far

  function render() {
    const m = get();
    if (!m || box.hidden) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    let h = '<div class="pophd" title="Drag to move"><span class="popttl">Building</span><span class="tabs" role="tablist">'
      + TABS.map(([k, l, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}" title="${esc(t)}">${l}</button>`).join('')
      + '</span><span class="popbtns"><button type="button" data-pop="close" title="Close">×</button></span></div><div class="libbody">';
    if (note) { h += `<div class="poprow error-text">${esc(note)}</div>`; note = null; }
    h += tab === 'levels' ? levelsTab(m) : tab === 'views' ? viewsTab(m) : zonesTab(m);
    box.innerHTML = h + '</div>';
  }

  const num = (act, f, v, title, min, d = 2) => `<input class="popnum" data-act="${act}" data-f="${f}" data-min="${min}" value="${fmt(v, d)}" title="${esc(title)}">`;
  const lvName = (m, L) => esc(m.levels[L]?.name || levelName(L));
  const lvOpts = (m, now, from = 0, to = m.levels.length - 1) => m.levels.map((lv, L) => (L >= from && L <= to ? `<option value="${L}"${L === now ? ' selected' : ''}>${lvName(m, L)}</option>` : '')).join('');

  // ---------- Levels ----------
  // Row L is level L and the storey standing on it, up to level L + 1; the top level has none.
  function levelsTab(m) {
    const top = m.levels.length - 1;
    level = Math.max(0, Math.min(level, top));
    let h = '<table class="libtable mstable"><thead><tr><th title="The levels zones stand on and reach up to; click one for the actions on its storey">Level</th>'
      + '<th class="num" title="Its height above the ground level">Elevation<span class="unit"> m</span></th>'
      + '<th class="num" title="Up to the next level: typed, the levels above move with it">Height<span class="unit"> m</span></th><th class="num" title="Zones standing on it">Zones</th></tr></thead><tbody>';
    for (let L = top; L >= 0; L--) {
      const lv = m.levels[L], next = m.levels[L + 1], n = m.zones.filter((z) => z.base === L).length;
      h += `<tr data-lv="${L}" class="${L === level ? 'on' : ''}"><td><input class="libname short" data-act="level-name" value="${lvName(m, L)}" title="Its name"></td>`
        + `<td class="num">${L ? num('level-z', 'z', lv.z, 'Elevation (m): this level alone moves', -Infinity) : '0'}</td>`
        + `<td class="num">${next ? num('level-h', 'h', next.z - lv.z, 'Height to the next level (m): the levels above move with it', 2) : ''}</td>`
        + `<td class="num">${n || ''}</td></tr>`;
    }
    h += '</tbody></table>';
    // the picked level's storey: the storey-stack pop-up's rows
    const isTop = level === top, full = m.levels.length > STOREYS_MAX;
    const can = (fn) => { const x = structuredClone(m); return fn(x) !== false; };
    const upOK = !isTop && can((x) => swapStoreys(x, level)), downOK = !isTop && level > 0 && can((x) => swapStoreys(x, level - 1));
    const lastZones = m.zones.every((z) => z.base === level && z.top === level + 1);
    const b = (act, glyph, title, ok) => `<button type="button" class="pbtn arw" data-act="${act}"${ok ? '' : ' disabled'} title="${esc(title)}">${glyph}</button>`;
    const nm = lvName(m, level);
    h += `<div class="msub">${isTop ? `${nm}, the top level` : `Storey on ${nm}`}</div><div class="stgrid">`
      + `<div class="strow"><span title="Add a blank storey: as high as this one, with no zones">${ico('ins')}</span>${b('st-ins-up', '▲', isTop ? 'Add a level above the top one, as high as the storey under it' : 'Add a blank storey above it', !full)}${b('st-ins-down', '▼', 'Add a blank storey below it, in its place: it and everything above rise', !full && !isTop)}</div>`
      + `<div class="strow"><span title="Add a copy of this storey: its zones copied, with their settings and windows">${ico('dup')}</span>${b('st-dup-up', '▲', 'Add a copy of this storey above it', !full && !isTop)}${b('st-dup-down', '▼', 'Add a copy of this storey below it', !full && !isTop)}</div>`
      + `<div class="strow"><span title="Move this storey: it trades places with the one above or below, taking its zones and height (not where a zone runs through it into another)">${ico('mov')}</span>${b('st-up', '▲', 'Move this storey up a level', upOK)}${b('st-down', '▼', 'Move this storey down a level', downOK)}</div></div>`;
    if (m.levels.length > 2 && !isTop) h += `<div class="poprow"><button type="button" class="pbtn danger" data-act="st-del"${lastZones ? ' disabled title="The building\'s last zones stay"' : ' title="Take this storey out: its zones go, zones running through it lose its height, everything above drops by it"'}>Remove storey</button></div>`;
    return h;
  }

  // ---------- Views ----------
  function viewsTab(m) {
    const views = m.views || [];
    let h = '';
    for (const [kind, title, tip] of [['plan', 'Plans', 'A plan cut across the building at a height above a level, looking down'], ['section', 'Sections', 'A section cut by a clipping plane: made from the plane\'s pop-up']]) {
      const list = views.filter((v) => v.kind === kind);
      h += `<div class="msub" title="${esc(tip)}">${title}</div>`;
      if (!list.length) { h += `<div class="poprow muted">${kind === 'plan' ? 'None yet: create one below, or from a plan clipping plane.' : 'None yet: create one from a section clipping plane\'s pop-up.'}</div>`; continue; }
      h += '<table class="libtable mstable"><tbody>';
      for (const v of list) {
        h += `<tr data-view="${v.id}"><td><input class="libname" data-act="view-name" value="${esc(v.name)}" title="Its name"></td><td>`;
        if (kind === 'plan' && Number.isInteger(v.level)) h += `<select class="popsel" data-act="view-level" title="The level it is cut above">${lvOpts(m, v.level)}</select> + ${num('view-cut', 'cut', v.cut, 'Cut height above the level (m)', -Infinity)} m`;
        else h += `<span class="muted">${v.plane !== undefined && v.plane !== null ? 'Linked to its clipping plane' : 'Its own cut'}</span>`;
        h += '</td><td><button type="button" class="pbtn" data-act="view-open" title="Show it in a view">Open</button> <button type="button" class="pbtn x" data-act="view-del" title="Delete this view">×</button></td></tr>';
      }
      h += '</tbody></table>';
    }
    make.level = Math.min(make.level, m.levels.length - 1);
    h += '<div class="msub" title="A plan view of a level, cut at a height above it. It owns its cut: Cut 3D here, on its bar, adds a clipping plane linked to it.">Create plan at level</div><div class="poprow">'
      + `<select class="popsel" data-act="make-level" title="The level to cut above">${lvOpts(m, make.level)}</select> + ${num('make-cut', 'cut', make.cut, 'Cut height above the level (m)', -Infinity)} m `
      + `<input class="libname short" data-act="make-name" value="${esc(make.name)}" placeholder="${lvName(m, make.level)} plan" title="Its name (Tab takes the suggestion)"> `
      + '<button type="button" class="pbtn" data-act="make-plan" title="Make the plan view and open it">Create</button></div>';
    return h;
  }

  // ---------- Zones ----------
  function zonesTab(m) {
    sel = Math.min(sel, m.zones.length - 1);
    const z = m.zones[sel];
    face = Math.min(face, z.plate.length - 1);
    const g = z.faces[face];
    const zoneLabel = (i) => esc(m.zones[i].name || `${m.name || 'Floor'}${m.zones[i].base + 1}`);
    let h = `<div class="poprow"><span class="tipped" title="Zones are named after it, with their base level's number and their own: Floor1_0, Floor2_1 …, as ClimateStudio names zones">Name</span> <input class="libname short" data-act="name" value="${esc(m.name || '')}" placeholder="Floor">`
      + `<span class="tipped" title="The whole building turned clockwise in plan">Turn</span> ${num('rot', 'rot', m.rot || 0, 'Degrees clockwise', -Infinity, 1)}°</div>`;
    // the zones
    h += '<table class="libtable mstable"><thead><tr><th title="Click a zone to set its windows">Zone</th><th title="The level it stands on">Base</th><th title="The level its roof reaches">Top</th>'
      + '<th class="num" title="Its floor area">Area<span class="unit"> m²</span></th><th class="num" title="Its windows, all faces">Windows</th><th></th></tr></thead><tbody>';
    const made = massingGeometry(m); // the windows as written: none where a face meets another zone
    m.zones.forEach((x, i) => {
      const n = made[i].windows.length;
      h += `<tr class="${i === sel ? 'on' : ''}" data-zn="${i}"><td><button type="button" class="linkbtn" data-act="pick" data-v="${i}" title="Set this zone's windows">${zoneLabel(i)}</button></td>`
        + `<td><select class="popsel" data-act="zone-base">${lvOpts(m, x.base, 0, x.top - 1)}</select></td><td><select class="popsel" data-act="zone-top">${lvOpts(m, x.top, x.base + 1)}</select></td>`
        + `<td class="num">${fmt(Math.abs(polyArea(x.plate)), 1)}</td><td class="num">${n}</td>`
        + `<td>${m.zones.length > 1 ? `<button type="button" class="pbtn x" data-act="del" data-v="${i}" title="Remove this zone">×</button>` : ''}</td></tr>`;
    });
    h += '</tbody></table>';
    // the selected zone's windows, face by face
    const word = (k) => compassWord(faceBearing(m, sel, k));
    h += `<div class="msub">Windows: ${zoneLabel(sel)}</div><div class="poprow">`
      + z.plate.map((_, k) => `<button type="button" class="pbtn side" data-act="face" data-v="${k}" aria-pressed="${k === face}" title="Face ${k + 1}, looking ${word(k)}, ${fmt(faceLength(m, sel, k))} m">${word(k)}${z.plate.filter((__, q) => word(q) === word(k)).length > 1 ? ` ${k + 1}` : ''}</button>`).join('')
      + `<label class="chk" title="Changes to the windows go to all the faces of this zone"><input type="checkbox" data-act="all-faces"${allFaces ? ' checked' : ''}> All faces</label>`
      + `<label class="chk" title="Changes to the windows go to the zones stacked above too, on their face looking the same way"><input type="checkbox" data-act="match-glazing"${matchGlazing ? ' checked' : ''}> Zones above match</label></div>`;
    h += `<div class="poprow"><label class="chk" title="Whether this face has windows"><input type="checkbox" data-act="has-win"${g ? ' checked' : ''}> Windows</label>`;
    if (g) {
      const len = faceLength(m, sel, face), lay = unitLayout(g, len), made = sideWindows(g, len, zoneHeight(m, sel), z.slab).length;
      h += `<select class="popsel" data-act="glz" data-f="winBy" title="By number: the face divided into equal bays, a window in each. By spacing: bays of a set pitch, centred on the face, plain wall left at the ends."><option value="number"${g.winBy !== 'spacing' ? ' selected' : ''}>By number</option><option value="spacing"${g.winBy === 'spacing' ? ' selected' : ''}>By spacing</option></select>`
        + (g.winBy === 'spacing' ? `<span class="tipped" title="Centre to centre">Spacing</span> ${num('glz', 'winSp', g.winSp, 'Spacing (m), centre to centre', 0.3)} m <span class="muted">${lay.n} windows</span>`
          : `<span>Count</span> ${num('glz', 'winN', g.winN, 'How many windows', 1, 0)} <span class="muted">${fmt(lay.pitch)} m bays</span>`) + '</div><div class="poprow">'
        + GLAZING.map(([f, l, u, t, min]) => `<span class="tipped" title="${esc(t)}">${l}</span> ${num('glz', f, g[f], `${l} (${u})`, min)} ${u}`).join(' ')
        + `<span class="tipped" title="How the windows' edges hold as the zone's height or the bay changes. Fixed: their own width and height. Offsets: the head a set distance under the slab, each jamb a set distance in from its bay (glass bay to bay, up to the slab, is Offsets of 0). Proportional: shares of the wall's height and the bay. Switching never moves the glass.">Size</span> <select class="popsel" data-act="glz-size">${SIZES.map(([v, l]) => `<option value="${v}"${(g.size || (g.fillW || g.fillH ? 'offset' : 'fixed')) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
      if (made < lay.n) h += `<div class="poprow muted">${lay.n - made} of the windows are too small to make.</div>`;
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
    if (act === 'view-name') { const id = viewId(el), v = el.value.trim(); if (v) changeViews((x) => { viewOf(x, id).name = v; }, 'view renamed'); else render(); return; }
    if (act === 'make-name') { make.name = el.value; return; }
    if (act === 'level-name') { const L = Number(el.closest('[data-lv]').dataset.lv), v = el.value.trim() || levelName(L); change((x) => { x.levels[L].name = v; }, 'level renamed'); return; }
    let v = Number(el.value);
    if (!Number.isFinite(v)) { render(); return; }
    v = Math.max(Number(el.dataset.min) || (el.dataset.min === '-Infinity' ? -Infinity : 0), v);
    if (act === 'view-cut') { const id = viewId(el); changeViews((x) => { viewOf(x, id).cut = v; }, 'plan cut height set'); return; }
    if (act === 'make-cut') { make.cut = v; return; }
    if (act === 'rot') change((x) => { x.rot = v; }, 'building turned');
    else if (act === 'level-z') { const L = Number(el.closest('[data-lv]').dataset.lv); change((x) => moveLevel(x, L, v - x.levels[L].z, false), `${m.levels[L].name} moved`); }
    else if (act === 'level-h') { const L = Number(el.closest('[data-lv]').dataset.lv); change((x) => moveLevel(x, L + 1, v - (x.levels[L + 1].z - x.levels[L].z), true), `${m.levels[L].name} height set`); }
    else if (act === 'glz') change((x) => edit(x, (i, k) => {
      const g = x.zones[i].faces[k];
      if (!g) return;
      // a window's own figures go through its Size, so each way it keeps them stays true
      if (['winW', 'winH', 'sill'].includes(f)) setWindowFigure(x, i, k, undefined, f, v); else g[f] = f === 'winN' ? Math.round(v) : v;
    }), `windows ${f} set`);
  }

  const viewId = (el) => Number(el.closest('[data-view]').dataset.view);
  const viewOf = (m, id) => m.views.find((v) => v.id === id);
  box.addEventListener('change', (e) => {
    const el = e.target, act = el.dataset.act;
    if (!act) return;
    if (act === 'view-level') { const id = viewId(el), L = Number(el.value); changeViews((x) => { viewOf(x, id).level = L; }, 'plan level set'); return; }
    if (act === 'make-level') { make.level = Number(el.value); render(); return; }
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
    if (!el.matches('input')) return;
    if (e.key === 'Tab' && (el.dataset.act === 'name' || el.dataset.act === 'make-name') && !el.value) { el.value = el.placeholder; if (el.dataset.act === 'make-name') make.name = el.value; }
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
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; render(); return; }
    const row = e.target.closest('tr[data-lv]');
    if (row && !e.target.matches('input, select')) { level = Number(row.dataset.lv); render(); return; }
    const b = e.target.closest('[data-act], [data-pop]');
    if (!b || b.matches('input, select') || b.disabled) return;
    if (b.dataset.pop === 'close') { box.hidden = true; return; }
    if (b.dataset.act?.startsWith('st-')) { storey(b.dataset.act); return; }
    if (b.dataset.act?.startsWith('view-') || b.dataset.act === 'make-plan') { views(b); return; }
    const act = b.dataset.act, i = Number(b.dataset.v);
    if (act === 'pick') { sel = i; face = 0; render(); }
    else if (act === 'face') { face = i; render(); }
    else if (act === 'del') change((x) => { deleteZone(x, i); sel = Math.min(sel, x.zones.length - 1); }, 'zone deleted');
    else if (act === 'rejoin') change((x) => { delete x.zones[sel].faces[face].broken[i]; }, 'window rejoined its array');
    else if (act === 'rejoin-all') change((x) => { x.zones[sel].faces[face].broken = {}; }, 'windows rejoined their array');
  });
  // the storey-stack actions on the picked level's storey; the result picked after
  function storey(act) {
    const L = level, nm = get().levels[L]?.name || levelName(L);
    let why = null;
    const done = {
      'st-ins-up': () => change((x) => { level = insertStorey(x, L, 'above'); }, `storey added above ${nm}`),
      'st-ins-down': () => change((x) => { level = insertStorey(x, L, 'below'); }, `storey added below ${nm}`),
      'st-dup-up': () => change((x) => { level = insertStorey(x, L, 'above', true); }, `storey on ${nm} copied above`),
      'st-dup-down': () => change((x) => { level = insertStorey(x, L, 'below', true); }, `storey on ${nm} copied below`),
      'st-up': () => change((x) => { if (swapStoreys(x, L)) level = L + 1; else why = 'A zone runs through this storey into the next.'; }, `storey on ${nm} moved up`),
      'st-down': () => change((x) => { if (swapStoreys(x, L - 1)) level = L - 1; else why = 'A zone runs through this storey into the next.'; }, `storey on ${nm} moved down`),
      'st-del': () => change((x) => { removeStorey(x, L); level = Math.min(L, x.levels.length - 1); }, `storey on ${nm} removed`),
    }[act];
    done?.();
    note = why;
    render();
  }
  function views(b) {
    const m = get(), act = b.dataset.act;
    if (act === 'make-plan') {
      const L = make.level, name = make.name.trim() || `${m.levels[L]?.name || levelName(L)} plan`;
      let made = null;
      changeViews((x) => { x.views ||= []; made = { id: Math.max(0, ...x.views.map((v) => v.id + 1)), kind: 'plan', name, level: L, cut: make.cut }; x.views.push(made); }, `plan view ${name} created`);
      make.name = '';
      render();
      if (made) onOpenView(made.id);
      return;
    }
    const id = viewId(b);
    if (act === 'view-open') onOpenView(id);
    else if (act === 'view-del') { changeViews((x) => { x.views = x.views.filter((v) => v.id !== id); }, 'view deleted'); render(); }
  }
  box.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pophd') || e.target.closest('button') || e.button !== 0) return;
    const r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const move = (m) => Object.assign(box.style, { left: `${m.clientX - x0}px`, top: `${m.clientY - y0}px`, right: 'auto' });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });
  return {
    render,
    // The zone and face of a window picked in the view, so the panel shows its array.
    show(zone, f) { sel = zone; face = f; tab = 'zones'; render(); },
    showTab(k) { tab = k; render(); },
    reset() { sel = 0; face = 0; level = 0; tab = 'levels'; },
  };
}
