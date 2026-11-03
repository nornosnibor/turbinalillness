// Sift – main app. Rendering, state, and user actions.

import { db } from './db.js';
import * as im from './imageutils.js';
import * as jev from './jev.js';
import { makeZip } from './zip.js';
import { icon, hydrateIcons } from './icons.js';

// ---------------------------------------------------------------- state

const DEFAULT_SETTINGS = {
  model: 'jev-latest',
  threshold: 0.7,
  analysisSize: 768,
  concurrency: 3,
  autoAnalyze: false,
  theme: 'system',
  tile: 190,
  sort: 'taken-desc',
};

const S = {
  photos: [],
  byId: new Map(),
  albums: [],
  customTags: [],
  searches: [],
  settings: { ...DEFAULT_SETTINGS },
  apiKey: '',
  usage: { requests: 0, input: 0, output: 0 },
  server: { reachable: false, demo: false, serverKey: false },
  view: 'all',
  query: '',
  filters: emptyFilters(),
  selected: new Set(),
  anchor: null,
  visible: [],
  working: new Set(),
  showWeak: false,
  lightboxId: null,
  panelOpen: true,
};

function emptyFilters() {
  return { scenes: new Set(), quality: null, orientation: null, setting: null, people: null, location: false, year: null };
}

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID().slice(0, 13);
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
const pct = (v) => `${Math.round(v * 100)}%`;
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtDate = (ms, opts = { dateStyle: 'medium' }) => (ms ? new Intl.DateTimeFormat(undefined, opts).format(ms) : '—');

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ } }

// ---------------------------------------------------------------- derived data

const ans = (p, k) => p.ai?.answers?.[k];
const sceneOf = (p) => ans(p, 'scene')?.choice;
const qualityOf = (p) => ans(p, 'quality')?.score ?? null;
const qualityLevel = (p) => { const q = qualityOf(p); return q == null ? null : Math.max(0, Math.min(3, Math.round(q))); };
const dateOf = (p) => p.taken || p.modified || p.added;
const orientationOf = (p) => { const r = p.width / p.height; return r > 1.08 ? 'landscape' : r < 0.92 ? 'portrait' : 'square'; };
const tagProb = (p, id) => ans(p, `tag_${id}`)?.noul ?? 0;

function autoTags(p) {
  const out = [];
  if (!p.ai) return out;
  const t = S.settings.threshold;
  for (const tag of jev.AUTO_TAGS) {
    const v = tagProb(p, tag.id);
    if (v >= t) out.push({ label: tag.label, prob: v });
  }
  for (const ct of S.customTags) {
    const v = p.custom?.[ct.id];
    if (v != null && v >= t) out.push({ label: ct.name, prob: v, custom: true });
  }
  return out;
}

function allTagLabels(p) {
  const set = new Set((p.tags || []).map((t) => t.toLowerCase()));
  for (const t of autoTags(p)) set.add(t.label.toLowerCase());
  return set;
}

function needsReview(p) {
  if (!p.ai) return false;
  const c = ans(p, 'scene')?.confidence;
  return c != null && c < 0.45;
}

function colorNames(p) {
  return (p.colors || []).slice(0, 3).filter((c) => c.share >= 0.1).map((c) => c.name);
}

function haystack(p) {
  const d = new Date(dateOf(p));
  const parts = [
    p.name, ...(p.tags || []), ...autoTags(p).map((t) => t.label),
    jev.SCENES[sceneOf(p)]?.label, ans(p, 'setting')?.choice, ans(p, 'light')?.choice,
    ans(p, 'people_count')?.choice, p.exif?.make, p.exif?.model, p.exif?.lens,
    ...colorNames(p), d.toLocaleString(undefined, { month: 'long' }), String(d.getFullYear()),
    orientationOf(p), p.fav ? 'favorite' : '', p.gps ? 'location' : '',
    qualityLevel(p) != null ? jev.QUALITY_NAMES[qualityLevel(p)] : '',
    ...(p.albums || []).map((id) => S.albums.find((a) => a.id === id)?.name),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

// Duplicate groups via perceptual hash distance (union–find).
function hashInts(hex) { return [parseInt(hex.slice(0, 8), 16) | 0, parseInt(hex.slice(8, 16), 16) | 0]; }
function pop32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
let dupCache = { key: '', groups: [] };
function duplicateGroups() {
  const list = S.photos.filter((p) => p.hash);
  const key = String(list.length);
  if (dupCache.key === key) return dupCache.groups;
  const hs = list.map((p) => hashInts(p.hash));
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (pop32(hs[i][0] ^ hs[j][0]) + pop32(hs[i][1] ^ hs[j][1]) <= 5) parent[find(i)] = find(j);
    }
  }
  const map = new Map();
  list.forEach((p, i) => { const r = find(i); if (!map.has(r)) map.set(r, []); map.get(r).push(p); });
  const groups = [...map.values()].filter((g) => g.length > 1).map((g) => {
    const best = [...g].sort((a, b) => (qualityOf(b) ?? 1.5) - (qualityOf(a) ?? 1.5) || b.width * b.height - a.width * a.height || b.size - a.size)[0];
    return { photos: g, best: best.id };
  }).sort((a, b) => dateOf(b.photos[0]) - dateOf(a.photos[0]));
  dupCache = { key, groups };
  return groups;
}
function invalidateDupes() { dupCache.key = ''; }

const CLEANUP = {
  blurry: { title: 'Blurry or unusable', desc: 'Out of focus, very dark, or accidental shots.', icon: 'blur', tone: 'warn', test: (p) => (qualityOf(p) != null && qualityOf(p) < 0.8) || tagProb(p, 'blurry') >= S.settings.threshold },
  eyes: { title: 'Eyes closed', desc: 'Someone blinked. Keep the best take.', icon: 'eye', tone: 'warn', test: (p) => tagProb(p, 'eyes_closed') >= S.settings.threshold && tagProb(p, 'person') >= 0.5 },
  screenshots: { title: 'Screenshots', desc: 'Screen captures that pile up in camera rolls.', icon: 'monitor', tone: '', test: (p) => tagProb(p, 'screenshot') >= S.settings.threshold },
  documents: { title: 'Receipts & documents', desc: 'Receipts, tickets and paperwork — file or delete them.', icon: 'receipt', tone: '', test: (p) => tagProb(p, 'receipt') >= S.settings.threshold },
  sensitive: { title: 'Sensitive info', desc: 'Cards, IDs, passwords or bank details. Think before sharing.', icon: 'shield', tone: 'bad', test: (p) => tagProb(p, 'sensitive') >= S.settings.threshold },
};

// ---------------------------------------------------------------- view lists

function baseList(view = S.view) {
  const all = S.photos;
  const [kind, arg] = view.split(':');
  switch (kind) {
    case 'all': return all;
    case 'favorites': return all.filter((p) => p.fav);
    case 'recent': { const cut = Date.now() - 30 * 864e5; return all.filter((p) => p.added >= cut); }
    case 'unanalyzed': return all.filter((p) => !p.ai);
    case 'review': return all.filter(needsReview);
    case 'scene': return all.filter((p) => sceneOf(p) === arg);
    case 'album': return all.filter((p) => p.albums?.includes(arg));
    case 'tag': return all.filter((p) => allTagLabels(p).has(arg));
    case 'color': return all.filter((p) => colorNames(p).includes(arg));
    case 'clean': return all.filter(CLEANUP[arg]?.test || (() => false));
    case 'search': {
      const s = S.searches.find((x) => x.id === arg);
      if (!s) return [];
      const min = S.showWeak ? 0.25 : 0.5;
      return all.filter((p) => (s.results[p.id] ?? 0) >= min);
    }
    default: return all;
  }
}

function applyFilters(list) {
  const f = S.filters;
  const q = S.query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/) : [];
  return list.filter((p) => {
    if (f.scenes.size && !f.scenes.has(sceneOf(p))) return false;
    if (f.quality != null && !(qualityLevel(p) >= f.quality)) return false;
    if (f.orientation && orientationOf(p) !== f.orientation) return false;
    if (f.setting && ans(p, 'setting')?.choice !== f.setting) return false;
    if (f.people && ans(p, 'people_count')?.choice !== f.people) return false;
    if (f.location && !p.gps) return false;
    if (f.year && new Date(dateOf(p)).getFullYear() !== f.year) return false;
    if (tokens.length) {
      const h = haystack(p);
      if (!tokens.every((t) => h.includes(t))) return false;
    }
    return true;
  });
}

function hueOf(p) {
  const c = p.colors?.[0]?.hex;
  if (!c) return 999;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return 400 + (1 - max) * 100; // grays at the end, light to dark
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function sortList(list) {
  const out = [...list];
  const by = S.view.startsWith('search:') ? 'match' : S.view === 'recent' ? 'added-desc' : S.settings.sort;
  const s = S.searches.find((x) => `search:${x.id}` === S.view);
  const cmp = {
    'taken-desc': (a, b) => dateOf(b) - dateOf(a),
    'taken-asc': (a, b) => dateOf(a) - dateOf(b),
    'added-desc': (a, b) => b.added - a.added,
    'quality-desc': (a, b) => (qualityOf(b) ?? -1) - (qualityOf(a) ?? -1),
    'name-asc': (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    'size-desc': (a, b) => b.size - a.size,
    color: (a, b) => hueOf(a) - hueOf(b),
    match: (a, b) => (s?.results[b.id] ?? 0) - (s?.results[a.id] ?? 0),
  }[by];
  return out.sort(cmp);
}

// ---------------------------------------------------------------- thumbnails

const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const blob = await db.get('thumbs', id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  thumbUrls.set(id, url);
  return url;
}
function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(id);
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const imgEl = e.target;
    io.unobserve(imgEl);
    thumbUrl(imgEl.dataset.id).then((url) => {
      if (!url) return;
      imgEl.src = url;
      imgEl.onload = () => imgEl.classList.add('loaded');
    });
  }
}, { rootMargin: '600px 0px' });

