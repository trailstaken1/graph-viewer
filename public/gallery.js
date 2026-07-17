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

async function load() {
  let data;
  try { data = await (await fetch('/api/media')).json(); }
  catch { data = { items: [] }; }
  ITEMS = data.items || [];
  ALBUM_META = data.albums || {};
  render();
}
let ALBUM_META = {};

/* ---------------------------------------------------------------- grouping */

function albumsInOrder() {
  const names = [];
  for (const it of ITEMS) { const a = it.album || ''; if (!names.includes(a)) names.push(a); }
  return names.sort((x, y) => albumLabel(x).localeCompare(albumLabel(y)));
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
  return [...list].sort((a, b) =>
    albumLabel(a.album).localeCompare(albumLabel(b.album)) || (a.name || '').localeCompare(b.name || ''));
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
  else renderMasonry(visibleItems());
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
  cap.innerHTML = `<div>${escapeHtml(it.title || it.name)}</div>` +
    (it.album ? `<div class="album">${escapeHtml(it.album)}</div>` : '');
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

function openLightbox(list, index) { lbList = list; lbIndex = index; showLightbox(); lb.hidden = false; }
function closeLightbox() { lb.hidden = true; lbMedia.innerHTML = ''; }
function step(d) { lbIndex = (lbIndex + d + lbList.length) % lbList.length; showLightbox(); }

function showLightbox() {
  const it = lbList[lbIndex];
  lbMedia.innerHTML = '';
  if (isVideo(it)) {
    const v = document.createElement('video');
    v.src = it.url; v.controls = true; v.loop = true; v.autoplay = true; v.muted = true; v.playsInline = true;
    lbMedia.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = it.url; img.alt = it.title || it.name;
    lbMedia.appendChild(img);
  }
  lbCaption.innerHTML = `${escapeHtml(it.title || it.name)}` +
    (it.album ? ` · <span class="album">${escapeHtml(it.album)}</span>` : '') +
    (it.date ? ` · ${it.date}` : '');
}

document.getElementById('lb-close').addEventListener('click', closeLightbox);
document.getElementById('lb-prev').addEventListener('click', () => step(-1));
document.getElementById('lb-next').addEventListener('click', () => step(1));
lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (lb.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

/* ---------------------------------------------------------------- controls */

tabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view = b.dataset.view; render();
});
document.getElementById('back').addEventListener('click', () => { view = 'albums'; render(); });
searchEl.addEventListener('input', () => { query = searchEl.value.trim(); render(); });

load();
