// Copied from the edit-handles skill (F:/ARCH 540/.claude/skills/edit-handles/handles.js): the Solar
// Shading Explorer's handles, so the massing's grips, gumball, arcs and dimensions look the same.

/* Edit handles - push/pull grips, gumballs, turning arcs, typed figures and
   array brackets - as the Solar Shading Explorer draws and drives them.

   Dependency-free. Drawing functions return SVG markup in sheet pixels and
   push hit records onto a `grips` array; the drag helpers turn pointer
   travel on the sheet into a new figure. Model units are metres and degrees.
   Colours are CSS custom properties: define them as in SKILL.md.

   A grip record:
     { p: [x, y]          where it is hit, on the sheet
       key                the figure it changes
       from               the figure when the drag starts
       dir: [dx, dy]      sheet pixels the grip moves per +1 of the figure
       mul                the figure grows mul times the grip's travel (2: a width pulled at one jamb, centred)
       arrow, o           a gumball arrow, and its origin - hit anywhere along the shaft
       sgn                which way the figure runs along the arrow, for a typed move
       rot, pivot, plane  a turning grip, its pivot, and the plane the angle is read in
       pop                the gumball's centre: a click opens the object's settings
       low                the parent's grips, ranked last (a window's, under its device's) } */

export const AXIS = { x: '#c2412d', y: '#2f8a4e', z: '#2f6fd1' };
export const CLICK_PX = 3;     // under this much travel a press is a click
export const HIT_PX = 9;       // a grip is taken this close
export const STEP = 0.005;     // lengths snap to 5 mm
export const SNAP_PX = 8;      // a length snaps to a target this close, on the sheet
export const SNAP_DEG = 2;     // an angle snaps to a target this close
export const ARROW_PX = 34;    // a sheet gumball's arrows, whatever the zoom

/* ---------- primitives ---------- */
const n2 = x => +(+x).toFixed(2);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const attrs = a => Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${v}"`).join('');
export const line = (x1, y1, x2, y2, o = {}) => `<line${attrs({ x1: n2(x1), y1: n2(y1), x2: n2(x2), y2: n2(y2), stroke: o.stroke || 'var(--ink)', 'stroke-width': o.w || 1, 'stroke-dasharray': o.dash, opacity: o.op })}/>`;
export const poly = (pts, o = {}) => `<polygon${attrs({ points: pts.map(p => n2(p[0]) + ',' + n2(p[1])).join(' '), fill: o.fill || 'none', stroke: o.stroke || 'none', 'stroke-width': o.w || 1, opacity: o.op, 'stroke-dasharray': o.dash })}/>`;
export const path = (pts, o = {}) => `<path${attrs({ d: pts.map((p, i) => (i ? 'L' : 'M') + n2(p[0]) + ',' + n2(p[1])).join(' '), fill: 'none', stroke: o.stroke || 'var(--ink)', 'stroke-width': o.w || 1, 'stroke-dasharray': o.dash, opacity: o.op, 'stroke-linejoin': 'round' })}/>`;
export const circle = (x, y, r, o = {}) => `<circle${attrs(Object.assign({ cx: n2(x), cy: n2(y), r }, o))}/>`;
export const text = (x, y, s, o = {}) => `<text${attrs({ x: n2(x), y: n2(y), fill: o.fill || 'var(--ink2)', 'font-size': o.size || 9.5, 'font-family': 'var(--mono)', 'text-anchor': o.anchor || 'start', 'data-edit': o.edit, class: o.edit ? 'editable' : undefined })}>${esc(s)}</text>`;
/** an arrowhead with its point at (tx, ty), pointing along unit (ux, uy): `len` long, `half` to each side */
export const head = (tx, ty, ux, uy, col, len = 10, half = 5) =>
  poly([[tx, ty], [tx - len * ux - half * uy, ty - len * uy + half * ux], [tx - len * ux + half * uy, ty - len * uy - half * ux]], { fill: col, stroke: col, w: .8 });
