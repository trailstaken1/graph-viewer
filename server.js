#!/usr/bin/env node
'use strict';

// graph-viewer — gallery + video-graph over an encrypted, git-committed library.
//
//   node server.js               serve at 127.0.0.1:8080 (gallery + graph)
//   node server.js resolve       populate media/ from the manifest (setup.sh uses this)
//   node server.js pack [--all]  encrypt new media + datestamp (pack.sh uses this)
//   node server.js splice …      slice a video into frames + clips (see below)
//
// The server never touches the passphrase or the private key: setup.sh has
// already decrypted the manifest and media, and the server just reads media.json
// fresh on every request (so editing it + refreshing shows changes with no
// restart) and serves media/ and public/ statically.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const M = require('./lib/manifest');

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

/* ------------------------------------------------------------ manifest API */

// Enrich the raw manifest for the browser: add derived type + working URL, and
// drop nothing — src stays so the client can show provenance if it wants.
function manifestForClient() {
  const m = M.read();
  return {
    version: m.version,
    albums: m.albums || {},
    graphs: m.graphs || {},
    items: m.items.map((it) => ({
      id: it.id,
      name: it.name,
      title: it.title || null,
      album: it.album || '',
      date: it.date || null,
      cover: !!it.cover,
      prompt: it.prompt || null,
      w: it.w || null,
      h: it.h || null,
      type: M.typeOf(it),
      url: M.workingUrl(it),
      src: it.src || [],
    })),
  };
}

/* ------------------------------------------------------------------ serving */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
};

// Serve a file with HTTP range support (needed for video seeking/looping).
function sendFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404).end('Not found'); return; }
  if (!stat.isFile()) { res.writeHead(404).end('Not found'); return; }

  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) { start = Math.max(0, stat.size - (end || 0)); end = stat.size - 1; }
    else if (end === null || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Resolve a request path to a file inside one of the allowed roots.
function within(rootDir, rel) {
  const p = path.resolve(rootDir, '.' + rel);
  if (p !== rootDir && !p.startsWith(rootDir + path.sep)) return null;   // traversal guard
  return p;
}

function serve() {
  const HOST = '127.0.0.1';
  const PORT = Number(process.env.PORT) || 8080;

  // Register (and scrub + measure) any hand-dropped files at startup, so
  // `node server.js` on freshly-dropped media just shows them. Only when the
  // manifest is already decrypted — never on an un-set-up clone, so we can't
  // start from an empty manifest and clobber the committed one. It's a cheap
  // no-op when nothing new was dropped. Files dropped WHILE running need a
  // restart (or `node server.js adopt`).
  if (fs.existsSync(M.MANIFEST)) {
    try { require('./lib/adopt').adoptLocal(); } catch (e) { console.warn('  startup adopt skipped:', e.message); }
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }

    if (pathname === '/') pathname = '/index.html';

    // live manifest — read fresh every time
    if (pathname === '/api/media') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(manifestForClient()));
      return;
    }

    // decrypted media
    if (pathname.startsWith('/media/')) {
      const f = within(M.MEDIA_DIR, pathname.slice('/media'.length));
      if (!f) { res.writeHead(403).end('Forbidden'); return; }
      sendFile(req, res, f);
      return;
    }

    // everything else is a static asset
    const f = within(PUBLIC, pathname);
    if (!f) { res.writeHead(403).end('Forbidden'); return; }
    sendFile(req, res, f);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`port ${PORT} in use — try: PORT=8081 node server.js`); process.exit(1); }
    throw e;
  });
  server.listen(PORT, HOST, () => {
    const n = M.read().items.length;
    console.log(`graph-viewer → http://${HOST}:${PORT}  (${n} item${n === 1 ? '' : 's'}, local only)`);
    if (!fs.existsSync(M.MANIFEST)) console.log('  no media.json yet — run ./scripts/setup.sh (or add media.json).');
  });
}

/* -------------------------------------------------------------------- main */

const die = (e) => { console.error(e.message || e); process.exit(1); };
const cmd = process.argv[2];

if (cmd === 'resolve') {
  require('./lib/resolve').resolveAll({ force: process.argv.includes('--force') }).catch(die);
} else if (cmd === 'pack') {
  require('./lib/pack').pack({ all: process.argv.includes('--all'), adopt: !process.argv.includes('--no-adopt') }).catch(die);
} else if (cmd === 'splice' || cmd === 'build') {
  require('./lib/splice').splice(process.argv.slice(3));
} else if (cmd === 'import') {
  require('./lib/import-library').runImport(process.argv.slice(3)).catch(die);
} else if (cmd === 'adopt') {
  require('./lib/adopt').adoptLocal({ dryRun: process.argv.includes('--dry-run') });
} else if (cmd === 'scrub') {
  require('./lib/scrub').scrubAll();   // sweep ALL of media/ for location/PII metadata
} else if (cmd === 'dims') {
  require('./lib/dims').backfillDims();  // record w/h for items missing it
} else if (cmd && cmd !== 'serve') {
  console.error('usage: node server.js [serve|resolve|pack [--all]|splice <video> …|import <library> …|adopt|scrub]');
  process.exit(1);
} else {
  serve();
}
