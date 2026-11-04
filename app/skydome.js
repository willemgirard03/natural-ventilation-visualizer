// The sky over the building, as the Solar Shading Explorer draws it (sky.js, from the sky-dome skill):
// the horizon with a compass, altitude rings and meridians, the hour lines, the solstice and equinox
// paths, the weather file's hours as dots, and the sun at the hour picked with its ray to the site.
//
// Where it departs from the shading tool, for this tool's views and data:
//  - The view is in the model's axes, so the sky is turned to the model's north axis (Building,
//    north_axis) - and the camera turns with it, so on screen the sky and compass stay still and the
//    building turns under them, as in the shading tool. The knob is on the model's own north (its +y):
//    dragged round, the building turns so that its north points at the pointer.
//  - The weather is hourly: the clock is the weather file's standard time, the sun stands at the
//    middle of the hour picked, and a sun dragged on the dome sets the date and the hour ending.
//  - The weather dots are coloured by whether the windows may open that hour: too cold, within the
//    model's outdoor limits for natural ventilation, too hot, or too humid.
//  - Lines are three.js lines sized to the model; the part behind the building shows faintly through
//    it (a copy drawn without the depth test). Labels, the sun disc and the knob are an SVG over the
//    view, in screen pixels, so they keep their size at every zoom.

import * as THREE from 'three';
import { askNumber } from './sections.js';
import { CLICK_PX, label, line, circle, head, segDist } from './handles.js';
import {
  SITE, setSite, clearSky, solarPosition, sunVec, graticule, hourLines, seasonPaths, dayPath,
  compassPt, ringPts, pickSun, monthDayOf, MONTHS, wrap180, wrap360, D2R, R2D,
} from './sky.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const BEHIND = 0.4; // the part of a line behind the building, as a share of its strength in front
export const VENT_BANDS = [
  { key: 'cold', color: '#4A6FA5' },
  { key: 'open', color: '#D9A625' },
  { key: 'hot', color: '#C0442B' },
  { key: 'humid', color: '#93A6AA' },
];

// The layers, each with its strength (multiplied by the sky's own opacity) and whether it starts on.
export const SKY_LAYERS = {
  grid: { name: 'Rings and meridians', on: true },
  paths: { name: 'Sun paths', on: true },
  hours: { name: 'Hour lines', on: true },
  dots: { name: 'Weather hours', on: false },
  compass: { name: 'Compass', on: true },
};

let dotTexture = null;
function roundDot() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
  return (dotTexture = new THREE.CanvasTexture(c));
}

// Polylines (arrays of [x, y, z]) as line segments, once with the depth test and once, fainter,
// without it: the part behind the building reads through it.
function lines(runs, color, strength) {
  const pos = [];
  for (const run of runs) for (let i = 1; i < run.length; i++) pos.push(...run[i - 1], ...run[i]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const g = new THREE.Group();
  const front = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false }));
  const back = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false, depthTest: false }));
  front.userData.strength = strength;
  back.userData.strength = strength * BEHIND;
  back.renderOrder = -1;
  g.add(back, front);
  return g;
}
function dots(points, color, strength) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  const g = new THREE.Group();
  for (const [depthTest, s] of [[false, strength * 0.4], [true, strength]]) {
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 3, sizeAttenuation: false, map: roundDot(), alphaTest: 0.4, transparent: true, depthWrite: false, depthTest }));
    p.userData.strength = s;
    g.add(p);
  }
  return g;
}

