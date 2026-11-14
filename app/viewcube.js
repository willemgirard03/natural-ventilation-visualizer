// A view cube in the 3D view's top right corner, as in Revit: it turns with the camera, and a click on
// one of its faces, edges or corners turns the camera to look from that side (6 faces, 12 edges,
// 8 corners). The faces are named after the model's axes (front looks north, along +y); a ring
// under the cube marks true north, which can differ from the model's y axis. Dragged sideways, the ring
// turns the view about the upright through what it looks at.

import * as THREE from 'three';

const SIZE = 124; // CSS px
const EDGE = 0.56; // where a face's middle ends and its edges and corners begin, of the half width
const FACES = [
  // [normal, label, up direction of its text in the cube's frame]
  [[0, 0, 1], 'TOP', [0, 1, 0]],
  [[0, 0, -1], 'BOTTOM', [0, -1, 0]],
  [[0, -1, 0], 'FRONT', [0, 0, 1]],
  [[0, 1, 0], 'BACK', [0, 0, 1]],
  [[1, 0, 0], 'RIGHT', [0, 0, 1]],
  [[-1, 0, 0], 'LEFT', [0, 0, 1]],
];

function faceTexture(label, css) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = css.face;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = css.line;
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 125, 125);
  g.fillStyle = css.ink;
  g.font = `600 ${label.length > 5 ? 20 : 23}px "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewCube {
  // view: the View3D it steers; onPick(direction): called with the unit vector to look from.
  constructor(view, onPick) {
    this.view = view;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(SIZE, SIZE);
    const el = this.renderer.domElement;
    el.className = 'viewcube';
    el.title = 'Click a face, edge or corner to look from that side';
    view.container.appendChild(el);

    this.scene = new THREE.Scene();
    // wide enough for the ring (radius 1.75, 1.05 below the cube's middle) and its north tip at any angle
    this.camera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 20);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bec0, 2.6));
    this.cube = new THREE.Group();
    this.scene.add(this.cube);
    this.hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthTest: true }));
    this.hover.visible = false;
    this.scene.add(this.hover);
    this.build();

    const ray = new THREE.Raycaster();
    const region = (e) => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObject(this.box, false)[0];
      if (!hit) return null;
      // The face hit sets one axis; on the others, near the face's border counts as an edge or corner
      // (in the cube's own axes, which turn with the north it is set to).
      const p = this.box.worldToLocal(hit.point.clone()), n = hit.face.normal;
      return [0, 1, 2].map((i) => {
        if (Math.abs(n.getComponent(i)) > 0.5) return Math.sign(n.getComponent(i));
        const v = p.getComponent(i);
        return v > EDGE ? 1 : v < -EDGE ? -1 : 0;
      });
    };
    const onRing = (e) => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      return ray.intersectObject(this.ringHit, false).length > 0 && !ray.intersectObject(this.box, false).length;
    };
    // the north arrow on the ring: a click turns the cube between true north and the building's
    const onArrow = (e) => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      return ray.intersectObject(this.arrowHit, false).length > 0;
    };
    let turning = null;
    el.addEventListener('pointermove', (e) => {
      if (turning) {
        const dx = e.clientX - turning.x;
        turning.x = e.clientX;
        turning.moved ||= Math.abs(e.clientX - turning.x0) > 2;
        this.turn(-dx * 0.012);
        return;
      }
      const arrow = onArrow(e), ring = !arrow && onRing(e);
      el.style.cursor = arrow ? 'pointer' : ring ? 'ew-resize' : '';
      el.title = arrow ? `True north. Click to turn the view ${this.northUp === 'true' ? 'with the building\'s north (its walls\' axis nearest true north) up' : 'with true north up'}; again for the other.`
        : 'Click a face, edge or corner to look from that side';
      this.showHover(ring ? null : region(e));
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || onArrow(e) || !onRing(e)) return;
      turning = { x: e.clientX, x0: e.clientX, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      e.preventDefault();
    });
    el.addEventListener('pointerup', (e) => {
      if (!turning) return;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already let go */ }
      this.justTurned = turning.moved;
      turning = null;
    });
    el.addEventListener('pointerleave', () => { if (!turning) this.showHover(null); });
    el.addEventListener('click', (e) => {
      if (this.justTurned) { this.justTurned = false; return; }
      if (onArrow(e)) { this.orientNorth(this.northUp === 'true' ? 'building' : 'true'); return; }
      if (onRing(e)) return;
      const d = region(e);
      // the cube's own axes turned out to the model's
      if (d) this.onPick(new THREE.Vector3(...d).normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), this.cube.rotation.z));
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  build() {
    const css = getComputedStyle(this.view.container);
    const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const colors = { face: get('--panel', '#FDFDFC'), ink: get('--ink2', '#4B5855'), line: get('--rule', '#C7D1CE') };
    this.accent = get('--glass', '#2F6F68');
    this.hover.material.color.set(this.accent);
    for (const o of [...this.cube.children]) { o.geometry?.dispose(); this.cube.remove(o); }
    // BoxGeometry's material order: +x, -x, +y, -y, +z, -z.
    const order = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const mats = order.map((n) => {
      const [, label] = FACES.find(([m]) => m.every((x, i) => x === n[i]));
      return new THREE.MeshLambertMaterial({ map: faceTexture(label, colors) });
    });
    this.box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
    this.fixTextOrientation();
    this.cube.add(this.box);
    this.cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.box.geometry), new THREE.LineBasicMaterial({ color: colors.ink })));
    // The compass ring under the cube, with true north marked.
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.75, 64), new THREE.MeshBasicMaterial({ color: colors.line, side: THREE.DoubleSide }));
    ring.position.z = -1.05;
    // a wider band, unseen, to take the pointer on the ring
    this.ringHit = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.95, 48), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    this.ringHit.position.z = -1.05;
    this.cube.add(this.ringHit);
    this.north = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 3), new THREE.MeshBasicMaterial({ color: this.accent }));
    tip.position.set(0, 1.86, -1.05); // a cone points along +y
    this.north.add(tip);
    // a larger unseen target round the tip, for the click that turns true north and the building's
    this.arrowHit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    this.arrowHit.position.copy(tip.position);
    this.north.add(this.arrowHit);
    this.cube.add(ring, this.north);
  }

  // BoxGeometry maps each face's texture with its own up direction; turn the side faces' text upright
  // (z up) and the top's towards +y, by rotating each face's UVs.
  fixTextOrientation() {
    const uv = this.box.geometry.getAttribute('uv');
    const rotate = (face, quarterTurns) => {
      for (let k = 0; k < 4; k++) {
        const i = face * 4 + k;
        let u = uv.getX(i) - 0.5, v = uv.getY(i) - 0.5;
        for (let q = 0; q < quarterTurns; q++) [u, v] = [-v, u];
        uv.setXY(i, u + 0.5, v + 0.5);
      }
    };
    // each side's text turned upright (z up); checked by rendering the cube from every side
    rotate(0, 3); rotate(1, 1); rotate(2, 2); rotate(5, 2);
    uv.needsUpdate = true;
    this.uv0 = Float32Array.from(uv.array); // the top's own, turned below to face the eye
    this.rotateFace = rotate;
    this.topTurn = 0;
  }

  // The top's text turned a quarter at a time so it reads from the side the camera is on (never upside
  // down): k quarter turns for the camera's bearing round the cube, to the nearest side.
  turnTop() {
    const v = this.view, d = v.camera.position.clone().sub(v.controls.target).applyAxisAngle(new THREE.Vector3(0, 0, 1), -this.cube.rotation.z); // in the cube's own axes
    const k = ((Math.round(Math.atan2(d.x, -d.y) / (Math.PI / 2)) % 4) + 4) % 4;
    if (k === this.topTurn || !this.uv0) return;
    const uv = this.box.geometry.getAttribute('uv');
    for (let i = 16; i < 20; i++) uv.setXY(i, this.uv0[i * 2], this.uv0[i * 2 + 1]);
    this.rotateFace(4, (4 - k) % 4);
    uv.needsUpdate = true;
    this.topTurn = k;
  }

  // The view turned by `angle` (radians) about the upright through the compass's centre (the site's
  // origin): the camera and what it looks at both swing round it.
  turn(angle) {
    const v = this.view, t = v.controls.target, up = new THREE.Vector3(0, 0, 1);
    v.camera.position.applyAxisAngle(up, angle);
    t.applyAxisAngle(up, angle);
    v.camera.up.applyAxisAngle(up, angle);
    v.camera.lookAt(t);
    v.controls.update?.();
    v.render();
  }

  // The norths, in degrees anticlockwise from the model's +y axis: true north, and the building's
  // (its walls' axis nearest true north; null when it has none). The ring's arrow marks true north.
  setNorth(trueDeg, buildingDeg = null) {
    this.norths = { true: trueDeg, building: buildingDeg ?? trueDeg };
    this.north.rotation.z = THREE.MathUtils.degToRad(trueDeg);
    this.render();
  }
  // A north as a horizontal unit vector in the model's axes.
  northVec(which = 'true') {
    const a = THREE.MathUtils.degToRad(this.norths?.[which] ?? 0);
    return new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
  }
  // The view turned about the compass's centre so this north points up the screen: looking north
  // (from the side, it is straight ahead; from above, at the top of the view).
  orientNorth(which) {
    this.northUp = which;
    const v = this.view, n = this.northVec(which), f = v.controls.target.clone().sub(v.camera.position);
    f.z = 0;
    if (f.lengthSq() < 1e-8) f.copy(v.camera.up).setZ(0); // from straight above: the screen's up
    if (f.lengthSq() < 1e-8) return;
    this.turn(Math.atan2(n.y, n.x) - Math.atan2(f.y, f.x));
  }

  showHover(d) {
    if (!d) { this.hover.visible = false; this.render(); return; }
    const span = (s) => (s === 0 ? [-EDGE, EDGE] : s > 0 ? [EDGE, 1.02] : [-1.02, -EDGE]);
    const [x, y, z] = d.map(span);
    this.hover.scale.set(x[1] - x[0], y[1] - y[0], z[1] - z[0]);
    this.hover.position.set((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2).applyAxisAngle(new THREE.Vector3(0, 0, 1), this.cube.rotation.z);
    this.hover.rotation.z = this.cube.rotation.z;
    this.hover.visible = true;
    this.render();
  }

  // Follows the main camera: the same direction from the target, the same up.
  render() {
    const v = this.view;
    this.turnTop();
    const dir = v.camera.position.clone().sub(v.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(6));
    this.camera.up.copy(v.camera.up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
