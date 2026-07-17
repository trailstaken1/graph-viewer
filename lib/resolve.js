'use strict';

// Turn manifest items into decrypted working files under media/.
//
// For each item, in src order (newest first):
//   • http(s) URL      → fetch the bytes
//   • anything else     → read as a repo-relative local path
// then, if that source ends in `.age`, decrypt it; otherwise use as-is; and
// write the result to media/<album>/<name>. A local media-age/<id>.age is
// always tried first, even if not listed in src, since we know where it lives.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const age = require('./age');
const M = require('./manifest');

// Fetch a URL to a Buffer, following redirects.
function fetchBuffer(link, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const get = link.startsWith('https:') ? https.get : http.get;
    get(link, { headers: { 'User-Agent': 'graph-viewer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, link).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

const isRemote = (s) => /^https?:\/\//i.test(s);
const isAge = (s) => /\.age($|\?)/i.test(s);

// Ordered list of sources to try: the implicit local .age first, then whatever
// the manifest lists (dedped).
function sourcesFor(item) {
  const list = [];
  const localRel = M.ageRel(item);
  if (fs.existsSync(M.agePath(item))) list.push(localRel);
  for (const s of item.src || []) if (!list.includes(s)) list.push(s);
  return list;
}

// Resolve one item → { status, via } where status is
// present | fetched | decrypted | missing.
async function resolveItem(item, { force = false } = {}) {
  const dest = M.workingPath(item);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { status: 'present' };
  }

  const sources = sourcesFor(item);
  if (!sources.length) return { status: 'missing', reason: 'no sources' };

  let lastErr;
  for (const src of sources) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      if (isRemote(src)) {
        const buf = await fetchBuffer(src);
        fs.writeFileSync(dest, isAge(src) ? age.decryptBuffer(buf) : buf);
        return { status: isAge(src) ? 'decrypted' : 'fetched', via: src };
      }

      // local repo-relative path
      const abs = path.resolve(M.ROOT, src);
      if (!fs.existsSync(abs)) throw new Error('not found locally');
      if (isAge(src)) age.decryptFile(abs, dest);
      else fs.copyFileSync(abs, dest);
      return { status: isAge(src) ? 'decrypted' : 'fetched', via: src };
    } catch (e) {
      lastErr = e;
    }
  }
  return { status: 'missing', reason: lastErr ? lastErr.message : 'all sources failed' };
}

async function resolveAll({ force = false } = {}) {
  const m = M.read();
  const counts = { present: 0, fetched: 0, decrypted: 0, missing: 0 };
  const missing = [];
  for (const item of m.items) {
    const r = await resolveItem(item, { force });
    counts[r.status] = (counts[r.status] || 0) + 1;
    const label = `${item.album ? item.album + '/' : ''}${item.name}`;
    if (r.status === 'missing') { missing.push(label); console.log(`  MISSING  ${label} — ${r.reason}`); }
    else console.log(`  ${r.status.padEnd(9)} ${label}`);
  }
  console.log(`\nresolved: ${counts.present} present, ${counts.decrypted} decrypted, ${counts.fetched} fetched, ${counts.missing} missing`);
  return { counts, missing };
}

module.exports = { fetchBuffer, resolveItem, resolveAll, sourcesFor, isRemote, isAge };
