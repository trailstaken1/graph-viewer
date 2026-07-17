'use strict';

// media.json — the one source of truth. Committed encrypted as media.json.age,
// decrypted to media.json (gitignored) for local use.
//
// Shape (v1):
// {
//   "version": 1,
//   "items": [
//     { "id": "<uuid>",            // also the media-age/<id>.age filename stem
//       "name": "beach.jpg",        // true filename (extension → image|video)
//       "title": "Sunset",          // optional display title
//       "album": "Holiday",         // optional; ungrouped if absent
//       "date": "2026-07-17",       // yyyy-MM-dd, the latest version's date
//       "cover": true,              // optional; marks the album's cover
//       "src": [                    // NEWEST FIRST; where the bytes can be got:
//         "media-age/<id>.age",     //   local, in this repo (encrypted)
//         "https://…/<id>.age",     //   another repo / host (encrypted)
//         "https://…/orig.jpg" ] }  //   a plain public URL (not encrypted)
//   ],
//   "albums": { "Holiday": { "title": "Holiday 2026", "cover": "<id>" } },  // optional
//   "graphs": {                     // optional; video-graph viewer definitions
//     "main": { "title": "…",
//       "nodes": [ { "id": "n0", "item": "<id>", "name": "0:00" } ],
//       "edges": [ { "id": "e1", "from": "n0", "to": "n5", "item": "<id>", "name": "…" } ] } }
// }

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
// GV_MANIFEST / GV_MEDIA_DIR let demo mode point at examples/ without touching
// the real library. The browser always requests /media/… — the server maps that
// URL onto MEDIA_DIR, whatever it is.
// path.resolve so an absolute GV_MANIFEST/GV_MEDIA_DIR is honored, while a
// relative one (e.g. examples/media) still resolves against the repo root.
const MANIFEST = path.resolve(ROOT, process.env.GV_MANIFEST || 'media.json');
const MANIFEST_ENC = path.join(ROOT, 'media.json.age');
const MEDIA_DIR = path.resolve(ROOT, process.env.GV_MEDIA_DIR || 'media');
const AGE_DIR = path.join(ROOT, 'media-age');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif']);
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.webm', '.avi', '.mkv', '.mpg', '.mpeg', '.wmv', '.flv']);

const empty = () => ({ version: 1, items: [], albums: {}, graphs: {} });

function read() {
  if (!fs.existsSync(MANIFEST)) return empty();
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  m.version ||= 1;
  m.items ||= [];
  m.albums ||= {};
  m.graphs ||= {};
  return m;
}

// Comparator for grouping items by album — natural, case-insensitive, by raw
// album name. Mirrors the gallery's `byAlbum` so file order == display order.
const byAlbum = (a, b) =>
  String(a.album || '').localeCompare(String(b.album || ''), undefined, { numeric: true, sensitivity: 'base' });

function write(m) {
  // Keep items grouped by album on disk. Array.prototype.sort is stable, so
  // this only reorders across albums — the internal order within an album is
  // preserved exactly as it was.
  if (Array.isArray(m.items)) m.items.sort(byAlbum);
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
}

// image | video | other, from the true filename.
function typeOf(item) {
  const ext = path.extname(item.name || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

// Keep album/name inside media/, never letting them escape it.
function safeSegment(s) {
  return String(s || '').replace(/[/\\]+/g, '_').replace(/^\.+/, '').trim();
}

// An album may be a nested path (e.g. "Trips/Italy"); sanitize each segment so
// it round-trips to a real directory and can't escape media/.
function albumSegs(album) {
  return String(album || '').split(/[/\\]+/).map(safeSegment).filter(Boolean);
}

// Where the decrypted working copy lives, and the URL the browser loads.
function workingPath(item) {
  return path.join(MEDIA_DIR, ...albumSegs(item.album), safeSegment(item.name));
}
function workingUrl(item) {
  const segs = [...albumSegs(item.album), safeSegment(item.name)].map(encodeURIComponent);
  return `media/${segs.join('/')}`;
}

// The canonical local encrypted path for an item.
const agePath = (item) => path.join(AGE_DIR, `${item.id}.age`);
const ageRel = (item) => `media-age/${item.id}.age`;

// A filename derived from a URL's last path segment (minus query/hash), for
// items added by URL with no explicit name.
function nameFromUrl(url) {
  const base = decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || '');
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'item';
}

// Distinct album names, in first-seen order, plus a synthetic bucket for
// ungrouped items.
function albumNames(m) {
  const seen = [];
  for (const it of m.items) {
    const a = it.album || '';
    if (!seen.includes(a)) seen.push(a);
  }
  return seen;
}

module.exports = {
  ROOT, MANIFEST, MANIFEST_ENC, MEDIA_DIR, AGE_DIR,
  IMAGE_EXT, VIDEO_EXT,
  empty, read, write,
  typeOf, safeSegment, albumSegs, workingPath, workingUrl, agePath, ageRel, nameFromUrl, albumNames,
};