function observeThumbs(root) {
  for (const imgEl of root.querySelectorAll('img[data-id]')) {
    const cached = thumbUrls.get(imgEl.dataset.id);
    if (cached) { imgEl.src = cached; imgEl.classList.add('loaded'); } else io.observe(imgEl);
  }
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function refresh() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

function renderAll() {
  renderNav();
  renderTopbar();
  renderChips();
  renderView();
  renderSelectionBar();
  // Don't wipe what you're typing in the photo panel.
  if (S.lightboxId && !document.activeElement?.matches('#lb-panel input')) renderLightboxPanel();
}

function navItem(view, label, iconHtml, n, extra = '') {
  const active = S.view === view ? ' active' : '';
  return `<button class="nav-item${active}" data-view="${esc(view)}" ${extra}>${iconHtml}<span class="label">${esc(label)}</span>${n != null ? `<span class="n">${n.toLocaleString()}</span>` : ''}</button>`;
}

function renderNav() {
  const ps = S.photos;
  const unanalyzed = ps.filter((p) => !p.ai).length;
  const review = ps.filter(needsReview).length;
  let h = '';
  h += navItem('all', 'All photos', icon('grid'), ps.length);
  h += navItem('favorites', 'Favorites', icon('heart'), ps.filter((p) => p.fav).length);
  h += navItem('recent', 'Recently added', icon('clock'));
  if (unanalyzed) h += navItem('unanalyzed', 'Not analyzed', icon('inbox'), unanalyzed);
  if (review) h += navItem('review', 'Needs review', icon('alert'), review);

  h += `<div class="nav-section">Tools</div>`;
  h += navItem('cleanup', 'Cleanup', icon('wand'));
  const dups = duplicateGroups().length;
  h += navItem('duplicates', 'Duplicates', icon('copy'), dups || null);
  h += navItem('smarttags', 'Smart tags', icon('scan'), S.customTags.length || null);

  const scenes = Object.entries(jev.SCENES).map(([k, v]) => [k, v, ps.filter((p) => sceneOf(p) === k).length]).filter((x) => x[2]);
  if (scenes.length) {
    h += `<div class="nav-section">Smart albums</div>`;
    for (const [k, v, n] of scenes) h += navItem(`scene:${k}`, v.label, `<span class="emoji">${v.icon}</span>`, n);
  }

  h += `<div class="nav-section">Albums <button data-action="new-album" title="New album">${icon('plus')}</button></div>`;
  if (!S.albums.length) h += `<div class="faint small-text" style="padding:2px 10px 4px">No albums yet</div>`;
  for (const a of S.albums) h += navItem(`album:${a.id}`, a.name, icon('folder'), ps.filter((p) => p.albums?.includes(a.id)).length);

  const counts = new Map();
  for (const p of ps) for (const t of allTagLabels(p)) counts.set(t, (counts.get(t) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14);
  if (top.length) {
    h += `<div class="nav-section">Tags</div>`;
    for (const [t, n] of top) h += navItem(`tag:${t}`, t, icon('tag'), n);
  }

  if (S.searches.length) {
    h += `<div class="nav-section">Jev searches</div>`;
    for (const s of S.searches.slice(0, 6)) {
      const n = Object.values(s.results).filter((v) => v >= 0.5).length;
      h += navItem(`search:${s.id}`, s.query, icon('sparkles'), n);
    }
  }

  const colorCounts = Object.fromEntries(im.COLOR_NAMES.map((c) => [c, 0]));
  for (const p of ps) for (const c of colorNames(p)) colorCounts[c]++;
  const shown = im.COLOR_NAMES.filter((c) => colorCounts[c]);
  if (shown.length) {
    h += `<div class="nav-section">Colors</div><div class="color-row">`;
    for (const c of shown) h += `<button data-view="color:${c}" class="${S.view === `color:${c}` ? 'active' : ''}" title="${c} (${colorCounts[c]})" style="background:${SWATCH[c]}"></button>`;
    h += `</div>`;
  }
  $('#nav').innerHTML = h;
}

const SWATCH = { red: '#e5484d', orange: '#f76b15', yellow: '#ffd60a', green: '#30a46c', teal: '#12a594', blue: '#3e63dd', purple: '#8e4ec6', pink: '#d6409f', brown: '#a07553', black: '#1c1c1f', gray: '#8b8d98', white: '#f4f4f5' };

function viewTitle() {
  const [kind, arg] = S.view.split(':');
  switch (kind) {
    case 'all': return ['All photos', ''];
    case 'favorites': return ['Favorites', 'Photos you loved.'];
    case 'recent': return ['Recently added', 'Imported in the last 30 days.'];
    case 'unanalyzed': return ['Not analyzed', 'Run Jev on these to unlock tags, scenes and quality.'];
    case 'review': return ['Needs review', 'Jev wasn\'t confident about what these show. Worth a quick look.'];
    case 'scene': return [`${jev.SCENES[arg]?.icon || ''} ${jev.SCENES[arg]?.label || arg}`, 'Sorted into this album automatically by Jev.'];
    case 'album': return [S.albums.find((a) => a.id === arg)?.name || 'Album', ''];
    case 'tag': return [`#${arg}`, ''];
    case 'color': return [`${arg[0].toUpperCase()}${arg.slice(1)} photos`, 'Based on each photo\'s dominant colors.'];
    case 'clean': return [CLEANUP[arg]?.title || 'Cleanup', CLEANUP[arg]?.desc || ''];
    case 'search': { const s = S.searches.find((x) => x.id === arg); return [`“${s?.query || ''}”`, s ? `Jev looked at ${plural(s.scope, 'photo')} on ${fmtDate(s.at, { dateStyle: 'medium', timeStyle: 'short' })}.` : '']; }
    default: return ['', ''];
  }
}

function renderView() {
  const view = $('#view');
  const scroll = view.scrollTop;
  S.visible = [];
  if (S.view === 'cleanup') view.innerHTML = renderCleanup();
  else if (S.view === 'duplicates') view.innerHTML = renderDuplicates();
  else if (S.view === 'smarttags') view.innerHTML = renderSmartTags();
  else view.innerHTML = renderGridView();
  view.classList.toggle('selecting', S.selected.size > 0);
  observeThumbs(view);
  view.scrollTop = scroll;
}

function banners() {
  let h = '';
  if (!S.server.reachable) {
    h += `<div class="banner">${icon('alert')}<span class="grow">Can't reach the Sift server. Start it with <code>python3 server.py</code> in the <code>sift</code> folder, then reload.</span></div>`;
  } else if (S.server.demo) {
    h += `<div class="banner">${icon('alert')}<span class="grow"><b>Demo mode:</b> Jev answers are made up so you can try the app. Restart the server without <code>--demo</code> to use the real model.</span></div>`;
  } else if (!S.server.serverKey && !S.apiKey && S.photos.length) {
    h += `<div class="banner info">${icon('key')}<span class="grow">Add your Jev API key to auto-tag, sort and search your photos.</span><button class="btn small" data-action="settings">Add key</button></div>`;
  }
  return h;
}

function renderGridView() {
  const [title, sub] = viewTitle();
  const base = baseList();
  const list = sortList(applyFilters(base));
  S.visible = list.map((p) => p.id);

  if (!S.photos.length) return banners() + emptyLibrary();

  const isSearch = S.view.startsWith('search:');
  const search = isSearch ? S.searches.find((x) => `search:${x.id}` === S.view) : null;
  const actions = [];
  if (list.length) actions.push(`<button class="btn small ghost" data-action="select-all">Select all</button>`);
  if (S.view.startsWith('album:')) actions.push(`<button class="btn small ghost" data-action="rename-album">Rename</button><button class="btn small ghost danger" data-action="delete-album">Delete album</button>`);
  if (isSearch) {
    actions.push(`<button class="btn small ghost" data-action="toggle-weak">${S.showWeak ? 'Hide weak matches' : 'Show weak matches'}</button>`);
    actions.push(`<button class="btn small ghost" data-action="search-to-album">Save as album</button>`);
    actions.push(`<button class="btn small ghost danger" data-action="delete-search">Remove search</button>`);
  }
  if (list.length) actions.push(`<button class="btn small" data-action="zip-view">${icon('download')}Download</button>`);

  let h = banners();
  h += `<div class="view-head"><div><h1 class="view-title">${esc(title)}</h1><div class="view-sub">${plural(list.length, 'photo')}${list.length !== base.length ? ` of ${base.length.toLocaleString()}` : ''}${sub ? ` · ${esc(sub)}` : ''}</div></div><div class="view-head-actions">${actions.join('')}</div></div>`;

  if (!list.length) {
    const msg = S.query || activeFilterCount() ? 'No photos match your search and filters.' : isSearch ? 'Jev didn\'t find strong matches. Try “Show weak matches”, or rephrase.' : 'Nothing here yet.';
    const askHint = S.query && !isSearch ? `<p>Tags didn't match — let Jev look at the pictures themselves.</p><div class="actions"><button class="btn jev" data-action="ask-jev">${icon('sparkles')}Ask Jev to find “${esc(S.query)}”</button></div>` : '';
    return h + `<div class="empty small"><div class="art">${icon('search')}</div><h2>${msg}</h2>${askHint}</div>`;
  }

  const grouped = !isSearch && ['taken-desc', 'taken-asc'].includes(S.settings.sort) && S.view !== 'recent';
  if (grouped) {
    let cur = null;
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      h += `<div class="group-head"><h3>${esc(cur)}</h3><span>${plural(buf.length, 'photo')}</span><button class="link-btn" data-action="select-group" data-ids="${buf.map((p) => p.id).join(',')}">Select</button></div><div class="grid">${buf.map((p) => tileHtml(p)).join('')}</div>`;
      buf = [];
    };
    for (const p of list) {
      const label = new Date(dateOf(p)).toLocaleString(undefined, { month: 'long', year: 'numeric' });
      if (label !== cur) { flush(); cur = label; }
      buf.push(p);
    }
    flush();
  } else {
    h += `<div class="grid" style="margin-top:10px">${list.map((p) => tileHtml(p, search)).join('')}</div>`;
  }
  return h;
}

function tileHtml(p, search) {
  const cls = ['tile'];
  if (S.selected.has(p.id)) cls.push('selected');
  if (p.fav) cls.push('is-fav');
  const q = qualityLevel(p);
  const scene = jev.SCENES[sceneOf(p)];
  const metaText = scene ? `${scene.icon} ${scene.label}` : esc(p.name);
  let extra = '';
  if (S.working.has(p.id)) extra += `<div class="working"><div class="spinner"></div></div>`;
  else if (p.aiError) extra += `<span class="err" title="${esc(p.aiError)}">${icon('alert')}</span>`;
  else if (!p.ai) extra += `<span class="pending" title="Not analyzed yet"></span>`;
  if (search) extra += `<span class="badge match">${pct(search.results[p.id] ?? 0)}</span>`;
  return `<div class="${cls.join(' ')}" data-id="${p.id}" title="${esc(p.name)}">
    <img data-id="${p.id}" alt="${esc(p.name)}" draggable="false" />
    <div class="shade"></div>
    <div class="check">${icon('check')}</div>
    <button class="fav" data-act="fav" aria-label="Favorite">${icon('heart')}</button>
    <div class="meta">${q != null ? `<span class="qdot q${q}" title="${jev.QUALITY_NAMES[q]} quality"></span>` : ''}<span class="grow">${metaText}</span></div>
    ${extra}
  </div>`;
}

function emptyLibrary() {
  return `<div class="empty">
    <div class="art">${icon('image')}</div>
    <h2>Bring your photos into Sift</h2>
    <p>Drop photos or whole folders anywhere on this window. Everything stays on your computer — only a small resized copy is sent to Jev when you analyze.</p>
    <div class="actions">
      <button class="btn primary" data-action="import">${icon('upload')}Choose photos</button>
      <button class="btn" data-action="import-folder">${icon('folder')}Import a folder</button>
    </div>
    <div class="features">
      <div class="feature">${icon('sparkles')}<h4>Auto-tagging</h4><p>Jev sorts each photo into scenes and adds tags like dog, beach, receipt or screenshot.</p></div>
      <div class="feature">${icon('search')}<h4>Search by description</h4><p>Type “kids at the beach at sunset” and Ask Jev to look at the pictures themselves.</p></div>
      <div class="feature">${icon('wand')}<h4>One-click cleanup</h4><p>Find duplicates, blurry shots, blinks, screenshots and photos with sensitive info.</p></div>
      <div class="feature">${icon('scan')}<h4>Teach it your things</h4><p>Create smart tags like “Max the dog” from one example photo, and Jev finds the rest.</p></div>
    </div>
  </div>`;
}

function stripHtml(photos) {
  const show = photos.slice(0, 5);
  return `<div class="strip">${show.map((p) => `<div class="tile" data-id="${p.id}"><img data-id="${p.id}" alt="" /></div>`).join('')}${'<div></div>'.repeat(5 - show.length)}</div>`;
}

function renderCleanup() {
  const analyzed = S.photos.filter((p) => p.ai).length;
  let h = banners();
  h += `<div class="view-head"><div><h1 class="view-title">Cleanup</h1><div class="view-sub">Free up space and tidy your library. Nothing is deleted without asking.</div></div></div>`;
  if (!S.photos.length) return h + emptyLibrary();
  if (analyzed < S.photos.length) {
    h += `<div class="banner info">${icon('sparkles')}<span class="grow">${plural(S.photos.length - analyzed, 'photo')} not analyzed yet — cleanup suggestions need Jev's tags (duplicates work without it).</span><button class="btn small jev" data-action="analyze-pending">Analyze now</button></div>`;
  }
  const groups = duplicateGroups();
  const extras = groups.reduce((n, g) => n + g.photos.length - 1, 0);
  const extraBytes = groups.reduce((n, g) => n + g.photos.filter((p) => p.id !== g.best).reduce((m, p) => m + p.size, 0), 0);
  h += `<div class="cards">`;
  h += `<div class="card"><div class="card-head"><div class="card-icon">${icon('copy')}</div><div><h4>Duplicates & near-duplicates</h4><p>${groups.length ? `${plural(groups.length, 'set')}, ${fmtBytes(extraBytes)} could be freed.` : 'No duplicates found.'}</p></div><div class="num">${extras}</div></div>${groups.length ? stripHtml(groups.flatMap((g) => g.photos)) : ''}<div class="card-actions"><button class="btn small" data-view="duplicates" ${groups.length ? '' : 'disabled'}>Review sets</button></div></div>`;
  for (const [key, c] of Object.entries(CLEANUP)) {
    const list = S.photos.filter(c.test);
    h += `<div class="card"><div class="card-head"><div class="card-icon ${c.tone}">${icon(c.icon)}</div><div><h4>${c.title}</h4><p>${c.desc}</p></div><div class="num">${list.length}</div></div>${list.length ? stripHtml(list) : ''}<div class="card-actions"><button class="btn small" data-view="clean:${key}" ${list.length ? '' : 'disabled'}>Review</button>${list.length ? `<button class="btn small ghost" data-action="select-clean" data-key="${key}">Select all</button>` : ''}</div></div>`;
  }
  h += `</div>`;
  return h;
}

function renderDuplicates() {
  const groups = duplicateGroups();
  let h = banners();
  h += `<div class="view-head"><div><h1 class="view-title">Duplicates</h1><div class="view-sub">${groups.length ? `${plural(groups.length, 'set')} of identical or near-identical photos. The best one in each set is marked Keep (by Jev quality, then resolution).` : 'No duplicates found.'}</div></div>${groups.length ? `<div class="view-head-actions"><button class="btn small" data-action="select-all-extras">Select all extras</button></div>` : ''}</div>`;
  S.visible = groups.flatMap((g) => g.photos.map((p) => p.id));
  for (const [i, g] of groups.entries()) {
    const size = g.photos.reduce((n, p) => n + p.size, 0);
    h += `<div class="dup-group"><div class="dup-head"><strong>Set ${i + 1}</strong><span>${plural(g.photos.length, 'photo')} · ${fmtBytes(size)}</span><span class="grow"></span><button class="btn small ghost" data-action="select-extras" data-group="${i}">Select extras</button></div><div class="grid">`;
    for (const p of g.photos) {
      h += tileHtml(p).replace('<div class="shade"></div>', `<div class="shade"></div>${p.id === g.best ? '<span class="keep-badge">Keep</span>' : ''}`);
    }
    h += `</div><div class="faint small-text" style="margin-top:8px">${g.photos.map((p) => `${esc(p.name)} (${p.width}×${p.height}, ${fmtBytes(p.size)})`).join(' · ')}</div></div>`;
  }
  return h;
}

function renderSmartTags() {
  let h = banners();
  h += `<div class="view-head"><div><h1 class="view-title">Smart tags</h1><div class="view-sub">Teach Jev things that matter to you — “Max the dog”, “our blue van”, “Grandma's house”. Add a description, an example photo, or both.</div></div><div class="view-head-actions"><button class="btn small primary" data-action="new-smart-tag">${icon('plus')}New smart tag</button></div></div>`;
  if (!S.customTags.length) {
    return h + `<div class="empty small"><div class="art">${icon('scan')}</div><h2>No smart tags yet</h2><p>Open any photo and choose “Find more like this”, or create one from a description.</p><div class="actions"><button class="btn primary" data-action="new-smart-tag">${icon('plus')}New smart tag</button></div></div>`;
  }
  h += `<table class="tag-table"><thead><tr><th style="width:56px"></th><th>Tag</th><th>Matches</th><th>Checked</th><th></th></tr></thead><tbody>`;
  for (const t of S.customTags) {
    const checked = S.photos.filter((p) => p.custom?.[t.id] != null).length;
    const matches = S.photos.filter((p) => (p.custom?.[t.id] ?? 0) >= S.settings.threshold).length;
    h += `<tr><td>${t.refPhotoId && S.byId.has(t.refPhotoId) ? `<img class="ref-thumb" data-id="${t.refPhotoId}" alt="" />` : `<div class="ref-thumb" style="display:flex;align-items:center;justify-content:center">${icon('tag')}</div>`}</td>
      <td><b>${esc(t.name)}</b>${t.description ? `<div class="faint small-text">${esc(t.description)}</div>` : ''}</td>
      <td><button class="tag" data-view="tag:${esc(t.name.toLowerCase())}">${matches}</button></td>
      <td><span class="pill">${checked} / ${S.photos.length}</span></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn small jev" data-action="apply-smart-tag" data-id="${t.id}" ${checked >= S.photos.length ? 'disabled' : ''}>${icon('sparkles')}Check ${S.photos.length - checked}</button> <button class="icon-btn" data-action="delete-smart-tag" data-id="${t.id}" title="Delete">${icon('trash')}</button></td></tr>`;
  }
  h += `</tbody></table><p class="faint small-text" style="margin-top:14px">New photos are checked for every smart tag automatically when they're analyzed.</p>`;
  return h;
}

function activeFilterCount() {
  const f = S.filters;
  return f.scenes.size + (f.quality != null) + !!f.orientation + !!f.setting + !!f.people + !!f.location + !!f.year;
}

function renderChips() {
  const f = S.filters;
  const chips = [];
  const chip = (label, key, val = '') => chips.push(`<span class="chip">${esc(label)}<button data-action="unfilter" data-key="${key}" data-val="${esc(val)}" aria-label="Remove filter">${icon('x')}</button></span>`);
  for (const s of f.scenes) chip(jev.SCENES[s]?.label || s, 'scenes', s);
  if (f.quality != null) chip(`${jev.QUALITY_NAMES[f.quality]}+ quality`, 'quality');
  if (f.orientation) chip(f.orientation, 'orientation');
  if (f.setting) chip(f.setting, 'setting');
  if (f.people) chip(`people: ${f.people}`, 'people');
  if (f.location) chip('has location', 'location');
  if (f.year) chip(String(f.year), 'year');
  if (S.query) chip(`“${S.query}”`, 'query');
  const bar = $('#chipbar');
  bar.hidden = !chips.length || ['cleanup', 'duplicates', 'smarttags'].includes(S.view);
  bar.innerHTML = chips.join('') + (chips.length > 1 ? `<button class="chip clear" data-action="clear-filters">Clear all</button>` : '');
  const n = activeFilterCount();
  $('#filter-count').hidden = !n;
  $('#filter-count').textContent = n;
}

function renderTopbar() {
  const pending = S.photos.filter((p) => !p.ai && !S.working.has(p.id)).length;
  const btn = $('#analyze-btn');
  btn.hidden = !pending || queue.active;
  $('#analyze-label').textContent = `Analyze ${pending.toLocaleString()}`;
  const prog = $('#progress');
  prog.hidden = !queue.active && !searchJob.active;
  if (queue.active) $('#progress-label').textContent = `Analyzing ${queue.done.toLocaleString()} / ${queue.total.toLocaleString()}`;
  else if (searchJob.active) $('#progress-label').textContent = `${searchJob.label} ${searchJob.done} / ${searchJob.total}`;
  $('#sort').value = S.settings.sort;
  const dot = $('#status-dot');
  dot.className = 'status-dot ' + (!S.server.reachable ? 'off' : S.server.demo ? 'demo' : S.server.serverKey || S.apiKey ? 'ok' : 'off');
}

function renderSelectionBar() {
  const n = S.selected.size;
  $('#selection-bar').hidden = !n;
  $('#sel-count').textContent = `${n.toLocaleString()} selected`;
}

async function renderStorage() {
  const est = await db.estimate();
  const total = S.photos.reduce((n, p) => n + p.size, 0);
  let h = `${plural(S.photos.length, 'photo')} · ${fmtBytes(total)}`;
  if (est?.quota) h += `<div class="bar"><i style="width:${Math.min(100, (est.usage / est.quota) * 100).toFixed(1)}%"></i></div>`;
  $('#storage-meter').innerHTML = h;
}

// ---------------------------------------------------------------- toasts & modals

function toast(msg, { type = 'info', sticky = false, action, onAction, timeout = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  el.innerHTML = `${icon(ic)}<span class="msg"></span>${action ? `<button class="link-btn">${esc(action)}</button>` : ''}`;
  el.querySelector('.msg').textContent = msg;
  if (action) el.querySelector('button').onclick = () => { onAction?.(); el.remove(); };
  $('#toasts').appendChild(el);
  const close = () => el.remove();
  if (!sticky) setTimeout(close, timeout);
  return { update: (m) => { el.querySelector('.msg').textContent = m; }, close };
}

let modalResolve = null;
function modal(html, { wide = false, onOpen } = {}) {
  const box = $('#modal-box');
  box.className = `modal${wide ? ' wide' : ''}`;
  box.innerHTML = html;
  $('#modal').hidden = false;
  onOpen?.(box);
  setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('input, button.primary'))?.focus(), 30);
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(value) {
  $('#modal').hidden = true;
  $('#modal-box').innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  r?.(value);
}

function confirmModal(title, body, { ok = 'Continue', danger = false, jevBtn = false } = {}) {
  return modal(`<div class="modal-head"><h3>${esc(title)}</h3></div><div class="modal-body"><p>${body}</p></div>
    <div class="modal-foot"><button class="btn ghost" data-modal="cancel">Cancel</button><button class="btn ${danger ? 'primary danger-solid' : jevBtn ? 'jev' : 'primary'}" data-modal="ok" autofocus>${esc(ok)}</button></div>`);
}

function promptModal(title, { label = '', value = '', placeholder = '', ok = 'Save', hint = '', suggestions = [] } = {}) {
  return modal(`<form data-modal-form><div class="modal-head"><h3>${esc(title)}</h3></div><div class="modal-body">
    <div class="field">${label ? `<label>${esc(label)}</label>` : ''}<input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus autocomplete="off" />${hint ? `<div class="hint">${hint}</div>` : ''}</div>
    ${suggestions.length ? `<div class="suggest">${suggestions.map((s) => `<button type="button" class="tag" data-fill="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    </div><div class="modal-foot"><button type="button" class="btn ghost" data-modal="cancel">Cancel</button><button class="btn primary">${esc(ok)}</button></div></form>`);
}

// ---------------------------------------------------------------- import

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif|tiff?)$/i;

async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

async function importFiles(files) {
  const known = new Set(S.photos.map((p) => p.fileKey));
  const images = files.filter((f) => (f.type.startsWith('image/') || IMAGE_EXT.test(f.name)) && !f.name.startsWith('.'));
  const fresh = images.filter((f) => !known.has(`${f.name}|${f.size}|${f.lastModified}`));
  const skipped = images.length - fresh.length;
  if (!fresh.length) {
    toast(images.length ? `Those ${plural(images.length, 'photo')} are already in your library.` : 'No photos found in what you dropped.');
    return;
  }
  db.persist();
  const t = toast(`Importing 0 / ${fresh.length}…`, { sticky: true });
  const added = [];
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < fresh.length) {
      const file = fresh[i++];
      try {
        const rec = await processFile(file);
        added.push(rec);
        S.photos.push(rec);
        S.byId.set(rec.id, rec);
      } catch (err) {
        console.warn('Could not import', file.name, err);
        failed++;
      }
      t.update(`Importing ${added.length + failed} / ${fresh.length}…`);
      if ((added.length + failed) % 12 === 0) refresh();
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  t.close();
  invalidateDupes();
  refresh();
  renderStorage();

  let msg = `Imported ${plural(added.length, 'photo')}.`;
  if (skipped) msg += ` ${skipped} already in library.`;
  if (failed) msg += ` ${failed} couldn't be read${fresh.some((f) => /\.hei[cf]$/i.test(f.name)) ? ' (HEIC needs Safari, or convert to JPEG)' : ''}.`;
  const canAnalyze = S.server.reachable && (S.server.demo || S.server.serverKey || S.apiKey);
  if (added.length && S.settings.autoAnalyze && canAnalyze) {
    toast(msg, { type: 'success' });
    enqueueAnalyze(added.map((p) => p.id));
  } else if (added.length && canAnalyze) {
    toast(msg, { type: 'success', action: 'Analyze with Jev', onAction: () => startAnalyze(added.map((p) => p.id)), timeout: 9000 });
  } else {
    toast(msg, { type: added.length ? 'success' : 'error' });
  }
}

async function processFile(file) {
  const buffer = await file.arrayBuffer();
  const exif = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name) ? im.readExif(buffer) : {};
  const blob = new Blob([buffer], { type: file.type || 'image/jpeg' });
  const bmp = await im.decode(blob);
  const [thumb, hash, colors] = [await im.makeThumb(bmp), im.dHash(bmp), im.palette(bmp)];
  const width = bmp.width || bmp.naturalWidth;
  const height = bmp.height || bmp.naturalHeight;
  bmp.close?.();
  const { taken, gps, ...camera } = exif;
  const rec = {
    id: uid(),
    name: file.name,
    path: file.webkitRelativePath || '',
    type: blob.type,
    size: file.size,
    width,
    height,
    modified: file.lastModified,
    added: Date.now(),
    taken: taken || null,
    exif: camera,
    gps: gps || null,
    hash,
    colors,
    fileKey: `${file.name}|${file.size}|${file.lastModified}`,
    fav: false,
    tags: [],
    albums: [],
    custom: {},
    ai: null,
  };
  await db.put('originals', blob, rec.id);
  await db.put('thumbs', thumb, rec.id);
  await db.put('photos', rec);
  return rec;
}

// ---------------------------------------------------------------- Jev analysis queue

const queue = { ids: [], running: 0, total: 0, done: 0, errors: 0, active: false, ctrl: null };
const refCopyCache = new Map();

function jevOpts(extra = {}) {
  return { model: S.settings.model, apiKey: S.server.serverKey ? '' : S.apiKey, ...extra };
}

function ensureReady() {
  if (!S.server.reachable) { toast('The Sift server isn\'t running. Start it with python3 server.py.', { type: 'error' }); return false; }
  if (!S.server.demo && !S.server.serverKey && !S.apiKey) { openSettings(); toast('Add your Jev API key first.', { type: 'error' }); return false; }
  return true;
}

async function startAnalyze(ids, { force = false } = {}) {
  if (!ensureReady()) return;
  const list = ids.filter((id) => force || !S.byId.get(id)?.ai);
  if (!list.length) { toast('Those photos are already analyzed.'); return; }
  if (list.length >= 10) {
    const ok = await confirmModal(`Analyze ${plural(list.length, 'photo')} with Jev?`,
      `Sift sends one request per photo with a ${S.settings.analysisSize}px copy (not the original) and asks ${jev.AUTO_TAGS.length + 5 + S.customTags.length} questions at once. ` +
      `So far you've used ${S.usage.requests.toLocaleString()} requests · ${S.usage.input.toLocaleString()} input tokens. You can stop at any time.`,
      { ok: `Analyze ${list.length}`, jevBtn: true });
    if (!ok) return;
  }
  enqueueAnalyze(list);
}

function enqueueAnalyze(ids) {
  const fresh = ids.filter((id) => !S.working.has(id) && !queue.ids.includes(id));
  if (!fresh.length) return;
  if (!queue.active) Object.assign(queue, { total: 0, done: 0, errors: 0, active: true, ctrl: new AbortController() });
  queue.ids.push(...fresh);
  queue.total += fresh.length;
  for (const id of fresh) S.working.add(id);
  refresh();
  pump();
}

function pump() {
  while (queue.active && queue.running < S.settings.concurrency && queue.ids.length) {
    const id = queue.ids.shift();
    queue.running++;
    analyzeOne(id).finally(() => {
      queue.running--;
      queue.done++;
      S.working.delete(id);
      if (!queue.ids.length && !queue.running) finishQueue();
      else pump();
      refresh();
    });
  }
}

function finishQueue(stopped = false) {
  if (!queue.active) return;
  const { done, errors } = queue;
  for (const id of queue.ids) S.working.delete(id);
  queue.ids = [];
  queue.active = false;
  invalidateDupes();
  saveUsage();
  if (stopped) toast(`Stopped. ${plural(done - errors, 'photo')} analyzed.`);
  else if (errors) toast(`Analyzed ${done - errors} of ${done}. ${errors} failed — open one to see why.`, { type: 'error' });
  else toast(`Analyzed ${plural(done, 'photo')}.`, { type: 'success' });
  refresh();
}

async function refCopyFor(photoId) {
  if (refCopyCache.has(photoId)) return refCopyCache.get(photoId);
  const blob = await db.get('originals', photoId);
  if (!blob) return null;
  const bmp = await im.decode(blob);
  const copy = await im.makeJevCopy(bmp, 512);
  bmp.close?.();
  refCopyCache.set(photoId, copy);
  return copy;
}

async function analyzeOne(id) {
  const p = S.byId.get(id);
  if (!p || !queue.active) return;
  try {
    const blob = await db.get('originals', id);
    const bmp = await im.decode(blob);
    const copy = await im.makeJevCopy(bmp, S.settings.analysisSize);
    bmp.close?.();
    const refCopies = {};
    for (const t of S.customTags) if (t.refPhotoId) refCopies[t.refPhotoId] = await refCopyFor(t.refPhotoId);
    const result = await jev.analyzePhoto(copy, jevOpts({ customTags: S.customTags, refCopies, signal: queue.ctrl.signal }));
    p.ai = result;
    p.custom = p.custom || {};
    for (const t of S.customTags) {
      const v = result.answers?.[`custom_${t.id}`]?.noul;
      if (v != null) p.custom[t.id] = v;
    }
    delete p.aiError;
    await db.put('photos', p);
  } catch (err) {
    if (err.name === 'AbortError') return;
    queue.errors++;
    p.aiError = err.message;
    await db.put('photos', p);
    // Stop early on problems that will affect every photo.
    if (err.status === 401 || err.status === 0 || err.status === 403) {
      toast(err.message, { type: 'error', timeout: 8000 });
      stopAll();
    }
  }
}

function stopAll() {
  queue.ctrl?.abort();
  searchJob.ctrl?.abort();
  if (queue.active) finishQueue(true);
}

// ---------------------------------------------------------------- Jev search & smart tags

const searchJob = { active: false, done: 0, total: 0, label: '', ctrl: null };

async function copiesFromThumbs(photos) {
  const out = [];
  for (const p of photos) {
    const blob = await db.get('thumbs', p.id);
    if (!blob) continue;
    const bmp = await im.decode(blob);
    out.push({ id: p.id, ...(await im.makeJevCopy(bmp, 512)) });
    bmp.close?.();
  }
  return out;
}

async function runBatchJob(label, photos, makeQuestion, extraImages = {}) {
  searchJob.ctrl = new AbortController();
  Object.assign(searchJob, { active: true, done: 0, total: photos.length, label });
  refresh();
  try {
    const results = {};
    // Prepare copies in chunks so huge libraries don't hold everything in memory.
    for (let i = 0; i < photos.length; i += 24) {
      const items = await copiesFromThumbs(photos.slice(i, i + 24));
      const base = searchJob.done;
      Object.assign(results, await jev.askAcross(items, makeQuestion, jevOpts({
        extraImages,
        signal: searchJob.ctrl.signal,
        onProgress: (d) => { searchJob.done = base + d; renderTopbar(); },
      })));
      searchJob.done = base + items.length;
    }
    return results;
  } finally {
    searchJob.active = false;
    saveUsage();
    refresh();
  }
}

async function askJev(query) {
  query = query.trim();
  if (!query) { $('#search').focus(); toast('Type what you\'re looking for, e.g. “birthday cake with candles”.'); return; }
  if (!ensureReady()) return;
  if (searchJob.active) { toast('A Jev search is already running.'); return; }
  const scopeView = ['cleanup', 'duplicates', 'smarttags'].includes(S.view) || S.view.startsWith('search:') ? 'all' : S.view;
  const saved = S.query;
  S.query = '';
  const scope = applyFilters(baseList(scopeView));
  S.query = saved;
  if (!scope.length) { toast('No photos to search here.'); return; }
  const requests = Math.ceil(scope.length / 4);
  const ok = await confirmModal(`Ask Jev to find “${query}”?`,
    `Jev will look at ${plural(scope.length, 'photo')} ${scopeView === 'all' ? 'in your library' : 'in this view'} — about ${plural(requests, 'request')} (4 small previews each).`,
    { ok: 'Search', jevBtn: true });
  if (!ok) return;
  try {
    const results = await runBatchJob('Searching', scope, jev.searchQuestion(query));
    const s = { id: uid(), query, results, scope: scope.length, at: Date.now() };
    S.searches.unshift(s);
    S.searches = S.searches.slice(0, 12);
    await db.put('kv', S.searches, 'searches');
    S.query = '';
    $('#search').value = '';
    S.showWeak = false;
    setView(`search:${s.id}`);
    const n = Object.values(results).filter((v) => v >= 0.5).length;
    toast(n ? `Jev found ${plural(n, 'match', 'matches')}.` : 'No strong matches. Try “Show weak matches”.', { type: n ? 'success' : 'info' });
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, { type: 'error', timeout: 8000 });
    else toast('Search stopped.');
  }
}