const unit = d => { const l = Math.hypot(d[0], d[1]); return l < 1e-9 ? null : [d[0] / l, d[1] / l]; };
/** where a model point a metre along `n` from `A` lands, less where A does: the sheet's run per metre that way */
export const screenDir = (P, A, n) => { const p = P(A), q = P([A[0] + n[0], A[1] + n[1], A[2] + n[2]]); return [q[0] - p[0], q[1] - p[1]]; };
export const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
export const bboxOf = pts => [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
export const mm = v => Math.round(v * 1000) + ' mm';

/* ---------- typed figures ---------- */
/** a figure on a small opaque backing; with `edit` it is boxed with a dashed line in its own colour, and a click types over it */
export function label(x, y, s, o = {}) {
  const size = o.size || 9, w = String(s).length * size * 0.58 + 6, h = size + 4;
  const x0 = o.anchor === 'start' ? x - 3 : o.anchor === 'end' ? x - w : x - w / 2, col = o.fill || 'var(--glass)';
  return `<rect${attrs({ x: n2(x0), y: n2(y - h + 3.5), width: n2(w), height: n2(h), fill: 'var(--panel)', opacity: o.bg ?? .92, 'data-edit': o.edit, class: o.edit ? 'editable' : undefined,
    stroke: o.edit ? col : undefined, 'stroke-width': o.edit ? .6 : undefined, 'stroke-dasharray': o.edit ? '1.5 1.5' : undefined })}/>`
    + text(x, y, s, { size, fill: col, anchor: o.anchor || 'middle', edit: o.edit });
}
/** a length dimensioned: closed by a 45° tick and a short square end line at each end, extension lines dashed, its figure centred */
export function dim(x1, y1, x2, y2, s, off = 0, edit) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy * off, ny = ux * off;
  const a = [x1 + nx, y1 + ny], b = [x2 + nx, y2 + ny], col = 'var(--ink3)', tx = (ux - uy) * 3.2, ty = (ux + uy) * 3.2, px = -uy * 4.5, py = ux * 4.5;
  let g = line(a[0], a[1], b[0], b[1], { stroke: col, w: .7 }) + line(x1, y1, a[0], a[1], { stroke: col, w: .5, dash: '2 2' }) + line(x2, y2, b[0], b[1], { stroke: col, w: .5, dash: '2 2' });
  for (const q of [a, b]) g += line(q[0] - tx, q[1] - ty, q[0] + tx, q[1] + ty, { stroke: col, w: 1 }) + line(q[0] - px, q[1] - py, q[0] + px, q[1] + py, { stroke: col, w: .63 });
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  return g + label(mx, my + 3, s, edit ? { edit, bg: 1 } : { fill: 'var(--ink2)', bg: 1 });
}
/** an array bracketed: a dotted line through its members, a tick at each - longer at the ends - and its number and spacing typed over */
export function arrayBracket(pts, horizontal, n, spacing, word, keys = { n: 'a.count', sp: 'a.spacing' }) {
  if (!pts.length) return '';
  const a = pts[0], b = pts[pts.length - 1], col = 'var(--glass)', o = { size: 9, bg: .94 };
  let g = line(a[0], a[1], b[0], b[1], { stroke: col, w: 1.2, dash: '2 3' });
  pts.forEach((p, i) => { const t = i === 0 || i === pts.length - 1 ? 6 : 3.5; g += horizontal ? line(p[0], p[1] - t, p[0], p[1] + t, { stroke: col }) : line(p[0] - t, p[1], p[0] + t, p[1], { stroke: col }); });
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, many = n + ' ' + word + (n === 1 ? '' : 's'), at = '@ ' + Math.round(spacing * 1000) + ' mm';
  if (horizontal) g += label(mx - 3, my - 9, many, { ...o, anchor: 'end', edit: keys.n }) + (n > 1 ? label(mx + 3, my - 9, at, { ...o, anchor: 'start', edit: keys.sp }) : '');
  else g += label(mx - 9, my - 3, many, { ...o, anchor: 'end', edit: keys.n }) + (n > 1 ? label(mx - 9, my + 11, at, { ...o, anchor: 'end', edit: keys.sp }) : '');
  return g;
}

/* ---------- push/pull ---------- */
/** the square a figure is pushed or pulled by: `panel` fill, `glass` stroke - 9 px for a device's or a window's grip, 10 px for a building's face */
export const gripMark = (x, y, half = 4.5) => poly([[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]], { fill: 'var(--panel)', stroke: 'var(--glass)', w: half > 4.5 ? 1.6 : 1.5 });
/** a face's grip at its middle, only on a face turned toward the eye (its normal n, the eye e, both in plan: n·e > 0.05) */
export function faceGrip(grips, P, mid, n, eye, key, from, half = 4.5) {
  if (n[0] * eye[0] + n[1] * eye[1] + (n[2] || 0) * (eye[2] || 0) <= 0.05) return '';
  const p = P(mid);
  grips.push({ p, key, from, dir: screenDir(P, mid, n) });
  return gripMark(p[0], p[1], half);
}

