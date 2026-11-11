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
//    it can: settled once SETTLE_AIR seconds of air have passed under them; it runs on after that (the
//    air moving on under the same conditions) until the next, so the view never stands still.

import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';

// seconds of air a room's flow takes to settle after its conditions change (its plumes and jets
// formed, the pattern then wandering about itself)
export const SETTLE_AIR = 90;

let grid = null, net = null, running = false;
let live = { mode: 'free', cap: 2 }, target = 0, since = 0; // since: the air time the last conditions came at

self.onmessage = ({ data: m }) => {
  if (m.type === 'model') {
    const model = importEpJSON(m.epjson);
    net = buildNetwork(model);
    grid = new GridFlow(prepareRoomFlow(voxelize(model), net, model), model);
    running = false;
  } else if (m.type === 'conditions' && grid) {
    const flows = flowStreams(net, solveNetwork(net, m.conditions), m.conditions);
    grid.setConditions(flows, m.conditions, { hour: m.hour });
    since = grid.time;
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
    behind: live.mode === 'follow' ? Math.max(0, target - grid.time) : 0, settled: live.mode === 'settle' ? Math.min(1, (grid.time - since) / SETTLE_AIR) : null,
  });
  setTimeout(loop, 0);
}