async function applySmartTag(tagId) {
  const tag = S.customTags.find((t) => t.id === tagId);
  if (!tag || !ensureReady()) return;
  if (searchJob.active) { toast('Another Jev job is running.'); return; }
  const todo = S.photos.filter((p) => p.custom?.[tag.id] == null);
  if (!todo.length) { toast('Every photo has been checked for this tag.'); return; }
  const ok = await confirmModal(`Check ${plural(todo.length, 'photo')} for “${tag.name}”?`,
    `About ${plural(Math.ceil(todo.length / 4), 'request')} (4 small previews each${tag.refPhotoId ? ', plus your example photo' : ''}).`, { ok: 'Check', jevBtn: true });
  if (!ok) return;
  try {
    const extra = tag.refPhotoId ? { reference: await refCopyFor(tag.refPhotoId) } : {};
    const results = await runBatchJob('Tagging', todo, jev.customTagQuestion(tag, !!tag.refPhotoId), extra);
    const changed = [];
    for (const [id, v] of Object.entries(results)) {
      const p = S.byId.get(id);
      if (!p) continue;
      p.custom = { ...(p.custom || {}), [tag.id]: v };
      changed.push(p);
    }
    await db.putMany('photos', changed);
    const n = changed.filter((p) => p.custom[tag.id] >= S.settings.threshold).length;
    toast(`Found ${plural(n, 'photo')} with “${tag.name}”.`, { type: 'success', action: n ? 'Show' : undefined, onAction: () => setView(`tag:${tag.name.toLowerCase()}`) });
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, { type: 'error', timeout: 8000 });
  }
}

