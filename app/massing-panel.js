// The Massing window: a building modelled as storeys of floor plates, one zone each, with a window
// array on each side (as the Solar Shading Explorer's massing). Every change goes through `change`,
// which rewrites the model from the massing (src/model/massing.js applyMassing) as one undoable edit.

import { SIDES, WINDOWS0, storey0, unitLayout, sideWindows, setWindowFigure, setWindowSize, spreadSide } from '../src/model/massing.js';
import { SIZES } from '../src/model/windows.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const SIDE_NAMES = { S: 'South', E: 'East', N: 'North', W: 'West' };
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));

// The plate's figures: field, label, unit, tooltip, smallest value.
const PLATE = [
  ['h', 'Height', 'm', 'Floor to floor: the storey and the slab over it', 2],
  ['w', 'Width', 'm', 'Along x (east–west before the building is turned): the length of its south and north sides', 1],
  ['d', 'Depth', 'm', 'Along y (north–south): the length of its east and west sides', 1],
  ['ox', 'Offset x', 'm', 'Where the plate’s middle is, east of the building’s origin: a storey set back or cantilevered', -Infinity],
  ['oy', 'Offset y', 'm', 'Where the plate’s middle is, north of the building’s origin', -Infinity],
];
const GLAZING = [
  ['winW', 'Width', 'm', 'Each window’s width, held to its bay', 0.2],
  ['winH', 'Height', 'm', 'Each window’s height, held under the slab', 0.2],
  ['sill', 'Sill', 'm', 'Height of the sill above the storey’s floor', 0],
];

