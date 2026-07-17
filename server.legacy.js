#!/usr/bin/env node
'use strict';

/**
 * Video Graph Viewer — everything in one file.
 *
 *   node server.js build clip.mov --loop 25-30    split a video into a graph
 *   node server.js                                serve it at 127.0.0.1:8080
 *
 * `build` cuts the video on a fixed grid (default every 5s across 60s), saves
 * the frame at each cut as a node image, and writes nodes.json. A --loop a-b
 * says the footage from a to b returns to where it started, so the frame at b
 * IS the frame at a: no node is made for b, the segment becomes a self-loop on
 * the node at a, and the next segment departs from that same node. Anything
 * past the span is folded into the final clip.
 *
 * Serving is local-only (binds 127.0.0.1). The page, styles and client code are
 * embedded below; only nodes.json and media/ are read from disk.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const GRAPH = 'nodes.json';

/* =========================================================================
 * MEDIA — mirror the graph's files on catbox.moe, and pull them back down
 *
 * `upload` puts every local file on catbox and records the URL alongside it in
 * nodes.json, as a `src` field. The local path stays exactly as it was, and is
 * still what the page loads:
 *
 *   { "id": "n0", "image": "media/node-000.jpg", "src": "https://files.catbox.moe/ab12cd.jpg" }
 *
 * So nodes.json + server.js is now enough to reconstitute the whole thing. On
 * startup, anything with a `src` whose local file is missing is downloaded and
 * moved into place. Once it is on disk it is never fetched again — `src` is
 * only ever a recovery instruction, never something the page loads from.
 * ========================================================================= */

const readGraph = () => JSON.parse(fs.readFileSync(path.join(ROOT, GRAPH), 'utf8'));
const writeGraph = (g) => fs.writeFileSync(path.join(ROOT, GRAPH), JSON.stringify(g, null, 2) + '\n');

// Every media file the graph refers to: node images and edge videos alike.
function assets(g) {
  const list = [];
  for (const n of g.nodes || []) list.push({ obj: n, key: 'image', id: n.id });
  for (const e of g.edges || []) list.push({ obj: e, key: 'video', id: e.id });
  return list.filter((a) => a.obj[a.key]);
}

// A `src` in nodes.json decides where a file is written, so treat it as
// untrusted: keep the destination inside this folder.
function safeDest(rel) {
  const dest = path.resolve(ROOT, rel);
  if (dest !== ROOT && !dest.startsWith(ROOT + path.sep)) {
    throw new Error(`refusing to write outside the project folder: ${rel}`);
  }
  return dest;
}

// The catbox userhash, if there is one. It is a credential — anyone holding it
// can upload to and delete from the account — so it lives in a chmod-600 file
// (or the environment), never in this source and never in nodes.json.
function userhash() {
  if (process.env.CATBOX_USERHASH) return process.env.CATBOX_USERHASH.trim();
  try {
    return fs.readFileSync(path.join(ROOT, '.catbox-userhash'), 'utf8').trim();
  } catch {
    return '';
  }
}

function catboxUpload(file) {
  return new Promise((resolve, reject) => {
    const boundary = '----vgv' + crypto.randomBytes(8).toString('hex');
    const field = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

    const uh = userhash();
    const head = field('reqtype', 'fileupload') +
      (uh ? field('userhash', uh) : '') +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="${path.basename(file)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n';
    const tail = `\r\n--${boundary}--\r\n`;
    const size = fs.statSync(file).size;

    const req = https.request({
      host: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(head) + size + Buffer.byteLength(tail),
        'User-Agent': 'video-graph-viewer',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const out = body.trim();
        if (res.statusCode === 200 && /^https?:\/\//.test(out)) resolve(out);
        else reject(new Error(`catbox said ${res.statusCode}: ${out.slice(0, 200) || '(empty body — throttled?)'}`));
      });
    });

    req.on('error', reject);
    req.write(head);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('end', () => req.end(tail));
    stream.pipe(req, { end: false });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many bytes does this url actually serve?
function remoteSize(link, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.request(link, { method: 'HEAD', headers: { 'User-Agent': 'video-graph-viewer' } }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(remoteSize(new URL(res.headers.location, link).href, hops + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      resolve(Number(res.headers['content-length'] ?? -1));
    });
    req.on('error', reject);
    req.end();
  });
}

// Upload, then PROVE it landed.
//
// When catbox is throttling you it has two failure modes, and the second one is
// the dangerous one: sometimes it returns nothing, but sometimes it returns a
// perfectly valid url and stores an EMPTY FILE behind it. A uploader that trusts
// the returned url will happily report 43/43 uploaded and leave you with 43 dead
// links. So the url is not the receipt — reading the bytes back is.
async function catboxUploadVerified(file) {
  const want = fs.statSync(file).size;
  const link = await catboxUpload(file);
  const got = await remoteSize(link);
  if (got !== want) {
    throw new Error(`stored ${got} of ${want} bytes (catbox is throttling us) ${link}`);
  }
  return link;
}

// A throttle is a "come back later", not a bad file, so back off hard.
async function catboxUploadRetrying(file, tries = 5) {
  let wait = 15000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await catboxUploadVerified(file);
    } catch (e) {
      if (attempt >= tries) throw e;
      process.stdout.write(`\n        ${e.message.split(' (')[0]} — retry ${attempt}/${tries - 1} in ${wait / 1000}s … `);
      await sleep(wait);
      wait = Math.min(wait * 2, 120000);
    }
  }
}

// Download to a .part file and rename only on success, so an interrupted fetch
// can never leave a truncated video looking like a real one.
function download(link, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    if (!/^https?:\/\//.test(link)) return reject(new Error(`not an http(s) url: ${link}`));

    const get = link.startsWith('https:') ? https.get : http.get;
    get(link, { headers: { 'User-Agent': 'video-graph-viewer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, link).href, dest, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = dest + '.part';
      const out = fs.createWriteStream(part);
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        fs.renameSync(part, dest);
        resolve(fs.statSync(dest).size);
      });
    }).on('error', reject);
  });
}

const mb = (n) => `${(n / 1e6).toFixed(1)}MB`;

async function cmdUpload(argv) {
  const force = argv.includes('--force');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? Number(argv[li + 1]) : Infinity;

  // Seconds to wait between files. Uploads are already strictly one at a time;
  // this is the gap between them. It is deliberately generous — hammering catbox
  // is what got us throttled, and a throttled catbox does not fail cleanly, it
  // hands back working urls that serve empty files.
  const pi = argv.indexOf('--pace');
  const pace = (pi >= 0 ? Number(argv[pi + 1]) : 20) * 1000;

  const g = readGraph();
  let todo = assets(g).filter((a) => force || !a.obj.src);

  // Images first, then videos; smallest first within each. If we get throttled
  // part way through, the cheap files are already banked and the run resumes
  // from where it stopped — rather than dying on a 20MB clip having achieved
  // nothing.
  const sizeOf = (a) => {
    try { return fs.statSync(path.join(ROOT, a.obj[a.key])).size; } catch { return 0; }
  };
  todo.sort((a, b) =>
    (a.key === 'image' ? 0 : 1) - (b.key === 'image' ? 0 : 1) || sizeOf(a) - sizeOf(b));

  if (Number.isFinite(limit)) todo = todo.slice(0, limit);

  if (!todo.length) {
    console.log('every file already has a src. Use --force to re-upload.');
    return;
  }

  console.log(`uploading ${todo.length} file(s) to catbox.moe — these become PUBLIC urls\n`);
  let done = 0, failed = 0;

  for (const a of todo) {
    const file = path.join(ROOT, a.obj[a.key]);
    if (!fs.existsSync(file)) { console.log(`  ${a.id.padEnd(5)} SKIP  missing: ${a.obj[a.key]}`); continue; }
    process.stdout.write(`  ${a.id.padEnd(5)} ${a.obj[a.key]} (${mb(fs.statSync(file).size)}) … `);
    try {
      a.obj.src = await catboxUploadRetrying(file);
      console.log(a.obj.src);
      done++;
      writeGraph(g);           // save as we go: a failure later cannot lose these
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      failed++;
    }

    if (todo.indexOf(a) < todo.length - 1 && pace) {
      process.stdout.write(`        waiting ${pace / 1000}s before the next file…\r`);
      await sleep(pace);
      process.stdout.write(' '.repeat(48) + '\r');
    }
  }

  writeGraph(g);
  console.log(`\nuploaded ${done}, failed ${failed}. ${GRAPH} now carries the urls to rebuild media/ from scratch.`);
  if (failed) console.log('re-run `node server.js upload` to retry just the failures — anything with a src is skipped.');
}