async function newSmartTag(refPhotoId = null) {
  const refUrl = refPhotoId ? await thumbUrl(refPhotoId) : '';
  const result = await modal(`<form data-modal-form><div class="modal-head"><h3>New smart tag</h3></div><div class="modal-body">
    ${refUrl ? `<div class="field"><div class="label">Example photo</div><div style="display:flex;gap:12px;align-items:center"><img class="ref-thumb" style="width:64px;height:64px" src="${refUrl}" alt="" /><span class="faint small-text">Jev will look for the same subject in other photos.</span></div></div>` : ''}
    <div class="field"><label>Name</label><input class="input" name="name" placeholder="${refUrl ? 'e.g. Max the dog' : 'e.g. birthday cake'}" autofocus required maxlength="60" /></div>
    <div class="field"><label>Description <span class="faint">(optional)</span></label><textarea class="input" name="description" maxlength="240" placeholder="${refUrl ? 'e.g. our golden retriever with a red collar' : 'e.g. a cake with lit candles'}"></textarea><div class="hint">Be specific. Jev answers best when the description is concrete and visual.</div></div>
    <div class="field-row"><div><div class="label">Check my library now</div><div class="hint">Otherwise it runs when photos are analyzed.</div></div><label class="switch"><input type="checkbox" name="apply" checked /><span></span></label></div>
    </div><div class="modal-foot"><button type="button" class="btn ghost" data-modal="cancel">Cancel</button><button class="btn primary">Create tag</button></div></form>`);
  if (!result) return;
  const name = result.get('name').trim();
  if (!name) return;
  const tag = { id: uid(), name, description: result.get('description').trim(), refPhotoId, created: Date.now() };
  S.customTags.push(tag);
  await db.put('kv', S.customTags, 'customTags');
  refresh();
  if (result.get('apply')) applySmartTag(tag.id);
}

