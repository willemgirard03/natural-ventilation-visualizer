import * as THREE from 'three';
import { importEpJSON, MODEL_VERSION } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { View3D, TYPE_COLORS, PROBLEM, OPEN_WINDOW, zoneColor, pressureColor, NO_PRESSURE, co2Color, CO2_SCALE, peopleColor } from './view3d.js';
import { footprintAxis, toAirflowNetwork } from '../src/model/airflow-network.js';
import { interiorDoors, DOOR } from '../src/model/interior-doors.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow, roomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';
import { co2Generation, outdoorAirSupply, outdoorCO2, stepCO2 } from '../src/solver/co2.js';
import { cellAt } from '../src/solver/roomflow.js';
import { FieldSlices, rampTemperature } from './slices.js';
import { standardPressure } from '../src/solver/air.js';
import { AirflowParticles, temperatureColor, speedColor, SPEED_RANGE } from './particles.js';
import { SkyDome, VENT_BANDS, ventBandLabels } from './skydome.js';
import { windRoseData, windRoseGroup, windArrow, windSpeedAt, BAND_COLORS, SPEED_BANDS } from './windrose.js';
import { dateOf, hourIndex, outdoorAt, parseEPW } from '../src/model/weather.js';
import { readZoneResultsStream, zoneAt, windowAt, mergeResults, surfaceAt } from '../src/model/results.js';
import { SASH_TYPES, sashAngle, freeFraction } from '../src/model/sash.js';
import { daylightSavingDays, hourlyValues } from '../src/model/schedules.js';
import { unitNormal } from '../src/model/geometry.js';
import { constructionProperties } from '../src/model/constructions.js';
import {
  edit, windowRect, rectProblem, clampRect, setWindowRect, setSurfaceConstruction, copyConstruction, setLayer, addLayer, removeLayer,
  moveLayer, layersOf, baseConstruction, materialType, setZoneSetting, zoneSettings, schedulesOfType, MATERIAL_FIELDS, MATERIAL_KINDS,
  setMaterialField, newMaterial, newConstruction, rename, removeMaterial, removeConstruction, materialUses, constructionUses,
} from '../src/model/edit.js';
import { HoverPick } from './hover.js';
import { WindowEditor } from './winedit.js';
import {
  massing0, massingEpJSON, applyMassing, massingWindow, breakOutWindow, massingGeometry, unitLayout, unitOf, isArray, brokenOf,
  faceLength, faceAxes, faceBearing, compassWord, zoneHeight, turnPlan, levelName, JUSTS, setJustify, deleteZone, floatingZones, zoneName,
  setArray, setBy, addWindows, setWindowSize, setWindowFigure, breakWindow, revertWindow, applyToArray, spreadSide, dragPitch, wallLine, freeWalls,
} from '../src/model/massing.js';
import { PRESETS, SIZES } from '../src/model/windows.js';
import { massingPanel } from './massing-panel.js';
import { workspace } from './workspace.js';
import { PlanEdit } from './planedit.js';
import { LevelEdits, LevelMarks3D } from './levels.js';
import { viewsBar } from './viewsbar.js';
import { MassingEditor } from './massedit.js';
import { ModelTools } from './modeltools.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, digits = 1) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(digits));

// A table cell for a value with a source; inherited values show where they came from.
function cell(v, digits) {
  if (!v) return '<td class="muted">–</td>';
  if (v.source === 'inherited') {
    const f = v.from;
    const title = `${f.type} "${f.name}", field ${f.field}${f.derived ? ` (${f.derived})` : ''}`;
    return `<td title="${esc(title)}">${fmt(v.value, digits)}</td>`;
  }
  return `<td>${fmt(v.value, digits)}</td>`;
}

let model = null;
$('version').textContent = MODEL_VERSION;
const view = new View3D($('viewer'), { onSelect: showInfo });
const air = new AirflowParticles(view);
const slices = new FieldSlices(view);
// The layer settings as the page opens them.
air.setVisible($('show-air').checked);
view.setProjection($('projection').querySelector('[aria-pressed="true"]').dataset.proj);
// The zone the pointer looks into: the room-air cell just in front of the surface hit (a floor and the
// ceiling below it share a place, so the surface alone does not say which room is seen).
function zoneUnder(e, h = view.hitAt(e)) {
  if (!h || !rooms) return null;
  const g = rooms.g, o = view.origin;
  for (const back of [0.3, 0.6, 0.9]) {
    const p = h.point.clone().addScaledVector(h.dir, -back);
    const c = cellAt(g, [p.x + o[0], p.y + o[1], p.z + o[2]]);
    if (c >= 0 && g.zone[c] >= 0) return g.zones[g.zone[c]];
  }
  return null;
}
// What a click would select, offered under the pointer, in this order: the whole zone; the window
// under it; the surface it is on, the side facing the view; the zone's floor; on a shared wall, its
// other side and the zone beyond. Shading, which belongs to no zone, comes first. Tab steps through
// them, outlined as offered.
function candidatesAt(e) {
  const h = view.hitAt(e);
  if (!h || !model) return [];
  const out = [], front = zoneUnder(e, h);
  const add = (kind, name, label) => { if (name && !out.some((c) => c.kind === kind && c.name === name)) out.push({ kind, name, label }); };
  const zone = (z) => { if (z && model.zones[z]) add('zone', z, `Zone · ${z}`); };
  if (h.kind === 'shading') add('shading', h.item.name, `Shading · ${h.item.name}`);
  const s = h.kind === 'surface' ? h.item : h.kind === 'window' ? model.surfaces[h.item.parent] : null;
  let near = null, far = null;
  if (s) {
    // The side facing the view: the one of the zone looked into, else the one whose outside faces the camera.
    const partner = s.adjacentSurface && model.surfaces[s.adjacentSurface];
    const faces = (x) => x.zone === front || (!front && unitNormal(x.vertices).reduce((a, n, i) => a + n * [h.dir.x, h.dir.y, h.dir.z][i], 0) < 0);
    [near, far] = partner && faces(partner) && !faces(s) ? [partner, s] : [s, partner];
  }
  const own = near?.zone || front || h.item?.zone;
  zone(own);
  if (h.kind === 'window') add('window', h.item.name, `Window · ${h.item.zone}`);
  if (h.kind === 'door') add('door', h.item.name, `Door · ${h.item.zone} – ${h.item.partnerZone}`);
  if (near) add('surface', near.name, `${near.csType} · ${near.zone}`);
  // the zone's floor: its largest piece
  const floor = model.zones[own]?.surfaces.map((n) => model.surfaces[n]).filter((x) => /floor/i.test(x.surfaceType)).sort((a, b) => b.area - a.area)[0];
  if (floor) add('surface', floor.name, `${floor.csType} · ${floor.zone} floor`);
  if (far) { add('surface', far.name, `${far.csType} · ${far.zone}`); zone(far.zone); }
  for (const z of [front, h.item?.zone, h.item?.partnerZone]) zone(z);
  return out;
}
// A candidate's outline: a zone's edges once each; a surface, window or door's own edges.
function edgesOf(c) {
  const o = view.origin, pos = [], seen = new Set();
  const polys = c.kind === 'shading' ? model.shading.filter((x) => x.name === c.name) : view.find(c.name)?.polys || [];
  // with thickness: the outer bounds of the solids the walls are drawn as (a window or door: its own outline)
  const thick = !['shading', 'window', 'door'].includes(c.kind) && view.outerOutlineOf(`${c.kind}:${c.name}`, polys);
  if (thick?.length) return thick;
  for (const { vertices: v } of polys) {
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length], k = [a, b].map((p) => p.map((x) => x.toFixed(3)).join()).sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      pos.push(a[0] - o[0], a[1] - o[1], a[2] - o[2], b[0] - o[0], b[1] - o[1], b[2] - o[2]);
    }
  }
  return pos;
}
const hover = new HoverPick(view, { candidatesAt, edgesOf });
// Pointing at a cut: a crosshair there and the air's values, read from the room air as it is now.
{
  const el = view.renderer.domElement;
  let pending = false, last = null;
  el.addEventListener('pointermove', (e) => {
    last = e;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const h = slices.visible && !e.buttons ? view.hitAt(last) : null;
      const behind = h ? h.distance : Infinity; // along the same ray as the probe's (the parallel view's starts at its near plane)
      slices.showProbe(slices.visible && !last.buttons ? slices.probeAt(last, behind) : null, last);
    });
  });
  el.addEventListener('pointerleave', () => slices.showProbe(null));
}
view.offered = (e) => hover.pickFor(e);
// While a plane's or a window's handle is under the pointer, nothing else is offered.
view.busy = (e) => !!(tools.active || view.sections.handleAt(e) || winEdit.handleAt(e) || massEdit.handleAt(e) || sky.handleAt(e));
hover.setEnabled($('show-labels').checked);
$('show-labels').addEventListener('change', (e) => hover.setEnabled(e.target.checked));
// A window's sill, head and jambs pushed and pulled in the view, and the window dragged across its wall.
const winEdit = new WindowEditor(view, {
  rectOf: (name) => (model ? windowRect(model, name) : null),
  problem: (name, r) => rectProblem(model, name, r),
  clamp: (name, r) => clampRect(model, name, r),
  floorOf: (name) => model.zones[model.windows[name].zone].bottom,
  depthOf: (name) => view.windowOffset(model.windows[name]),
  // a window of a massing's array is broken out of it, with the size and place it was given
  // a massing's window: its Size, bay and the top of its wall, and its figures typed as its Size keeps them
  sizeOf: (name) => {
    const at = massing && massingWindow(massing, name);
    if (!at) return null;
    const z = massing.zones[at.zone], g = z.faces[at.face], len = faceLength(massing, at.zone, at.face);
    const lay = unitLayout(g, len), cc = lay.first + at.index * lay.pitch, mid = faceMiddle(name), u = unitOf(g, at.index);
    return { free: !!g.broken?.[at.index], size: u.size || (g.fillW || g.fillH ? 'offset' : 'fixed'), bay: [mid + Math.max(cc - lay.pitch / 2, -len / 2), mid + Math.min(cc + lay.pitch / 2, len / 2)], top: at.z0 + zoneHeight(massing, at.zone) - (z.slab || 0), slab: (z.slab || 0) > 0 };
  },
  onFigure: (name, key, v) => {
    const at = massingWindow(massing, name);
    sideEdit({ zone: at.zone, face: at.face }, (x) => setWindowFigure(x, at.zone, at.face, at.index, key, v), `window ${at.index + 1}'s ${key} set`);
  },
  onCommit: (name, r) => (massing && massingWindow(massing, name)
    ? massingWindowEdit(name, r)
    : applyEdit((tx, m) => setWindowRect(tx, m, name, r), `window ${name} moved or resized`, { geometry: true })),
});
view.onRender = () => followPop();
// A massing's zone pushed, pulled, moved and turned in the view (app/massedit.js).
const massEdit = new MassingEditor(view, {
  massing: () => massing, onChange: massingChange,
  isolated: () => winEdit.active,
  windowAt: (e) => {
    if (winEdit.active || !massing || !model) return null;
    const h = view.hitAt(e), at = h?.kind === 'window' && massingWindow(massing, h.item.name);
    return at ? { zone: at.zone, face: at.face, index: at.index, name: h.item.name } : null;
  },
  onPick: (name) => { if (selected !== name) view.select(name); },
  brokenWindows: () => (massing && model ? brokenNames().filter((n) => n !== selected).map((n) => model.windows[n]?.vertices).filter(Boolean) : []),
});
// The massing's windows broken out of their arrays, worked out again only when the massing changes.
let brokenKey = '', brokenList = [];
function brokenNames() {
  const key = JSON.stringify(massing);
  if (key !== brokenKey) {
    brokenKey = key;
    brokenList = massingGeometry(massing).flatMap((z) => z.windows.filter((w) => massing.zones[z.zone].faces[w.face]?.broken?.[w.index]).map((w) => w.name));
  }
  return brokenList;
}
// The sky over the building (app/skydome.js): the sun at the hour picked, dragged to pick another,
// and true north on the horizon, dragged to set the model's north axis.
const sky = new SkyDome(view, {
  onTime: (doy, hour) => { $('day').value = doy; $('hour').value = hour; applyHour(); },
  onNorth: (deg) => {
    const name = Object.keys(model.epjson.Building || {})[0];
    if (!name) { popMessage('The model has no Building object to hold a north axis.'); updateSky(); return; }
    if (!applyEdit((tx) => { tx.get('Building', name).north_axis = deg; }, `north axis set to ${deg}°`, { geometry: true })) updateSky();
  },
});
let levelMarks = null; // the levels' markers in 3D, made with the views below
view.beforeRender = () => { winEdit.beforeRender(); massEdit.beforeRender(); sky.beforeRender(); tools.beforeRender(); levelMarks?.draw(); };
// The modelling tools (app/modeltools.js): Add zone and Split zone, in the view's bar for a massing.
const tools = new ModelTools(view, {
  massing: () => massing,
  // the massing's zone and face under the pointer (a window counts as its face), and the point hit in
  // the plan's own coordinates
  targetAt: (e) => {
    if (!massing || !model) return null;
    const h = view.hitAt(e);
    if (!h) return null;
    let t = null;
    if (h.kind === 'window') { const w = massingWindow(massing, h.item.name); t = w && { zone: w.zone, face: w.face }; }
    else if (h.kind === 'surface') { const s = massingTarget({ kind: 'surface', item: h.item }); t = s && { zone: s.zone, face: s.face ?? 'floor' }; }
    if (!t) return null;
    const o = view.origin, p = turnPlan([h.point.x + o[0], h.point.y + o[1]], -(massing.rot || 0));
    return { ...t, point: p };
  },
  onChange: (mutate, what) => massingChange(mutate, what),
  onAdded: (j) => { const z = massingGeometry(massing)[j]; if (z && model.zones[z.name]) view.select(z.name); },
  keepSeams: () => $('keep-seams').checked,
  wallProps: () => ({ asm: $('wall-asm').value, base: Number($('wall-base').value), top: Number($('wall-top').value), line: $('wall-line').value, chain: $('wall-chain').checked }),
  onTool: (tool) => {
    for (const b of document.querySelectorAll('.mtools [data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === tool);
    $('keep-seams-l').hidden = tool !== 'merge';
    wallTab(tool === 'wall');
    if (tool) { winEdit.stop(); view.select(null); hover.clear(); }
  },
});
for (const b of document.querySelectorAll('#model-tools [data-tool]')) {
  // Add zone is dragged in, or clicked and then placed; Split zone stays on until Esc or a second click
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !massing || b.dataset.tool !== 'add') return;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (m) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      window.removeEventListener('pointermove', move);
      tools.start('add', true);
      b.dataset.dragged = '1';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });
  b.addEventListener('click', () => {
    if (b.dataset.dragged) { delete b.dataset.dragged; return; }
    if (!massing) return;
    if (tools.tool === b.dataset.tool) tools.stop(); else tools.start(b.dataset.tool);
  });
}
// The model's outdoor limits for opening windows (its natural ventilation's), for the sky's weather
// dots: the first zone's that has them; EnergyPlus's own defaults where none are set.
function ventLimits() {
  for (const z of Object.values(model.zones)) {
    const v = z.ventilation && [...z.ventilation.stack, ...z.ventilation.wind, ...z.ventilation.other][0];
    if (v) return [v.controls.minOutdoorTemperature.value ?? -100, v.controls.maxOutdoorTemperature.value ?? 100];
  }
  return [-100, 100];
}
// The sky sized to the building, for the place, day and hour picked.
function updateSky() {
  if (!model) return;
  const loc = Object.entries(model.epjson['Site:Location'] || {})[0];
  sky.setPlace(weather?.location || (loc && { latitude: loc[1].latitude, longitude: loc[1].longitude, timeZone: loc[1].time_zone, name: loc[0] }));
  const { radius, height } = view.extent(), R = 1.45 * Math.max(2 * radius, height, 1);
  view.skyRadius = sky.shown ? R : 0;
  sky.update({ R, north: model.site.northAxis, doy: Number($('day').value), hour: Number($('hour').value), weather, limits: ventLimits() });
}
$('show-sky').addEventListener('change', (e) => { sky.set({ shown: e.target.checked }); updateSky(); legend(); });
$('show-sun').addEventListener('change', (e) => sky.set({ sunShown: e.target.checked }));
$('sun-shadows').addEventListener('change', (e) => sky.set({ shadows: e.target.checked }));
// Each group's figures and names, switched on their own.
for (const el of document.querySelectorAll('[data-labels]')) el.addEventListener('change', () => {
  const on = el.checked, k = el.dataset.labels;
  if (k === 'sky') sky.set({ labels: on });
  else if (k === 'sun') sky.set({ sunLabels: on });
  else if (k === 'preview') hover.setLabels(on);
  else if (k === 'rose') { roseLabels = on; drawRose(); }
});
$('sky-opacity').addEventListener('input', (e) => { sky.set({ opacity: Number(e.target.value) / 100 }); $('sky-opacity-value').textContent = `${e.target.value}%`; });
for (const el of document.querySelectorAll('[data-sky]')) el.addEventListener('change', () => { sky.set({ layers: { ...sky.layers, [el.dataset.sky]: el.checked } }); legend(); });
let sliceRanges = {}, sliceTimer = 0, sliceLast = 0;
// Redraws the slices from the room air: the grid solver's fields, or ideal flow's speed and each
// room's own temperature. Throttled, since the simulation posts several steps a second.
function drawSlices(now = false) {
  // While a baked day plays, its blended fields; otherwise the live room air.
  const simulated = bakedPlay ? bakedPlay.kind === 'grid' : $('room-air').value === 'grid';
  const grid = bakedPlay?.grid || liveGrid(), field = bakedPlay?.live || liveField();
  const any = view.sections.planes.some((p) => p.air.field || p.air.particles);
  if (!any || !model || !rooms || (simulated ? !(bakedPlay || gridLive) : !field)) { slices.hide(); sliceRanges = {}; legend(); return; }
  const wait = 300 - (performance.now() - sliceLast);
  if (!now && wait > 0) { clearTimeout(sliceTimer); sliceTimer = setTimeout(() => drawSlices(true), wait); return; }
  sliceLast = performance.now();
  const g = rooms.g, fluid = (x, y, z) => { const c = cellAt(g, [x, y, z]); return c >= 0 && g.zone[c] >= 0; };
  const velocity = simulated ? (x, y, z) => grid.velocityAt([x, y, z])
    : (x, y, z) => { const c = cellAt(g, [x, y, z]); return [field.velocity[3 * c], field.velocity[3 * c + 1], field.velocity[3 * c + 2]]; };
  const temperature = simulated ? (x, y, z) => grid.temperatureAt(x, y, z) : (x, y, z) => airflow.conditions.zones[g.zones[g.zone[cellAt(g, [x, y, z])]]]?.t ?? 20;
  const co2 = (x, y, z) => co2Near([x, y, z]);
  const value = (kind, x, y, z) => (kind === 'speed' ? Math.hypot(...velocity(x, y, z)) : kind === 'co2' ? co2(x, y, z) : temperature(x, y, z));
  const co2Ramp = (v, [lo, hi]) => co2Color(CO2_SCALE[0] + ((v - lo) / Math.max(1, hi - lo)) * (CO2_SCALE[2] - CO2_SCALE[0]));
  const colour = (kind, v, range) => (kind === 'speed' ? speedColor(v) : kind === 'co2' ? co2Ramp(v, range) : rampTemperature(v, range[0], range[1]));
  sliceRanges = slices.update({ inside: fluid, value, velocity, temperature, co2 }, colour, g);
  legend();
}
let net = null, airflow = null; // the network for the loaded model, and its latest solution
const liveGrid = () => grid, liveField = () => field;
let co2Timer = 0;
let rooms = null, field = null, fieldTimer = 0; // cells and faces for the room flow, and its latest field
let pressureRange = 1; // Pa, the end of the pressure colour scale for the hour solved
// The grid solver runs in a worker; `grid` is the page's copy, reading the worker's latest step.
let worker = null, grid = null, gridLive = false;
function startGrid(m) {
  slices.hide(); // their particles read the room air being replaced; they start again with the next one
  worker?.terminate();
  worker = null; grid = null; gridLive = false;
  $('room-air-status').textContent = '';
  if ($('room-air').value !== 'grid') return;
  grid = new GridFlow(rooms, m);
  worker = new Worker(new URL('./grid-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type !== 'state' || !grid) return;
    gridAirTime = data.time;
    grid.FV.set(data.FV);
    grid.T.set(data.T);
    if (data.C) grid.C.set(data.C);
    drawSlices();
    if (!gridLive && airflow) { gridLive = true; air.clear(); air.setField(grid, airflow.conditions); }
    const pace = data.dt / (data.ms / 1000);
    $('room-air-status').textContent = `${fmt(grid.fluid.length / 1000, 0)}k cells · ${fmt(pace, 1)}× real time`;
    const walls = Object.keys(airflow?.conditions.surfaceT || {}).length;
    $('room-air-status').title = `Simulated air time ${fmt(data.time, 0)} s; this step ${fmt(data.ms, 0)} ms for ${fmt(data.dt, 2)} s of air, ${data.iterations} pressure iterations. `
      + (walls ? `Walls, floors and windows warm or cool the air at the inside temperatures of the results (${walls} surfaces).` : 'Surfaces neither warm nor cool the air: the results have no surface temperatures; a rerun adds them.');
  };
  worker.postMessage({ type: 'model', epjson: m.epjson });
}
// Windows opened or closed one by one (by window name) or room by room (by zone), over the Windows setting.
const windowSet = new Map(), roomSet = new Map();
// Sashes set window by window ({ type, hinge }), over the Sashes setting.
const sashSet = new Map();
const sashOf = (name) => ({ type: $('sash-type').value, hinge: 'left', ...sashSet.get(name) });
// How a window's sash opens to give `fraction` of its rough opening: { angle, fraction, reachable, maxFraction }.
const sashFor = (l, fraction) => sashAngle(sashOf(l.name).type, l.width, l.height, fraction);
// Each window's opening amount: 0 to 1 of its sash's travel (1 = at the mechanism's limit). By default,
// the amount that frees the model's operable fraction (ClimateStudio's 0.8 in the examples).
const amountSet = new Map();
const maxAngleOf = (l) => SASH_TYPES[sashOf(l.name).type].maxAngle;
const defaultAmount = (l) => Math.min(1, sashFor(l, l.openFactor).angle / maxAngleOf(l));
const amountOf = (l) => (amountSet.has(l.name) ? amountSet.get(l.name) : defaultAmount(l));
// The free fraction of the opening at a window's amount: the opening factor EnergyPlus gets.
const openFraction = (l) => freeFraction(sashOf(l.name).type, l.width, l.height, amountOf(l) * maxAngleOf(l));
let weather = null, weatherHour = null, roseLabels = true; // the weather file and the hour picked from it
let results = null; // zone conditions hour by hour from a results file, for the loaded model
let esoSource = null; // where the results file in use comes from: { name, blob() }, for Export .eso

// The network's conditions at an hour index: the outdoor air given, rooms from the results (or the
// Inside setting) and windows and doors as set, following the results' own openings where asked.
function conditionsAt(hourAt, outdoor, site) {
  const tIn = Number($('t-in').value), mode = $('windows').value;
  const inside = (z) => (results && zoneAt(results, z, hourAt, outdoor.pressure)) || { t: tIn, w: 0.008, vent: null };
  const conditions = {
    site, outdoor,
    zones: Object.fromEntries(net.zones.map((z) => [z, inside(z)])),
    open: Object.fromEntries(net.links.filter((l) => l.control === 'zone' || l.door).map((l) => {
      if (l.door) return [l.name, (windowSet.has(l.name) ? windowSet.get(l.name) : $('doors').value === 'open') ? l.openFactor : 0];
      // As in results: an airflow network run gives each window's opening; otherwise the zone's ventilation.
      // Each window opens as far as its sash allows towards the fraction asked of it.
      const reported = mode === 'results' && results ? windowAt(results, l.name, hourAt) : null;
      if (reported !== null && !windowSet.has(l.name) && !roomSet.has(l.from)) return [l.name, reported > 0 ? sashFor(l, reported).fraction : 0];
      const base = mode === 'open' || (mode === 'results' && !!inside(l.from).vent);
      const open = windowSet.has(l.name) ? windowSet.get(l.name) : roomSet.has(l.from) ? roomSet.get(l.from) : base;
      return [l.name, open ? openFraction(l) : 0];
    })),
  };
  // Open windows' sashes: a hopper or awning shapes its flow in the network, and every sash spreads
  // its air along it in the room air.
  conditions.sashes = Object.fromEntries(net.links.filter((l) => l.control === 'zone' && conditions.open[l.name] > 0)
    .map((l) => [l.name, { ...sashOf(l.name), angle: sashFor(l, conditions.open[l.name]).angle }]));
  return conditions;
}

// CO2 in each zone (ppm), the mean over the hour picked, as EnergyPlus reports it. It builds up over
// hours, so the balance steps through the two days before from outdoor levels: each hour with its own
// weather (this hour's held without a weather file), the results' room temperatures, the windows and
// doors as set now, people from the model's schedules and the outdoor air its ventilation equipment
// supplies.
const CO2_HOURS = 48;
function co2History(hourAt, solutionNow, site, outdoorNow) {
  const volumes = net.zones.map((z) => model.zones[z].volume.value);
  let C = null;
  for (let k = CO2_HOURS - 1; k >= 0; k--) {
    const i = (hourAt - k + 8760) % 8760;
    const outdoor = k && weather ? outdoorAt(weather, Math.floor(i / 24) + 1, (i % 24) + 1) : outdoorNow;
    const solution = k ? solveNetwork(net, conditionsAt(i, outdoor, site)) : solutionNow;
    const co = outdoorCO2(model, i);
    const generation = co2Generation(model, net.zones, i), supply = outdoorAirSupply(model, net.zones, i, site.elevation);
    C ??= net.zones.map(() => co);
    if (k) { C = stepCO2(net, solution, C, 3600, volumes, generation, co, supply); continue; }
    // The hour picked, in 10-minute steps, averaged.
    const mean = C.map(() => 0);
    for (let s = 0; s < 6; s++) {
      C = stepCO2(net, solution, C, 600, volumes, generation, co, supply);
      C.forEach((c, z) => { mean[z] += c / 6; });
    }
    return Object.fromEntries(net.zones.map((z, i) => [z, mean[i]]));
  }
}

// Solves the network for the conditions in the Airflow controls and hands the flows to the particles.
function solveAir() {
  if (!model || !net) return;
  // The site comes from the weather file when there is one, else from the model, else sea level.
  const loc = weather?.location || Object.values(model.epjson['Site:Location'] || {})[0] || {};
  const site = { elevation: loc.elevation ?? 0, latitude: loc.latitude ?? 45 };
  const hourAt = hourIndex(Number($('day').value), Number($('hour').value));
  const outdoor = {
    t: Number($('t-out').value), w: weatherHour?.w ?? 0.008, pressure: weatherHour?.pressure ?? standardPressure(site.elevation),
    windSpeed: Number($('wind').value), windDirection: Number($('wind-dir').value),
  };
  const conditions = conditionsAt(hourAt, outdoor, site);
  view.setPeople(peopleNow(hourAt), peopleTop());
  const mode = $('windows').value;
  // Surfaces' inside temperatures this hour, where the results have them (the tool's reruns do).
  conditions.surfaceT = {};
  if (results?.surfaces) {
    for (const name of [...Object.keys(model.surfaces), ...Object.keys(model.windows)]) {
      const t = surfaceAt(results, name, hourAt);
      if (t !== null) conditions.surfaceT[name] = t;
    }
  }
  const solution = solveNetwork(net, conditions);
  const flows = flowStreams(net, solution, conditions);
  // CO2 keeps the last figures until its history (up to a few seconds in large models) is redone once the controls settle.
  airflow = { solution, flows, conditions, co2: airflow?.co2 ?? null, site, outdoor, hourAt };
  clearTimeout(co2Timer);
  co2Timer = setTimeout(() => {
    if (baking || bakedPlay) return; // a bake has its own CO2
    const now = airflow;
    if (now?.solution !== solution) return;
    now.co2 = co2History(hourAt, solution, site, outdoor);
    view.setCO2(now.co2);
    // The grid solver carries CO2 within rooms, each zone's mean held at these levels.
    if (grid && worker) {
      const co2 = co2Message(hourAt, now.co2, site);
      grid.setCO2(co2);
      worker.postMessage({ type: 'co2', co2 });
    }
    if (view.sections.planes.some((q) => q.air.field === 'co2')) drawSlices(true);
    if ($('color-by').value === 'co2') legend();
    const line = document.getElementById('co2-line');
    if (line) line.outerHTML = co2Line(line.dataset.zone);
  }, 250);
  const openNow = Object.entries(conditions.open).filter(([n, f]) => f > 0 && !n.endsWith(':door')).map(([n]) => n);
  view.setOpenDoors(new Set(Object.entries(conditions.open).filter(([n, f]) => f > 0 && n.endsWith(':door')).map(([n]) => n)));
  view.setOpenWindows(new Set(openNow), new Map(openNow.map((n) => {
    const l = net.links.find((x) => x.name === n);
    return [n, { ...sashOf(n), angle: sashFor(l, conditions.open[n]).angle }];
  })));
  $('windows-reset').hidden = !windowSet.size && !roomSet.size;
  showKeyframes();
  // With a results file, temperatures belong to the results' own window states.
  const differs = results && (modelEdited || mode !== 'results' || [...windowSet.keys()].some((n) => !n.endsWith(':door')) || roomSet.size);
  $('stale').hidden = !differs;
  if (differs && !rerunning) {
    const [a, b] = rerunWeek();
    $('stale').innerHTML = `${modelEdited ? 'The model has been edited since' : 'Windows differ from'} ${esc(results.name)}. Room temperatures are still the ones it recorded with its own windows, so the stack effect and two-way flows use temperatures that these windows would change over the following hours. `
      + (runner ? `<button class="quiet" id="rerun">Rerun ${esc(dateOf(a).label)}–${esc(dateOf(b).label)} in EnergyPlus</button> (about 20 s, with these windows and doors)`
        : 'Running EnergyPlus again, with these windows and doors, needs the tool on this computer.');
  }
  // Pressure difference across every surface with a crack, seen from its own zone (its partner's is opposite).
  const dps = {};
  solution.links.forEach((r, i) => {
    if (net.links[i].type !== 'crack') return;
    dps[r.name] = r.dp;
    const partner = model.surfaces[r.name]?.adjacentSurface;
    if (partner && model.surfaces[partner]) dps[partner] = -r.dp;
  });
  const top = Math.max(0.1, ...Object.values(dps).map(Math.abs));
  pressureRange = [0.5, 1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100].find((x) => x >= top) || Math.ceil(top);
  view.setPressures(dps, pressureRange);
  if ($('color-by').value === 'pressure' || $('color-by').value === 'co2') legend();
  // Baking, or playing a bake: the hour's network only; the bake has its own room air.
  if (baking || bakedPlay) { airTotals(flows, conditions); return; }
  if ($('room-air').value === 'grid') {
    // Simulated: the background solver takes the new conditions; the page's copy of the grid follows.
    if (grid && worker) {
      const hour = hourIndex(Number($('day').value), Number($('hour').value));
      grid.setConditions(flows, conditions, { hour, copy: true });
      worker.postMessage({ type: 'conditions', conditions, hour });
      if (gridLive) air.setField(grid, conditions);
    }
  } else {
    // Ideal flow takes a few hundred milliseconds, so it follows once the controls settle.
    clearTimeout(fieldTimer);
    fieldTimer = setTimeout(() => {
      if (!rooms || airflow?.flows !== flows) return;
      field = roomFlow(rooms, flows, { previous: field, open: conditions.open, sashes: conditions.sashes });
      air.setField(field, conditions);
      drawSlices(true);
    }, 120);
  }
  airTotals(flows, conditions);
}
// The outdoor air entering, as a line under the settings.
function airTotals(flows, conditions) {
  const volume = Object.values(model.zones).reduce((s, z) => s + z.volume.value, 0);
  const m3h = (flows.outdoorIn / 1.2) * 3600;
  // Which rooms have windows open this hour, so a still room is not mistaken for a fault.
  const openZones = [...new Set(net.links.filter((l) => l.control === 'zone' && conditions.open[l.name] > 0).map((l) => l.from))];
  const ventilable = new Set(net.links.filter((l) => l.control === 'zone').map((l) => l.from)).size;
  const which = !openZones.length ? 'all windows closed' : openZones.length === ventilable ? 'windows open in every room that has them'
    : `windows open in ${openZones.length <= 3 ? openZones.join(', ') : `${openZones.length} of ${ventilable} rooms`}`;
  $('air-total').textContent = `Outdoor air ${fmt(m3h, 0)} m³/h · ${fmt(m3h / volume, m3h / volume < 1 ? 2 : 1)} air changes/h · ${which}`;
  $('air-total').title = 'Outdoor air entering the building through windows, doors and leaks, from the airflow network. Air changes per hour: that flow divided by the volume of all zones.';
}
for (const id of ['t-out', 't-in', 'wind', 'wind-dir', 'windows']) $(id).addEventListener('input', () => { solveAir(); drawRose(); if (model) showInfo(current()); });
$('air-density').addEventListener('input', (e) => {
  const k = 2 ** Number(e.target.value);
  $('air-density-value').textContent = `×${k < 1 ? k.toFixed(2).replace(/0$/, '') : k}`;
  air.densityScale = k;
  air.clear();
  solveAir(); // refills the view at the new density
});

// The wind rose for the month of the day picked, and this hour's wind as an arrow.
function drawRose() {
  if (!model) return;
  updateSky();
  if (!weather || !$('show-rose').checked) { view.setGroundOverlay(null); legend(); return; }
  const month = dateOf(Number($('day').value)).month;
  const radius = view.footprintRadius() * 1.05, northAxis = model.site.northAxis;
  const wind = { direction: Number($('wind-dir').value), speed: Number($('wind').value) };
  // The rose is built once for a month; a change of wind redraws only its arrow.
  const key = `${weather.fileName}|${weather.location?.name}|${month}|${radius}|${northAxis}`, rose = view.overlay;
  if (rose?.userData.key === key) {
    for (const o of rose.children.filter((c) => c.userData.windArrow)) { o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); }); rose.remove(o); }
    const arrow = windArrow(wind, { radius, northAxis });
    if (arrow) rose.add(arrow);
    view.render();
  } else {
    const data = windRoseData(weather.hours.filter((h) => h.month === month));
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1D2124';
    const group = windRoseGroup(data, { radius, northAxis, ink, wind });
    group.userData.key = key;
    view.setGroundOverlay(group);
  }
  if (view.overlay) {
    for (const o of view.overlay.children) if (o.isSprite) o.visible = roseLabels;
    view.render();
  }
  legend();
}
$('show-rose').addEventListener('change', drawRose);

