// Copied from the facade-windows skill (F:/ARCH 540/.claude/skills/facade-windows/windows.js): the
// Solar Shading Explorer's window model. The massing uses its Size rules (how a window's edges hold),
// its presets and its array settings; each side's array stands in for a system and its unit.

/* Windows on a facade: the model, how an array is set out along a side, the
   window broken out of its array and bound back, and the figures its handles
   set. No dependencies, no drawing: a renderer reads `layoutSide` and draws.

   Everything named is kept in a library and used by reference, so editing one
   changes everything that uses it:
     units    a window type: its glass's width, height, sill, set-back, SHGC,
              and how its edges hold as its storey and its bay change (size).
              A window wall and a curtain wall are units held to their bay and
              their wall with no gap.
     systems  how units are set out along a side: by number or by spacing, the
              wall they stand in, and the unit type they lay.
   A side holds a reference:
     { sys, broken: { i: { unit, offU } } }
   where window i, broken from the array, lays a unit type of its own, moved
   offU along its bay. Facade coordinates: u along the side from its middle
   (right +, seen from outside), v up from the storey's floor, w out of the
   glass. Metres throughout.                                                 */

export const SHGC_MAX = 0.36;          // the most a unit may have; glass over it is drawn red
export const SLAB = 0.30;              // the band at the top of a storey, under the floor above; 0 where a tool has no slab
export const WIN_MAX = 200;            // a typo cannot build a million windows

export const UNIT0 = () => ({ name: null, winW: 1.8, winH: 1.8, sill: 0.9, reveal: 0, shgc: SHGC_MAX, size: 'fixed' });
export const SYSTEM0 = () => ({ name: null, winBy: 'spacing', winN: 4, winSp: 3.0, wallT: 0.30, unit: null });
export const UNIT_KEYS = ['winW', 'winH', 'sill', 'reveal', 'shgc', 'size', 'jamb', 'headGap', 'widthR', 'sillR', 'headR'];

/* The window systems a bare side can start from. A window wall and a curtain
   wall are units held by offsets of 0 to their bay and their wall, so they
   fill both; the window wall's glass is set back so the slab edge stands proud
   of it, the curtain wall's is flush. */
export const PRESETS = {
  punched: { label: 'Punched windows', sys: { name: 'Punched windows', winBy: 'spacing', winSp: 3.0 }, unit: { name: 'Punched window', winW: 1.5, winH: 1.8, sill: 0.9, reveal: 0.10 } },
  windowwall: { label: 'Window wall', sys: { name: 'Window wall', winBy: 'spacing', winSp: 1.5 }, unit: { name: 'Window wall', size: 'offset', sill: 0, jamb: 0, headGap: 0, reveal: 0.15, shgc: 0.33 } },
  curtainwall: { label: 'Curtain wall', sys: { name: 'Curtain wall', winBy: 'spacing', winSp: 1.5 }, unit: { name: 'Curtain wall', size: 'offset', sill: 0, jamb: 0, headGap: 0, reveal: 0, shgc: 0.28 } }
};

