'use strict';

// Prepare everything for committing:
//   • encrypt any item whose bytes are in media/ but not yet in media-age/
//   • datestamp (yyyy-MM-dd) any item that has no date yet
//   • make sure each stored item lists its local media-age/<id>.age in src
//   • re-encrypt media.json → media.json.age
//
// With --all, also pull down items that live only remotely, so this repo keeps
// its own encrypted copy rather than depending on someone else's host.

const fs = require('fs');
const path = require('path');

const age = require('./age');
const M = require('./manifest');
const { resolveItem } = require('./resolve');
const { scrub } = require('./scrub');

const today = () => new Date().toISOString().slice(0, 10); // yyyy-MM-dd, no time

async function pack({ all = false } = {}) {
  if (!age.haveRecipient()) {
    throw new Error('.age-recipient missing — run scripts/init.sh once to create the key.');
  }
  const m = M.read();
  const stamp = today();
  let encrypted = 0, dated = 0, stored = 0, skipped = 0, scrubbed = 0;
  const warnings = [];

  for (const item of m.items) {
    if (!item.id) { console.log(`  SKIP (no id) ${item.name}`); skipped++; continue; }

    const localAge = M.agePath(item);
    const rel = M.ageRel(item);
    let working = M.workingPath(item);

    // No local encrypted copy yet: make one from the working file.
    if (!fs.existsSync(localAge)) {
      if (!fs.existsSync(working) && all) {
        // only-remote item: fetch it into media/ first so we can encrypt it
        const r = await resolveItem(item);
        if (r.status === 'missing') { console.log(`  SKIP (no bytes) ${item.name} — ${r.reason}`); skipped++; continue; }
      }
      if (fs.existsSync(working)) {
        // Strip location + PII BEFORE it is ever encrypted or committed — but
        // only if the file actually carries any; clean files are left untouched.
        const s = scrub(working);
        if (s.changed) scrubbed++;
        if (s.warning) { warnings.push(`${item.name}: ${s.warning}`); console.log(`  ⚠ ${item.name}: ${s.warning}`); }
        age.encryptFile(working, localAge);
        encrypted++;
        console.log(`  ${s.changed ? 'scrubbed+encrypted' : 'clean, encrypted   '}  ${item.name} -> ${rel}`);
      } else {
        console.log(`  SKIP (not local) ${item.name} — add the file to media/ or use --all`);
        skipped++;
      }
    }

    // Make sure the local copy is listed as a source (newest first).
    if (fs.existsSync(localAge)) {
      item.src ||= [];
      if (!item.src.includes(rel)) item.src.unshift(rel);
      stored++;
    }

    // Datestamp if missing.
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

  console.log(`\npacked: ${encrypted} newly encrypted (${scrubbed} scrubbed of metadata), ${stored} stored, ${dated} datestamped (${stamp}), ${skipped} skipped`);
  console.log(`wrote media.json.age. Commit: media.json.age, media-age/, .age-recipient, key.age`);
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} scrub warning(s) — check these before committing:`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (untracked.length) {
    console.log(`\nnote: ${untracked.length} file(s) in media/ not in the manifest (add them to media.json to include):`);
    for (const u of untracked.slice(0, 20)) console.log(`  ${u}`);
  }
  return { encrypted, stored, dated, skipped, scrubbed, warnings, untracked };
}

module.exports = { pack, today };
