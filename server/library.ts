import type { Loudness, Playlist, Track, TransitionProfile } from '../shared/types.ts';
import { analyzeLevels, edgeLoudness, type Edges } from './analysis.ts';
import { PlexError, type MediaContainer, type PlexClient, type PlexMetadata, type PlexStream } from './plex.ts';
import type { SearchIndex } from './search-index.ts';
import type { AlbumInfo } from './universe.ts';
import type { JsonStore } from './store.ts';

/** Codecs Chromium-class browsers decode natively via decodeAudioData. */
const BROWSER_CODECS = new Set(['flac', 'mp3', 'aac', 'pcm', 'opus', 'vorbis']);

const CONTENT_TYPES: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

/** Playlist contents are re-read after this long (smart playlists change). */
const PLAYLIST_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_PAGE = 2000;

const ART_PATH = /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

export function isArtPath(path: string): boolean {
  return ART_PATH.test(path);
}

export function artUrl(path: string | undefined): string | null {
  return path && isArtPath(path) ? `/api/art?u=${encodeURIComponent(path)}` : null;
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function audioStream(meta: PlexMetadata): PlexStream | undefined {
  return meta.Media?.[0]?.Part?.[0]?.Stream?.find((s) => s.streamType === 2 || s.gain !== undefined);
}

function loudnessOf(meta: PlexMetadata): Loudness | null {
  const audio = audioStream(meta);
  const gainDb = num(audio?.gain);
  if (!audio || gainDb === null) return null;
  const peak = num(audio.peak) ?? 1;
  return {
    gainDb,
    albumGainDb: num(audio.albumGain) ?? gainDb,
    peak,
    albumPeak: num(audio.albumPeak) ?? peak,
  };
}

export function toTrack(meta: PlexMetadata): Track {
  const media = meta.Media?.[0];
  const codec = media?.audioCodec ?? media?.container ?? 'unknown';
  const albumArtist = meta.grandparentTitle ?? '';
  return {
    id: meta.ratingKey,
    title: meta.title,
    artist: meta.originalTitle || albumArtist,
    albumArtist,
    album: meta.parentTitle ?? '',
    albumId: meta.parentRatingKey ?? '',
    disc: meta.parentIndex ?? 1,
    index: meta.index ?? 0,
    durationMs: meta.duration ?? 0,
    year: meta.parentYear ?? null,
    art: artUrl(meta.parentThumb ?? meta.thumb),
    codec,
    rating: meta.userRating ?? null,
    playable: BROWSER_CODECS.has(codec),
    loudness: loudnessOf(meta),
    transition: null,
  };
}

export interface AudioSource {
  partKey: string;
  contentType: string;
}

/** Cached analysis, keyed by track id; `stream` detects replaced files. */
export interface StoredTransition {
  stream: string;
  profile: TransitionProfile | null;
  /** Edge loudness after loudness normalization (dB); null when unanalyzed. Absent in old caches. */
  edges?: Edges | null;
}

export class Library {
  readonly #plex: PlexClient;
  readonly #libraryName: string;
  readonly #transitions: JsonStore<StoredTransition>;
  #sectionId: Promise<string> | null = null;
  readonly #sources = new Map<string, AudioSource>();
  #index: SearchIndex | null = null;
  readonly #byId = new Map<string, Track>();
  readonly #playlists = new Map<string, { at: number; ids: Promise<ReadonlySet<string>>; refreshing: boolean }>();
  #albums: AlbumInfo[] = [];

  constructor(plex: PlexClient, libraryName: string, transitions: JsonStore<StoredTransition>) {
    this.#plex = plex;
    this.#libraryName = libraryName;
    this.#transitions = transitions;
  }

  sectionId(): Promise<string> {
    this.#sectionId ??= this.#resolveSection().catch((err: unknown) => {
      this.#sectionId = null;
      throw err;
    });
    return this.#sectionId;
  }

  async #resolveSection(): Promise<string> {
    const mc = await this.#plex.json('/library/sections');
    const wanted = fold(this.#libraryName);
    const dir = mc.Directory?.find((d) => d.type === 'artist' && fold(d.title) === wanted);
    if (!dir) throw new Error(`Music library "${this.#libraryName}" not found in Plex`);
    return dir.key;
  }

  /** Loads every track into `index` for romaji-aware local search. Returns the track count. */
  async buildIndex(index: SearchIndex): Promise<number> {
    const section = await this.sectionId();
    const [trackMetas, albumMetas] = await Promise.all([this.#listAll(section, 10), this.#listAll(section, 9)]);
    const tracks = trackMetas.map((m) => this.#remember(m));
    index.build(tracks);

    const byAlbum = new Map<string, Track[]>();
    for (const t of tracks) {
      const list = byAlbum.get(t.albumId);
      if (list) list.push(t);
      else byAlbum.set(t.albumId, [t]);
    }
    this.#albums = albumMetas
      .map((m) => ({
        id: m.ratingKey,
        title: m.title,
        artist: m.parentTitle ?? '',
        label: m.studio ?? null,
        genres: (m.Genre ?? []).map((g) => g.tag),
        year: m.year ?? null,
        tracks: (byAlbum.get(m.ratingKey) ?? []).sort((a, b) => a.disc - b.disc || a.index - b.index),
      }))
      .filter((a) => a.tracks.length > 0);

    this.#index = index;
    this.#byId.clear();
    for (const t of tracks) this.#byId.set(t.id, t);
    return tracks.length;
  }

  /** Audio playlists on the server (smart ones included; Plex evaluates them). */
  async playlists(): Promise<Playlist[]> {
    const mc = await this.#plex.json('/playlists', { playlistType: 'audio' });
    return (mc.Metadata ?? [])
      .filter((m) => m.playlistType === 'audio')
      .map((m) => ({ id: m.ratingKey, title: m.title, count: m.leafCount ?? 0 }));
  }

  /**
   * Track ids of a playlist. Cached for a while and refreshed in the
   * background, since smart playlists of thousands of tracks take seconds.
   */
  playlistTracks(id: string): Promise<ReadonlySet<string>> {
    const cached = this.#playlists.get(id);
    const fresh = cached && Date.now() - cached.at < PLAYLIST_TTL_MS;
    if (cached && !fresh && !cached.refreshing) {
      cached.refreshing = true;
      void this.#loadPlaylist(id).then(
        (ids) => this.#playlists.set(id, { at: Date.now(), ids: Promise.resolve(ids), refreshing: false }),
        () => (cached.refreshing = false),
      );
    }
    if (cached) return cached.ids;
    const ids = this.#loadPlaylist(id);
    this.#playlists.set(id, { at: Date.now(), ids, refreshing: false });
    ids.catch(() => this.#playlists.delete(id));
    return ids;
  }

  async #loadPlaylist(id: string): Promise<ReadonlySet<string>> {
    // One big request is very slow on Plex (minutes for 17k items); pages are not.
    const page = (start: number) =>
      this.#plex.json(`/playlists/${id}/items`, {
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PLAYLIST_PAGE,
      });
    const first = await page(0);
    const total = first.totalSize ?? first.size ?? 0;
    const ids = new Set<string>();
    const add = (mc: MediaContainer): void => {
      for (const m of mc.Metadata ?? []) if (m.type === 'track') ids.add(m.ratingKey);
    };
    add(first);
    const starts: number[] = [];
    for (let s = PLAYLIST_PAGE; s < total; s += PLAYLIST_PAGE) starts.push(s);
    for (let i = 0; i < starts.length; i += 4) (await Promise.all(starts.slice(i, i + 4).map(page))).forEach(add);
    return ids;
  }

  /** Albums with their tracks (empty until the index is built). */
  albums(): AlbumInfo[] {
    return this.#albums;
  }

  async #listAll(section: string, type: number): Promise<PlexMetadata[]> {
    const out: PlexMetadata[] = [];
    for (let start = 0; ; ) {
      const mc = await this.#plex.json(`/library/sections/${section}/all`, {
        type,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': 2000,
      });
      const page = mc.Metadata ?? [];
      out.push(...page);
      start += page.length;
      if (!page.length || start >= (mc.totalSize ?? 0)) return out;
    }
  }

  /** A track from the index, without hitting Plex (no loudness/transition). */
  cached(id: string): Track | undefined {
    return this.#byId.get(id);
  }

  /** Every indexed track (empty until the index is built). */
  all(): Iterable<Track> {
    return this.#byId.values();
  }

  /** Plex's sonically nearest tracks, closest first. */
  async nearest(id: string, limit = 60, maxDistance = 0.35): Promise<{ track: Track; distance: number }[]> {
    const mc = await this.#plex.json(`/library/metadata/${id}/nearest`, { limit, maxDistance });
    return (mc.Metadata ?? [])
      .filter((m) => m.type === 'track')
      .map((m) => ({ track: this.#remember(m), distance: m.distance ?? maxDistance }));
  }

  /** Search, optionally only among `within` (track ids, e.g. a playlist). */
  async search(query: string, limit = 40, within?: ReadonlySet<string>): Promise<Track[]> {
    const q = query.trim();
    if (!q) return [];
    const inside = within && ((t: Track): boolean => within.has(t.id));
    if (this.#index?.size) return this.#index.search(q, limit, inside);
    const section = await this.sectionId();
    const mc = await this.#plex.json(`/library/sections/${section}/search`, { type: 10, query: q, limit: 200 });
    const tracks = (mc.Metadata ?? []).map((m) => this.#remember(m));
    return rankSearch(inside ? tracks.filter(inside) : tracks, q).slice(0, limit);
  }

  /** Full track, including loudness and the (cached) transition profile. */
  async track(id: string): Promise<Track | null> {
    const meta = await this.#metadata(id);
    if (!meta) return null;
    const track = this.#remember(meta);
    track.transition = await this.#transition(meta, track.durationMs / 1000);
    return track;
  }

  async #transition(meta: PlexMetadata, duration: number): Promise<TransitionProfile | null> {
    const streamId = audioStream(meta)?.id;
    if (streamId === undefined || duration <= 0) return null;
    const stream = String(streamId);
    const cached = this.#transitions.get(meta.ratingKey);
    if (cached?.stream === stream && cached.edges !== undefined) return cached.profile;
    let levels: number[];
    try {
      const mc = await this.#plex.json(`/library/streams/${stream}/levels`);
      levels = (mc.Level ?? []).map((l) => l.v);
    } catch (err) {
      // 404 = Plex has not analyzed this track; remember that too.
      if (!(err instanceof PlexError && err.status === 404)) throw err;
      levels = [];
    }
    const rate = levels.length / duration;
    const profile = levels.length ? analyzeLevels(levels, rate, duration) : null;
    const raw = profile && edgeLoudness(levels, rate, profile);
    // Compared across tracks, so as they will sound: after normalization.
    const gain = loudnessOf(meta)?.gainDb ?? 0;
    const edges = raw && { start: raw.start + gain, end: raw.end + gain };
    this.#transitions.set(meta.ratingKey, { stream, profile, edges });
    return profile;
  }

  /** Normalized edge loudness of a track (analyzed once, then cached); null when unknown. */
  async edges(id: string): Promise<Edges | null> {
    const cached = this.#transitions.get(id);
    if (cached?.edges !== undefined) return cached.edges;
    await this.track(id);
    return this.#transitions.get(id)?.edges ?? null;
  }

  /** Sets (0-10) or clears (null) the Plex user rating. */
  async rate(id: string, rating: number | null): Promise<void> {
    await this.#plex.put('/:/rate', { key: id, identifier: 'com.plexapp.plugins.library', rating: rating ?? -1 });
    const known = this.#byId.get(id);
    if (known) known.rating = rating;
  }

  async audioSource(id: string): Promise<AudioSource | null> {
    const known = this.#sources.get(id);
    if (known) return known;
    const meta = await this.#metadata(id);
    if (!meta) return null;
    this.#remember(meta);
    return this.#sources.get(id) ?? null;
  }

  async #metadata(id: string): Promise<PlexMetadata | null> {
    const mc = await this.#plex.json(`/library/metadata/${id}`);
    const meta = mc.Metadata?.[0];
    return meta?.type === 'track' ? meta : null;
  }

  #remember(meta: PlexMetadata): Track {
    const part = meta.Media?.[0]?.Part?.[0];
    if (part?.key) {
      const container = part.container ?? meta.Media?.[0]?.container ?? '';
      this.#sources.set(meta.ratingKey, {
        partKey: part.key,
        contentType: CONTENT_TYPES[container] ?? 'application/octet-stream',
      });
    }
    return toTrack(meta);
  }
}

/** Exact title matches first, then prefix matches, keeping Plex order otherwise. */
export function rankSearch(tracks: Track[], query: string): Track[] {
  const q = fold(query);
  const score = (t: Track): number => {
    const title = fold(t.title);
    if (title === q) return 0;
    if (title.startsWith(q)) return 1;
    return 2;
  };
  return tracks
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.t);
}
