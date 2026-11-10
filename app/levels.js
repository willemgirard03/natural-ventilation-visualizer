// Levels shown and edited in the views, as Revit's level markers: in the 3D view, a dashed line along
// the building's front edge at each level, carried past its end to a tag with the level's name and
// elevation, and between each level and the next its storey's height. The same marks are drawn in
// section views (workspace.js), which call the same edits.
//  - A click on a marker selects its level: the line turns to glass, and a pop-up opens with the
//    storey-stack rows (the storey-stack skill) for the storey standing on it: a blank storey or a copy
//    put in above or below, the storey moved up or down, Remove storey; and the level's name.
//  - A selected level dragged up or down moves that level alone (the storeys either side change height),
//    by 50 mm steps (10 mm with Shift).
//  - The elevation and the storey height are typed over: a click on either asks for the figure. The
//    elevation moves the level alone; the height moves every level above.
// Levels belong to a massing (src/model/massing.js); every change goes through change(mutate, what).

import * as THREE from 'three';
import { insertStorey, swapStoreys, removeStorey, STOREYS_MAX, moveLevel, levelName } from '../src/model/massing.js';
import { askNumber } from './sections.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => (+Number(x).toFixed(d)).toFixed(d);
// the storey-stack icons, in currentColor
const ICO = {
  ins: '<rect x="-5" y="-4" width="10" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-2.5 0H2.5M0 -2.5V2.5" stroke="currentColor" stroke-width="1.2"/>',
  dup: '<rect x="-6" y="-5" width="8" height="7" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="-2" y="-2" width="8" height="7" fill="var(--panel)" stroke="currentColor" stroke-width="1.1"/>',
  mov: '<rect x="-4" y="-2.5" width="8" height="5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M0 -3.5V-6.5M0 3.5V6.5" stroke="currentColor"/><path d="M0 -8.5L2.2 -6H-2.2ZM0 8.5L2.2 6H-2.2Z" fill="currentColor"/>',
};
const ico = (k) => `<svg class="stico" viewBox="-7 -9 14 18" width="14" height="16" aria-hidden="true">${ICO[k]}</svg>`;
export const lvName = (m, L) => m.levels[L]?.name || levelName(L);

// ---------- the storey-stack rows and what they do ----------
// The rows for the storey standing on level L (the top level has none above it: only a level added).
export function storeyRows(m, L) {
  const top = m.levels.length - 1, isTop = L === top, full = m.levels.length > STOREYS_MAX;
  const can = (fn) => { const x = structuredClone(m); return fn(x) !== false; };
  const upOK = !isTop && can((x) => swapStoreys(x, L)), downOK = !isTop && L > 0 && can((x) => swapStoreys(x, L - 1));
  const lastZones = m.zones.every((z) => z.base === L && z.top === L + 1);
  const b = (act, glyph, title, ok) => `<button type="button" class="pbtn arw" data-st="${act}"${ok ? '' : ' disabled'} title="${esc(title)}">${glyph}</button>`;
  let h = '<div class="stgrid">'
    + `<div class="strow"><span title="Add a blank storey: as high as this one, with no zones">${ico('ins')}</span>${b('ins-up', '▲', isTop ? 'Add a level above the top one, as high as the storey under it' : 'Add a blank storey above it', !full)}${b('ins-down', '▼', 'Add a blank storey below it, in its place: it and everything above rise', !full && !isTop)}</div>`
    + `<div class="strow"><span title="Add a copy of this storey: its zones copied, with their settings and windows">${ico('dup')}</span>${b('dup-up', '▲', 'Add a copy of this storey above it', !full && !isTop)}${b('dup-down', '▼', 'Add a copy of this storey below it', !full && !isTop)}</div>`
    + `<div class="strow"><span title="Move this storey: it trades places with the one above or below, taking its zones and height (not where a zone runs through it into another)">${ico('mov')}</span>${b('up', '▲', 'Move this storey up a level', upOK)}${b('down', '▼', 'Move this storey down a level', downOK)}</div></div>`;
  if (m.levels.length > 2 && !isTop) h += `<div class="poprow"><button type="button" class="pbtn danger" data-st="del"${lastZones ? ' disabled title="The building\'s last zones stay"' : ' title="Take this storey out: its zones go, zones running through it lose its height, everything above drops by it"'}>Remove storey</button></div>`;
  return h;
}
// One of those actions on massing m (inside a change). Returns { level: the level picked after, why }.
export function storeyAction(m, L, act) {
  let level = L, why = null;
  if (act === 'ins-up') level = insertStorey(m, L, 'above');
  else if (act === 'ins-down') level = insertStorey(m, L, 'below');
  else if (act === 'dup-up') level = insertStorey(m, L, 'above', true);
  else if (act === 'dup-down') level = insertStorey(m, L, 'below', true);
  else if (act === 'up') { if (swapStoreys(m, L)) level = L + 1; else why = 'A zone runs through this storey into the next.'; }
  else if (act === 'down') { if (swapStoreys(m, L - 1)) level = L - 1; else why = 'A zone runs through this storey into the next.'; }
  else if (act === 'del') { removeStorey(m, L); level = Math.min(L, m.levels.length - 1); }
  return { level, why };
}
const WHAT = { 'ins-up': 'storey added above', 'ins-down': 'storey added below', 'dup-up': 'storey copied above', 'dup-down': 'storey copied below', up: 'storey moved up', down: 'storey moved down', del: 'storey removed' };

