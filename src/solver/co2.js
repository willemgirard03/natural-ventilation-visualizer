// CO2 in each zone (PLAN.md, Thermal gains: CO2): a balance over the airflow network's flows,
//   rho V dC/dt = sum of inflows (m_in C_source) - m_out C + rho G,
// with C in ppm by volume, G the people's CO2 (m3/s) and m mass flows (kg/s). Stepped implicitly
// (backward Euler, split into parts when the air changes fast), so it is stable at any step.
// Generation and outdoor CO2 follow EnergyPlus: people x activity (W) x 3.82e-8 m3/s per W unless the
// People object says otherwise; outdoor CO2 from ZoneAirContaminantBalance's schedule.

import { hourlyValues } from '../model/schedules.js';
import { density, standardPressure } from './air.js';

const RHO = 1.2;

// CO2 generated in each zone at an hour index (m3/s), in the network's zone order.
export function co2Generation(model, zones, hour) {
  const sched = (name) => (name ? hourlyValues(model.epjson, name)?.[hour] ?? 1 : 1);
  return zones.map((z) => {
    const p = model.zones[z].people;
    if (!p) return 0;
    const people = p.density.value * model.zones[z].floorArea.value * sched(p.schedule);
    const activity = p.activityLevel ? hourlyValues(model.epjson, p.activityLevel.from.name)?.[hour] ?? p.activityLevel.value : 120;
    return people * activity * p.co2GenerationRate.value;
  });
}

// Outdoor air the zones' ideal-loads units supply at an hour index (kg/s), in the network's zone order.
// ClimateStudio's free-running models switch heating and cooling off, but each unit stays on and still
// supplies its DesignSpecification:OutdoorAir minimum, as EnergyPlus computes it: (people now x per-person
// rate + floor area x per-area rate + per-zone rate + volume x ACH) x the outdoor-air schedule, converted
// at standard density (20 C dry air at the site's pressure). That fresh air dilutes the zone's CO2.
export function outdoorAirSupply(model, zones, hour, elevation = 0) {
  const ep = model.epjson;
  const sched = (name) => (name ? hourlyValues(ep, name)?.[hour] ?? 1 : 1);
  const lists = ep['ZoneHVAC:EquipmentList'] || {}, units = ep['ZoneHVAC:IdealLoadsAirSystem'] || {};
  const connections = Object.values(ep['ZoneHVAC:EquipmentConnections'] || {});
  const rho = density(standardPressure(elevation), 20, 0);
  return zones.map((z) => {
    const list = lists[connections.find((c) => c.zone_name === z)?.zone_conditioning_equipment_list_name];
    let total = 0;
    for (const item of list?.equipment || []) {
      const unit = item.zone_equipment_object_type === 'ZoneHVAC:IdealLoadsAirSystem' && units[item.zone_equipment_name];
      const spec = unit && (ep['DesignSpecification:OutdoorAir'] || {})[unit.design_specification_outdoor_air_object_name];
      if (!spec || sched(unit.availability_schedule_name) <= 0) continue;
      const zone = model.zones[z], p = zone.people;
      const nominal = p ? p.density.value * zone.floorArea.value : 0;
      const people = unit.demand_controlled_ventilation_type === 'OccupancySchedule' ? nominal * sched(p?.schedule) : nominal;
      const parts = [people * (spec.outdoor_air_flow_per_person ?? 0.00944), zone.floorArea.value * (spec.outdoor_air_flow_per_zone_floor_area ?? 0),
        spec.outdoor_air_flow_per_zone ?? 0, (zone.volume.value * (spec.outdoor_air_flow_air_changes_per_hour ?? 0)) / 3600];
      const method = spec.outdoor_air_method || 'Flow/Person';
      const flow = { 'Flow/Person': parts[0], 'Flow/Area': parts[1], 'Flow/Zone': parts[2], AirChanges: parts[3], Sum: parts[0] + parts[1] + parts[2] + parts[3], Maximum: Math.max(...parts) }[method] ?? 0;
      total += flow * sched(spec.outdoor_air_schedule_name) * rho;
    }
    return total;
  });
}

// Outdoor CO2 at an hour index (ppm): EnergyPlus's schedule, or 400 ppm.
export function outdoorCO2(model, hour) {
  const balance = Object.values(model.epjson.ZoneAirContaminantBalance || {})[0];
  const v = balance?.outdoor_carbon_dioxide_schedule_name ? hourlyValues(model.epjson, balance.outdoor_carbon_dioxide_schedule_name)?.[hour] : null;
  return v ?? 400;
}

// One step of dt seconds: C (ppm, by zone index) to the new concentrations, with the network's
// solution for these flows, volumes (m3) and generation (m3/s) by zone, outdoor CO2 (ppm), and any
// mechanical outdoor air (kg/s by zone, from outdoorAirSupply), which leaves again at the zone's CO2.
// A window opened for one 10-minute step can change a room's air nine times over; one implicit step
// would leave a tenth of the excess CO2 behind, so the step is split until no zone changes its air
// more than once per part (as EnergyPlus shortens its own step when zones change fast).
export function stepCO2(net, solution, C, dt, volumes, generation, outdoor, supply = null) {
  const F = flowMatrix(net, solution, volumes, generation, outdoor, supply);
  const changes = Math.max(...F.map((row, z) => (row[z] * dt) / (RHO * volumes[z])));
  const parts = Math.min(60, Math.max(1, Math.ceil(changes)));
  for (let k = 0; k < parts; k++) C = solveStep(F, C, dt / parts, volumes);
  return C;
}

// The balance's flow terms: row z holds what leaves z on the diagonal, what enters it from other
// zones off the diagonal (negative), and the constant sources (generation, outdoor air) in the last column.
function flowMatrix(net, solution, volumes, generation, outdoor, supply) {
  const Z = net.zones.length;
  const F = Array.from({ length: Z }, () => new Float64Array(Z + 1));
  for (let z = 0; z < Z; z++) {
    F[z][Z] = RHO * generation[z] * 1e6;
    if (supply?.[z] > 0) { F[z][z] += supply[z]; F[z][Z] += supply[z] * outdoor; }
  }
  solution.links.forEach((r, i) => {
    const l = net.links[i];
    for (const [from, to, m] of [[l.n, l.m, r.forward], [l.m, l.n, r.backward]]) {
      if (!(m > 0)) continue;
      if (from >= 0) F[from][from] += m; // leaves `from`
      if (to >= 0) { // enters `to`, carrying the source's CO2
        if (from >= 0) F[to][from] -= m;
        else F[to][Z] += m * outdoor;
      }
    }
  });
  return F;
}

// One backward-Euler step, solved by Gaussian elimination (few zones).
function solveStep(F, C, dt, volumes) {
  const Z = F.length;
  const M = F.map((row, z) => {
    const r = Float64Array.from(row);
    r[z] += (RHO * volumes[z]) / dt;
    r[Z] += (RHO * volumes[z] * C[z]) / dt;
    return r;
  });
  for (let c = 0; c < Z; c++) {
    let p = c;
    for (let r = c + 1; r < Z; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < Z; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= Z; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(Z).fill(0);
  for (let r = Z - 1; r >= 0; r--) {
    let s = M[r][Z];
    for (let k = r + 1; k < Z; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// CO2 a zone would settle at with these flows held (ppm): the steady state of the balance.
export function steadyCO2(net, solution, volumes, generation, outdoor, supply = null) {
  const F = flowMatrix(net, solution, volumes, generation, outdoor, supply);
  return solveStep(F, new Array(net.zones.length).fill(outdoor), 1e9, volumes);
}
