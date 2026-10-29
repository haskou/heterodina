import './style.css';
import type { RadioAlbum, RadioContext, Track } from '../../shared/types.ts';
import { api } from './api.ts';
import { AudioEngine } from './engine.ts';
import { formatTime } from './format.ts';
import { applyTo, pickLanguage, translator } from './i18n.ts';
import { MediaSession } from './media-session.ts';
import { DEFAULT_THEME, themeFromPixels, type Theme } from './palette.ts';
import { Queue } from './queue.ts';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

// The browser's language, falling back to English.
const language = pickLanguage(navigator.languages);
const t = translator(language);
document.documentElement.lang = language;
applyTo(document, t);
// index.html keeps the page hidden until styles and text are in place.
document.body.style.visibility = 'visible';

const ui = {
  source: $<HTMLSelectElement>('source'),
  search: $<HTMLInputElement>('search'),
  results: $<HTMLUListElement>('results'),
  now: $('now'),
  nowArt: $('now-art'),
  nowTitle: $('now-title'),
  nowSub: $('now-sub'),
  stars: $('stars'),
  station: $<HTMLButtonElement>('station'),
  universe: $<HTMLDialogElement>('universe'),
  uTitle: $('u-title'),
  uSub: $('u-sub'),
  uClose: $<HTMLButtonElement>('u-close'),
  uSearch: $<HTMLInputElement>('u-search'),
  uList: $<HTMLUListElement>('u-list'),
  empty: $('empty'),
  startList: $<HTMLUListElement>('start-list'),
  startMore: $<HTMLButtonElement>('start-more'),
  play: $<HTMLButtonElement>('play'),
  next: $<HTMLButtonElement>('next'),
  seek: $<HTMLInputElement>('seek'),
  pos: $('pos'),
  dur: $('dur'),
  volume: $<HTMLInputElement>('volume'),
  toast: $('toast'),
  busy: $('busy'),
};

const queue = new Queue();

const player = new BroadcastChannel('heterodina-player');
const engine = new AudioEngine(queue, {
  state(state, track) {
    document.body.classList.toggle('playing', state === 'playing');
    document.body.classList.toggle('loading', state === 'loading');
    ui.play.disabled = !track;
    ui.seek.disabled = state === 'idle' || state === 'loading';
    media.playing(state === 'playing');
    if (state === 'playing') player.postMessage('playing');
  },
  trackChanged(track) {
    show(track);
    media.track(track);
    history.push(track.id);
    void refillRadio();
  },
  error(track, err) {
    console.error(err);
    toast(t('cantPlay', { title: track.title }));
  },
});

// One player at a time: a tab that starts playing pauses the others.
player.onmessage = () => void engine.pause();

if (import.meta.env.DEV) Object.assign(window, { heterodina: { engine, queue, api } });

const media = new MediaSession({
  play: () => void engine.resume(),
  pause: () => void engine.pause(),
  next: () => void engine.skip(),
  previous: () => engine.seek(0),
  seekTo: (s) => engine.seek(s),
  seekBy: (d) => engine.seek(engine.position + d),
});

// --- volume (remembered per browser) ---

const VOLUME_KEY = 'heterodina.volume';
function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? v : 80;
  } catch {
    return 80;
  }
}
function applyVolume(v: number): void {
  const clamped = Math.min(Math.max(Math.round(v), 0), 100);
  ui.volume.value = String(clamped);
  engine.setVolume(clamped / 100);
  try {
    localStorage.setItem(VOLUME_KEY, String(clamped));
  } catch {
    // Storage unavailable; volume just won't persist.
  }
}
applyVolume(readVolume());
ui.volume.addEventListener('input', () => applyVolume(Number(ui.volume.value)));

// --- playback ---

/** Starts a new radio from `track`. */
function playNow(track: Track): void {
  if (!track.playable) return toast(t('unsupported', { codec: track.codec }));
  closeResults();
  radioToken++;
  station = { seed: track, context: null };
  ui.station.hidden = true;
  queue.clear();
  updateNext();
  void engine.play(track);
  void loadContext();
}

function show(track: Track): void {
  ui.empty.hidden = true;
  ui.now.hidden = false;
  ui.nowTitle.textContent = track.title;
  ui.nowTitle.title = track.title;
  ui.nowSub.textContent = [track.artist, track.album, track.year].filter(Boolean).join(' · ');
  ui.nowSub.title = ui.nowSub.textContent;
  crossfadeCover(track.art);
  renderStars(track);
  renderStation(track);
  void applyCoverTheme(track.art);
  document.title = `${track.title} · ${track.artist}`;
}

