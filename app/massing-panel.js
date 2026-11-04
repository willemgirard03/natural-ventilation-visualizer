// The Massing window: a building modelled as zones standing on levels (src/model/massing.js). The
// levels, each typed over (its elevation, or the height to the next, which moves the levels above);
// the zones, each between a base and a top level; and the selected zone's windows, face by face. Every
// change goes through `change`, which rewrites the model from the massing (applyMassing) as one
// undoable edit.

import { WINDOWS0, unitLayout, sideWindows, setWindowFigure, setWindowSize, spreadSide, moveLevel, faceLength, zoneHeight, faceBearing, compassWord, polyArea, levelName } from '../src/model/massing.js';
import { SIZES } from '../src/model/windows.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));
const GLAZING = [
  ['winW', 'Width', 'm', 'Each window’s width, held to its bay', 0.2],
  ['winH', 'Height', 'm', 'Each window’s height, held under the slab', 0.2],
  ['sill', 'Sill', 'm', 'Height of the sill above the zone’s floor', 0],
];

export function massingPanel(box, { get, change }) {
  let sel = 0, face = 0, allFaces = false, matchGlazing = false;

  function render() {
    const m = get();
    if (!m || box.hidden) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    sel = Math.min(sel, m.zones.length - 1);
    const z = m.zones[sel];
    face = Math.min(face, z.plate.length - 1);
    const g = z.faces[face];
    const num = (act, f, v, title, min, d = 2) => `<input class="popnum" data-act="${act}" data-f="${f}" data-min="${min}" value="${fmt(v, d)}" title="${esc(title)}">`;
    const zoneLabel = (i) => esc(m.zones[i].name || `${m.name || 'Floor'}${m.zones[i].base + 1}`);
    let h = '<div class="pophd" title="Drag to move"><span class="popttl">Massing</span><span class="popbtns"><button type="button" data-pop="close" title="Close">×</button></span></div><div class="libbody">';
    h += `<div class="poprow"><span class="tipped" title="Zones are named after it, with their base level's number and their own: Floor1_0, Floor2_1 …, as ClimateStudio names zones">Name</span> <input class="libname short" data-act="name" value="${esc(m.name || '')}" placeholder="Floor">`
      + `<span class="tipped" title="The whole building turned clockwise in plan">Turn</span> ${num('rot', 'rot', m.rot || 0, 'Degrees clockwise', -Infinity, 1)}°</div>`;
    // the levels, top first, as they stand
    h += '<table class="libtable mstable"><thead><tr><th title="The levels zones stand on and reach up to; moving one moves every zone on it">Level</th>'
      + '<th class="num" title="Its height above the ground level">Elevation<span class="unit"> m</span></th>'
      + '<th class="num" title="Up to the next level: typed, the levels above move with it">To next<span class="unit"> m</span></th><th></th></tr></thead><tbody>';
    for (let L = m.levels.length - 1; L >= 0; L--) {
      const lv = m.levels[L], used = m.zones.some((x) => x.base === L || x.top === L), next = m.levels[L + 1];
      h += `<tr data-lv="${L}"><td><input class="libname short" data-act="level-name" value="${esc(lv.name || levelName(L))}" title="Its name"></td>`
        + `<td class="num">${L ? num('level-z', 'z', lv.z, 'Elevation (m): this level alone moves', -Infinity) : '0'}</td>`
        + `<td class="num">${next ? num('level-h', 'h', next.z - lv.z, 'Height to the next level (m): the levels above move with it', 2) : ''}</td>`
        + `<td>${!used && L ? `<button type="button" class="pbtn x" data-act="level-del" data-v="${L}" title="Remove this level (no zone uses it)">×</button>` : ''}</td></tr>`;
    }
    h += '</tbody></table>';
    // the zones
    const lvOpts = (now, from, to) => m.levels.map((lv, L) => (L >= from && L <= to ? `<option value="${L}"${L === now ? ' selected' : ''}>${esc(lv.name || levelName(L))}</option>` : '')).join('');
    h += '<table class="libtable mstable"><thead><tr><th title="Click a zone to set its windows">Zone</th><th title="The level it stands on">Base</th><th title="The level its roof reaches">Top</th>'
      + '<th class="num" title="Its floor area">Area<span class="unit"> m²</span></th><th class="num" title="Its windows, all faces">Windows</th><th></th></tr></thead><tbody>';
    m.zones.forEach((x, i) => {
      const n = x.plate.reduce((a, _, k) => a + sideWindows(x.faces[k], faceLength(m, i, k), zoneHeight(m, i), x.slab).length, 0);
      h += `<tr class="${i === sel ? 'on' : ''}" data-zn="${i}"><td><button type="button" class="linkbtn" data-act="pick" data-v="${i}" title="Set this zone's windows">${zoneLabel(i)}</button></td>`
        + `<td><select class="popsel" data-act="zone-base">${lvOpts(x.base, 0, x.top - 1)}</select></td><td><select class="popsel" data-act="zone-top">${lvOpts(x.top, x.base + 1, m.levels.length - 1)}</select></td>`
        + `<td class="num">${fmt(Math.abs(polyArea(x.plate)), 1)}</td><td class="num">${n}</td>`
        + `<td>${m.zones.length > 1 ? `<button type="button" class="pbtn x" data-act="del" data-v="${i}" title="Remove this zone">×</button>` : ''}</td></tr>`;
    });
    h += '</tbody></table>';
    h += '<div class="poprow libfoot"><button type="button" class="pbtn" data-act="add" title="A level on top, the zones that reach the top level copied up onto it">+ Storey</button></div>';
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
    h += '</div>';
    box.innerHTML = h;
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
    if (act === 'level-name') { const L = Number(el.closest('[data-lv]').dataset.lv), v = el.value.trim() || levelName(L); change((x) => { x.levels[L].name = v; }, 'level renamed'); return; }
    let v = Number(el.value);
    if (!Number.isFinite(v)) { render(); return; }
    v = Math.max(Number(el.dataset.min) || (el.dataset.min === '-Infinity' ? -Infinity : 0), v);
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

  box.addEventListener('change', (e) => {
    const el = e.target, act = el.dataset.act;
    if (!act) return;
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
    if (e.key === 'Tab' && el.dataset.act === 'name' && !el.value) { el.value = el.placeholder; }
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
    const b = e.target.closest('[data-act], [data-pop]');
    if (!b || b.matches('input, select')) return;
    if (b.dataset.pop === 'close') { box.hidden = true; return; }
    const act = b.dataset.act, i = Number(b.dataset.v);
    if (act === 'pick') { sel = i; face = 0; render(); }
    else if (act === 'face') { face = i; render(); }
    else if (act === 'add') change((x) => {
      // a level on top, as high as the one under it; the zones reaching the old top copied up onto it
      const T = x.levels.length - 1, h = T ? x.levels[T].z - x.levels[T - 1].z : 3.5;
      x.levels.push({ name: levelName(T + 1), z: +(x.levels[T].z + h).toFixed(6) });
      for (const z of x.zones.filter((y) => y.top === T)) x.zones.push({ ...structuredClone(z), name: null, base: T, top: T + 1 });
      sel = x.zones.length - 1;
    }, 'storey added');
    else if (act === 'del') change((x) => { x.zones.splice(i, 1); sel = Math.min(sel, x.zones.length - 1); }, 'zone removed');
    else if (act === 'level-del') change((x) => {
      x.levels.splice(i, 1);
      for (const z of x.zones) { if (z.base > i) z.base--; if (z.top > i) z.top--; }
    }, 'level removed');
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
    // The zone and face of a window picked in the view, so the panel shows its array.
    show(zone, f) { sel = zone; face = f; render(); },
    reset() { sel = 0; face = 0; },
  };
}