// The wind arrow's handle, dragged in the view as the sun is in the Solar Shading Explorer: round the
// building it sets the direction the wind comes from, in or out the speed (the tail's distance from
// the centre). Snaps to whole degrees and tenths of a metre per second.
{
  const canvas = view.renderer.domElement;
  const knobAt = (e) => {
    const knob = view.overlay?.children.find((c) => c.userData.windArrow)?.userData.knob;
    if (!knob || !view.overlay.visible) return null;
    const r = canvas.getBoundingClientRect(), p = knob.getWorldPosition(new THREE.Vector3()).project(view.camera);
    const d = Math.hypot((p.x + 1) / 2 * r.width - (e.clientX - r.left), (1 - p.y) / 2 * r.height - (e.clientY - r.top));
    return d < 14 ? knob : null;
  };
  let drag = null, hovering = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || view.sections.placing) return;
    const knob = knobAt(e);
    if (!knob) return;
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    drag = { z: knob.getWorldPosition(new THREE.Vector3()).z };
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const near = !!knobAt(e);
      if (near) canvas.style.cursor = 'grab'; else if (hovering) canvas.style.cursor = '';
      hovering = near;
      return;
    }
    const r = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), view.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -drag.z), new THREE.Vector3());
    if (!hit) return;
    const radius = view.footprintRadius() * 1.05;
    const dir = ((THREE.MathUtils.radToDeg(Math.atan2(hit.x, hit.y)) + model.site.northAxis) % 360 + 360) % 360;
    $('wind-dir').value = Math.round(dir) % 360;
    $('wind').value = Math.round(windSpeedAt(Math.hypot(hit.x, hit.y), radius) * 10) / 10;
    $('wind').dispatchEvent(new Event('input', { bubbles: true }));
  });
  const end = (e) => { if (drag) { drag = null; canvas.releasePointerCapture?.(e.pointerId); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
$('show-air').addEventListener('change', (e) => {
  air.setVisible(e.target.checked);
  if (e.target.checked) { solveAir(); air.play(); } else { air.stop(); air.clear(); }
  legend();
});
// Rerunning EnergyPlus for the week ending on the day picked, with the windows and doors as set now:
// the tool's airflow network model, run by the dev server, its results laid over the loaded ones.
let rerunning = false;
function rerunWeek() {
  const end = Number($('day').value);
  return [Math.max(1, end - 6), end];
}
function linkStates() {
  const mode = $('windows').value, states = {};
  for (const l of net.links) {
    if (l.door) {
      if (windowSet.has(l.name)) states[l.name] = windowSet.get(l.name);
      else if ($('doors').value === 'closed') states[l.name] = false;
    } else if (l.control === 'zone') {
      if (windowSet.has(l.name)) states[l.name] = windowSet.get(l.name);
      else if (roomSet.has(l.from)) states[l.name] = roomSet.get(l.from);
      else if (mode !== 'results') states[l.name] = mode === 'open';
      // else: left to the zone's control, opening above 25 degC as in ClimateStudio
    }
  }
  return states;
}
// year: the whole year, replacing the results; otherwise the week ending on the date picked, laid over them.
async function rerun(year = false) {
  if (rerunning || !weather || !runner || (!year && !results)) return;
  const file = $('weather-file').value, local = $('weather-file').selectedOptions[0]?.file;
  const [a, b] = year ? [1, 365] : rerunWeek(), da = dateOf(a), db = dateOf(b);
  const forModel = model, label = year ? 'whole year' : `${da.label}–${db.label}`;
  // Windows open as far as their sashes allow; EnergyPlus's control then opens them up to that.
  const openFactors = Object.fromEntries(net.links.filter((l) => l.control === 'zone').map((l) => [l.name, openFraction(l)]));
  // Hoppers and awnings run as EnergyPlus's pivoted openings, at the angle their opening amount gives.
  const pivoted = Object.fromEntries(net.links.filter((l) => l.control === 'zone' && ['hopper', 'awning'].includes(sashOf(l.name).type))
    .map((l) => [l.name, { type: sashOf(l.name).type, angle: amountOf(l) * maxAngleOf(l) }]));
  const epjson = toAirflowNetwork(model, { states: linkStates(), openFactors, sashes: pivoted, runPeriod: [da.month, da.day, db.month, db.day], skipSizing: true, surfaceTemperatures: true });
  rerunning = true;
  updateRun();
  $('stale').hidden = false;
  const t0 = Date.now();
  const tick = setInterval(() => { $('stale').textContent = `Running EnergyPlus for ${label}… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  try {
    // A weather file loaded from this computer goes with the model; the server's own go by name.
    const weatherBody = local ? { weatherText: await local.text() } : { weather: file };
    const res = await fetch(`${runnerBase}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epjson, ...weatherBody }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    const esoUrl = runnerBase + out.eso, eso = await fetch(esoUrl);
    const week = await readZoneResultsStream(eso.body, forModel, null, { hours: (b - a + 1) * 24 });
    if (model !== forModel) return;
    // A pivoted window reports its opening factor as angle / 90: read it as the share of the window
    // its sash frees at that angle, as the tool's other windows are.
    for (const [name, s] of Object.entries(pivoted)) {
      const series = week.windows[name.toUpperCase()], l = net.links.find((x) => x.name === name);
      if (series && l) week.windows[name.toUpperCase()] = series.map((f) => (f > 0 ? freeFraction(s.type, l.width, l.height, f * 90) : 0));
    }
    const merged = year ? week : mergeResults(results, week, hourIndex(a, 1));
    esoSource = { name: `${(forModel.source.fileName || 'model').replace(/\.(epjson|json)$/i, '')}_${year ? 'year' : 'week'}.eso`, blob: () => fetch(esoUrl).then((x) => x.blob()) };
    windowSet.clear(); roomSet.clear(); // the run now holds these choices
    modelEdited = false; // and the model as it is
    $('windows').value = 'results';
    clearInterval(tick);
    rerunning = false;
    $('stale').hidden = true;
    setResults(merged, year ? `EnergyPlus run, whole year (${Math.round(out.seconds)} s)` : `${results.name.replace(/; rerun .*$/, '')}; rerun ${label} (${Math.round(out.seconds)} s)`);
  } catch (err) {
    $('stale').textContent = `The rerun did not finish: ${err.message}`;
  } finally {
    clearInterval(tick);
    rerunning = false;
    updateRun();
  }
}
$('stale').addEventListener('click', (e) => { if (e.target.id === 'rerun') rerun(); });
$('run-period').addEventListener('change', (e) => { yearPicked = e.target.value === 'year'; });
$('run-eplus').addEventListener('click', () => rerun($('run-period').value === 'year'));


// What is selected now: a section plane, or a surface, window, door or zone.
const current = () => (view.sections.selected ? { kind: 'plane', item: view.sections.selected } : view.find(selected));

// Section planes: added from the bar (dragged in, or a click on the button and then on the view), and
// picked, moved and turned in the view (sections.js). The air on them follows every change.
view.sections.onChange = () => { drawSlices(true); planesMoved(); };
view.sections.onSelect = (p) => {
  if (p) { const c = view.sections.screen(view.sections.centre(p)); view.lastPick = [c.x, c.y]; view.select(null); showInfo({ kind: 'plane', item: p }); }
  else if ($('info').dataset.kind === 'plane') showInfo(current());
};
// Section | Plan: what the Clipping plane button places
for (const k of document.querySelectorAll('#clip-kind [data-clip]')) {
  k.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#clip-kind [data-clip]')) x.setAttribute('aria-pressed', String(x === k));
    document.querySelector('[data-add]').dataset.add = k.dataset.clip;
    if (view.sections.placing) view.sections.startPlacing(k.dataset.clip, false);
  });
}
for (const b of document.querySelectorAll('[data-add]')) {
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !model) return;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (m) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      window.removeEventListener('pointermove', move);
      view.sections.startPlacing(b.dataset.add, true);
      b.dataset.dragged = '1';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });
  b.addEventListener('click', () => {
    if (b.dataset.dragged) { delete b.dataset.dragged; return; }
    if (model) view.sections.startPlacing(b.dataset.add, false);
  });
}

// Opening and closing windows one by one or room by room, from the details of what is selected.
$('info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !airflow || !['window', 'room', 'wall'].includes(b.dataset.act)) return;
  if (b.dataset.act === 'wall') for (const n of model.surfaces[b.dataset.surface].windows) windowSet.set(n, b.dataset.open === '1');
  if (b.dataset.act === 'window') windowSet.set(b.dataset.name, b.dataset.open === '1');
  if (b.dataset.act === 'room') {
    roomSet.set(b.dataset.zone, b.dataset.open === '1');
    for (const l of net.links) if (l.from === b.dataset.zone) windowSet.delete(l.name);
  }
  solveAir();
  showInfo(current());
  legend();
});
// A window's opening amount, typed: a click on the figure beside its slider.
$('info').addEventListener('click', (e) => {
  const out = e.target.closest('output[data-for]');
  if (!out || out.classList.contains('typeable')) return;
  const slider = $('info').querySelector(`input[data-act=amount][data-name="${CSS.escape(out.dataset.for)}"]`);
  if (!slider) return;
  typeable(out, slider, parseTimes);
  out.click();
});
// Sashes: one window's type or hinge from its details, or all of them from the Sashes setting.
$('info').addEventListener('change', (e) => {
  if (e.target.dataset?.act !== 'sash') return;
  for (const n of scopeOf(e.target.dataset.name)) {
    sashSet.set(n, { ...sashSet.get(n), type: e.target.value });
    amountSet.delete(n); // a new mechanism: back to the amount that frees the model's fraction
  }
  solveAir();
  showInfo(current());
});
$('info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act=hinge]');
  if (!b) return;
  const s = sashOf(b.dataset.name);
  sashSet.set(b.dataset.name, { ...sashSet.get(b.dataset.name), hinge: s.hinge === 'left' ? 'right' : 'left' });
  solveAir();
  showInfo(current());
});
$('sash-type').addEventListener('change', () => { sashSet.clear(); amountSet.clear(); solveAir(); if (model) showInfo(current()); });
// The opening amount slider in a window's details: the window opens to it as the slider moves.
$('info').addEventListener('input', (e) => {
  if (e.target.dataset?.act !== 'amount') return;
  const name = e.target.dataset.name, a = Number(e.target.value) / 100, l = net.links.find((x) => x.name === name);
  for (const n of scopeOf(name)) { amountSet.set(n, a); windowSet.set(n, a > 0); }
  solveAir();
  const out = $('info').querySelector(`output[data-for="${CSS.escape(name)}"]`);
  if (out) out.textContent = amountText(l);
});
$('windows-reset').addEventListener('click', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(current()); legend(); });
for (const id of ['windows', 'doors']) $(id).addEventListener('change', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(current()); legend(); });


