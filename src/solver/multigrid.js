// Aggregation multigrid, used as the preconditioner of the grid solver's pressure solve (a graph
// Laplacian over the air cells, singular per connected region). Coarse levels merge 2 x 2 x 2 blocks
// of cells (within one region); the coarse operator is the fine one summed over the blocks (P^T A P
// with P piecewise constant). One V-cycle: symmetric Gauss-Seidel before and after the coarse
// correction (so the preconditioner stays symmetric for conjugate gradients), the coarse correction
// scaled up, as unsmoothed aggregation needs.

const COARSEST = 400; // cells: below this, many sweeps stand in for an exact solve
export const OVER_CORRECTION = 1.8;

// A level: n unknowns, rows of (neighbour, weight) in compressed form, the diagonal, and the block
// (coarse unknown) of each one. pos: [i, j, k] of each fine unknown on this level's lattice.
function level(n, start, adj, w, pos, region) {
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let k = start[i]; k < start[i + 1]; k++) diag[i] += w[k];
  return { n, start, adj, w, diag, pos, region };
}

export function buildHierarchy(start, adj, pos, region) {
  const levels = [level(start.length - 1, start, adj, new Float64Array(adj.length).fill(1), pos, region)];
  while (levels[levels.length - 1].n > COARSEST && levels.length < 12) {
    const L = levels[levels.length - 1];
    const key = new Map(), agg = new Int32Array(L.n), cpos = [], creg = [];
    for (let i = 0; i < L.n; i++) {
      const p = L.pos[i], kk = `${p[0] >> 1},${p[1] >> 1},${p[2] >> 1},${L.region[i]}`;
      let a = key.get(kk);
      if (a === undefined) { a = cpos.length; key.set(kk, a); cpos.push([p[0] >> 1, p[1] >> 1, p[2] >> 1]); creg.push(L.region[i]); }
      agg[i] = a;
    }
    const nc = cpos.length;
    if (nc >= L.n * 0.9) break; // no longer coarsening
    const rows = Array.from({ length: nc }, () => new Map());
    for (let i = 0; i < L.n; i++) for (let k = L.start[i]; k < L.start[i + 1]; k++) {
      const a = agg[i], b = agg[L.adj[k]];
      if (a !== b) rows[a].set(b, (rows[a].get(b) || 0) + L.w[k]);
    }
    const cs = new Int32Array(nc + 1), ca = [], cw = [];
    rows.forEach((r, a) => { for (const [b, wt] of r) { ca.push(b); cw.push(wt); } cs[a + 1] = ca.length; });
    L.agg = agg;
    levels.push(level(nc, cs, Int32Array.from(ca), Float64Array.from(cw), cpos, Int32Array.from(creg)));
  }
  for (const L of levels) { L.x = new Float64Array(L.n); L.b = new Float64Array(L.n); L.r = new Float64Array(L.n); }
  return levels;
}

// Gauss-Seidel sweeps on A x = b, forwards or backwards.
function sweep(L, x, b, backwards) {
  const { n, start, adj, w, diag } = L;
  for (let s = 0; s < n; s++) {
    const i = backwards ? n - 1 - s : s;
    if (!diag[i]) continue;
    let sum = b[i];
    for (let k = start[i]; k < start[i + 1]; k++) sum += w[k] * x[adj[k]];
    x[i] = sum / diag[i];
  }
}

// z = M^-1 r: one V-cycle from zero.
export function vcycle(levels, r, z, l = 0) {
  const L = levels[l];
  const x = l === 0 ? z : L.x, b = l === 0 ? r : L.b;
  x.fill(0);
  if (l === levels.length - 1) {
    for (let s = 0; s < 30; s++) { sweep(L, x, b, false); sweep(L, x, b, true); }
    return x;
  }
  sweep(L, x, b, false);
  // Residual, summed into the blocks.
  const C = levels[l + 1];
  C.b.fill(0);
  for (let i = 0; i < L.n; i++) {
    let ax = L.diag[i] * x[i];
    for (let k = L.start[i]; k < L.start[i + 1]; k++) ax -= L.w[k] * x[L.adj[k]];
    C.b[L.agg[i]] += b[i] - ax;
  }
  vcycle(levels, null, null, l + 1);
  for (let i = 0; i < L.n; i++) x[i] += OVER_CORRECTION * C.x[L.agg[i]];
  sweep(L, x, b, true);
  return x;
}