// ---------------------------------------------------------------- photo actions

async function savePhotos(list) { await db.putMany('photos', list); }

function selectedPhotos() { return [...S.selected].map((id) => S.byId.get(id)).filter(Boolean); }

async function toggleFav(ids) {
  const list = ids.map((id) => S.byId.get(id)).filter(Boolean);
  const value = !list.every((p) => p.fav);
  for (const p of list) p.fav = value;
  await savePhotos(list);
  refresh();
}

async function deletePhotos(ids) {
  const ok = await confirmModal(`Delete ${plural(ids.length, 'photo')}?`, 'They\'ll be removed from Sift on this computer. Your original files on disk are not touched.', { ok: 'Delete', danger: true });
  if (!ok) return;
  for (const id of ids) {
    S.byId.delete(id);
    S.selected.delete(id);
    dropThumb(id);
  }
  const gone = new Set(ids);
  S.photos = S.photos.filter((p) => !gone.has(p.id));
  await Promise.all([db.delMany('photos', ids), db.delMany('thumbs', ids), db.delMany('originals', ids)]);
  invalidateDupes();
  if (S.lightboxId && gone.has(S.lightboxId)) closeLightbox();
  toast(`Deleted ${plural(ids.length, 'photo')}.`);
  refresh();
  renderStorage();
}

async function addTag(ids) {
  const existing = new Set();
  for (const p of S.photos) for (const t of p.tags || []) existing.add(t);
  const form = await promptModal(ids.length > 1 ? `Tag ${plural(ids.length, 'photo')}` : 'Add tag', { placeholder: 'e.g. vacation 2025', ok: 'Add tag', suggestions: [...existing].slice(0, 12) });
  const tag = form?.get('v')?.trim().toLowerCase();
  if (!tag) return;
  const list = ids.map((id) => S.byId.get(id)).filter(Boolean);
  for (const p of list) if (!p.tags.includes(tag)) p.tags.push(tag);
  await savePhotos(list);
  toast(`Tagged ${plural(list.length, 'photo')} “${tag}”.`, { type: 'success' });
  refresh();
}

async function addToAlbum(ids) {
  const list = S.albums.map((a) => `<button type="button" data-pick="${a.id}">${icon('folder')}<span>${esc(a.name)}</span></button>`).join('');
  const result = await modal(`<form data-modal-form><div class="modal-head"><h3>Add ${plural(ids.length, 'photo')} to album</h3></div><div class="modal-body">
    ${list ? `<div class="album-pick">${list}</div>` : ''}
    <div class="field"><label>${list ? 'Or create a new album' : 'New album name'}</label><input class="input" name="v" placeholder="e.g. Japan trip" ${list ? '' : 'autofocus'} autocomplete="off" /></div>
    </div><div class="modal-foot"><button type="button" class="btn ghost" data-modal="cancel">Cancel</button><button class="btn primary">Create & add</button></div></form>`);
  if (!result) return;
  let albumId = typeof result === 'string' ? result : null;
  if (!albumId) {
    const name = result.get('v')?.trim();
    if (!name) return;
    albumId = (await createAlbum(name)).id;
  }
  const photos = ids.map((id) => S.byId.get(id)).filter(Boolean);
  for (const p of photos) if (!p.albums.includes(albumId)) p.albums.push(albumId);
  await savePhotos(photos);
  const album = S.albums.find((a) => a.id === albumId);
  toast(`Added to ${album.name}.`, { type: 'success', action: 'Open', onAction: () => setView(`album:${albumId}`) });
  refresh();
}

