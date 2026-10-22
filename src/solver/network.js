// The tool's airflow network solver: zone pressures and the flow through every crack, window and
// door at one moment. It follows EnergyPlus 23.1's AirflowNetwork (multizone, no distribution)
// equation for equation, so its results can be checked against EnergyPlus's own network run
// (PLAN.md, EnergyPlus foundation). Sources: EnergyPlus src/EnergyPlus/AirflowNetwork/src/
// Solver.cpp (calculate_Cps, airmov, filjac) and Elements.cpp (SurfaceCrack, SimpleOpening,
// generic_crack, pstack), read 20 Oct 2026.
//
// Conventions as in EnergyPlus: each link joins its surface's zone (node 1) to the adjacent zone or
// outdoors (node 2); positive flow runs from node 1 to node 2; heights are model z in metres.

import { area, azimuth, bounds, tilt } from '../model/geometry.js';
import { footprintAxis, networkElements } from '../model/airflow-network.js';
import { density, viscosity, gravity, standardPressure, weatherStation, windSpeedAt, GROUND_TEMPERATURE_OFFSET } from './air.js';

// Surface-averaged wind pressure coefficients (EnergyPlus calculate_Cps, low-rise building):
// Swami and Chandra's correlation for the four walls of the footprint rectangle, a table for the roof,
// both tabulated every 30 degrees of wind direction and interpolated linearly.
const ROOF_TABLE = [
  [-0.28, -0.69, -0.72, -0.76, -0.72, -0.69, -0.28, -0.69, -0.72, -0.76, -0.72, -0.69], // side ratio 0.25
  [-0.47, -0.52, -0.70, -0.76, -0.70, -0.52, -0.47, -0.52, -0.70, -0.76, -0.70, -0.52], // 0.5
  [-0.70, -0.55, -0.55, -0.70, -0.55, -0.55, -0.70, -0.55, -0.55, -0.70, -0.55, -0.55], // 1.0
];

export function windPressureTables(axisAzimuth, ratio) {
  const facadeAngle = [0, 1, 2, 3].map((k) => (axisAzimuth + k * 90) % 360).concat((axisAzimuth + 90) % 360);
  return facadeAngle.map((angle, f) => {
    const sideRatio = f === 1 || f === 3 ? 1 / ratio : ratio;
    const vals = [];
    for (let k = 0; k < 12; k++) {
      let inc = Math.abs(k * 30 - angle);
      if (inc > 180) inc = 360 - inc;
      if (f < 4) {
        const r = (inc * Math.PI) / 180, g = Math.log(sideRatio), c = Math.cos(r / 2);
        vals.push(0.6 * Math.log(1.248 - 0.703 * Math.sin(r / 2) - 1.175 * Math.sin(r) ** 2 + 0.131 * Math.sin(2 * r * g) ** 3
          + 0.769 * c + 0.07 * (g * Math.sin(r / 2)) ** 2 + 0.717 * c ** 2));
      } else {
        const sr = Math.min(Math.max(sideRatio, 0.25), 1);
        const [isr, wsr] = sr < 0.5 ? [0, (0.5 - sr) / 0.25] : [1, (1 - sr) / 0.5];
        const ia = Math.floor(inc / 30), wa = 1 - (inc % 30) / 30;
        const row = (t) => wa * t[ia] + (1 - wa) * t[Math.min(ia + 1, 11)];
        vals.push(wsr * row(ROOF_TABLE[isr]) + (1 - wsr) * row(ROOF_TABLE[isr + 1]));
      }
    }
    vals.push(vals[0]); // 360 degrees
    return { angle, vals };
  });
}

export function windPressureCoefficient(table, windDirection) {
  const d = ((windDirection % 360) + 360) % 360;
  const i = Math.min(Math.floor(d / 30), 11), w = (d - i * 30) / 30;
  return (1 - w) * table.vals[i] + w * table.vals[i + 1];
}

// Facade of an exterior surface: the nearest of the four wall directions, or the roof (index 4).
function facadeOf(points, tables, northAxis) {
  if (tilt(points) < 45) return 4;
  const az = azimuth(points, northAxis);
  let best = 0, bestDiff = Infinity;
  for (let f = 0; f < 4; f++) {
    let d = Math.abs(az - tables[f].angle);
    if (d > 359) d = Math.abs(d - 360);
    if (d < bestDiff) { bestDiff = d; best = f; }
  }
  return best;
}

