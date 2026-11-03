// Copied from the sky-dome skill (F:/ARCH 540/.claude/skills/sky-dome/sky.js): the Solar Shading
// Explorer's sun position, sky dome polylines, sun picking and north-offset maths.

/* The sky dome, the sun on it and the place it is worked out for - as the
   Solar Shading Explorer builds them. Dependency-free and renderer-agnostic:
   the dome comes back as polylines and points in world axes, metres,
   x east, y north, z up, centred on the site, for any camera to project.

   Accurate to about a tenth of a degree (Cooper's declination, a Spencer-style
   equation of time) - right for design, not for calibrating a heliodon.

   Angles: altitude above the horizon; azimuth clockwise from north (90 east).
   Days are days of the year 1-365 (no leap day). Clocks:
     'sol'  apparent solar time - noon when the sun is due south (north, south of the equator)
     'std'  the zone's standard time, as weather files keep it
     'dst'  the zone's daylight time, standard + 1 h                           */

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const wrap360 = a => ((a % 360) + 360) % 360;
export const wrap180 = a => wrap360(a + 180) - 180;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const doyOf = (m, d) => DAYS.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
export function monthDayOf(doy) { let m = 0; while (m < 11 && doy > DAYS[m]) doy -= DAYS[m++]; return { m: m + 1, d: doy }; }
export const hhmm = h => { const m = Math.round(h * 60) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

/* ---------- the place ---------- */
/** where the sun is worked out for: set from a weather file's header. key changes with the place, for caches */
export const SITE = { lat: 49.19, lon: -123.18, tz: -8, place: 'Vancouver', key: '49.19,-123.18,-8' };
export function setSite({ lat, lon, tz, place = '' }) { Object.assign(SITE, { lat, lon, tz, place, key: [lat, lon, tz].join(',') }); }
/** the clocks named for the zone: 'UTC−8 standard', 'UTC−7 daylight', 'Solar time' */
export function clockNames(tz = SITE.tz) {
  const utc = n => 'UTC' + (n < 0 ? '−' : '+') + Math.abs(n);
  return { sol: 'Solar time', std: utc(tz) + ' standard', dst: utc(tz + 1) + ' daylight' };
}
/** the place as a chip shows it: 49.19°N 123.18°W · Vancouver */
export const placeLabel = (p = SITE) => Math.abs(p.lat).toFixed(2) + '°' + (p.lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(p.lon).toFixed(2) + '°' + (p.lon >= 0 ? 'E' : 'W') + (p.place ? ' · ' + p.place : '');
/** the highest the sun climbs here, on a solstice - what a sky chart's altitude scale needs to reach */
export const peakAltitude = (lat = SITE.lat) => Math.min(90, 90 - Math.abs(lat) + 23.45);

/* ---------- the sun ---------- */
export function equationOfTime(doy) {               // minutes
  const B = (doy - 81) * 360 / 364 * D2R;
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}
export const declination = doy => 23.45 * Math.sin(360 * (284 + doy) / 365 * D2R);
/** apparent solar time from a clock time */
export function solarTimeOf(doy, t, mode) {
  if (mode === 'sol') return t;
  const std = mode === 'dst' ? t - 1 : t;
  return std + (4 * (SITE.lon - SITE.tz * 15) + equationOfTime(doy)) / 60;
}
/** a clock time from apparent solar time */
export function clockOf(doy, solarT, mode) {
  if (mode === 'sol') return solarT;
  const std = solarT - (4 * (SITE.lon - SITE.tz * 15) + equationOfTime(doy)) / 60;
  return mode === 'dst' ? std + 1 : std;
}
/** the sun at a day and a clock time: { alt, az } in degrees */
export function solarPosition(doy, t, mode = 'sol') {
  const dec = declination(doy) * D2R, H = (solarTimeOf(doy, t, mode) - 12) * 15 * D2R, lat = SITE.lat * D2R;
  const alt = Math.asin(clamp(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H), -1, 1)) * R2D;
  const az = wrap360(Math.atan2(Math.sin(H) * Math.cos(dec), Math.cos(H) * Math.cos(dec) * Math.sin(lat) - Math.sin(dec) * Math.cos(lat)) * R2D + 180);
  return { alt, az };
}
/** the sun as a unit vector: x east, y north, z up */
export const sunVec = (alt, az) => [Math.cos(alt * D2R) * Math.sin(az * D2R), Math.cos(alt * D2R) * Math.cos(az * D2R), Math.sin(alt * D2R)];
/** sunrise and sunset in solar hours, or null when the sun never rises that day */
export function sunriseSunset(doy) {
  const c = -Math.tan(SITE.lat * D2R) * Math.tan(declination(doy) * D2R);
  if (c >= 1) return null;
  if (c <= -1) return [0, 24];
  const h = Math.acos(c) * R2D / 15;
  return [12 - h, 12 + h];
}

/* ---------- the weather file ---------- */
/* An EnergyPlus weather file (.epw). Its first line names the place:
   LOCATION, city, state, country, source, WMO, latitude, longitude, time zone, elevation.
   Eight header lines, then a row an hour, each the hour ENDING at its time,
   in the zone's standard time. A leap day is left out, so the year is 8760
   hours; hour index (doy - 1) * 24 + (hour - 1) covers hour - 1 .. hour. */
export function parseEpw(text) {
  const lines = String(text).split(/\r?\n/), loc = (lines[0] || '').split(',');
  if (!/^LOCATION/i.test(loc[0] || '')) throw new Error('this is not an EnergyPlus weather file');
  const N = 8760, db = new Float32Array(N), dni = new Float32Array(N), ghi = new Float32Array(N), dhi = new Float32Array(N);
  const ok = (x, hi) => isFinite(x) && x >= 0 && x < hi ? x : 0;
  let n = 0;
  for (let k = 8; k < lines.length; k++) {
    const f = lines[k].split(',');
    if (f.length < 16) continue;
    const mo = +f[1], d = +f[2], h = +f[3];
    if (!(mo >= 1 && mo <= 12) || (mo === 2 && d === 29)) continue;
    const i = (doyOf(mo, d) - 1) * 24 + (h - 1);
    if (i < 0 || i >= N) continue;
    db[i] = isFinite(+f[6]) && +f[6] < 90 ? +f[6] : 0;      // dry bulb, °C
    ghi[i] = ok(+f[13], 2000); dni[i] = ok(+f[14], 2000); dhi[i] = ok(+f[15], 2000);   // W/m²
    n++;
  }
  if (n < 8700) throw new Error('only ' + n + ' of the 8760 hours could be read');
  return { place: (loc[1] || '').trim(), lat: +loc[6], lon: +loc[7], tz: +loc[8], elev: +loc[9], db, dni, ghi, dhi };
}
/** a weather file's place made the site: returns true if the place changed - every sky cache must then be cleared */
export function siteFromEpw(epw) {
  if (![epw.lat, epw.lon, epw.tz].every(isFinite)) return false;
  const key = [epw.lat, epw.lon, epw.tz].join(',');
  if (key === SITE.key) return false;
  setSite(epw); clearSky();
  return true;
}

/* ---------- the dome, as polylines ---------- */
// the solstices and an equinox - March's and September's paths all but lie on each other, so one stands for both
export const PATH_DOYS = [355, 80, 172];
export const PATH_LABELS = { 172: '21 Jun', 80: '21 Mar · Sep', 355: '21 Dec' };
/** a point on the ground (or at height z) at a compass bearing, r out */
export const compassPt = (brg, r, z = 0) => [r * Math.sin(brg * D2R), r * Math.cos(brg * D2R), z];
/** a level circle: the horizon at z = 0, or an altitude ring */
export const ringPts = (r, z = 0, n = 96) => Array.from({ length: n + 1 }, (_, i) => compassPt(i * 360 / n, r, z));
/** the altitude rings at 30° and 60°, and a meridian every 45° from the horizon to the zenith */
export function graticule(R, alts = [30, 60], step = 45) {
  return {
    rings: alts.map(a => ({ alt: a, pts: ringPts(R * Math.cos(a * D2R), R * Math.sin(a * D2R)) })),
    meridians: Array.from({ length: 360 / step }, (_, k) => Array.from({ length: 31 }, (_, i) => scale(sunVec(i * 3, k * step), R)))
  };
}
const scale = (v, R) => [v[0] * R, v[1] * R, v[2] * R];
/** one day's path: runs above the horizon (more than one where the sun dips and rises again near the poles) */
export function dayPath(doy, R, step = 0.1) {
  const runs = []; let run = null;
  for (let t = 0; t <= 24.001; t += step) {
    const sp = solarPosition(doy, t, 'sol');
    if (sp.alt < 0) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(scale(sunVec(sp.alt, sp.az), R));
  }
  return runs;
}
/* An hour line for every hour of the clock: where the sun stands at that hour
   through the whole year. On solar time the year's two halves trace the same
   line and it is straight; on a zone's clock the equation of time opens it into
   a figure eight - an analemma. tag: where it is named, its June end. */
export function hourLines(R, mode, hours = [4, 20]) {
  const out = [];
  for (let h = hours[0]; h <= hours[1]; h++) {
    const runs = []; let run = null;
    for (let d = 1; d <= 366; d += 3) {
      const s = solarPosition(Math.min(d, 365), h, mode);
      if (s.alt < 0.5) { run = null; continue; }
      if (!run) runs.push(run = []);
      run.push(scale(sunVec(s.alt, s.az), R));
    }
    // a line that runs over New Year's Day meets itself
    if (runs.length > 1 && solarPosition(1, h, mode).alt >= 0.5 && solarPosition(365, h, mode).alt >= 0.5) runs[0] = runs.pop().concat(runs[0]);
    const s0 = solarPosition(SITE.lat >= 0 ? 172 : 355, h, mode);
    out.push({ h, runs, tag: s0.alt > 1 ? scale(sunVec(s0.alt, s0.az), R) : null });
  }
  return out;
}
/** the solstice and equinox paths, each with its noon (for its label) and its hour dots on the clock chosen */
export function seasonPaths(R, mode) {
  return PATH_DOYS.map(doy => {
    const noon = solarPosition(doy, 12, 'sol'), hours = [];
    for (let h = 4; h <= 20; h++) { const s = solarPosition(doy, h, mode); if (s.alt > 1) hours.push({ h, p: scale(sunVec(s.alt, s.az), R) }); }
    return { doy, label: PATH_LABELS[doy], runs: dayPath(doy, R), noon: noon.alt > 0 ? scale(sunVec(noon.alt, noon.az), R) : null, hours };
  });
}
/* The weather file's every daylit hour as a dot on the dome, at the middle of
   its hour, coloured by its dry-bulb temperature: below 20 °C cool, 20-27
   warm, above 27 hot. Unit vectors - scale them to the dome. */
export const TEMP_BANDS = [[20, '#4A6FA5', 'below 20 °C'], [27, '#D9A625', '20–27 °C'], [99, '#C0442B', 'above 27 °C']];
export function weatherDots(epw) {
  const pts = [];
  for (let d = 1; d <= 365; d++) for (let h = 0; h < 24; h++) {
    const sp = solarPosition(d, h + 0.5, 'std');
    if (sp.alt < 0.5) continue;
    const t = epw.db[(d - 1) * 24 + h];
    pts.push({ v: sunVec(sp.alt, sp.az), band: t < TEMP_BANDS[0][0] ? 0 : t < TEMP_BANDS[1][0] ? 1 : 2, doy: d, h });
  }
  return pts;
}

/* ---------- a date and a time from a point on the sky ---------- */
/* The sun dragged on the dome: the date and time whose sun is drawn nearest
   the pointer. Every place on the sun's band is reached on two dates, one
   either side of a solstice; the nearer to the date already set wins, so a
   drag stays on its side of the year instead of flipping across it.
   project(v) takes a unit sun vector to the sheet: [x, y], or null. */
let samples = { key: '', pts: [] };
function sunSamples(mode) {
  const key = mode + '|' + SITE.key;
  if (samples.key === key) return samples.pts;
  const pts = [];
  for (let doy = 1; doy <= 365; doy += 3) for (let t = 0; t <= 24.001; t += 0.2) {
    const sp = solarPosition(doy, t, mode);
    if (sp.alt > 0) pts.push({ doy, t, v: sunVec(sp.alt, sp.az) });
  }
  return (samples = { key, pts }).pts;
}
export function pickSun(doyNow, mode, x, y, project, LAM = 0.0004) {
  const cyc = d => { const a = Math.abs(d - doyNow); return Math.min(a, 365 - a); };
  const score = (v, doy) => { const q = project(v); return q ? (q[0] - x) ** 2 + (q[1] - y) ** 2 + LAM * cyc(doy) ** 2 : Infinity; };
  let best = null, bs = Infinity;
  for (const p of sunSamples(mode)) { const s = score(p.v, p.doy); if (s < bs) { bs = s; best = p; } }
  if (!best) return null;
  let doy = best.doy, t = best.t;
  // refined round the nearest sample: three days either side, a minute or so at a time
  for (let dd = -3; dd <= 3; dd++) {
    const d = clamp(best.doy + dd, 1, 365);
    for (let h = best.t - 0.2; h <= best.t + 0.2001; h += 0.02) {
      const sp = solarPosition(d, h, mode);
      if (sp.alt <= 0) continue;
      const s = score(sunVec(sp.alt, sp.az), d);
      if (s < bs) { bs = s; doy = d; t = h; }
    }
  }
  return { doy, hour: clamp(t, 0, 24) };
}

/* ---------- the north offset ---------- */
/* The model's own axes turned against true north: north is the angle, clockwise,
   from true north to the model's +y. The sky and the compass never turn - the
   camera's azimuth is a compass bearing - so a change of offset turns the
   building under them. The handle is an arrow on the ground from the origin
   to the dome's horizon ring along a direction of the model (its +y, or the
   selected facade's outward normal), and a knob on the ring; dragged, the
   model turns so that direction points at the pointer, a degree at a time. */
export const toWorld = (p, north) => { const a = north * D2R, c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c, p[2] || 0]; };
/** the bearing of a point on the ground, from the origin */
export const bearingOf = g => wrap360(Math.atan2(g[0], g[1]) * R2D);
/** the offset that turns the model's direction at `dirBrg` (its bearing in model axes, 0 for +y) to point at ground point g; step 1°, Shift 15° */
export const northFromDrag = (g, dirBrg = 0, step = 1) => Math.round(wrap180(bearingOf(g) - dirBrg) / step) * step;

/** every cache the sky keeps, emptied: call after the place changes */
export function clearSky() { samples = { key: '', pts: [] }; }
