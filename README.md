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

## Try it (no setup)

```sh
./scripts/demo.sh          # http://127.0.0.1:8080 — bundled sample library
```

Runs against `examples/` (generated sample media, no encryption). Doesn't touch
your real `media/` or `media.json`.

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
| `node server.js` | serve gallery (`/`) + graph viewer (`/graph.html`) |
| `node server.js resolve` | populate `media/` from the manifest |
| `node server.js pack [--all]` | scrub + encrypt new media, datestamp, re-encrypt manifest |
| `node server.js splice <video> [--interval 5] [--span 60] [--loop a-b] [--album N] [--graph N]` | slice a video into frames + clips, register them as items, and build a graph |
| `node server.js import <library.js\|json> [--check] [--drop-dead] [--out media.json]` | build a manifest from a `library` array of `{n, c, x, s, f}` collections |

## Importing a library

`import` turns the old download-script `library` structure into a manifest: each
collection is an album, its cover `c` and files `f` become items whose `src`
holds the URL(s), and an `s` field (string or array) is carried across as
`additionalLinks` (always an array). It preserves the original URL handling
(`https://` prepend, `/`-relative resolution) and de-duplicates the cover against
the file list. `--check` HEAD-probes every URL and reports the dead ones (falling
back to a ranged GET when a server rejects HEAD); `--drop-dead` removes them,
otherwise they're flagged `"dead": true`. The probe is **per-host polite**: at
most `--per-host` (default 4) requests in flight to any one domain, `--concurrency`
(default 16) overall, with an optional `--delay` ms between requests to the same
host — so a single CDN is never hammered. Then `node server.js resolve` downloads
every live `src` into `media/`, and `./scripts/pack.sh` scrubs + encrypts.

## Video graph

`splice` cuts a video on a grid: a frame at each cut becomes a node, each segment
a clip on the edge between two nodes. `--loop a-b` makes the b-frame the a-frame
(a self-loop). The graph viewer (`/graph.html`, linked from the gallery when a
graph exists) plays it back — autoplay picks the shortest loop home, click a node
or edge to route there, double-click to jump, ⌘-click to queue, and an edge with
no clip is a jump cut. After splicing, run `./scripts/pack.sh`.

`--all` also pulls down items that live only remotely and stores a local
encrypted copy.

## Not yet ported

`server.legacy.js` still holds the video **splicer** (`build`) and the original
**graph viewer** client; both are being moved onto the new manifest model.
