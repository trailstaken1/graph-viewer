'use strict';

// Gallery client. Reads /api/media (served fresh each request), renders albums
// or a pinterest-style masonry, filters by text, and opens a lightbox where
// videos loop.

const stage = document.getElementById('stage');
const emptyEl = document.getElementById('empty');
const searchEl = document.getElementById('search');
const tabsEl = document.getElementById('tabs');
const crumbEl = document.getElementById('crumb');
const crumbName = document.getElementById('crumb-name');

let ITEMS = [];                 // all items from the manifest
let view = 'albums';            // 'albums' | 'all' | { album: name }
let query = '';

const isVideo = (it) => it.type === 'video';
const albumLabel = (a) => a || 'Ungrouped';
// One album ordering used everywhere (and mirrored in the manifest): natural,
// case-insensitive, by the raw album name so it matches media.json's order.
const byAlbum = (x, y) => String(x || '').localeCompare(String(y || ''), undefined, { numeric: true, sensitivity: 'base' });

async function load() {
  let data;
  try { data = await (await fetch('/api/media')).json(); }
  catch { data = { items: [] }; }
  ITEMS = data.items || [];
  ALBUM_META = data.albums || {};
  // Surface the graph viewer only when a graph is defined.
  const hasGraph = data.graphs && Object.keys(data.graphs).length > 0;
  document.getElementById('graph-link').hidden = !hasGraph;
  render();
}
let ALBUM_META = {};

/* ---------------------------------------------------------------- grouping */

function albumsInOrder() {
  const names = [];
  for (const it of ITEMS) { const a = it.album || ''; if (!names.includes(a)) names.push(a); }
  return names.sort(byAlbum);
}

function coverFor(album) {
  const inAlbum = ITEMS.filter((it) => (it.album || '') === album);
  const metaCover = ALBUM_META[album] && ALBUM_META[album].cover;
  return inAlbum.find((it) => it.id === metaCover) || inAlbum.find((it) => it.cover) || inAlbum[0] || null;
}

// Items to show as a flat list for the current view + query, ordered by album
// then filename.
function visibleItems() {
  let list = ITEMS;
  if (typeof view === 'object') list = list.filter((it) => (it.album || '') === view.album);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((it) =>
      (it.album || '').toLowerCase().includes(q) ||
      (it.name || '').toLowerCase().includes(q) ||
      (it.title || '').toLowerCase().includes(q));
  }
  // Preserve manifest order (which is already album-sorted, internal order kept).
  return list;
}

/* --------------------------------------------------------------- rendering */

function render() {
  // A search always drops into the flat masonry across everything.
  const showAlbums = view === 'albums' && !query;
  tabsEl.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', (b.dataset.view === 'albums' && (view === 'albums')) ||
                            (b.dataset.view === 'all' && view === 'all')));
  crumbEl.hidden = typeof view !== 'object';
  if (typeof view === 'object') crumbName.textContent = albumLabel(view.album);

  stage.innerHTML = '';
  if (!ITEMS.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  if (showAlbums) renderAlbums();
  else if (typeof view === 'object' && !query) renderMasonry(visibleItems()); // drilled into one album
  else renderCompact(visibleItems());                                          // "All" / search
}

// One compact pinterest masonry across everything, albums A→Z with internal
// order preserved. The first tile of each album carries the album title as a
// banner — compact, but still delineated. Tiles index into one flat list so the
// lightbox arrows step across every visible image.
function renderCompact(items) {
  const groups = new Map();
  for (const it of items) {
    const a = it.album || '';
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(it);
  }
  const albums = [...groups.keys()].sort(byAlbum);
  const flat = [];
  const heads = new Set();                 // items that open a new album
  for (const a of albums) {
    const arr = groups.get(a);
    if (arr.length) heads.add(arr[0]);
    flat.push(...arr);
  }

  const wrap = document.createElement('div');
  wrap.className = 'masonry';
  flat.forEach((it, i) => {
    const t = tile(it, i, flat);
    if (heads.has(it)) {
      const tag = document.createElement('div');
      tag.className = 'album-tag';
      tag.textContent = albumLabel(it.album);
      tag.addEventListener('click', (e) => { e.stopPropagation(); view = { album: it.album || '' }; render(); });
      t.appendChild(tag);
    }
    wrap.appendChild(t);
  });
  stage.appendChild(wrap);
}

