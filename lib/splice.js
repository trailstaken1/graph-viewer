'use strict';

// Slice a video into frames + clips on a fixed grid, register each as a media
// item, and wire them into a graph in the manifest.
//
//   node server.js splice clip.mov [--interval 5] [--span 60] [--loop 25-30 …]
//                                  [--album Name] [--graph Name]
//
// A --loop a-b means the footage from a to b returns to where it started, so the
// frame at b IS the frame at a: no node for b, the segment becomes a self-loop
// edge, and the next segment departs from the a node. Anything past --span is
// folded into the final clip. Clips are re-encoded (not stream-copied) so each
// cut lines up exactly with the extracted frame.
//
// Output goes into media/<album>/ (gitignored working copies) and into
// media.json (items + graphs[<graph>]). The entire unspliced video is also kept
// as its own item in the album. Run ./scripts/pack.sh afterwards to scrub +
// encrypt for committing.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const M = require('./manifest');

function splice(argv) {
  const input = argv[0];
  if (!input || input.startsWith('-')) {
    console.error('usage: node server.js splice <video> [--interval 5] [--span 60] [--loop a-b] [--album Name] [--graph Name]');
    process.exit(1);
  }
  const opt = { interval: 5, span: 60, album: '', graph: '', loops: [] };
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

  const album = M.safeSegment(opt.album || path.basename(input, path.extname(input)));
  const graphName = opt.graph || album;
  const outDir = path.join(M.MEDIA_DIR, album);

  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
  };

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { encoding: 'utf8' });
  const duration = parseFloat(probe.stdout);
  if (!Number.isFinite(duration)) { console.error('could not read duration'); process.exit(1); }
  const end = Math.round(duration);

  console.log(`input : ${input} (${duration.toFixed(2)}s)  album=${album}  graph=${graphName}`);

  const cuts = [0];
  for (let t = opt.interval; t < opt.span && t < end; t += opt.interval) cuts.push(t);
  cuts.push(end);

  const alias = {};
  for (const range of opt.loops) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) { console.error(`bad loop range: ${range}`); process.exit(1); }
    const [a, b] = [Number(m[1]), Number(m[2])];
    for (const t of [a, b]) if (!cuts.includes(t)) { console.error(`loop bound ${t}s not on the ${opt.interval}s grid`); process.exit(1); }
    alias[b] = a;
    console.log(`loop  : ${a}s → ${b}s (self-loop on the ${a}s node)`);
  }
  const nodeAt = (t) => (t in alias ? alias[t] : t);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const pad = (s) => String(s).padStart(3, '0');

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    if (/^(frame-\d+\.jpg|clip-\d+-\d+\.mp4)$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  }

  const items = [];
  const gnodes = [];
  const nodeItem = {};                 // second -> item id

  // one frame per node
  const seen = new Set();
  for (const cut of cuts) {
    const n = nodeAt(cut);
    if (seen.has(n)) continue;
    seen.add(n);
    const fname = `frame-${pad(n)}.jpg`;
    const abs = path.join(outDir, fname);
    if (cut >= end) ff(['-sseof', '-0.2', '-i', input, '-update', '1', '-q:v', '2', abs]);
    else ff(['-ss', String(cut), '-i', input, '-frames:v', '1', '-q:v', '2', abs]);

    const id = crypto.randomUUID();
    nodeItem[n] = id;
    items.push({ id, name: fname, title: mmss(n), album });
    gnodes.push({ id: `n${n}`, item: id, name: mmss(n) });
    console.log(`frame : ${mmss(n)} -> ${album}/${fname}`);
  }

  // clips + edges
  const MOVFLAGS = '+faststart+frag_keyframe+empty_moov+default_base_moof';
  const gedges = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k], stop = cuts[k + 1];
    const from = nodeAt(start), to = nodeAt(stop);
    const fname = `clip-${pad(start)}-${pad(stop)}.mp4`;
    const abs = path.join(outDir, fname);
    const args = ['-i', input, '-ss', String(start)];
    if (stop < end) args.push('-to', String(stop));
    ff([...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', MOVFLAGS, abs]);

    const self = from === to;
    const id = crypto.randomUUID();
    items.push({ id, name: fname, title: self ? `Loop ${mmss(start)}` : `${mmss(start)}–${mmss(stop)}`, album });
    gedges.push({ id: `e${k + 1}`, from: `n${from}`, to: `n${to}`, item: id, name: self ? `Loop ${mmss(start)}` : `${mmss(start)}–${mmss(stop)}` });
    console.log(`clip  : ${mmss(start)} -> ${mmss(stop)}${self ? '  [self-loop]' : ''}`);
  }

  // Keep the entire unspliced video as its own item in the album (PII is stripped
  // at pack time, like any other media).
  const fullName = M.safeSegment(path.basename(input));
  const fullDest = path.join(outDir, fullName);
  if (path.resolve(fullDest) !== path.resolve(input)) fs.copyFileSync(input, fullDest);
  items.push({ id: crypto.randomUUID(), name: fullName, title: 'Full video', album });
  console.log(`full  : ${fullName} (unspliced, kept in ${album})`);

  // merge into the manifest: append items, set the graph
  const m = M.read();
  m.items.push(...items);
  m.graphs ||= {};
  m.graphs[graphName] = { title: album, nodes: gnodes, edges: gedges };
  M.write(m);

  console.log(`\nwrote media.json: +${items.length} items, graph "${graphName}" (${gnodes.length} nodes, ${gedges.length} edges)`);
  console.log('next: ./scripts/pack.sh   (scrub + encrypt for committing), then node server.js');
}

module.exports = { splice };