export class SkyDome {
  // onTime(dayOfYear, hourEnding): the sun was dragged. onNorth(degrees): the north axis was set.
  constructor(view, { onTime, onNorth }) {
    Object.assign(this, { view, onTime, onNorth });
    this.shown = true; this.opacity = 0.5; this.sunShown = true; this.labels = true; this.sunLabels = true; this.shadows = true;
    this.layers = Object.fromEntries(Object.entries(SKY_LAYERS).map(([k, l]) => [k, l.on]));
    this.state = null; // { R, north, doy, hour, weather, limits }
    this.group = new THREE.Group();
    this.group.userData.noSection = true;
    view.scene.add(this.group);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mhandles skyover');
    view.container.appendChild(this.svg);
    // taken on press, as the massing's figures are (the overlay is redrawn with every frame)
    this.svg.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-edit]') || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.typeNorth(e);
    });
    this.wire();
  }

  // The place the sun is worked out for: the weather file's, else the model's.
  setPlace(loc) {
    if (!loc || ![loc.latitude, loc.longitude, loc.timeZone].every(Number.isFinite)) return;
    const key = [loc.latitude, loc.longitude, loc.timeZone].join(',');
    if (key === SITE.key) return;
    setSite({ lat: loc.latitude, lon: loc.longitude, tz: loc.timeZone, place: loc.name || '' });
    clearSky();
    this.built = null;
  }

  // R: the dome's radius (m); north: the model's north axis (°); doy and hour: the day picked and the
  // weather file's hour ending; weather: its hours, for the dots; limits: [lo, hi] °C outdoors.
  // The sky turned to a north axis, and the camera with it: the sky stays still on screen and the
  // building turns. The first north a model is shown with only sets the sky.
  turnTo(north) {
    if (this.turned !== null && this.turned !== undefined && north !== this.turned) this.view.turnCamera(north - this.turned);
    this.turned = north;
    this.group.rotation.z = north * D2R;
  }
  update(state) {
    this.state = state;
    if (!this.drag) this.turnTo(state.north);
    this.build();
    this.castShadows();
    this.view.render();
  }

  build() {
    const s = this.state;
    if (!s) return;
    const key = [SITE.key, s.R.toFixed(2), this.layers.dots && s.weather ? `${s.weather.fileName}|${s.limits}` : '', s.doy].join('|');
    if (this.built === key) { this.style(); return; }
    this.built = key;
    for (const o of [...this.group.children]) { o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); }); this.group.remove(o); }
    const R = s.R, ink3 = css('--ink3', '#7D8A87'), rule = css('--rule', '#C7D1CE'), poche = css('--poche', '#243230'), sun = css('--sun', '#D9821A'), ink = css('--ink', '#18211F');
    const add = (layer, obj) => { obj.userData.layer = layer; this.group.add(obj); };
    // The grid: horizon, altitude rings, meridians.
    const gr = graticule(R);
    add('grid', lines(gr.rings.map((r) => r.pts), rule, 1));
    add('grid', lines(gr.meridians, rule, 0.8));
    add('compass', lines([ringPts(R)], ink3, 0.8));
    // Compass ticks every 15° in from the horizon, and the north triangle.
    const ticks = [];
    for (let b = 0; b < 360; b += 15) ticks.push([compassPt(b, R), compassPt(b, R * (1 - (b % 90 === 0 ? 0.1 : b % 45 === 0 ? 0.06 : 0.035)))]);
    add('compass', lines(ticks, ink3, 0.9));
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([...compassPt(-2.6, R * 0.9), ...compassPt(2.6, R * 0.9), ...compassPt(0, R)], 3));
    const north = new THREE.Mesh(tri, new THREE.MeshBasicMaterial({ color: ink, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    north.userData.strength = 1;
    add('compass', north);
    // Hour lines, on the weather file's clock (figure eights), and the season paths.
    this.hours = hourLines(R, 'std');
    add('hours', lines(this.hours.flatMap((h) => h.runs), ink3, 0.55));
    this.seasons = seasonPaths(R, 'std').filter((p) => p.doy !== s.doy);
    add('paths', lines(this.seasons.flatMap((p) => p.runs), poche, 1));
    // The day picked: its path, in the sun's colour.
    this.day = dayPath(s.doy, R);
    add('sun', lines(this.day, sun, 1));
    // Every daylit hour of the weather file, by whether the windows may open then.
    if (this.layers.dots && s.weather) {
      const [lo, hi] = s.limits, bands = VENT_BANDS.map(() => []);
      s.weather.hours.forEach((w, i) => {
        const doy = Math.floor(i / 24) + 1, p = solarPosition(doy, (i % 24) + 0.5, 'std');
        if (p.alt < 0.5) return;
        const b = w.t < lo ? 0 : w.t > hi ? 2 : w.relativeHumidity > 90 ? 3 : 1;
        bands[b].push(sunVec(p.alt, p.az).map((x) => x * R));
      });
      bands.forEach((pts, b) => { if (pts.length) add('dots', dots(pts, VENT_BANDS[b].color, 0.75)); });
    }
    this.style();
  }

  // Each layer's visibility and opacity, from the sky's settings.
  style() {
    for (const o of this.group.children) {
      const sunLayer = o.userData.layer === 'sun';
      o.visible = sunLayer ? this.sunShown : this.shown && this.layers[o.userData.layer];
      const k = sunLayer ? 1 : this.opacity;
      o.traverse((x) => { if (x.material) x.material.opacity = k * (x.userData.strength ?? 1); });
    }
  }
  set(what) { Object.assign(this, what); this.build(); this.castShadows(); this.view.render(); }
  // The building's shadows from the sun at the hour picked, turned into the model's axes.
  castShadows(north = this.state?.north) {
    if (!this.state) return;
    const sun = this.sunAt();
    if (!this.sunShown || !this.shadows || sun.alt <= 0) { this.view.setSun(null); return; }
    const a = north * D2R, [x, y, z] = sun.v;
    this.view.setSun([x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z]);
  }

  // A point of the sky (world axes, as sky.js gives them) or of the model, on the sheet.
  P = (p) => {
    const v = new THREE.Vector3(...p).applyMatrix4(this.group.matrixWorld), s = this.view.sections.screen(v);
    const c = v.clone().project(this.view.camera);
    return c.z > 1 ? null : [s.x, s.y];
  };
  sunAt() {
    const s = this.state, p = solarPosition(s.doy, s.hour - 0.5, 'std');
    return { ...p, v: sunVec(p.alt, p.az) };
  }

  // The labels, the sun and the knob, redrawn with the view.
  beforeRender() {
    const s = this.state;
    if (!s || (!this.shown && !this.sunShown)) { this.svg.innerHTML = this.html = ''; this.marks = null; return; }
    this.group.updateMatrixWorld();
    const R = s.R, out = [], P = this.P, on = (k) => this.shown && this.layers[k];
    const tag = (p, t, o) => { const q = P(p); if (q) out.push(label(q[0], q[1], t, o)); };
    if (this.labels && on('grid')) {
      // Each altitude ring named at the side of the view.
      for (const a of [30, 60]) {
        const pts = ringPts(R * Math.cos(a * D2R), R * Math.sin(a * D2R), 48).map(P).filter(Boolean);
        if (pts.length) { const q = pts.reduce((m, p) => (p[0] > m[0] ? p : m)); out.push(label(q[0] + 4, q[1] + 3, `${a}°`, { size: 8, fill: 'var(--ink3)', anchor: 'start' })); }
      }
      const z = P([0, 0, R]);
      if (z) out.push(circle(z[0], z[1], 1.6, { fill: 'var(--ink3)' }), label(z[0] + 4, z[1] - 3, 'zenith', { size: 8, fill: 'var(--ink3)', anchor: 'start' }));
    }
    if (this.labels && on('compass')) {
      for (const [b, t] of [[0, 'N 0°'], [90, 'E 90°'], [180, 'S 180°'], [270, 'W 270°']]) tag(compassPt(b, R * 1.14), t, { size: 10, fill: b ? 'var(--ink2)' : 'var(--ink)' });
      for (const [b, t] of [[45, 'NE'], [135, 'SE'], [225, 'SW'], [315, 'NW']]) tag(compassPt(b, R * 1.1), t, { size: 8, fill: 'var(--ink3)' });
    }
    if (this.labels && on('hours')) for (const h of this.hours || []) if (h.tag && h.h % 2 === 0) tag(h.tag, `${h.h}h`, { size: 7.5, fill: 'var(--ink3)', bg: 0.75 });
    if (this.labels && on('paths')) for (const p of this.seasons || []) if (p.noon) tag(p.noon, p.label, { size: 8.5, fill: 'var(--poche)' });
    this.marks = {};
    if (this.sunShown) {
      const { m, d } = monthDayOf(s.doy), mid = this.day?.flat().reduce((a, p) => (p[2] > a[2] ? p : a), [0, 0, -1]);
      if (this.sunLabels && mid && mid[2] > 0) tag(mid, `${MONTHS[m - 1]} ${d} path`, { size: 8.5, fill: 'var(--sun)' });
      const sun = this.sunAt();
      if (sun.alt > 0) {
        const q = P(sun.v.map((x) => x * R)), o = P([0, 0, 0]);
        if (q && o) {
          const L = Math.hypot(o[0] - q[0], o[1] - q[1]) || 1, u = [(o[0] - q[0]) / L, (o[1] - q[1]) / L];
          out.push(line(q[0], q[1], o[0] - u[0] * 2, o[1] - u[1] * 2, { stroke: 'var(--sun)', w: 1.1 }), head(o[0], o[1], u[0], u[1], 'var(--sun)', 7, 3));
          out.push(circle(q[0], q[1], 11, { fill: 'var(--sun)', opacity: 0.18 }), circle(q[0], q[1], 7, { fill: 'var(--sun)', stroke: 'var(--panel)', 'stroke-width': 1.2 }));
          // Azimuth from due south, east negative, as sun charts give it.
          if (this.sunLabels) out.push(label(q[0], q[1] - 14, `β ${sun.alt.toFixed(1)}° · az ${wrap180(sun.az - 180).toFixed(1)}°`, { size: 9, fill: 'var(--ink2)' }));
          this.marks.sun = q; this.marks.ray = [q, o];
        }
      }
    }
    // The building's own north (its +y): an arrow on the ground out to a knob on the horizon, which
    // turns the building under the sky.
    if (this.shown && on('compass')) {
      const M = (p) => { const q = this.view.sections.screen(new THREE.Vector3(...p)); return [q.x, q.y]; };
      const k = M([0, R, 0]), tip = M([0, R * 0.97, 0]), o = M([0, 0, 0]), from = M([0, R * 0.45, 0]);
      const L = Math.hypot(tip[0] - o[0], tip[1] - o[1]) || 1, u = [(tip[0] - o[0]) / L, (tip[1] - o[1]) / L];
      out.push(line(o[0], o[1], tip[0] - u[0] * 6, tip[1] - u[1] * 6, { stroke: 'var(--glass)', w: 1.3 }), head(tip[0], tip[1], u[0], u[1], 'var(--glass)', 8, 3.5));
      out.push(circle(k[0], k[1], 6, { fill: 'var(--panel)', stroke: 'var(--glass)', 'stroke-width': 1.6 }), circle(k[0], k[1], 2.4, { fill: 'var(--glass)' }));
      out.push(label(k[0], k[1] - 13, `north axis ${Math.round(this.drag?.north ?? s.north)}°`, { size: 9, edit: 'north' }));
      this.marks.knob = k; this.marks.arrow = [from, k];
    }
    const html = out.join('');
    if (this.html !== html) this.svg.innerHTML = this.html = html; // only when it changed
  }

  // What a press here would take: the sun, its ray, the north knob or its arrow.
  handleAt(e) {
    if (!this.marks || !this.state) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect(), m = [e.clientX - r.left, e.clientY - r.top], k = this.marks;
    if (k.knob && Math.hypot(m[0] - k.knob[0], m[1] - k.knob[1]) < 11) return { kind: 'north' };
    if (k.sun && Math.hypot(m[0] - k.sun[0], m[1] - k.sun[1]) < 16) return { kind: 'sun', off: [m[0] - k.sun[0], m[1] - k.sun[1]] };
    if (k.ray) {
      const [a, b] = k.ray, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 20) {
        const t = (L - 14) / L, end = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (segDist(m, a, end) < 6) return { kind: 'sun', off: [m[0] - a[0], m[1] - a[1]] };
      }
    }
    if (k.arrow && segDist(m, ...k.arrow) < 9 && !this.view.hitAt?.(e)) return { kind: 'north' };
    return null;
  }

  wire() {
    const canvas = this.view.renderer.domElement;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.view.sections.placing) return;
      const h = this.handleAt(e);
      if (!h) return;
      e.stopImmediatePropagation();
      canvas.setPointerCapture(e.pointerId);
      this.drag = { ...h, start: at(e), moved: false, north: this.state.north, doy: this.state.doy, hour: this.state.hour };
    }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) { canvas.style.cursor = this.handleAt(e) ? 'grab' : canvas.style.cursor === 'grab' ? '' : canvas.style.cursor; return; }
      const d = this.drag, m = at(e);
      if (!d.moved && Math.hypot(m[0] - d.start[0], m[1] - d.start[1]) < CLICK_PX) return;
      d.moved = true;
      canvas.style.cursor = 'grabbing';
      if (d.kind === 'sun') {
        // The date and hour whose sun is drawn nearest the pointer, kept on its side of the year.
        const R = this.state.R, got = pickSun(d.doy, 'std', m[0] - d.off[0], m[1] - d.off[1], (v) => this.P(v.map((x) => x * R)));
        if (!got) return;
        const hour = Math.min(24, Math.max(1, Math.floor(got.hour) + 1));
        if (got.doy !== d.doy || hour !== d.hour) { d.doy = got.doy; d.hour = hour; this.onTime(got.doy, hour); }
      } else {
        // The building's north follows the pointer: whole degrees, 15° with Shift. The pointer's
        // bearing in the model's axes, plus the turn shown now, is its compass bearing.
        const r = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((m[0] / r.width) * 2 - 1, -(m[1] / r.height) * 2 + 1), this.view.camera);
        const g = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
        if (!g) return;
        const step = e.shiftKey ? 15 : 1;
        d.north = wrap360(Math.round((Math.atan2(g.x, g.y) * R2D + this.turned) / step) * step);
        this.turnTo(d.north);
        this.castShadows(d.north);
        this.view.render();
      }
    });
    const end = (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      canvas.releasePointerCapture?.(e.pointerId);
      canvas.style.cursor = '';
      if (!d.moved) { if (d.kind === 'north') this.typeNorth(e); return; }
      if (d.kind === 'north' && d.north !== this.state.north) this.onNorth(d.north);
      else this.update(this.state);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
  typeNorth(e) {
    askNumber(this.view.container, e, `north axis °, now ${Math.round(this.state.north)}`, (x) => this.onNorth(wrap360(x)), true);
  }
}

// The legend's chips for the weather dots, with the limits they are read against.
export function ventBandLabels([lo, hi]) {
  return {
    cold: [`below ${lo} °C`, 'Too cold for the windows to open, by the model’s natural ventilation limits'],
    open: [`${lo}–${hi} °C`, 'Windows may open: within the model’s outdoor limits for natural ventilation, and not above 90% humidity'],
    hot: [`above ${hi} °C`, 'Too hot for the windows to open'],
    humid: ['above 90% humidity', 'Within the temperature limits, but too humid for the windows to open'],
  };
}
