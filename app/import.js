import { importEpJSON, MODEL_VERSION } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { View3D, TYPE_COLORS, PROBLEM, OPEN_WINDOW, zoneColor, pressureColor, NO_PRESSURE } from './view3d.js';
import { footprintAxis } from '../src/model/airflow-network.js';
import { interiorDoors, DOOR } from '../src/model/interior-doors.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow, roomFlow } from '../src/solver/roomflow.js';
import { standardPressure } from '../src/solver/air.js';
import { AirflowParticles, temperatureColor, speedColor, SPEED_RANGE } from './particles.js';
import { windRoseData, windRoseGroup, BAND_COLORS, SPEED_BANDS } from './windrose.js';
import { dateOf, hourIndex, outdoorAt, parseEPW } from '../src/model/weather.js';
import { readZoneResultsStream, zoneAt } from '../src/model/results.js';

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
let net = null, airflow = null; // the network for the loaded model, and its latest solution
let rooms = null, field = null, fieldTimer = 0; // cells and faces for the room flow, and its latest field
let pressureRange = 1; // Pa, the end of the pressure colour scale for the hour solved
// Windows opened or closed one by one (by window name) or room by room (by zone), over the Windows setting.
const windowSet = new Map(), roomSet = new Map();
let weather = null, weatherHour = null; // the weather file and the hour picked from it
let results = null; // zone conditions hour by hour from a results file, for the loaded model

// Solves the network for the conditions in the Airflow controls and hands the flows to the particles.
function solveAir() {
  if (!model || !net) return;
  // The site comes from the weather file when there is one, else from the model, else sea level.
  const loc = weather?.location || Object.values(model.epjson['Site:Location'] || {})[0] || {};
  const site = { elevation: loc.elevation ?? 0, latitude: loc.latitude ?? 45 };
  const tIn = Number($('t-in').value), mode = $('windows').value;
  const hourAt = hourIndex(Number($('day').value), Number($('hour').value));
  const pressure = weatherHour?.pressure ?? standardPressure(site.elevation);
  const inside = (z) => (results && zoneAt(results, z, hourAt, pressure)) || { t: tIn, w: 0.008, vent: null };
  const conditions = {
    site,
    outdoor: {
      t: Number($('t-out').value), w: weatherHour?.w ?? 0.008, pressure: weatherHour?.pressure ?? standardPressure(site.elevation),
      windSpeed: Number($('wind').value), windDirection: Number($('wind-dir').value),
    },
    zones: Object.fromEntries(net.zones.map((z) => [z, inside(z)])),
    open: Object.fromEntries(net.links.filter((l) => l.control === 'zone' || l.door).map((l) => {
      if (l.door) return [l.name, (windowSet.has(l.name) ? windowSet.get(l.name) : $('doors').value === 'open') ? l.openFactor : 0];
      const base = mode === 'open' || (mode === 'results' && !!inside(l.from).vent);
      const open = windowSet.has(l.name) ? windowSet.get(l.name) : roomSet.has(l.from) ? roomSet.get(l.from) : base;
      return [l.name, open ? l.openFactor : 0];
    })),
  };
  const solution = solveNetwork(net, conditions);
  const flows = flowStreams(net, solution, conditions);
  airflow = { solution, flows, conditions };
  view.setOpenWindows(new Set(Object.entries(conditions.open).filter(([, f]) => f > 0).map(([n]) => n)));
  $('windows-reset').hidden = !windowSet.size && !roomSet.size;
  // With a results file, temperatures belong to the results' own window states.
  const differs = results && (mode !== 'results' || [...windowSet.keys()].some((n) => !n.endsWith(':door')) || roomSet.size);
  $('stale').hidden = !differs;
  if (differs) {
    $('stale').textContent = `Windows differ from ${results.name}. Room temperatures are still the ones it recorded with its own windows, so the stack effect and two-way flows use temperatures that these windows would change over the following hours. A new EnergyPlus run would update them.`;
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
  if ($('color-by').value === 'pressure') legend();
  // The room flow takes a few hundred milliseconds, so it follows once the controls settle.
  clearTimeout(fieldTimer);
  fieldTimer = setTimeout(() => {
    if (!rooms || airflow?.flows !== flows) return;
    field = roomFlow(rooms, flows, { previous: field });
    air.setField(field, conditions);
  }, 120);
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
for (const id of ['t-out', 't-in', 'wind', 'wind-dir', 'windows']) $(id).addEventListener('input', () => { solveAir(); drawRose(); if (model) showInfo(view.find(selected)); });
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
  const data = windRoseData(weather.hours.filter((h) => h.month === month));
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1D2124';
  view.setGroundOverlay(windRoseGroup(data, {
    radius: view.footprintRadius() * 1.05, northAxis: model.site.northAxis, ink,
    wind: { direction: Number($('wind-dir').value), speed: Number($('wind').value) },
  }));
  legend();
}
$('show-rose').addEventListener('change', drawRose);
$('show-air').addEventListener('change', (e) => {
  air.setVisible(e.target.checked);
  if (e.target.checked) { solveAir(); air.play(); } else { air.stop(); air.clear(); }
  legend();
});
// Opening and closing windows one by one or room by room, from the details of what is selected.
$('info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !airflow) return;
  if (b.dataset.act === 'window') windowSet.set(b.dataset.name, b.dataset.open === '1');
  if (b.dataset.act === 'room') {
    roomSet.set(b.dataset.zone, b.dataset.open === '1');
    for (const l of net.links) if (l.from === b.dataset.zone) windowSet.delete(l.name);
  }
  solveAir();
  showInfo(view.find(selected));
  legend();
});
$('windows-reset').addEventListener('click', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(view.find(selected)); legend(); });
for (const id of ['windows', 'doors']) $(id).addEventListener('change', () => { windowSet.clear(); roomSet.clear(); solveAir(); if (model) showInfo(view.find(selected)); legend(); });

