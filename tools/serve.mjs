// Serves the repository on http://localhost:8000 for development.
// Browsers only load JavaScript modules over http, not from file:// paths.
//
//   node tools/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/examples/') {
    const found = EXAMPLES.filter((e) => existsSync(e.file)).map((e) => ({ label: e.label, file: path.basename(e.file), url: `/examples/${e.id}.epJSON` }));
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
