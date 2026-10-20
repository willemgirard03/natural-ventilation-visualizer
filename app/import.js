import { importEpJSON, MODEL_VERSION } from '../src/model/import-epjson.js';
import { exportEpJSON, serializeEpJSON } from '../src/model/export-epjson.js';

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

async function load(file) {
  $('status').textContent = `Reading ${file.name}…`;
  try {
    const epjson = JSON.parse(await file.text());
    model = importEpJSON(epjson, { fileName: file.name });
  } catch (err) {
    model = null;
    $('status').innerHTML = `<span class="error-text">Could not read ${esc(file.name)}: ${esc(err.message)}</span>`;
    $('results').hidden = true;
    $('export').disabled = true;
    return;
  }
  $('status').textContent = file.name;
  $('export').disabled = false;
  render(model);
}

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
  $('checks').innerHTML = checks.length
    ? checks.map((c) => `<li class="${c.level}"><span class="level">${c.level}</span> ${esc(c.message)}</li>`).join('')
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
}

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