// Vertical section, along or across the footprint's long side.
function applySection() {
  const axis = $('section').value;
  $('section-at').disabled = $('section-flip').disabled = !axis;
  if (!model) return;
  const a = ((footprintAxis(model).azimuth - model.site.northAxis) * Math.PI) / 180;
  view.setSection(axis || null, Number($('section-at').value), $('section-flip').dataset.flip === '1', [Math.sin(a), Math.cos(a)]);
}
$('section').addEventListener('change', applySection);
$('section-at').addEventListener('input', applySection);
$('section-flip').addEventListener('click', (e) => { e.target.dataset.flip = e.target.dataset.flip === '1' ? '0' : '1'; applySection(); });

$('air-color').addEventListener('change', (e) => { air.colorBy = e.target.value; legend(); });
$('air-speed').addEventListener('input', (e) => { air.speed = Number(e.target.value); $('air-speed-value').textContent = `×${e.target.value}`; });
let selected = null;

// Weather: picking a day and hour fills in the outdoor conditions, which can still be edited.
function setWeather(w) {
  weather = w;
  weatherHour = null;
  applyHour();
}
function applyHour() {
  for (const id of ['day', 'hour']) $(id).disabled = !weather && !results;
  const day = Number($('day').value), hour = Number($('hour').value);
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  if (!weather) {
    $('when').textContent = results ? `${dateOf(day).label}, ${hh(hour - 1)}–${hh(hour)}` : '';
    $('when').title = '';
    solveAir();
    if (model) showInfo(view.find(selected));
    return;
  }
  weatherHour = outdoorAt(weather, day, hour);
  $('t-out').value = weatherHour.t;
  $('wind').value = weatherHour.windSpeed;
  $('wind-dir').value = weatherHour.windDirection;
  $('when').textContent = `${dateOf(day).label}, ${hh(hour - 1)}–${hh(hour)}`;
  $('when').title = `${weather.location.name}, ${weather.fileName || 'weather file'}: ${weatherHour.t} °C, wind ${weatherHour.windSpeed} m/s from ${weatherHour.windDirection}°, ${(weatherHour.w * 1000).toFixed(1)} g/kg humidity`;
  solveAir();
  drawRose();
  if (model) showInfo(view.find(selected));
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
  $('t-in-label').style.opacity = r ? 0.5 : 1;
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
  $('examples').innerHTML = list.map((e, i) => `<button class="quiet" data-i="${i}" title="${esc(e.file)}">${esc(e.label)}</button>`).join(' ');
  $('examples').addEventListener('click', (ev) => {
    const e = list[ev.target.dataset?.i];
    if (e) loadText(e.file, () => fetch(e.url).then((r) => r.text())).then(() => offerResults(e.id));
  });
}).catch(() => {});

// Details of the selected surface, window, zone or shading surface, and any checks that name it.
function showInfo(found) {
  const box = $('info');
  selected = found?.item?.name ?? null;
  if (!found) { box.hidden = true; return; }
  const { kind, item } = found;
  const rows = [];
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
  if (airflow && $('show-air').checked) {
    rows.push(...airLines(kind, item));
    if (kind === 'zone') rows.push(...roomButton(item.name));
    if (kind === 'surface') rows.push(...roomButton(item.zone));
  }
  for (const c of model.checks.filter((c) => c.objects.includes(item.name))) {
    const cls = c.level === 'error' ? 'error-text' : c.level === 'warning' ? 'warning-text' : 'muted';
    rows.push(`<span class="${cls}">${esc(c.message)}</span>`);
  }
  box.innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
  box.hidden = false;
}