/* ---------- gumballs ---------- */
/** the centre that opens the object's settings: a ring and a dot */
export const gumCentre = (grips, O) => { grips.push({ p: O, pop: true }); return circle(O[0], O[1], 5.5, { fill: 'var(--panel)', stroke: 'var(--ink2)', 'stroke-width': 1.4 }) + circle(O[0], O[1], 1.8, { fill: 'var(--ink2)' }); };
function arrowAt(grips, O, u, col, key, from, dir) {
  const tx = O[0] + ARROW_PX * u[0], ty = O[1] + ARROW_PX * u[1];
  // which way the figure runs along the arrow, so a typed move goes the way it points
  const sgn = Math.sign(u[0] * dir[0] + u[1] * dir[1]) || 1;
  grips.push({ p: [tx - 4 * u[0], ty - 4 * u[1]], o: O, key, from, dir, arrow: true, sgn });
  return line(O[0] + 6 * u[0], O[1] + 6 * u[1], tx - 6 * u[0], ty - 6 * u[1], { stroke: col, w: 1.8 }) + head(tx, ty, u[0], u[1], col);
}
/** on a flat drawing: red to the right, green up, each moving the object along that sheet axis only; axes = [{ key, from, dir }, { key, from, dir }] */
export function gumball2D(grips, O, axes) {
  let g = '';
  [[1, 0], [0, -1]].forEach((u, i) => { if (axes[i]) g += arrowAt(grips, O, u, [AXIS.x, AXIS.y][i], axes[i].key, axes[i].from, axes[i].dir); });
  return g + gumCentre(grips, O);
}
/** in a 3D view: an arrow along each model axis as the sheet shows it, always ARROW_PX long; axes = [{ key, from, dir, col }] - an axis seen end on is left out */
export function gumball3D(grips, O, axes) {
  let g = '';
  for (const a of axes) { const u = unit(a.dir); if (u && Math.hypot(a.dir[0], a.dir[1]) > 1e-6) g += arrowAt(grips, O, u, a.col, a.key, a.from, a.dir); }
  return g + gumCentre(grips, O);
}
/* A floor gumball for a whole storey or massing, drawn at model size so it
   foreshortens with the floor: a red and a green arrow along its own axes, a
   square between them that moves it freely, and a double-headed arc between
   the arrows that turns it. P projects model [x, y, z]; C is its middle on
   the floor; ex, ey its axes in plan; GL the arrows' length in metres -
   2 to 10, a quarter of its smaller side. */
export function floorGumball(grips, P, C, ex, ey, GL, keys = { x: 'ox', y: 'oy', rot: 'rot' }, from = { x: 0, y: 0, rot: 0 }) {
  const at = (u, v) => P([C[0] + u * ex[0] + v * ey[0], C[1] + u * ex[1] + v * ey[1], C[2]]), o = at(0, 0);
  let g = '';
  const arc = [];
  for (let k = 0; k <= 16; k++) { const t = (18 + k / 16 * 54) * Math.PI / 180; arc.push(at(GL * Math.cos(t), GL * Math.sin(t))); }
  g += path(arc, { stroke: 'var(--glass)', w: 1.8 });
  for (const [a, b] of [[arc[0], arc[2]], [arc[16], arc[14]]]) { const u = unit([a[0] - b[0], a[1] - b[1]]) || [1, 0]; g += head(a[0] + u[0] * 3, a[1] + u[1] * 3, u[0], u[1], 'var(--glass)', 9, 4.5); }
  // the floor's own axes on the sheet: a turn is read round the floor, a free move taken back onto it
  const floor = { H: o, A: screenDir(P, C, [ex[0], ex[1], 0]), B: screenDir(P, C, [ey[0], ey[1], 0]) };
  grips.push({ arc, rot: true, pivot: o, plane: floor, key: keys.rot, from: from.rot });
  for (const [w, col, k] of [[ex, AXIS.x, 'x'], [ey, AXIS.y, 'y']]) {
    const q = at(w === ex ? 1 : 0, w === ey ? 1 : 0), s = [q[0] - o[0], q[1] - o[1]], u = unit(s) || [1, 0], tip = [o[0] + s[0] * GL, o[1] + s[1] * GL];
    g += line(o[0], o[1], tip[0] - u[0] * 7, tip[1] - u[1] * 7, { stroke: col, w: 1.8 }) + head(tip[0], tip[1], u[0], u[1], col);
    grips.push({ p: tip, o, arrow: true, key: keys[k], from: from[k], dir: s, sgn: 1 });
  }
  const sq = [[.32, .32], [.62, .32], [.62, .62], [.32, .62]].map(([a, b]) => at(GL * a, GL * b));
  grips.push({ plane: sq, move: true, floor });
  return g + poly(sq, { fill: 'var(--glass)', op: .35, stroke: 'var(--glass)', w: 1.2 }) + circle(o[0], o[1], 3, { fill: 'var(--ink2)' });
}