// ---------- the levels' edits, shared by the 3D view and the sections ----------
// A small window off the level picked: its name, its figures, the storey rows.
export class LevelEdits {
  // massing() -> the massing; change(mutate, what); onSelect(L or null)
  constructor({ massing, change, onSelect = () => {} }) {
    Object.assign(this, { massing, change, onSelect });
    this.selected = null;
    this.pop = document.createElement('div');
    this.pop.className = 'lvpop';
    this.pop.hidden = true;
    document.body.appendChild(this.pop);
    this.pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-st], [data-lvclose]');
      if (!b || b.disabled) return;
      if (b.dataset.lvclose !== undefined) { this.select(null); return; }
      const L = this.selected, m = this.massing();
      let res = null;
      this.change((x) => { res = storeyAction(x, L, b.dataset.st); }, `${WHAT[b.dataset.st]} (${lvName(m, L)})`);
      this.note = res?.why || null;
      this.select(res ? res.level : L, this.at);
    });
    this.pop.addEventListener('change', (e) => {
      const t = e.target, L = this.selected, m = this.massing();
      if (t.dataset.lvf === 'name') { const v = t.value.trim() || levelName(L); if (v !== lvName(m, L)) this.change((x) => { x.levels[L].name = v; }, 'level renamed'); }
      else if (t.dataset.lvf === 'z') this.setElevation(L, Number(t.value));
      else if (t.dataset.lvf === 'h') this.setHeight(L, Number(t.value));
      this.render();
    });
    this.pop.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur?.(); e.stopPropagation(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.selected !== null && !e.target.closest?.('input')) { this.select(null); } });
  }
  setElevation(L, z) { if (Number.isFinite(z) && L > 0) this.change((x) => moveLevel(x, L, z - x.levels[L].z, false), `${lvName(this.massing(), L)} moved to ${fmt(z)} m`); }
  setHeight(L, h) { const m = this.massing(); if (Number.isFinite(h) && h > 0 && m.levels[L + 1]) this.change((x) => moveLevel(x, L + 1, h - (x.levels[L + 1].z - x.levels[L].z), true), `storey on ${lvName(m, L)} ${fmt(h)} m high`); }
  move(L, dz) { if (dz) this.change((x) => moveLevel(x, L, dz, false), `${lvName(this.massing(), L)} moved ${dz > 0 ? 'up' : 'down'} ${Math.round(Math.abs(dz) * 1000)} mm`); }
  // a figure clicked: typed over
  ask(e, L, what) {
    const m = this.massing(), host = e.target.closest('.view') || document.body;
    if (what === 'z') askNumber(host, e, `elevation m, now ${fmt(m.levels[L].z)}`, (v) => this.setElevation(L, v), true);
    else askNumber(host, e, `storey height m, now ${fmt(m.levels[L + 1].z - m.levels[L].z)}`, (v) => this.setHeight(L, v));
  }
  // The level picked (null: none), its pop-up opened at the point (client px) given.
  select(L, at = this.at) {
    const m = this.massing();
    this.selected = m && L !== null && L >= 0 && L < m.levels.length ? L : null;
    this.at = at;
    this.render();
    this.onSelect(this.selected);
  }
  render() {
    const m = this.massing(), L = this.selected;
    if (!m || L === null) { this.pop.hidden = true; return; }
    const next = m.levels[L + 1];
    this.pop.innerHTML = `<div class="pophd"><span class="popttl">Level</span><span class="popbtns"><button type="button" data-lvclose title="Close; Esc lets go of the level">×</button></span></div>`
      + (this.note ? `<div class="poprow error-text">${esc(this.note)}</div>` : '')
      + `<div class="poprow"><input class="libname short" data-lvf="name" value="${esc(lvName(m, L))}" title="Its name"></div>`
      + `<div class="poprow"><span class="tipped" title="Its height above the ground level: typed, this level alone moves">Elevation</span> ${L ? `<input class="popnum" data-lvf="z" value="${fmt(m.levels[L].z)}"> m` : '0.00 m'}</div>`
      + (next ? `<div class="poprow"><span class="tipped" title="Up to the next level: typed, every level above moves with it">Storey height</span> <input class="popnum" data-lvf="h" value="${fmt(next.z - m.levels[L].z)}"> m</div>` : '')
      + `<div class="msub">${next ? 'Storey on it' : 'The top level'}</div>` + storeyRows(m, L);
    this.note = null;
    this.pop.hidden = false;
    const [x, y] = this.at || [innerWidth / 2, innerHeight / 2], w = this.pop.offsetWidth, h = this.pop.offsetHeight;
    Object.assign(this.pop.style, { left: `${Math.max(8, Math.min(x + 16, innerWidth - w - 8))}px`, top: `${Math.max(8, Math.min(y - h / 2, innerHeight - h - 8))}px` });
  }
}