// --- cover-driven theme ---

const themes = new Map<string, Promise<Theme>>();

function themeFor(art: string): Promise<Theme> {
  let pending = themes.get(art);
  if (!pending) {
    pending = new Promise<Theme>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const size = 48;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(DEFAULT_THEME);
        ctx.drawImage(img, 0, 0, size, size);
        resolve(themeFromPixels(ctx.getImageData(0, 0, size, size).data));
      };
      img.onerror = () => resolve(DEFAULT_THEME);
      img.src = api.artUrl(art, 96);
    });
    themes.set(art, pending);
  }
  return pending;
}

let themeToken = 0;
async function applyCoverTheme(art: string | null): Promise<void> {
  const token = ++themeToken;
  const theme = art ? await themeFor(art) : DEFAULT_THEME;
  if (token !== themeToken) return;
  const root = document.documentElement.style;
  root.setProperty('--bg', theme.bg);
  root.setProperty('--bg-deep', theme.bgDeep);
  root.setProperty('--text', theme.text);
  root.setProperty('--muted', theme.muted);
  root.setProperty('--accent', theme.accent);
}

// --- rating (Plex stars: 2 points per star) ---

const STARS = 5;
const starButtons = Array.from({ length: STARS }, (_, i) => {
  const value = STARS - i; // laid out right-to-left, see CSS
  const b = Object.assign(document.createElement('button'), {
    className: 'star',
    type: 'button',
    textContent: '★',
    title: `${t(value === 1 ? 'star' : 'stars', { n: value })} (${value})`,
  });
  b.addEventListener('click', () => void rateStars(value));
  ui.stars.append(b);
  return { b, value };
});

function renderStars(track: Track | null): void {
  const stars = track?.rating ? Math.round(track.rating / 2) : 0;
  for (const { b, value } of starButtons) b.classList.toggle('on', value <= stars);
}

/** Sets `stars` (1-5); repeating the current value clears it. 0 clears. */
async function rateStars(stars: number): Promise<void> {
  const track = engine.track;
  if (!track) return;
  const before = track.rating;
  const next = stars === 0 || Math.round((before ?? 0) / 2) === stars ? null : stars * 2;
  track.rating = next;
  renderStars(track);
  try {
    await api.rate(track.id, next);
  } catch {
    track.rating = before;
    if (engine.track === track) renderStars(track);
    toast(t('ratingFailed'));
  }
}

/** Fades the new cover in over the current one, then drops the old layers. */
function crossfadeCover(art: string | null): void {
  const layers = [...ui.nowArt.querySelectorAll('img')];
  const top = layers.at(-1);
  const src = art ? api.artUrl(art, 1280) : null;
  if (top?.dataset.src === (src ?? '')) return;
  const img = document.createElement('img');
  img.alt = '';
  img.dataset.src = src ?? '';
  const reveal = (): void => {
    // Next frame, so the opacity change animates from 0.
    requestAnimationFrame(() => img.classList.add('shown'));
    img.addEventListener('transitionend', () => layers.forEach((l) => l.remove()), { once: true });
  };
  ui.nowArt.append(img);
  if (!src) return reveal();
  img.addEventListener('load', reveal, { once: true });
  img.addEventListener('error', reveal, { once: true });
  img.src = src;
}

ui.play.addEventListener('click', () => void engine.toggle());
ui.next.addEventListener('click', () => void engine.skip());

// Seek: the slider previews while dragging and commits on release.
let dragging = false;
ui.seek.addEventListener('input', () => {
  dragging = true;
  ui.pos.textContent = formatTime((Number(ui.seek.value) / 1000) * engine.duration);
});
ui.seek.addEventListener('change', () => {
  dragging = false;
  engine.seek((Number(ui.seek.value) / 1000) * engine.duration);
});

