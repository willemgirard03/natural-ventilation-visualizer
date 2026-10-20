// Polygon and solid geometry for EnergyPlus surfaces. Points are [x, y, z] in metres.
// EnergyPlus lists vertices counterclockwise seen from outside, so the area vector
// (Newell's method) points out of the zone.

export function areaVector(points) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1, z1] = points[i];
    const [x2, y2, z2] = points[(i + 1) % points.length];
    x += y1 * z2 - z1 * y2;
    y += z1 * x2 - x1 * z2;
    z += x1 * y2 - y1 * x2;
  }
  return [x / 2, y / 2, z / 2];
}

export const length = ([x, y, z]) => Math.hypot(x, y, z);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function area(points) {
  return length(areaVector(points));
}

export function unitNormal(points) {
  const v = areaVector(points);
  const n = length(v);
  return n ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

// Compass direction the surface faces, degrees clockwise from north (EnergyPlus convention).
// northAxis is the Building object's north axis: the angle of the model's y axis from true north.
export function azimuth(points, northAxis = 0) {
  const [nx, ny] = unitNormal(points);
  if (Math.hypot(nx, ny) < 1e-9) return null; // horizontal surface
  const a = (Math.atan2(nx, ny) * 180) / Math.PI + northAxis;
  return ((a % 360) + 360) % 360;
}

// 0 = facing up (roof), 90 = vertical (wall), 180 = facing down (floor).
export function tilt(points) {
  const nz = Math.max(-1, Math.min(1, unitNormal(points)[2]));
  return (Math.acos(nz) * 180) / Math.PI;
}

// Volume enclosed by outward-facing polygons (divergence theorem).
export function enclosedVolume(polygons) {
  let v = 0;
  for (const p of polygons) v += dot(p[0], areaVector(p));
  return v / 3;
}

export function bounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max };
}

// Largest distance of any point from the plane of a polygon.
export function distanceFromPlane(points, polygon) {
  const n = unitNormal(polygon);
  const d0 = dot(n, polygon[0]);
  return Math.max(...points.map((p) => Math.abs(dot(n, p) - d0)));
}

// Converts a zone's relative coordinates to building coordinates.
export function toBuilding(points, zone = {}) {
  const ox = zone.x_origin || 0, oy = zone.y_origin || 0, oz = zone.z_origin || 0;
  const r = ((zone.direction_of_relative_north || 0) * Math.PI) / 180;
  if (!ox && !oy && !oz && !r) return points;
  const c = Math.cos(r), s = Math.sin(r);
  return points.map(([x, y, z]) => [x * c + y * s + ox, -x * s + y * c + oy, z + oz]);
}

// Vertices from either epJSON layout: a "vertices" list, or numbered vertex_N_*_coordinate fields.
export function verticesOf(obj) {
  if (Array.isArray(obj.vertices)) {
    return obj.vertices.map((v) => [v.vertex_x_coordinate, v.vertex_y_coordinate, v.vertex_z_coordinate]);
  }
  const pts = [];
  for (let i = 1; obj[`vertex_${i}_x_coordinate`] !== undefined; i++) {
    pts.push([obj[`vertex_${i}_x_coordinate`], obj[`vertex_${i}_y_coordinate`], obj[`vertex_${i}_z_coordinate`]]);
  }
  return pts;
}