// A surface's centre as EnergyPlus computes it (SurfaceGeometry CalcSurfaceCentroid), which sets the
// height of its link. Collinear corners are dropped first, as EnergyPlus does on input. Then:
// 3 corners, the triangle's centroid; 4, two triangles weighted by area; 5 or more, the plain
// average of the corners. For an L-shaped roof plane the average sits well above the area centroid.
export function energyPlusCentroid(points) {
  const span = Math.max(...[0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]))));
  const pts = points.filter((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    const u = p.map((c, k) => c - a[k]), v = b.map((c, k) => c - p[k]);
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 1e-9 * span * span;
  });
  const mean = (list) => [0, 1, 2].map((k) => list.reduce((s, p) => s + p[k], 0) / list.length);
  if (pts.length !== 4) return mean(pts);
  const total = area(pts);
  let t1 = [pts[0], pts[1], pts[2]], t2 = [pts[0], pts[2], pts[3]];
  let w1 = area(t1) / total, w2 = area(t2) / total;
  if (w1 + w2 > 1.05) { // concave along the first diagonal: use the other one
    t1 = [pts[0], pts[1], pts[3]]; t2 = [pts[1], pts[2], pts[3]];
    const a1 = area(t1), a2 = area(t2);
    w1 = a1 / (a1 + a2); w2 = a2 / (a1 + a2);
  }
  const c1 = mean(t1), c2 = mean(t2);
  return [0, 1, 2].map((k) => w1 * c1[k] + w2 * c2[k]);
}

// The network for a model, ready to solve at any moment.
export function buildNetwork(model, options = {}) {
  const { zones, links, options: o } = networkElements(model, options);
  const axis = footprintAxis(model);
  // EnergyPlus writes the axis and ratio rounded, as toAirflowNetwork does.
  const tables = windPressureTables(Math.round(axis.azimuth * 10) / 10, Math.round(axis.ratio * 1000) / 1000);
  const index = Object.fromEntries(zones.map((z, i) => [z, i]));
  return {
    zones,
    terrain: model.site.terrain || 'Suburbs',
    station: weatherStation(model.epjson),
    tables,
    options: o,
    links: links.map((l) => {
      const b = bounds(l.vertices);
      const height = b.max[2] - b.min[2];
      const c = energyPlusCentroid(l.vertices);
      return {
        ...l,
        n: index[l.from],
        m: l.to === null ? -1 : index[l.to],
        z: c[2],
        width: height > 0 ? area(l.vertices) / height : Math.sqrt(area(l.vertices)),
        height,
        tilt: tilt(l.vertices),
        facade: l.to === null ? facadeOf(l.vertices, tables, model.site.northAxis) : null,
      };
    }),
  };
}

// Reference conditions of the cracks (AFN Reference Conditions: 20 degC, 101325 Pa, dry air).
const REF_DENSITY = density(101325, 20, 0);
const REF_VISCOSITY = viscosity(20);
const MIN_DENSITY_DIFFERENCE = 0.0001; // kg/m3, below this an opening carries one-way flow

// Power-law flow (EnergyPlus generic_crack / SurfaceCrack): flow F (kg/s) and dF/dP for a pressure
// drop dp from node 1 to node 2, laminar near zero. coef is the flow coefficient at 1 Pa.
export function powerLaw(coef, n, dp, a, b) {
  const up = dp >= 0 ? a : b;
  const tAve = 0.5 * (a.t + b.t), visAve = 0.5 * (a.mu + b.mu);
  const rhoCor = (up.t + 273.15) / (tAve + 273.15);
  const ctl = (REF_DENSITY / up.rho / rhoCor) ** (n - 1) * (REF_VISCOSITY / visAve) ** (2 * n - 1);
  const cdm = (coef / Math.sqrt(up.rho)) * (up.rho / up.mu) * ctl;
  const fl = cdm * dp;
  const ft = coef * Math.abs(dp) ** n * ctl;
  if (Math.abs(fl) <= ft) return { f: [fl], df: [cdm] };
  const f = Math.sign(dp) * ft;
  return { f: [f], df: [(f * n) / dp] };
}

