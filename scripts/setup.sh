#!/usr/bin/env bash
# Prepare a working copy: unlock the key, decrypt the manifest, and populate
# media/ from wherever each item's bytes live (local .age or a remote source).
#
# Run this on a fresh clone, or any time you want to refresh media/ from the
# manifest. It asks for the passphrase only the first time (to unwrap the key).

set -euo pipefail
cd "$(dirname "$0")/.."

command -v age >/dev/null || { echo "age not installed — run: brew install age"; exit 1; }

# 1. Unlock the private key (prompts for the passphrase on this terminal).
if [ ! -f key.txt ]; then
  if [ ! -f key.age ]; then
    echo "No key found. On the machine that owns this repo, run ./scripts/init.sh first."
    exit 1
  fi
  echo "Unlocking the private key — enter your passphrase:"
  age -d -o key.txt key.age
  chmod 600 key.txt
fi

# 2. Decrypt the manifest.
if [ -f media.json.age ]; then
  age -d -i key.txt -o media.json media.json.age
  echo "decrypted media.json"
else
  echo "no media.json.age yet — nothing to decrypt (empty library)."
fi

# 3. Populate media/ (fetch remote / decrypt local, place under media/<album>/).
echo "resolving media…"
node server.js resolve

echo
echo "Ready. Start the app with:  node server.js"