/* ---------- turning ---------- */
/** a member's turn on a flat drawing: an arc beyond its tip about its hinge, an arrowhead each end, quiet at .7; three grips along it */
export function turnArc(grips, H, R, phi, key, from, sgn = 1) {
  const half = Math.min(0.32, 12 / R), pts = [];
  for (let i = 0; i <= 10; i++) { const a = phi - half + 2 * half * i / 10; pts.push([H[0] + R * Math.cos(a), H[1] + R * Math.sin(a)]); }
  for (const da of [0, -0.8 * half, 0.8 * half]) grips.push({ p: [H[0] + R * Math.cos(phi + da), H[1] + R * Math.sin(phi + da)], rot: true, pivot: H, key, from, sgn });
  return arcMarks(pts) + circle(H[0], H[1], 3, { fill: 'var(--panel)', stroke: 'var(--glass)', 'stroke-width': 1.2 });
}
/* In a 3D view the arc lies in the plane the member turns in, and
   foreshortens with it. The plane: origin O, unit axes a and b (model);
   the angle is measured from a toward b. The grips carry the plane on the
   sheet, so the pointer's angle is read back in it (planeAngle). */
export function planeTurnArc(grips, P, O, a, b, R, ang, key, from) {
  const half = Math.min(0.32, 0.6 / Math.max(R, 1e-6)) || 0.2, pt = t => P([O[0] + R * (a[0] * Math.cos(t) + b[0] * Math.sin(t)), O[1] + R * (a[1] * Math.cos(t) + b[1] * Math.sin(t)), O[2] + R * (a[2] * Math.cos(t) + b[2] * Math.sin(t))]);
  const pts = []; for (let i = 0; i <= 12; i++) pts.push(pt(ang - half + 2 * half * i / 12));
  const H = P(O), plane = { H, A: screenDir(P, O, a), B: screenDir(P, O, b) };
  for (const da of [0, -0.8 * half, 0.8 * half]) grips.push({ p: pt(ang + da), rot: true, pivot: H, plane, key, from });
  return arcMarks(pts) + circle(H[0], H[1], 3, { fill: 'var(--panel)', stroke: 'var(--glass)', 'stroke-width': 1.2 });
}
function arcMarks(pts) {
  let g = path(pts, { stroke: 'var(--glass)', w: 1.2 });
  for (const [p, q] of [[pts[1], pts[0]], [pts[pts.length - 2], pts[pts.length - 1]]]) { const u = unit([q[0] - p[0], q[1] - p[1]]) || [1, 0]; g += head(q[0] + u[0] * 5, q[1] + u[1] * 5, u[0], u[1], 'var(--glass)', 5, 3); }
  return `<g opacity=".7">${g}</g>`;
}
/** the sheet point v taken back through a plane's two axes on the sheet: [along A, along B] in model units from its origin - null seen edge on */
export function planeCoords(pl, v) {
  const dx = v[0] - pl.H[0], dy = v[1] - pl.H[1], det = pl.A[0] * pl.B[1] - pl.B[0] * pl.A[1];
  if (Math.abs(det) < 1e-9) return null;
  return [(dx * pl.B[1] - pl.B[0] * dy) / det, (pl.A[0] * dy - dx * pl.A[1]) / det];
}
/** the angle in a plane under the sheet point v, from its A axis toward its B */
export function planeAngle(pl, v) {
  const c = planeCoords(pl, v);
  return c ? Math.atan2(c[1], c[0]) : Math.atan2(v[1] - pl.H[1], v[0] - pl.H[0]);
}
/** a free move on a plane: how far along its A and B axes the pointer has gone since v0 */
export function dragOnPlane(pl, v0, v) {
  const a = planeCoords(pl, v0), b = planeCoords(pl, v);
  return a && b ? [b[0] - a[0], b[1] - a[1]] : [0, 0];
}