// Simple opening (EnergyPlus SimpleOpening::calculate): one- or two-way flow through a window or door.
// As in EnergyPlus, dp is the pressure difference at the opening's centroid, used as if at its bottom.
// When both sides have nearly the same density, EnergyPlus computes an open opening's flow with its
// closed leakage coefficient, so an open door between rooms at one temperature carries almost
// nothing. Unless `exact`, the tool treats it as the open orifice it is: Cd A sqrt(2 rho dp).
export function simpleOpening(l, open, dp, a, b, exact = false) {
  let width = l.width, height = l.height;
  const perimeterCoef = l.closedCoefficient * 2 * (width + height);
  const coefClosed = perimeterCoef / Math.sqrt(dp >= 0 ? a.rho : b.rho);
  if (open <= 0) return powerLaw(coefClosed, l.exponent, dp, a, b);
  width *= open;
  if (l.tilt < 90) height *= Math.sin((l.tilt * Math.PI) / 180);
  const drho = a.rho - b.rho, gdrho = 9.8 * drho;
  if (Math.abs(drho) < MIN_DENSITY_DIFFERENCE) {
    const mid = dp - 0.5 * height * gdrho;
    if (exact) return powerLaw(coefClosed, l.exponent, mid, a, b);
    const k = l.dischargeCoefficient * width * height * Math.sqrt(2 * (mid >= 0 ? a.rho : b.rho));
    const lin = 1e-4; // Pa: linear below this, to keep the slope finite at zero
    if (Math.abs(mid) < lin) return { f: [(k * mid) / Math.sqrt(lin)], df: [k / Math.sqrt(lin)] };
    const f = Math.sign(mid) * k * Math.sqrt(Math.abs(mid));
    return { f: [f], df: [f / (2 * mid)] };
  }
  const y = dp / gdrho; // neutral plane above the bottom
  const neutral = Math.min(1, Math.max(0, y / height));
  const c = Math.SQRT2 * width * l.dischargeCoefficient;
  const df0 = (c * Math.sqrt(Math.abs(dp))) / Math.abs(gdrho);
  const f0 = (2 / 3) * c * Math.sqrt(Math.abs(gdrho * y)) * Math.abs(y);
  const dfh = c * Math.sqrt(Math.abs((height - y) / gdrho));
  const fh = (2 / 3) * dfh * Math.abs(gdrho * (height - y));
  const sa = Math.sqrt(a.rho), sb = Math.sqrt(b.rho);
  if (y <= 0) return drho >= 0 ? { f: [-sb * Math.abs(fh - f0)], df: [sb * Math.abs(dfh - df0)], neutral } : { f: [sa * Math.abs(fh - f0)], df: [sa * Math.abs(dfh - df0)], neutral };
  if (y >= height) return drho >= 0 ? { f: [sa * Math.abs(fh - f0)], df: [sa * Math.abs(dfh - df0)], neutral } : { f: [-sb * Math.abs(fh - f0)], df: [sb * Math.abs(dfh - df0)], neutral };
  return drho >= 0 ? { f: [-sb * fh, sa * f0], df: [sb * dfh, sa * df0], neutral } : { f: [sa * fh, -sb * f0], df: [sa * dfh, sb * df0], neutral };
}