$('air-color').addEventListener('change', (e) => { air.colorBy = e.target.value; legend(); });
// What the grid solver needs for CO2 in an hour: each zone's level from the balance, the outdoor
// level, and the CO2 people breathe out and the outdoor air supplied, by zone.
function co2Message(hourAt, targets, site) {
  return {
    targets, outdoor: outdoorCO2(model, hourAt),
    generation: Object.fromEntries(net.zones.map((z, i) => [z, co2Generation(model, net.zones, hourAt)[i]])),
    supply: Object.fromEntries(outdoorAirSupply(model, net.zones, hourAt, site.elevation).map((m, i) => [net.zones[i], m])),
  };
}
// CO2 at a point (model coordinates): the grid solver's field, or with ideal flow its room's level.
function co2Near(p, zoneIndex = null) {
  const G = bakedPlay?.grid || grid, sim = bakedPlay ? bakedPlay.kind === 'grid' : $('room-air').value === 'grid';
  if (sim && G?.co2) return G.co2At(p);
  const g = rooms?.g;
  if (!g) return 400;
  const zi = zoneIndex ?? g.zone[cellAt(g, p)];
  return airflow?.co2?.[g.zones[zi]] ?? 400;
}
air.co2At = (p, zi) => co2Near(p, zi);
$('air-speed').addEventListener('input', (e) => { air.speed = Number(e.target.value); $('air-speed-value').textContent = `×${e.target.value}`; });
let selected = null;

// Weather: picking a day and hour fills in the outdoor conditions, which can still be edited.
function setWeather(w) {
  weather = w;
  weatherHour = null;
  applyHour();
}
// Running EnergyPlus needs a runner on this computer (tools/serve.mjs): the server this page came
// from, or, for the web demo, one started at RUNNER. runnerBase: where the runner is; runnerStatus: its answer.
const RUNNER = 'http://localhost:8000';
let runner = false, runnerBase = '', runnerStatus = null, yearPicked = false;
function updateRun() {
  const b = $('run-eplus'), week = $('run-period').querySelector('option[value=week]');
  // Without results only the whole year can run; the week comes back once there are some, unless a year was picked.
  week.disabled = !results;
  $('run-period').value = results && !yearPicked ? 'week' : 'year';
  b.disabled = !runner || !runnerStatus?.energyplus || !model || !weather || rerunning;
  b.title = !runner ? `Running EnergyPlus needs the runner on this computer: in the tool's folder, run npm run serve (with Node.js and EnergyPlus 23.1 installed). This page then finds it at ${RUNNER.replace('http://', '')}.`
    : !runnerStatus?.energyplus ? 'The runner on this computer has no EnergyPlus 23.1: install it, or run tools/run_alignment.py once to set it up.'
    : !model ? 'Load a model first' : !weather ? 'Pick a weather file first'
    : 'Run EnergyPlus on this model with the windows, doors and sashes as set now, and read its results in';
}
function applyHour() {
  updateRun();
  if (keyframes.length) followKeyframes(Number($('hour').value) - 1);
  if (!baking && !bakedPlay) bakeStatus();
  for (const id of ['day', 'hour', 'play']) $(id).disabled = !weather && !results;
  if (!weather && !results && $('play').classList.contains('on')) setPlaying(false);
  const day = Number($('day').value), hour = Number($('hour').value);
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  // Weather files and results keep standard time; on daylight-saving days the model's schedules
  // (people, lights) run an hour ahead, so the clock reads an hour later.
  const dst = model && daylightSavingDays(model.epjson);
  const clock = dst && day - 1 >= dst[0] && day - 1 <= dst[1] ? ` (${hh(hour % 24)}–${hh((hour + 1) % 24)} daylight time)` : '';
  const when = `${hh(hour - 1)}–${hh(hour)}${clock}`;
  $('day-value').textContent = weather || results ? dateOf(day).label : '';
  if (!weather) {
    $('when').textContent = results ? when : '';
    $('when').title = '';
    solveAir();
    if (model) showInfo(current());
    return;
  }
  weatherHour = outdoorAt(weather, day, hour);
  $('t-out').value = weatherHour.t;
  $('wind').value = weatherHour.windSpeed;
  $('wind-dir').value = weatherHour.windDirection;
  $('when').textContent = when;
  $('when').title = `${weather.location.name}, ${weather.fileName || 'weather file'}: ${weatherHour.t} °C, wind ${weatherHour.windSpeed} m/s from ${weatherHour.windDirection}°, ${(weatherHour.w * 1000).toFixed(1)} g/kg humidity`;
  solveAir();
  drawRose();
  if (model) showInfo(current());
}
async function loadWeather(name, read) {
  try { setWeather(parseEPW(await read(), { fileName: name })); } catch (err) {
    setWeather(null);
    $('when').innerHTML = `<span class="error-text">Could not read ${esc(name)}: ${esc(err.message)}</span>`;
  }
}
// Results: each zone's temperature, humidity and ventilation for the hour picked.
function setResults(r, name = '') {
  results = r ? { ...r, name } : null;
  if (!r) esoSource = null;
  queueMicrotask(() => { $('export-eso').disabled = !esoSource?.blob; });
  const option = $('windows').querySelector('option[value=results]');
  option.disabled = !r;
  if (r) $('windows').value = 'results';
  else if ($('windows').value === 'results') $('windows').value = 'open';
  $('t-in').disabled = !!r;
  const missing = r?.missing.length ? ` (no temperatures for ${r.missing.length} zones: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''})` : '';
  $('results-status').textContent = r ? `Zone temperatures from ${name}${missing}` : '';
  applyHour();
}
async function loadResults(name, stream, size, blobOf = null) {
  if (!model) { $('results-status').textContent = 'Load a model first.'; return; }
  const forModel = model;
  $('results-status').textContent = `Reading ${name}…`;
  try {
    const r = await readZoneResultsStream(stream, forModel, (bytes) => {
      $('results-status').textContent = `Reading ${name}… ${size ? Math.round((100 * bytes) / size) + '%' : (bytes / 1e6).toFixed(0) + ' MB'}`;
    });
    if (model !== forModel) return; // another model was loaded meanwhile
    if (!Object.keys(r.zones).length) throw new Error('it has no zone temperatures for this model');
    setResults(r, name);
    esoSource = { name, blob: blobOf };
  } catch (err) {
    setResults(null);
    $('results-status').innerHTML = `<span class="error-text">Could not use ${esc(name)}: ${esc(err.message)}</span>`;
  }
}
let resultFiles = [];
fetch('/results/').then((r) => (r.ok ? r.json() : [])).then((list) => {
  resultFiles = list;
  for (const f of list) $('results-file').add(new Option(`${f.label}: ${f.file}`, f.url));
}).catch(() => {});
// After an example loads, its own ClimateStudio results are read too.
function offerResults(id) {
  const f = resultFiles.find((x) => x.id === id);
  if (!f) return;
  $('results-file').value = f.url;
  $('results-file').dispatchEvent(new Event('change'));
}
$('results-file').addEventListener('change', async (e) => {
  const opt = e.target.selectedOptions[0];
  if (!e.target.value) return setResults(null);
  if (opt.file) return loadResults(opt.file.name, opt.file.stream(), opt.file.size, async () => opt.file);
  const url = e.target.value, res = await fetch(url);
  loadResults(opt.textContent, res.body, Number(res.headers.get('content-length')) || 0, () => fetch(url).then((x) => x.blob()));
});
$('results-load').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const option = new Option(file.name, `local:${file.name}`, true, true);
  option.file = file;
  $('results-file').add(option);
  loadResults(file.name, file.stream(), file.size, async () => file);
});
for (const id of ['day', 'hour']) $(id).addEventListener('input', applyHour);
$('weather-file').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) return setWeather(null);
  const local = e.target.selectedOptions[0].file;
  loadWeather(name, local ? () => local.text() : () => fetch(`${runnerBase}/weather/${encodeURIComponent(name)}`).then((r) => r.text()));
});
$('weather-load').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const option = new Option(file.name, file.name, true, true);
  option.file = file;
  $('weather-file').add(option);
  loadWeather(file.name, () => file.text());
});
// The dev server offers the course weather files; the one ClimateStudio's runs used is picked first.
// The runner: the page's own server first, then one on this computer for a page served elsewhere.
const askStatus = (base) => fetch(`${base}/status`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
async function findRunner() {
  let base = '', s = await askStatus('');
  if (!s?.runner && location.origin !== RUNNER) { base = RUNNER; s = await askStatus(RUNNER); }
  const found = !!s?.runner, first = !runner && found;
  runner = found; runnerBase = found ? base : ''; runnerStatus = found ? s : null;
  updateRun();
  // The runner's weather files, offered by name; the one ClimateStudio's runs used is picked first.
  if (!first) return;
  const files = s.weather || [], have = new Set([...$('weather-file').options].map((o) => o.value));
  for (const f of files) if (!have.has(f)) $('weather-file').add(new Option(f, f));
  const pick = files.find((f) => f.includes('TDY-CWEC2020v2'));
  if (pick && !weather) { $('weather-file').value = pick; $('weather-file').dispatchEvent(new Event('change')); }
}
findRunner();
// A runner started after the page opened is found when the page is next looked at.
addEventListener('focus', () => { if (!runner || runnerBase) findRunner(); });

const load = (file) => loadText(file.name, () => file.text());

async function loadText(name, read) {
  $('status').textContent = `Reading ${name}…`;
  massing = null; $('massing').hidden = true; $('mass-open').hidden = false; massEdit.stop(); tools.stop(); $('model-tools').hidden = true;
  try {
    const epjson = JSON.parse(await read());
    model = importEpJSON(epjson, { fileName: name });
  } catch (err) {
    model = null;
    $('status').innerHTML = `<span class="error-text">Could not read ${esc(name)}: ${esc(err.message)}</span>`;
    $('results').hidden = true;
    $('export').disabled = true;
    return;
  }
  $('status').textContent = name;
  $('export').disabled = false;
  render(model);
}

// The dev server offers the course examples when they are on this computer (see tools/serve.mjs).
fetch('/examples/').then((r) => (r.ok ? r.json() : [])).then((list) => {
  if (!list.length) return;
  $('examples').hidden = false;
  $('examples').innerHTML = list.map((e, i) => `<button class="minibtn" data-i="${i}" title="${esc(e.file)}">${esc(e.label)}</button>`).join(' ');
  $('examples').addEventListener('click', (ev) => {
    const e = list[ev.target.dataset?.i];
    if (e) loadText(e.file, () => fetch(e.url).then((r) => r.text())).then(() => offerResults(e.id));
  });
}).catch(() => {});

// The selected surface, window, zone, door or section plane, in a pop-up beside where it was picked
// (as the Solar Shading Explorer's): its settings to change, the air through it, and any checks that
// name it. The pop-up keeps beside its selection on screen, clear of it, as the view turns, until it
// is dragged somewhere; then it stays there while the same thing is selected.
let popKey = null, popMin = false, layersOpen = false, popPinned = false, popShut = null; // popShut: the selection whose pop-up was closed
function showInfo(found) {
  const box = $('info');
  // a window of a massing: the Zones window turns to its zone and face
  const at = massing && found?.kind === 'window' && massingWindow(massing, found.item.name);
  if (at && !$('massing').hidden) massingUI.show(at.zone, at.face);
  else if (found?.kind === 'zone' && !$('massing').hidden) massingUI.showName(found.item.name);
  if (found && levelEdits.selected !== null) levelEdits.select(null);
  // a massing's zone or surface: its handles
  const mt = massing && massingTarget(found);
  if (mt) massEdit.start(mt); else massEdit.stop();
  if (found?.kind !== 'plane') selected = found?.item?.name ?? null;
  queueMicrotask(() => ws.selection());
  if (winEdit.active && !(found?.kind === 'window' && found.item.name === winEdit.name)) winEdit.stop();
  if (!found) { box.hidden = true; box.dataset.kind = ''; popKey = null; popShut = null; view.clicked = false; return; }
  const { kind, item } = found, key = `${kind}:${item.name}`;
  // its pop-up closed: the selection stays, the pop-up stays shut until another is selected
  const clicked = view.clicked;
  view.clicked = false;
  if (key === popShut && !clicked) { box.hidden = true; return; }
  popShut = null;
  // Not redrawn under a figure being typed, unless the selection changed.
  if (key === popKey && box.contains(document.activeElement) && document.activeElement.matches('input:not([type=range]), select')) return;
  const { title, rows } = popContent(kind, item);
  box.dataset.kind = kind;
  box.innerHTML = `<div class="pophd" title="Drag to move"><span class="popttl">${title}</span><span class="popbtns">`
    + `<button type="button" data-pop="min" title="${popMin ? 'Show the details' : 'Fold the details away'}">${popMin ? '▸' : '–'}</button>`
    + '<button type="button" data-pop="close" title="Close this pop-up; the selection stays (Esc deselects)">×</button></span></div>'
    + `<div class="popbody"${popMin ? ' hidden' : ''}>${rows.map((r) => (r.startsWith('<div') ? r : `<div>${r}</div>`)).join('')}</div>`;
  box.hidden = false;
  if (key !== popKey) { popKey = key; popPinned = false; placePop(); }
}

// Beside the point picked, inside the view.
function placePop() {
  const box = $('info'), v = $('viewer'), at = view.lastPick;
  if (!at) { Object.assign(box.style, { left: '10px', top: '10px', bottom: '' }); return; }
  const w = box.offsetWidth, h = box.offsetHeight, W = v.clientWidth, H = v.clientHeight;
  const x = Math.max(8, Math.min(at[0] + 16, W - w - 8)), y = Math.max(8, Math.min(at[1] + 12, H - h - 8));
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, bottom: '' });
}
$('info').addEventListener('pointerdown', (e) => {
  const hd = e.target.closest('.pophd');
  if (!hd || e.target.closest('button') || e.button !== 0) return;
  const box = $('info'), x0 = e.clientX - box.offsetLeft, y0 = e.clientY - box.offsetTop;
  const move = (m) => { popPinned = true; Object.assign(box.style, { left: `${m.clientX - x0}px`, top: `${m.clientY - y0}px`, bottom: '' }); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
});
// After each frame: the pop-up beside the selection's outline on screen (right of it, else left, else
// below), never over it; a window being edited keeps room for its figures.
function followPop() {
  const box = $('info');
  if (popPinned || box.hidden || !model) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  if (box.dataset.kind === 'plane') {
    // Beside a plane's gumball, clear of its arrows.
    if (!view.sections.selected) return;
    const c = view.sections.screen(view.sections.centre(view.sections.selected));
    [x0, x1, y0, y1] = [c.x - 70, c.x + 70, c.y - 70, c.y + 70];
  } else {
    if (!view.selectedPolys?.length) return;
    const pts = view.selectedPolys.flatMap((p) => p.vertices), o = view.origin, q = new THREE.Vector3();
    for (const p of pts) {
      const s2 = view.sections.screen(q.set(p[0] - o[0], p[1] - o[1], p[2] - o[2]));
      x0 = Math.min(x0, s2.x); x1 = Math.max(x1, s2.x); y0 = Math.min(y0, s2.y); y1 = Math.max(y1, s2.y);
    }
  }
  // A massing's handles and figures count as part of it.
  if (massEdit.active && massEdit.svg.childElementCount) {
    const b = massEdit.svg.getBBox();
    x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.width); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.height);
  }
  const pad = winEdit.active ? 64 : 14, v = $('viewer'), W = v.clientWidth, H = v.clientHeight, w = box.offsetWidth, h = box.offsetHeight;
  const cy = Math.max(8, Math.min((y0 + y1) / 2 - h / 2, H - h - 8)), cx = Math.max(8, Math.min((x0 + x1) / 2 - w / 2, W - w - 8));
  // Right of it, left, below, above; where none fits clear, the place that covers least of it.
  const places = [[x1 + pad, cy], [x0 - pad - w, cy], [cx, y1 + pad], [cx, y0 - pad - h]]
    .map(([px, py]) => [Math.max(8, Math.min(px, W - w - 8)), Math.max(8, Math.min(py, H - h - 8))]);
  const cover = ([px, py]) => Math.max(0, Math.min(px + w, x1) - Math.max(px, x0)) * Math.max(0, Math.min(py + h, y1) - Math.max(py, y0));
  const [x, y] = places.reduce((a, b) => (cover(b) < cover(a) ? b : a));
  const l = `${Math.round(x)}px`, t = `${Math.round(y)}px`;
  if (box.style.left !== l || box.style.top !== t) Object.assign(box.style, { left: l, top: t, bottom: '' });
}
$('info').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pop]');
  if (!b) return;
  if (b.dataset.pop === 'close') { popShut = popKey; $('info').hidden = true; return; }
  popMin = !popMin;
  showInfo(current());
});

// A heading inside the pop-up.
const popSec = (t, tip = '') => `<div class="popsec"${tip ? ` title="${esc(tip)}"` : ''}>${t}</div>`;
// A figure that can be typed over: a setting of the model, applied when Enter is pressed or it is left.
const popNum = (key, value, unit, tip, digits = 2, extra = '') => `<span class="popv"><input class="popnum" data-zset="${key}"${extra} value="${value === null || value === undefined ? '' : +Number(value).toFixed(digits)}" ${value === null || value === undefined ? 'disabled placeholder="–"' : ''} title="${esc(tip)}"> ${unit}</span>`;

function popContent(kind, item) {
  const rows = [];
  const deg = (x) => (x === null ? '' : `${Math.round(x)}°`);
  if (kind === 'plane') return { title: esc(item.name), rows: planeRows(item) };
  let title;
  if (kind === 'surface') {
    title = `${esc(item.csType)} · ${esc(item.zone)}`;
    rows.push(`<span class="muted">${esc(item.name)}</span>`,
      `${fmt(item.area, 2)} m² · ${item.azimuth === null ? (item.tilt < 90 ? 'faces up' : 'faces down') : `faces ${deg(item.azimuth)} from north`} · tilt ${deg(item.tilt)}`);
    if (item.adjacentZone) rows.push(`Shared with zone ${esc(item.adjacentZone)}`);
    { const ms = massingSide(kind, item); if (ms) rows.push(...sideRows(ms)); }
    rows.push(...assemblyRows(item));
  } else if (kind === 'window') {
    const r = windowRect(model, item.name), floor = model.zones[item.zone].bottom;
    title = `Window · ${dirWord(item.azimuth)} · level ${levelOf(item) + 1}`;
    rows.push(`<span class="muted">${esc(item.name)}, ${esc(item.zone)}</span>`,
      r ? `${fmt(r.s1 - r.s0, 2)} × ${fmt(r.z1 - r.z0, 2)} m, sill ${fmt(r.z0 - floor, 2)} m · ${fmt(item.area, 2)} m²` : `${fmt(item.area, 2)} m² · ${fmt(item.height, 2)} m tall`,
      item.operableFraction ? `Operable fraction ${fmt(item.operableFraction.value, 2)}` : 'Not operable');
    const ms = massingSide(kind, item);
    if (ms) title = `Window ${ms.index + 1} of ${ms.n}`;
    if (r) rows.push(`<button class="pbtn${winEdit.name === item.name ? ' on' : ''}" data-act="winedit" title="${winEdit.name === item.name ? 'Back to the building: the handles go (Esc)' : 'Its sill, head and jambs get handles in the view to push or pull; drag the glass to move it across its wall; click a handle or a figure to type it'}">${winEdit.name === item.name ? 'Done' : 'Edit window in 3D'}</button>`);
    if (ms) rows.push(...sideRows(ms, winEdit.name === item.name));
  } else if (kind === 'door') {
    title = 'Door';
    rows.push(`Between ${esc(item.zone)} and ${esc(item.partnerZone)}`, `${fmt(item.width, 2)} × ${fmt(item.height, 2)} m`,
      '<span class="muted">Added by the tool for the airflow network; the model has no interior openings here.</span>');
  } else if (kind === 'zone') {
    title = `Zone · ${esc(item.name)}`;
    rows.push(`${fmt(item.floorArea.value, 1)} m² floor · ${fmt(item.volume.value, 0)} m³ · ${fmt(item.height, 2)} m high`);
    rows.push(...zoneLevelRows(item));
    rows.push(...zoneRows(item));
  } else {
    title = 'Shading surface';
    rows.push(esc(item.name));
  }
  if (airflow) {
    const air = airLines(kind, item);
    if (air.length) rows.push(popSec(kind === 'window' ? 'Opening' : 'Air'), ...air);
    if (kind === 'window' && air.length) {
      rows.push(`<div class="poprow"><label class="chk" title="The window type and opening amount set here go to every window on this window's level, on all sides of the building"><input type="checkbox" data-apply="sides"${applyAll.sides ? ' checked' : ''}> Apply to all sides</label>`
        + `<label class="chk" title="The window type and opening amount set here go to the windows on this side of the building on every level"><input type="checkbox" data-apply="levels"${applyAll.levels ? ' checked' : ''}> Apply to all levels</label></div>`);
    }
    if (kind === 'zone') rows.push(...roomButton(item.name));
    if (kind === 'surface' || kind === 'window') rows.push(`Room: ${co2Line(item.zone)}`);
    if (kind === 'surface') rows.push(...wallButton(item));
  }
  for (const c of model.checks.filter((c) => c.objects.includes(item.name))) {
    const cls = c.level === 'error' ? 'error-text' : c.level === 'warning' ? 'warning-text' : 'muted';
    rows.push(`<span class="${cls}">${esc(c.message)}</span>`);
  }
  return { title, rows };
}