function renderAlbums() {
  const grid = document.createElement('div');
  grid.className = 'albums';
  for (const album of albumsInOrder()) {
    const count = ITEMS.filter((it) => (it.album || '') === album).length;
    const cover = coverFor(album);
    const card = document.createElement('div');
    card.className = 'album-card';
    const cov = document.createElement('div');
    cov.className = 'album-cover' + (cover ? '' : ' empty');
    if (cover) cov.style.backgroundImage = `url("${cover.url}")`;
    else cov.textContent = '▤';
    const meta = document.createElement('div');
    meta.className = 'album-meta';
    meta.innerHTML = `<div class="album-name"></div><div class="album-count"></div>`;
    meta.querySelector('.album-name').textContent = albumLabel(album);
    meta.querySelector('.album-count').textContent = `${count} item${count === 1 ? '' : 's'}`;
    card.append(cov, meta);
    card.addEventListener('click', () => { view = { album }; render(); });
    grid.appendChild(card);
  }
  stage.appendChild(grid);
}

function renderMasonry(list) {
  const wrap = document.createElement('div');
  wrap.className = 'masonry';
  list.forEach((it, i) => wrap.appendChild(tile(it, i, list)));
  stage.appendChild(wrap);
}

function tile(it, index, list) {
  const el = document.createElement('div');
  el.className = 'tile';

  if (isVideo(it)) {
    const v = document.createElement('video');
    v.src = it.url; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
    el.appendChild(v);
    el.addEventListener('mouseenter', () => v.play().catch(() => {}));
    el.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
    const badge = document.createElement('div'); badge.className = 'badge'; badge.textContent = '▶'; el.appendChild(badge);
  } else {
    const img = document.createElement('img');
    img.src = it.url; img.loading = 'lazy'; img.alt = it.title || it.name;
    el.appendChild(img);
  }

  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<div class="cap-title">${escapeHtml(it.title || it.name)}</div>` +
    (it.album ? `<div class="album">${escapeHtml(it.album)}</div>` : '') +
    (it.prompt ? `<div class="prompt">${escapeHtml(it.prompt)}</div>` : '');
  el.appendChild(cap);

  el.addEventListener('click', () => openLightbox(list, index));
  return el;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* --------------------------------------------------------------- lightbox */

const lb = document.getElementById('lightbox');
const lbMedia = document.getElementById('lb-media');
const lbCaption = document.getElementById('lb-caption');
let lbList = [], lbIndex = 0;
let zoom = { scale: 1, x: 0, y: 0 };   // image pan/zoom (screen px + scale)
let idleTimer = null;

function openLightbox(list, index) {
  lbList = list; lbIndex = index;
  lb.hidden = false;
  showLightbox();
  // Fill the browser viewport via the fixed overlay only — deliberately NOT the
  // Fullscreen API, so macOS doesn't shove it into a new Space / OS fullscreen.
  wake();
}
function closeLightbox() {
  if (lb.hidden) return;
  lb.hidden = true;
  lbMedia.innerHTML = '';
  clearTimeout(idleTimer);
  lb.classList.remove('idle');
}
function step(d) { lbIndex = (lbIndex + d + lbList.length) % lbList.length; showLightbox(); wake(); }

function resetZoom() { zoom = { scale: 1, x: 0, y: 0 }; }
function applyZoom() {
  const img = lbMedia.querySelector('img');
  if (img) img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  lb.classList.toggle('zoomed', zoom.scale > 1.01);
}

function showLightbox() {
  const it = lbList[lbIndex];
  lbMedia.innerHTML = '';
  resetZoom();
  if (isVideo(it)) {
    const v = document.createElement('video');
    v.src = it.url; v.controls = true; v.loop = true; v.autoplay = true; v.muted = true; v.playsInline = true;
    lbMedia.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = it.url; img.alt = it.title || it.name; img.draggable = false;
    lbMedia.appendChild(img);
  }
  lbCaption.innerHTML =
    `<div class="lb-title">${escapeHtml(it.title || it.name)}` +
    (it.album ? ` · <span class="album">${escapeHtml(it.album)}</span>` : '') +
    (it.date ? ` · ${it.date}` : '') +
    ` · ${lbIndex + 1}/${lbList.length}</div>` +
    (it.prompt ? `<div class="lb-prompt">${escapeHtml(it.prompt)}</div>` : '');
}

// Reveal controls + cursor on movement, hide them after a beat of stillness.
function wake() {
  lb.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!lb.hidden) lb.classList.add('idle'); }, 1100);
}

/* ---- image zoom + pan (pinch, wheel, double-click) ---- */

function zoomAt(clientX, clientY, factor) {
  const img = lbMedia.querySelector('img');
  if (!img) return;
  const r = img.getBoundingClientRect();
  const cx = clientX - (r.left + r.width / 2);   // cursor relative to image centre
  const cy = clientY - (r.top + r.height / 2);
  const os = zoom.scale;
  const ns = Math.min(8, Math.max(1, os * factor));
  if (ns === os) return;
  zoom.x = cx - ((cx - zoom.x) * ns) / os;       // keep the point under the cursor fixed
  zoom.y = cy - ((cy - zoom.y) * ns) / os;
  zoom.scale = ns;
  if (ns === 1) { zoom.x = 0; zoom.y = 0; }
  applyZoom();
}

lbMedia.addEventListener('wheel', (e) => {
  if (!lbMedia.querySelector('img')) return;
  e.preventDefault();
  // trackpad pinch arrives as ctrlKey+wheel (Chrome); plain wheel zooms too
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
  wake();
}, { passive: false });

// Safari pinch
let gScale = 1;
lbMedia.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = 1; });
lbMedia.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.scale / gScale); gScale = e.scale; });

// drag to pan when zoomed in
let pan = null;
lbMedia.addEventListener('pointerdown', (e) => {
  if (zoom.scale <= 1.01) return;
  pan = { x: e.clientX, y: e.clientY };
  try { lbMedia.setPointerCapture(e.pointerId); } catch {}
});
lbMedia.addEventListener('pointermove', (e) => {
  wake();
  if (!pan) return;
  zoom.x += e.clientX - pan.x; zoom.y += e.clientY - pan.y;
  pan.x = e.clientX; pan.y = e.clientY;
  applyZoom();
});
lbMedia.addEventListener('pointerup', () => { pan = null; });

lbMedia.addEventListener('dblclick', (e) => {
  if (!lbMedia.querySelector('img')) return;
  if (zoom.scale > 1.01) { resetZoom(); applyZoom(); }
  else zoomAt(e.clientX, e.clientY, 2.5);
});

/* ---- lightbox controls ---- */

document.getElementById('lb-close').addEventListener('click', closeLightbox);
document.getElementById('lb-prev').addEventListener('click', () => step(-1));
document.getElementById('lb-next').addEventListener('click', () => step(1));
lb.addEventListener('mousemove', wake);
// click the empty backdrop (not the media) to close — but not while zoomed, so
// releasing a pan over the letterbox area doesn't close it
lb.addEventListener('click', (e) => {
  if (zoom.scale > 1.01) return;
  if (e.target === lb || e.target === lbMedia) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (lb.hidden) return;
  switch (e.key) {
    case 'Escape': closeLightbox(); break;
    case 'ArrowLeft': step(-1); break;
    case 'ArrowRight': step(1); break;
    case 'Home': lbIndex = 0; showLightbox(); wake(); break;
    case 'End': lbIndex = lbList.length - 1; showLightbox(); wake(); break;
    case '+': case '=': zoomAt(innerWidth / 2, innerHeight / 2, 1.3); wake(); break;
    case '-': case '_': zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.3); wake(); break;
    case '0': resetZoom(); applyZoom(); wake(); break;
    default: return;
  }
  e.preventDefault();
});

/* ---------------------------------------------------------------- controls */

tabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view = b.dataset.view; render();
});
document.getElementById('back').addEventListener('click', () => { view = 'albums'; render(); });
searchEl.addEventListener('input', () => { query = searchEl.value.trim(); render(); });

load();