// A window hinged along its top (awning) or bottom (hopper), as EnergyPlus's horizontally pivoted
// detailed opening (AirflowNetwork:MultiZone:Component:DetailedOpening, type 2, Elements.cpp): the sash
// turned by `angle` about an axis at the hinge leaves the full width free where it has swung clear
// (above h4 for a hopper, below h2 for an awning) and, where it still covers the frame, only the
// triangular gaps at its sides, 2 |axis - z| tan(angle) wide, in series with the frame. The flow is
// summed over 20 strips (EnergyPlus's NrInt), each an orifice at its own pressure difference: dp is at
// the window's centre (the network's link height) and the stack changes it with height. A hopper
// therefore passes most of its air near its top, in and out, and an awning near its bottom. The tool's
// reruns write hoppers and awnings as these openings, with the opening factor = angle / 90 degrees.
export const PIVOT_STRIPS = 20;
export function pivotedOpening(l, angle, dp, a, b, type) {
  let height = l.height;
  if (l.tilt < 90) height *= Math.sin((l.tilt * Math.PI) / 180);
  const alpha = (Math.min(90, Math.max(0, angle)) * Math.PI) / 180, cos = Math.cos(alpha), tan = Math.tan(alpha);
  const axis = type === 'hopper' ? 0 : height;
  let h2 = axis * (1 - cos), h4 = axis + (height - axis) * cos;
  if (alpha >= Math.PI / 2 - 1e-9) h2 = h4 = axis;
  const dz = height / PIVOT_STRIPS, gdrho = 9.8 * (a.rho - b.rho), lin = 1e-4, cd = l.dischargeCoefficient;
  const f = [0, 0], df = [0, 0]; // positive (a to b), negative
  for (let i = 0; i < PIVOT_STRIPS; i++) {
    const z = (i + 0.5) * dz, d = dp - gdrho * (z - height / 2); // the pressure difference at this height
    const root = Math.sqrt(2 * (d >= 0 ? a.rho : b.rho));
    let k = cd * l.width * dz * root; // the strip, full width
    if (z > h2 && z < h4) { // still covered by the sash: its side gaps, in series with the frame
      const c2 = 2 * cd * Math.abs(axis - z) * tan * dz * root;
      k = k > 0 && c2 > 0 ? 1 / Math.sqrt(1 / (k * k) + 1 / (c2 * c2)) : 0;
    }
    const [q, dq] = Math.abs(d) < lin ? [(k * d) / Math.sqrt(lin), k / Math.sqrt(lin)] : [Math.sign(d) * k * Math.sqrt(Math.abs(d)), k / (2 * Math.sqrt(Math.abs(d)))];
    const j = q >= 0 ? 0 : 1;
    f[j] += q; df[j] += dq;
  }
  // The neutral plane: where the pressure difference changes sign, from the bottom.
  const neutral = Math.abs(gdrho) > 1e-9 ? Math.min(1, Math.max(0, (dp / gdrho + height / 2) / height)) : undefined;
  const out = { f: [], df: [], neutral };
  for (const j of [0, 1]) if (f[j] !== 0 || df[j] !== 0) { out.f.push(f[j]); out.df.push(df[j]); }
  if (!out.f.length) { out.f.push(0); out.df.push(1e-12); }
  return out;
}

// Pressure change climbing height h in air of density rho from pressure p0 (EnergyPlus psz).
const climb = (p0, rho, h, g) => -p0 * (1 - Math.exp((-h * rho * g) / p0));

