// Colour gradients for the clipping planes' fills and their particles, and where a value falls on
// one. Each gradient runs from the low end of its range to the high end through its stops. Speed is
// placed on a log scale (an air speed of 0.02 m/s and of 2 m/s both need to read), the others in a
// straight line.

import * as THREE from 'three';

export const RAMPS = {
  coolwarm: { name: 'Cool–warm', stops: ['#1F6FE0', '#EEF1F4', '#E0401F'] },
  heat: { name: 'Heat', stops: ['#DCE3EA', '#F2C14E', '#E0701F', '#B3261E', '#5E1235'] },
  traffic: { name: 'Green–amber–red', stops: ['#3E8E5E', '#E0A526', '#C4372D'] },
  viridis: { name: 'Viridis', stops: ['#440154', '#3B528B', '#21918C', '#5EC962', '#FDE725'] },
  magma: { name: 'Magma', stops: ['#000004', '#51127C', '#B73779', '#FC8961', '#FCFDBF'] },
  spectral: { name: 'Spectral', stops: ['#3288BD', '#99D594', '#E6F598', '#FEE08B', '#FC8D59', '#D53E4F'] },
  blues: { name: 'Blues', stops: ['#F7FBFF', '#9ECAE1', '#3182BD', '#08306B'] },
  greys: { name: 'Greys', stops: ['#F2F2F2', '#9A9A9A', '#262626'] },
};
const COLOURS = Object.fromEntries(Object.entries(RAMPS).map(([k, r]) => [k, r.stops.map((c) => new THREE.Color(c))]));
// each kind of data's own gradient, until another is picked
export const DEFAULT_RAMP = { temperature: 'coolwarm', speed: 'heat', co2: 'traffic' };
export const UNITS = { temperature: '°C', speed: 'm/s', co2: 'ppm' };
const SPEED_FLOOR = 0.005; // m/s: the slowest speed the log scale tells apart

// The colour x of the way along gradient `name` (0 low, 1 high).
export function rampAt(name, x, out = new THREE.Color()) {
  const s = COLOURS[name] || COLOURS.coolwarm, f = Math.max(0, Math.min(1, x)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(f));
  return out.copy(s[i]).lerp(s[i + 1], f - i);
}
// How far along its range [lo, hi] a value of this kind of data falls (0 to 1).
export function placeOf(field, v, lo, hi) {
  if (field === 'speed') {
    const a = Math.log(Math.max(lo, SPEED_FLOOR)), b = Math.log(Math.max(hi, lo * 1.01, SPEED_FLOOR * 1.01));
    return (Math.log(Math.max(v, SPEED_FLOOR)) - a) / (b - a || 1);
  }
  return hi > lo ? (v - lo) / (hi - lo) : 0.5;
}
// The value at a place along the range (the inverse of placeOf), for a legend's marks.
export function valueAt(field, x, lo, hi) {
  if (field === 'speed') { const a = Math.log(Math.max(lo, SPEED_FLOOR)), b = Math.log(Math.max(hi, lo * 1.01, SPEED_FLOOR * 1.01)); return Math.exp(a + (b - a) * x); }
  return lo + (hi - lo) * x;
}
// A range to suggest from the data's own lowest and highest: rounded outwards to a step that suits
// the kind of data, never narrower than it can tell apart.
export function niceRange(field, lo, hi) {
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return null;
  if (field === 'speed') return [Math.max(SPEED_FLOOR, +lo.toPrecision(1)), +Math.max(hi, lo * 2).toPrecision(2)];
  const step = field === 'co2' ? 10 : 0.1, min = field === 'co2' ? 50 : 0.5;
  let a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  if (b - a < min) { const m = (a + b) / 2; a = m - min / 2; b = m + min / 2; }
  const d = field === 'co2' ? 0 : 1;
  return [+a.toFixed(d), +b.toFixed(d)];
}
// The gradient as a CSS linear-gradient, for swatches.
export const rampCss = (name) => `linear-gradient(90deg, ${(RAMPS[name] || RAMPS.coolwarm).stops.join(', ')})`;
