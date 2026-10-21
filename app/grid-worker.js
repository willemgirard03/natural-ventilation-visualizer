// Runs the grid solver (src/solver/grid.js) in the background, so the page stays responsive: it builds
// the same model, network and cells as the page, steps continuously, and posts each step's face
// velocities and temperatures, which the page's copy of the grid reads for the particles.

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
    grid = new GridFlow(prepareRoomFlow(voxelize(model), net), model);
    running = false;
  } else if (m.type === 'conditions' && grid) {
    const flows = flowStreams(net, solveNetwork(net, m.conditions), m.conditions);
    grid.setConditions(flows, m.conditions, { hour: m.hour });
    if (!running) { running = true; loop(); }
  } else if (m.type === 'stop') {
    running = false;
  }
};

function loop() {
  if (!running) return;
  const t0 = performance.now();
  const dt = grid.step();
  self.postMessage({ type: 'state', FV: grid.FV, T: grid.T, time: grid.time, dt, ms: performance.now() - t0, iterations: grid.iterations });
  setTimeout(loop, 0);
}