// Air moving through a zone, or through a window, door or surface leak, from the latest solution.
function airLines(kind, item) {
  const m3h = (kg) => fmt((kg / 1.2) * 3600, 0);
  if (kind === 'zone') {
    const q = (airflow.flows.throughflow[net.zones.indexOf(item.name)] / 1.2) * 3600;
    const c = airflow.conditions.zones[item.name];
    return [`Air at ${fmt(c.t, 1)} °C${results ? ' (from results)' : ''}; ${fmt(q, 0)} m³/h through the zone, ${fmt(q / item.volume.value, 1)} air changes/h`];
  }
  // A wall between two zones is one link in the network, named after one of its two surfaces.
  let i = net.links.findIndex((l) => l.name === item.name);
  if (i < 0 && kind === 'surface' && item.adjacentSurface) i = net.links.findIndex((l) => l.name === item.adjacentSurface);
  if (i < 0) return [];
  const r = airflow.solution.links[i], l = net.links[i], other = l.to ?? 'outdoors';
  const what = l.type === 'crack' ? 'Leakage' : 'Air';
  const lines = [`${what}: ${m3h(r.forward)} m³/h ${esc(l.from)} → ${esc(other)}, ${m3h(r.backward)} m³/h ${esc(other)} → ${esc(l.from)}`];
  if (l.control === 'zone' || l.door) {
    const open = airflow.conditions.open[l.name] > 0, what = l.door ? 'door' : 'window';
    if (l.door) lines.push(open ? 'Open' : `Closed: leaks like a 1 cm gap under it`);
    lines.push(`<button class="quiet" data-act="window" data-name="${esc(l.name)}" data-open="${open ? 0 : 1}">${open ? 'Close' : 'Open'} this ${what}</button>`);
  }
  return lines;
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
  if ($('show-air').checked) {
    if ($('air-color').value === 'speed') {
      const stops = [0, 0.25, 0.5, 0.75, 1].map((x) => speedColor(SPEED_RANGE[0] * (SPEED_RANGE[1] / SPEED_RANGE[0]) ** x));
      items.push(`<span title="Particle colour: air speed, on a log scale (each step ten times faster)">${ramp(stops, 48)}Air speed ${SPEED_RANGE[0]} … ${SPEED_RANGE[1]} m/s</span>`);
    } else {
      items.push(`<span title="Particle colour: the temperature of the air they carry">${ramp([temperatureColor(14), temperatureColor(22), temperatureColor(30)])}Air 14–30 °C</span>`);
    }
  }
  if (view.problems.length) items.push(chip(PROBLEM, 'Named by a model check', 'The arrow shows the way EnergyPlus takes as outward, from the order of the corner points.'));
  $('legend').innerHTML = items.join('');
}

function setupCut() {
  const [lo, hi] = view.zRange;
  Object.assign($('cut'), { min: lo, max: hi, step: 0.1 });
  showCut(null);
}
// Slider and label for a cut height in model coordinates; null = no cut. Shown above the lowest floor.
function showCut(z) {
  $('cut').value = z === null ? $('cut').max : z;
  $('cut-value').textContent = z === null ? 'none' : `${fmt(z - Number($('cut').min), 1)} m`;
}
$('cut').addEventListener('input', (e) => {
  const z = Number(e.target.value) >= Number(e.target.max) ? null : Number(e.target.value);
  view.setCut(z);
  showCut(z);
});
$('color-by').addEventListener('change', (e) => { view.setColorBy(e.target.value); legend(); });
$('show-shading').addEventListener('change', (e) => view.setShadingVisible(e.target.checked));
$('fit').addEventListener('click', () => { view.setCut(null); showCut(null); view.frame(); });

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
  view.setModel(m, { doors: interiorDoors(m) });
  net = buildNetwork(m);
  rooms = prepareRoomFlow(voxelize(m), net);
  field = null;
  air.setGrid(rooms.g, Object.values(m.zones).reduce((s, z) => s + z.volume.value, 0));
  $('results-file').value = '';
  windowSet.clear(); roomSet.clear();
  $('section').value = '';
  applySection();
  setResults(null); // results belong to the previous model; this also solves the network
  if ($('show-air').checked) air.play();
  view.setColorBy($('color-by').value);
  view.setShadingVisible($('show-shading').checked);
  view.select(null);
  setupCut();
  legend();
}

$('checks').addEventListener('click', (e) => {
  const name = e.target.dataset?.name;
  if (!name) return;
  showCut(view.focus(name));
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
