// Reads an EnergyPlus .epJSON (from ClimateStudio or any other EnergyPlus tool) into the project model.
//
// The model keeps every EnergyPlus object exactly as read (model.epjson), so exporting is lossless.
// On top of it, it builds the views the tool works with: zones, classified surfaces, windows,
// constructions, ventilation and internal gains. Each setting read from the file is an
// "inherited" value that records the object and field it came from (see PLAN.md, Data model).

import { area, areaVector, azimuth, bounds, distanceFromPlane, dot, enclosedVolume, length, tilt, toBuilding, unitNormal, verticesOf } from './geometry.js';
import { constructionProperties } from './constructions.js';
import { hourlyValues, scheduleType, SUPPORTED_SCHEDULE_TYPES } from './schedules.js';

export const MODEL_VERSION = 1;

const inherited = (type, name, field, value) => ({ value, source: 'inherited', from: { type, name, field } });
const local = (value) => ({ value, source: 'local' });
const objects = (epjson, type) => Object.entries(epjson[type] || {});

// ClimateStudio's seven surface types (plus adiabatic variants) from EnergyPlus's surface type and
// outside boundary condition. Window and glazing door subsurfaces are "Glazing".
export function classifySurface(surfaceType, boundary) {
  const t = String(surfaceType).toLowerCase();
  const b = String(boundary).toLowerCase();
  const ground = b.startsWith('ground');
  const interior = b === 'surface' || b === 'zone' || b === 'space';
  if (b === 'adiabatic') return { wall: 'Adiabatic Wall', floor: 'Adiabatic Floor', roof: 'Adiabatic Roof', ceiling: 'Adiabatic Roof' }[t] || 'Unknown';
  if (t === 'wall') return ground ? 'Ground Wall' : interior ? 'Partition' : b === 'outdoors' ? 'Facade' : 'Unknown';
  if (t === 'floor') return ground ? 'Ground Slab' : interior ? 'Slab' : b === 'outdoors' ? 'External Floor' : 'Unknown';
  if (t === 'roof' || t === 'ceiling') return interior ? 'Slab' : b === 'outdoors' ? 'Roof' : 'Unknown';
  return 'Unknown';
}

// Zone name on a load object; ZoneList and Space references are not resolved yet.
const zoneOf = (o) => o.zone_or_zonelist_or_space_or_spacelist_name || o.zone_or_space_name || o.zone_name;