// A clipping plane's own view of the air: what its cut is coloured by, and its particles (their
// colour, density and speed), so planes can show different things. Moving it is its gumball's job.
const TIMES = (k) => `×${k < 1 ? k.toFixed(2).replace(/0$/, '') : k}`;
function planeRows(p) {
  const a = p.air, opt = (list, now) => list.map(([v, l]) => `<option value="${v}"${v === now ? ' selected' : ''}>${l}</option>`).join('');
  const fields = [['', 'None'], ['temperature', 'Temperature'], ['speed', 'Speed'], ['co2', 'CO₂']];
  const made = namedViews().filter((v) => v.plane === p.id), kindWord = p.kind === 'plan' ? 'plan' : 'section';
  const suggest = p.kind === 'plan' ? `Plan at ${fmt(p.o.z + (view.origin?.[2] || 0), 2)} m` : `Section ${namedViews().filter((v) => v.kind === 'section').length + 1}`;
  return [
    ...made.map((v) => `<span class="popkv"><span class="tipped" title="A ${v.kind} view made from this plane, linked to it: moving either moves the other">View</span><button type="button" class="pbtn" data-plview-open="${v.id}" title="Show it">${esc(v.name)}</button></span>`),
    `<div class="poprow"><input class="popname" data-plview-name placeholder="${esc(suggest)}" title="The view's name (Tab takes the suggestion)"><button type="button" class="pbtn" data-plview title="A ${kindWord} view of this cut, named and linked to this plane: show it from its name here, or pick it in a plan or section view">Create ${kindWord} view</button></div>`,
    `<label class="chk" title="Switch the plane's cut off without removing it: the building, the air and the particles show whole; switch it on again to cut as before"><input type="checkbox" data-air="on"${p.off ? '' : ' checked'}> Cut on</label>`,
    `<span class="popkv"><span class="tipped" title="Colour the cut where it passes through rooms: the air's temperature, speed or CO2. Point at the cut to read the values there.">Cut colour</span><select class="popsel" data-air="field">${opt(fields, a.field)}</select></span>`,
    `<label class="chk" title="Particles moving with the air within this plane, trailing, as in a 2D section: their own, apart from the 3D particles"><input type="checkbox" data-air="particles"${a.particles ? ' checked' : ''}> Particles in the cut</label>`,
    `<label class="chk" title="The 3D airflow particles seen through this cut: off, only the cut's own particles show there. Each plane decides for what is seen through it."><input type="checkbox" data-air="beyond"${a.beyond ? ' checked' : ''}> Show 3D particles beyond</label>`,
    ...(a.particles ? [
      `<span class="popkv"><span>Colour</span><select class="popsel" data-air="color">${opt([['temperature', 'Temperature'], ['speed', 'Speed'], ['co2', 'CO₂'], ['none', 'None (black)']], a.color)}</select></span>`,
      `<span class="popkv"><span class="tipped" title="How many particles for the same area of air">Density</span><span class="popv"><input type="range" data-air="density" min="-2" max="2" step="0.5" value="${Math.log2(a.density)}"> <output>${TIMES(a.density)}</output></span></span>`,
      `<span class="popkv"><span class="tipped" title="How much faster than real time they move">Speed</span><span class="popv"><input type="range" data-air="speed" min="1" max="60" value="${a.speed}"> <output>${TIMES(a.speed)}</output></span></span>`,
    ] : []),
  ];
}
// Its settings changed: the cut redrawn (density and speed as the slider moves).
function onAir(e) {
  const t = e.target, key = t.dataset?.air, p = view.sections.selected;
  if (!key || !p) return;
  const a = p.air;
  if (key === 'on') { p.off = !t.checked; view.sections.changed(); drawSlices(true); showInfo(current()); legend(); return; }
  if (key === 'particles') a.particles = t.checked;
  else if (key === 'beyond') { a.beyond = t.checked; view.sections.changed(); }
  else if (key === 'density') a.density = 2 ** Number(t.value);
  else if (key === 'speed') a.speed = Number(t.value);
  else a[key] = t.value;
  if (key === 'density' || key === 'speed') t.nextElementSibling.textContent = TIMES(a[key]);
  if (key !== 'speed') drawSlices(true);
  if (e.type === 'change' && key !== 'density' && key !== 'speed') showInfo(current());
  legend();
}
$('info').addEventListener('input', onAir);
$('info').addEventListener('click', (e) => {
  const p = view.sections.selected, b = e.target.closest('[data-plview], [data-plview-open]');
  if (!b || !p) return;
  if (b.dataset.plviewOpen !== undefined) { ws.open(Number(b.dataset.plviewOpen)); return; }
  const input = $('info').querySelector('[data-plview-name]'), name = input.value.trim() || input.placeholder;
  viewFromPlane(p, name);
});
$('info').addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.matches?.('[data-plview-name]')) return;
  if (e.key === 'Tab' && !t.value) { t.value = t.placeholder; e.preventDefault(); }
  if (e.key === 'Enter') { e.preventDefault(); t.nextElementSibling.click(); }
  e.stopPropagation();
});
$('info').addEventListener('change', onAir);

const dirWord = (az) => (az === null || az === undefined ? 'skylight' : ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(az / 45) % 8]);

// Surface films (inside + outside, m2.K/W, ISO 6946) for a construction's U-value by surface type.
const FILMS = { wall: 0.13 + 0.04, floor: 0.17 + 0.04, roof: 0.1 + 0.04, ceiling: 0.1 + 0.04 };
const materialNames = () => ['Material', 'Material:NoMass', 'Material:AirGap'].flatMap((t) => Object.keys(model.epjson[t] || {})).sort();

// A surface's assembly: the construction it takes (any of the model's opaque ones), drawn in section
// with its two sides named, and its layers to change (outside first). Changing a layer changes every
// surface with that assembly; a copy gives this surface one of its own.
function assemblyRows(s) {
  const ep = model.epjson, base = baseConstruction(s.construction);
  const users = constructionUses(ep, base);
  const opts = Object.keys(ep.Construction || {}).filter((n) => !n.endsWith('_FLIPPED') && !constructionProperties(ep, n)?.glazing).sort()
    .map((n) => `<option${n === base ? ' selected' : ''}>${esc(n)}</option>`).join('');
  // The construction's outside layer faces the other side of the surface; on a shared surface that
  // takes the reversed one, the construction's outside faces this zone.
  const other = s.boundary === 'Surface' ? `Zone ${s.adjacentZone}` : s.boundary === 'Outdoors' ? 'Exterior' : /ground/i.test(s.boundary) ? 'Ground' : s.boundary;
  const mine = s.boundary === 'Surface' ? `Zone ${s.zone}` : 'Interior';
  const [outside, inside] = s.construction.endsWith('_FLIPPED') ? [mine, other] : [other, mine];
  const along = String(s.surfaceType).toLowerCase() === 'wall' ? 'wall' : String(s.surfaceType).toLowerCase() === 'floor' ? 'floor' : 'roof';
  return [popSec('Assembly', 'The construction of this surface. Partitions and slabs shared by two zones take it on both sides, reversed on the other.'),
    `<select class="popsel wide" data-act="construction" title="Give this surface another of the model's assemblies">${opts}</select>`,
    ...assemblyEditor(base, { outside, inside, along, users, film: FILMS[String(s.surfaceType).toLowerCase()] ?? 0.17, open: layersOpen, copy: true })];
}

// Layers of an assembly, drawn and listed, for the pop-up and the Materials and assemblies window.
// along: 'wall' (outside left), 'roof' (outside on top) or 'floor' (outside below).
function assemblyEditor(base, { outside = 'Exterior', inside = 'Interior', along = 'wall', users = constructionUses(model.epjson, base), film = 0.17, open = true, copy = false } = {}) {
  const ep = model.epjson, c = constructionProperties(ep, base);
  if (!c) return [];
  const rows = [`<div class="popdraw" data-c="${esc(base)}">${assemblyDrawing(base, { outside, inside, along })}</div>`,
    `R ${fmt(c.R, 2)} m²·K/W · U ${c.R === null ? '–' : fmt(1 / (c.R + film), 3)} W/m²·K · ${fmt((c.thickness || 0) * 1000, 0)} mm · <span title="Surfaces and windows with this assembly (both sides of shared ones count)">${users} surface${users === 1 ? '' : 's'}</span>`];
  if (copy) rows.push(`<button class="pbtn more" data-act="layers" aria-expanded="${open}">${open ? 'Layers ▴' : 'Layers ▸'}</button>`);
  if (!open) return rows;
  const mats = materialNames(), layers = layersOf(ep.Construction[base]);
  rows.push(`<div class="lside" data-c="${esc(base)}">▲ ${esc(outside)} side</div>`);
  layers.forEach((m, i) => {
    const thick = materialType(ep, m) === 'Material';
    rows.push(`<div class="poplayer" data-c="${esc(base)}"><span class="lnum" title="${i ? `Layer ${i + 1} from the ${esc(outside)} side` : `Outermost, on the ${esc(outside)} side`}">${i + 1}</span>`
      + `<select class="popsel" data-act="layer-mat" data-i="${i}" title="${esc(m)}">${mats.map((n) => `<option${n === m ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`
      + (thick ? `<input class="popnum" data-act="layer-thk" data-i="${i}" value="${+(ep.Material[m].thickness * 1000).toFixed(1)}" title="Thickness, mm"> mm` : '<span class="muted" title="A layer without mass: a resistance only">R only</span>')
      + `<button type="button" class="pbtn x" data-act="layer-up" data-i="${i}" title="Move it one layer towards the ${esc(outside)} side"${i ? '' : ' disabled'}>↑</button>`
      + `<button type="button" class="pbtn x" data-act="layer-down" data-i="${i}" title="Move it one layer towards the ${esc(inside)} side"${i < layers.length - 1 ? '' : ' disabled'}>↓</button>`
      + `<button type="button" class="pbtn x" data-act="layer-del" data-i="${i}" title="Take this layer out">×</button></div>`);
  });
  rows.push(`<div class="lside" data-c="${esc(base)}">▼ ${esc(inside)} side</div>`,
    `<div class="poprow" data-c="${esc(base)}"><button class="pbtn" data-act="layer-add" title="A layer added on the ${esc(inside)} side, a copy of the innermost one's material">Add layer</button>`
    + `<span class="muted">${users > 1 ? `Changes all ${users} surfaces with this assembly` : ''}</span></div>`);
  if (copy) rows.push(`<div class="poprow" data-c="${esc(base)}"><input class="popname" data-act="copy-name" placeholder="${esc(base)} copy" title="A name for the copy: Tab takes the one suggested"><button class="pbtn" data-act="copy" title="A copy of this assembly, with its own materials, given to this surface only (and its other side)">Copy for this surface</button></div>`);
  return rows;
}

// What a material looks like in section, from what it is made of: insulation (low conductivity),
// masonry and concrete (dense), timber, a board, a resistance-only layer or an air gap.
function materialLook(ep, name) {
  const type = materialType(ep, name), m = ep[type]?.[name] || {};
  if (type === 'Material:AirGap' || /air ?(gap|space|cavity)/i.test(name)) return 'gap';
  if (type !== 'Material') return 'res';
  // By name first: densities overlap (a hollow clay block weighs what timber does).
  const n = name.toLowerCase();
  if (/insul|wool|eps|xps|polystyrene|polyiso|pir|foam|fibre|fiber|cellulose|batt|cork|hemp/.test(n)) return 'ins';
  if (/plaster|gypsum|board|render|stucco|tile|carpet|screed|membrane/.test(n)) return 'board';
  if (/concrete|brick|block|clay|porotherm|masonry|stone|mortar|cement|terrazzo/.test(n)) return 'mas';
  if (/wood|timber|ply|osb|clt|lumber|glulam|lvl|oak|pine|spruce|fir/.test(n)) return 'wood';
  if (/steel|metal|alumin|copper|zinc/.test(n)) return 'metal';
  if (m.conductivity <= 0.07) return 'ins';
  if (m.density >= 1500) return 'mas';
  if (m.density >= 350 && m.density <= 900 && m.conductivity <= 0.3) return 'wood';
  if (m.density > 4000) return 'metal';
  return 'board';
}

// The assembly in section: each layer as wide as it is thick (thin ones kept visible), patterned by
// what it is, numbered as listed, the two sides named.
function assemblyDrawing(base, { outside, inside, along }) {
  const ep = model.epjson, layers = layersOf(ep.Construction[base]);
  const t = layers.map((m) => (materialType(ep, m) === 'Material' ? ep.Material[m].thickness : 0));
  const total = t.reduce((a, b) => a + b, 0) || 1, wall = along === 'wall';
  const span = wall ? 200 : 74, minW = 5;
  const raw = t.map((x) => Math.max(minW, (x / total) * span)), k = span / raw.reduce((a, b) => a + b, 0);
  const size = raw.map((x) => Math.max(minW * Math.min(1, k * 1.6), x * k));
  const W = wall ? 300 : 300, H = wall ? 74 : size.reduce((a, b) => a + b, 0) + 30;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="asm" role="img" aria-label="${esc(base)} in section">${ASM_DEFS}`;
  let at = wall ? 50 : 15;
  // Layers in their order from the outside side: left to right in a wall, top down in a roof,
  // bottom up in a floor.
  const order = layers.map((m, i) => i);
  if (along === 'floor') { at = 15 + size.reduce((a, b) => a + b, 0); }
  order.forEach((i) => {
    const look = materialLook(ep, layers[i]), w = size[i];
    const tip = `${i + 1}. ${layers[i]}${t[i] ? `, ${fmt(t[i] * 1000, 0)} mm` : ''}${ep.Material?.[layers[i]] ? `, k ${ep.Material[layers[i]].conductivity} W/m·K` : ''}`;
    let x, y, bw, bh;
    if (wall) { x = at; y = 10; bw = w; bh = 48; at += w; }
    else if (along === 'roof') { x = 60; y = at; bw = 180; bh = w; at += w; }
    else { at -= w; x = 60; y = at; bw = 180; bh = w; }
    s += `<g><title>${esc(tip)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" class="ly ${look}" fill="url(#asm-${look})"/>`;
    if ((wall ? bw : bh) >= 12) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y + bh / 2 + 3).toFixed(1)}" class="lyn">${i + 1}</text>`;
    s += '</g>';
  });
  if (wall) {
    s += `<text x="45" y="38" class="side" text-anchor="end">${esc(short(outside))}</text><text x="${at + 5}" y="38" class="side">${esc(short(inside))}</text>`;
  } else {
    const top = along === 'roof' ? outside : inside, bottom = along === 'roof' ? inside : outside, y1 = 15 + size.reduce((a, b) => a + b, 0);
    s += `<text x="150" y="11" class="side" text-anchor="middle">${esc(short(top))}</text><text x="150" y="${y1 + 12}" class="side" text-anchor="middle">${esc(short(bottom))}</text>`;
  }
  return s + '</svg>';
}
const short = (t) => (t.length > 16 ? t.slice(0, 15) + '…' : t);
// Patterns for the section's layers, in the drawings' greys.
const ASM_DEFS = `<defs>
  <pattern id="asm-ins" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#FBF6EA"/><path d="M0 6 Q2 0 4 4 T8 2" fill="none" stroke="#C9A85C" stroke-width=".8"/></pattern>
  <pattern id="asm-mas" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#E2E4E1"/><line x1="0" y1="0" x2="0" y2="5" stroke="#7D8A87" stroke-width=".8"/></pattern>
  <pattern id="asm-wood" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#EFE2CC"/><path d="M0 2 h6 M0 5 h6" stroke="#B48A55" stroke-width=".5"/></pattern>
  <pattern id="asm-board" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#F1F2EF"/><circle cx="2" cy="2" r=".45" fill="#9AA5A2"/></pattern>
  <pattern id="asm-metal" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#9AA5A2"/></pattern>
  <pattern id="asm-res" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#FDFDFC"/></pattern>
  <pattern id="asm-gap" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#FDFDFC"/></pattern>
</defs>`;

// A zone's settings, read from its objects, each typed over: occupancy with its schedule through the
// day picked, lights, equipment, outdoor air, infiltration and when its windows open.
function zoneRows(z) {
  const ep = model.epjson, s = zoneSettings(ep, z.name), rows = [];
  const hourAt = hourIndex(Number($('day').value), Number($('hour').value)), dayStart = hourIndex(Number($('day').value), 1);
  rows.push(popSec('Occupancy', 'People in the zone: a peak density, and a schedule of the fraction present each hour'));
  rows.push(`${popNum('peoplePerArea', s.peoplePerArea, 'people/m²', 'Peak people per square metre of floor', 4)}`
    + (z.people ? ` · ${fmt(s.peoplePerArea ? 1 / s.peoplePerArea : null, 1)} m²/person` : ''));
  if (s.peopleSchedule) {
    const opts = schedulesOfType(ep, 'Fraction', s.peopleSchedule).map((n) => `<option${n === s.peopleSchedule ? ' selected' : ''}>${esc(n)}</option>`).join('');
    rows.push(`<select class="popsel wide" data-zset="peopleSchedule" title="The fraction of the peak present each hour">${opts}</select>`);
    const values = scheduleValues(s.peopleSchedule);
    if (values) {
      const day = Array.from({ length: 24 }, (_, h) => values[dayStart + h] ?? 0), now = values[hourAt] ?? 0;
      const people = (z.people?.density.value || 0) * z.floorArea.value * now;
      rows.push(`<div class="popday" title="The fraction present through ${esc(dateOf(Number($('day').value)).label)}, hour by hour; the hour picked is darker">${daySpark(day, hourAt - dayStart)}</div>`,
        `${fmt(people, 1)} people now (${fmt(100 * now, 0)}% of peak)`);
    }
  }
  rows.push(popSec('Loads'),
    `<span class="popkv"><span>Lights</span>${popNum('lightsPerArea', s.lightsPerArea, 'W/m²', 'Lighting power per square metre of floor, at full use', 2)}</span>`,
    `<span class="popkv"><span>Equipment</span>${popNum('equipmentPerArea', s.equipmentPerArea, 'W/m²', 'Equipment power per square metre of floor, at full use', 2)}</span>`);
  rows.push(popSec('Ventilation', 'Mechanical: the outdoor air the zone\'s ideal loads supply (people and floor area add up). Infiltration: air leaking in, as air changes per hour. Natural: windows open when the room is warmer than this.'),
    `<span class="popkv"><span>Outdoor air</span>${popNum('outdoorAirPerPerson', s.outdoorAirPerPerson === null ? null : s.outdoorAirPerPerson * 1000, 'L/s·person', 'Mechanical outdoor air per person', 2, ' data-scale="0.001"')}</span>`,
    `<span class="popkv"><span></span>${popNum('outdoorAirPerArea', s.outdoorAirPerArea === null ? null : s.outdoorAirPerArea * 1000, 'L/s·m²', 'Mechanical outdoor air per square metre of floor', 3, ' data-scale="0.001"')}</span>`,
    `<span class="popkv"><span>Infiltration</span>${popNum('infiltrationAch', s.infiltrationAch, 'ach', 'Air changes per hour leaking in', 3)}</span>`,
    `<span class="popkv"><span>Windows open above</span>${popNum('ventMinIndoor', s.ventMinIndoor, '°C', 'Natural ventilation: the room temperature above which its windows open', 1)}</span>`);
  return rows;
}

// 24 bars, one an hour, as high as the fraction present; the hour picked darker.
function daySpark(day, now) {
  const w = 7, h = 26;
  return `<svg width="${24 * w}" height="${h + 10}" viewBox="0 0 ${24 * w} ${h + 10}" aria-hidden="true">`
    + day.map((f, i) => `<rect x="${i * w + 0.5}" y="${h - Math.max(0.5, f * h)}" width="${w - 1.5}" height="${Math.max(0.5, f * h)}" class="${i === now ? 'now' : ''}"/>`).join('')
    + [0, 6, 12, 18].map((x) => `<text x="${x * w}" y="${h + 9}">${x}</text>`).join('') + '</svg>';
}

const CO2_HELP = `The mean over this hour, from a balance over the airflow network run through the ${CO2_HOURS} hours before: the people in the model's schedules breathing out CO2, outdoor air coming in through windows, leaks and any ventilation equipment, and air passing between rooms. Windows and doors are held as set now for those hours. Outdoor air is about 400 ppm; above 1000 ppm rooms feel stuffy.`;

// A zone's CO2 from the tool, with the results' own figure beside it where they report one.
function co2Line(zone) {
  const co2 = airflow?.co2?.[zone], recorded = airflow?.conditions.zones[zone]?.co2;
  return `<span id="co2-line" data-zone="${esc(zone)}"><span title="${esc(CO2_HELP)}">CO₂ ${co2 === undefined ? '…' : `${fmt(co2, 0)} ppm`}</span>`
    + `${recorded !== null && recorded !== undefined ? ` <span class="muted" title="Zone Air CO2 Concentration in the results, the mean over this hour">(results: ${fmt(recorded, 0)} ppm)</span>` : ''}</span>`;
}

// Air moving through a zone, or through a window, door or surface leak, from the latest solution.
function airLines(kind, item) {
  const m3h = (kg) => fmt((kg / 1.2) * 3600, 0);
  if (kind === 'zone') {
    const q = (airflow.flows.throughflow[net.zones.indexOf(item.name)] / 1.2) * 3600;
    const c = airflow.conditions.zones[item.name];
    return [`Air at ${fmt(c.t, 1)} °C${results ? ' (from results)' : ''}; ${fmt(q, 0)} m³/h through the zone, ${fmt(q / item.volume.value, 1)} air changes/h`, co2Line(item.name)];
  }
  // A wall between two zones is one link in the network, named after one of its two surfaces.
  let i = net.links.findIndex((l) => l.name === item.name);
  if (i < 0 && kind === 'surface' && item.adjacentSurface) i = net.links.findIndex((l) => l.name === item.adjacentSurface);
  if (i < 0) return [];
  const r = airflow.solution.links[i], l = net.links[i], other = l.to ?? 'outdoors';
  const what = l.type === 'crack' ? 'Leakage' : 'Air';
  const lines = [`${what}: ${m3h(r.forward)} m³/h ${esc(l.from)} → ${esc(other)}, ${m3h(r.backward)} m³/h ${esc(other)} → ${esc(l.from)}`];
  if (l.control === 'zone') {
    // The sash: its type, hinge and the angle it opens to; a note when it cannot give what is asked.
    const s = sashOf(l.name), now = airflow.conditions.open[l.name], need = sashFor(l, l.openFactor);
    const types = Object.entries(SASH_TYPES).map(([k, t]) => `<option value="${k}"${k === s.type ? ' selected' : ''}>${t.label}</option>`).join('');
    lines.push(`Sash <select data-act="sash" data-name="${esc(l.name)}" title="${esc(Object.values(SASH_TYPES).map((t) => `${t.label}: ${t.help}, up to ${t.maxAngle}°`).join('. '))}">${types}</select>`
      + (s.type === 'casement' ? ` <button class="quiet" data-act="hinge" data-name="${esc(l.name)}">hinged ${s.hinge}</button>` : ''));
    lines.push(`Opening <input type="range" data-act="amount" data-name="${esc(l.name)}" min="0" max="100" step="1" value="${Math.round(100 * (now > 0 ? sashFor(l, now).angle / maxAngleOf(l) : amountOf(l)))}" title="How far the sash opens, as a share of its travel (100% = ${maxAngleOf(l)}°, the mechanism's limit)"> <output data-for="${esc(l.name)}">${esc(amountText(l))}</output>`);
    if (!need.reachable) {
      lines.push(`<span class="warning-text">At its ${SASH_TYPES[s.type].maxAngle}° limit this sash frees ${fmt(100 * need.maxFraction, 0)}% of the opening, not the ${fmt(100 * l.openFactor, 0)}% the model asks for; the airflow uses ${fmt(100 * need.maxFraction, 0)}%.</span>`);
    }
  }
  if (l.control === 'zone' || l.door) {
    const open = airflow.conditions.open[l.name] > 0, what = l.door ? 'door' : 'window';
    if (l.door) lines.push(open ? 'Open' : `Closed: leaks like a 1 cm gap under it`);
    lines.push(`<button class="quiet" data-act="window" data-name="${esc(l.name)}" data-open="${open ? 0 : 1}">${open ? 'Close' : 'Open'} this ${what}</button>`);
  }
  return lines;
}

// What a window's opening amount gives now: its angle, the free share of the opening, and the opening
// factor EnergyPlus gets; or closed.
function amountText(l) {
  const now = airflow.conditions.open[l.name];
  if (!(now > 0)) return 'closed';
  const angle = sashFor(l, now).angle;
  return `${fmt((100 * angle) / maxAngleOf(l), 0)}% of its travel: ${fmt(angle, 0)}°, ${fmt(100 * now, 0)}% free (EnergyPlus opening factor ${fmt(now, 2)})`;
}

// ---------- a massing's windows in its pop-ups (the facade-windows skill) ----------
// The face a selected wall or window of a massing is on: its zone, face, the window's place and how
// many the array makes. null for anything else.
function massingSide(kind, item) {
  if (!massing) return null;
  let at;
  if (kind === 'window') { const w = massingWindow(massing, item.name); at = w && { zone: w.zone, face: w.face, index: w.index }; }
  else if (kind === 'surface') { const t = massingTarget({ kind, item }); at = t && Number.isInteger(t.face) ? { zone: t.zone, face: t.face } : null; }
  if (!at) return null;
  const g = massing.zones[at.zone].faces[at.face];
  return { ...at, n: g ? unitLayout(g, faceLength(massing, at.zone, at.face)).n : 0 };
}
// A massing's zone deleted (Delete, or its pop-up); its levels stay.
function removeZone(i) {
  if (!massing || massing.zones.length < 2) { popMessage('The last zone stays: a massing needs one.'); return; }
  view.select(null);
  massingChange((x) => deleteZone(x, i), 'zone deleted');
}
// Zones left floating (held up by nothing) are hatched grey in the view.
function markFloating() { view.setFloating(massing ? floatingZones(massing).map((i) => zoneName(massing, i)) : []); }
// A massing's zone stands on a base level and reaches a top level: pushing its roof or floor moves
// those levels, and so every zone on them.
function zoneLevelRows(item) {
  const i = massing ? massingGeometry(massing).findIndex((z) => z.name === item.name) : -1;
  if (i < 0) return [];
  const z = massing.zones[i], opts = (now, from, to) => massing.levels.map((lv, L) => (L >= from && L <= to ? `<option value="${L}"${L === now ? ' selected' : ''}>${esc(lv.name || levelName(L))}</option>` : '')).join('');
  return [`<div class="poprow"><span class="tipped" title="The level this zone stands on and the level its roof reaches. Its roof and floor handles move these levels, and with them every zone on them.">Levels</span>`
    + `<select class="popsel" data-zlevel="base" data-zone="${i}" title="Base level">${opts(z.base, 0, z.top - 1)}</select> to <select class="popsel" data-zlevel="top" data-zone="${i}" title="Top level">${opts(z.top, z.base + 1, massing.levels.length - 1)}</select>`
    + (massing.zones.length > 1 ? `<button type="button" class="quiet" data-zdelete="${i}" title="Delete this zone (Delete). Its levels stay, empty or not; a storey is taken out from its level's pop-up (click the level's marker). A zone left held up by nothing is hatched grey.">Delete zone</button>` : '') + '</div>'];
}
$('info').addEventListener('click', (e) => { const b = e.target.closest('[data-zdelete]'); if (b && massing) removeZone(Number(b.dataset.zdelete)); });
$('info').addEventListener('change', (e) => {
  const el = e.target.closest('[data-zlevel]');
  if (!el || !massing) return;
  const i = Number(el.dataset.zone), key = el.dataset.zlevel, L = Number(el.value);
  massingChange((x) => { x.zones[i][key] = L; }, `zone ${i + 1} ${key} level set to ${massing.levels[L].name}`);
});
// A face named for the way it looks: 'South face', 'North-east face'.
const COMPASS_WORD = { N: 'North', NE: 'North-east', E: 'East', SE: 'South-east', S: 'South', SW: 'South-west', W: 'West', NW: 'North-west' };
const faceWord = (at) => `${COMPASS_WORD[compassWord(faceBearing(massing, at.zone, at.face))]} face`;
let sideMore = false, applyAsk = false; // More ▸ open; Apply to array asking about the others broken out
function sideRows(at, isolated = false) {
  const z = massing.zones[at.zone], g = z.faces[at.face], rows = [], k = at.index;
  const seg = (act, opts, now, tip) => `<span class="seg mini" title="${esc(tip)}">${opts.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${v === now}">${l}</button>`).join('')}</span>`;
  const chk = (act, on, text, tip) => `<label class="chk" title="${esc(tip)}"><input type="checkbox" data-act="${act}"${on ? ' checked' : ''}> ${text}</label>`;
  rows.push(popSec(`${faceWord(at)} · windows`, 'The window array on this face of the zone: set out along it by number or spacing, every window of it the same type unless broken out'));
  if (!g) {
    rows.push(`<div class="poprow"><button type="button" class="pbtn" data-act="sw-one" title="A 1.5 × 1.8 m window, sill 900 mm, in the middle of the side (lower if the wall is short). Make it an array from its pop-up.">One window</button>`
      + `<select class="popsel" data-act="sw-preset" title="Punched windows: 1.5 × 1.8 m at 3 m spacing. Window wall: glass from the floor to the slab, bay to bay, at 1.5 m spacing. Curtain wall: the same, flush."><option value="" selected hidden>From preset…</option>${Object.entries(PRESETS).map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('')}</select></div>`);
    return rows;
  }
  if (isolated && k !== undefined) rows.push(`<div class="poprow"><span class="tipped" title="How this window type's edges hold as the zone's height or the window's bay changes. Fixed: its own width and height, the sill above the floor. Offsets: the sill above the floor, the head a set distance under the slab, each jamb a set distance in from its bay - a window wall is Offsets of 0. Proportional: each edge a share of the wall's height and of the bay. Switching never moves the glass.">Size</span> ${seg('sw-size', SIZES, unitOf(g, k).size || 'fixed', 'How the edges hold')}</div>`);
  rows.push(`<div class="poprow">${chk('sw-array', isArray(g), 'Array', 'On: the window repeats along the side at a spacing that leaves wall between. Off: one window, in the middle.')}`
    + (isArray(g) ? seg('sw-by', [['spacing', 'Spacing'], ['number', 'Number']], g.winBy === 'spacing' ? 'spacing' : 'number', 'Spacing keeps the pitch as the side changes length; Number keeps the count. Switching keeps the layout as it is.') : '') + '</div>');
  rows.push(`<div class="poprow"><span class="tipped" title="Where the array stands on the face: its length is set by the grips at the ends of its bracket in the view (or typed there). Justified left, centre or right, it keeps that end, or its middle, where it is as the face changes length.">Justify</span> ${seg('sw-just', JUSTS, g.just || 'centre', 'The edge of the face the array keeps to')}`
    + (g.len > 0 ? '<button type="button" class="pbtn" data-act="sw-full" title="The array set out along the whole face again">Full face</button>' : '') + '</div>');
  rows.push(`<div class="poprow">${chk('sw-sides', z.linkFaces, 'Apply to all faces', 'On: the zone\'s other faces take these windows and follow every later change to them. Off: each face keeps its own.')}`
    + chk('sw-above', z.linkAbove, 'Apply to zones above', 'On: the zones stacked above take these windows on their face looking the same way, and follow every later change to them.') + '</div>');
  rows.push(`<button type="button" class="pbtn more" data-act="sw-more" aria-expanded="${sideMore}">${sideMore ? 'More ▴' : 'More ▸'}</button>`);
  if (sideMore) {
    const broken = brokenOf(g), others = broken.filter((j) => j !== k);
    if (k !== undefined && isArray(g)) {
      if (g.broken?.[k]) {
        rows.push(`<b>Window ${k + 1} · broken from array</b>`);
        if (applyAsk && others.length) rows.push(`<div class="poprow">${others.length === 1 ? `Window ${others[0] + 1} is` : `Windows ${others.map((j) => j + 1).join(', ')} are`} broken too: <button type="button" class="pbtn" data-act="sw-apply" data-o="rebind" title="They take the array's new type too">Rebind them</button><button type="button" class="pbtn" data-act="sw-apply" data-o="keep" title="They keep their own types">Keep broken</button><button type="button" class="quiet" data-act="sw-cancel">Cancel</button></div>`);
        else rows.push(`<div class="poprow"><button type="button" class="pbtn" data-act="sw-revert" title="It drops its own type and follows the array again">Revert to array</button><button type="button" class="pbtn" data-act="sw-apply" title="The array lays this window's type from now on">Apply to array</button></div>`);
      } else {
        rows.push(`<div class="poprow"><button type="button" class="pbtn" data-act="sw-break" title="This window takes a copy of the array's type as its own, so its edits are its own. It keeps its place in the array.">Break window ${k + 1} from array</button></div>`);
        if (others.length) rows.push(`<div class="poprow">${others.length === 1 ? `Window ${others[0] + 1} is` : `Windows ${others.map((j) => j + 1).join(', ')} are`} broken. <button type="button" class="pbtn" data-act="sw-rebind-all" title="Every broken window of the side follows the array again">Rebind all</button></div>`);
      }
    } else if (broken.length) rows.push(`<div class="poprow">${broken.length === 1 ? `Window ${broken[0] + 1} is` : `Windows ${broken.map((j) => j + 1).join(', ')} are`} broken. <button type="button" class="pbtn" data-act="sw-rebind-all" title="Every broken window of the side follows the array again">Rebind all</button></div>`);
    rows.push('<button type="button" class="quiet" data-act="sw-remove" title="Take the windows off this side (Delete)">Remove windows</button>');
  }
  return rows;
}
// An edit to a selected face's windows, carried to the faces and zones linked to it.
function sideEdit(at, fn, what) {
  const word = faceWord(at);
  return massingChange((x) => { fn(x, x.zones[at.zone].faces[at.face]); spreadSide(x, at.zone, at.face); }, `${word}: ${what}`);
}
function sideAction(el) {
  const found = current(), at = found && massingSide(found.kind, found.item);
  if (!at) return;
  const act = el.dataset.act, i = at.zone, f = at.face, k = at.index;
  if (act !== 'sw-apply' && act !== 'sw-cancel') applyAsk = false;
  if (act === 'sw-more') { sideMore = !sideMore; showInfo(found); }
  else if (act === 'sw-one' || (act === 'sw-preset' && el.value)) {
    if (!sideEdit(at, (x) => addWindows(x, i, f, act === 'sw-one' ? null : el.value), act === 'sw-one' ? 'a window added' : `${PRESETS[el.value].label.toLowerCase()} added`)) return;
    // the window added (the first of a preset's) is selected
    const w = massingGeometry(massing)[i]?.windows.find((x) => x.face === f);
    if (w && model.windows[w.name]) view.select(w.name);
  }
  else if (act === 'sw-size') sideEdit(at, (x) => setWindowSize(x, i, f, k, el.dataset.v), `windows sized ${el.dataset.v}`);
  else if (act === 'sw-array') sideEdit(at, (x, g) => setArray(g, el.checked), el.checked ? 'an array' : 'one window');
  else if (act === 'sw-by') sideEdit(at, (x) => setBy(x, i, f, el.dataset.v), `set out by ${el.dataset.v}`);
  else if (act === 'sw-just') sideEdit(at, (x) => setJustify(x, i, f, el.dataset.v), `windows justified ${el.dataset.v}`);
  else if (act === 'sw-full') sideEdit(at, (x, g) => { delete g.len; delete g.off; }, 'windows along the whole face');
  else if (act === 'sw-sides') sideEdit(at, (x) => { x.zones[i].linkFaces = el.checked; }, el.checked ? 'applied to all faces' : 'faces kept apart');
  else if (act === 'sw-above') sideEdit(at, (x) => { x.zones[i].linkAbove = el.checked; }, el.checked ? 'applied to the zones above' : 'zones above kept apart');
  else if (act === 'sw-break') sideEdit(at, (x, g) => breakWindow(g, k), `window ${k + 1} broken from its array`);
  else if (act === 'sw-revert') sideEdit(at, (x, g) => revertWindow(g, k), `window ${k + 1} back in its array`);
  else if (act === 'sw-apply') {
    const others = brokenOf(massing.zones[i].faces[f]).filter((j) => j !== k);
    if (others.length && !el.dataset.o) { applyAsk = true; showInfo(found); return; }
    applyAsk = false;
    sideEdit(at, (x, g) => applyToArray(g, k, el.dataset.o || 'keep'), `window ${k + 1}'s type given to the array`);
  } else if (act === 'sw-cancel') { applyAsk = false; showInfo(found); }
  else if (act === 'sw-rebind-all') sideEdit(at, (x, g) => { g.broken = {}; }, 'broken windows back in the array');
  else if (act === 'sw-remove') sideEdit(at, (x) => { x.zones[i].faces[f] = null; }, 'windows removed');
}
$('info').addEventListener('click', (e) => { const b = e.target.closest('button[data-act^="sw-"]'); if (b && massing) sideAction(b); });
$('info').addEventListener('change', (e) => { const el = e.target.closest('[data-act^="sw-"]'); if (el && massing) sideAction(el); });