/** the typed figures' limits: [min, max, step] */
export const LIMITS = {
  winW: [0.3, 8, 0.005], winH: [0.6, 5, 0.05], sill: [0, 4, 0.005], head: [0.3, 8, 0.005], reveal: [0, 0.8, 0.005],
  arrN: [1, WIN_MAX, 1], arrSp: [0.3, 60, 0.05]
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r4 = x => +x.toFixed(4);
const copy = o => JSON.parse(JSON.stringify(o));

/* ---------- the library ---------- */
export const lib0 = () => ({ seq: 0, units: {}, systems: {} });
export function addEntry(L, kind, o) {
  const id = (kind === 'units' ? 'u' : 's') + (++L.seq);
  L[kind][id] = Object.assign(kind === 'units' ? UNIT0() : SYSTEM0(), copy(o || {}), { id });
  return id;
}
/** the name itself while it is free, then "Name 2", "Name 3" ... */
export function nextName(L, kind, base) {
  const taken = new Set(Object.values(L[kind]).map(o => o.name));
  if (!taken.has(base)) return base;
  const b = base.replace(/ \d+$/, '');
  for (let k = 2; ; k++) if (!taken.has(b + ' ' + k)) return b + ' ' + k;
}
export function duplicateEntry(L, kind, id, name) {
  const src = L[kind][id];
  if (!src) return null;
  const nid = addEntry(L, kind, src);
  L[kind][nid].name = name || nextName(L, kind, src.name || (kind === 'units' ? 'Window' : 'Window group'));
  return nid;
}
/** what nothing uses any more, dropped - only the copies made on their own (auto), never what was named */
export function prune(L, sides) {
  const used = new Set();
  for (const r of Object.values(sides)) if (r) {
    used.add(r.sys); const y = L.systems[r.sys]; if (y) used.add(y.unit);
    for (const b of Object.values(r.broken || {})) used.add(b.unit);
  }
  for (const kind of ['systems', 'units']) for (const id of Object.keys(L[kind])) if (!used.has(id) && L[kind][id].auto) delete L[kind][id];
}

/* ---------- a window added to a bare side ---------- */
/** one window in the middle of the side - an array is made of it from its pop-up. Returns the side's reference. */
export function oneWindow(L, storeyH, slab = SLAB) {
  const u = { name: nextName(L, 'units', 'Window'), winW: 1.5, winH: 1.8, sill: 0.9 };
  // a window has to fit under the slab of the storey it is put in
  if (u.sill + u.winH > storeyH - slab) u.winH = Math.max(0.6, storeyH - slab - u.sill);
  const unit = addEntry(L, 'units', u);
  return { sys: addEntry(L, 'systems', { name: nextName(L, 'systems', 'Window'), winBy: 'number', winN: 1, unit }) };
}
/** a window system from a preset, with its unit */
export function fromPreset(L, key) {
  const p = PRESETS[key];
  const unit = addEntry(L, 'units', Object.assign({}, p.unit, { name: nextName(L, 'units', p.unit.name) }));
  return { sys: addEntry(L, 'systems', Object.assign({}, p.sys, { name: nextName(L, 'systems', p.sys.name), unit })) };
}
/** a window system already in the library, linked */
export const fromLibrary = (L, id) => L.systems[id] ? { sys: id } : null;

/* ---------- how a window's edges hold ----------
   A window type keeps its edges one of three ways, so they know what to do
   when the storey's height or the window's bay changes (the spacing, the
   number, the side's length):
     fixed     its own width and height; the sill above the floor
     offset    the sill keeps its height above the floor, the head its
               distance below the slab, each jamb its distance in from the
               bay's edge - a taller storey makes a taller window
     ratio     each edge keeps its share: the sill and the head of the wall's
               height (floor to slab), the width of the bay
   Every way is kept on the type at once (winW / winH / sill, jamb / headGap,
   widthR / sillR / headR), so switching between them never moves the glass.
   Glass that fills its bay, or runs up to the slab, is offsets of 0: there is
   no separate full-width or full-height setting. `top` is the top of the wall
   above the floor: the underside of the slab where the tool has a slab
   thickness, else the storey's own height (slab 0). */
export const SIZES = [['fixed', 'Fixed'], ['offset', 'Offsets'], ['ratio', 'Proportional']];
const WMIN = 0.3, HMIN = 0.2;
/** the width of a unit's glass in a bay of `pitch` */
export function glassWidth(u, pitch) {
  const w = u.size === 'offset' ? pitch - 2 * (u.jamb ?? 0) : u.size === 'ratio' ? (u.widthR ?? 0.5) * pitch : u.winW;
  return Math.min(Math.max(Math.min(WMIN, pitch), w), pitch);
}
/** the glass's sill and head in a wall `top` high: { sill, head } */
export function glassHeights(u, top) {
  const room = Math.max(0, top - HMIN);
  const sill = clamp(u.size === 'ratio' ? (u.sillR ?? 0.3) * top : u.sill || 0, 0, room);
  const head = u.size === 'offset' ? top - (u.headGap ?? 0) : u.size === 'ratio' ? (u.headR ?? 0.9) * top : sill + u.winH;
  return { sill, head: clamp(head, sill + Math.min(HMIN, top - sill), top) };
}
/* One edge of the glass set - 'w', 'sill' or 'head' - written into every way
   the type keeps it, from the window it was set on (its bay and its wall). The
   head holds while the sill moves, and the other way round. */
function storeEdge(u, part, v, pitch, top) {
  const { sill, head } = glassHeights(u, top);
  if (part === 'w') Object.assign(u, { winW: r4(v), jamb: r4((pitch - v) / 2), widthR: +(v / pitch).toFixed(6) });
  if (part === 'sill') Object.assign(u, { sill: r4(v), sillR: +(v / top).toFixed(6), winH: r4(head - v) });
  if (part === 'head') Object.assign(u, { winH: r4(v - sill), headGap: r4(top - v), headR: +(v / top).toFixed(6) });
}
/** the way a type keeps its edges switched, the glass left where it is in the window it was switched on */
export function setSize(u, mode, pitch, top) {
  const w = glassWidth(u, pitch), { sill, head } = glassHeights(u, top);
  u.size = mode;
  storeEdge(u, 'w', w, pitch, top); storeEdge(u, 'sill', sill, pitch, top); storeEdge(u, 'head', head, pitch, top);
}

/* ---------- setting out ---------- */

/* How the units are set out along a side of length `len`. By number, they
   divide the side evenly and their bays tile it. By spacing, they stand at
   that pitch, centred on the side, and what is left at the two ends is plain
   wall; a window must stand wholly on the side. */
export function unitLayout(sys, unit, len) {
  if (sys.winBy !== 'spacing') {
    const n = clamp(Math.round(sys.winN) || 1, 1, WIN_MAX);
    return { n, pitch: len / n, first: -len / 2 + len / n / 2 };
  }
  const sp = Math.max(0.3, sys.winSp), w = glassWidth(unit, sp);
  const n = clamp(Math.floor((len - w) / sp + 1e-9) + 1, 1, WIN_MAX);
  return { n, pitch: sp, first: -(n - 1) * sp / 2 };
}

/* Every window of a side: its centre cc on the side, its bay [r0, r1] about
   that centre (clipped at the side's ends), the unit it lays - its own if it
   is broken out - and its glass { u0, u1, v0, v1 } in facade coordinates.
   The glass stands between its sill and the underside of the slab, within its
   bay; a broken window moved along its bay stays wholly inside it. The layout
   is the array's: a broken window's own width never moves the others. */
export function layoutSide(L, ref, len, storeyH, slab = SLAB) {
  const sys = ref && L.systems[ref.sys], unit0 = sys && L.units[sys.unit];
  if (!unit0) return null;
  const lay = unitLayout(sys, unit0, len), top = storeyH - slab, out = [];
  for (let i = 0; i < lay.n; i++) {
    const b = ref.broken && ref.broken[i], u = (b && L.units[b.unit]) || unit0;
    const cc = lay.first + i * lay.pitch, w = glassWidth(u, lay.pitch), { sill, head } = glassHeights(u, top);
    const room = Math.max(0, (lay.pitch - w) / 2), du = b ? clamp(b.offU || 0, -room, room) : 0;
    out.push({ i, cc, r0: Math.max(-lay.pitch / 2, -len / 2 - cc), r1: Math.min(lay.pitch / 2, len / 2 - cc), unit: u, broken: !!b,
      run: w >= lay.pitch - 1e-9, reveal: Math.min(u.reveal || 0, sys.wallT),
      glass: { u0: cc + du - w / 2, u1: cc + du + w / 2, v0: sill, v1: head } });
  }
  return { n: lay.n, pitch: lay.pitch, byNumber: sys.winBy !== 'spacing', len, top, units: out };
}

/* ---------- the array, from the pop-up and the bracket ---------- */
/** an array, or one window: on, set out by a spacing that leaves wall between; off, one window */
export const isArray = sys => !!sys && !(sys.winBy !== 'spacing' && sys.winN <= 1);
export function setArray(L, ref, on) {
  const sys = L.systems[ref.sys], u = L.units[sys.unit];
  if (on) { sys.winBy = 'spacing'; sys.winSp = r4(Math.max(3, (u ? u.winW : 1.5) + 1.2)); }
  else { sys.winBy = 'number'; sys.winN = 1; }
}
/** set out by number or by spacing, keeping what it has: the count it makes becomes the number, the pitch the spacing */
export function setBy(L, ref, by, len) {
  const sys = L.systems[ref.sys];
  if (sys.winBy === by || (by !== 'number' && by !== 'spacing')) return;
  const lay = unitLayout(sys, L.units[sys.unit], len);
  sys.winBy = by;
  if (by === 'number') sys.winN = lay.n; else sys.winSp = r4(lay.pitch);
}
/** a number typed on the bracket sets the array out by number; a spacing, by spacing */
export function setCount(L, ref, n) { const s = L.systems[ref.sys]; s.winBy = 'number'; s.winN = clamp(Math.round(n), 1, WIN_MAX); }
export function setSpacing(L, ref, sp) { const s = L.systems[ref.sys]; s.winBy = 'spacing'; s.winSp = clamp(sp, 0.3, 60); }

/* A window dragged along its side: the pitch the pointer implies, measured from
   the side's first window - or from its last, when the first is dragged. The
   array keeps how it is set out: by number it takes the count nearest that
   pitch, by spacing the pitch to 50 mm. `u` is the pointer's place on the side. */
export function dragPitch(L, ref, lay, idx, u) {
  const sys = L.systems[ref.sys], { units, n, len } = lay, first = units[0].cc, last = units[n - 1].cc;
  const p = Math.max(0.3, idx > 0 ? (u - first) / idx : (last - u) / (n - 1));
  if (sys.winBy !== 'spacing') sys.winN = clamp(Math.round(len / p), 1, WIN_MAX);
  else sys.winSp = Math.round(p / 0.05) * 0.05;
}

/* ---------- a window's own figures, from its grips and typed in 3D ----------
   The sill moves with the head held, the head with the sill held; the glass
   stays between the floor and the slab, at least 200 mm high and 300 mm wide.
   A width dragged by one jamb grows the window both ways (the grip runs at
   twice the pointer). The figures a way of keeping its edges shows are set
   too: the head's gap to the slab and a jamb's to its bay's edge (offset), or
   the shares of the wall and the bay (ratio). `ctx` is the window it is set
   on: { pitch, top }. */
export function setFigure(u, key, v, { pitch, top }) {
  const { sill, head } = glassHeights(u, top);
  const H = x => clamp(x, sill + HMIN, top), S = x => clamp(x, 0, head - HMIN), Wd = x => clamp(x, Math.min(WMIN, pitch), u.size === 'fixed' ? LIMITS.winW[1] : pitch);
  if (key === 'sill') storeEdge(u, 'sill', S(v), pitch, top);
  else if (key === 'head') storeEdge(u, 'head', H(v), pitch, top);
  else if (key === 'winH') storeEdge(u, 'head', H(sill + v), pitch, top);
  else if (key === 'headGap') storeEdge(u, 'head', H(top - v), pitch, top);
  else if (key === 'sillR') storeEdge(u, 'sill', S(v * top), pitch, top);
  else if (key === 'headR') storeEdge(u, 'head', H(v * top), pitch, top);
  else if (key === 'winW') storeEdge(u, 'w', Wd(v), pitch, top);
  else if (key === 'jamb') storeEdge(u, 'w', Wd(pitch - 2 * v), pitch, top);
  else if (key === 'widthR') storeEdge(u, 'w', Wd(v * pitch), pitch, top);
  else if (key === 'reveal') u.reveal = clamp(v, LIMITS.reveal[0], LIMITS.reveal[1]);
  else u[key] = v;
}
/** the unit window i lays: its own when broken, else the array's (an edit to it changes every window of the array) */
export function unitOf(L, ref, i) { const b = ref.broken && ref.broken[i]; return L.units[b ? b.unit : L.systems[ref.sys].unit]; }

/* ---------- breaking a window from its array, and binding it back ----------
   Broken, window i takes a copy of the array's unit type as its own, named
   "<unit> · window 3", so its edits are its own. It keeps its place in the
   array: the layout and the wall still follow the array. Bound back, it either
   drops its own unit (revert) or gives it to the array (apply) - and then the
   other broken windows can take the array's new unit too, or stay as they are.
   A copy nothing uses any more leaves the library. (In the shading tool the
   window's shading breaks out alongside its glass the same way.) */
export function breakUnit(L, ref, i) {
  if (ref.broken && ref.broken[i]) return false;
  const u = L.units[L.systems[ref.sys].unit];
  const id = duplicateEntry(L, 'units', u.id, nextName(L, 'units', (u.name || 'Window') + ' · window ' + (i + 1)));
  L.units[id].auto = true;
  ref.broken = Object.assign(ref.broken || {}, { [i]: { unit: id, offU: 0 } });
  return true;
}
export const brokenOf = ref => Object.keys(ref.broken || {}).map(Number).sort((a, b) => a - b);
export const otherBroken = (ref, i) => brokenOf(ref).filter(k => k !== i);
/** mode 'revert' | 'apply'; others 'keep' | 'rebind' (only with apply) */
export function rebindUnit(L, ref, i, mode, others = 'keep', sides = {}) {
  const own = ref.broken && ref.broken[i];
  if (!own) return false;
  if (mode === 'apply') { const y = L.systems[ref.sys]; y.unit = own.unit; L.units[own.unit].auto = false; }
  delete ref.broken[i];
  if (mode === 'apply' && others === 'rebind') delete ref.broken;
  if (ref.broken && !Object.keys(ref.broken).length) delete ref.broken;
  prune(L, sides);
  return true;
}
export function rebindAll(L, ref, sides = {}) { delete ref.broken; prune(L, sides); }

/* ---------- where else it applies ----------
   Apply to all sides: the other sides take this side's reference - the same
   system, so they stay linked - and follow every later change. Off, each side
   keeps a copy of its own. (Apply to storeys above does the same up the stack.) */
export function matchSides(sides, from) {
  for (const f of Object.keys(sides)) if (f !== from) sides[f] = sides[from] ? copy(sides[from]) : null;
}
export function unlinkSides(L, sides, from) {
  for (const f of Object.keys(sides)) {
    const r = sides[f];
    if (!r || f === from || r.sys !== sides[from].sys) continue;
    r.sys = duplicateEntry(L, 'systems', r.sys, L.systems[r.sys].name);
    const y = L.systems[r.sys]; y.unit = duplicateEntry(L, 'units', y.unit, L.units[y.unit].name);
  }
}
