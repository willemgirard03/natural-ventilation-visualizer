// Runs the grid solver (src/solver/grid.js) in the background, so the page stays responsive: it builds
// the same model, network and cells as the page, steps, and posts each step's face velocities and
// temperatures, which the page's copy of the grid reads for the particles.
//
// How it steps (set by 'live' messages, as the day plays or not):
//  - free: on and on at the solver's own steps (the air moves at most a cell a step), as fast as it
//    can: the air shown is the hour picked, held.
//  - follow: the air keeps the day's clock. The page says how much air time has passed (target);
//    the solver catches up in steps of up to `cap` seconds and waits when it is level. Where it
//    cannot keep up it falls behind, and says by how much.
//  - settle: each new set of conditions gets the air run, in steps of up to `cap` seconds, as fast as
//    it can: settled once `settle` seconds of air have passed under them; it runs on after that (the
//    air moving on under the same conditions) until the next, so the view never stands still.
// In every mode it says how far the air has settled under the last conditions: `settle` seconds of
// air after a change, three times that from still air (a model newly loaded or the air restarted).
// Measured on Example 02 (PLAN.md): after a weather step about half the change comes in the first 30 s
// of air and nearly all by about 200 s; from still air, 4 to 5 minutes.

import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';

let grid = null, net = null, running = false;
let live = { mode: 'free', cap: 2, settle: 120 }, target = 0, since = 0, still = true; // since: the air time the last conditions came at; still: from still air

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
    since = grid.time;
    if (!running) { running = true; loop(); }
  } else if (m.type === 'co2' && grid) {
    grid.setCO2(m.co2);
  } else if (m.type === 'live') {
    live = { mode: m.mode, cap: m.cap ?? live.cap, settle: m.settle ?? live.settle };
    if (m.mode === 'follow') target = grid ? grid.time : 0;
  } else if (m.type === 'target') {
    target = m.air;
  } else if (m.type === 'stop') {
    running = false;
  }
};

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
  self.postMessage({
    type: 'state', FV: grid.FV, T: grid.T, C: grid.co2 ? grid.C : null, time: grid.time, dt, ms: performance.now() - t0, iterations: grid.iterations,
    behind: live.mode === 'follow' ? Math.max(0, target - grid.time) : 0, settled: Math.min(1, (grid.time - since) / (live.settle * (still ? 3 : 1))),
  });
  setTimeout(loop, 0);
}