// A button to open or close all the operable windows on one wall.
function wallButton(surface) {
  const own = net.links.filter((l) => l.control === 'zone' && surface.windows.includes(l.name));
  if (!airflow || !own.length) return [];
  const anyOpen = own.some((l) => airflow.conditions.open[l.name] > 0);
  return [`<button class="quiet" data-act="wall" data-surface="${esc(surface.name)}" data-open="${anyOpen ? 0 : 1}">${anyOpen ? 'Close' : 'Open'} the windows on this wall</button>`];
}
// A button to open or close all of a room's operable windows.
function roomButton(zone) {
  const own = net.links.filter((l) => l.control === 'zone' && l.from === zone);
  if (!airflow || !own.length) return [];
  const anyOpen = own.some((l) => airflow.conditions.open[l.name] > 0);
  return [`<button class="quiet" data-act="room" data-zone="${esc(zone)}" data-open="${anyOpen ? 0 : 1}">${anyOpen ? 'Close' : 'Open'} the windows of ${esc(zone)}</button>`];
}

function legend() {
  const chip = (color, label, title = '') => `<span${title ? ` title="${esc(title)}"` : ''}><i style="background:${color}"></i>${esc(label)}</span>`;
  const items = [];
  const ramp = (colors, w = 36) => `<i style="background:linear-gradient(90deg,${colors.map((c) => '#' + c.getHexString()).join(',')});width:${w}px"></i>`;
  if ($('color-by').value === 'pressure') {
    items.push(`<span title="Pressure difference across each surface in the hour solved, inside minus outside at the surface's height. Blue: outside pressure is higher, so air is pushed into the room through any opening or leak; red: pushed out. Square-root scale, so small differences still show.">${ramp([pressureColor(-pressureRange, pressureRange), pressureColor(0, pressureRange), pressureColor(pressureRange, pressureRange)], 48)}Pushed in ${pressureRange} Pa … pushed out ${pressureRange} Pa</span>`);
    items.push(chip(NO_PRESSURE, 'No airflow across it', 'Surfaces on the ground or between parts of the same zone carry no flow in the network.'));
  } else if ($('color-by').value === 'co2') {
    if (airflow) {
      const [lo, mid, hi] = CO2_SCALE;
      items.push(`<span title="${esc(CO2_HELP)} Each zone's surfaces take its colour.">${ramp([co2Color(lo), co2Color(mid), co2Color(hi)], 48)}CO₂ ${lo} … ${mid} … ${hi}+ ppm</span>`);
    } else items.push('<span class="muted">CO₂ needs the airflow on</span>');
  } else if ($('color-by').value === 'people') {
    const top = peopleTop();
    items.push(`<span title="People per square metre of floor in each zone this hour: its peak density times its occupancy schedule's fraction now. Pale: nobody there.">${ramp([peopleColor(0, top), peopleColor(top / 2, top), peopleColor(top, top)], 48)}Occupancy 0 … ${fmt(top, 2)} people/m² this hour</span>`);
  } else if ($('color-by').value === 'zone') {
    Object.keys(model.zones).forEach((z, i) => items.push(chip(`#${zoneColor(i).getHexString()}`, z)));
  } else if ($('color-by').value !== 'white') {
    const types = new Set(Object.values(model.surfaces).map((s) => s.csType));
    for (const [t, c] of Object.entries(TYPE_COLORS)) if (types.has(t)) items.push(chip(c, t));
  }
  if (Object.keys(model.windows).length) items.push(chip($('color-by').value === 'white' ? '#C4D0D2' : TYPE_COLORS.Glazing, $('show-air').checked ? 'Glazing, closed' : 'Glazing'));
  if ($('show-air').checked && airflow) {
    const n = Object.entries(airflow.conditions.open).filter(([k, f]) => f > 0 && !k.endsWith(':door')).length;
    if (n) items.push(chip(OPEN_WINDOW, `Window open (${n})`, 'Open to its operable fraction in the airflow. Select a window or a room to open or close it.'));
  }
  if (view.doors.length) items.push(chip(TYPE_COLORS.Door, `Door, added (${view.doors.length})`, `The tool adds an open ${DOOR.width} × ${DOOR.height} m door between each room and the circulation zones it shares a wall with, and between adjoining circulation zones, so air can move through the building. Circulation is recognised by zone name (circulation, corridor, hall, lobby, stair, vestibule, foyer, atrium).`));
  if (model.shading.length) items.push(chip(TYPE_COLORS.Shading, 'Shading'));
  if (view.overlay) {
    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][dateOf(Number($('day').value)).month - 1];
    items.push(`<span title="Petal length: how often the wind blows from that direction in ${month} (rings every 5% of hours). Shading: wind speed at the weather station.">Wind rose, ${month}:</span>`);
    SPEED_BANDS.forEach((b, i) => items.push(chip(BAND_COLORS[i], b === Infinity ? `over ${SPEED_BANDS[i - 1]} m/s` : `${i ? SPEED_BANDS[i - 1] : 0}–${b} m/s`)));
    items.push(chip('#E0401F', 'This hour', 'The arrow points the way the wind blows; its length grows with speed.'));
  }
  if (sky.shown && sky.layers.dots && weather) {
    const names = ventBandLabels(ventLimits());
    items.push('<span title="Every daylit hour of the weather file, as a dot where the sun stood then, by whether the windows may open">Weather hours:</span>');
    for (const b of VENT_BANDS) items.push(chip(b.color, names[b.key][0], names[b.key][1]));
  }
  // The cuts: each field one of them is coloured by, over its range there.
  if (slices.visible && sliceRanges.co2) {
    const [lo, hi] = sliceRanges.co2;
    items.push(`<span title="Cuts: CO2 in the room air, from the grid solver (each room's mean held at its balance figure) or, with ideal flow, each room's own level. Coloured from the lowest to the highest on the cuts, so the pattern within rooms shows; the colours do not mean the same levels as Colour by CO2.">${ramp([co2Color(CO2_SCALE[0]), co2Color(CO2_SCALE[1]), co2Color(CO2_SCALE[2])], 48)}Cuts: CO₂ ${fmt(lo, 0)} … ${fmt(hi, 0)} ppm</span>`);
  }
  if (slices.visible && sliceRanges.speed) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((x) => speedColor(SPEED_RANGE[0] * (SPEED_RANGE[1] / SPEED_RANGE[0]) ** x));
    items.push(`<span title="Cuts: air speed on a log scale">${ramp(stops, 48)}Cuts: speed ${SPEED_RANGE[0]} … ${SPEED_RANGE[1]} m/s</span>`);
  }
  if (slices.visible && sliceRanges.temperature) {
    const [lo, hi] = sliceRanges.temperature;
    items.push(`<span title="Cuts: air temperature, from the lowest to the highest on the cuts coloured by it">${ramp([rampTemperature(lo, lo, hi), rampTemperature((lo + hi) / 2, lo, hi), rampTemperature(hi, lo, hi)], 48)}Cuts: ${fmt(lo, 1)} … ${fmt(hi, 1)} °C</span>`);
  }
  // Particles: the 3D ones and those in the cuts, each by its own colour setting; one entry when they agree.
  const particleKey = (mode, who) => {
    if (mode === 'speed') {
      const stops = [0, 0.25, 0.5, 0.75, 1].map((x) => speedColor(SPEED_RANGE[0] * (SPEED_RANGE[1] / SPEED_RANGE[0]) ** x));
      return `<span title="${who} colour: air speed, on a log scale (each step ten times faster)">${ramp(stops, 48)}${who}: speed ${SPEED_RANGE[0]} … ${SPEED_RANGE[1]} m/s</span>`;
    }
    if (mode === 'co2') return `<span title="${who} colour: the CO2 of the air they carry; amber from 1000 ppm, where rooms feel stuffy">${ramp(CO2_SCALE.map((c) => co2Color(c)), 48)}${who}: CO₂ ${CO2_SCALE[0]} … ${CO2_SCALE[2]}+ ppm</span>`;
    if (mode === 'none') return chip('#000000', `${who}: black`);
    return `<span title="${who} colour: the temperature of the air they carry">${ramp([temperatureColor(14), temperatureColor(22), temperatureColor(30)])}${who}: 14–30 °C</span>`;
  };
  const cutColours = [...new Set(view.sections.planes.filter((q) => q.air.particles).map((q) => q.air.color))];
  if ($('show-air').checked && cutColours.length === 1 && $('air-color').value === cutColours[0]) items.push(particleKey($('air-color').value, 'Particles'));
  else {
    if ($('show-air').checked) items.push(particleKey($('air-color').value, 'Particles'));
    for (const c of cutColours) items.push(particleKey(c, 'In the cuts'));
  }
  if (view.problems.length) items.push(chip(PROBLEM, 'Named by a model check', 'The arrow shows the way EnergyPlus takes as outward, from the order of the corner points.'));
  $('legend').innerHTML = items.join('');
}