let lastMediaSync = 0;
function tick(now: number): void {
  if (!dragging && engine.track) {
    const d = engine.duration;
    const p = engine.position;
    ui.seek.value = String(d > 0 ? Math.round((p / d) * 1000) : 0);
    ui.pos.textContent = formatTime(p);
    ui.dur.textContent = formatTime(d);
    if (now - lastMediaSync > 1000) {
      lastMediaSync = now;
      media.position(p, d);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- radio: there is always a next track, picked ahead of time ---

/** Tracks kept queued ahead, so a transition never waits for a request. */
const AHEAD = 2;
const history: string[] = [];
let radioToken = 0;
let refilling = false;

async function refillRadio(): Promise<void> {
  if (refilling || !station) return;
  refilling = true;
  updateNext();
  const token = radioToken;
  const seed = station.seed.id;
  try {
    while (queue.entries.length < AHEAD && engine.track && token === radioToken) {
      const from = queue.entries.at(-1)?.track ?? engine.track;
      const recent = [...history, ...queue.entries.map((e) => e.track.id)].slice(-200);
      const pick = await api.radioNext(seed, from.id, recent, source);
      if (!pick || token !== radioToken) break;
      queue.add(pick.track);
    }
  } catch (err) {
    console.error(err);
    toast(t('radioFailed'));
  } finally {
    refilling = false;
    updateNext();
    // A new radio may have started while this one was fetching.
    if (token !== radioToken) void refillRadio();
  }
}

// --- the station's universe: shown under the stars, correctable ---

let station: { seed: Track; context: RadioContext | null } | null = null;

async function loadContext(retries = 10): Promise<void> {
  const current = station;
  if (!current) return;
  let context: RadioContext | null = null;
  try {
    context = await api.radioContext(current.seed.id);
  } catch (err) {
    console.error(err);
  }
  if (station !== current) return;
  // Null while the server is still indexing the library.
  if (!context) {
    if (retries > 0) window.setTimeout(() => void loadContext(retries - 1), 3000);
    return;
  }
  current.context = context;
  renderStation();
  if (ui.universe.open) renderUniverse();
}

/** The playing file's format, then what the station draws from. */
function renderStation(playing: Track | null = engine.track): void {
  const context = station?.context;
  if (!station || !context) return;
  const track = playing ?? station.seed;
  // The artist and album are already in the line above: don't repeat them.
  const shown = [track.artist, track.albumArtist, track.album].map((v) => v.toLocaleLowerCase()).filter(Boolean);
  const repeats = (label: string): boolean => {
    const l = label.toLocaleLowerCase();
    return shown.some((v) => v.includes(l) || l.includes(v));
  };
  const labels = context.labels.filter((l) => !repeats(l)).slice(0, 3);
  ui.station.textContent = [track.format, ...labels].join(' · ');
  ui.station.hidden = false;
}

ui.station.addEventListener('click', () => openUniverse());
ui.uClose.addEventListener('click', () => ui.universe.close());
ui.universe.addEventListener('click', (e) => {
  if (e.target === ui.universe) ui.universe.close(); // backdrop
});
ui.universe.addEventListener('close', () => {
  ui.uSearch.value = '';
  albumResults = [];
});

function openUniverse(): void {
  if (!station?.context) return;
  renderUniverse();
  ui.universe.showModal();
  ui.uList.scrollTop = 0;
}

function albumRow(album: RadioAlbum, action: { label: string; title: string; run: () => void }, faded = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = faded ? 'u-row faded' : 'u-row';
  const img = album.art
    ? Object.assign(document.createElement('img'), { src: api.artUrl(album.art, 80), alt: '', loading: 'lazy' })
    : Object.assign(document.createElement('div'), { className: 'ph' });
  // The action sits on the cover itself: + to add, × to remove, ↺ to restore.
  const art = document.createElement(action.label ? 'button' : 'div');
  art.className = 'u-art';
  art.append(img);
  if (art instanceof HTMLButtonElement) {
    art.type = 'button';
    art.title = action.title;
    art.setAttribute('aria-label', `${action.title}: ${album.title}`);
    art.append(Object.assign(document.createElement('span'), { className: 'u-badge', textContent: action.label }));
    art.addEventListener('click', action.run);
  }
  const text = document.createElement('div');
  text.style.minWidth = '0';
  text.append(
    Object.assign(document.createElement('div'), { className: 'r-title', textContent: album.title }),
    Object.assign(document.createElement('div'), { className: 'r-sub', textContent: album.artist }),
  );
  li.append(art, text);
  return li;
}

let albumResults: RadioAlbum[] = [];

function renderUniverse(): void {
  const context = station?.context;
  if (!context) return;
  ui.uTitle.textContent = context.labels.join(' · ') || (station?.seed.album ?? '');
  ui.uSub.textContent = t('universeCount', { albums: context.albums.length, tracks: context.trackCount });
  const inside = new Set(context.albums.map((a) => a.id));
  const rows: HTMLLIElement[] = [];
  const adds = albumResults.filter((a) => !inside.has(a.id));
  for (const a of adds) rows.push(albumRow(a, { label: '+', title: t('addToUniverse'), run: () => void correct(a.id, false) }));
  if (adds.length) rows.push(Object.assign(document.createElement('li'), { className: 'u-sep' }));
  for (const a of context.albums) {
    const seed = a.id === context.seedAlbumId;
    rows.push(
      albumRow(a, {
        label: seed ? '' : '×',
        title: seed ? '' : t('removeFromUniverse'),
        run: () => (seed ? undefined : void correct(a.id, true)),
      }),
    );
  }
  for (const a of context.excluded) {
    rows.push(albumRow(a, { label: '↺', title: t('restoreToUniverse'), run: () => void correct(a.id, false) }, true));
  }
  ui.uList.replaceChildren(...rows);
}

async function correct(albumId: string, excluded: boolean): Promise<void> {
  const context = station?.context;
  if (!context) return;
  try {
    await api.correctUniverse(context.seedAlbumId, albumId, excluded);
  } catch (err) {
    console.error(err);
    return toast(t('universeFailed'));
  }
  // Queued picks from a removed album go; the radio refills from the new universe.
  if (excluded) for (const e of queue.entries.filter((e) => e.track.albumId === albumId)) queue.remove(e.key);
  await loadContext(0);
  void refillRadio();
}

let albumTimer = 0;
let albumAbort: AbortController | null = null;
ui.uSearch.addEventListener('input', () => {
  window.clearTimeout(albumTimer);
  albumTimer = window.setTimeout(() => void searchAlbums(ui.uSearch.value), 180);
});

async function searchAlbums(q: string): Promise<void> {
  albumAbort?.abort();
  const abort = new AbortController();
  albumAbort = abort;
  let tracks: Track[] = [];
  if (q.trim()) {
    try {
      tracks = await api.search(q, null, abort.signal);
    } catch {
      return;
    }
  }
  const byId = new Map<string, RadioAlbum>();
  for (const t of tracks) byId.set(t.albumId, byId.get(t.albumId) ?? { id: t.albumId, title: t.album, artist: t.albumArtist, art: t.art });
  albumResults = [...byId.values()].slice(0, 8);
  renderUniverse();
}

/** Next is disabled with nothing queued, and spins while the radio is choosing. */
function updateNext(): void {
  const empty = queue.entries.length === 0;
  ui.next.disabled = empty;
  ui.next.classList.toggle('busy', empty && station !== null && (refilling || !engine.track));
}

queue.onChange(() => {
  updateNext();
  engine.queueChanged();
});

function cover(track: Track, size: number): HTMLElement {
  if (!track.art) return Object.assign(document.createElement('div'), { className: 'ph' });
  return Object.assign(document.createElement('img'), { src: api.artUrl(track.art, size), alt: '', loading: 'lazy' });
}

function trackText(track: Track): HTMLElement {
  const text = document.createElement('div');
  text.style.minWidth = '0';
  text.append(
    Object.assign(document.createElement('div'), { className: 'r-title', textContent: track.title }),
    Object.assign(document.createElement('div'), { className: 'r-sub', textContent: `${track.artist} — ${track.album}` }),
  );
  return text;
}

// --- source: the whole library or one Plex playlist, for search and radio ---

const SOURCE_KEY = 'heterodina.source';
let source: string | null = null;
try {
  source = localStorage.getItem(SOURCE_KEY) || null;
} catch {
  // Storage unavailable: start from the whole library.
}

async function loadPlaylists(): Promise<void> {
  try {
    const lists = await api.playlists();
    ui.source.append(
      ...lists.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.title })),
    );
  } catch (err) {
    console.error(err);
  }
  // A remembered playlist that no longer exists falls back to everything.
  if (source && ![...ui.source.options].some((o) => o.value === source)) source = null;
  ui.source.value = source ?? '';
  warmSource();
}

