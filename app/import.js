import * as THREE from 'three';
import { importEpJSON, MODEL_VERSION } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { View3D, TYPE_COLORS, PROBLEM, OPEN_WINDOW, zoneColor, pressureColor, NO_PRESSURE, co2Color, CO2_SCALE } from './view3d.js';
import { footprintAxis, toAirflowNetwork } from '../src/model/airflow-network.js';
import { interiorDoors, DOOR } from '../src/model/interior-doors.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow, roomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';
import { co2Generation, outdoorAirSupply, outdoorCO2, stepCO2 } from '../src/solver/co2.js';
import { cellAt } from '../src/solver/roomflow.js';
import { FieldSlices, rampTemperature } from './slices.js';
import { frameOf } from './sections.js';
import { standardPressure } from '../src/solver/air.js';
import { AirflowParticles, temperatureColor, speedColor, SPEED_RANGE } from './particles.js';
import { windRoseData, windRoseGroup, windArrow, windSpeedAt, BAND_COLORS, SPEED_BANDS } from './windrose.js';
import { dateOf, hourIndex, outdoorAt, parseEPW } from '../src/model/weather.js';
import { readZoneResultsStream, zoneAt, windowAt, mergeResults, surfaceAt } from '../src/model/results.js';
import { SASH_TYPES, sashAngle, freeFraction } from '../src/model/sash.js';
import { daylightSavingDays } from '../src/model/schedules.js';

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
slices.timeScale = Number($('cut-speed').value);
view.setProjection($('projection').querySelector('[aria-pressed="true"]').dataset.proj);
let sliceRange = null, sliceTimer = 0, sliceLast = 0;
// Redraws the slices from the room air: the grid solver's fields, or ideal flow's speed and each
// room's own temperature. Throttled, since the simulation posts several steps a second.
function drawSlices(now = false) {
  const kind = $('slices').value, arrows = $('arrows').checked, simulated = $('room-air').value === 'grid';
  if ((!kind && !arrows) || !model || !rooms || !view.sections.planes.length || (simulated ? !gridLive : !field)) { slices.hide(); sliceRange = null; legend(); return; }
  const wait = 300 - (performance.now() - sliceLast);
  if (!now && wait > 0) { clearTimeout(sliceTimer); sliceTimer = setTimeout(() => drawSlices(true), wait); return; }
  sliceLast = performance.now();
  const g = rooms.g, fluid = (x, y, z) => { const c = cellAt(g, [x, y, z]); return c >= 0 && g.zone[c] >= 0; };
  let value;
  const velocity = simulated ? (x, y, z) => grid.velocityAt([x, y, z])
    : (x, y, z) => { const c = cellAt(g, [x, y, z]); return [field.velocity[3 * c], field.velocity[3 * c + 1], field.velocity[3 * c + 2]]; };
  if (kind === 'co2') {
    value = simulated && grid.co2 ? (x, y, z) => grid.co2At(x, y, z) : (x, y, z) => airflow.co2?.[g.zones[g.zone[cellAt(g, [x, y, z])]]] ?? 400;
  } else if (simulated) {
    value = kind === 'speed' ? (x, y, z) => Math.hypot(...grid.velocityAt([x, y, z])) : (x, y, z) => grid.temperatureAt(x, y, z);
  } else {
    const t = airflow.conditions.zones;
    value = kind === 'speed' ? (x, y, z) => { const c = cellAt(g, [x, y, z]); return Math.hypot(field.velocity[3 * c], field.velocity[3 * c + 1], field.velocity[3 * c + 2]); }
      : (x, y, z) => t[g.zones[g.zone[cellAt(g, [x, y, z])]]].t;
  }
  const co2Ramp = (v, [lo, hi]) => co2Color(CO2_SCALE[0] + ((v - lo) / Math.max(1, hi - lo)) * (CO2_SCALE[2] - CO2_SCALE[0]));
  const colour = kind === 'speed' ? (v) => speedColor(v) : kind === 'co2' ? co2Ramp : (v, range) => rampTemperature(v, range[0], range[1]);
  const temperature = simulated ? (x, y, z) => grid.temperatureAt(x, y, z) : (x, y, z) => airflow.conditions.zones[g.zones[g.zone[cellAt(g, [x, y, z])]]]?.t ?? 20;
  sliceRange = slices.update({ inside: fluid, value, velocity, temperature, co2: (x, y, z) => co2Near([x, y, z]) }, kind, colour, g, arrows);
  legend();
}
let net = null, airflow = null; // the network for the loaded model, and its latest solution
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
let weather = null, weatherHour = null; // the weather file and the hour picked from it
let results = null; // zone conditions hour by hour from a results file, for the loaded model

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
  airflow = { solution, flows, conditions, co2: airflow?.co2 ?? null };
  clearTimeout(co2Timer);
  co2Timer = setTimeout(() => {
    const now = airflow;
    if (now?.solution !== solution) return;
    now.co2 = co2History(hourAt, solution, site, outdoor);
    view.setCO2(now.co2);
    // The grid solver carries CO2 within rooms, each zone's mean held at these levels.
    if (grid && worker) {
      const co2 = {
        targets: now.co2, outdoor: outdoorCO2(model, hourAt),
        generation: Object.fromEntries(net.zones.map((z, i) => [z, co2Generation(model, net.zones, hourAt)[i]])),
        supply: Object.fromEntries(outdoorAirSupply(model, net.zones, hourAt, site.elevation).map((m, i) => [net.zones[i], m])),
      };
      grid.setCO2(co2);
      worker.postMessage({ type: 'co2', co2 });
    }
    if ($('slices').value === 'co2') drawSlices(true);
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
  // With a results file, temperatures belong to the results' own window states.
  const differs = results && (mode !== 'results' || [...windowSet.keys()].some((n) => !n.endsWith(':door')) || roomSet.size);
  $('stale').hidden = !differs;
  if (differs && !rerunning) {
    const [a, b] = rerunWeek();
    $('stale').innerHTML = `Windows differ from ${esc(results.name)}. Room temperatures are still the ones it recorded with its own windows, so the stack effect and two-way flows use temperatures that these windows would change over the following hours. `
      + `<button class="quiet" id="rerun">Rerun ${esc(dateOf(a).label)}–${esc(dateOf(b).label)} in EnergyPlus</button> (about 20 s, with these windows and doors)`;
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
async function rerun() {
  if (rerunning || !results || !weather) return;
  const file = $('weather-file').value;
  if (!file || $('weather-file').selectedOptions[0].file) {
    $('stale').textContent = 'A rerun needs one of the weather files the server offers; pick one under Weather.';
    return;
  }
  const [a, b] = rerunWeek(), da = dateOf(a), db = dateOf(b);
  const forModel = model, label = `${da.label}–${db.label}`;
  // Windows open as far as their sashes allow; EnergyPlus's control then opens them up to that.
  const openFactors = Object.fromEntries(net.links.filter((l) => l.control === 'zone').map((l) => [l.name, openFraction(l)]));
  // Hoppers and awnings run as EnergyPlus's pivoted openings, at the angle their opening amount gives.
  const pivoted = Object.fromEntries(net.links.filter((l) => l.control === 'zone' && ['hopper', 'awning'].includes(sashOf(l.name).type))
    .map((l) => [l.name, { type: sashOf(l.name).type, angle: amountOf(l) * maxAngleOf(l) }]));
  const epjson = toAirflowNetwork(model, { states: linkStates(), openFactors, sashes: pivoted, runPeriod: [da.month, da.day, db.month, db.day], skipSizing: true, surfaceTemperatures: true });
  rerunning = true;
  const t0 = Date.now();
  const tick = setInterval(() => { $('stale').textContent = `Running EnergyPlus for ${label}… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  try {
    const res = await fetch('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epjson, weather: file }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    const eso = await fetch(out.eso);
    const week = await readZoneResultsStream(eso.body, forModel, null, { hours: (b - a + 1) * 24 });
    if (model !== forModel) return;
    // A pivoted window reports its opening factor as angle / 90: read it as the share of the window
    // its sash frees at that angle, as the tool's other windows are.
    for (const [name, s] of Object.entries(pivoted)) {
      const series = week.windows[name.toUpperCase()], l = net.links.find((x) => x.name === name);
      if (series && l) week.windows[name.toUpperCase()] = series.map((f) => (f > 0 ? freeFraction(s.type, l.width, l.height, f * 90) : 0));
    }
    const merged = mergeResults(results, week, hourIndex(a, 1));
    windowSet.clear(); roomSet.clear(); // the run now holds these choices
    $('windows').value = 'results';
    clearInterval(tick);
    rerunning = false;
    setResults(merged, `${results.name.replace(/; rerun .*$/, '')}; rerun ${label} (${Math.round(out.seconds)} s)`);
  } catch (err) {
    $('stale').textContent = `The rerun did not finish: ${err.message}`;
  } finally {
    clearInterval(tick);
    rerunning = false;
  }
}
$('stale').addEventListener('click', (e) => { if (e.target.id === 'rerun') rerun(); });

// The compass direction (true north) a horizontal direction in model axes points to, in words.
function compass(d) {
  const az = (THREE_DEG(Math.atan2(d.x, d.y)) + (model?.site.northAxis || 0) + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(az / 45) % 8];
}
const THREE_DEG = (r) => (r * 180) / Math.PI;

// What is selected now: a section plane, or a surface, window, door or zone.
const current = () => (view.sections.selected ? { kind: 'plane', item: view.sections.selected } : view.find(selected));

// Section planes: added from the bar (dragged in, or a click on the button and then on the view), and
// picked, moved and turned in the view (sections.js). The air on them follows every change.
view.sections.onChange = () => drawSlices(true);
view.sections.onSelect = (p) => {
  if (p) { view.select(null); showInfo({ kind: 'plane', item: p }); }
  else if (!$('info').hidden && $('info').dataset.kind === 'plane') showInfo(null);
};
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
  if (b?.dataset.act === 'plane-flip') { view.sections.flip(view.sections.selected); return; }
  if (b?.dataset.act === 'plane-delete') { view.sections.remove(view.sections.selected); return; }
  if (!b || !airflow) return;
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
  sashSet.set(e.target.dataset.name, { ...sashSet.get(e.target.dataset.name), type: e.target.value });
  amountSet.delete(e.target.dataset.name); // a new mechanism: back to the amount that frees the model's fraction
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
  amountSet.set(name, a);
  windowSet.set(name, a > 0);
  solveAir();
  const out = $('info').querySelector(`output[data-for="${CSS.escape(name)}"]`);
  if (out) out.textContent = amountText(l);
});
$('windows-reset').addEventListener('click', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(current()); legend(); });
for (const id of ['windows', 'doors']) $(id).addEventListener('change', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(current()); legend(); });

// Vertical section, along or across the footprint's long side.
$('slices').addEventListener('change', () => drawSlices(true));
$('arrows').addEventListener('change', () => drawSlices(true));

$('air-color').addEventListener('change', (e) => { air.colorBy = e.target.value; legend(); });
$('cut-color').addEventListener('change', (e) => { slices.colorBy = e.target.value; legend(); });
// CO2 at a point (model coordinates): the grid solver's field, or with ideal flow its room's level.
function co2Near(p, zoneIndex = null) {
  if ($('room-air').value === 'grid' && grid?.co2) return grid.co2At(p);
  const g = rooms?.g;
  if (!g) return 400;
  const zi = zoneIndex ?? g.zone[cellAt(g, p)];
  return airflow?.co2?.[g.zones[zi]] ?? 400;
}
air.co2At = (p, zi) => co2Near(p, zi);
// The particles in the cuts: their own density and speed.
$('cut-density').addEventListener('input', (e) => {
  const k = 2 ** Number(e.target.value);
  slices.density = k;
  $('cut-density-value').textContent = `×${k < 1 ? k.toFixed(2).replace(/0$/, '') : k}`;
  drawSlices(true);
});
$('cut-speed').addEventListener('input', (e) => { slices.timeScale = Number(e.target.value); $('cut-speed-value').textContent = `×${e.target.value}`; });
$('air-speed').addEventListener('input', (e) => { air.speed = Number(e.target.value); $('air-speed-value').textContent = `×${e.target.value}`; });
let selected = null;

// Weather: picking a day and hour fills in the outdoor conditions, which can still be edited.
function setWeather(w) {
  weather = w;
  weatherHour = null;
  applyHour();
}
function applyHour() {
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
  const option = $('windows').querySelector('option[value=results]');
  option.disabled = !r;
  if (r) $('windows').value = 'results';
  else if ($('windows').value === 'results') $('windows').value = 'open';
  $('t-in').disabled = !!r;
  const missing = r?.missing.length ? ` (no temperatures for ${r.missing.length} zones: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''})` : '';
  $('results-status').textContent = r ? `Zone temperatures from ${name}${missing}` : '';
  applyHour();
}
async function loadResults(name, stream, size) {
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
  if (opt.file) return loadResults(opt.file.name, opt.file.stream(), opt.file.size);
  const res = await fetch(e.target.value);
  loadResults(opt.textContent, res.body, Number(res.headers.get('content-length')) || 0);
});
$('results-load').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const option = new Option(file.name, `local:${file.name}`, true, true);
  option.file = file;
  $('results-file').add(option);
  loadResults(file.name, file.stream(), file.size);
});
for (const id of ['day', 'hour']) $(id).addEventListener('input', applyHour);
$('weather-file').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) return setWeather(null);
  const local = e.target.selectedOptions[0].file;
  loadWeather(name, local ? () => local.text() : () => fetch(`/weather/${encodeURIComponent(name)}`).then((r) => r.text()));
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
fetch('/weather/').then((r) => (r.ok ? r.json() : [])).then((files) => {
  for (const f of files) $('weather-file').add(new Option(f, f));
  const first = files.find((f) => f.includes('TDY-CWEC2020v2')) || null;
  if (first) { $('weather-file').value = first; $('weather-file').dispatchEvent(new Event('change')); }
}).catch(() => {});

const load = (file) => loadText(file.name, () => file.text());

async function loadText(name, read) {
  $('status').textContent = `Reading ${name}…`;
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

// Details of the selected surface, window, zone or shading surface, and any checks that name it.
function showInfo(found) {
  const box = $('info');
  if (found?.kind !== 'plane') selected = found?.item?.name ?? null;
  if (!found) { box.hidden = true; box.dataset.kind = ''; return; }
  const { kind, item } = found;
  box.dataset.kind = kind;
  const rows = [];
  if (kind === 'plane') {
    const plan = item.kind === 'plan';
    rows.push(`<b>${esc(item.name)}</b>`,
      plan ? `Removes what is ${item.flip ? 'below' : 'above'} it, within its bounds` : `Removes the ${compass(frameOf(item).n)} side, within its bounds`,
      `<span class="muted">Drag its outline to move it, the gumball's arrows to move it along x, y or z (click one to type a distance), its arc to turn it, the squares to resize its bounds. Delete removes it.</span>`,
      `<button class="quiet" data-act="plane-flip">Flip</button> <button class="quiet" data-act="plane-delete">Delete</button>`);
    box.innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
    box.hidden = false;
    return;
  }
  const deg = (x) => (x === null ? '' : `${Math.round(x)}°`);
  if (kind === 'surface') {
    rows.push(`<b>${esc(item.name)}</b>`, `${esc(item.csType)} of zone ${esc(item.zone)}`,
      `${fmt(item.area, 2)} m² · ${item.azimuth === null ? (item.tilt < 90 ? 'faces up' : 'faces down') : `faces ${deg(item.azimuth)} from north`} · tilt ${deg(item.tilt)}`,
      esc(item.construction));
    if (item.adjacentZone) rows.push(`Shared with zone ${esc(item.adjacentZone)}`);
  } else if (kind === 'window') {
    rows.push(`<b>${esc(item.name)}</b>`, `Window of zone ${esc(item.zone)}, on ${esc(item.parent)}`,
      `${fmt(item.area, 2)} m² · faces ${deg(item.azimuth)} from north · ${fmt(item.height, 2)} m tall`,
      item.operableFraction ? `Operable fraction ${fmt(item.operableFraction.value, 2)}` : 'Not operable');
  } else if (kind === 'door') {
    rows.push(`<b>Door between ${esc(item.zone)} and ${esc(item.partnerZone)}</b>`, `${fmt(item.width, 2)} × ${fmt(item.height, 2)} m`,
      '<span class="muted">Added by the tool for the airflow network; the model has no interior openings here.</span>');
  } else if (kind === 'zone') {
    rows.push(`<b>Zone ${esc(item.name)}</b>`, `${fmt(item.floorArea.value, 1)} m² floor · ${fmt(item.volume.value, 0)} m³ · ${fmt(item.height, 2)} m high`);
  } else {
    rows.push(`<b>${esc(item.name)}</b>`, 'Shading surface');
  }
  if (airflow) {
    rows.push(...airLines(kind, item));
    if (kind === 'zone') rows.push(...roomButton(item.name));
    if (kind === 'surface' || kind === 'window') rows.push(`Room: ${co2Line(item.zone)}`);
    if (kind === 'surface') rows.push(...roomButton(item.zone));
  }
  for (const c of model.checks.filter((c) => c.objects.includes(item.name))) {
    const cls = c.level === 'error' ? 'error-text' : c.level === 'warning' ? 'warning-text' : 'muted';
    rows.push(`<span class="${cls}">${esc(c.message)}</span>`);
  }
  box.innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
  box.hidden = false;
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

// A button to open or close all of a room's operable windows, for the room or one of its surfaces.
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
  } else if ($('color-by').value === 'zone') {
    Object.keys(model.zones).forEach((z, i) => items.push(chip(`#${zoneColor(i).getHexString()}`, z)));
  } else {
    const types = new Set(Object.values(model.surfaces).map((s) => s.csType));
    for (const [t, c] of Object.entries(TYPE_COLORS)) if (types.has(t)) items.push(chip(c, t));
  }
  if (Object.keys(model.windows).length) items.push(chip(TYPE_COLORS.Glazing, $('show-air').checked ? 'Glazing, closed' : 'Glazing'));
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
  if ($('slices').value && sliceRange !== undefined && slices.visible) {
    if ($('slices').value === 'co2' && sliceRange) {
      const [lo, hi] = sliceRange;
      items.push(`<span title="Cuts: CO2 in the room air, from the grid solver (each room's mean held at its balance figure) or, with ideal flow, each room's own level. Coloured from the lowest to the highest on the cuts, so the pattern within rooms shows; the colours do not mean the same levels as Colour by CO2.">${ramp([co2Color(CO2_SCALE[0]), co2Color(CO2_SCALE[1]), co2Color(CO2_SCALE[2])], 48)}Cuts: CO₂ ${fmt(lo, 0)} … ${fmt(hi, 0)} ppm</span>`);
    } else if ($('slices').value === 'speed') {
      const stops = [0, 0.25, 0.5, 0.75, 1].map((x) => speedColor(SPEED_RANGE[0] * (SPEED_RANGE[1] / SPEED_RANGE[0]) ** x));
      items.push(`<span title="Slices: air speed on a log scale">${ramp(stops, 48)}Slices: speed ${SPEED_RANGE[0]} … ${SPEED_RANGE[1]} m/s</span>`);
    } else if (sliceRange) {
      const [lo, hi] = sliceRange;
      items.push(`<span title="Slices: air temperature, from the lowest to the highest on the slices shown">${ramp([rampTemperature(lo, lo, hi), rampTemperature((lo + hi) / 2, lo, hi), rampTemperature(hi, lo, hi)], 48)}Slices: ${fmt(lo, 1)} … ${fmt(hi, 1)} °C</span>`);
    }
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
  const cutsShown = $('arrows').checked && view.sections.planes.length > 0;
  if ($('show-air').checked && cutsShown && $('air-color').value === $('cut-color').value) items.push(particleKey($('air-color').value, 'Particles'));
  else {
    if ($('show-air').checked) items.push(particleKey($('air-color').value, 'Particles'));
    if (cutsShown) items.push(particleKey($('cut-color').value, 'In the cuts'));
  }
  if (view.problems.length) items.push(chip(PROBLEM, 'Named by a model check', 'The arrow shows the way EnergyPlus takes as outward, from the order of the corner points.'));
  $('legend').innerHTML = items.join('');
}

$('color-by').addEventListener('change', (e) => { view.setColorBy(e.target.value); legend(); });
$('show-shading').addEventListener('change', (e) => view.setShadingVisible(e.target.checked));
$('walls').addEventListener('change', (e) => view.setWalls(e.target.value));
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
typeable($('cut-density-value'), $('cut-density'), (t) => { const k = parseTimes(t); return k > 0 ? Math.log2(k) : null; });
typeable($('cut-speed-value'), $('cut-speed'), parseTimes);

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
  $('play').classList.toggle('on', on);
  $('play').textContent = on ? '❚❚ Pause' : '▶ Play day';
  if (!on) { applyHour(); return; } // the label back to the whole hour
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

function render(m) {
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

  $('results').hidden = false;
  view.resize();
  view.setModel(m, { doors: interiorDoors(m), walls: $('walls').value });
  net = buildNetwork(m);
  rooms = prepareRoomFlow(voxelize(m), net, m);
  field = null;
  startGrid(m);
  $('restart-air').disabled = false;
  air.setGrid(rooms.g, Object.values(m.zones).reduce((s, z) => s + z.volume.value, 0));
  $('results-file').value = '';
  windowSet.clear(); roomSet.clear(); sashSet.clear(); amountSet.clear();
  const a = ((footprintAxis(m).azimuth - m.site.northAxis) * Math.PI) / 180;
  view.longAxis = Math.atan2(Math.cos(a), Math.sin(a)); // the footprint's long side, from model x
  view.cube.setNorth(-m.site.northAxis);
  setResults(null); // results belong to the previous model; this also solves the network
  if ($('show-air').checked) air.play();
  view.setColorBy($('color-by').value);
  view.setShadingVisible($('show-shading').checked);
  view.select(null);
  legend();
}

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
$('export').addEventListener('click', () => {
  if (!model) return;
  const blob = new Blob([serializeEpJSON(exportEpJSON(model))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (model.source.fileName || 'model').replace(/\.(epjson|json)$/i, '') + '_export.epJSON';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
