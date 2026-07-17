#!/usr/bin/env bash
# Package new/changed media for committing: encrypt anything in media/ that
# isn't in media-age/ yet, datestamp new items, and re-encrypt the manifest.
#
#   ./scripts/pack.sh          only what's present locally in media/
#   ./scripts/pack.sh --all    also pull down remote-only items and store them here
#
# Encryption uses the public key, so this never asks for the passphrase.

set -euo pipefail
cd "$(dirname "$0")/.."

command -v age >/dev/null || { echo "age not installed — run: brew install age"; exit 1; }
[ -f .age-recipient ] || { echo ".age-recipient missing — run ./scripts/init.sh first."; exit 1; }

node server.js pack "$@"

echo
echo "Review, then commit the encrypted artifacts:"
echo "  git add media.json.age media-age .age-recipient key.age && git commit"
