'use strict';

// Prepare everything for committing:
//   • decide, per item, whether to store a local encrypted copy (media-age/<id>.age)
//   • scrub PII, then encrypt the ones we store
//   • record an ABSOLUTE url for every stored item (this repo's raw.githubusercontent
//     path) alongside the local path, so the manifest is portable
//   • datestamp (yyyy-MM-dd) any item with no date
//   • re-encrypt media.json → media.json.age
//
// Storage decision (keyed on where an item's bytes come from, not on whether they
// happen to be downloaded locally):
//   • no remote src  (your own media — spliced or dropped in)  → STORE
//   • src on another GitHub repo                                → leverage it, DON'T store
//   • src only on non-GitHub host(s)                            → STORE (don't trust it to stay up)
//   • --all                                                     → STORE everything, GitHub included

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const age = require('./age');
const M = require('./manifest');
const { resolveItem, isRemote } = require('./resolve');
const { scrub } = require('./scrub');

const today = () => new Date().toISOString().slice(0, 10); // yyyy-MM-dd, no time

const isGithubUrl = (u) => {
  try { const h = new URL(u).host.toLowerCase(); return h === 'github.com' || h === 'raw.githubusercontent.com' || h.endsWith('.githubusercontent.com'); }
  catch { return false; }
};

// This repo's raw base, e.g. https://raw.githubusercontent.com/owner/repo/main
// From GV_RAW_BASE, else derived from `git remote get-url origin` + current branch.
let _rawBase;
function repoRawBase() {
  if (_rawBase !== undefined) return _rawBase;
  if (process.env.GV_RAW_BASE) return (_rawBase = process.env.GV_RAW_BASE.replace(/\/+$/, ''));
  const remote = spawnSync('git', ['-C', M.ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const branchR = spawnSync('git', ['-C', M.ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const url = (remote.stdout || '').trim();
  const branch = (branchR.stdout || '').trim() || 'main';
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  _rawBase = m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}` : null;
  return _rawBase;
}

async function pack({ all = false } = {}) {
  if (!age.haveRecipient()) {
    throw new Error('.age-recipient missing — run scripts/init.sh once to create the key.');
  }
  const rawBase = repoRawBase();
  const m = M.read();
  const stamp = today();
  let encrypted = 0, dated = 0, stored = 0, leveraged = 0, skipped = 0, scrubbed = 0;
  const warnings = [];
  let warnedNoRawBase = false;

  const ensureSrc = (item, url, front = false) => {
    item.src ||= [];
    if (!item.src.includes(url)) { front ? item.src.unshift(url) : item.src.push(url); }
  };

  for (const item of m.items) {
    if (!item.id) { console.log(`  SKIP (no id) ${item.name} — run ./scripts/setup.sh (or resolve) first`); skipped++; continue; }

    const localAge = M.agePath(item);
    const rel = M.ageRel(item);
    const working = M.workingPath(item);
    const absUrl = rawBase ? `${rawBase}/${rel}` : null;

    const remotes = (item.src || []).filter(isRemote);
    const hasGithub = remotes.some(isGithubUrl);
    const onlyNonGithub = remotes.length > 0 && !hasGithub;
    const isOwn = remotes.length === 0;         // no remote origin → our own media

    // Should this repo hold its own encrypted copy?
    const materialize = fs.existsSync(localAge) || all || isOwn || onlyNonGithub;

    if (materialize && !fs.existsSync(localAge)) {
      // need the plaintext bytes in media/ to encrypt; fetch if not already there
      if (!fs.existsSync(working)) {
        const r = await resolveItem(item);
        if (r.status === 'missing') { console.log(`  SKIP (no bytes) ${item.name} — ${r.reason}`); skipped++; continue; }
      }
      const s = scrub(working);
      if (s.changed) scrubbed++;
      if (s.warning) { warnings.push(`${item.name}: ${s.warning}`); console.log(`  ⚠ ${item.name}: ${s.warning}`); }
      age.encryptFile(working, localAge);
      encrypted++;
      console.log(`  ${s.changed ? 'scrubbed+encrypted' : 'clean, encrypted   '}  ${item.name} -> ${rel}`);
    }

    if (fs.existsSync(localAge)) {
      // we host it — record the absolute url first, then the local path
      if (absUrl) ensureSrc(item, absUrl, true);
      else if (!warnedNoRawBase) { warnings.push('no git remote / GV_RAW_BASE — cannot add absolute urls'); warnedNoRawBase = true; }
      ensureSrc(item, rel);
      stored++;
    } else {
      // leveraged from elsewhere (a GitHub repo) — it already carries an absolute url
      leveraged++;
      console.log(`  leveraged (not stored) ${item.name} — ${remotes[0] || '(no src)'}`);
    }

    if (!item.date) { item.date = stamp; dated++; }
  }

  // Untracked plaintext sitting in media/ that no item claims.
  const claimed = new Set(m.items.map((it) => M.workingPath(it)));
  const untracked = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!claimed.has(p) && e.name !== '.DS_Store') untracked.push(path.relative(M.ROOT, p));
    }
  };
  walk(M.MEDIA_DIR);

  M.write(m);
  age.encryptFile(M.MANIFEST, M.MANIFEST_ENC);

  console.log(`\npacked: ${encrypted} encrypted (${scrubbed} scrubbed), ${stored} stored here, ${leveraged} leveraged from GitHub, ${dated} datestamped (${stamp}), ${skipped} skipped`);
  if (rawBase) console.log(`absolute urls → ${rawBase}/media-age/<id>.age`);
  console.log(`wrote media.json.age. Commit: media.json.age, media-age/, .age-recipient, key.age`);
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (untracked.length) {
    console.log(`\nnote: ${untracked.length} file(s) in media/ not in the manifest:`);
    for (const u of untracked.slice(0, 20)) console.log(`  ${u}`);
  }
  return { encrypted, stored, leveraged, dated, skipped, scrubbed, warnings, untracked };
}

module.exports = { pack, today, isGithubUrl, repoRawBase };
