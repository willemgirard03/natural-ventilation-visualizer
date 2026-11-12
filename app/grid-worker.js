// Runs the grid solver (src/solver/grid.js) in the background, so the page stays responsive: it builds
// the same model, network and cells as the page, steps, and posts each step's face velocities and
// temperatures, which the page's copy of the grid reads for the particles.
//
// How it steps (set by 'live' messages, as the day plays or not):
//  - free: on and on at the solver's own steps (the air moves at most a cell a step), as fast as it
//    can: the air shown is the hour picked, held.
//  - follow: the air keeps the day's clock. The page says how much air time has passed (target);
//    the solver catches up in steps of up to `cap` seconds and waits when it is level.
//  - settle: on and on in steps of up to `cap` seconds, as fast as it can, under the conditions given
//    (the page holds its clock until the air has settled under each set).
//
// In every mode it says whether the air has settled under the last conditions it was given: once the
// air's change over 10 s of air has stopped falling (over the last 40 s, its mean over 20 s is no
// more than 15% below what it was), the change left being the flow's own wandering about itself.
// That level depends on the conditions and the cells, so a falling change, not a level, is the test.
// Measured on Example 02 (PLAN.md): settled 90-110 s of air after a weather step, about 190 s after
// the windows shut or from still air. At most SETTLE_MAX seconds of air (twice that from still air).

import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';

const SAMPLE = 10; // s of air between the snapshots the change is measured over
const SETTLE_MAX = 300; // s of air: settled at the latest

let grid = null, net = null, running = false;
let live = { mode: 'free', cap: 2 }, target = 0;
// settling under the last conditions: the air time they came at, from still air or not, the last
// snapshot of the flow and the changes measured since, and whether it has settled
let since = 0, still = true, snap = null, nextSnap = 0, changes = [], settled = false;

self.onmessage = ({ data: m }) => {
  if (m.type === 'model') {
    const model = importEpJSON(m.epjson);
    net = buildNetwork(model);
    grid = new GridFlow(prepareRoomFlow(voxelize(model, { cell: m.cell ?? 0.5 }), net, model), model);
    running = false;
    still = true;
  } else if (m.type === 'conditions' && grid) {
    const flows = flowStreams(net, solveNetwork(net, m.conditions), m.conditions);
    grid.setConditions(flows, m.conditions, { hour: m.hour });
    if (grid.time > 0) still = false; // the air already moving: a change, not a start
    since = grid.time; snap = null; nextSnap = grid.time; changes = []; settled = false;
    if (!running) { running = true; loop(); }
  } else if (m.type === 'co2' && grid) {
    grid.setCO2(m.co2);
  } else if (m.type === 'live') {
    live = { mode: m.mode, cap: m.cap ?? live.cap };
    if (m.mode === 'follow') target = grid ? grid.time : 0;
  } else if (m.type === 'target') {
    target = m.air;
  } else if (m.type === 'stop') {
    running = false;
  }
};

// The flow's change since the last snapshot, every SAMPLE s of air; settled once it stops falling.
function watch() {
  if (settled || grid.time < nextSnap) return;
  const U = grid.U.map((u) => Float32Array.from(u));
  if (snap) {
    let d = 0, s = 0;
    for (const c of grid.fluid) for (let k = 0; k < 3; k++) { d += Math.abs(U[k][c] - snap[k][c]); s += Math.abs(U[k][c]); }
    changes.push(d / (s || 1));
  }
  snap = U;
  nextSnap = grid.time + SAMPLE;
  const n = changes.length, mean = (i) => (changes[i] + changes[i - 1]) / 2;
  if ((n >= 6 && mean(n - 1) >= 0.85 * mean(n - 5)) || grid.time - since >= SETTLE_MAX * (still ? 2 : 1)) settled = true;
}

function loop() {
  if (!running) return;
  let dt = null;
  if (live.mode === 'follow') {
    const need = target - grid.time;
    if (need < 0.05) { setTimeout(loop, 15); return; } // level with the day: wait
    dt = Math.min(need, Math.max(grid.stableDt(), live.cap));
  } else if (live.mode === 'settle') dt = Math.max(grid.stableDt(), live.cap);
  const t0 = performance.now();
  dt = grid.step(dt ?? undefined);
  watch();
  self.postMessage({
    type: 'state', FV: grid.FV, T: grid.T, C: grid.co2 ? grid.C : null, time: grid.time, dt, ms: performance.now() - t0, iterations: grid.iterations,
    behind: live.mode === 'follow' ? Math.max(0, target - grid.time) : 0, settled, settling: grid.time - since, still,
  });
  setTimeout(loop, 0);
}