async function createAlbum(name) {
  const a = { id: uid(), name, created: Date.now() };
  S.albums.push(a);
  S.albums.sort((x, y) => x.name.localeCompare(y.name));
  await db.put('albums', a);
  return a;
}

async function downloadZip(ids, name = 'sift-photos') {
  if (!ids.length) return;
  if (ids.length === 1) return downloadOriginal(ids[0]);
  const t = toast(`Preparing ${plural(ids.length, 'photo')}…`, { sticky: true });
  try {
    const files = [];
    for (const id of ids) {
      const p = S.byId.get(id);
      const blob = await db.get('originals', id);
      if (p && blob) files.push({ name: p.name, blob, modified: p.modified });
    }
    const zip = await makeZip(files);
    saveBlob(zip, `${name.replace(/[^\w\- ]+/g, '').trim() || 'sift-photos'}.zip`);
  } finally { t.close(); }
}

async function downloadOriginal(id) {
  const p = S.byId.get(id);
  const blob = await db.get('originals', id);
  if (p && blob) saveBlob(blob, p.name);
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportCsv() {
  const cols = ['name', 'taken', 'camera', 'width', 'height', 'size', 'scene', 'scene_confidence', 'setting', 'light', 'people', 'quality', 'tags', 'albums', 'favorite', 'latitude', 'longitude'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = S.photos.map((p) => [
    p.name, p.taken ? new Date(p.taken).toISOString() : '', [p.exif?.make, p.exif?.model].filter(Boolean).join(' '),
    p.width, p.height, p.size, sceneOf(p) || '', ans(p, 'scene')?.confidence ?? '', ans(p, 'setting')?.choice || '',
    ans(p, 'light')?.choice || '', ans(p, 'people_count')?.choice || '', qualityOf(p)?.toFixed(2) ?? '',
    [...allTagLabels(p)].join('; '), (p.albums || []).map((id) => S.albums.find((a) => a.id === id)?.name).filter(Boolean).join('; '),
    p.fav ? 'yes' : '', p.gps?.lat ?? '', p.gps?.lon ?? '',
  ].map(q).join(','));
  saveBlob(new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' }), 'sift-library.csv');
}

// ---------------------------------------------------------------- selection

function toggleSelect(id, e) {
  if (e?.shiftKey && S.anchor && S.visible.includes(S.anchor)) {
    const a = S.visible.indexOf(S.anchor);
    const b = S.visible.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) S.selected.add(S.visible[i]);
  } else if (S.selected.has(id)) S.selected.delete(id);
  else S.selected.add(id);
  S.anchor = id;
  refresh();
}

function clearSelection() { S.selected.clear(); S.anchor = null; refresh(); }

// ---------------------------------------------------------------- lightbox

let lbUrl = null;
async function openLightbox(id) {
  S.lightboxId = id;
  const lb = $('#lightbox');
  lb.hidden = false;
  lb.classList.toggle('no-panel', !S.panelOpen);
  const imgEl = $('#lb-img');
  const p = S.byId.get(id);
  imgEl.src = await thumbUrl(id);
  imgEl.alt = p.name;
  renderLightboxPanel();
  const blob = await db.get('originals', id);
  if (S.lightboxId !== id || !blob) return;
  if (lbUrl) URL.revokeObjectURL(lbUrl);
  lbUrl = URL.createObjectURL(blob);
  const full = new Image();
  full.onload = () => { if (S.lightboxId === id) imgEl.src = lbUrl; };
  full.src = lbUrl;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  S.lightboxId = null;
  if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = null; }
  $('#lb-img').removeAttribute('src');
}

function stepLightbox(d) {
  const i = S.visible.indexOf(S.lightboxId);
  const next = S.visible[i + d];
  if (next) openLightbox(next);
}

function bars(answer, labels) {
  const entries = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return `<div class="bars">${entries.map(([k, v], i) => `<div class="bar-row ${i === 0 ? 'top' : ''}"><span class="lbl">${esc(labels(k))}</span><span class="track"><i style="width:${(v * 100).toFixed(1)}%"></i></span><span class="v">${pct(v)}</span></div>`).join('')}</div>`;
}

function renderLightboxPanel() {
  const p = S.byId.get(S.lightboxId);
  if (!p) return;
  const i = S.visible.indexOf(p.id);
  $('#lb-title').textContent = `${p.name}${i >= 0 ? `  ·  ${i + 1} of ${S.visible.length}` : ''}`;
  $('.lb-nav.prev').disabled = i <= 0;
  $('.lb-nav.next').disabled = i < 0 || i >= S.visible.length - 1;
  $('#lb-fav').classList.toggle('on', p.fav);

  let h = `<div class="panel-sec"><div style="font-weight:650;font-size:15px;overflow-wrap:anywhere">${esc(p.name)}</div><div class="muted small-text">${fmtDate(dateOf(p), { dateStyle: 'full', timeStyle: 'short' })}${p.taken ? '' : ' <span class="faint">(file date)</span>'}</div></div>`;

  // Jev section
  h += `<div class="panel-sec"><h5>${icon('sparkles')}<span class="grow">Jev analysis</span>${p.ai ? `<button class="link-btn small-text" data-action="lb-reanalyze">Re-analyze</button>` : ''}</h5>`;
  if (S.working.has(p.id)) {
    h += `<div class="muted small-text" style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>Analyzing…</div>`;
  } else if (!p.ai) {
    if (p.aiError) h += `<div class="banner" style="margin:0 0 10px">${icon('alert')}<span class="grow small-text">${esc(p.aiError)}</span></div>`;
    h += `<p class="muted small-text" style="margin:0 0 10px">Let Jev sort this photo into a scene, rate its quality, and tag what's in it.</p><button class="btn jev small" data-action="lb-analyze">${icon('sparkles')}Analyze this photo</button>`;
  } else {
    const scene = ans(p, 'scene');
    const s = jev.SCENES[scene?.choice];
    const low = (scene?.confidence ?? 1) < 0.45;
    h += `<div class="answer"><div class="big">${s?.icon || ''} ${esc(s?.label || scene?.choice || '—')}</div><span class="conf ${low ? 'low' : ''}" title="How sure Jev is">${low ? 'unsure · ' : ''}${pct(scene?.confidence ?? 0)} sure</span></div>`;
    if (scene) h += bars(scene, (k) => jev.SCENES[k]?.label || k);
    const mini = (k, label, map = (x) => x) => `<div class="mini"><div class="k">${label}</div><div class="v">${esc(map(ans(p, k)?.choice) || '—')}</div></div>`;
    h += `<div class="mini-grid" style="margin-top:12px">${mini('setting', 'Setting')}${mini('light', 'Light', (x) => ({ golden: 'golden hour', none: '—' }[x] || x))}${mini('people_count', 'People')}</div>`;
    const ql = qualityLevel(p);
    if (ql != null) {
      h += `<div style="margin-top:12px"><div class="answer" style="margin-bottom:4px"><span class="small-text muted">Quality</span><span class="small-text"><b>${jev.QUALITY_NAMES[ql]}</b> <span class="faint">${qualityOf(p).toFixed(1)} / 3</span></span></div><div class="quality-meter">${[0, 1, 2, 3].map((k) => `<span class="${k <= ql ? `on q${ql}` : ''}"></span>`).join('')}</div></div>`;
    }
  }
  h += `</div>`;

  // Tags
  const auto = autoTags(p);
  h += `<div class="panel-sec"><h5>${icon('tag')}Tags</h5><div class="tags">`;
  for (const t of auto) h += `<button class="tag auto" data-view="tag:${esc(t.label.toLowerCase())}" title="Added by Jev">${t.custom ? '★ ' : ''}${esc(t.label)} <span class="pct">${pct(t.prob)}</span></button>`;
  for (const t of p.tags) h += `<span class="tag"><button class="tag" style="padding:0;background:none" data-view="tag:${esc(t)}">${esc(t)}</button><button class="x" data-action="lb-untag" data-tag="${esc(t)}" aria-label="Remove tag">${icon('x')}</button></span>`;
  if (!auto.length && !p.tags.length) h += `<span class="faint small-text">No tags yet.</span>`;
  h += `</div><form class="tag-input" data-lb-tag><input class="input" name="t" placeholder="Add a tag…" autocomplete="off" /><button class="btn small">Add</button></form></div>`;

  // Albums
  h += `<div class="panel-sec"><h5>${icon('folder')}<span class="grow">Albums</span><button class="link-btn small-text" data-action="lb-album">Add</button></h5><div class="tags">`;
  const albums = p.albums.map((id) => S.albums.find((a) => a.id === id)).filter(Boolean);
  for (const a of albums) h += `<span class="tag"><button class="tag" style="padding:0;background:none" data-view="album:${a.id}">${esc(a.name)}</button><button class="x" data-action="lb-unalbum" data-album="${a.id}" aria-label="Remove from album">${icon('x')}</button></span>`;
  if (!albums.length) h += `<span class="faint small-text">Not in any album.</span>`;
  h += `</div></div>`;

  // Details
  const e = p.exif || {};
  const camera = [e.make, e.model].filter(Boolean).join(' ');
  const exposure = [e.fNumber && `ƒ/${+e.fNumber.toFixed(1)}`, e.exposure && (e.exposure >= 1 ? `${e.exposure}s` : `1/${Math.round(1 / e.exposure)}s`), e.iso && `ISO ${e.iso}`, e.focal && `${Math.round(e.focal)}mm`].filter(Boolean).join(' · ');
  h += `<div class="panel-sec"><h5>${icon('camera')}Details</h5><dl class="kv">`;
  if (camera) h += `<dt>Camera</dt><dd>${esc(camera)}</dd>`;
  if (e.lens) h += `<dt>Lens</dt><dd>${esc(e.lens)}</dd>`;
  if (exposure) h += `<dt>Exposure</dt><dd>${esc(exposure)}</dd>`;
  h += `<dt>Dimensions</dt><dd>${p.width} × ${p.height} · ${((p.width * p.height) / 1e6).toFixed(1)} MP</dd>`;
  h += `<dt>File</dt><dd>${fmtBytes(p.size)} · ${esc((p.type || '').replace('image/', '').toUpperCase())}</dd>`;
  if (p.path) h += `<dt>Folder</dt><dd>${esc(p.path.split('/').slice(0, -1).join('/'))}</dd>`;
  if (p.gps) h += `<dt>Location</dt><dd><a href="https://www.openstreetmap.org/?mlat=${p.gps.lat}&mlon=${p.gps.lon}#map=15/${p.gps.lat}/${p.gps.lon}" target="_blank" rel="noopener">${p.gps.lat.toFixed(4)}, ${p.gps.lon.toFixed(4)} ↗</a></dd>`;
  h += `<dt>Imported</dt><dd>${fmtDate(p.added)}</dd></dl></div>`;

  // Colors
  if (p.colors?.length) {
    h += `<div class="panel-sec"><h5>Colors</h5><div class="swatches">${p.colors.map((c) => `<button style="background:${c.hex}" title="${c.name} ${c.hex}" data-view="color:${c.name}"></button>`).join('')}</div></div>`;
  }

  h += `<div class="panel-sec"><button class="btn small" data-action="lb-smart-tag">${icon('scan')}Find more like this</button></div>`;
  $('#lb-panel').innerHTML = h;
}

// ---------------------------------------------------------------- filters popover

function openFilters(anchor) {
  const pop = $('#popover');
  const f = S.filters;
  const years = [...new Set(S.photos.map((p) => new Date(dateOf(p)).getFullYear()))].sort((a, b) => b - a);
  const opt = (group, val, label, on) => `<button class="opt ${on ? 'on' : ''}" data-filter="${group}" data-val="${esc(val)}">${esc(label)}</button>`;
  let h = `<h6>Scene</h6><div class="opt-row">${Object.entries(jev.SCENES).map(([k, v]) => opt('scenes', k, `${v.icon} ${v.label}`, f.scenes.has(k))).join('')}</div>`;
  h += `<h6>Quality</h6><div class="opt-row">${opt('quality', '', 'Any', f.quality == null)}${opt('quality', '2', 'Fine or better', f.quality === 2)}${opt('quality', '3', 'Great only', f.quality === 3)}</div>`;
  h += `<h6>Orientation</h6><div class="opt-row">${['', 'landscape', 'portrait', 'square'].map((o) => opt('orientation', o, o || 'Any', (f.orientation || '') === o)).join('')}</div>`;
  h += `<h6>Setting</h6><div class="opt-row">${['', 'indoor', 'outdoor'].map((o) => opt('setting', o, o || 'Any', (f.setting || '') === o)).join('')}</div>`;
  h += `<h6>People</h6><div class="opt-row">${['', 'none', 'one', 'two', 'group', 'crowd'].map((o) => opt('people', o, o || 'Any', (f.people || '') === o)).join('')}</div>`;
  if (years.length > 1) h += `<h6>Year</h6><div class="opt-row">${opt('year', '', 'Any', !f.year)}${years.map((y) => opt('year', y, y, f.year === y)).join('')}</div>`;
  h += `<h6>Other</h6><div class="opt-row">${opt('location', '1', 'Has GPS location', f.location)}</div>`;
  pop.innerHTML = h;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - 332))}px`;
}

function setFilter(group, val) {
  const f = S.filters;
  if (group === 'scenes') f.scenes.has(val) ? f.scenes.delete(val) : f.scenes.add(val);
  else if (group === 'quality') f.quality = val === '' ? null : +val;
  else if (group === 'year') f.year = val === '' ? null : +val;
  else if (group === 'location') f.location = !f.location;
  else f[group] = val || null;
}

// ---------------------------------------------------------------- settings

async function openSettings() {
  const st = S.settings;
  const statusText = !S.server.reachable ? 'Server not reachable — start it with <code>python3 server.py</code>.'
    : S.server.demo ? 'Demo mode — answers are made up.'
    : S.server.serverKey ? 'Connected. Using the API key from the server\'s environment.'
    : S.apiKey ? 'Connected. Using the key saved in this browser.' : 'Connected, but no API key yet.';
  const dotCls = !S.server.reachable ? 'off' : S.server.demo ? 'demo' : S.server.serverKey || S.apiKey ? 'ok' : 'off';
  const seg = (name, options, cur) => `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const result = await modal(`<form data-modal-form><div class="modal-head"><h3>Settings</h3><button type="button" class="icon-btn" data-modal="cancel">${icon('x')}</button></div><div class="modal-body">
    <div class="status-box"><span class="status-dot ${dotCls}"></span><span>${statusText}</span></div>
    <div class="field"><label>Jev API key</label><input class="input" type="password" name="apiKey" value="${esc(S.apiKey)}" placeholder="${S.server.serverKey ? 'Set on the server — nothing needed here' : 'Paste your TypeSafe API key'}" autocomplete="off" ${S.server.serverKey ? 'disabled' : ''} />
      <div class="hint">Saved only in this browser and sent to your local Sift server, which forwards it to Jev. For extra safety, set <code>TYPESAFE_API_KEY</code> before starting the server instead.</div></div>
    <div class="field"><label>Model</label><input class="input" name="model" value="${esc(st.model)}" /><div class="hint"><code>jev-latest</code> always points at the newest Jev.</div></div>
    <div class="settings-sec">Tagging</div>
    <div class="field"><div class="label">Tag confidence threshold</div><div class="range-row"><input type="range" name="threshold" min="0.5" max="0.95" step="0.05" value="${st.threshold}" oninput="this.nextElementSibling.value=Math.round(this.value*100)+'%'" /><output>${Math.round(st.threshold * 100)}%</output></div><div class="hint">A tag is added when Jev is at least this sure. Higher means fewer, more accurate tags. Changing it doesn't cost anything.</div></div>
    <div class="field-row"><div><div class="label">Analysis image size</div><div class="hint">Smaller copies use fewer tokens.</div></div>${seg('analysisSize', [[512, '512px'], [768, '768px'], [1024, '1024px']], st.analysisSize)}</div>
    <div class="field-row"><div><div class="label">Parallel requests</div><div class="hint">Lower this if you hit rate limits.</div></div>${seg('concurrency', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], st.concurrency)}</div>
    <div class="field-row"><div><div class="label">Analyze new imports automatically</div><div class="hint">Off = you choose when to spend requests.</div></div><label class="switch"><input type="checkbox" name="autoAnalyze" ${st.autoAnalyze ? 'checked' : ''} /><span></span></label></div>
    <div class="settings-sec">Appearance</div>
    <div class="field-row"><div class="label">Theme</div>${seg('theme', [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], st.theme)}</div>
    <div class="settings-sec">Usage this browser</div>
    <div class="usage"><div class="mini"><div class="k">Requests</div><div class="v">${S.usage.requests.toLocaleString()}</div></div><div class="mini"><div class="k">Input tokens</div><div class="v">${S.usage.input.toLocaleString()}</div></div><div class="mini"><div class="k">Output tokens</div><div class="v">${S.usage.output.toLocaleString()}</div></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn small" data-action="export-csv">${icon('file')}Export library as CSV</button><button type="button" class="btn small ghost" data-action="reset-usage">Reset usage</button><button type="button" class="btn small ghost danger" data-action="wipe">Delete all data</button></div>
    </div><div class="modal-foot"><button type="button" class="btn ghost" data-modal="cancel">Cancel</button><button class="btn primary">Save</button></div></form>`, { wide: true });
  if (!result) return;
  const box = result;
  if (!S.server.serverKey) {
    S.apiKey = (box.get('apiKey') || '').trim();
    lsSet('sift.apiKey', S.apiKey);
  }
  st.model = (box.get('model') || '').trim() || 'jev-latest';
  st.threshold = +box.get('threshold');
  st.autoAnalyze = !!box.get('autoAnalyze');
  for (const k of ['analysisSize', 'concurrency']) st[k] = +box.get(k);
  st.theme = box.get('theme');
  applyTheme();
  await saveSettings();
  toast('Settings saved.', { type: 'success' });
  refresh();
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