// Pull down anything that has a `src` but no local file. Returns how many.
async function fetchMissing(quiet) {
  if (!fs.existsSync(path.join(ROOT, GRAPH))) return 0;

  let g;
  try { g = readGraph(); } catch (e) { console.error(`bad ${GRAPH}: ${e.message}`); return 0; }

  const missing = assets(g).filter((a) => a.obj.src && !fs.existsSync(safeDest(a.obj[a.key])));
  if (!missing.length) {
    if (!quiet) console.log('all media present, nothing to fetch.');
    return 0;
  }

  console.log(`fetching ${missing.length} missing file(s)…`);
  let ok = 0;
  for (const a of missing) {
    const rel = a.obj[a.key];
    process.stdout.write(`  ${a.id.padEnd(5)} ${a.obj.src} -> ${rel} … `);
    try {
      const size = await download(a.obj.src, safeDest(rel));
      console.log(mb(size));
      ok++;
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  console.log(`fetched ${ok}/${missing.length}.\n`);
  return ok;
}

/* =========================================================================
 * BUILD — split a video into clips + frames, and write nodes.json
 * ========================================================================= */

function buildGraph(argv) {
  const input = argv[0];
  if (!input || input.startsWith('-')) {
    console.error('usage: node server.js build <video> [--interval 5] [--span 60] [--loop 25-30 ...] [--out media] [--json nodes.json]');
    process.exit(1);
  }

  const opt = { interval: 5, span: 60, out: 'media', json: 'nodes.json', loops: [] };
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined) { console.error(`missing value for --${k}`); process.exit(1); }
    if (k === 'loop') opt.loops.push(v);
    else if (k === 'interval' || k === 'span') opt[k] = Number(v);
    else if (k in opt) opt[k] = v;
    else { console.error(`unknown option --${k}`); process.exit(1); }
  }

  if (!fs.existsSync(input)) { console.error(`no such file: ${input}`); process.exit(1); }
  for (const bin of ['ffmpeg', 'ffprobe']) {
    if (spawnSync(bin, ['-version']).error) { console.error(`${bin} not found on PATH`); process.exit(1); }
  }

  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
  };

  const probe = spawnSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
    { encoding: 'utf8' });
  const duration = parseFloat(probe.stdout);
  if (!Number.isFinite(duration)) { console.error('could not read duration'); process.exit(1); }
  const end = Math.round(duration);

  console.log(`input    : ${input} (${duration.toFixed(2)}s)`);
  console.log(`grid     : every ${opt.interval}s across ${opt.span}s; excess folded into the last clip`);

  // Cut points: interior cuts strictly inside (0, span); the closing boundary is
  // the end of the file, so a 62s input still ends with one clip 55s -> 62s.
  const cuts = [0];
  for (let t = opt.interval; t < opt.span && t < end; t += opt.interval) cuts.push(t);
  cuts.push(end);

  // alias[b] = a  —  "the frame at b is the frame at a"
  const alias = {};
  for (const range of opt.loops) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) { console.error(`bad loop range: ${range} (expected a-b)`); process.exit(1); }
    const [a, b] = [Number(m[1]), Number(m[2])];
    for (const t of [a, b]) {
      if (!cuts.includes(t)) { console.error(`loop bound ${t}s is not on the ${opt.interval}s grid`); process.exit(1); }
    }
    alias[b] = a;
    console.log(`loop     : ${a}s -> ${b}s returns to the ${a}s frame (self-loop)`);
  }
  const nodeAt = (t) => (t in alias ? alias[t] : t);

  fs.mkdirSync(opt.out, { recursive: true });
  for (const f of fs.readdirSync(opt.out)) {
    if (/^(node-\d+\.jpg|clip-\d+-\d+\.mp4)$/.test(f)) fs.unlinkSync(path.join(opt.out, f));
  }

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const pad = (s) => String(s).padStart(3, '0');

  // one frame per node
  const nodes = [];
  const seen = new Set();
  for (const cut of cuts) {
    const n = nodeAt(cut);
    if (seen.has(n)) continue;          // aliased away by a loop
    seen.add(n);

    const img = `${opt.out}/node-${pad(n)}.jpg`;
    if (cut >= end) {
      // the closing node is the genuine last frame, not the frame at `span`
      ff(['-sseof', '-0.2', '-i', input, '-update', '1', '-q:v', '2', img]);
    } else {
      ff(['-ss', String(cut), '-i', input, '-frames:v', '1', '-q:v', '2', img]);
    }
    console.log(`frame    : ${mmss(n)} -> ${img}`);
    nodes.push({ id: `n${n}`, name: mmss(n), image: img });
  }

  // the clips. Re-encoded, not stream-copied: -c copy snaps each cut to the
  // nearest keyframe, and the clips would stop lining up with the frames above.
  const MOVFLAGS = '+faststart+frag_keyframe+empty_moov+default_base_moof';
  const edges = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k];
    const stop = cuts[k + 1];
    const from = nodeAt(start);
    const to = nodeAt(stop);
    const out = `${opt.out}/clip-${pad(start)}-${pad(stop)}.mp4`;

    const args = ['-i', input, '-ss', String(start)];
    if (stop < end) args.push('-to', String(stop));   // else: run to EOF
    ff([...args,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', MOVFLAGS, out]);

    const self = from === to;
    console.log(`clip     : ${mmss(start)} -> ${mmss(stop)}${self ? `  [self-loop on ${mmss(from)}]` : ''}`);
    edges.push({
      id: `e${k + 1}`,
      name: self ? `Loop ${mmss(start)}` : `${mmss(start)} - ${mmss(stop)}`,
      from: `n${from}`,
      to: `n${to}`,
      video: out,
    });
  }

  if (fs.existsSync(opt.json)) {
    fs.copyFileSync(opt.json, opt.json + '.bak');
    console.log(`backup   : ${opt.json}.bak`);
  }
  const title = path.basename(input, path.extname(input));
  fs.writeFileSync(opt.json, JSON.stringify({ title, nodes, edges }, null, 2) + '\n');

  console.log(`\nwrote    : ${opt.json} — ${nodes.length} nodes, ${edges.length} edges`);
  console.log('now run  : node server.js');
}

/* =========================================================================
 * The page
 * ========================================================================= */

