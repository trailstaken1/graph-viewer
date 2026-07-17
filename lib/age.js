'use strict';

// Thin wrappers around the `age` CLI.
//
// Encryption uses the PUBLIC recipient (.age-recipient), so it never needs a
// passphrase — packing media is frictionless. Decryption uses the PLAINTEXT
// private identity (key.txt), which setup.sh produces once by unwrapping the
// passphrase-protected key.age on a real terminal. Nothing here ever handles
// the passphrase itself.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const RECIPIENT_FILE = path.join(ROOT, '.age-recipient');
const IDENTITY_FILE = path.join(ROOT, 'key.txt');

function haveAge() {
  return !spawnSync('age', ['--version']).error;
}
const haveRecipient = () => fs.existsSync(RECIPIENT_FILE);
const haveIdentity = () => fs.existsSync(IDENTITY_FILE);

function requireAge() {
  if (!haveAge()) throw new Error('`age` is not installed. Run: brew install age');
}

// Encrypt a file to the repo's public recipient. No passphrase needed.
function encryptFile(inPath, outPath) {
  requireAge();
  if (!haveRecipient()) {
    throw new Error('.age-recipient missing — run scripts/init.sh first to create the key.');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = spawnSync('age', ['-R', RECIPIENT_FILE, '-o', outPath, inPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`age encrypt failed: ${r.stderr?.toString().trim() || r.status}`);
}

// Decrypt an .age file to a destination, using the plaintext identity.
function decryptFile(inPath, outPath) {
  requireAge();
  if (!haveIdentity()) {
    throw new Error('key.txt missing — run scripts/setup.sh to unlock the private key.');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = spawnSync('age', ['-d', '-i', IDENTITY_FILE, '-o', outPath, inPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`age decrypt failed for ${inPath}: ${r.stderr?.toString().trim() || r.status}`);
}

// Decrypt a Buffer of .age bytes (e.g. fetched from a remote) to a Buffer.
function decryptBuffer(buf) {
  requireAge();
  if (!haveIdentity()) throw new Error('key.txt missing — run scripts/setup.sh first.');
  const r = spawnSync('age', ['-d', '-i', IDENTITY_FILE], { input: buf, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`age decrypt (stream) failed: ${r.stderr?.toString().trim() || r.status}`);
  return r.stdout;
}

module.exports = {
  haveAge, haveRecipient, haveIdentity,
  encryptFile, decryptFile, decryptBuffer,
  RECIPIENT_FILE, IDENTITY_FILE,
};