$('color-by').addEventListener('change', (e) => { view.setColorBy(e.target.value); legend(); });
$('show-shading').addEventListener('change', (e) => view.setShadingVisible(e.target.checked));
// The thickness switch: off, the thin surfaces as modelled; on, the location line chosen.
const wallMode = () => ($('wall-thick').checked ? $('walls').value : 'thin');
$('walls').addEventListener('change', () => view.setWalls(wallMode()));
$('wall-thick').addEventListener('change', () => { $('walls').disabled = !$('wall-thick').checked; view.setWalls(wallMode()); });
// Room air from the start: the particles clear and the grid solver begins again from still air.
function restartAir() {
  if (!model) return;
  air.clear();
  startGrid(model);
  if ($('room-air').value !== 'grid') field = null;
  solveAir();
}
$('room-air').addEventListener('change', restartAir);
$('restart-air').addEventListener('click', restartAir);
$('window-depth').addEventListener('change', (e) => view.setWindowDepth(e.target.value));
view.windowDepth = $('window-depth').value;
$('fit').addEventListener('click', () => view.frame());
$('projection').addEventListener('click', (e) => {
  const mode = e.target.dataset?.proj;
  if (!mode) return;
  for (const b of $('projection').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === e.target));
  view.setProjection(mode);
});
// Full screen: the view fills the window; Esc or the button again leaves it.
function setFull(on) {
  $('view3d').classList.toggle('full', on);
  document.body.classList.toggle('hasfull', on);
  $('full').title = on ? 'Leave full screen' : 'Full screen';
  view.resize();
}
$('full').addEventListener('click', () => setFull(!$('view3d').classList.contains('full')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('view3d').classList.contains('full')) setFull(false); });
// A figure beside a slider can be typed over: a click turns it into a box; Enter or leaving the box
// sets the slider (within its range) as if dragged, Esc cancels. parse(text) gives the slider's value
// or null when the text cannot be read.
function typeable(out, slider, parse) {
  out.classList.add('typeable');
  out.title = 'Click to type a value';
  out.addEventListener('click', () => {
    if (slider.disabled || out.hidden) return;
    const box = document.createElement('input');
    box.className = 'valbox';
    box.value = out.textContent.replace(/\s*\(.*\)$/, '');
    out.hidden = true;
    out.after(box);
    box.focus();
    box.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = keep ? parse(box.value.trim()) : null;
      box.remove();
      out.hidden = false;
      if (v === null || !Number.isFinite(v)) return;
      slider.value = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    };
    box.addEventListener('keydown', (k) => { if (k.key === 'Enter') finish(true); if (k.key === 'Escape') finish(false); });
    box.addEventListener('blur', () => finish(true));
  });
}
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS_BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
// A date as "15 Jul", "Jul 15", "15/7" (day/month) or a day of the year.
function parseDay(t) {
  const s = t.toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  let m = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (m) return DAYS_BEFORE[Number(m[2]) - 1] + Number(m[1]);
  m = s.match(/^(\d{1,2})\s*([a-z]{3})/) || s.match(/^([a-z]{3})[a-z]*\s*(\d{1,2})/);
  if (!m) return null;
  const [day, mon] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  const i = MONTH_NAMES.indexOf(mon.slice(0, 3));
  return i < 0 ? null : DAYS_BEFORE[i] + Number(day);
}
// An hour as "14", "14:00" or "14:00-15:00": the hour starting then, standard time (the slider holds
// the hour ending).
const parseHour = (t) => { const m = t.match(/^(\d{1,2})/); return m ? Number(m[1]) + 1 : null; };
const parseTimes = (t) => { const m = t.replace(',', '.').match(/[\d.]+/); return m ? Number(m[0]) : null; };
typeable($('day-value'), $('day'), parseDay);
typeable($('when'), $('hour'), parseHour);
typeable($('air-density-value'), $('air-density'), (t) => { const k = parseTimes(t); return k > 0 ? Math.log2(k) : null; });
typeable($('air-speed-value'), $('air-speed'), parseTimes);

// A figure set by dragging its name left or right, as at the foot of the Solar Shading Explorer's views:
// `per` of a unit for each pixel moved, kept within min and max (or wrapped round `wrap`); its value
// typed after a click. The input it drives stays in the page (hidden for numbers) and gets an input
// event as if edited, so everything reading it works as before. A disabled input shows faded.
function scrubbable(name, input, { per = 1, digits = 0, min = -Infinity, max = Infinity, wrap = 0, show = null } = {}) {
  const clamp = (v) => (wrap ? ((v % wrap) + wrap) % wrap : Math.min(max, Math.max(min, v)));
  const set = (v) => {
    const f = 10 ** digits;
    input.value = clamp(Math.round(v * f) / f);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  name.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || input.disabled) return;
    e.preventDefault();
    const x0 = e.clientX, v0 = Number(input.value);
    document.body.classList.add('scrubbing');
    const move = (m) => set(v0 + (m.clientX - x0) * per);
    const up = () => { document.body.classList.remove('scrubbing'); window.removeEventListener('pointermove', move); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
  if (show) {
    // The figure follows the input, whoever sets it (the weather file sets the outdoor conditions).
    const own = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const refresh = () => { show.textContent = Number(input.value).toFixed(digits); show.parentElement.classList.toggle('off', input.disabled); };
    Object.defineProperty(input, 'value', { get() { return own.get.call(this); }, set(v) { own.set.call(this, v); refresh(); } });
    const ownDisabled = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'disabled') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'disabled');
    Object.defineProperty(input, 'disabled', { get() { return ownDisabled.get.call(this); }, set(v) { ownDisabled.set.call(this, v); refresh(); } });
    refresh();
    show.title = 'Click to type a value';
    show.addEventListener('click', () => {
      if (input.disabled) return;
      const box = document.createElement('input');
      box.className = 'valbox';
      box.value = show.textContent;
      show.hidden = true;
      show.after(box);
      box.focus();
      box.select();
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        const v = Number(box.value.replace(',', '.').trim());
        box.remove();
        show.hidden = false;
        if (keep && box.value.trim() && Number.isFinite(v)) set(v);
      };
      box.addEventListener('keydown', (k) => { if (k.key === 'Enter') finish(true); if (k.key === 'Escape') finish(false); });
      box.addEventListener('blur', () => finish(true));
    });
  }
}
for (const el of document.querySelectorAll('.barval[data-for]')) {
  const d = el.dataset;
  scrubbable(el.querySelector('.scrub'), $(d.for), { per: Number(d.per), digits: Number(d.digits), min: d.min ? Number(d.min) : -Infinity, max: d.max ? Number(d.max) : Infinity, wrap: Number(d.wrap || 0), show: el.querySelector('.val') });
}
// The sliders' names drag them too: a day or an hour for every 4 px.
for (const [id, per] of [['day', 0.25], ['hour', 0.25]]) scrubbable($(id).previousElementSibling, $(id), { per, min: Number($(id).min), max: Number($(id).max) });

// Play day: the hour steps on from From to To, each held for a few seconds while its air moves. The
// weather, room temperatures, windows and CO2 follow each hour as if picked by hand; the grid solver
// carries its air on from hour to hour (setConditions keeps the flow). Changing the date or time by
// hand pauses it.
let playTimer = 0, stepping = false, gridAirTime = 0;
// The air's own clock (s): the grid solver's simulated time, or with ideal flow (which has no time of
// its own) the real time. Play day paces its hours by it, so every hour gets the same air time
// whatever the computer's speed, and the plumes an hour shows do not depend on how long it is watched.
const airSource = () => ($('room-air').value === 'grid' && gridLive ? 'air' : 'real');
const airClock = () => (airSource() === 'air' ? gridAirTime : performance.now() / 1000);
const pad2 = (h) => String(h).padStart(2, '0');
function playSpan() {
  const from = Number($('play-from').value), to = Math.max(from + 1, Number($('play-to').value));
  $('play-span').textContent = `${pad2(from)}:00–${pad2(to)}:00`;
  return [from, to];
}
function setPlaying(on) {
  clearInterval(playTimer);
  playTimer = 0;
  if (bakedPlay) stopBaked();
  $('play').classList.toggle('on', on);
  $('play').textContent = on ? '❚❚ Pause' : bakeReady() ? '▶ Play baked' : '▶ Play day';
  if (!on) { applyHour(); return; } // the label back to the whole hour
  if (bakeReady()) { playBaked(); return; }
  const [from, to] = playSpan(), start = Number($('hour').value) - 1; // the hour's start, standard time
  if (start < from || start >= to) setHour(from); // start from the beginning unless already within
  let began = airClock(), source = airSource();
  // Each tenth of a second: the clock shows the minutes of the hour as its air time passes; when the
  // hour's air time is up, the next hour.
  playTimer = setInterval(() => {
    if (airSource() !== source) { source = airSource(); began = airClock(); } // the grid started or stopped: count afresh
    const per = Number($('play-hold').value), done = (airClock() - began) / per;
    if (done < 1) { showMinutes(Math.floor(done * 60)); return; }
    const [f, t] = playSpan(), now = Number($('hour').value) - 1;
    if (now + 1 < t) setHour(now + 1);
    else if ($('play-loop').checked) setHour(f);
    else { setPlaying(false); return; }
    began = airClock();
    showMinutes(0);
  }, 100);
}
// ---------- window keyframes ----------
// The windows and doors kept at an hour (◆ Keyframe): the Windows, Doors and Sashes settings and every
// window or room set one by one. From each keyframe's hour until the next they hold, as the day plays,
// as it is baked and as the hour is moved; before the first, the first holds. Editing windows between
// keyframes changes only what is shown until the hour moves, unless it is kept as a keyframe.
let keyframes = [], kfHour = null;
function windowState() {
  return { windows: $('windows').value, doors: $('doors').value, sash: $('sash-type').value,
    windowSet: [...windowSet], roomSet: [...roomSet], sashSet: [...sashSet].map(([k, v]) => [k, { ...v }]), amountSet: [...amountSet] };
}
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keyframeAt(hour) {
  if (!keyframes.length) return null;
  return [...keyframes].reverse().find((k) => k.hour <= hour) || keyframes[0];
}
// Puts the windows as a keyframe has them, when the hour has moved to another keyframe's span.
function followKeyframes(hour) {
  const k = keyframeAt(hour);
  if (!k || kfHour === k.hour) return;
  kfHour = k.hour;
  const s = k.state;
  $('windows').value = s.windows; $('doors').value = s.doors; $('sash-type').value = s.sash;
  windowSet.clear(); roomSet.clear(); sashSet.clear(); amountSet.clear();
  for (const [n, v] of s.windowSet) windowSet.set(n, v);
  for (const [n, v] of s.roomSet) roomSet.set(n, v);
  for (const [n, v] of s.sashSet) sashSet.set(n, { ...v });
  for (const [n, v] of s.amountSet) amountSet.set(n, v);
}
function saveKeyframe() {
  const hour = Number($('hour').value) - 1, state = windowState();
  keyframes = keyframes.filter((k) => k.hour !== hour).concat({ hour, state }).sort((a, b) => a.hour - b.hour);
  kfHour = hour;
  showKeyframes();
}
// What a keyframe holds, in a few words.
function keyframeWords(s) {
  const mode = { open: 'all open', closed: 'all closed', results: 'as in results' }[s.windows] || s.windows;
  const own = s.windowSet.filter(([n]) => !n.endsWith(':door')).length + s.roomSet.length, doors = s.windowSet.filter(([n]) => n.endsWith(':door')).length;
  return [`windows ${mode}`, s.sash !== 'casement' ? s.sash : null, own ? `${own} set one by one` : null, s.amountSet.length ? `${s.amountSet.length} opening${s.amountSet.length === 1 ? '' : 's'} set` : null,
    `doors ${s.doors}${doors ? `, ${doors} set` : ''}`].filter(Boolean).join(', ');
}
function showKeyframes() {
  const hour = Number($('hour').value) - 1, now = keyframeAt(hour), changed = now && !sameState(now.state, windowState());
  $('keyframes').innerHTML = keyframes.length ? keyframes.map((k) => `<div class="kfrow${k === now ? ' on' : ''}"><button type="button" class="linkbtn" data-kf="go" data-h="${k.hour}" title="Go to ${pad2(k.hour)}:00">${pad2(k.hour)}:00</button>`
    + `<span class="muted">${esc(keyframeWords(k.state))}</span><button type="button" class="pbtnx" data-kf="del" data-h="${k.hour}" title="Remove this keyframe">×</button></div>`).join('')
    : '<span class="muted">None: set the windows, then ◆ Keyframe.</span>';
  $('keyframe').disabled = !model;
  $('keyframe').textContent = changed ? '◆ Keyframe *' : '◆ Keyframe';
  $('keyframe').title = (changed ? `The windows differ from the keyframe at ${pad2(now.hour)}:00: keep them as a keyframe at ${pad2(hour)}:00. ` : '') + 'Keep the windows and doors as they are now as a keyframe at this hour. From then on, as the day plays (and in bakes) they change at each keyframe and hold until the next. The keyframes are listed in the Play day menu.';
}
$('keyframe').addEventListener('click', saveKeyframe);
$('keyframes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kf]');
  if (!b) return;
  const h = Number(b.dataset.h);
  if (b.dataset.kf === 'del') { keyframes = keyframes.filter((k) => k.hour !== h); kfHour = null; showKeyframes(); return; }
  const el = $('hour'); el.value = h + 1; el.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---------- Play day, baked ----------
// A day worked out before it is played, so it plays smoothly at any speed: each hour's network, and
// its room air, either ideal flow (seconds) or the grid solver run for each hour's air time in a
// worker of its own (minutes). Playing blends each hour's fields into the next as its clock runs; the
// particles move through the blend and the cuts are drawn from it, so clipping planes still cut it
// live. A bake holds while the model, the day, the hours and the window settings are as they were.
let bake = null, baking = null, bakedPlay = null, edits = 0;
function bakeKey(kind) {
  return JSON.stringify([kind, edits, model?.source.fileName, results?.name || null, weather?.fileName || null, $('day').value, playSpan(),
    ...(keyframes.length ? [] : [$('windows').value, $('doors').value, $('sash-type').value, [...windowSet], [...roomSet], [...sashSet], [...amountSet]]),
    weather ? null : [$('t-out').value, $('t-in').value, $('wind').value, $('wind-dir').value], kind === 'grid' ? $('play-hold').value : null, keyframes]);
}
const bakeReady = () => !!bake && bake.key === bakeKey(bake.kind);
function bakeStatus(text) {
  if (text === undefined) {
    const day = dateOf(Number($('day').value)).label, [f, t] = bake?.span || [];
    text = !bake ? '' : bakeReady() ? `Baked: ${bake.kind === 'grid' ? 'simulated' : 'ideal flow'}, ${day} ${pad2(f)}:00–${pad2(t)}:00. Play day plays it.`
      : 'The bake no longer matches the settings: bake again, or Play day plays live.';
    if (!baking && !$('play').classList.contains('on')) $('play').textContent = bakeReady() ? '▶ Play baked' : '▶ Play day';
  }
  $('bake-status').textContent = text;
  $('bake-quick').textContent = baking?.kind === 'ideal' ? 'Cancel' : 'Ideal flow';
  $('bake-full').textContent = baking?.kind === 'grid' ? 'Cancel' : 'Simulated';
  $('bake-quick').disabled = !model || (baking && baking.kind !== 'ideal');
  $('bake-full').disabled = !model || (baking && baking.kind !== 'grid');
}

