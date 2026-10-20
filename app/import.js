import { importEpJSON, MODEL_VERSION } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';
import { View3D, TYPE_COLORS, PROBLEM, zoneColor } from './view3d.js';
import { interiorDoors, DOOR } from '../src/model/interior-doors.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { standardPressure } from '../src/solver/air.js';
import { AirflowParticles, temperatureColor } from './particles.js';

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

// Solves the network for the conditions in the Airflow controls and hands the flows to the particles.
function solveAir() {
  if (!model || !net) return;
  const loc = Object.values(model.epjson['Site:Location'] || {})[0] || {};
  const site = { elevation: loc.elevation ?? 0, latitude: loc.latitude ?? 45 };
  const open = $('windows-open').checked, tIn = Number($('t-in').value);
  const conditions = {
    site,
    outdoor: { t: Number($('t-out').value), w: 0.008, pressure: standardPressure(site.elevation), windSpeed: Number($('wind').value), windDirection: Number($('wind-dir').value) },
    zones: Object.fromEntries(net.zones.map((z) => [z, { t: tIn, w: 0.008 }])),
    open: Object.fromEntries(net.links.filter((l) => l.control === 'zone').map((l) => [l.name, open ? l.openFactor : 0])),
  };
  const solution = solveNetwork(net, conditions);
  const flows = flowStreams(net, solution, conditions);
  airflow = { solution, flows, conditions };
  air.setFlows(flows, conditions);
  const volume = Object.values(model.zones).reduce((s, z) => s + z.volume.value, 0);
  const m3h = (flows.outdoorIn / 1.2) * 3600;
  $('air-total').textContent = `Outdoor air ${fmt(m3h, 0)} m³/h · ${fmt(m3h / volume, m3h / volume < 1 ? 2 : 1)} air changes/h`;
  $('air-total').title = 'Outdoor air entering the building through windows, doors and leaks, from the airflow network. Air changes per hour: that flow divided by the volume of all zones.';
}
for (const id of ['t-out', 't-in', 'wind', 'wind-dir', 'windows-open']) $(id).addEventListener('input', () => { solveAir(); if (model) showInfo(view.find(selected)); });
$('show-air').addEventListener('change', (e) => {
  air.setVisible(e.target.checked);
  if (e.target.checked) air.play(); else { air.stop(); air.clear(); }
  legend();
});
$('air-speed').addEventListener('input', (e) => { air.speed = Number(e.target.value); $('air-speed-value').textContent = `×${e.target.value}`; });
let selected = null;

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
    if (e) loadText(e.file, () => fetch(e.url).then((r) => r.text()));
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
    rows.push(`<b>Door between ${esc(item.zone)} and ${esc(item.partnerZone)}</b>`, `${fmt(item.width, 2)} × ${fmt(item.height, 2)} m, open`,
      '<span class="muted">Added by the tool for the airflow network; the model has no interior openings here.</span>');
  } else if (kind === 'zone') {
    rows.push(`<b>Zone ${esc(item.name)}</b>`, `${fmt(item.floorArea.value, 1)} m² floor · ${fmt(item.volume.value, 0)} m³ · ${fmt(item.height, 2)} m high`);
  } else {
    rows.push(`<b>${esc(item.name)}</b>`, 'Shading surface');
  }
  if (airflow && $('show-air').checked) rows.push(...airLines(kind, item));
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
    return [`Air through the zone: ${fmt(q, 0)} m³/h, ${fmt(q / item.volume.value, 1)} air changes/h`];
  }
  const i = net.links.findIndex((l) => l.name === item.name);
  if (i < 0) return [];
  const r = airflow.solution.links[i], l = net.links[i], other = l.to ?? 'outdoors';
  const what = l.type === 'crack' ? 'Leakage' : 'Air';
  return [`${what}: ${m3h(r.forward)} m³/h ${esc(l.from)} → ${esc(other)}, ${m3h(r.backward)} m³/h ${esc(other)} → ${esc(l.from)}`];
}

function legend() {
  const chip = (color, label, title = '') => `<span${title ? ` title="${esc(title)}"` : ''}><i style="background:${color}"></i>${esc(label)}</span>`;
  const items = [];
  if ($('color-by').value === 'zone') {
    Object.keys(model.zones).forEach((z, i) => items.push(chip(`#${zoneColor(i).getHexString()}`, z)));
  } else {
    const types = new Set(Object.values(model.surfaces).map((s) => s.csType));
    for (const [t, c] of Object.entries(TYPE_COLORS)) if (types.has(t)) items.push(chip(c, t));
  }
  if (Object.keys(model.windows).length) items.push(chip(TYPE_COLORS.Glazing, 'Glazing'));
  if (view.doors.length) items.push(chip(TYPE_COLORS.Door, `Door, added (${view.doors.length})`, `The tool adds an open ${DOOR.width} × ${DOOR.height} m door between each room and the circulation zones it shares a wall with, and between adjoining circulation zones, so air can move through the building. Circulation is recognised by zone name (circulation, corridor, hall, lobby, stair, vestibule, foyer, atrium).`));
  if (model.shading.length) items.push(chip(TYPE_COLORS.Shading, 'Shading'));
  if ($('show-air').checked) items.push(`<span title="Particle colour: the temperature of the air they carry"><i style="background:linear-gradient(90deg,#${temperatureColor(14).getHexString()},#${temperatureColor(22).getHexString()},#${temperatureColor(30).getHexString()});width:36px"></i>Air 14–30 °C</span>`);
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
  air.setNetwork(net, m);
  solveAir();
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
