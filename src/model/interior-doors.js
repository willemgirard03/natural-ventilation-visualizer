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

// Doors to add: one per pair of zones, on their largest shared wall that fits a door.
export function interiorDoors(model, door = DOOR) {
  const pairs = new Map();
  for (const s of Object.values(model.surfaces)) {
    if (s.boundary !== 'Surface' || !s.adjacentZone || s.zone === s.adjacentZone || s.name > s.adjacentSurface) continue;
    if (Math.abs(s.tilt - 90) > 1 || !model.surfaces[s.adjacentSurface]) continue;
    const [a, b] = [s.zone, s.adjacentZone];
    if (ELEVATOR.test(a) || ELEVATOR.test(b) || !(isCirculation(a) || isCirculation(b))) continue;
    const key = [a, b].sort().join('\u0000');
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
  return doors;
}