const CSS = `
:root {
  --bg: #0b0b0f;
  --panel: #121218;
  --line: #23232e;
  --text: #e9e9f0;
  --dim: #6b6b7b;
  --hot: #ff2d95;
  --hot-soft: rgba(255, 45, 149, 0.42);
  --hot-faint: rgba(255, 45, 149, 0.16);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; height: 100%;
  background: var(--bg); color: var(--text);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  overflow: hidden;
}
#app { display: grid; grid-template-columns: 1fr minmax(320px, 38%); height: 100%; }

/* ---------- graph pane ---------- */
#graph-pane {
  position: relative; min-width: 0;
  background: radial-gradient(1200px 800px at 30% 20%, #14141c 0%, var(--bg) 70%);
}
.pane-head { position: absolute; top: 0; left: 0; right: 0; padding: 18px 22px; pointer-events: none; z-index: 2; }
.pane-head h1 {
  margin: 0; font-size: 15px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--text);
}
.hint { margin: 6px 0 0; font-size: 12px; color: var(--dim); }
.hint b { color: #9a9aad; font-weight: 600; }
#graph { width: 100%; height: 100%; display: block; cursor: grab; user-select: none; touch-action: none; }

/* edges */
.edge-hit { fill: none; stroke: transparent; stroke-width: 22; cursor: pointer; }
.edge-base {
  fill: none; stroke: #2e2e3c; stroke-width: 2; pointer-events: none;
  transition: stroke 220ms ease, stroke-width 220ms ease;
}
.edge.next .edge-base   { stroke: var(--hot-soft); stroke-width: 2.5; }   /* one step ahead */
.edge.future .edge-base { stroke: var(--hot-faint); }                     /* two steps ahead */
.edge.queued .edge-base { stroke: #4b4b60; stroke-dasharray: 5 5; }
.edge.hover .edge-base  { stroke: #6f6f8a; }
.edge.active .edge-base { stroke: rgba(255, 45, 149, 0.25); stroke-width: 3; }

/* jump cut: no clip behind it, so it is drawn as an open dashed line and never
   fills with playback progress — there is nothing to play */
.edge.jump .edge-base     { stroke-dasharray: 9 7; stroke-width: 1.6; }
.edge.jump .edge-progress { display: none; }
.edge.jump .edge-label    { font-style: italic; letter-spacing: 0.03em; }
.edge.jump .edge-arrow    { opacity: 0.75; }

/* the pink fill that tracks playback progress along the active edge */
.edge-progress {
  fill: none; stroke: var(--hot); stroke-width: 3.5; stroke-linecap: round;
  pointer-events: none; opacity: 0;
  filter: drop-shadow(0 0 6px rgba(255, 45, 149, 0.55));
}
.edge.active .edge-progress { opacity: 1; }

.edge-arrow { fill: #2e2e3c; pointer-events: none; transition: fill 220ms ease; }
.edge.next .edge-arrow   { fill: var(--hot-soft); }
.edge.future .edge-arrow { fill: var(--hot-faint); }
.edge.active .edge-arrow { fill: var(--hot); }

.edge-label {
  fill: var(--dim); font-size: 11px; text-anchor: middle; pointer-events: none;
  paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
  transition: fill 220ms ease;
}
.edge.next .edge-label   { fill: #9a7f92; }
.edge.active .edge-label { fill: var(--hot); font-weight: 600; }
.edge.hover .edge-label  { fill: var(--text); }

/* nodes */
.node { cursor: pointer; }
.node-img { opacity: 0.35; transition: opacity 260ms ease; }
.node.next .node-img   { opacity: 0.6; }
.node.future .node-img { opacity: 0.45; }
.node.hover .node-img,
.node.source .node-img,
.node.target .node-img { opacity: 1; }

.node-ring { fill: none; stroke: #2e2e3c; stroke-width: 2; transition: stroke 220ms ease, stroke-width 220ms ease; }
.node.next .node-ring   { stroke: var(--hot-soft); }
.node.future .node-ring { stroke: var(--hot-faint); }
.node.hover .node-ring  { stroke: #8a8aa5; }
.node.queued .node-ring { stroke: #4b4b60; stroke-dasharray: 4 4; }
.node.source .node-ring { stroke: var(--hot); stroke-width: 2.5; stroke-dasharray: 3 4; opacity: 0.8; }
.node.target .node-ring { stroke: var(--hot); stroke-width: 4; filter: drop-shadow(0 0 8px rgba(255, 45, 149, 0.6)); }

.node-label {
  fill: var(--dim); font-size: 12px; font-weight: 500; text-anchor: middle; pointer-events: none;
  paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
  transition: fill 220ms ease;
}
.node.source .node-label,
.node.target .node-label,
.node.hover .node-label { fill: var(--text); }
.node.target .node-label { fill: var(--hot); font-weight: 700; }

.node-badge circle { fill: var(--hot); }
.node-badge text { fill: #12000a; font-size: 10px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }

/* loop regions — click inside one to repeat it */
.loop-region { fill: transparent; stroke: none; cursor: pointer; transition: fill 200ms ease; }
.loop-region.hover  { fill: rgba(255, 45, 149, 0.07); }
.loop-region.locked { fill: rgba(255, 45, 149, 0.11); }

/* ---------- player pane ---------- */
#player-pane { display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--line); min-width: 0; }
#stage { position: relative; flex: 1; min-height: 0; background: #000; overflow: hidden; }
#stage video {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
  opacity: 0;   /* no fade: we want a hard cut, a crossfade would show both frames */
}
#stage video.live { opacity: 1; }

/* the held still shown while parked on a node, waiting for a direction */
#still { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; pointer-events: none; }
#still.live { opacity: 1; }
#park-hint {
  position: absolute; left: 0; right: 0; bottom: 16px; text-align: center;
  font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--hot); text-shadow: 0 1px 8px #000;
  opacity: 0; transition: opacity 220ms ease; pointer-events: none;
}
#park-hint.live { opacity: 1; animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

#now-playing { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; font-size: 13px; min-width: 0; }
.np-node { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#np-to { color: var(--hot); font-weight: 600; }
.np-arrow { color: var(--dim); }
.np-edge { margin-left: auto; color: var(--dim); font-size: 12px; white-space: nowrap; }

#scrub { height: 3px; margin: 0 14px; background: var(--line); border-radius: 2px; overflow: hidden; }
#scrub-fill { height: 100%; width: 0%; background: var(--hot); box-shadow: 0 0 8px rgba(255, 45, 149, 0.7); }

#controls { display: flex; align-items: center; gap: 8px; padding: 12px 14px 14px; flex-wrap: wrap; }
button {
  background: #1c1c25; color: var(--text); border: 1px solid var(--line); border-radius: 6px;
  padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
}
button:hover { background: #262632; border-color: #3a3a4a; }
button.muted { color: var(--dim); }
button.on { background: rgba(255, 45, 149, 0.14); border-color: var(--hot); color: var(--hot); }

#queue { display: flex; gap: 6px; margin-left: auto; overflow-x: auto; max-width: 100%; }
.chip {
  flex: none; padding: 3px 8px; border-radius: 999px; background: #1c1c25;
  border: 1px solid var(--line); color: var(--dim); font-size: 11px; white-space: nowrap;
}
.chip.loop { border-color: var(--hot); color: var(--hot); }

@media (max-width: 900px) {
  #app { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
  #player-pane { border-left: none; border-top: 1px solid var(--line); }
}
`;

/* =========================================================================
 * CLIENT — a real function, not a string, so it keeps its template literals
 * and can still be syntax-checked. Serialised into the page below.
 * ========================================================================= */