async function saveSettings() { await db.put('kv', S.settings, 'settings'); }
let usageTimer;
function saveUsage() { clearTimeout(usageTimer); usageTimer = setTimeout(() => db.put('kv', S.usage, 'usage'), 500); }

// ---------------------------------------------------------------- navigation

function setView(view) {
  S.view = view;
  S.selected.clear();
  $('#sidebar').classList.remove('open');
  $('#view').scrollTop = 0;
  refresh();
}

// ---------------------------------------------------------------- events

function bindEvents() {
  document.addEventListener('click', async (e) => {
    const t = e.target;

    // Modal buttons
    const mb = t.closest('[data-modal]');
    if (mb) { closeModal(mb.dataset.modal === 'ok'); return; }
    const pick = t.closest('[data-pick]');
    if (pick) { closeModal(pick.dataset.pick); return; }
    const fill = t.closest('[data-fill]');
    if (fill) { const inp = $('#modal-box input[name="v"]'); inp.value = fill.dataset.fill; inp.focus(); return; }
    const segBtn = t.closest('.seg button');
    if (segBtn) { for (const b of segBtn.parentElement.children) b.classList.toggle('on', b === segBtn); return; }
    if (t === $('#modal')) { closeModal(null); return; }

    // Popover
    const fb = t.closest('[data-filter]');
    if (fb) { setFilter(fb.dataset.filter, fb.dataset.val); openFilters($('#filter-btn')); refresh(); return; }
    if (!t.closest('#popover') && !t.closest('#filter-btn')) $('#popover').hidden = true;

    // Tiles
    const tile = t.closest('.tile[data-id]');
    if (tile && t.closest('#view')) {
      const id = tile.dataset.id;
      if (t.closest('.strip')) { openLightbox(id); return; }
      if (t.closest('[data-act="fav"]')) { toggleFav([id]); return; }
      if (t.closest('.check') || e.shiftKey || e.metaKey || e.ctrlKey || S.selected.size) { toggleSelect(id, e); return; }
      S.anchor = id;
      openLightbox(id);
      return;
    }

    const nav = t.closest('[data-view]');
    if (nav) {
      if (S.lightboxId && nav.closest('#lightbox')) closeLightbox();
      setView(nav.dataset.view);
      return;
    }

    const a = t.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    const lbIds = S.lightboxId ? [S.lightboxId] : [];
    switch (act) {
      case 'import': $('#file-input').click(); break;
      case 'import-folder': $('#folder-input').click(); break;
      case 'settings': openSettings(); break;
      case 'toggle-sidebar': $('#sidebar').classList.toggle('open'); break;
      case 'filters': $('#popover').hidden ? openFilters(a) : ($('#popover').hidden = true); break;
      case 'unfilter': {
        const { key, val } = a.dataset;
        if (key === 'query') { S.query = ''; $('#search').value = ''; } else if (key === 'scenes') S.filters.scenes.delete(val);
        else if (key === 'location') S.filters.location = false; else S.filters[key] = null;
        refresh(); break;
      }
      case 'clear-filters': S.filters = emptyFilters(); S.query = ''; $('#search').value = ''; refresh(); break;
      case 'analyze-pending': startAnalyze(S.photos.filter((p) => !p.ai).map((p) => p.id)); break;
      case 'stop': stopAll(); break;
      case 'ask-jev': askJev($('#search').value); break;
      case 'select-all': S.visible.forEach((id) => S.selected.add(id)); refresh(); break;
      case 'select-group': a.dataset.ids.split(',').forEach((id) => S.selected.add(id)); refresh(); break;
      case 'select-clean': setView(`clean:${a.dataset.key}`); baseList().forEach((p) => S.selected.add(p.id)); refresh(); break;
      case 'select-extras': { const g = duplicateGroups()[+a.dataset.group]; g.photos.forEach((p) => p.id !== g.best && S.selected.add(p.id)); refresh(); break; }
      case 'select-all-extras': duplicateGroups().forEach((g) => g.photos.forEach((p) => p.id !== g.best && S.selected.add(p.id))); refresh(); break;
      case 'sel-clear': clearSelection(); break;
      case 'sel-fav': toggleFav([...S.selected]); break;
      case 'sel-tag': addTag([...S.selected]); break;
      case 'sel-album': addToAlbum([...S.selected]); break;
      case 'sel-analyze': startAnalyze([...S.selected], { force: selectedPhotos().every((p) => p.ai) }); break;
      case 'sel-zip': downloadZip([...S.selected]); break;
      case 'sel-delete': deletePhotos([...S.selected]); break;
      case 'zip-view': downloadZip(S.visible, viewTitle()[0]); break;
      case 'new-album': { const f = await promptModal('New album', { placeholder: 'e.g. Summer 2025', ok: 'Create' }); const name = f?.get('v')?.trim(); if (name) { const al = await createAlbum(name); setView(`album:${al.id}`); } break; }
      case 'rename-album': {
        const al = S.albums.find((x) => `album:${x.id}` === S.view);
        const f = await promptModal('Rename album', { value: al.name, ok: 'Rename' });
        const name = f?.get('v')?.trim();
        if (name) { al.name = name; await db.put('albums', al); refresh(); }
        break;
      }
      case 'delete-album': {
        const al = S.albums.find((x) => `album:${x.id}` === S.view);
        if (!(await confirmModal(`Delete “${al.name}”?`, 'The photos stay in your library — only the album is removed.', { ok: 'Delete album', danger: true }))) break;
        S.albums = S.albums.filter((x) => x !== al);
        const changed = S.photos.filter((p) => p.albums.includes(al.id));
        changed.forEach((p) => { p.albums = p.albums.filter((x) => x !== al.id); });
        await Promise.all([db.del('albums', al.id), savePhotos(changed)]);
        setView('all');
        break;
      }
      case 'toggle-weak': S.showWeak = !S.showWeak; refresh(); break;
      case 'search-to-album': {
        const s = S.searches.find((x) => `search:${x.id}` === S.view);
        const al = await createAlbum(s.query);
        const photos = S.visible.map((id) => S.byId.get(id));
        photos.forEach((p) => p.albums.push(al.id));
        await savePhotos(photos);
        toast(`Saved ${plural(photos.length, 'photo')} to “${al.name}”.`, { type: 'success' });
        setView(`album:${al.id}`);
        break;
      }
      case 'delete-search': S.searches = S.searches.filter((x) => `search:${x.id}` !== S.view); await db.put('kv', S.searches, 'searches'); setView('all'); break;
      case 'new-smart-tag': newSmartTag(S.selected.size === 1 ? [...S.selected][0] : null); break;
      case 'apply-smart-tag': applySmartTag(a.dataset.id); break;
      case 'delete-smart-tag': {
        const tag = S.customTags.find((x) => x.id === a.dataset.id);
        if (!(await confirmModal(`Delete smart tag “${tag.name}”?`, 'Photos keep everything else; only this tag is removed.', { ok: 'Delete', danger: true }))) break;
        S.customTags = S.customTags.filter((x) => x !== tag);
        await db.put('kv', S.customTags, 'customTags');
        refresh();
        break;
      }
      // Lightbox
      case 'lb-close': closeLightbox(); break;
      case 'lb-prev': stepLightbox(-1); break;
      case 'lb-next': stepLightbox(1); break;
      case 'lb-info': S.panelOpen = !S.panelOpen; $('#lightbox').classList.toggle('no-panel', !S.panelOpen); break;
      case 'lb-fav': toggleFav(lbIds); break;
      case 'lb-download': downloadOriginal(S.lightboxId); break;
      case 'lb-delete': deletePhotos(lbIds); break;
      case 'lb-analyze': if (ensureReady()) enqueueAnalyze(lbIds); break;
      case 'lb-reanalyze': if (ensureReady()) enqueueAnalyze(lbIds); break;
      case 'lb-album': addToAlbum(lbIds); break;
      case 'lb-smart-tag': { const id = S.lightboxId; closeLightbox(); newSmartTag(id); break; }
      case 'lb-untag': { const p = S.byId.get(S.lightboxId); p.tags = p.tags.filter((x) => x !== a.dataset.tag); await savePhotos([p]); refresh(); break; }
      case 'lb-unalbum': { const p = S.byId.get(S.lightboxId); p.albums = p.albums.filter((x) => x !== a.dataset.album); await savePhotos([p]); refresh(); break; }
      // Settings extras
      case 'export-csv': exportCsv(); break;
      case 'reset-usage': S.usage = { requests: 0, input: 0, output: 0 }; saveUsage(); for (const el of document.querySelectorAll('.usage .v')) el.textContent = '0'; break;
      case 'wipe': {
        closeModal(null);
        if (!(await confirmModal('Delete everything?', 'This removes all photos, albums, tags, searches and settings from Sift in this browser. Original files on your disk are not touched.', { ok: 'Delete everything', danger: true }))) break;
        stopAll();
        await Promise.all(['photos', 'thumbs', 'originals', 'albums', 'kv'].map((s) => db.clear(s)));
        location.reload();
        break;
      }
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    if (form.id === 'search-form') {
      // Enter searches locally (already live). If nothing matched, offer Jev.
      S.query = $('#search').value;
      refresh();
      if (S.query.trim() && !applyFilters(baseList()).length) askJev(S.query);
      return;
    }
    if (form.matches('[data-modal-form]')) {
      const data = new FormData(form);
      for (const seg of form.querySelectorAll('[data-seg]')) data.set(seg.dataset.seg, seg.querySelector('.on')?.dataset.v);
      closeModal(data);
      return;
    }
    if (form.matches('[data-lb-tag]')) {
      const tag = new FormData(form).get('t').trim().toLowerCase();
      const p = S.byId.get(S.lightboxId);
      if (tag && p && !p.tags.includes(tag)) { p.tags.push(tag); await savePhotos([p]); }
      renderLightboxPanel();
      $('#lb-panel input[name="t"]')?.focus();
      refresh();
    }
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.query = e.target.value; refresh(); }, 120);
  });
  $('#sort').addEventListener('change', (e) => { S.settings.sort = e.target.value; saveSettings(); refresh(); });
  $('#zoom').addEventListener('input', (e) => { S.settings.tile = +e.target.value; document.documentElement.style.setProperty('--tile', `${e.target.value}px`); });
  $('#zoom').addEventListener('change', saveSettings);

  for (const id of ['file-input', 'folder-input']) {
    $(`#${id}`).addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  }

  // Drag & drop anywhere
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#drop-overlay').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    importFiles(await filesFromDrop(e.dataTransfer));
  });

  // Swipe between photos on touch screens
  let touchX = null;
  $('.lb-stage').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('.lb-stage').addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(null); return; }
    if (S.lightboxId) {
      if (e.key === 'Escape') { document.activeElement?.blur(); closeLightbox(); return; }
      if (typing) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'f') toggleFav([S.lightboxId]);
      else if (e.key === 'i') { S.panelOpen = !S.panelOpen; $('#lightbox').classList.toggle('no-panel', !S.panelOpen); }
      else if (e.key === 'Delete' || e.key === 'Backspace') deletePhotos([S.lightboxId]);
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#popover').hidden) $('#popover').hidden = true;
      else if (typing) document.activeElement.blur();
      else if (S.selected.size) clearSelection();
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); S.visible.forEach((id) => S.selected.add(id)); refresh(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected.size) deletePhotos([...S.selected]);
  });
}

