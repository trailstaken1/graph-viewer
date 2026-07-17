'use strict';

// Convert a `library` array (the structure from the old download script) into a
// media.json for this tool. Each collection becomes an album; its cover `c` and
// files `f` become items whose `src` holds the download URL(s). An `s` field
// (string | string[]) is carried across as `additionalLinks` (always an array).
//
// URL handling matches the original script exactly:
//   • a url with no "//" gets "https://" prepended
//   • a url starting with "/" is resolved against the previous file's url
// Cover + files are de-duplicated by resolved url within each collection, so a
// cover that also appears in the file list yields a single item (flagged cover).
//
//   node server.js import <library.js|json> [--check] [--drop-dead]
//                         [--concurrency 8] [--out media.json]
//
// <library file> is required to expose the array — `module.exports = [...]`,
// `module.exports = { library: [...] }`, or a JSON array.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* --------------------------------------------------------------- url helpers */

// prepend https:// unless the url already carries a scheme or is protocol-relative
const complete = (url) => (String(url).includes('//') ? String(url) : `https://${url}`);

// resolve a "/rooted" path against the previous url, exactly as the old script did
function resolveRel(u, prevUrl) {
  if (!u.startsWith('/')) return u;
  const uSlashes = u.split('/').slice(1);
  const prevSlashes = prevUrl.split('/');
  return [...prevSlashes.slice(0, prevSlashes.length - uSlashes.length), ...uSlashes].join('/');
}

const asArray = (s) => (s == null ? [] : Array.isArray(s) ? s.map(String) : [String(s)]);

const sanitize = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+|_+$/g, '') || 'item';

// best-effort extension from a url path (ignoring any ?query / #hash)
function extFromUrl(url, fallback) {
  const pathOnly = String(url).split(/[?#]/)[0];
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(pathOnly);
  return (m ? m[1] : fallback || 'jpg').toLowerCase();
}

function fileName(rawUrl, explicitName, index, fallbackExt) {
  const ext = extFromUrl(rawUrl, fallbackExt);
  let base;
  if (explicitName) base = sanitize(explicitName);
  else {
    const last = decodeURIComponent(String(rawUrl).split(/[?#]/)[0].split('/').pop() || '');
    base = sanitize(last);
  }
  if (!/\.[a-zA-Z0-9]{1,5}$/.test(base)) base = `${base}.${ext}`;
  return index == null ? base : `${String(index).padStart(3, '0')}-${base}`;
}

/* ------------------------------------------------------------ library → media */

function libraryToManifest(library, { defaultExt = 'jpg' } = {}) {
  const items = [];
  const albums = {};
  let covers = 0, files = 0, deduped = 0;

  for (const collection of library) {
    const album = String(collection.n ?? '').trim();
    if (album && !albums[album]) albums[album] = {};
    const seen = new Set();               // dedupe by resolved url within this collection

    const add = (rawUrl, { cover = false, name, s, index } = {}) => {
      const url = complete(rawUrl);
      if (seen.has(url)) { deduped++; return null; }
      seen.add(url);
      const item = {
        id: crypto.randomUUID(),
        name: fileName(rawUrl, name, index, collection.x ?? defaultExt),
        album,
        src: [url],
      };
      if (cover) item.cover = true;
      const extra = asArray(s);
      if (extra.length) item.additionalLinks = extra;   // always an array of strings
      items.push(item);
      return item;
    };

    // cover
    if (collection.c) { if (add(collection.c, { cover: true, name: `${sanitize(album)}-cover`, s: collection.s })) covers++; }

    // files (with the running prevUrl used for "/"-relative resolution)
    let prevUrl = '';
    for (let j = 0; j < (collection.f || []).length; j++) {
      const file = collection.f[j];
      let u = file.u || file;
      u = resolveRel(u, prevUrl);
      prevUrl = u;
      // use an explicit name if given, else let fileName() derive a clean basename from the url
      if (add(u, { name: file.n, s: file.s, index: j })) files++;
    }
  }

  return { manifest: { version: 1, items, albums, graphs: {} }, stats: { covers, files, deduped, total: items.length } };
}

/* ---------------------------------------------------------------- HEAD check */

// Check each item's primary src. HEAD first; fall back to a 1-byte GET for
// servers that reject HEAD. Returns [{ url, status, ok, item }].
async function checkLinks(items, { concurrency = 8 } = {}) {
  const urls = items.map((it) => it.src[0]);
  const results = new Array(urls.length);
  let i = 0;

  async function probe(url) {
    try {
      let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (res.status === 405 || res.status === 501 || res.status === 403) {
        res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
      }
      try { res.body?.cancel?.(); } catch {}
      return { status: res.status, ok: res.status >= 200 && res.status < 400 };
    } catch (e) {
      return { status: 0, ok: false, error: e.message };
    }
  }

  async function worker() {
    while (i < urls.length) {
      const k = i++;
      const r = await probe(urls[k]);
      results[k] = { url: urls[k], item: items[k], ...r };
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

/* --------------------------------------------------------------------- CLI */

async function runImport(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node server.js import <library.js|json> [--check] [--drop-dead] [--concurrency 8] [--out media.json]'); process.exit(1); }

  const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };
  const doCheck = argv.includes('--check');
  const dropDead = argv.includes('--drop-dead');
  const concurrency = Number(flag('--concurrency', 8));
  const out = String(flag('--out', 'media.json'));

  const mod = require(path.resolve(file));
  const library = Array.isArray(mod) ? mod : (mod.library || mod.default || []);
  if (!Array.isArray(library) || !library.length) { console.error(`no library array found in ${file}`); process.exit(1); }

  const { manifest, stats } = libraryToManifest(library);
  console.log(`built ${stats.total} items (${stats.covers} covers, ${stats.files} files) from ${library.length} collections; ${stats.deduped} duplicate url(s) dropped`);

  if (doCheck) {
    console.log(`\nHEAD-checking ${manifest.items.length} url(s) (concurrency ${concurrency})…`);
    const results = await checkLinks(manifest.items, { concurrency });
    const dead = results.filter((r) => !r.ok);
    for (const r of dead) console.log(`  DEAD ${r.status || 'ERR'}  ${r.url}`);
    console.log(`\nlive: ${results.length - dead.length}/${results.length}  |  dead: ${dead.length}`);
    if (dropDead && dead.length) {
      const deadIds = new Set(dead.map((r) => r.item.id));
      manifest.items = manifest.items.filter((it) => !deadIds.has(it.id));
      console.log(`dropped ${dead.length} dead item(s); ${manifest.items.length} remain`);
    } else if (dead.length) {
      // annotate rather than drop, so you can decide later
      const deadIds = new Set(dead.map((r) => r.item.id));
      for (const it of manifest.items) if (deadIds.has(it.id)) it.dead = true;
      console.log('(marked dead items with "dead": true — re-run with --drop-dead to remove)');
    }
  }

  if (fs.existsSync(out)) { fs.copyFileSync(out, out + '.bak'); console.log(`\nbacked up existing ${out} -> ${out}.bak`); }
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out} — ${manifest.items.length} items across ${Object.keys(manifest.albums).length} albums`);
  console.log('next: node server.js resolve   (download every src into media/), then ./scripts/pack.sh');
}

module.exports = { libraryToManifest, checkLinks, complete, resolveRel, runImport };