/** Big smart playlists take seconds to read from Plex the first time: start early. */
function warmSource(): void {
  if (source) void api.search('', source).catch(() => {});
}
ui.source.addEventListener('change', () => {
  source = ui.source.value || null;
  try {
    if (source) localStorage.setItem(SOURCE_KEY, source);
    else localStorage.removeItem(SOURCE_KEY);
  } catch {
    // Not remembered; still applies now.
  }
  ui.source.blur();
  warmSource();
  if (ui.search.value.trim()) void runSearch(ui.search.value);
  if (!engine.track) void loadSuggestions();
  // The station keeps going, now from the new source: re-pick what is queued.
  if (station && engine.track) {
    radioToken++;
    queue.clear();
    void refillRadio();
  }
});

// --- starting points, before anything plays ---

let suggestionsToken = 0;

async function loadSuggestions(retries = 10): Promise<void> {
  const token = ++suggestionsToken;
  let tracks: Track[];
  ui.startMore.disabled = true;
  try {
    tracks = await api.suggestions(source);
  } catch (err) {
    console.error(err);
    return;
  } finally {
    if (token === suggestionsToken) ui.startMore.disabled = false;
  }
  if (token !== suggestionsToken) return;
  // Empty while the server is still indexing the library.
  if (!tracks.length && retries > 0) {
    window.setTimeout(() => {
      if (token === suggestionsToken) void loadSuggestions(retries - 1);
    }, 3000);
    return;
  }
  ui.startList.replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement('li');
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'start-card' });
      button.title = `${t.title} — ${t.artist}`;
      const art = t.art
        ? Object.assign(document.createElement('img'), { src: api.artUrl(t.art, 300), alt: '', loading: 'lazy' })
        : Object.assign(document.createElement('div'), { className: 'ph' });
      button.append(
        art,
        Object.assign(document.createElement('span'), { className: 'start-title', textContent: t.title }),
        Object.assign(document.createElement('span'), { className: 'start-artist', textContent: t.artist }),
      );
      button.addEventListener('click', () => playNow(t));
      li.append(button);
      return li;
    }),
  );
}

