// The room-air grid's own axes. Buildings are rarely set square to the model's x and y, so the cells
// are laid along the building's walls instead: the axes are turned about the vertical by the walls'
// prevailing direction. The solver works in these grid axes throughout (cells, velocities, the model
// and network handed to it, turned); the page turns points into them, and points and velocities back.
//
// The prevailing direction: each wall's horizontal run, as an angle, weighted by its length; walls at
// right angles to one another count as the same direction (angles are taken four times over, averaged
// as unit vectors, then divided by four), so a building of mostly square corners gets its own axes.
// Below a quarter of a degree the grid stays on the model's axes.

// { angle (radians, the grid's x from the model's x, anticlockwise), cos, sin }, or null for none.
export function gridFrame(model) {
  let sx = 0, cx = 0;
  for (const s of Object.values(model.surfaces || {})) {
    const v = s.vertices || [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      if (Math.abs(a[2] - b[2]) > 0.01) continue; // horizontal runs only
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const t = 4 * Math.atan2(dy, dx);
      sx += L * Math.sin(t); cx += L * Math.cos(t);
    }
  }
  if (!sx && !cx) return null;
  const angle = Math.atan2(sx, cx) / 4;
  if (Math.abs(angle) < (0.25 * Math.PI) / 180) return null;
  return { angle, cos: Math.cos(angle), sin: Math.sin(angle) };
}

// A point (or a velocity, for vectors) from the model's axes into the grid's, and back.
export const toGrid = (F, p) => (F ? [F.cos * p[0] + F.sin * p[1], -F.sin * p[0] + F.cos * p[1], p[2]] : p);
export const fromGrid = (F, p) => (F ? [F.cos * p[0] - F.sin * p[1], F.sin * p[0] + F.cos * p[1], p[2]] : p);

// The model and network as the grid sees them: every surface, window and door, and every link's
// opening, turned into the grid's axes (copies; the originals are untouched). Without a frame, as given.
export function inGridFrame(model, net, F) {
  if (!F) return { model, net };
  const turn = (o) => (o?.vertices ? { ...o, vertices: o.vertices.map((p) => toGrid(F, p)) } : o);
  const each = (m) => (m ? Object.fromEntries(Object.entries(m).map(([k, o]) => [k, turn(o)])) : m);
  return {
    model: { ...model, surfaces: each(model.surfaces), windows: each(model.windows), doors: each(model.doors) },
    net: net && { ...net, links: net.links.map(turn) },
  };
}
