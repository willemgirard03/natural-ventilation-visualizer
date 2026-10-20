// A wind rose drawn on the ground around the building, to check the airflow against: petals show how
// often the wind blows from each of 16 directions in a month of the weather file, shaded by speed,
// and an arrow shows the hour being solved, pointing the way the wind blows.

import * as THREE from 'three';

export const SPEED_BANDS = [2, 4, 6, 8, Infinity]; // m/s, upper limits
export const BAND_COLORS = ['#CFE0F2', '#9CC0E6', '#5F97D3', '#2F6DB5', '#173F73'];
const WIND_ARROW = '#E0401F';

// Frequencies by direction (16 sectors, wind coming from) and speed band, for some weather hours.
export function windRoseData(hours) {
  const counts = Array.from({ length: 16 }, () => new Array(SPEED_BANDS.length).fill(0));
  let calm = 0;
  for (const h of hours) {
    if (h.windSpeed < 0.5) { calm++; continue; }
    const s = Math.round(h.windDirection / 22.5) % 16;
    counts[s][SPEED_BANDS.findIndex((b) => h.windSpeed <= b)]++;
  }
  const n = hours.length || 1;
  return { sectors: counts.map((c) => c.map((x) => x / n)), calm: calm / n };
}

function label(text, color, size) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = '600 88px Archivo, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false }));
  s.scale.set(size, size, 1);
  return s;
}

// The rose as a three.js group at ground level (z = 0 in the view's coordinates), centred on the
// building. radius: just outside the footprint. northAxis: the model's y axis from true north.
export function windRoseGroup(data, { radius, northAxis = 0, wind = null, ink = '#1D2124' }) {
  const group = new THREE.Group();
  const dirVec = (deg) => { const a = ((deg - northAxis) * Math.PI) / 180; return [Math.sin(a), Math.cos(a)]; };
  const maxFreq = Math.max(...data.sectors.map((s) => s.reduce((a, b) => a + b, 0)), 1e-9);
  const reach = radius * 0.9; // the most frequent direction's petal length
  const z = 0.02;
  // Rings every 5% of hours, labelled.
  const ringMat = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.25 });
  for (let f = 0.05; f <= maxFreq + 1e-9; f += 0.05) {
    const r = radius + (f / maxFreq) * reach, pts = [];
    for (let k = 0; k <= 96; k++) { const a = (k / 96) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z)); }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }
  // Petals: a wedge per sector, stacked by speed band from the inside out.
  data.sectors.forEach((bands, s) => {
    const centre = s * 22.5, half = 22.5 * 0.42;
    let r0 = radius;
    bands.forEach((f, b) => {
      if (f <= 0) return;
      const r1 = r0 + (f / maxFreq) * reach, pos = [];
      const steps = 4;
      for (let k = 0; k < steps; k++) {
        const [a0, a1] = [centre - half + (2 * half * k) / steps, centre - half + (2 * half * (k + 1)) / steps];
        const [x0, y0] = dirVec(a0), [x1, y1] = dirVec(a1);
        pos.push(x0 * r0, y0 * r0, z, x1 * r0, y1 * r0, z, x1 * r1, y1 * r1, z, x0 * r0, y0 * r0, z, x1 * r1, y1 * r1, z, x0 * r1, y0 * r1, z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: BAND_COLORS[b], side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false })));
      r0 = r1;
    });
  });
  // North.
  const [nx, ny] = dirVec(0);
  const n = label('N', ink, radius * 0.18);
  n.position.set(nx * (radius + reach + radius * 0.22), ny * (radius + reach + radius * 0.22), radius * 0.1);
  group.add(n);
  // This hour's wind: an arrow from upwind towards the building, longer for stronger wind.
  if (wind && wind.speed > 0) {
    const [ux, uy] = dirVec(wind.direction);
    const len = Math.min(1, wind.speed / 10) * reach + radius * 0.15;
    const start = new THREE.Vector3(ux * (radius + reach + len), uy * (radius + reach + len), radius * 0.05);
    const dir = new THREE.Vector3(-ux, -uy, 0);
    group.add(new THREE.ArrowHelper(dir, start, len, WIND_ARROW, Math.min(len * 0.35, radius * 0.25), radius * 0.12));
  }
  group.renderOrder = 0;
  return group;
}