// ---------- the markers in the 3D view ----------
export class LevelMarks3D {
  // view: the View3D; edits: the LevelEdits; massing() -> the massing
  constructor(view, edits, massing) {
    Object.assign(this, { view, edits, massing });
    this.on = true;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'lvmarks');
    view.container.appendChild(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
  }
  // where the markers run: the building's bottom edge nearest the eye, carried past its left end
  frame() {
    const v = this.view, box = v.sections?.box?.();
    if (!box || box.isEmpty()) return null;
    const { min, max } = box, c = [[min.x, min.y], [max.x, min.y], [max.x, max.y], [min.x, max.y]];
    const S = (p, z) => { const s = v.sections.screen(new THREE.Vector3(p[0], p[1], z)); return [s.x, s.y]; };
    const z0 = min.z, sc = c.map((p) => S(p, z0));
    // the corner nearest the eye (lowest on screen), and of its two edges the longer on screen
    const k = sc.reduce((best, p, i) => (p[1] > sc[best][1] ? i : best), 0);
    const len = (i, j) => Math.hypot(sc[i][0] - sc[j][0], sc[i][1] - sc[j][1]);
    const j = len(k, (k + 1) % 4) >= len(k, (k + 3) % 4) ? (k + 1) % 4 : (k + 3) % 4;
    let a = c[k], b = c[j];
    if (sc[k][0] > sc[j][0]) [a, b] = [b, a]; // a: the left end on screen
    const ext = [a[0] + (a[0] - b[0]) * 0.22, a[1] + (a[1] - b[1]) * 0.22];
    return { a, b, ext, S };
  }
  draw() {
    const m = this.massing(), v = this.view;
    const canvas = v.renderer.domElement, cr = canvas.getBoundingClientRect(), kr = v.container.getBoundingClientRect();
    Object.assign(this.svg.style, { left: `${cr.left - kr.left}px`, top: `${cr.top - kr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` });
    const fr = m && this.on && this.frame();
    if (!fr) { this.svg.innerHTML = ''; return; }
    const o3 = v.origin || [0, 0, 0], sel = this.edits.selected, drag = this.drag;
    let g = '';
    m.levels.forEach((lv, L) => {
      const z = lv.z - o3[2] + (drag?.L === L ? drag.dz : 0), p = fr.S(fr.b, z), q = fr.S(fr.ext, z), on = L === sel;
      const col = on ? 'var(--glass)' : 'var(--ink3)';
      g += `<g class="lvmark${on ? ' on' : ''}" data-lv="${L}">`
        + `<line class="lvhit" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="transparent" stroke-width="10"/>`
        + `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${col}" stroke-width="${on ? 1.6 : 0.9}" stroke-dasharray="9 3 2 3" pointer-events="none"/>`
        + `<path d="M${q[0]} ${q[1] - 5}l5 5l-5 5l-5 -5z" fill="${on ? 'var(--glass)' : 'var(--panel)'}" stroke="${col}" stroke-width="1.2"/>`
        + `<text x="${q[0] - 9}" y="${q[1] + 3.5}" text-anchor="end"><tspan class="lvname" fill="${on ? 'var(--glass)' : 'var(--ink2)'}">${esc(lvName(m, L))}</tspan> <tspan class="lvfig" data-fig="z" fill="var(--ink3)">${drag?.L === L ? `${drag.dz > 0 ? '+' : ''}${Math.round(drag.dz * 1000)} mm` : `${fmt(lv.z)} m`}</tspan></text>`
        + '</g>';
      const next = m.levels[L + 1];
      if (next) {
        const mid = fr.S(fr.ext, (lv.z + next.z) / 2 - o3[2]);
        const top = fr.S(fr.ext, next.z - o3[2]);
        if (Math.abs(top[1] - fr.S(fr.ext, lv.z - o3[2])[1]) > 30) g += `<text x="${mid[0] + 8}" y="${mid[1] + 3}" class="lvfig" data-lv="${L}" data-fig="h" fill="var(--ink3)">↕ ${fmt(next.z - lv.z)} m</text>`;
      }
    });
    this.svg.innerHTML = g;
  }
  down(e) {
    if (e.button !== 0) return;
    const t = e.target, fig = t.closest('[data-fig]'), mark = t.closest('[data-lv]');
    if (!mark) return;
    e.stopPropagation(); e.preventDefault();
    const L = Number(mark.dataset.lv);
    if (fig) { if (fig.dataset.fig === 'h' || L > 0) this.edits.ask(e, L, fig.dataset.fig); return; }
    // pressed: picked; dragged: the level moves (not the ground)
    const fr = this.frame(), o3 = this.view.origin || [0, 0, 0], z = this.massing().levels[L].z - o3[2];
    const p0 = fr.S(fr.ext, z), p1 = fr.S(fr.ext, z + 1), pxm = p0[1] - p1[1] || 1;
    const y0 = e.clientY, x0 = e.clientX;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      if (L === 0) return;
      moved = true;
      const step = ev.shiftKey ? 0.01 : 0.05;
      this.drag = { L, dz: Math.round(((y0 - ev.clientY) / pxm) / step) * step };
      this.draw();
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const d = this.drag;
      this.drag = null;
      if (moved && d) this.edits.move(L, d.dz);
      else this.edits.select(L, [ev.clientX, ev.clientY]);
      this.draw();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
}
