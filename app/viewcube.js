// A view cube in the 3D view's top right corner, as in Revit: it turns with the camera, and a click on
// one of its faces, edges or corners turns the camera to look from that side (6 faces, 12 edges,
// 8 corners). The faces are named after the model's axes (front looks north, along +y); a ring
// under the cube marks true north, which can differ from the model's y axis.

import * as THREE from 'three';

const SIZE = 112; // CSS px
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
    this.camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
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
      // The face hit sets one axis; on the others, near the face's border counts as an edge or corner.
      const p = hit.point, n = hit.face.normal;
      return [0, 1, 2].map((i) => {
        if (Math.abs(n.getComponent(i)) > 0.5) return Math.sign(n.getComponent(i));
        const v = p.getComponent(i);
        return v > EDGE ? 1 : v < -EDGE ? -1 : 0;
      });
    };
    el.addEventListener('pointermove', (e) => this.showHover(region(e)));
    el.addEventListener('pointerleave', () => this.showHover(null));
    el.addEventListener('click', (e) => {
      const d = region(e);
      if (d) this.onPick(new THREE.Vector3(...d).normalize());
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
    this.north = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 3), new THREE.MeshBasicMaterial({ color: this.accent }));
    tip.position.set(0, 1.86, -1.05); // a cone points along +y
    this.north.add(tip);
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
    rotate(0, 3); rotate(1, 1); rotate(5, 2); // +x, -x, top and bottom; checked by eye in the view
    uv.needsUpdate = true;
  }

  // True north, in degrees clockwise from the model's +y axis (EnergyPlus's north axis is the reverse).
  setNorth(degrees) {
    this.north.rotation.z = THREE.MathUtils.degToRad(degrees);
    this.render();
  }

  showHover(d) {
    if (!d) { this.hover.visible = false; this.render(); return; }
    const span = (s) => (s === 0 ? [-EDGE, EDGE] : s > 0 ? [EDGE, 1.02] : [-1.02, -EDGE]);
    const [x, y, z] = d.map(span);
    this.hover.scale.set(x[1] - x[0], y[1] - y[0], z[1] - z[0]);
    this.hover.position.set((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2);
    this.hover.visible = true;
    this.render();
  }

  // Follows the main camera: the same direction from the target, the same up.
  render() {
    const v = this.view;
    const dir = v.camera.position.clone().sub(v.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(6));
    this.camera.up.copy(v.camera.up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
