// A static file server for development. No dependencies — Node's own http and
// fs are enough for a game that is served as plain files.
//
// It exists for one reason: `Cache-Control: no-store`. Python's http.server
// sends no cache headers at all, which lets the browser heuristically cache ES
// modules, and a heuristically cached module is a nightmare to diagnose — the
// page runs a mix of old and new files and reports errors about exports that
// plainly exist. Edited files must always be the ones that load.
//
//   node tools/devserver.mjs [port]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : '.');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a))) || 8145;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';

  // normalize() collapses any ../ before it can escape the served directory.
  const file = join(ROOT, normalize(path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: path + '/' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
      // The whole point of this file.
      'Cache-Control': 'no-store, must-revalidate',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`lil-farm dev server on http://localhost:${PORT} (no-store)`);
});