// ---------------------------------------------------------------- boot

async function checkServer() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const data = await res.json();
    S.server = { reachable: !!data.ok, demo: !!data.demo, serverKey: !!data.serverKey };
  } catch {
    S.server = { reachable: false, demo: false, serverKey: false };
  }
}

async function boot() {
  hydrateIcons();
  $('#boot-hint')?.remove();
  const [photos, albums, settings, customTags, searches, usage] = await Promise.all([
    db.all('photos'), db.all('albums'), db.get('kv', 'settings'), db.get('kv', 'customTags'), db.get('kv', 'searches'), db.get('kv', 'usage'),
  ]);
  S.photos = photos;
  for (const p of photos) { S.byId.set(p.id, p); p.tags ||= []; p.albums ||= []; }
  S.albums = albums.sort((a, b) => a.name.localeCompare(b.name));
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.customTags = customTags || [];
  S.searches = searches || [];
  S.usage = usage || S.usage;
  S.apiKey = lsGet('sift.apiKey');
  applyTheme();
  document.documentElement.style.setProperty('--tile', `${S.settings.tile}px`);
  $('#zoom').value = S.settings.tile;

  jev.onUsage((u) => {
    S.usage.requests++;
    S.usage.input += u.input_tokens || 0;
    S.usage.output += u.output_tokens || 0;
    saveUsage();
  });

  bindEvents();
  await checkServer();
  renderAll();
  renderStorage();
}

boot();