export function massingPanel(box, { get, change }) {
  let sel = 0, side = 'S', allSides = false, matchPlate = true, matchGlazing = false;

  function render() {
    const m = get();
    if (!m || box.hidden) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    sel = Math.min(sel, m.storeys.length - 1);
    const s = m.storeys[sel], g = s.sides[side];
    const num = (act, f, v, title, min, d = 2) => `<input class="popnum" data-act="${act}" data-f="${f}" data-min="${min}" value="${fmt(v, d)}" title="${esc(title)}">`;
    let h = '<div class="pophd" title="Drag to move"><span class="popttl">Massing</span><span class="popbtns"><button type="button" data-pop="close" title="Close">×</button></span></div><div class="libbody">';
    h += `<div class="poprow"><span class="tipped" title="Zones are named after it, with each storey’s number: Floor1_0, Floor2_1 …, as ClimateStudio names zones">Name</span> <input class="libname short" data-act="name" value="${esc(m.name || '')}" placeholder="Floor">`
      + `<span class="tipped" title="The whole building turned clockwise in plan; the sides keep their names">Turn</span> ${num('rot', 'rot', m.rot || 0, 'Degrees clockwise', -Infinity, 1)}°</div>`;
    // the storeys, top first, as they stand
    h += '<table class="libtable mstable"><thead><tr><th title="Click a storey to set its windows">Storey</th>'
      + PLATE.map(([, l, u, t]) => `<th class="num" title="${esc(t)}">${l}<span class="unit"> ${u}</span></th>`).join('')
      + '<th class="num" title="Windows in the storey, all sides">Windows</th><th></th></tr></thead><tbody>';
    for (let i = m.storeys.length - 1; i >= 0; i--) {
      const p = m.storeys[i], n = SIDES.reduce((a, f) => a + sideWindows(p.sides[f], f === 'N' || f === 'S' ? p.w : p.d, p.h, p.slab).length, 0);
      h += `<tr class="${i === sel ? 'on' : ''}" data-st="${i}"><td><button type="button" class="linkbtn" data-act="pick" data-v="${i}" title="Set this storey’s windows">${esc(p.name || `${m.name || 'Floor'}${i + 1}`)}</button></td>`
        + PLATE.map(([f, l, u, t, min]) => `<td class="num">${num('plate', f, p[f], `${l} (${u}): ${t}`, min)}</td>`).join('')
        + `<td class="num">${n}</td><td>${m.storeys.length > 1 ? `<button type="button" class="pbtn x" data-act="del" data-v="${i}" title="Remove this storey (its zone goes with it)">×</button>` : ''}</td></tr>`;
    }
    h += '</tbody></table>';
    h += `<div class="poprow libfoot"><button type="button" class="pbtn" data-act="add" title="A storey on top, a copy of the top one">+ Storey</button>`
      + `<label class="chk" title="A plate’s height, width, depth and offsets changed on one storey go to every storey above it too"><input type="checkbox" data-act="match-plate"${matchPlate ? ' checked' : ''}> Storeys above match</label></div>`;
    // the selected storey's windows, side by side
    h += `<div class="msub">Windows: ${esc(s.name || `${m.name || 'Floor'}${sel + 1}`)}</div><div class="poprow">`
      + SIDES.map((f) => `<button type="button" class="pbtn side" data-act="side" data-v="${f}" aria-pressed="${f === side}" title="${SIDE_NAMES[f]} side${f === 'N' || f === 'S' ? '' : ''}">${f}</button>`).join('')
      + `<label class="chk" title="Changes to the windows go to all four sides of this storey"><input type="checkbox" data-act="all-sides"${allSides ? ' checked' : ''}> All sides</label>`
      + `<label class="chk" title="Changes to the windows go to the same side of every storey above too"><input type="checkbox" data-act="match-glazing"${matchGlazing ? ' checked' : ''}> Storeys above match</label></div>`;
    h += `<div class="poprow"><label class="chk" title="Whether this side has windows"><input type="checkbox" data-act="has-win"${g ? ' checked' : ''}> Windows</label>`;
    if (g) {
      const len = side === 'N' || side === 'S' ? s.w : s.d, lay = unitLayout(g, len), made = sideWindows(g, len, s.h, s.slab).length;
      h += `<select class="popsel" data-act="glz" data-f="winBy" title="By number: the side divided into equal bays, a window in each. By spacing: bays of a set pitch, centred on the side, plain wall left at the ends."><option value="number"${g.winBy !== 'spacing' ? ' selected' : ''}>By number</option><option value="spacing"${g.winBy === 'spacing' ? ' selected' : ''}>By spacing</option></select>`
        + (g.winBy === 'spacing' ? `<span class="tipped" title="Centre to centre">Spacing</span> ${num('glz', 'winSp', g.winSp, 'Spacing (m), centre to centre', 0.3)} m <span class="muted">${lay.n} windows</span>`
          : `<span>Count</span> ${num('glz', 'winN', g.winN, 'How many windows', 1, 0)} <span class="muted">${fmt(lay.pitch)} m bays</span>`) + '</div><div class="poprow">'
        + GLAZING.map(([f, l, u, t, min]) => `<span class="tipped" title="${esc(t)}">${l}</span> ${num('glz', f, g[f], `${l} (${u})`, min)} ${u}`).join(' ')
        + `<span class="tipped" title="How the windows' edges hold as the storey's height or the bay changes. Fixed: their own width and height. Offsets: the head a set distance under the slab, each jamb a set distance in from its bay (glass bay to bay, up to the slab, is Offsets of 0). Proportional: shares of the wall's height and the bay. Switching never moves the glass.">Size</span> <select class="popsel" data-act="glz-size">${SIZES.map(([v, l]) => `<option value="${v}"${(g.size || (g.fillW || g.fillH ? 'offset' : 'fixed')) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
      if (made < lay.n) h += `<div class="poprow muted">${lay.n - made} of the windows are too small to make.</div>`;
      const broken = Object.keys(g.broken || {}).map(Number).sort((a, b) => a - b);
      if (broken.length) {
        h += '<div class="poprow"><span class="tipped" title="Windows of this array given their own size and place, by dragging them in the view. Rejoin puts one back in the array.">Broken out</span> '
          + broken.map((i) => { const b = g.broken[i]; return `<span class="mbroken">${i + 1}: ${fmt(b.winW)} × ${fmt(b.winH)} m <button type="button" class="pbtn x" data-act="rejoin" data-v="${i}" title="Back into the array">↺</button></span>`; }).join(' ')
          + (broken.length > 1 ? ' <button type="button" class="pbtn" data-act="rejoin-all" title="Put every broken-out window on this side back into the array">Rejoin all</button>' : '') + '</div>';
      }
    } else h += '</div>';
    h += '</div>';
    box.innerHTML = h;
  }

  // The sides and storeys an edit to the selected side's windows goes to.
  const glazingTargets = (m) => {
    const out = [];
    for (let i = sel; i < (matchGlazing ? m.storeys.length : sel + 1); i++) for (const f of allSides ? SIDES : [side]) out.push([m.storeys[i], f, i]);
    return out;
  };
  function commit(el) {
    const act = el.dataset.act, f = el.dataset.f, m = get();
    if (!m) return;
    if (act === 'name') { const v = el.value.trim() || 'Floor'; if (v !== m.name) change((x) => { x.name = v; }, 'massing renamed'); return; }
    let v = Number(el.value);
    if (!Number.isFinite(v)) { render(); return; }
    v = Math.max(Number(el.dataset.min) || (el.dataset.min === '-Infinity' ? -Infinity : 0), v);
    if (act === 'rot') change((x) => { x.rot = v; }, 'building turned');
    else if (act === 'plate') {
      const i0 = Number(el.closest('[data-st]').dataset.st);
      change((x) => { for (let i = i0; i < (matchPlate ? x.storeys.length : i0 + 1); i++) x.storeys[i][f] = v; }, `storey ${f} set`);
    } else if (act === 'glz') change((x) => {
      for (const [s, sd, i] of glazingTargets(x)) {
        if (!s.sides[sd]) continue;
        // a window's own figures go through its Size, so each way it keeps them stays true
        if (['winW', 'winH', 'sill'].includes(f)) setWindowFigure(x, i, sd, undefined, f, v); else s.sides[sd][f] = f === 'winN' ? Math.round(v) : v;
        spreadSide(x, i, sd);
      }
    }, `windows ${f} set`);
  }

  box.addEventListener('change', (e) => {
    const el = e.target, act = el.dataset.act;
    if (!act) return;
    if (act === 'match-plate') { matchPlate = el.checked; return; }
    if (act === 'match-glazing') { matchGlazing = el.checked; return; }
    if (act === 'all-sides') { allSides = el.checked; return; }
    if (act === 'has-win') { change((x) => { for (const [s, sd] of glazingTargets(x)) s.sides[sd] = el.checked ? (s.sides[sd] || WINDOWS0()) : null; }, el.checked ? 'windows added' : 'windows removed'); return; }
    if (act === 'glz-size') { change((x) => { for (const [s, sd, i] of glazingTargets(x)) if (s.sides[sd]) { setWindowSize(x, i, sd, undefined, el.value); spreadSide(x, i, sd); } }, `windows sized ${el.value}`); return; }
    if (act === 'glz' && el.tagName === 'SELECT') { change((x) => { for (const [s, sd] of glazingTargets(x)) if (s.sides[sd]) s.sides[sd].winBy = el.value; }, 'windows set out'); return; }
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
    if (!b) return;
    if (b.dataset.pop === 'close') { box.hidden = true; return; }
    const act = b.dataset.act, i = Number(b.dataset.v);
    if (act === 'pick') { sel = i; render(); }
    else if (act === 'side') { side = b.dataset.v; render(); }
    else if (act === 'add') change((x) => { const top = x.storeys[x.storeys.length - 1]; x.storeys.push({ ...structuredClone(top), name: null }); sel = x.storeys.length - 1; }, 'storey added');
    else if (act === 'del') change((x) => { x.storeys.splice(i, 1); sel = Math.min(sel, x.storeys.length - 1); }, 'storey removed');
    else if (act === 'rejoin') change((x) => { delete x.storeys[sel].sides[side].broken[i]; }, 'window rejoined its array');
    else if (act === 'rejoin-all') change((x) => { x.storeys[sel].sides[side].broken = {}; }, 'windows rejoined their array');
  });
  box.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pophd') || e.target.closest('button') || e.button !== 0) return;
    const r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const move = (m) => Object.assign(box.style, { left: `${m.clientX - x0}px`, top: `${m.clientY - y0}px`, right: 'auto' });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });
  // focus moving off a figure commits it (change does too; this catches a blur with no change event)
  return {
    render,
    // The storey and side of a window picked in the view, so the panel shows its array.
    show(storey, f) { sel = storey; side = f; render(); },
    reset() { sel = 0; side = 'S'; },
  };
}

export { storey0 };
