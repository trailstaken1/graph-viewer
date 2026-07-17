'use strict';

// Record each item's pixel width/height in the manifest so the gallery masonry
// can lay out instantly (from the aspect ratio) and lazy-load — without waiting
// for images to download to learn their size.

const { spawnSync } = require('child_process');
const fs = require('fs');

const M = require('./manifest');

// { w, h } for an image or video, via ffprobe. null if it can't be read.
function probeDims(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /^(\d+)x(\d+)/.exec((r.stdout || '').trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// Fill in w/h for any item that lacks them and has a local working file.
function backfillDims() {
  const m = M.read();
  let set = 0, pending = 0;
  for (const item of m.items) {
    if (item.w && item.h) continue;
    const f = M.workingPath(item);
    if (!fs.existsSync(f)) { pending++; continue; }
    const d = probeDims(f);
    if (d) { item.w = d.w; item.h = d.h; set++; }
  }
  if (set) M.write(m);
  console.log(`dimensions: recorded ${set}${pending ? `, ${pending} not downloaded yet` : ''}`);
  return { set, pending };
}

module.exports = { probeDims, backfillDims };
