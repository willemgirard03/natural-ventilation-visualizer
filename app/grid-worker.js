// Runs the grid solver (src/solver/grid.js) in the background, so the page stays responsive: it builds
// the same model, network and cells as the page, steps continuously, and posts each step's face
// velocities and temperatures, which the page's copy of the grid reads for the particles. Or it bakes
// a day: each hour in turn, carried on from the hour before, for its air time, posting the fields
// it ends with.

import { importEpJSON } from '../src/model/import-epjson.js';
import { buildNetwork, solveNetwork } from '../src/solver/network.js';
import { flowStreams } from '../src/solver/paths.js';
import { voxelize, prepareRoomFlow } from '../src/solver/roomflow.js';
import { GridFlow } from '../src/solver/grid.js';

let grid = null, net = null, running = false;

self.onmessage = ({ data: m }) => {
  if (m.type === 'model') {
    const model = importEpJSON(m.epjson);
    net = buildNetwork(model);
    grid = new GridFlow(prepareRoomFlow(voxelize(model), net, model), model);
    running = false;
  } else if (m.type === 'conditions' && grid) {
    const flows = flowStreams(net, solveNetwork(net, m.conditions), m.conditions);
    grid.setConditions(flows, m.conditions, { hour: m.hour });
    if (!running) { running = true; loop(); }
  } else if (m.type === 'co2' && grid) {
    grid.setCO2(m.co2);
  } else if (m.type === 'stop') {
    running = false;
  } else if (m.type === 'bake' && grid) {
    running = false;
    bake(m);
  }
};

// Each hour's conditions (and CO2), simulated for `air` seconds of air time from where the hour before
// left the air (the first hour, from still air, for twice that), then its fields posted.
function bake({ hours, air }) {
  hours.forEach((H, i) => {
    const flows = flowStreams(net, solveNetwork(net, H.conditions), H.conditions);
    grid.setConditions(flows, H.conditions, { hour: H.hour });
    if (H.co2) grid.setCO2(H.co2);
    const until = grid.time + air * (i ? 1 : 2);
    while (grid.time < until) grid.step();
    self.postMessage({ type: 'baked', i, FV: grid.FV.slice(), T: grid.T.slice(), C: grid.co2 ? grid.C.slice() : null });
  });
  self.postMessage({ type: 'bake-done' });
}

function loop() {
  if (!running) return;
  const t0 = performance.now();
  const dt = grid.step();
  self.postMessage({ type: 'state', FV: grid.FV, T: grid.T, C: grid.co2 ? grid.C : null, time: grid.time, dt, ms: performance.now() - t0, iterations: grid.iterations });
  setTimeout(loop, 0);
}