// Solves the network at one moment.
//   conditions.outdoor: { t, w, pressure (Pa), windSpeed (m/s at the weather station), windDirection (deg) }
//   conditions.zones:   { [zone]: { t, w } }
//   conditions.open:    { [link name]: open factor 0-1 } for windows under zone control, or to open or
//                       close any other window or door for this moment (doors are otherwise open)
//   conditions.site:    { elevation, latitude }
//   conditions.sashes:  { [window name]: { type, angle } }: hoppers and awnings open by angle (degrees) are
//                       pivoted openings (pivotedOpening), as the tool's reruns write them
// Returns zone pressures (Pa, relative to outdoors at ground level) and each link's flow both ways (kg/s).
// exactEnergyPlus: reproduce EnergyPlus also where it treats an open opening as closed (see simpleOpening).
export function solveNetwork(net, conditions, { tolerance = 1e-10, maxIterations = 100, exactEnergyPlus = false } = {}) {
  const { outdoor, site = { elevation: 0, latitude: 45 } } = conditions;
  const pStd = standardPressure(site.elevation), g = gravity(site.latitude);
  const zoneState = net.zones.map((z) => {
    const s = conditions.zones[z];
    return { t: s.t, w: s.w, rho: density(pStd, s.t, s.w), mu: viscosity(s.t) };
  });
  const rhoWind = density(outdoor.pressure, outdoor.t + GROUND_TEMPERATURE_OFFSET, outdoor.w);
  const rhoOutdoorClimb = density(outdoor.pressure, outdoor.t, outdoor.w);
  const links = net.links.map((l) => {
    const a = zoneState[l.n];
    let b, pOut = 0;
    if (l.m < 0) {
      const v = windSpeedAt(l.z, outdoor.windSpeed, net.terrain, net.station);
      pOut = windPressureCoefficient(net.tables[l.facade], outdoor.windDirection) * 0.5 * rhoWind * v * v;
      b = { t: outdoor.t, w: outdoor.w, rho: density(pStd + pOut, outdoor.t, outdoor.w), mu: viscosity(outdoor.t) };
    } else b = zoneState[l.m];
    // Stack: pressure at the link's height on each side, from each node at ground level.
    const rhoA = density(outdoor.pressure, a.t, a.w);
    const rhoB = l.m < 0 ? rhoOutdoorClimb : density(outdoor.pressure, b.t, b.w);
    const stack = climb(outdoor.pressure, rhoA, l.z, g) - climb(outdoor.pressure, rhoB, l.z, g);
    let open = 1;
    if (l.type === 'opening') open = conditions.open?.[l.name] ?? (l.control === 'open' ? l.openFactor : 0);
    const sash = conditions.sashes?.[l.name];
    const pivoted = (sash?.type === 'hopper' || sash?.type === 'awning') && sash.angle > 0 ? sash : null;
    return { l, a, b, pOut, stack, open, pivoted };
  });

  const N = net.zones.length;
  const p = new Array(N).fill(0);
  const evaluate = () => {
    const sum = new Array(N).fill(0), scale = new Array(N).fill(0);
    const J = Array.from({ length: N }, () => new Array(N).fill(0));
    const flows = links.map((k) => {
      const dp = p[k.l.n] - (k.l.m < 0 ? k.pOut : p[k.l.m]) + k.stack;
      const r = k.l.type === 'crack' ? powerLaw(k.l.coefficient, k.l.exponent, dp, k.a, k.b)
        : k.pivoted && k.open > 0 ? pivotedOpening(k.l, k.pivoted.angle, dp, k.a, k.b, k.pivoted.type)
        : simpleOpening(k.l, k.open, dp, k.a, k.b, exactEnergyPlus);
      const total = r.f.reduce((s, x) => s + x, 0), d = r.df.reduce((s, x) => s + x, 0);
      sum[k.l.n] += total; scale[k.l.n] += r.f.reduce((s, x) => s + Math.abs(x), 0); J[k.l.n][k.l.n] += d;
      if (k.l.m >= 0) {
        sum[k.l.m] -= total; scale[k.l.m] += r.f.reduce((s, x) => s + Math.abs(x), 0);
        J[k.l.m][k.l.m] += d; J[k.l.n][k.l.m] -= d; J[k.l.m][k.l.n] -= d;
      }
      return { dp, f: r.f, neutral: r.neutral };
    });
    return { sum, scale, J, flows };
  };
  let state = evaluate(), iterations = 0;
  const residual = (s) => Math.max(...s.sum.map((x, i) => Math.abs(x) / Math.max(s.scale[i], 1e-12)));
  while (residual(state) > tolerance && iterations < maxIterations) {
    const step = solveLinear(state.J, state.sum.map((x) => -x));
    const before = residual(state), p0 = [...p];
    let lambda = 1;
    for (;;) { // damped Newton: halve the step until the imbalance falls
      for (let i = 0; i < N; i++) p[i] = p0[i] + lambda * step[i];
      const trial = evaluate();
      if (residual(trial) < before || lambda < 1e-4) { state = trial; break; }
      lambda /= 2;
    }
    iterations++;
  }
  return {
    converged: residual(state) <= tolerance,
    iterations,
    pressures: Object.fromEntries(net.zones.map((z, i) => [z, p[i]])),
    links: links.map((k, i) => {
      const f = state.flows[i].f;
      return { name: k.l.name, from: k.l.from, to: k.l.to, type: k.l.type, dp: state.flows[i].dp,
        forward: f.filter((x) => x > 0).reduce((s, x) => s + x, 0), backward: -f.filter((x) => x < 0).reduce((s, x) => s + x, 0),
        neutral: state.flows[i].neutral }; // an opening's neutral plane, 0 (bottom) to 1 (top), if it has one
    }),
  };
}

// Gaussian elimination with partial pivoting; the matrix is small (one row per zone).
function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-30;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-30);
  }
  return x;
}