function client() {
  'use strict';

  const CFG = {
    nodeRadius: 46,
    edgeLength: 300,          // spring rest length
    repulsion: 300000,        // higher = airier layout, nodes hold each other further off
    spring: 0.02,
    damping: 0.86,
    centerPull: 0.005,        // the only thing stopping the graph drifting away for good
    focusPull: 0.022,         // pulls the clip we are playing towards the middle
    maxCycleLength: 6,        // longest loop we detect for click-to-repeat

    // How early to start the next clip, in seconds. A video element takes a few
    // frames to actually begin playing, and if we only start it once the current
    // clip has ended, that startup shows as a frozen frame. Starting it this far
    // ahead hides the startup behind the tail of the outgoing clip. The cost is
    // that we may cut up to this much off that tail — at 80ms, invisible.
    preroll: 0.08,

    // Autoplay: score = loopLength + recencyWeight / (1 + clipsSincePlayed).
    // Lowest score wins, ties broken at random. A clip is never played twice in
    // a row while another option exists.
    noLoopScore: 99,          // an edge you cannot get back from
    recencyWeight: 2.5,       // >0 stops the graph settling into one tight loop
  };

  let G = { nodes: [], edges: [], byId: {}, out: {}, dist: {} };
  let cycles = [];

  const play = {
    edge: null,               // edge currently on screen
    progress: 0,              // 0..1 through that edge
    queue: [],                // user-queued edges, played in order
    loop: null,               // cycle we are locked to, if any
    loopAt: 0,
    next: null,               // the edge we have committed to (and preloaded)
    history: [],              // edge ids, most recent last
    parked: null,             // node we are stopped on
    paused: false,
    repeat: false,            // Loop toggle: replay the current clip, never move on
  };

  const svg = document.getElementById('graph');
  const scene = document.getElementById('scene');
  const layers = {
    loops: document.getElementById('layer-loops'),
    edges: document.getElementById('layer-edges'),
    nodes: document.getElementById('layer-nodes'),
  };

  // Viewport. Node coordinates are world coordinates and are never clamped to
  // the window; this transform is the only thing that decides what you can see.
  const view = { x: 0, y: 0, k: 1 };
  const applyView = () => scene.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);

  // Until you pan or zoom, the camera keeps the whole graph framed by itself —
  // otherwise an unclamped node could wander off with no way to find it again.
  // Any manual pan/zoom hands control over to you; Fit takes it back.
  let autoFit = true;
  const videos = [document.getElementById('video-a'), document.getElementById('video-b')];
  let live = 0;
  let handing = false;        // a hand-over is in flight: the next clip is already rolling
  let hover = { node: null, edge: null, loop: null };
  let W = 0, H = 0;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* --------------------------------------------------------------- graph */

  async function loadGraph() {
    const data = await (await fetch('nodes.json')).json();
    document.getElementById('graph-title').textContent = data.title || 'Video Graph';
    document.title = data.title || 'Video Graph Viewer';

    G.nodes = data.nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }));
    G.edges = data.edges.map((e) => ({ ...e }));
    G.byId = {};
    G.out = {};

    for (const n of G.nodes) { G.byId[n.id] = n; G.out[n.id] = []; }
    for (const e of G.edges) {
      if (!G.byId[e.from] || !G.byId[e.to]) { console.warn(`edge ${e.id} references a missing node`); continue; }
      G.out[e.from].push(e);
      e.self = e.from === e.to;
      // An edge with no video is a jump cut: it is traversed instantly, and the
      // picture cuts straight from the clip before it to the clip after it.
      e.jump = !e.video;
    }

    // Parallel edges get fanned out so they don't draw on top of each other.
    const bundles = {};
    for (const e of G.edges) {
      const key = e.self ? `self:${e.from}` : [e.from, e.to].sort().join('~');
      (bundles[key] ||= []).push(e);
    }
    for (const key in bundles) {
      bundles[key].forEach((e, i) => { e.slot = i; e.slots = bundles[key].length; });
    }

    // Seed on a circle so the simulation opens up rather than exploding out of a point.
    const cx = W / 2, cy = H / 2;
    G.nodes.forEach((n, i) => {
      const a = (i / G.nodes.length) * Math.PI * 2;
      n.x = cx + Math.cos(a) * 160;
      n.y = cy + Math.sin(a) * 160;
    });

    computeDistances();
    cycles = findCycles();
  }

  // All-pairs shortest hop counts (BFS from every node). Graphs here are tiny.
  function computeDistances() {
    G.dist = {};
    for (const src of G.nodes) {
      const d = { [src.id]: 0 };
      const q = [src.id];
      while (q.length) {
        const cur = q.shift();
        for (const e of G.out[cur]) {
          if (!(e.to in d)) { d[e.to] = d[cur] + 1; q.push(e.to); }
        }
      }
      G.dist[src.id] = d;
    }
  }

  const hops = (from, to) => {
    const d = G.dist[from];
    return d && to in d ? d[to] : Infinity;
  };

  // Shortest edge-path from `from` to `to`. Equal-length paths chosen at random.
  function shortestPath(from, to) {
    if (from === to) return [];
    const prev = {};
    const seen = new Set([from]);
    let frontier = [from];

    while (frontier.length) {
      const next = [];
      for (const cur of shuffle(frontier.slice())) {
        for (const e of shuffle(G.out[cur].slice())) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          prev[e.to] = e;
          if (e.to === to) {
            const path = [];
            for (let at = to; at !== from; at = prev[at].from) path.unshift(prev[at]);
            return path;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return null;               // unreachable
  }

  // Every simple cycle up to CFG.maxCycleLength, deduped by edge set.
  function findCycles() {
    const found = [];
    const seen = new Set();
    const index = {};
    G.nodes.forEach((n, i) => (index[n.id] = i));

    const walk = (start, cur, pathEdges, visited) => {
      for (const e of G.out[cur]) {
        if (e.to === start) {
          const edges = [...pathEdges, e];
          const key = edges.map((x) => x.id).sort().join(',');
          if (!seen.has(key)) { seen.add(key); found.push({ edges, nodes: edges.map((x) => x.from) }); }
          continue;
        }
        // only extend through nodes "after" the start, so each cycle is found once
        if (index[e.to] < index[start] || visited.has(e.to)) continue;
        if (pathEdges.length + 1 >= CFG.maxCycleLength) continue;
        visited.add(e.to);
        walk(start, e.to, [...pathEdges, e], visited);
        visited.delete(e.to);
      }
    };

    for (const n of G.nodes) walk(n.id, n.id, [], new Set([n.id]));
    return found.sort((a, b) => a.edges.length - b.edges.length);
  }

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  /* ------------------------------------------------------------- autoplay */

  // Prefer the exit with the shortest loop back to here; if nothing loops back,
  // effectively random.
  function autoPick(node, avoidEdgeId) {
    let options = G.out[node] || [];
    if (!options.length) return null;
    if (options.length > 1 && avoidEdgeId) {
      const trimmed = options.filter((e) => e.id !== avoidEdgeId);
      if (trimmed.length) options = trimmed;
    }

    const scored = options.map((e) => {
      const back = hops(e.to, node);
      const loopLen = back === Infinity ? CFG.noLoopScore : 1 + back;
      const idx = play.history.lastIndexOf(e.id);
      const since = idx === -1 ? Infinity : play.history.length - idx;
      const recency = idx === -1 ? 0 : CFG.recencyWeight / (1 + since);
      return { e, score: loopLen + recency };
    });

    const best = Math.min(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score <= best + 1e-9);
    return winners[Math.floor(Math.random() * winners.length)].e;
  }

  /* ----------------------------------------------------- planning / routing */

  // Route from wherever the current clip is heading — we never cut a clip short.
  const planOrigin = () => (play.edge ? play.edge.to : play.parked);

  function plannedEnd() {
    if (play.queue.length) return play.queue[play.queue.length - 1].to;
    return planOrigin();
  }

  function routeToNode(nodeId, append) {
    const from = append ? plannedEnd() : planOrigin();
    const path = shortestPath(from, nodeId);
    if (!path) return;

    // Clicking the node you are already on (or already heading to) has nowhere
    // to travel, so the path comes back empty and the click would do nothing at
    // all. Read it as "play what this node has": if it carries a loop clip, that
    // is its footage, so play it — explicitly asked for, so even if it has just
    // been played.
    if (!path.length) {
      const held = pendingLoop(nodeId, null);
      if (held) path.push(held);
    }

    if (!append) { play.queue = []; play.loop = null; }
    play.queue.push(...path);
    planChanged();
  }

  function routeToEdge(edge, append) {
    const from = append ? plannedEnd() : planOrigin();
    const lead = shortestPath(from, edge.from);
    if (!lead) return;
    if (!append) { play.queue = []; play.loop = null; }
    play.queue.push(...lead, edge);
    planChanged();
  }

  function lockLoop(cycle) {
    const from = planOrigin();
    let bestEntry = null, bestPath = null;
    for (const nid of cycle.nodes) {
      const p = shortestPath(from, nid);
      if (p && (!bestPath || p.length < bestPath.length)) { bestPath = p; bestEntry = nid; }
    }
    if (!bestPath) return;

    play.queue = [...bestPath];
    play.loop = cycle;
    play.loopAt = cycle.edges.findIndex((e) => e.from === bestEntry);
    if (play.loopAt < 0) play.loopAt = 0;
    planChanged();
  }

  // The plan changed: recommit and re-preload whatever comes next.
  function planChanged() {
    const committed = chainClip();
    replan();
    if (chainClip() !== committed) preloadNext();

    // Picking a destination while parked is the cue to start moving again.
    // advance() walks the chain, so this works whether the first step is a clip
    // or a jump cut.
    if (play.parked && play.chain.length && (play.queue.length || play.loop)) {
      advance();
      return;
    }
    render();
  }

  // What happens after this clip, up to and including the next thing that
  // actually has footage.
  //
  // Normally that is one edge. But jump cuts carry no clip, so a plan can run
  // through several of them before reaching real footage — and it is that clip,
  // not the jump, that we must preload if the cut is to stay seamless. So we
  // resolve the whole chain ahead of time: zero or more jumps, then one clip.
  //
  // Decisions are taken here ONCE and held in play.chain, because autoPick is
  // random: asking twice would give two different answers, and we would preload
  // a clip we then do not play.
  function buildChain() {
    const chain = [];
    let origin = planOrigin();
    if (origin == null) return chain;

    // walk a copy of the plan's cursors, committing nothing
    let qi = 0;
    let loopAt = play.loopAt;
    let lastId = play.edge ? play.edge.id : null;

    for (let guard = 0; guard < 16; guard++) {
      // peek at the next step WITHOUT consuming it, so we can still put a loop
      // clip in front of it below
      let e = null, fromQueue = false, fromLoop = false;
      if (qi < play.queue.length) { e = play.queue[qi]; fromQueue = true; }
      else if (play.loop) { e = play.loop.edges[loopAt % play.loop.edges.length]; fromLoop = true; }
      else if (play.repeat && play.edge && !play.edge.jump) e = play.edge;
      else e = autoPick(origin, lastId);

      if (!e) break;

      // A jump cut shows nothing. If we are about to leave this node by one, but
      // the node has a loop clip we have not just played, play that first — the
      // jump keeps its place and is taken next time round. Without this, a route
      // that happens to pass through here skips the node's own footage entirely,
      // and if nothing leads back, you never see it at all.
      if (e.jump) {
        const held = pendingLoop(origin, lastId);
        if (held) { chain.push(held); break; }   // note: queue/loop cursors NOT advanced
      }

      if (fromQueue) qi++;
      else if (fromLoop) loopAt++;

      chain.push(e);
      if (!e.jump) break;              // reached real footage: chain is complete
      origin = e.to;                   // step through the jump and keep looking
      lastId = e.id;
    }
    return chain;                      // an all-jump chain (no clip) is possible, and handled
  }

  // A loop clip on this node that is still owed a play: it has footage, and it
  // is not the clip we have just come off. Least recently played wins.
  function pendingLoop(nodeId, lastId) {
    const held = (G.out[nodeId] || []).filter((e) => e.self && !e.jump && e.id !== lastId);
    if (!held.length) return null;

    let best = null, bestSince = -1;
    for (const e of held) {
      const idx = play.history.lastIndexOf(e.id);
      const since = idx === -1 ? Infinity : play.history.length - idx;
      if (since > bestSince) { bestSince = since; best = e; }
    }
    return best;
  }

  // The clip at the end of the chain — the one we should be buffering.
  function chainClip() {
    if (!play.chain || !play.chain.length) return null;
    const last = play.chain[play.chain.length - 1];
    return last.jump ? null : last;
  }

  // Recompute what comes next, from wherever the plan now stands.
  function replan() {
    play.chain = buildChain();
    play.next = play.chain[0] || null;
  }

  // Consume whatever produced `edge`, so the plan advances by one.
  function commitNext(edge) {
    if (play.queue.length && play.queue[0] === edge) {
      play.queue.shift();
      // dropping out of a routed path back into a locked loop: line the loop up
      if (!play.queue.length && play.loop) {
        const i = play.loop.edges.indexOf(edge);
        if (i >= 0) play.loopAt = i + 1;
      }
    } else if (play.loop && play.loop.edges[play.loopAt % play.loop.edges.length] === edge) {
      play.loopAt = (play.loopAt + 1) % play.loop.edges.length;
    }
  }

  /* -------------------------------------------------- playback (2 buffers) */

  function videoFor(edge, idx) {
    const v = videos[idx];
    if (v.dataset.edge !== edge.id) {
      v.dataset.edge = edge.id;
      v.src = edge.video;
      v.load();
    }
    return v;
  }

  // Buffer the committed next clip into the element we are NOT driving.
  //
  // Never do this mid-hand-over: until the swap completes, the element we are
  // not driving is the outgoing one, still playing its tail on screen. Loading
  // over it would kill the clip in view. show() re-runs this once it is free.
  function preloadNext() {
    if (handing) return;
    const clip = chainClip();          // look THROUGH any jump cuts to real footage
    if (!clip) return;
    const v = videoFor(clip, 1 - live);
    v.pause();
    try { v.currentTime = 0; } catch { /* not seekable yet; load() lands at 0 */ }
  }

  function startEdge(edge, videoIdx) {
    play.edge = edge;
    play.parked = null;
    play.progress = 0;
    remember(edge);

    const v = videoFor(edge, videoIdx);
    videos.forEach((x, i) => x.classList.toggle('live', i === videoIdx));
    live = videoIdx;
    v.currentTime = 0;
    if (!play.paused) v.play().catch(() => {});

    replan();
    preloadNext();
    render();
  }

  function remember(edge) {
    play.history.push(edge.id);
    if (play.history.length > 40) play.history.shift();
  }

  // Cut to `edge` on the idle element. The outgoing clip's last frame and the
  // incoming clip's first frame are the same still, so holding the old frame for
  // the beat it takes the new element to decode is invisible — that is what
  // makes the cut look seamless.
  function transitionTo(edge) {
    const idx = 1 - live;               // the idle element becomes the incoming one
    const old = videos[live];
    const v = videoFor(edge, idx);

    handing = true;
    live = idx;                         // drive the incoming element from here on,
                                        // so nothing else can target it as "idle"
    play.edge = edge;
    play.parked = null;
    play.progress = 0;
    remember(edge);

    // The outgoing element keeps playing, and stays visible, right up to the
    // moment the incoming one paints its first frame — so there is never a
    // moment with nothing to show.
    const show = () => {
      if (!handing) return;             // already swapped
      videos.forEach((x, i) => x.classList.toggle('live', i === idx));
      old.pause();
      handing = false;
      preloadNext();                    // only now is the other element free
    };

    const go = () => {
      if (v.currentTime > 0) v.currentTime = 0;   // avoid a needless seek/flush
      if (play.paused) { show(); return; }
      Promise.resolve(v.play())
        .then(() => {
          // swap on the incoming element's first painted frame
          if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(show);
          else show();
        })
        .catch(show);
    };

    if (v.readyState >= 2) go();
    else v.addEventListener('loadeddata', go, { once: true });

    replan();
    render();
  }

  // Hand over to whatever the plan says is next: step through any jump cuts
  // instantly, then play the first clip with real footage behind it.
  function advance() {
    if (handing) return;                 // already rolling into the next clip

    const chain = (play.chain && play.chain.length) ? play.chain : buildChain();
    if (!chain.length) { park(play.edge ? play.edge.to : play.parked); return; }   // dead end

    for (const e of chain) {
      commitNext(e);
      if (!e.jump) { transitionTo(e); return; }
      // a jump cut has no duration: cross it and keep going, without touching
      // the video elements — the outgoing clip stays on screen until the next
      // real clip paints, which is exactly what makes it read as a cut
      remember(e);
      play.edge = e;
      play.parked = null;
    }

    // nothing but jumps and then nowhere to go
    park(chain[chain.length - 1].to);
  }

  // Double-click a connection: abandon the plan and take it now.
  function jumpToEdge(edge) {
    play.queue = [];
    play.loop = null;

    if (edge.jump) {                   // no footage: cross it and play what follows
      remember(edge);
      play.edge = edge;
      play.parked = null;
      replan();
      advance();
      return;
    }
    transitionTo(edge);
  }

  // Double-click a node: arrive now and STOP, holding its still, so the user can
  // choose a direction. Autoplay does not resume on its own.
  //
  // Unless there is nothing to choose: with exactly one way out, stopping to ask
  // is just a dead pause, so we take it.
  function park(nodeId) {
    play.queue = [];
    play.loop = null;
    play.edge = null;
    play.parked = nodeId;
    play.progress = 0;

    // A node with a loop clip has footage of its own, so there is nothing to ask
    // about yet: play the loop and carry on. No special case afterwards — the
    // loop was simply the last clip played, so the ordinary autoplay rule takes
    // it from there and moves on to the next edge.
    const held = pendingLoop(nodeId, null);
    if (held) { transitionTo(held); return; }

    // advance() walks jump cuts, so this is right even when the only way out of
    // here is a jump.
    if ((G.out[nodeId] || []).length === 1) { replan(); advance(); return; }

    videos.forEach((v) => { v.pause(); v.classList.remove('live'); });
    document.getElementById('scrub-fill').style.width = '0%';

    // Buffer the likeliest exit, so whatever they pick is more likely to be warm.
    replan();
    preloadNext();
    render();
  }

  function jumpToLoop(cycle) {
    play.queue = [];
    play.loop = cycle;
    play.loopAt = 0;
    replan();
    advance();                         // handles a cycle that opens with a jump cut
  }

  function tick() {
    const v = videos[live];
    if (play.edge && v.duration) {
      play.progress = Math.min(1, v.currentTime / v.duration);
      document.getElementById('scrub-fill').style.width = `${play.progress * 100}%`;

      // Start the next clip before this one ends, so its startup latency is
      // spent while the current clip is still on screen rather than after it.
      const remaining = v.duration - v.currentTime;
      if (!handing && !play.paused && play.chain && play.chain.length
          && remaining > 0 && remaining <= CFG.preroll) {
        advance();          // walks any jump cuts, then plays the next real clip
      }
    }
    simulate();
    if (autoFit) fitView();
    draw();
    requestAnimationFrame(tick);
  }

  /* --------------------------------------------------------- force layout */

  function simulate() {
    const cx = W / 2, cy = H / 2;
    const focus = play.edge ? play.edge.to : play.parked;

    for (let i = 0; i < G.nodes.length; i++) {
      const a = G.nodes[i];
      let fx = 0, fy = 0;

      for (let j = 0; j < G.nodes.length; j++) {
        if (i === j) continue;
        const b = G.nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = CFG.repulsion / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }

      fx += (cx - a.x) * CFG.centerPull;
      fy += (cy - a.y) * CFG.centerPull;

      // bias the layout around what is playing, so options open up in view
      if (a.id === focus) {
        fx += (cx - a.x) * CFG.focusPull;
        fy += (cy - a.y) * CFG.focusPull;
      }

      a.vx = (a.vx + fx * 0.01) * CFG.damping;
      a.vy = (a.vy + fy * 0.01) * CFG.damping;
    }

    for (const e of G.edges) {
      if (e.self) continue;
      const a = G.byId[e.from], b = G.byId[e.to];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - CFG.edgeLength) * CFG.spring;
      const ux = (dx / d) * f, uy = (dy / d) * f;
      a.vx += ux; a.vy += uy;
      b.vx -= ux; b.vy -= uy;
    }

    // No clamping to the window: nodes live in world space and may sit off
    // screen. The gentle pull towards the centre above is what keeps the layout
    // from drifting away for good; pan and zoom decide what is actually visible.
    for (const n of G.nodes) {
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // Frame the whole graph.
  function fitView() {
    if (!G.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of G.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = CFG.nodeRadius + 70;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    view.k = Math.min(W / (maxX - minX), H / (maxY - minY), 1.6);
    view.x = W / 2 - ((minX + maxX) / 2) * view.k;
    view.y = H / 2 - ((minY + maxY) / 2) * view.k;
    applyView();
  }

  /* -------------------------------------------------------------- geometry */

  // Edge as an SVG path, trimmed to the node rims. Parallel edges bow apart;
  // self-loops become a teardrop off the node.
  function edgePath(e) {
    const a = G.byId[e.from], b = G.byId[e.to];
    const R = CFG.nodeRadius;

    if (e.self) {
      const spread = 0.55, lift = 118 + e.slot * 46;
      // Throw the loop into free space rather than always straight up: point it
      // away from the node's neighbours, so the teardrop stops landing on top of
      // whatever happens to be sitting above.
      const base = freeAngle(a) + e.slot * 0.9;
      const p1 = { x: a.x + Math.cos(base - spread) * R, y: a.y + Math.sin(base - spread) * R };
      const p2 = { x: a.x + Math.cos(base + spread) * R, y: a.y + Math.sin(base + spread) * R };
      const c1 = { x: a.x + Math.cos(base - spread) * lift, y: a.y + Math.sin(base - spread) * lift };
      const c2 = { x: a.x + Math.cos(base + spread) * lift, y: a.y + Math.sin(base + spread) * lift };
      return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    }

    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const bow = (e.slot - (e.slots - 1) / 2) * 62;      // fan parallel edges out
    const mx = (a.x + b.x) / 2 - (dy / d) * bow;
    const my = (a.y + b.y) / 2 + (dx / d) * bow;

    const a1 = Math.atan2(my - a.y, mx - a.x);
    const a2 = Math.atan2(my - b.y, mx - b.x);
    const sx = a.x + Math.cos(a1) * R, sy = a.y + Math.sin(a1) * R;
    const ex = b.x + Math.cos(a2) * (R + 9), ey = b.y + Math.sin(a2) * (R + 9);

    return `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
  }

  // The emptiest direction out of a node: opposite the average bearing of its
  // neighbours. Used to aim self-loops away from the rest of the graph.
  function freeAngle(n) {
    let sx = 0, sy = 0;
    for (const e of G.edges) {
      if (e.self) continue;
      let other = null;
      if (e.from === n.id) other = G.byId[e.to];
      else if (e.to === n.id) other = G.byId[e.from];
      if (!other) continue;
      const dx = other.x - n.x, dy = other.y - n.y;
      const d = Math.hypot(dx, dy) || 1;
      sx += dx / d;
      sy += dy / d;
    }
    if (Math.hypot(sx, sy) < 0.01) return -Math.PI / 2;   // no neighbours: straight up
    return Math.atan2(-sy, -sx);                          // away from the crowd
  }

  // Closed outline of a cycle — the clickable "inside the loop" region.
  function cyclePath(cycle) {
    const pts = [];
    for (const e of cycle.edges) {
      const p = cycle.paths[e.id];
      if (!p) continue;
      const L = p.getTotalLength();
      const steps = e.self ? 14 : 8;
      for (let i = 0; i <= steps; i++) {
        const pt = p.getPointAtLength((L * i) / steps);
        pts.push(`${pt.x} ${pt.y}`);
      }
    }
    return pts.length ? `M ${pts.join(' L ')} Z` : '';
  }

  /* ---------------------------------------------------------- click routing */

  // A single click has to hold back long enough to know a second one isn't
  // coming. ⌘/Ctrl-click (queue) can't be doubled, so it fires straight away.
  const DOUBLE_CLICK_MS = 230;
  let pendingClick = null;

  function onSingle(ev, route) {
    ev.stopPropagation();
    if (ev.metaKey || ev.ctrlKey) { route(true); return; }
    clearTimeout(pendingClick);
    pendingClick = setTimeout(() => { pendingClick = null; route(false); }, DOUBLE_CLICK_MS);
  }

  function onDouble(ev, jump) {
    ev.stopPropagation();
    clearTimeout(pendingClick);
    pendingClick = null;
    jump();
  }

  /* ------------------------------------------------------------- rendering */

  const gfx = { nodes: {}, edges: {}, loops: [] };

  function buildScene() {
    layers.loops.innerHTML = '';
    layers.edges.innerHTML = '';
    layers.nodes.innerHTML = '';
    gfx.nodes = {}; gfx.edges = {}; gfx.loops = [];

    // loop regions sit under everything; smallest drawn last so it wins the click
    cycles.forEach((cycle) => {
      const region = el('path', { class: 'loop-region' });
      region.addEventListener('mouseenter', () => { hover.loop = cycle; render(); });
      region.addEventListener('mouseleave', () => { if (hover.loop === cycle) hover.loop = null; render(); });
      region.addEventListener('click', (ev) => onSingle(ev, () => lockLoop(cycle)));
      region.addEventListener('dblclick', (ev) => onDouble(ev, () => jumpToLoop(cycle)));
      layers.loops.appendChild(region);
      gfx.loops.push({ cycle, region });
      cycle.paths = {};
    });

    for (const e of G.edges) {
      const g = el('g', { class: 'edge' });
      const base = el('path', { class: 'edge-base' });
      const prog = el('path', { class: 'edge-progress' });
      const hit = el('path', { class: 'edge-hit' });
      const arrow = el('path', { class: 'edge-arrow' });
      const label = el('text', { class: 'edge-label' });
      label.textContent = e.name || e.id;

      hit.addEventListener('mouseenter', () => { hover.edge = e; render(); });
      hit.addEventListener('mouseleave', () => { if (hover.edge === e) hover.edge = null; render(); });
      hit.addEventListener('click', (ev) => onSingle(ev, (append) => routeToEdge(e, append)));
      hit.addEventListener('dblclick', (ev) => onDouble(ev, () => jumpToEdge(e)));

      g.append(base, prog, arrow, hit, label);
      layers.edges.appendChild(g);
      gfx.edges[e.id] = { g, base, prog, hit, arrow, label };

      for (const { cycle } of gfx.loops) {
        if (cycle.edges.includes(e)) cycle.paths[e.id] = base;
      }
    }

    for (const n of G.nodes) {
      const g = el('g', { class: 'node' });
      const clipId = `clip-${n.id}`;
      const clip = el('clipPath', { id: clipId });
      clip.appendChild(el('circle', { r: CFG.nodeRadius - 2 }));

      const img = el('image', {
        class: 'node-img',
        href: n.image,
        width: CFG.nodeRadius * 2,
        height: CFG.nodeRadius * 2,
        x: -CFG.nodeRadius,
        y: -CFG.nodeRadius,
        preserveAspectRatio: 'xMidYMid slice',
        'clip-path': `url(#${clipId})`,
      });
      const ring = el('circle', { class: 'node-ring', r: CFG.nodeRadius });
      const hit = el('circle', { class: 'node-hit', r: CFG.nodeRadius, fill: 'transparent' });
      const label = el('text', { class: 'node-label', y: CFG.nodeRadius + 20 });
      label.textContent = n.name || n.id;

      const badge = el('g', { class: 'node-badge' });
      badge.append(el('circle', { r: 9, cx: CFG.nodeRadius - 6, cy: -CFG.nodeRadius + 6 }));
      const badgeText = el('text', { x: CFG.nodeRadius - 6, y: -CFG.nodeRadius + 6 });
      badge.appendChild(badgeText);
      badge.style.display = 'none';

      g.addEventListener('mouseenter', () => { hover.node = n; render(); });
      g.addEventListener('mouseleave', () => { if (hover.node === n) hover.node = null; render(); });
      g.addEventListener('click', (ev) => onSingle(ev, (append) => routeToNode(n.id, append)));
      g.addEventListener('dblclick', (ev) => onDouble(ev, () => park(n.id)));

      g.append(clip, img, ring, hit, badge, label);
      layers.nodes.appendChild(g);
      gfx.nodes[n.id] = { g, badge, badgeText };
    }
  }

  // Positions change every frame; classes only when the plan does.
  function draw() {
    for (const e of G.edges) {
      const gg = gfx.edges[e.id];
      const d = edgePath(e);
      gg.base.setAttribute('d', d);
      gg.prog.setAttribute('d', d);
      gg.hit.setAttribute('d', d);

      const L = gg.base.getTotalLength();
      const tip = gg.base.getPointAtLength(L);
      const before = gg.base.getPointAtLength(Math.max(0, L - 1));
      const ang = (Math.atan2(tip.y - before.y, tip.x - before.x) * 180) / Math.PI;
      gg.arrow.setAttribute('d', 'M 0 -5 L 10 0 L 0 5 Z');
      gg.arrow.setAttribute('transform', `translate(${tip.x} ${tip.y}) rotate(${ang})`);

      const mid = gg.base.getPointAtLength(L / 2);
      gg.label.setAttribute('x', mid.x);
      gg.label.setAttribute('y', mid.y - 8);
    }

    for (const n of G.nodes) {
      gfx.nodes[n.id].g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    }

    for (const { cycle, region } of gfx.loops) {
      region.setAttribute('d', cyclePath(cycle));
    }

    paintProgress();
  }

  function paintProgress() {
    for (const e of G.edges) {
      const gg = gfx.edges[e.id];
      if (play.edge && e.id === play.edge.id) {
        const L = gg.base.getTotalLength();
        gg.prog.setAttribute('stroke-dasharray', `${L * play.progress} ${L}`);
      } else {
        gg.prog.setAttribute('stroke-dasharray', '0 1');
      }
    }
  }

  // Highlight: the current edge and its two nodes, the options one step ahead,
  // and the options after those.
  function render() {
    const cur = play.edge;
    const target = cur ? cur.to : play.parked;

    const nextEdges = new Set();
    const futureEdges = new Set();
    const nextNodes = new Set();
    const futureNodes = new Set();

    if (target) {
      for (const e of G.out[target] || []) {
        nextEdges.add(e.id);
        nextNodes.add(e.to);
        for (const e2 of G.out[e.to] || []) {
          futureEdges.add(e2.id);
          futureNodes.add(e2.to);
        }
      }
    }

    const queuedEdges = new Set(play.queue.map((e) => e.id));
    const queuePos = {};
    play.queue.forEach((e, i) => { if (!(e.to in queuePos)) queuePos[e.to] = i + 1; });

    for (const e of G.edges) {
      const c = gfx.edges[e.id].g.classList;
      c.toggle('jump', !!e.jump);
      c.toggle('active', !!cur && e.id === cur.id);
      c.toggle('next', nextEdges.has(e.id) && (!cur || e.id !== cur.id));
      c.toggle('future', futureEdges.has(e.id) && !nextEdges.has(e.id) && (!cur || e.id !== cur.id));
      c.toggle('queued', queuedEdges.has(e.id));
      c.toggle('hover', hover.edge === e);
    }

    for (const n of G.nodes) {
      const gg = gfx.nodes[n.id];
      const c = gg.g.classList;
      c.toggle('source', !!cur && n.id === cur.from);
      c.toggle('target', n.id === target);
      c.toggle('next', nextNodes.has(n.id) && n.id !== target);
      c.toggle('future', futureNodes.has(n.id) && !nextNodes.has(n.id) && n.id !== target);
      c.toggle('queued', n.id in queuePos);
      c.toggle('hover', hover.node === n);

      if (n.id in queuePos) {
        gg.badge.style.display = '';
        gg.badgeText.textContent = queuePos[n.id];
      } else {
        gg.badge.style.display = 'none';
      }
    }

    for (const { cycle, region } of gfx.loops) {
      region.classList.toggle('hover', hover.loop === cycle);
      region.classList.toggle('locked', play.loop === cycle);
    }

    // player chrome
    const parked = !cur && play.parked;
    const still = document.getElementById('still');
    if (parked) {
      const src = G.byId[play.parked].image;
      if (!still.src.endsWith(src)) still.src = src;
    }
    still.classList.toggle('live', !!parked);
    document.getElementById('park-hint').classList.toggle('live', !!parked);

    document.getElementById('np-from').textContent = cur ? G.byId[cur.from].name : '—';
    document.getElementById('np-to').textContent = target ? G.byId[target].name : '—';
    document.getElementById('np-edge').textContent =
      cur ? (cur.name || cur.id) : parked ? 'stopped' : 'idle';

    const q = document.getElementById('queue');
    q.innerHTML = '';
    if (play.loop) {
      const chip = document.createElement('span');
      chip.className = 'chip loop';
      chip.textContent = `↻ ${play.loop.edges.map((e) => G.byId[e.from].name).join(' → ')}`;
      q.appendChild(chip);
    }
    play.queue.slice(0, 6).forEach((e) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = e.name || e.id;
      q.appendChild(chip);
    });
  }

  /* -------------------------------------------------------------- controls */

  function wire() {
    videos.forEach((v) => {
      v.addEventListener('ended', () => { if (v === videos[live]) advance(); });
    });

    const btnPlay = document.getElementById('btn-play');
    btnPlay.addEventListener('click', () => {
      if (play.parked) {                 // stopped on a node: carry on under autoplay
        play.paused = false;
        btnPlay.textContent = 'Pause';
        advance();
        return;
      }
      play.paused = !play.paused;
      btnPlay.textContent = play.paused ? 'Play' : 'Pause';
      if (play.paused) videos[live].pause();
      else videos[live].play().catch(() => {});
    });

    const btnMute = document.getElementById('btn-mute');
    btnMute.addEventListener('click', () => {
      const muted = !videos[0].muted;
      videos.forEach((v) => (v.muted = muted));
      btnMute.textContent = muted ? 'Unmute' : 'Mute';
      btnMute.classList.toggle('muted', muted);
      btnMute.classList.toggle('on', !muted);
    });

    const btnLoop = document.getElementById('btn-loop');
    btnLoop.addEventListener('click', () => {
      play.repeat = !play.repeat;
      btnLoop.classList.toggle('on', play.repeat);
      planChanged();                     // recommit and re-preload what comes next
    });

    // Skip means "move on now", so it overrides the hold rather than fighting it.
    document.getElementById("btn-skip").addEventListener("click", () => {
      if (play.repeat && play.edge) {
        const on = autoPick(play.edge.to, play.edge.id);
        if (on) { commitNext(on); transitionTo(on); return; }
      }
      advance();
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      play.queue = [];
      play.loop = null;
      planChanged();
    });

    svg.addEventListener('click', () => { hover.loop = null; render(); });
    document.getElementById('btn-fit').addEventListener('click', () => { autoFit = true; fitView(); });

    /* ---- pan ---- */

    let drag = null;
    let panned = false;      // the pointer moved far enough that this was a pan

    // Deliberately NOT using setPointerCapture here. Capturing on the <svg>
    // retargets the pointer events — and the click they produce — to the <svg>
    // itself, so clicks would never reach the node and edge handlers. Tracking
    // the drag on `window` instead keeps dragging working past the edge of the
    // pane without stealing anything's click.
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
      svg.style.cursor = 'grabbing';
    });

    window.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) autoFit = false;     // you are driving the camera now
      view.x += dx;
      view.y += dy;
      applyView();
    });

    const endPan = () => {
      if (!drag) return;
      if (drag.moved > 4) panned = true;      // swallow the click this produces
      drag = null;
      svg.style.cursor = '';
    };
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);

    // Capture phase, so a pan that finishes over a node never reaches the node's
    // own click handler and starts routing playback.
    svg.addEventListener('click', (ev) => {
      if (!panned) return;
      panned = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);

    /* ---- zoom ---- */

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;

      const k0 = view.k;
      const k1 = Math.min(4, Math.max(0.15, k0 * Math.exp(-ev.deltaY * 0.0015)));
      if (k1 === k0) return;
      autoFit = false;                        // you are driving the camera now

      // keep whatever is under the cursor pinned under the cursor
      view.x = sx - ((sx - view.x) / k0) * k1;
      view.y = sy - ((sy - view.y) / k0) * k1;
      view.k = k1;
      applyView();
    }, { passive: false });

    window.addEventListener('resize', resize);
  }

  function resize() {
    const r = svg.getBoundingClientRect();
    W = r.width; H = r.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }

  /* ------------------------------------------------------------------ boot */

  (async function main() {
    resize();
    await loadGraph();
    buildScene();
    wire();
    render();
    requestAnimationFrame(tick);

    // Kick off from the first node. Muted, so autoplay is never blocked.
    const first = autoPick(G.nodes[0].id, null);
    if (first) startEdge(first, 0);
    else { play.parked = G.nodes[0].id; render(); }
  })();
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Video Graph Viewer</title>
  <style>${CSS}</style>
