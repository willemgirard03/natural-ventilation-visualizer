// Serves the repository on http://localhost:8000 for development.
// Browsers only load JavaScript modules over http, not from file:// paths.
//
//   node tools/serve.mjs [port]

import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The two course examples, offered on the import page when they are on this computer. They stay
// outside the repository (see .gitignore); only this local development server reads them.
const A2 = path.resolve(ROOT, '..');
const EXAMPLES = [
  { id: 'example02', label: 'Example 02', file: path.join(A2, 'Example 02', 'Results', '2226_Emmenweid.epJSON') },
  { id: 'example01', label: 'Example 01', file: path.join(A2, 'Example 01', 'CS Results', 'Willem_Girard_CS_V3.epJSON') },
];

// Weather files in A2's Weather Files folder, offered the same way.
const WEATHER = path.join(A2, 'Weather Files');
const weatherFiles = () => (existsSync(WEATHER) ? readdirSync(WEATHER).filter((f) => f.toLowerCase().endsWith('.epw')) : []);

// EnergyPlus runs for the page: the network model it built (posted as JSON), run with one of the
// weather files above, results written under runs/live (ignored by Git). One run at a time.
// EnergyPlus must be on an internal drive (it crashes on the exFAT project drive); run
// tools/run_alignment.py once to copy it there.
const EPLUS = path.join(process.env.EPLUS_DIR || 'C:/EnergyPlus-23.1.0', 'energyplus.exe');
let running = false;
async function runEnergyPlus(req, res) {
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (running) return json(409, { error: 'EnergyPlus is already running.' });
  if (!existsSync(EPLUS)) return json(503, { error: `EnergyPlus not found at ${EPLUS}. Run tools/run_alignment.py once to set it up.` });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 50e6) return json(413, { error: 'Model too large.' }); }
  let input;
  try { input = JSON.parse(body); } catch { return json(400, { error: 'Not JSON.' }); }
  // A weather file the server offers, by name, or one loaded in the page, sent with the model.
  const own = typeof input.weatherText === 'string';
  if (!own && !weatherFiles().includes(input.weather)) return json(400, { error: 'Pick a weather file first.' });
  running = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'runs', 'live', stamp);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'run.epJSON'), JSON.stringify(input.epjson));
    const epw = own ? path.join(dir, 'weather.epw') : path.join(WEATHER, input.weather);
    if (own) await writeFile(epw, input.weatherText);
    const start = Date.now();
    const code = await new Promise((resolve) => {
      const p = spawn(EPLUS, ['-w', epw, '-d', dir, '-p', 'run', '-s', 'C', path.join(dir, 'run.epJSON')], { stdio: 'ignore' });
      p.on('error', () => resolve(-1));
      p.on('close', resolve);
    });
    await rm(path.join(dir, 'runShading.csv'), { force: true });
    const err = await readFile(path.join(dir, 'run.err'), 'utf8').catch(() => '');
    const summary = err.trim().split(/\r?\n/).pop() || '';
    if (code !== 0) return json(500, { error: `EnergyPlus failed (exit ${code}): ${summary.trim()}` });
    json(200, { seconds: (Date.now() - start) / 1000, summary: summary.trim(), eso: `/runs/live/${stamp}/run.eso` });
  } finally {
    running = false;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/run' && req.method === 'POST') return runEnergyPlus(req, res);
  // ClimateStudio's results for each example (zone temperatures), streamed: they run to 150 MB.
  if (url.pathname === '/results/') {
    const found = EXAMPLES.map((e) => ({ ...e, results: e.file.replace(/\.epJSON$/, 'out.eso') })).filter((e) => existsSync(e.results))
      .map((e) => ({ id: e.id, label: e.label, file: path.basename(e.results), url: `/results/${e.id}.eso` }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(found));
  }
  const results = EXAMPLES.find((e) => url.pathname === `/results/${e.id}.eso`);
  if (results) {
    const file = results.file.replace(/\.epJSON$/, 'out.eso');
    if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return createReadStream(file).pipe(res);
  }
  if (url.pathname === '/weather/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(weatherFiles()));
  }
  if (url.pathname.startsWith('/weather/')) {
    const name = decodeURIComponent(url.pathname.slice('/weather/'.length));
    if (!weatherFiles().includes(name)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(await readFile(path.join(WEATHER, name)));
  }
  if (url.pathname === '/examples/') {
    const found = EXAMPLES.filter((e) => existsSync(e.file)).map((e) => ({ id: e.id, label: e.label, file: path.basename(e.file), url: `/examples/${e.id}.epJSON` }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(found));
  }
  const example = EXAMPLES.find((e) => url.pathname === `/examples/${e.id}.epJSON`);
  if (example) {
    try {
      const body = await readFile(example.file);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(body);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (url.pathname === '/') { res.writeHead(302, { Location: '/app/import.html' }); return res.end(); }
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Serving ${ROOT} at http://localhost:${PORT}/`));
