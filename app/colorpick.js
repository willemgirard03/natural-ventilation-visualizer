// A colour picker in a small pop-over, as drawing tools have them: a grid of colours (hues across, from
// pale to deep down, and a row of greys), and a custom colour picked on a square of saturation and
// brightness for a hue chosen on a strip, or typed as a hex code. openColorPicker(anchor, '#rrggbb',
// onPick) opens it under anchor; onPick(hex) is called as a colour is chosen. A click elsewhere or Esc
// closes it.

const HUES = [0, 25, 45, 60, 90, 140, 175, 200, 220, 255, 285, 320];
const SHADES = [[35, 94], [60, 86], [80, 72], [85, 52], [80, 34]]; // [saturation, brightness] %, pale to deep

export function hsvToHex(h, s, v) {
  s /= 100; v /= 100;
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, max ? (d / max) * 100 : 0, max * 100];
}

let open = null;
export function closeColorPicker() { open?.close(); }

export function openColorPicker(anchor, value, onPick, onClose = null) {
  closeColorPicker();
  const box = document.createElement('div');
  box.className = 'cpick';
  let [h, s, v] = hexToHsv(value) || [0, 0, 50];
  const grid = SHADES.map(([ss, vv]) => HUES.map((hh) => hsvToHex(hh, ss, vv)));
  grid.push([0, 10, 20, 30, 40, 50, 60, 70, 80, 88, 94, 100].map((vv) => hsvToHex(0, 0, vv)));
  box.innerHTML = `<div class="cpgrid">${grid.flat().map((c) => `<button type="button" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>`
    + '<div class="cpcustom"><canvas class="cpsv" width="168" height="96"></canvas><canvas class="cphue" width="168" height="12"></canvas>'
    + `<div class="cprow"><i class="cpnow"></i><input class="cphex" spellcheck="false" maxlength="7" title="A hex code: Enter to take it"></div></div>`;
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect(), W = box.offsetWidth, H = box.offsetHeight;
  box.style.left = `${Math.max(6, Math.min(r.left, innerWidth - W - 6))}px`;
  box.style.top = `${r.bottom + 4 + H > innerHeight ? Math.max(6, r.top - H - 4) : r.bottom + 4}px`;
  const sv = box.querySelector('.cpsv'), hue = box.querySelector('.cphue'), hex = box.querySelector('.cphex'), now = box.querySelector('.cpnow');
  const draw = () => {
    const g = sv.getContext('2d');
    g.fillStyle = hsvToHex(h, 100, 100); g.fillRect(0, 0, sv.width, sv.height);
    const wx = g.createLinearGradient(0, 0, sv.width, 0); wx.addColorStop(0, '#fff'); wx.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = wx; g.fillRect(0, 0, sv.width, sv.height);
    const bk = g.createLinearGradient(0, 0, 0, sv.height); bk.addColorStop(0, 'rgba(0,0,0,0)'); bk.addColorStop(1, '#000'); g.fillStyle = bk; g.fillRect(0, 0, sv.width, sv.height);
    const x = (s / 100) * sv.width, y = (1 - v / 100) * sv.height;
    g.strokeStyle = v > 55 ? '#18211F' : '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 4, 0, 7); g.stroke();
    const q = hue.getContext('2d');
    for (let i = 0; i < hue.width; i++) { q.fillStyle = hsvToHex((i / hue.width) * 360, 100, 100); q.fillRect(i, 0, 1, hue.height); }
    q.strokeStyle = '#18211F'; q.lineWidth = 2; q.strokeRect((h / 360) * hue.width - 2, 0.5, 4, hue.height - 1);
    const c = hsvToHex(h, s, v);
    now.style.background = c;
    if (document.activeElement !== hex) hex.value = c;
    for (const b of box.querySelectorAll('[data-c]')) b.classList.toggle('on', b.dataset.c === c);
  };
  const pick = () => { draw(); onPick(hsvToHex(h, s, v)); };
  const drag = (el, at) => el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const go = (m) => { const rr = el.getBoundingClientRect(); at(Math.max(0, Math.min(1, (m.clientX - rr.left) / rr.width)), Math.max(0, Math.min(1, (m.clientY - rr.top) / rr.height))); pick(); };
    go(e);
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); };
    addEventListener('pointermove', go); addEventListener('pointerup', up);
  });
  drag(sv, (x, y) => { s = x * 100; v = (1 - y) * 100; });
  drag(hue, (x) => { h = x * 360; });
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { [h, s, v] = hexToHsv(b.dataset.c); pick(); } });
  hex.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const x = hexToHsv(hex.value.startsWith('#') ? hex.value : `#${hex.value}`); if (x) { [h, s, v] = x; hex.blur(); pick(); } }
    if (e.key === 'Escape') close();
  });
  const outside = (e) => { if (!box.contains(e.target) && e.target !== anchor) close(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { addEventListener('pointerdown', outside, true); addEventListener('keydown', esc, true); });
  function close() { removeEventListener('pointerdown', outside, true); removeEventListener('keydown', esc, true); box.remove(); if (open?.box === box) open = null; onClose?.(); }
  open = { box, close };
  draw();
}
