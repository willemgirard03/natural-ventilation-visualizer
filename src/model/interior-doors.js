// Interior doors the tool adds where a model has none (decided 20 Oct, PLAN.md). ClimateStudio
// models often have no interior openings, so in an airflow network rooms would exchange air only
// through cracks and stairs could not act as stacks. One open door joins each room to each
// circulation zone it shares a wall with, and adjoining circulation zones to each other.
// Circulation is recognised by zone name; elevator shafts get no doors.

import { cross, dot, insidePolygon, unitNormal } from './geometry.js';

export const DOOR = { width: 0.9, height: 2.1, sill: 0.02, margin: 0.1 }; // m; sill and margin keep it off the wall's edges
export const CIRCULATION = /circ|corridor|hall|lobby|stair|vestib|foyer|atrium/i;
const ELEVATOR = /elev|lift/i;
export const isCirculation = (zone) => CIRCULATION.test(zone) && !ELEVATOR.test(zone);

// A door rectangle on a vertical wall, centred on the wall's bottom edge, with corners in EnergyPlus
// order (upper left first, counterclockwise seen from outside); null if the door does not fit.
export function doorOnWall(vertices, door = DOOR) {
  const n = unitNormal(vertices);
  if (Math.abs(n[2]) > 0.01) return null;
  const h = Math.hypot(n[0], n[1]);
  const out = [n[0] / h, n[1] / h, 0];
  const right = cross([0, 0, 1], out); // to the right, seen from outside
  const flat = vertices.map((p) => [dot(p, right), p[2]]);
  const zmin = Math.min(...flat.map((p) => p[1]));
  const bottom = flat.filter((p) => p[1] - zmin < 0.01).map((p) => p[0]);
  const mid = (Math.min(...bottom) + Math.max(...bottom)) / 2, half = door.width / 2, m = door.margin;
  const z0 = zmin + door.sill, z1 = z0 + door.height;
  const clear = [[mid - half - m, z1 + m], [mid - half - m, zmin + door.sill / 2], [mid + half + m, zmin + door.sill / 2], [mid + half + m, z1 + m]];
  if (!clear.every((p) => insidePolygon(p, flat))) return null;
  const d = dot(vertices[0], out);
  return [[mid - half, z1], [mid - half, z0], [mid + half, z0], [mid + half, z1]]
    .map(([s, z]) => [out[0] * d + right[0] * s, out[1] * d + right[1] * s, z]);
}

// The model's own doors (opaque Door subsurfaces, model.doors) as doors of the same shape as those
// added: one of each pair between zones (partnerZone the zone across), or to outdoors (partnerZone
// null). own: true (they are in the .epJSON already).
export function modelDoors(model) {
  const out = [], seen = new Set();
  for (const d of Object.values(model.doors || {})) {
    if (seen.has(d.name)) continue;
    const p = d.partner && model.doors[d.partner], s = model.surfaces[d.parent];
    if (p) seen.add(p.name);
    const partnerZone = p ? p.zone : s?.boundary === 'Surface' ? s.adjacentZone : null;
    out.push({
      name: d.name, surface: d.parent, zone: d.zone, partnerName: p?.name ?? null, partnerSurface: p?.parent ?? null, partnerZone,
      vertices: d.vertices, partnerVertices: p?.vertices ?? null, width: d.area / (d.height || 1), height: d.height, area: d.area, own: true,
    });
  }
  return out;
}

// The doors between rooms: the model's own, and (add) one added per pair of zones that has none, on
// their largest shared wall that fits a door.
export function interiorDoors(model, door = DOOR, { add = true } = {}) {
  const own = modelDoors(model);
  if (!add) return own;
  const pairKey = (a, b) => [a, b].sort().join('\u0000');
  const joined = new Set(own.filter((d) => d.partnerZone).map((d) => pairKey(d.zone, d.partnerZone)));
  const pairs = new Map();
  for (const s of Object.values(model.surfaces)) {
    if (s.boundary !== 'Surface' || !s.adjacentZone || s.zone === s.adjacentZone || s.name > s.adjacentSurface) continue;
    if (Math.abs(s.tilt - 90) > 1 || !model.surfaces[s.adjacentSurface]) continue;
    const [a, b] = [s.zone, s.adjacentZone];
    if (ELEVATOR.test(a) || ELEVATOR.test(b) || !(isCirculation(a) || isCirculation(b))) continue;
    const key = pairKey(a, b);
    if (joined.has(key)) continue;
    pairs.set(key, [...(pairs.get(key) || []), s]);
  }
  const doors = [];
  for (const walls of pairs.values()) {
    for (const s of walls.sort((x, y) => y.area - x.area)) {
      const vertices = doorOnWall(s.vertices, door);
      if (!vertices) continue;
      const partner = model.surfaces[s.adjacentSurface];
      doors.push({
        name: `${s.name}:door`, surface: s.name, zone: s.zone,
        partnerName: `${partner.name}:door`, partnerSurface: partner.name, partnerZone: partner.zone,
        vertices, partnerVertices: [...vertices].reverse().map((p) => [...p]),
        width: door.width, height: door.height, area: door.width * door.height,
      });
      break;
    }
  }
  return [...own, ...doors];
}