</head>
<body>
  <div id="app">
    <section id="graph-pane">
      <header class="pane-head">
        <h1 id="graph-title">Video Graph</h1>
        <p class="hint">
          <b>Click</b> to route there ·
          <b>Double-click</b> to go there now ·
          <b>⌘/Ctrl-click</b> to queue ·
          <b>Click inside a loop</b> to repeat it<br />
          <b>Drag</b> to pan · <b>Scroll</b> to zoom
        </p>
      </header>
      <svg id="graph" role="img" aria-label="Video graph">
        <g id="scene">
          <g id="layer-loops"></g>
          <g id="layer-edges"></g>
          <g id="layer-nodes"></g>
        </g>
      </svg>
    </section>

    <section id="player-pane">
      <div id="stage">
        <video id="video-a" playsinline muted preload="auto"></video>
        <video id="video-b" playsinline muted preload="auto"></video>
        <img id="still" alt="" />
        <div id="park-hint">Pick a direction</div>
      </div>

      <div id="now-playing">
        <span id="np-from" class="np-node">—</span>
        <span class="np-arrow">→</span>
        <span id="np-to" class="np-node">—</span>
        <span id="np-edge" class="np-edge"></span>
      </div>

      <div id="scrub"><div id="scrub-fill"></div></div>

      <div id="controls">
        <button id="btn-play" title="Play / pause">Pause</button>
        <button id="btn-mute" title="Mute / unmute" class="muted">Unmute</button>
        <button id="btn-loop" title="Repeat the current clip instead of moving on">Loop</button>
        <button id="btn-skip" title="Skip to the next clip">Skip</button>
        <button id="btn-clear" title="Clear the queue and any loop">Clear</button>
        <button id="btn-fit" title="Fit the whole graph in view">Fit</button>
        <div id="queue" aria-label="Queued clips"></div>
      </div>
    </section>
  </div>

  <script>(${client})();<\/script>