/* ---------- picking ---------- */
/** the grip under v: a push/pull grip first, then a turn, then a gumball's arrows and centre, then a parent's (`low`) - the nearest within each */
export function gripAt(grips, v, r = HIT_PX) {
  const rank = g => g.low ? 3 : g.arrow || g.pop ? 2 : g.rot ? 1 : 0;
  const dist = g => g.arc ? Math.min(...g.arc.slice(1).map((q, k) => segDist(v, g.arc[k], q)))
    : g.plane && g.move ? (inside(g.plane, v) ? 0 : Infinity)
    : g.arrow && g.o ? Math.min(Math.hypot(v[0] - g.p[0], v[1] - g.p[1]), segDist(v, g.o, g.p) + 2) : Math.hypot(v[0] - g.p[0], v[1] - g.p[1]);
  let best = null;
  for (const g of grips) {
    const d = dist(g);
    if (d >= r) continue;
    if (!best || rank(g) < best.r || (rank(g) === best.r && d < best.d)) best = { g, r: rank(g), d };
  }
  return best ? best.g : null;
}
export const inside = (q, p) => { let c = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < (q[j][0] - q[i][0]) * (p[1] - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) c = !c; return c; };
/** the cursor over a grip: resize along its run, grab for a turn, move for a free move, pointer for a centre */
export const cursorFor = g => !g ? '' : g.pop ? 'pointer' : g.rot ? 'grab' : g.move ? 'move' : Math.abs(g.dir[0]) > Math.abs(g.dir[1]) ? 'ew-resize' : 'ns-resize';

/* ---------- dragging ---------- */
/** a length pulled: the pointer's run along the grip's own direction, mul times, to the nearest step, held above min - and onto a target within SNAP_PX */
export function dragLength(g, v0, v, { step = STEP, min = -Infinity, max = Infinity, snap = null } = {}) {
  const d2 = g.dir[0] * g.dir[0] + g.dir[1] * g.dir[1] || 1, t = ((v[0] - v0[0]) * g.dir[0] + (v[1] - v0[1]) * g.dir[1]) / d2;
  let x = Math.min(max, Math.max(min, Math.round((g.from + t * (g.mul || 1)) / step) * step));
  const snapped = snap !== null && Math.abs(x - snap) < SNAP_PX / Math.sqrt(d2) * Math.abs(g.mul || 1);
  if (snapped) x = snap;
  return { value: x, snapped };
}
/** the pointer's angle about a turning grip: in its plane if it has one, else about its pivot on the sheet */
export const angleOf = (g, v) => g.plane ? planeAngle(g.plane, v) : Math.atan2(v[1] - g.pivot[1], v[0] - g.pivot[0]);
/** a turn: the change in angle since the press, whole degrees (step 15 with Shift), onto a target angle within SNAP_DEG */
export function dragAngle(g, t0, v, { step = 1, min = -180, max = 180, snaps = [] } = {}) {
  const d = ((angleOf(g, v) - t0) * 180 / Math.PI + 540) % 360 - 180, a = g.from + (g.plane ? 1 : g.sgn || 1) * d;
  const sn = snaps.find(s => Math.abs(s - a) < SNAP_DEG);
  return { value: Math.min(max, Math.max(min, sn !== undefined ? sn : Math.round(a / step) * step)), snapped: sn !== undefined };
}
/** the badge that says a drag has snapped, bottom left of the view: the host gets data-snap, CSS shows it */
export const showSnap = (host, note) => { if (note) host.dataset.snap = note; else delete host.dataset.snap; };

/* ---------- typing ---------- */
/** a box over a figure clicked on the drawing: it holds the figure as shown; Enter or leaving it commits, Escape lets it go */
export function typeOver(el, shown, commit) {
  const r = el.getBoundingClientRect(), box = document.createElement('input');
  box.type = 'text'; box.className = 'floatedit'; box.spellcheck = false; box.value = shown;
  Object.assign(box.style, { left: Math.round(r.left + scrollX) + 'px', top: Math.round(r.top + scrollY - 2) + 'px', minWidth: Math.round(Math.max(56, r.width)) + 'px' });
  return openBox(box, commit);
}
/** a gumball arrow, or a turning arc, clicked rather than dragged: a box at the pointer for how far - mm along the arrow, or degrees */
export function typeMove(x, y, g, commit) {
  const box = document.createElement('input');
  box.type = 'text'; box.className = 'floatedit'; box.spellcheck = false; box.placeholder = g.rot ? 'turn °' : 'move mm';
  Object.assign(box.style, { left: Math.round(x + scrollX + 10) + 'px', top: Math.round(y + scrollY - 12) + 'px', minWidth: '78px' });
  return openBox(box, n => { if (n !== 0) commit(g.rot ? n : (g.sgn || 1) * n / 1000); });
}
function openBox(box, commit) {
  document.body.appendChild(box); box.focus(); box.select();
  let done = false;
  const close = ok => { if (done) return; done = true; const n = parseFloat(box.value.replace(',', '.').replace(/[^0-9.\-]/g, '')); box.remove(); if (ok && isFinite(n)) commit(n); };
  box.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') close(true); else if (e.key === 'Escape') close(false); });
  box.addEventListener('blur', () => close(true));
  return box;
}