async function bakeDay(kind) {
  if (baking) { baking.cancel(); return; }
  if (!model || !rooms) return;
  setPlaying(false);
  const [from, to] = playSpan(), keep = Number($('hour').value) - 1, frames = [];
  const job = baking = { kind, cancelled: false, cancel() { this.cancelled = true; this.stop?.(); } };
  if (kind === 'grid') worker?.postMessage({ type: 'stop' }); // the live room air rests meanwhile
  bakeStatus('Baking: the network, hour by hour…');
  let prev = null;
  for (let h = from; h < to && !job.cancelled; h++) {
    setHour(h); // the hour's weather, temperatures and network, as Play day steps it
    const a = airflow, co2 = co2History(a.hourAt, a.solution, a.site, a.outdoor);
    const f = { hour: h, conditions: a.conditions, flows: a.flows, co2 };
    if (kind === 'ideal') { prev = roomFlow(rooms, a.flows, { previous: prev, open: a.conditions.open, sashes: a.conditions.sashes }); f.field = prev; }
    else f.co2msg = co2Message(a.hourAt, co2, a.site);
    frames.push(f);
    bakeStatus(`Baking: hour ${h - from + 1} of ${to - from}${kind === 'grid' ? ', network' : ''}…`);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (kind === 'grid' && !job.cancelled) {
    const w = new Worker(new URL('./grid-worker.js', import.meta.url), { type: 'module' }), t0 = performance.now();
    await new Promise((resolve) => {
      job.stop = () => { w.terminate(); resolve(); };
      w.onmessage = ({ data }) => {
        if (data.type === 'baked') {
          Object.assign(frames[data.i], { FV: data.FV, T: data.T, C: data.C });
          const left = ((performance.now() - t0) / (data.i + 1)) * (frames.length - data.i - 1) / 1000;
          bakeStatus(`Baking the room air: hour ${data.i + 1} of ${frames.length} done, about ${Math.ceil(left / 60)} min left…`);
        } else if (data.type === 'bake-done') { w.terminate(); resolve(); }
      };
      w.postMessage({ type: 'model', epjson: model.epjson });
      w.postMessage({ type: 'bake', air: Number($('play-hold').value), hours: frames.map((f) => ({ conditions: f.conditions, hour: hourIndex(Number($('day').value), f.hour + 1), co2: f.co2msg })) });
    });
  }
  baking = null;
  if (!job.cancelled) {
    bake = { kind, span: [from, to], frames, key: null };
    if (kind === 'grid') { bake.grid = new GridFlow(rooms, model); bake.grid.setCO2(frames[0].co2msg); }
  }
  setHour(keep); // back to the hour shown before, with the live room air
  if (bake && !job.cancelled) bake.key = bakeKey(kind);
  bakeStatus(job.cancelled ? 'Bake cancelled.' : undefined);
}
$('bake-quick').addEventListener('click', () => bakeDay('ideal'));
$('bake-full').addEventListener('click', () => bakeDay('grid'));

// Plays the bake: each hour blends into the next over the seconds it is given; the last is held.
function playBaked() {
  const B = bake, n = B.frames.length, now = Number($('hour').value) - 1;
  worker?.postMessage({ type: 'stop' });
  const P = bakedPlay = { kind: B.kind, t: Math.max(0, Math.min(n - 1, now - B.span[0])), k: -1 };
  if (B.kind === 'grid') P.grid = B.grid;
  else {
    const f0 = B.frames[0].field;
    P.live = { phi: Float64Array.from(f0.phi), velocity: Float32Array.from(f0.velocity), out: new Map(f0.out), entries: f0.entries };
  }
  let last = performance.now();
  const frame = (time) => {
    if (bakedPlay !== P) return;
    P.t += Math.max(0, Math.min(0.1, (time - last) / 1000)) / Math.max(0.1, Number($('play-sec').value) || 4); // a frame's time can come before playing began
    last = time;
    if (P.t >= n) {
      if (!$('play-loop').checked) { setPlaying(false); return; }
      P.t = 0;
    }
    const k = Math.min(n - 1, Math.floor(P.t)), f = P.t - k;
    if (k !== P.k) enterBakedHour(P, k);
    blendBaked(P, k, k < n - 1 ? f : 0);
    showMinutes(Math.floor(f * 60));
    drawSlices();
    P.raf = requestAnimationFrame(frame);
  };
  P.raf = requestAnimationFrame(frame);
}
// An hour of the bake begins: its network drawn (open windows, pressures) and the particles' sources.
function enterBakedHour(P, k) {
  const B = bake, F = B.frames[k], G = B.frames[Math.min(k + 1, B.frames.length - 1)];
  P.k = k;
  setHour(F.hour);
  airflow.co2 = F.co2;
  view.setCO2(F.co2);
  const zones = rooms.g.zones;
  P.za = zones.map((z) => F.conditions.zones[z].t);
  P.zb = zones.map((z) => G.conditions.zones[z].t);
  P.oa = F.conditions.outdoor.t; P.ob = G.conditions.outdoor.t;
  if (P.grid) {
    P.grid.setConditions(F.flows, F.conditions, { copy: true });
    if (F.co2msg) P.grid.setCO2(F.co2msg);
    air.setField(P.grid, F.conditions);
  } else {
    P.live.entries = F.field.entries;
    P.keys = [...new Set([...F.field.out.keys(), ...G.field.out.keys()])];
    P.live.out = new Map(P.keys.map((key) => [key, 0]));
    air.setField(P.live, F.conditions);
  }
  P.zoneT = P.za.slice();
}
// The fields between two hours, f of the way from the first to the second.
function blendBaked(P, k, f) {
  const B = bake, A = B.frames[k], Z = B.frames[Math.min(k + 1, B.frames.length - 1)], g = 1 - f;
  const mix = (out, a, b) => { for (let i = 0; i < out.length; i++) out[i] = a[i] * g + b[i] * f; };
  if (P.grid) {
    mix(P.grid.FV, A.FV, Z.FV);
    mix(P.grid.T, A.T, Z.T);
    if (A.C && Z.C && P.grid.C) mix(P.grid.C, A.C, Z.C);
  } else {
    mix(P.live.phi, A.field.phi, Z.field.phi);
    mix(P.live.velocity, A.field.velocity, Z.field.velocity);
    for (const key of P.keys) P.live.out.set(key, (A.field.out.get(key) || 0) * g + (Z.field.out.get(key) || 0) * f);
  }
  for (let i = 0; i < P.zoneT.length; i++) P.zoneT[i] = P.za[i] * g + P.zb[i] * f;
  air.tracer.zoneT = P.zoneT;
  air.tracer.outdoorT = P.oa * g + P.ob * f;
}
function stopBaked() {
  if (!bakedPlay) return;
  cancelAnimationFrame(bakedPlay.raf);
  bakedPlay = null;
  air.clear();
  solveAir(); // the live room air again
  if ($('room-air').value === 'grid' && grid && airflow) air.setField(grid, airflow.conditions);
}

// The time label with minutes, while the day plays: standard time, and the clock's on daylight-saving days.
function showMinutes(minute) {
  const day = Number($('day').value), start = Number($('hour').value) - 1;
  const dst = model && daylightSavingDays(model.epjson);
  const t = (h) => `${pad2(h % 24)}:${pad2(minute)}`;
  $('when').textContent = t(start) + (dst && day - 1 >= dst[0] && day - 1 <= dst[1] ? ` (${t(start + 1)} daylight time)` : '');
}
// Moves to the hour starting at h (0 to 23), as the Time slider would.
function setHour(h) {
  stepping = true;
  $('hour').value = h + 1;
  $('hour').dispatchEvent(new Event('input', { bubbles: true }));
  stepping = false;
}
$('play').addEventListener('click', () => setPlaying(!playTimer && !$('play').classList.contains('on')));
for (const id of ['day', 'hour']) $(id).addEventListener('input', () => { if (!stepping && $('play').classList.contains('on')) setPlaying(false); });
for (const id of ['play-from', 'play-to']) $(id).addEventListener('input', playSpan);
playSpan();

// The settings bar folds to one line; the view takes the height left under it.
// The top menu's tabs: one panel at a time; the one last used comes back.
function ribbon(k) {
  for (const b of document.querySelectorAll('.ribtabs [data-rib]')) b.setAttribute('aria-selected', String(b.dataset.rib === k));
  for (const p of document.querySelectorAll('.calcbar .ribbon')) p.hidden = p.dataset.panel !== k;
  document.body.classList.remove('bartucked');
  try { localStorage.setItem('natvent-ribbon', k); } catch { /* not kept */ }
}
for (const b of document.querySelectorAll('.ribtabs [data-rib]')) b.addEventListener('click', () => ribbon(b.dataset.rib));
try { const k = localStorage.getItem('natvent-ribbon'); if (k && document.querySelector(`.ribtabs [data-rib="${k}"]`)) ribbon(k); } catch { /* not kept */ }
$('tuck').addEventListener('click', () => {
  const on = document.body.classList.toggle('bartucked');
  $('tuck').textContent = on ? '▾' : '▴';
  $('tuck').title = on ? 'Show all the settings' : 'Fold the settings to one line';
});
new ResizeObserver(() => document.documentElement.style.setProperty('--cbh', `${$('drop').offsetHeight}px`)).observe($('drop'));
// A menu in a view's bar closes on a click anywhere outside it.
document.addEventListener('pointerdown', (e) => {
  for (const d of document.querySelectorAll('details.dd[open]')) if (!d.contains(e.target)) d.open = false;
});

// The model's details below the view: summary, checks, zones, surfaces and constructions.
function fillDetails(m) {
  const zones = Object.values(m.zones);
  const windows = Object.values(m.windows);
  const ventilated = zones.filter((z) => z.ventilation);
  const floorArea = zones.reduce((s, z) => s + z.floorArea.value, 0);
  $('summary').innerHTML = [
    ['EnergyPlus', m.source.energyPlusVersion || '?'],
    ['Zones', zones.length],
    ['Floor area', `${fmt(floorArea, 0)} m²`],
    ['Windows', windows.length],
    ['Naturally ventilated zones', ventilated.length],
    ['Shading surfaces', m.shading.length],
    ['Timesteps per hour', m.site.timestepsPerHour ?? '?'],
  ].map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join('');

  const order = { error: 0, warning: 1, info: 2 };
  const checks = [...m.checks].sort((a, b) => order[a.level] - order[b.level]);
  // Each check links to the first surface or window it names (else its zone) in the 3D view.
  const target = (c) => c.objects.find((n) => m.surfaces[n] || m.windows[n]) || c.objects.find((n) => m.zones[n]);
  $('checks').innerHTML = checks.length
    ? checks.map((c) => `<li class="${c.level}"><span class="level">${c.level}</span> ${esc(c.message)}`
      + (target(c) ? ` <button class="object" data-name="${esc(target(c))}">Show in 3D</button>` : '') + '</li>').join('')
    : '<li class="info"><span class="level">OK</span> No problems found.</li>';

  $('zones').innerHTML = `<tr>
      <th>Zone</th><th>Floor area<br>m²</th><th>Volume<br>m³</th><th>Height<br>m</th><th>Windows</th><th>Glazing<br>m²</th>
      <th>Operable<br>fraction</th><th>Opens above<br>°C</th><th>People<br>per m²</th><th>Activity<br>W/person</th>
      <th>Lighting<br>W/m²</th><th>Equipment<br>W/m²</th><th>Infiltration<br>ach</th></tr>`
    + zones.map((z) => `<tr>
      <td>${esc(z.name)}</td>${cell(z.floorArea, 1)}${cell(z.volume, 0)}<td>${fmt(z.height, 2)}</td>
      <td>${z.windows.length}</td><td>${z.windows.length ? fmt(z.glazingArea, 1) : '–'}</td>
      ${cell(z.ventilation?.operableFraction, 2)}${cell(z.ventilation?.controls.minIndoorTemperature, 0)}
      ${cell(z.people?.density, 4)}${cell(z.people?.activityLevel, 1)}
      ${cell(z.lights?.powerDensity, 2)}${cell(z.equipment?.powerDensity, 2)}
      ${z.infiltration ? `<td title="${esc(`${z.infiltration.method}, ZoneInfiltration:DesignFlowRate "${z.infiltration.name}"`)}">${fmt(z.infiltration.airChangesPerHour, 3)}</td>` : '<td class="muted">–</td>'}
    </tr>`).join('');

  const byType = {};
  for (const s of Object.values(m.surfaces)) {
    const t = (byType[s.csType] ||= { count: 0, area: 0, constructions: new Set() });
    t.count++; t.area += s.area; t.constructions.add(s.construction.replace(/_FLIPPED$/, ''));
  }
  const glazing = windows.reduce((s, w) => s + w.area, 0);
  $('surfaces').innerHTML = '<tr><th>Type</th><th>Surfaces</th><th>Area m²</th><th>Constructions</th></tr>'
    + Object.entries(byType).sort((a, b) => b[1].area - a[1].area).map(([t, v]) =>
      `<tr><td>${esc(t)}</td><td>${v.count}</td><td>${fmt(v.area, 0)}</td><td>${esc([...v.constructions].join(', '))}</td></tr>`).join('')
    + `<tr><td>Glazing</td><td>${windows.length}</td><td>${fmt(glazing, 0)}</td><td>${esc([...new Set(windows.map((w) => w.construction))].join(', '))}</td></tr>`;

  const uses = {};
  for (const s of [...Object.values(m.surfaces), ...windows]) uses[s.construction] = (uses[s.construction] || 0) + 1;
  $('constructions').innerHTML = '<tr><th>Construction</th><th>Layers</th><th>Thickness<br>m</th><th>R<br>m²·K/W</th><th>Heat capacity<br>kJ/m²·K</th><th>U-factor<br>W/m²·K</th><th>Used by</th></tr>'
    + Object.values(m.constructions).filter((c) => !c.name.endsWith('_FLIPPED')).map((c) => `<tr>
      <td>${esc(c.name)}</td><td>${c.layers.length}</td><td>${c.thickness ? fmt(c.thickness, 3) : '<span class="muted">–</span>'}</td>
      <td>${c.R === null ? '<span class="muted">–</span>' : fmt(c.R, 2)}</td>
      <td>${c.C === null ? '<span class="muted">–</span>' : fmt(c.C / 1000, 0)}</td>
      <td>${c.uFactor === undefined ? '<span class="muted">–</span>' : fmt(c.uFactor, 3)}</td>
      <td>${(uses[c.name] || 0) + (uses[c.name + '_FLIPPED'] || 0)}</td></tr>`).join('');
}

function render(m) {
  looseViews = { views: [] };
  queueMicrotask(() => { vbar.render(); levelEdits.select(null); });
  fillDetails(m);
  winEdit.stop();
  undoStack.length = 0; redoStack.length = 0; modelEdited = false; axisCache = null; schedCache.clear();
  if (bakedPlay) stopBaked();
  if (baking) baking.cancel();
  bake = null; edits = 0;
  keyframes = []; kfHour = null;
  $('edited').hidden = true;
  $('lib-open').disabled = false;
  libOpen = null;
  renderLibrary();
  $('results').hidden = false;
  view.resize();
  view.setModel(m, { doors: interiorDoors(m), walls: wallMode() });
  hover.clear();
  net = buildNetwork(m);
  rooms = prepareRoomFlow(voxelize(m), net, m);
  field = null;
  startGrid(m);
  $('restart-air').disabled = false;
  updateRun();
  air.setGrid(rooms.g, Object.values(m.zones).reduce((s, z) => s + z.volume.value, 0));
  $('results-file').value = '';
  windowSet.clear(); roomSet.clear(); sashSet.clear(); amountSet.clear();
  const a = ((footprintAxis(m).azimuth - m.site.northAxis) * Math.PI) / 180;
  view.longAxis = Math.atan2(Math.cos(a), Math.sin(a)); // the footprint's long side, from model x
  view.cube.setNorth(-m.site.northAxis);
  sky.turned = null;
  setResults(null); // results belong to the previous model; this also solves the network
  if ($('show-air').checked) air.play();
  view.setColorBy($('color-by').value);
  view.setShadingVisible($('show-shading').checked);
  view.select(null);
  legend();
}

// ---------- editing the model ----------
// Each edit changes the .epJSON (src/model/edit.js); the model is read again from it and everything
// drawn and solved is rebuilt, keeping the camera, the cuts, the selection and the results (which
// are then stale: their room temperatures were recorded for the model as it was).
const undoStack = [], redoStack = [];
let modelEdited = false;
// geometry: the edit moves or resizes something, so the room air's cells are laid out again (about a
// second for Example_02); settings and assemblies keep them.
function applyEdit(change, what, { geometry = false } = {}) {
  if (!model) return false;
  let e;
  try { e = edit(model.epjson, (tx) => change(tx, model)); } catch (err) { popMessage(err.message); return false; }
  if (!e.changed) return false;
  undoStack.push({ ...e, what, geometry });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  refreshModel(geometry);
  return true;
}
function undo() { const e = undoStack.pop(); if (!e) return; e.undo(); redoStack.push(e); if (!e.view) refreshModel(e.geometry); }
function redo() { const e = redoStack.pop(); if (!e) return; e.redo(); undoStack.push(e); if (!e.view) refreshModel(e.geometry); }
// Clipping planes moved, turned, resized, added or removed: undone like the model's edits, but they
// change only the view.
view.sections.onCommit = (before, after, what) => {
  undoStack.push({ undo: () => view.sections.setState(before), redo: () => view.sections.setState(after), what, view: true });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
};
function popMessage(text) {
  const body = $('info').querySelector('.popbody');
  if (body) body.insertAdjacentHTML('afterbegin', `<div class="error-text popmsg">${esc(text)}</div>`);
}
function refreshModel(geometry = true) {
  const keep = selected, keepPlane = view.sections.selected;
  queueMicrotask(markFloating);
  const m = importEpJSON(model.epjson, { fileName: model.source.fileName });
  model = m;
  modelEdited = true;
  edits++;
  axisCache = null; schedCache.clear();
  fillDetails(m);
  view.setModel(m, { doors: interiorDoors(m), walls: wallMode(), keep: true });
  hover.clear();
  if (geometry) {
    net = buildNetwork(m);
    rooms = prepareRoomFlow(voxelize(m), net, m);
  }
  field = null;
  startGrid(m);
  air.setGrid(rooms.g, Object.values(m.zones).reduce((s, z) => s + z.volume.value, 0));
  for (const map of [windowSet, sashSet, amountSet]) for (const k of [...map.keys()]) if (!m.windows[k] && !k.endsWith(':door')) map.delete(k);
  view.cube.setNorth(-m.site.northAxis);
  view.setColorBy($('color-by').value);
  view.setShadingVisible($('show-shading').checked);
  $('edited').hidden = false;
  $('edited').textContent = `Edited (${undoStack.length})`;
  applyHour(); // solves the air with the model as it is now
  if ($('show-air').checked) air.play();
  winEdit.refresh();
  massEdit.refresh();
  if (keepPlane) view.sections.select(keepPlane); else view.select(keep);
  renderLibrary();
  legend();
}
document.addEventListener('keydown', (e) => {
  if (!model || e.target.closest?.('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { redo(); e.preventDefault(); }
  else if (e.key === 'Escape' && !view.sections.selected && !$('view3d').classList.contains('full')) {
    if (winEdit.active) { winEdit.stop(); showInfo(current()); } else if (selected) view.select(null);
  } else if (e.key === 'Delete' && massing && selected) {
    const found = current(), at = found && massingSide(found.kind, found.item), zt = found?.kind === 'zone' && massingTarget(found);
    if (at && massing.zones[at.zone].faces[at.face]) { sideEdit(at, (x) => { x.zones[at.zone].faces[at.face] = null; }, 'windows removed'); e.preventDefault(); }
    else if (zt) { removeZone(zt.zone); e.preventDefault(); }
  }
});
$('edited').addEventListener('click', undo);

// Settings typed in the pop-up and in the Materials and assemblies window: a zone's, an assembly's
// layers, a material's figures, names. Tab in a name box takes its suggestion.
const assemblyOf = (t) => t.closest('[data-c]')?.dataset.c;
function onChange(e) {
  const named = e.target.closest?.('[data-zone-name]')?.dataset.zoneName;
  const t = e.target, zone = named && model?.zones[named] ? named : selected && model?.zones[selected] ? selected : null;
  if (!model) return;
  if (t.dataset.zcons && zone) {
    const list = Object.values(model.surfaces).filter((x) => x.zone === zone && x.csType === t.dataset.zcons);
    applyEdit((tx, m) => { for (const x of list) setSurfaceConstruction(tx, m, x.name, t.value); }, `${zone} ${t.dataset.zcons} assembly ${t.value}`);
    return;
  }
  if (t.dataset.zset && zone) {
    const v = t.tagName === 'SELECT' ? t.value : Number(String(t.value).replace(',', '.')) * Number(t.dataset.scale || 1);
    if (t.tagName !== 'SELECT' && !(Number.isFinite(v) && v >= 0)) { showInfo(current()); return; }
    applyEdit((tx) => setZoneSetting(tx, zone, t.dataset.zset, v), `zone ${zone} ${t.dataset.zset}`);
    return;
  }
  const s = selected && model.surfaces[selected], base = assemblyOf(t);
  const num = () => Number(String(t.value).replace(',', '.'));
  const act = t.dataset.act;
  if (act === 'construction' && s) applyEdit((tx, m) => setSurfaceConstruction(tx, m, s.name, t.value), `assembly of ${s.name}`);
  else if (act === 'layer-mat' && base) applyEdit((tx) => setLayer(tx, base, Number(t.dataset.i), { material: t.value }), `layer of ${base}`);
  else if (act === 'layer-thk' && base) {
    if (num() > 0) applyEdit((tx) => setLayer(tx, base, Number(t.dataset.i), { thickness: num() / 1000 }), `layer of ${base}`);
    else refreshPanels();
  } else if (act === 'mat-field') {
    const m = t.closest('[data-m]').dataset.m;
    if (num() > 0) applyEdit((tx) => setMaterialField(tx, m, t.dataset.f, num() / Number(t.dataset.per || 1)), `material ${m}`);
    else refreshPanels();
  } else if (act === 'mat-name') {
    const m = t.closest('[data-m]').dataset.m;
    if (t.value.trim() && t.value.trim() !== m) applyEdit((tx) => rename(tx, 'material', m, t.value), `material ${m} renamed`);
  } else if (act === 'asm-name' && base) {
    if (t.value.trim() && t.value.trim() !== base) { libOpen = t.value.trim(); applyEdit((tx) => rename(tx, 'construction', base, t.value), `assembly ${base} renamed`); }
  }
}
function onKey(e) {
  const t = e.target;
  if (e.key === 'Enter' && t.matches('input.popnum, input.libname')) t.blur();
  if (e.key === 'Tab' && t.matches('input.popname') && !t.value) { t.value = t.placeholder; e.preventDefault(); }
  if (e.key === 'Enter' && t.matches('input.popname')) t.closest('.poprow')?.querySelector('[data-act=copy]')?.click();
  e.stopPropagation();
}
function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !model || b.disabled) return;
  const s = selected && model.surfaces[selected], base = assemblyOf(b), i = Number(b.dataset.i), act = b.dataset.act;
  if (act === 'layers') { layersOpen = !layersOpen; showInfo(current()); }
  else if (act === 'layer-del' && base) applyEdit((tx) => removeLayer(tx, base, i), `layer of ${base}`);
  else if (act === 'layer-up' && base) applyEdit((tx) => moveLayer(tx, base, i, -1), `layer of ${base}`);
  else if (act === 'layer-down' && base) applyEdit((tx) => moveLayer(tx, base, i, 1), `layer of ${base}`);
  else if (act === 'layer-add' && base) applyEdit((tx) => { const l = layersOf(tx.epjson.Construction[base]); addLayer(tx, base, l.length, l[l.length - 1]); }, `layer of ${base}`);
  else if (act === 'copy' && s && base) {
    const box = b.closest('.poprow').querySelector('[data-act=copy-name]'), name = (box.value || box.placeholder).trim();
    if (name) applyEdit((tx, m) => { copyConstruction(tx, base, name); setSurfaceConstruction(tx, m, s.name, name); }, `copy of ${base}`);
  } else if (act === 'winedit' && model.windows[selected]) {
    if (winEdit.name === selected) winEdit.stop(); else winEdit.start(selected);
    showInfo(current());
  } else if (act === 'lib-tab') { libTab = b.dataset.v; renderLibrary(); }
  else if (act === 'asm-open') { libOpen = libOpen === b.dataset.v ? null : b.dataset.v; renderLibrary(); }
  else if (act === 'asm-new') {
    const first = materialNames()[0];
    let made = null;
    if (first) applyEdit((tx) => { made = newConstruction(tx, 'New assembly', [first]); }, 'new assembly');
    if (made) { libOpen = made; renderLibrary(); }
  } else if (act === 'asm-del') applyEdit((tx) => removeConstruction(tx, b.dataset.v), `assembly ${b.dataset.v} removed`);
  else if (act === 'mat-new') applyEdit((tx) => newMaterial(tx, $('lib-kind').value, 'New material'), 'new material');
  else if (act === 'mat-del') applyEdit((tx) => removeMaterial(tx, b.dataset.v), `material ${b.dataset.v} removed`);
}
$('massing').addEventListener('change', onChange);
for (const id of ['info', 'library']) {
  $(id).addEventListener('change', onChange);
  $(id).addEventListener('keydown', onKey);
  $(id).addEventListener('click', onClick);
}
function refreshPanels() { showInfo(current()); renderLibrary(); massingUI.render(); }

// ---------- massing ----------
// A building modelled from scratch: zones standing on levels, each face with a window array
// (src/model/massing.js). The massing is kept beside the model; each change to it rewrites the model's
// geometry as one undoable edit, keeping the assemblies, loads and settings changed since.
let massing = null;
const massingUI = massingPanel($('massing'), {
  get: () => massing, model: () => model, change: massingChange,
  zoneExtra: (name) => zoneExtraRows(name),
  onPick: (name) => { if (model?.zones[name] && selected !== name) view.select(name); },
});
// A zone's settings in the Zones window: its space use and ventilation (as its pop-up), and its
// assemblies by surface class (ClimateStudio's construction template), each class set for all the
// zone's surfaces of it at once.
function zoneExtraRows(name) {
  const z = model?.zones[name];
  if (!z) return '';
  const rows = [...zoneRows(z), ...zoneConstructionRows(name)];
  return rows.map((r) => (r.startsWith('<div') ? r : `<div>${r}</div>`)).join('');
}
const CLASS_TIPS = { Facade: 'Walls to the outside', Partition: 'Walls between zones', Roof: 'Roofs to the outside', Slab: 'Floors and ceilings between zones', 'External Floor': 'Floors over the outside', 'Ground Slab': 'Floors on the ground', 'Ground Wall': 'Walls against the ground' };
function zoneConstructionRows(name) {
  const by = new Map();
  for (const s of Object.values(model.surfaces)) if (s.zone === name) { if (!by.has(s.csType)) by.set(s.csType, []); by.get(s.csType).push(s); }
  if (!by.size) return [];
  const ep = model.epjson, names = Object.keys(ep.Construction || {}).filter((n) => !n.endsWith('_FLIPPED') && !constructionProperties(ep, n)?.glazing).sort();
  const rows = [popSec('Construction', 'The assembly of each class of the zone\'s surfaces: picked here, it goes to every surface of the class in this zone (and the other side of those it shares)')];
  for (const [cls, list] of by) {
    const now = new Set(list.map((s) => baseConstruction(s.construction))), one = now.size === 1 ? [...now][0] : null;
    const opts = (one ? '' : '<option selected disabled>mixed</option>') + names.map((n) => `<option${n === one ? ' selected' : ''}>${esc(n)}</option>`).join('');
    rows.push(`<span class="popkv"><span class="tipped" title="${esc(CLASS_TIPS[cls] || cls)}: ${list.length} surface${list.length > 1 ? 's' : ''}">${esc(cls)}</span><select class="popsel wide" data-zcons="${esc(cls)}">${opts}</select></span>`);
  }
  return rows;
}
// The plan and section views changed (made, renamed, re-cut, deleted): undone like the clipping planes,
// touching only the views, not the model.
function viewsChange(mutate, what) {
  const host = viewsHost();
  const before = structuredClone(host.views || []);
  mutate(host);
  const after = structuredClone(host.views || []);
  const put = (v) => { host.views = structuredClone(v); massingUI.render(); viewsChanged(); };
  undoStack.push({ undo: () => put(before), redo: () => put(after), what, view: true });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  viewsChanged();
  return true;
}
// ---------- the views workspace: the 3D view, plans and sections in rows (workspace.js) ----------
// The named plan and section views live with the massing (so storeys put in or taken out carry their
// plans); a model opened from a file keeps them here instead.
let looseViews = { views: [] };
const viewsHost = () => massing || looseViews;
const namedViews = () => viewsHost().views || [];
const planeById = (id) => (id === null || id === undefined ? null : view.sections.planes.find((p) => p.id === id) || null);
const ws = workspace({
  host: document.querySelector('main#results > .views'), view3dEl: $('view3d'), view,
  views: namedViews,
  levels: () => massing?.levels || null,
  planeOf: (id) => planeById(namedViews().find((v) => v.id === id)?.plane),
  onCut3d: cut3d,
  // a plan edited as the 3D view is: its zones, walls and windows picked and pushed, the tools at work
  editorFor: (d) => new PlanEdit(d, {
    view, tools, massing: () => massing, selected: () => selected,
    select: (name) => { view.select(name); ws.selection(); },
    massingTarget: (name) => { const f = view.find(name); return f && massing ? massingTarget(f) : null; },
    change: massingChange,
  }),
  hasTools: () => !!massing,
  onTake: (rec) => {
    undoStack.push({ undo: () => ws.put(rec), redo: () => ws.take(rec.el), what: 'view removed', view: true });
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  },
});
// the building drawn again (a new model, an edit, walls drawn otherwise): the plans and sections cut again
ws.setTools(tools);
// Levels in the views (levels.js): markers in 3D and in sections, a pop-up for the level picked.
const levelEdits = new LevelEdits({
  massing: () => massing, change: massingChange,
  onSelect: (L) => { if (L !== null && (selected || view.sections.selected)) { view.sections.select(null); view.select(null); } levelMarks.draw(); ws.redraw(); },
});
levelMarks = new LevelMarks3D(view, levelEdits, () => massing);
ws.setLevels(levelEdits);
$('show-levels').addEventListener('change', () => { levelMarks.on = $('show-levels').checked; levelMarks.draw(); });
// the View tab: Plan at level, and the views made
const vbar = viewsBar($('view-make'), { views: namedViews, levels: () => massing?.levels || null, changeViews: viewsChange, onOpen: (id) => ws.open(id) });
vbar.render();
// the modelling tools' buttons on a plan view's bar: as the 3D view's
document.addEventListener('click', (e) => {
  const b = e.target.closest('.vtools [data-tool]');
  if (!b || !massing) return;
  if (tools.tool === b.dataset.tool) tools.stop(); else tools.start(b.dataset.tool);
});
// the building drawn again (a new model, an edit, walls drawn otherwise): each drawn wall's location
// line, the walls standing free, and the plans and sections cut again
let surfaceLines = new Map();
view.surfaceLine = (name) => surfaceLines.get(name) || null;
for (const k of ['setModel', 'setWalls']) {
  const f = view[k].bind(view);
  view[k] = (...a) => {
    surfaceLines = new Map();
    if (massing?.walls?.length) for (const z of massingGeometry(massing)) for (const s of z.surfaces) if (s.type === 'Wall') { const l = wallLine(massing, z.zone, s.face); if (l) surfaceLines.set(s.name, l); }
    const r = f(...a);
    view.setFreeWalls(freeWallSolids());
    ws.redraw();
    return r;
  };
}
// the drawn walls standing free, in model coordinates, at their assembly's thickness
function freeWallSolids() {
  if (!massing?.walls?.length || !model) return [];
  const ep = model.epjson, thick = (n) => { const c = ep.Construction?.[n]; if (!c) return 0.2; let t = 0; for (const [k, v] of Object.entries(c)) if (k !== 'name' && ep.Material?.[v]?.thickness) t += ep.Material[v].thickness; return t || 0.2; };
  return freeWalls(massing).map((w) => {
    const t = thick(w.asm), side = w.side || 1, off = w.line === 'exterior' ? -side * t / 2 : w.line === 'interior' ? side * t / 2 : 0;
    const [a, b] = [w.a, w.b].map((p) => turnPlan(p, massing.rot || 0));
    return { a, b, z0: massing.levels[w.base].z, z1: massing.levels[w.top].z, t, off };
  });
}
// The Place wall tab: shown while Draw wall is on, its lists filled from the model.
let ribBefore = 'model';
function wallTab(on) {
  const tab = document.querySelector('.ribtabs [data-rib="wall"]');
  if (on) {
    const ep = model.epjson, cur = $('wall-asm').value || 'Generic Exterior Wall';
    const walls = Object.keys(ep.Construction || {}).filter((n) => !n.endsWith('_FLIPPED') && !constructionProperties(ep, n)?.glazing && !/slab|floor|roof/i.test(n)).sort();
    $('wall-asm').innerHTML = walls.map((n) => `<option${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const lv = massing.levels, b = Math.min(Number($('wall-base').value) || 0, lv.length - 2);
    $('wall-base').innerHTML = lv.slice(0, -1).map((l, L) => `<option value="${L}"${L === b ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    fillTop();
    ribBefore = document.querySelector('.ribtabs [aria-selected=true]')?.dataset.rib || 'model';
    if (ribBefore === 'wall') ribBefore = 'model';
    tab.hidden = false;
    ribbon('wall');
  } else if (!tab.hidden) {
    tab.hidden = true;
    ribbon(ribBefore);
  }
}
function fillTop() {
  const lv = massing.levels, b = Number($('wall-base').value), t = Math.max(Number($('wall-top').value) || 0, b + 1);
  $('wall-top').innerHTML = lv.map((l, L) => (L > b ? `<option value="${L}"${L === Math.min(t, lv.length - 1) ? ' selected' : ''}>${esc(l.name)}</option>` : '')).join('');
}
$('wall-base').addEventListener('change', fillTop);
$('wall-done').addEventListener('click', () => tools.stop());
function openView(id) { ws.open(id); }
// The named views changed: the workspace's lists, and each plan linked to a plane moves its plane.
function viewsChanged() {
  let moved = false;
  for (const v of namedViews()) {
    const p = planeById(v.plane), z = planZ(v);
    if (p && v.kind === 'plan' && Number.isFinite(z) && Math.abs(p.o.z - (z - view.origin[2])) > 1e-6) { p.o.z = z - view.origin[2]; moved = true; }
  }
  if (moved) { view.sections.changed(); if (view.sections.selected) showInfo(current()); }
  ws.listChanged();
  ws.redraw();
  vbar.render();
}
// a plan's cut as a model elevation
const planZ = (v) => (Number.isInteger(v.level) && massing?.levels[v.level] ? massing.levels[v.level].z + v.cut : v.elev);
// The clipping planes moved: the views linked to them follow (their cut, not an edit of their own).
function planesMoved() {
  const o3 = view.origin || [0, 0, 0];
  for (const v of namedViews()) {
    const p = planeById(v.plane);
    if (!p) continue;
    if (v.kind === 'plan') {
      const z = p.o.z + o3[2];
      if (Number.isInteger(v.level) && massing?.levels[v.level]) v.cut = +(z - massing.levels[v.level].z).toFixed(4); else v.elev = +z.toFixed(4);
    } else v.frame = frameRecord(p);
  }
  ws.redraw();
}
// a plane's frame in model coordinates, for a section view to keep
const frameRecord = (p) => { const o3 = view.origin || [0, 0, 0]; return { o: [p.o.x + o3[0], p.o.y + o3[1], p.o.z + o3[2]], q: p.q.toArray(), b: [...p.b], flip: !!p.flip }; };
// Cut 3D here: the view's linked plane picked, or a plane made at its cut and linked to it.
function cut3d(id) {
  const v = namedViews().find((x) => x.id === id), had = planeById(v?.plane);
  if (!v) return;
  if (had) { view.sections.select(had); return; }
  const o3 = view.origin || [0, 0, 0];
  let p;
  if (v.kind === 'plan') {
    const z = planZ(v);
    if (!Number.isFinite(z)) return;
    const c = view.sections.box().getCenter(new THREE.Vector3());
    p = view.sections.add('plan', c.setZ(z - o3[2]));
  } else {
    const f = v.frame, q = new THREE.Quaternion().fromArray(f.q);
    p = view.sections.add('section', new THREE.Vector3(f.o[0] - o3[0], f.o[1] - o3[1], f.o[2] - o3[2]), new THREE.Vector3(1, 0, 0).applyQuaternion(q), f.flip);
    if (p) { p.q.copy(q); p.b = [...f.b]; p.flip = f.flip; view.sections.changed(); }
  }
  if (p) { viewsChange((x) => { x.views.find((y) => y.id === id).plane = p.id; }, `${v.name} linked to ${p.name}`); showInfo(current()); }
}
// A view made from a clipping plane's pop-up, named there; linked to the plane.
function viewFromPlane(p, name) {
  const host = viewsHost(), o3 = view.origin || [0, 0, 0];
  let made = null;
  viewsChange((x) => {
    x.views ||= [];
    const id = Math.max(0, ...x.views.map((v) => v.id + 1));
    made = p.kind === 'plan' ? { id, kind: 'plan', name, level: null, elev: +(p.o.z + o3[2]).toFixed(4), cut: 0, plane: p.id } : { id, kind: 'section', name, frame: frameRecord(p), plane: p.id };
    x.views.push(made);
  }, `${p.kind} view ${name} created`);
  void host;
  if (made) showInfo(current());
}
function massingChange(mutate, what) {
  if (!massing) return false;
  const before = structuredClone(massing);
  mutate(massing);
  const after = structuredClone(massing);
  if (!applyEdit((tx) => applyMassing(tx, massing, { weather }), what, { geometry: true })) { massing = before; massingUI.render(); return false; }
  const e = undoStack[undoStack.length - 1], u = e.undo, r = e.redo, target = massEdit.target;
  e.undo = () => { u(); massing = structuredClone(before); queueMicrotask(() => { massingUI.render(); reselect(target); }); };
  e.redo = () => { r(); massing = structuredClone(after); queueMicrotask(() => { massingUI.render(); reselect(target); }); };
  massingUI.render();
  reselect(target);
  levelEdits.render(); vbar.render();
  return true;
}
// The massing rewritten renumbers its surfaces: the face that was selected, found again by its zone
// and face (its largest piece), stays selected.
function reselect(target) {
  if (target?.face === null || target?.face === undefined || target.window !== undefined || !massing) return;
  const zone = massingGeometry(massing)[target.zone];
  if (!zone) return;
  const kinds = target.face === 'roof' ? ['Roof', 'Ceiling'] : target.face === 'floor' ? ['Floor'] : ['Wall'];
  const pick = zone.surfaces.filter((x) => kinds.includes(x.type) && (x.type !== 'Wall' || x.face === target.face) && model.surfaces[x.name])
    .sort((a, b) => model.surfaces[b.name].area - model.surfaces[a.name].area)[0];
  if (pick && pick.name !== selected) view.select(pick.name);
}
// Which zone a selected zone or surface of a massing is, and which face of it (an index along its
// footprint, 'roof' or 'floor'; null: the whole zone). A floor on the ground has no handle of its own.
function massingTarget(found) {
  if (found?.kind === 'window') { const at = massingWindow(massing, found.item.name); return at ? { zone: at.zone, face: at.face, window: at.index } : null; }
  if (found?.kind !== 'zone' && found?.kind !== 'surface') return null;
  const zones = massingGeometry(massing);
  if (found.kind === 'zone') { const i = zones.findIndex((z) => z.name === found.item.name); return i < 0 ? null : { zone: i, face: null }; }
  for (const z of zones) {
    const s = z.surfaces.find((x) => x.name === found.item.name);
    if (!s) continue;
    const face = s.type === 'Wall' ? s.face : s.type === 'Floor' ? (massing.zones[z.zone].base > 0 ? 'floor' : null) : 'roof';
    return face !== null ? { zone: z.zone, face } : null;
  }
  return null;
}
// A massing's window edited in 3D (the facade-windows skill): its edges set its type - the array's, so
// every window of the array changes, unless it is broken out - each kept as its Size says; the glass
// moved along its wall sets the array's pitch. A broken window keeps its own size and place.
function massingWindowEdit(name, r) {
  const at = massingWindow(massing, name), was = windowRect(model, name), g = massing.zones[at.zone].faces[at.face];
  const i = at.zone, f = at.face, k = at.index, mid = faceMiddle(name), word = faceWord(at);
  if (g.broken?.[k]) return massingChange((x) => { breakOutWindow(x, name, r, mid); spreadSide(x, i, f); }, `window ${k + 1} of the ${word} moved or resized`);
  const eq = (a, b) => Math.abs(a - b) < 1e-3, w0 = was.s1 - was.s0, w = r.s1 - r.s0;
  return massingChange((x) => {
    if (!eq(w, w0)) setWindowFigure(x, i, f, k, 'winW', w);
    for (const key of r.z1 > was.z1 ? ['head', 'sill'] : ['sill', 'head']) {
      const v = (key === 'sill' ? r.z0 : r.z1) - at.z0, old = (key === 'sill' ? was.z0 : was.z1) - at.z0;
      if (!eq(v, old)) setWindowFigure(x, i, f, k, key, v);
    }
    if (eq(w, w0) && !eq(r.s0 + r.s1, was.s0 + was.s1)) dragPitch(x, i, f, k, (r.s0 + r.s1) / 2 - mid);
    spreadSide(x, i, f);
  }, `windows of the ${word} changed`);
}
// Where a massing's window's face has its middle, along it (as windowRect measures it): the face's, not
// its wall piece's, which can be shorter where the face meets another zone.
function faceMiddle(name) {
  const at = massingWindow(massing, name), { A, B } = faceAxes(massing, at.zone, at.face), f = windowRect(model, name).frame;
  const M = turnPlan([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], massing.rot || 0);
  return M[0] * f.right[0] + M[1] * f.right[1];
}
$('new-massing').addEventListener('click', () => {
  if (model && !confirm('Start a new massing in place of the model open now? Export it first to keep it.')) return;
  massing = massing0();
  model = importEpJSON(massingEpJSON(massing, { weather }), { fileName: 'Massing.epJSON' });
  $('status').textContent = 'Massing';
  $('export').disabled = false;
  render(model);
  $('mass-open').hidden = false;
  $('model-tools').hidden = false;
  $('massing').hidden = false;
  massingUI.reset(); massingUI.render();
  vbar.render();
  ribbon('model');
});
$('mass-open').addEventListener('click', () => { $('massing').hidden = !$('massing').hidden; massingUI.render(); });

// ---------- the Materials and assemblies window ----------
// The model's library: every material with the figures that define it, and every assembly with its
// layers, each typed over, renamed, added or (when nothing uses it) removed.
let libTab = 'assemblies', libOpen = null;
function renderLibrary() {
  const box = $('library');
  if (box.hidden || !model) return;
  if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  const ep = model.epjson, scroll = box.querySelector('.libbody')?.scrollTop || 0;
  const tab = (v, label) => `<button type="button" data-act="lib-tab" data-v="${v}" aria-pressed="${libTab === v}">${label}</button>`;
  let body = '';
  if (libTab === 'materials') {
    // One table for each kind of material, its figures under column titles that stay in view.
    for (const type of Object.keys(MATERIAL_FIELDS)) {
      const list = Object.entries(ep[type] || {}).sort(([a], [b]) => a.localeCompare(b));
      if (!list.length) continue;
      body += `<table class="libtable"><thead><tr><th>${MATERIAL_KINDS[type]}</th>`
        + MATERIAL_FIELDS[type].map(([, label, unit]) => `<th class="num">${label}${unit ? `<span class="unit"> ${unit}</span>` : ''}</th>`).join('')
        + '<th class="num" title="Assemblies using it">Used</th><th></th></tr></thead><tbody>';
      for (const [name, m] of list) {
        const uses = materialUses(ep, name);
        body += `<tr data-m="${esc(name)}"><td><input class="libname" data-act="mat-name" value="${esc(name)}" title="${esc(name)}: type a new name"></td>`
          + MATERIAL_FIELDS[type].map(([f, label, unit, per]) => `<td class="num"><input class="popnum" data-act="mat-field" data-f="${f}" data-per="${per}" value="${+((m[f] ?? 0) * per).toFixed(per > 1 ? 1 : 4)}" title="${label}${unit ? `, ${unit}` : ''}"></td>`).join('')
          + `<td class="num">${uses}</td><td>${uses ? '' : `<button type="button" class="pbtn x" data-act="mat-del" data-v="${esc(name)}" title="Remove this material (no assembly uses it)">×</button>`}</td></tr>`;
      }
      body += '</tbody></table>';
    }
    body += `<div class="poprow libfoot"><select id="lib-kind" class="popsel">${Object.entries(MATERIAL_KINDS).map(([t, l]) => `<option value="${t}">${l}</option>`).join('')}</select><button type="button" class="pbtn" data-act="mat-new">New material</button></div>`;
  } else {
    body += '<div class="libasms">';
    for (const name of Object.keys(ep.Construction || {}).filter((n) => !n.endsWith('_FLIPPED')).sort()) {
      const c = constructionProperties(ep, name), uses = constructionUses(ep, name), open = libOpen === name;
      body += `<div class="libasm${open ? ' open' : ''}" data-c="${esc(name)}"><div class="libasmhd">`
        + `<button type="button" class="pbtn more" data-act="asm-open" data-v="${esc(name)}" title="${open ? 'Close' : 'Show and edit its layers'}">${open ? '▾' : '▸'}</button>`
        + `<input class="libname" data-act="asm-name" value="${esc(name)}" title="Its name: type a new one">`
        + `<span class="muted">${c.layers.length} layer${c.layers.length === 1 ? '' : 's'} · ${c.glazing ? (c.uFactor ? `U ${fmt(c.uFactor, 2)}` : 'glazing') : `R ${fmt(c.R, 2)}`} · ${uses} surface${uses === 1 ? '' : 's'}</span>`
        + (uses ? '' : `<button type="button" class="pbtn x" data-act="asm-del" data-v="${esc(name)}" title="Remove this assembly (no surface uses it)">×</button>`)
        + '</div>';
      if (open) body += (c.glazing ? [`<span class="muted">A window's glazing: its layers are set in the material list.</span>`] : assemblyEditor(name, { users: uses }))
        .map((r) => (r.startsWith('<div') ? r : `<div>${r}</div>`)).join('');
      body += '</div>';
    }
    body += '</div><div class="poprow libfoot"><button type="button" class="pbtn" data-act="asm-new" title="A new assembly of one layer, to build up here and give to surfaces from their pop-up">New assembly</button></div>';
  }
  box.innerHTML = `<div class="pophd" title="Drag to move"><span class="popttl">Materials and assemblies</span><span class="seg mini">${tab('assemblies', 'Assemblies')}${tab('materials', 'Materials')}</span>`
    + '<span class="popbtns"><button type="button" data-pop="close" title="Close">×</button></span></div>'
    + `<div class="libbody">${body}</div>`;
  box.querySelector('.libbody').scrollTop = scroll;
}
$('lib-open').addEventListener('click', () => { const box = $('library'); box.hidden = !box.hidden; renderLibrary(); });
$('library').addEventListener('click', (e) => { if (e.target.closest('[data-pop=close]')) $('library').hidden = true; });
$('library').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.pophd') || e.target.closest('button') || e.button !== 0) return;
  const box = $('library'), r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
  const move = (m) => Object.assign(box.style, { left: `${m.clientX - x0}px`, top: `${m.clientY - y0}px`, right: 'auto' });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
});

$('info').addEventListener('change', (e) => {
  const a = e.target.dataset?.apply;
  if (a) applyAll[a] = e.target.checked;
});

// Windows on a level, and on a side of the building: for Apply to all sides and Apply to all levels.
const applyAll = { sides: false, levels: false };
let axisCache = null;
const sideOf = (w) => {
  axisCache ??= footprintAxis(model).azimuth;
  return Math.round(((((w.azimuth ?? 0) - axisCache) % 360) + 360) % 360 / 90) % 4;
};
function levelOf(w) {
  const floors = [...new Set(Object.values(model.zones).map((z) => Math.round(z.bottom * 2) / 2))].sort((a, b) => a - b);
  return floors.indexOf(Math.round(model.zones[w.zone].bottom * 2) / 2);
}
// The operable windows a change to one window's type or opening goes to.
function scopeOf(name) {
  const w = model.windows[name];
  if (!w || (!applyAll.sides && !applyAll.levels)) return [name];
  return net.links.filter((l) => l.control === 'zone' && model.windows[l.name]).map((l) => l.name).filter((n) => {
    const x = model.windows[n];
    return n === name || ((applyAll.sides || sideOf(x) === sideOf(w)) && (applyAll.levels || levelOf(x) === levelOf(w)));
  });
}

// Occupancy: the people per m2 in each zone this hour, from its peak density and schedule.
const schedCache = new Map();
function scheduleValues(name) {
  if (!schedCache.has(name)) schedCache.set(name, hourlyValues(model.epjson, name));
  return schedCache.get(name);
}
function peopleNow(hourAt) {
  return Object.fromEntries(Object.values(model.zones).map((z) => [z.name, z.people ? z.people.density.value * (scheduleValues(z.people.schedule)?.[hourAt] ?? 1) : 0]));
}
const peopleTop = () => Math.max(0.02, ...Object.values(model.zones).map((z) => z.people?.density.value || 0));

$('checks').addEventListener('click', (e) => {
  const name = e.target.dataset?.name;
  if (!name) return;
  view.focus(name);
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('file').addEventListener('change', (e) => e.target.files[0] && load(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
});
$('export-eso').addEventListener('click', async () => {
  if (!esoSource?.blob) return;
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await esoSource.blob());
    a.download = /\.eso$/i.test(esoSource.name) ? esoSource.name.replace(/^.*[\\/]/, '').replace(/^.*: /, '') : `${esoSource.name}.eso`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { $('results-status').innerHTML = `<span class="error-text">Could not save the results file: ${esc(err.message)}</span>`; }
});
$('export').addEventListener('click', () => {
  if (!model) return;
  const blob = new Blob([serializeEpJSON(exportEpJSON(model))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (model.source.fileName || 'model').replace(/\.(epjson|json)$/i, '') + (modelEdited || undoStack.length ? '_edited' : '_export') + '.epJSON';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