</body>
</html>
`;

/* =========================================================================
 * SERVE — local only
 * ========================================================================= */

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function serve() {
  const HOST = '127.0.0.1';                       // loopback only: not reachable off this machine
  const PORT = Number(process.env.PORT) || 8080;

  if (!fs.existsSync(path.join(ROOT, GRAPH))) {
    console.warn(`warning: no ${GRAPH} here. Run:  node server.js build <video> --loop 25-30`);
  } else {
    // First run on a fresh clone: pull down whatever the graph says is missing.
    // After that the files are on disk and this is a no-op.
    await fetchMissing(true);
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(url.parse(req.url).pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(HTML);
      return;
    }

    // Everything else comes off disk, and must stay inside ROOT.
    const file = path.resolve(ROOT, '.' + pathname);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404).end('Not found'); return; }

      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;

      // Range requests: how the browser buffers and seeks video.
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null) {                       // suffix range: last N bytes
          start = Math.max(0, stat.size - (end || 0));
          end = stat.size - 1;
        } else if (end === null || end >= stat.size) {
          end = stat.size - 1;
        }
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`port ${PORT} is already in use. Try:  PORT=8081 node server.js`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(PORT, HOST, () => {
    console.log(`video graph viewer → http://${HOST}:${PORT}  (local only)`);
  });
}

/* ------------------------------------------------------------------- main */

const USAGE = `usage:
  node server.js build <video> [--interval 5] [--span 60] [--loop a-b]
        cut a video into a graph: clips, frames, and ${GRAPH}

  node server.js upload [--limit N] [--pace SECONDS] [--force]
        upload every media file to catbox.moe and record the urls in ${GRAPH}
        (these become PUBLIC urls — see the notes at the top of this file)

  node server.js fetch
        download any media that ${GRAPH} has a url for but is missing locally

  node server.js
        serve at 127.0.0.1:8080 (fetches missing media first)`;

const cmd = process.argv[2];
const die = (e) => { console.error(e.message || e); process.exit(1); };

if (cmd === 'build') buildGraph(process.argv.slice(3));
else if (cmd === 'upload') cmdUpload(process.argv.slice(3)).catch(die);
else if (cmd === 'fetch') fetchMissing(false).catch(die);
else if (cmd && cmd !== 'serve') { console.error(USAGE); process.exit(1); }
else serve().catch(die);
