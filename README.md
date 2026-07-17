# graph-viewer

A gallery + video-graph viewer over a media library that is **encrypted at rest
in git**. Raw images/videos are never committed in the clear — only:

- `media.json.age` — the encrypted manifest (albums, items, dates, graph defs)
- `media-age/<uuid>.age` — each media file, encrypted, flat, random-named
- `key.age` — the private key, wrapped under **your passphrase**
- `.age-recipient` — the public key (not secret)

Anyone who clones the repo and knows the passphrase can reconstruct everything;
anyone without it sees only ciphertext. Media can also live in another repo or
any public URL — `src[]` on each item lists where its bytes can be fetched.

## One-time setup (owner)

```sh
brew install age exiftool
./scripts/init.sh          # generates the keypair, wraps the private key under your passphrase
```

Back up that passphrase. Without it, every `.age` in the repo is unrecoverable.

## Everyday use

```sh
./scripts/setup.sh         # fresh clone: unlock key, decrypt manifest, populate media/
node server.js             # http://127.0.0.1:8080

# add media: drop files in media/<album>/, add matching items to media.json, then
./scripts/pack.sh          # scrubs PII, encrypts new files, datestamps, re-encrypts manifest
git add media.json.age media-age .age-recipient key.age && git commit
```

The server reads `media.json` fresh on every request, so editing it and adding
files under `media/` shows up on refresh — no restart.

## Privacy

`pack` strips location + PII (GPS, device make/model/serial, owner, host) from
every file **before** it is encrypted — losslessly, and only when the file
actually carries such metadata (clean files are left byte-for-byte untouched).

## media.json shape

```jsonc
{
  "version": 1,
  "items": [
    { "id": "<uuid>", "name": "beach.jpg", "title": "Sunset", "album": "Holiday",
      "date": "2026-07-17", "cover": true,
      "src": ["media-age/<uuid>.age", "https://…/<uuid>.age", "https://…/orig.jpg"] }
  ],
  "albums": { "Holiday": { "title": "Holiday 2026", "cover": "<uuid>" } },
  "graphs": { "main": { "nodes": [...], "edges": [...] } }
}
```

## Commands

| command | what |
|---|---|
| `node server.js` | serve gallery + graph |
| `node server.js resolve` | populate `media/` from the manifest |
| `node server.js pack [--all]` | scrub + encrypt new media, datestamp, re-encrypt manifest |

`--all` also pulls down items that live only remotely and stores a local
encrypted copy.

## Not yet ported

`server.legacy.js` still holds the video **splicer** (`build`) and the original
**graph viewer** client; both are being moved onto the new manifest model.
