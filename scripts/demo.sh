#!/usr/bin/env bash
# Trial the gallery with the bundled sample library — no key, no setup, no
# encryption. Runs against examples/ and never touches your real media/ or
# media.json.

set -euo pipefail
cd "$(dirname "$0")/.."

export GV_MANIFEST=examples/media.json
export GV_MEDIA_DIR=examples/media

echo "Demo mode: sample library (examples/), no key required."
node server.js
