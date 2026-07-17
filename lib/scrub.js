'use strict';

// Strip location + PII metadata from a media file before it is encrypted and
// committed — but ONLY if it actually carries any. A file with no identifying
// metadata (a screenshot, a generated image) is left byte-for-byte untouched.
//
// When a strip is needed it is LOSSLESS — metadata only, never the pixels or the
// video stream:
//   • images → exiftool -all= (keeping only Orientation + colour profile)
//   • video  → ffmpeg -map_metadata -1 -c copy (stream-copied, not re-encoded)

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const M = require('./manifest');

function haveExiftool() { return !spawnSync('exiftool', ['-ver']).error; }
function haveFfmpeg() { return !spawnSync('ffmpeg', ['-version']).error; }

// Tags/groups that identify a place, a device, or a person. If any are present,
// the file gets scrubbed. Deliberately broad — better a needless lossless
// rewrite than a leaked coordinate.
const PII_TAGS = [
  '-GPS:all', '-Location', '-LocationName', '-GPSCoordinates', '-GPSPosition',
  '-Make', '-Model', '-LensMake', '-LensModel',
  '-SerialNumber', '-InternalSerialNumber', '-LensSerialNumber', '-CameraSerialNumber', '-BodySerialNumber',
  '-OwnerName', '-CameraOwnerName', '-Artist', '-Creator', '-By-line', '-Copyright', '-Rights',
  '-HostComputer',
  '-MakerNotes:all', '-XMP:all', '-IPTC:all',
];

// Does the file carry any identifying metadata? (exiftool prints only tags that
// are actually present, so any output means "yes".)
function hasPii(file) {
  const r = spawnSync('exiftool', ['-s', '-s', '-s', ...PII_TAGS, file], { encoding: 'utf8' });
  if (r.error) return null;                    // exiftool missing — caller decides
  return r.stdout.trim().length > 0;
}

function hasGps(file) {
  const r = spawnSync('exiftool', ['-n', '-s', '-GPS:all', file], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// Returns { changed, clean?, tool?, warning? }.
function scrub(file) {
  const ext = path.extname(file).toLowerCase();
  const isVideo = M.VIDEO_EXT.has(ext);
  const isImage = M.IMAGE_EXT.has(ext);
  if (!isVideo && !isImage) return { changed: false, warning: `unknown type ${ext} — not scrubbed` };

  if (!haveExiftool()) return { changed: false, warning: 'exiftool not installed — cannot check/strip metadata' };

  const pii = hasPii(file);
  if (pii === false) return { changed: false, clean: true };   // already clean → leave as-is

  if (isImage) {
    const r = spawnSync('exiftool', [
      '-all=', '-tagsFromFile', '@', '-Orientation', '-ICC_Profile',
      '-overwrite_original', '-q', '-P', file,
    ], { encoding: 'utf8' });
    if (r.status !== 0) return { changed: false, warning: `exiftool failed: ${(r.stderr || '').trim()}` };
    const out = { changed: true, tool: 'exiftool' };
    if (hasGps(file)) out.warning = 'GPS tag still present after strip!';
    return out;
  }

  // video
  if (!haveFfmpeg()) return { changed: false, warning: 'ffmpeg not installed — video NOT scrubbed' };
  const tmp = file + '.scrub.tmp' + ext;
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', file, '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', tmp,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch {}
    return { changed: false, warning: `ffmpeg strip failed: ${(r.stderr || '').trim()}` };
  }
  fs.renameSync(tmp, file);
  return { changed: true, tool: 'ffmpeg' };
}

// Sweep local media files and strip PII from any that carry it. Pass an explicit
// list (e.g. just-dropped files) or omit to walk all of media/. Clean files are
// left byte-for-byte untouched.
function scrubAll(files) {
  const list = files || walkMedia(M.MEDIA_DIR);
  let checked = 0, scrubbed = 0;
  const warnings = [];
  for (const f of list) {
    const ext = path.extname(f).toLowerCase();
    if (!M.IMAGE_EXT.has(ext) && !M.VIDEO_EXT.has(ext)) continue;
    checked++;
    const r = scrub(f);
    const rel = path.relative(M.MEDIA_DIR, f);
    if (r.changed) { scrubbed++; console.log(`  scrubbed  ${rel}`); }
    if (r.warning) warnings.push(`${rel}: ${r.warning}`);
  }
  console.log(`checked ${checked} media file(s), scrubbed ${scrubbed}`);
  if (warnings.length) { console.log(`⚠ ${warnings.length} warning(s):`); for (const w of warnings) console.log(`  ${w}`); }
  return { checked, scrubbed, warnings };
}

function walkMedia(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
}

module.exports = { scrub, scrubAll, hasPii, hasGps, haveExiftool, haveFfmpeg };
