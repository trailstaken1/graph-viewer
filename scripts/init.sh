#!/usr/bin/env bash
# One-time key setup. Run this once per repo, on your machine.
#
# Creates an age keypair. The PUBLIC key (.age-recipient) is committed and used
# to encrypt everything — no passphrase needed to pack media. The PRIVATE key is
# committed only in passphrase-wrapped form (key.age); its plaintext (key.txt)
# stays gitignored on this machine. Clone + passphrase = full access.
#
# You choose the passphrase here and it never leaves your terminal. Back it up
# somewhere safe: without it, every committed .age is unrecoverable.

set -euo pipefail
cd "$(dirname "$0")/.."

command -v age >/dev/null || { echo "age not installed — run: brew install age"; exit 1; }

if [ -f key.age ] || [ -f .age-recipient ]; then
  echo "Key already exists (key.age / .age-recipient present)."
  echo "Delete them first if you really mean to start over — this orphans every existing .age file."
  exit 1
fi

echo "Generating age keypair…"
age-keygen -o key.txt 2>/dev/null
chmod 600 key.txt
age-keygen -y key.txt > .age-recipient
echo "  public recipient: $(cat .age-recipient)"

echo
echo "Now choose a passphrase to protect the private key (you'll type it twice)."
echo "This is the master secret for the whole repo — make it strong, and back it up."
age -p -o key.age key.txt

echo
echo "Done. Created:"
echo "  key.txt         (gitignored — the live private key on this machine)"
echo "  key.age         (COMMIT — passphrase-wrapped private key)"
echo "  .age-recipient  (COMMIT — public key, not secret)"
echo
echo "Next: add media to media.json + media/, then ./scripts/pack.sh, then commit."