export function importEpJSON(epjson, { fileName = null } = {}) {
  const checks = [];
  const check = (level, code, message, objectNames = []) => checks.push({ level, code, message, objects: objectNames });

  const building = Object.values(epjson.Building || {})[0] || {};
  const northAxis = building.north_axis || 0;
  const geometryRules = Object.values(epjson.GlobalGeometryRules || {})[0] || {};
  const relative = String(geometryRules.coordinate_system || 'Relative').toLowerCase() === 'relative';
  const zoneFields = epjson.Zone || {};
  const place = (pts, zoneName) => (relative ? toBuilding(pts, zoneFields[zoneName]) : pts);

  // Zones
  const zones = {};
  for (const [name] of objects(epjson, 'Zone')) {
    zones[name] = { name, surfaces: [], windows: [], glazingArea: 0, ventilation: null, people: null, lights: null, equipment: null, infiltration: null };
  }

  // Surfaces
  const surfaces = {};
  for (const [name, s] of objects(epjson, 'BuildingSurface:Detailed')) {
    const vertices = place(verticesOf(s), s.zone_name);
    surfaces[name] = {
      name,
      zone: s.zone_name,
      surfaceType: s.surface_type,
      boundary: s.outside_boundary_condition,
      adjacentSurface: s.outside_boundary_condition_object || null,
      adjacentZone: null,
      csType: classifySurface(s.surface_type, s.outside_boundary_condition),
      construction: s.construction_name,
      vertices,
      area: area(vertices),
      azimuth: azimuth(vertices, northAxis),
      tilt: tilt(vertices),
      windows: [],
    };
    if (zones[s.zone_name]) zones[s.zone_name].surfaces.push(name);
    else check('error', 'surface-zone-missing', `Surface ${name} belongs to zone ${s.zone_name}, which does not exist.`, [name]);
  }
  for (const s of Object.values(surfaces)) {
    if (s.boundary !== 'Surface') continue;
    const other = surfaces[s.adjacentSurface];
    if (!other) check('error', 'interzone-partner-missing', `Surface ${s.name} faces ${s.adjacentSurface}, which does not exist.`, [s.name]);
    else {
      s.adjacentZone = other.zone;
      if (other.adjacentSurface !== s.name) check('error', 'interzone-not-reciprocal', `Surfaces ${s.name} and ${other.name} do not point at each other.`, [s.name, other.name]);
      else if (s.name < other.name && dot(unitNormal(s.vertices), unitNormal(other.vertices)) > -0.99) {
        check('warning', 'interzone-not-opposite', `Surfaces ${s.name} and ${other.name} are paired but do not face opposite ways; one has its vertices in reverse order.`, [s.name, other.name]);
      }
    }
  }
  for (const s of Object.values(surfaces)) {
    const t = s.surfaceType.toLowerCase();
    if ((t === 'floor' && s.tilt < 90) || ((t === 'roof' || t === 'ceiling') && s.tilt > 90)) {
      check('warning', 'surface-upside-down', `${s.surfaceType} ${s.name} faces ${s.tilt < 90 ? 'up' : 'down'}; its vertices are in reverse order.`, [s.name]);
    }
  }

  // Windows
  const windows = {};
  for (const [name, f] of objects(epjson, 'FenestrationSurface:Detailed')) {
    const parent = surfaces[f.building_surface_name];
    const zone = parent ? parent.zone : null;
    const vertices = place(verticesOf(f), zone);
    const b = bounds(vertices);
    windows[name] = {
      name,
      parent: f.building_surface_name,
      zone,
      surfaceType: f.surface_type,
      construction: f.construction_name,
      multiplier: f.multiplier || 1,
      vertices,
      area: area(vertices) * (f.multiplier || 1),
      azimuth: azimuth(vertices, northAxis),
      tilt: tilt(vertices),
      height: b.max[2] - b.min[2],
      bottom: b.min[2],
      operableFraction: null,
      sashType: local('casement'), // PLAN.md: casement is the default; EnergyPlus has no field for it
    };
    if (!parent) { check('error', 'window-parent-missing', `Window ${name} sits on ${f.building_surface_name}, which does not exist.`, [name]); continue; }
    parent.windows.push(name);
    zones[zone].windows.push(name);
    zones[zone].glazingArea += windows[name].area;
    if (distanceFromPlane(vertices, parent.vertices) > 0.01) check('warning', 'window-off-plane', `Window ${name} is not in the plane of its wall ${parent.name}.`, [name]);
    if (parent.csType !== 'Facade') check('info', 'window-not-on-facade', `Window ${name} is on a ${parent.csType} surface.`, [name]);
  }

  // Zone geometry: computed from surfaces, compared with the values the file declares
  for (const z of Object.values(zones)) {
    const polys = z.surfaces.map((n) => surfaces[n].vertices);
    const b = bounds(polys.flat());
    const volume = enclosedVolume(polys);
    const floorArea = z.surfaces.filter((n) => surfaces[n].surfaceType === 'Floor').reduce((s, n) => s + surfaces[n].area, 0);
    const declared = zoneFields[z.name];
    Object.assign(z, {
      floorArea: typeof declared.floor_area === 'number' ? inherited('Zone', z.name, 'floor_area', declared.floor_area) : local(floorArea),
      volume: typeof declared.volume === 'number' ? inherited('Zone', z.name, 'volume', declared.volume) : local(volume),
      computedFloorArea: floorArea,
      computedVolume: volume,
      bottom: b.min[2],
      top: b.max[2],
      height: b.max[2] - b.min[2],
    });
    // A closed zone's area vectors cancel; a single reversed surface leaves twice its own area vector.
    const vectors = z.surfaces.map((n) => areaVector(surfaces[n].vertices));
    const gap = vectors.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
    const totalArea = vectors.reduce((s, v) => s + length(v), 0);
    if (length(gap) > 1e-3 * totalArea) {
      const i = vectors.findIndex((v) => length([gap[0] - 2 * v[0], gap[1] - 2 * v[1], gap[2] - 2 * v[2]]) < 0.01 * length(gap));
      if (i >= 0) {
        const name = z.surfaces[i];
        z.computedVolume = enclosedVolume(polys.map((p, j) => (j === i ? [...p].reverse() : p)));
        check('warning', 'zone-surface-reversed', `Zone ${z.name} is not closed because surface ${name} faces into the zone; with it reversed, the zone encloses ${z.computedVolume.toFixed(1)} m3.`, [z.name, name]);
      } else {
        check('warning', 'zone-not-closed', `Zone ${z.name} is not closed: its surfaces leave a gap of about ${length(gap).toFixed(1)} m2.`, [z.name]);
      }
    }
    if (z.computedVolume <= 0) check('error', 'zone-negative-volume', `Zone ${z.name} does not enclose a positive volume; its surfaces face inwards.`, [z.name]);
    else if (Math.abs(z.volume.value - z.computedVolume) / z.computedVolume > 0.01) check('warning', 'zone-volume-mismatch', `Zone ${z.name}: declared volume ${z.volume.value.toFixed(1)} m3, surfaces enclose ${z.computedVolume.toFixed(1)} m3.`, [z.name]);
  }

  // Constructions
  const constructions = {};
  for (const [name] of objects(epjson, 'Construction')) {
    constructions[name] = constructionProperties(epjson, name);
    if (constructions[name].missingLayers.length) check('error', 'material-missing', `Construction ${name} uses undefined materials: ${constructions[name].missingLayers.join(', ')}.`, [name]);
  }
  for (const s of [...Object.values(surfaces), ...Object.values(windows)]) {
    if (!constructions[s.construction]) check('error', 'construction-missing', `${s.name} uses construction ${s.construction}, which does not exist.`, [s.name]);
  }
  const defaults = Object.values(surfaces).filter((s) => /^default/i.test(s.construction)).map((s) => s.name);
  if (defaults.length) check('warning', 'default-construction', `${defaults.length} surfaces use a default construction, probably because none was assigned.`, defaults);

  // Natural ventilation (simple airflow): ClimateStudio writes one stack object per zone (wind term off)
  // and wind objects per facade direction or per window (stack term off). Opening area = glazing area x operable fraction.
  for (const [name, v] of objects(epjson, 'ZoneVentilation:WindandStackOpenArea')) {
    const z = zones[v.zone_or_space_name];
    if (!z) { check('error', 'ventilation-zone-missing', `Ventilation ${name} refers to a missing zone.`, [name]); continue; }
    if (!z.ventilation) z.ventilation = { stack: [], wind: [], other: [] };
    const T = 'ZoneVentilation:WindandStackOpenArea';
    const entry = {
      name,
      openingArea: inherited(T, name, 'opening_area', v.opening_area),
      schedule: v.opening_area_fraction_schedule_name,
      effectiveAngle: v.effective_angle,
      dischargeCoefficient: v.discharge_coefficient_for_opening,
      heightDifference: v.height_difference,
      controls: {
        minIndoorTemperature: inherited(T, name, 'minimum_indoor_temperature', v.minimum_indoor_temperature),
        maxIndoorTemperature: inherited(T, name, 'maximum_indoor_temperature', v.maximum_indoor_temperature),
        deltaTemperature: inherited(T, name, 'delta_temperature', v.delta_temperature),
        minOutdoorTemperature: inherited(T, name, 'minimum_outdoor_temperature', v.minimum_outdoor_temperature),
        maxOutdoorTemperature: inherited(T, name, 'maximum_outdoor_temperature', v.maximum_outdoor_temperature),
        maxWindSpeed: inherited(T, name, 'maximum_wind_speed', v.maximum_wind_speed),
      },
    };
    const windOff = v.opening_effectiveness === 0;
    const stackOff = v.discharge_coefficient_for_opening === 0;
    (windOff && !stackOff ? z.ventilation.stack : stackOff && !windOff ? z.ventilation.wind : z.ventilation.other).push(entry);
  }
  for (const z of Object.values(zones)) {
    const vent = z.ventilation;
    if (!vent) continue;
    const main = vent.stack[0] || vent.other[0] || vent.wind[0];
    const total = vent.stack.length ? vent.stack.reduce((s, e) => s + e.openingArea.value, 0)
      : vent.other.length ? vent.other.reduce((s, e) => s + e.openingArea.value, 0)
      : vent.wind.reduce((s, e) => s + e.openingArea.value, 0);
    vent.openingArea = total;
    vent.controls = main.controls;
    vent.schedule = main.schedule;
    if (vent.stack.length && vent.wind.length) {
      const windTotal = vent.wind.reduce((s, e) => s + e.openingArea.value, 0);
      if (Math.abs(windTotal - total) > 0.01 * total) check('info', 'wind-stack-area-differ', `Zone ${z.name}: wind opening areas sum to ${windTotal.toFixed(2)} m2, the stack area is ${total.toFixed(2)} m2.`, [z.name]);
    }
    if (!z.glazingArea) { check('warning', 'ventilation-without-windows', `Zone ${z.name} has natural ventilation but no windows.`, [z.name]); continue; }
    vent.operableFraction = { value: total / z.glazingArea, source: 'inherited', from: { type: 'ZoneVentilation:WindandStackOpenArea', name: main.name, field: 'opening_area', derived: 'opening area / glazing area' } };
    for (const w of z.windows) windows[w].operableFraction = vent.operableFraction;
  }
  const unventilated = Object.values(zones).filter((z) => z.windows.length && !z.ventilation).map((z) => z.name);
  if (unventilated.length) check('info', 'windows-not-operable', `${unventilated.length} zones have windows but no natural ventilation.`, unventilated);

  // Internal gains and infiltration
  for (const [name, p] of objects(epjson, 'People')) {
    const z = zones[zoneOf(p)];
    if (!z) { check('warning', 'load-zone-unresolved', `People ${name} refers to ${zoneOf(p)}, which is not a zone (zone lists are not read yet).`, [name]); continue; }
    const method = p.number_of_people_calculation_method;
    const fa = z.floorArea.value;
    const density = method === 'People/Area' ? p.people_per_floor_area
      : method === 'People' ? p.number_of_people / fa
      : method === 'Area/Person' ? 1 / p.floor_area_per_person : null;
    const field = { 'People/Area': 'people_per_floor_area', People: 'number_of_people', 'Area/Person': 'floor_area_per_person' }[method];
    const activity = hourlyValues(epjson, p.activity_level_schedule_name);
    z.people = {
      name,
      density: inherited('People', name, field, density),
      activityLevel: activity ? inherited(scheduleType(epjson, p.activity_level_schedule_name), p.activity_level_schedule_name, 'W/person', Math.max(...activity)) : null,
      schedule: p.number_of_people_schedule_name,
      co2GenerationRate: inherited('People', name, 'carbon_dioxide_generation_rate', p.carbon_dioxide_generation_rate ?? 3.82e-8),
      sensibleHeatFraction: p.sensible_heat_fraction ?? 'Autocalculate',
      fractionRadiant: p.fraction_radiant,
    };
  }
  const perArea = (type, name, o, z) => {
    const m = o.design_level_calculation_method;
    if (m === 'Watts/Area') return inherited(type, name, 'watts_per_zone_floor_area', o.watts_per_zone_floor_area);
    if (m === 'LightingLevel' || m === 'EquipmentLevel') return inherited(type, name, m === 'LightingLevel' ? 'lighting_level' : 'design_level', (o.lighting_level ?? o.design_level) / z.floorArea.value);
    return null;
  };
  for (const [type, key] of [['Lights', 'lights'], ['ElectricEquipment', 'equipment']]) {
    for (const [name, o] of objects(epjson, type)) {
      const z = zones[zoneOf(o)];
      if (!z) { check('warning', 'load-zone-unresolved', `${type} ${name} refers to ${zoneOf(o)}, which is not a zone.`, [name]); continue; }
      z[key] = { name, powerDensity: perArea(type, name, o, z), schedule: o.schedule_name, fractionRadiant: o.fraction_radiant };
    }
  }
  for (const [name, o] of objects(epjson, 'ZoneInfiltration:DesignFlowRate')) {
    const z = zones[zoneOf(o)];
    if (!z) continue;
    // Design flow in m3/s for every EnergyPlus method, then as air changes per hour for comparison.
    // Exterior area is the gross area of the zone's surfaces facing outdoors, as EnergyPlus uses it.
    const exterior = (wallsOnly) => z.surfaces.map((n) => surfaces[n])
      .filter((s) => s.boundary === 'Outdoors' && (!wallsOnly || s.surfaceType === 'Wall')).reduce((a, s) => a + s.area, 0);
    const method = o.design_flow_rate_calculation_method;
    const [field, flow] = {
      'Flow/Zone': ['design_flow_rate', o.design_flow_rate],
      'Flow/Area': ['flow_rate_per_floor_area', o.flow_rate_per_floor_area * z.floorArea.value],
      'Flow/ExteriorArea': ['flow_rate_per_exterior_surface_area', o.flow_rate_per_exterior_surface_area * exterior(false)],
      'Flow/ExteriorWallArea': ['flow_rate_per_exterior_surface_area', o.flow_rate_per_exterior_surface_area * exterior(true)],
      'AirChanges/Hour': ['air_changes_per_hour', (o.air_changes_per_hour * z.volume.value) / 3600],
    }[method] || [null, null];
    if (flow === null) check('info', 'infiltration-method-unknown', `Infiltration ${name} uses ${method}, which the tool cannot read yet.`, [name]);
    z.infiltration = {
      name,
      method,
      designValue: field ? inherited('ZoneInfiltration:DesignFlowRate', name, field, o[field]) : null,
      flowRate: flow,
      airChangesPerHour: flow === null ? null : (flow * 3600) / z.volume.value,
      schedule: o.schedule_name,
    };
  }

  // Schedules referenced by the model's settings
  const used = new Set();
  for (const z of Object.values(zones)) {
    for (const s of [z.ventilation?.schedule, z.people?.schedule, z.lights?.schedule, z.equipment?.schedule, z.infiltration?.schedule]) if (s) used.add(s);
  }
  for (const s of used) {
    const type = scheduleType(epjson, s);
    if (!type) check('error', 'schedule-missing', `Schedule ${s} does not exist.`, [s]);
    else if (!SUPPORTED_SCHEDULE_TYPES.includes(type)) check('info', 'schedule-unsupported', `Schedule ${s} is a ${type}, which the tool cannot read yet.`, [s]);
  }

  const shading = objects(epjson, 'Shading:Building:Detailed').concat(objects(epjson, 'Shading:Site:Detailed'))
    .map(([name, s]) => ({ name, vertices: verticesOf(s) }));

  const version = Object.values(epjson.Version || {})[0]?.version_identifier || null;
  const timestep = Object.values(epjson.Timestep || {})[0]?.number_of_timesteps_per_hour ?? null;
  return {
    modelVersion: MODEL_VERSION,
    source: { format: 'epJSON', fileName, energyPlusVersion: version },
    site: { terrain: building.terrain || 'Suburbs', northAxis, timestepsPerHour: timestep },
    zones,
    surfaces,
    windows,
    constructions,
    shading,
    checks,
    epjson,
  };
}
