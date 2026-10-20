// Serves the repository on http://localhost:8000 for development.
// Browsers only load JavaScript modules over http, not from file:// paths.
//
//   node tools/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