ui.startMore.addEventListener('click', () => void loadSuggestions());
// After the playlist list settles, so a remembered playlist is the source.
void loadPlaylists().then(() => loadSuggestions());

// --- search ---

let results: Track[] = [];
let selected = -1;
let searchAbort: AbortController | null = null;
let searchTimer = 0;

ui.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(ui.search.value), 180);
});

async function runSearch(q: string): Promise<void> {
  searchAbort?.abort();
  if (!q.trim()) return closeResults();
  const abort = new AbortController();
  searchAbort = abort;
  try {
    results = await api.search(q, source, abort.signal);
  } catch {
    if (!abort.signal.aborted) toast(t('searchFailed'));
    return;
  }
  selected = results.findIndex((t) => t.playable);
  renderResults();
}

function renderResults(): void {
  ui.results.replaceChildren(
    ...results.map((t, i) => {
      const li = document.createElement('li');
      li.className = t.playable ? 'result' : 'result unplayable';
      li.setAttribute('aria-selected', String(i === selected));
      const dur = Object.assign(document.createElement('span'), {
        className: 'r-dur',
        textContent: formatTime(t.durationMs / 1000),
      });
      li.append(cover(t, 80), trackText(t), dur);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        playNow(t);
      });
      return li;
    }),
  );
  ui.results.hidden = results.length === 0;
}

function closeResults(): void {
  ui.results.hidden = true;
  ui.search.blur();
}

ui.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
    ui.results.children[selected]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const t = results[selected];
    if (t) playNow(t);
  } else if (e.key === 'Escape') {
    closeResults();
  }
});
ui.search.addEventListener('blur', () => window.setTimeout(() => (ui.results.hidden = true), 100));
ui.search.addEventListener('focus', () => (ui.results.hidden = results.length === 0));

// --- keyboard shortcuts (outside text inputs) ---

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'search') return;
  if (ui.universe.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      void engine.toggle();
      break;
    case '/':
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
      break;
    case 'n':
    case 'N':
      void engine.skip();
      break;
    case 'u':
    case 'U':
      openUniverse();
      break;
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
      void rateStars(Number(e.key));
      break;
    case 'ArrowRight':
      e.preventDefault();
      engine.seek(engine.position + 10);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      engine.seek(engine.position - 10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      applyVolume(Number(ui.volume.value) + 5);
      break;
    case 'ArrowDown':
      e.preventDefault();
      applyVolume(Number(ui.volume.value) - 5);
      break;
  }
});

// --- toast ---

let toastTimer = 0;
function toast(message: string): void {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), 3500);
}

// --- what the server is busy with: the first index, then tempo analysis ---

const STATUS_BUSY_MS = 4000;
const STATUS_IDLE_MS = 30000;
let wasIndexing = false;

async function pollStatus(): Promise<void> {
  let busy = false;
  try {
    const s = await api.status();
    // A few tracks queued is the radio's own look-ahead, not the library.
    const analysing = s.waiting > 20;
    busy = s.indexing || analysing;
    ui.busy.textContent = s.indexing ? t('indexing') : t('analysing', { left: s.waiting.toLocaleString() });
    ui.busy.hidden = !busy;
    if (wasIndexing && !s.indexing && !ui.startList.childElementCount) void loadSuggestions();
    wasIndexing = s.indexing;
  } catch {
    ui.busy.hidden = true;
  }
  window.setTimeout(() => void pollStatus(), busy ? STATUS_BUSY_MS : STATUS_IDLE_MS);
}
void pollStatus();
