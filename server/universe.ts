// Infers a seed track's "universe": the albums that belong to the same
// world (same game/anime/franchise, same project, its arrangements),
// from what the library actually has. Plex tags here are thin (no styles,
// moods or collections), so the strongest evidence is structural: shared
// track titles (arrangements and covers), shared track artists, the
// album artist, the label and rare words in album titles.

import type { Track } from '../shared/types.ts';
import { searchKey } from './romaji.ts';

export interface AlbumInfo {
  id: string;
  title: string;
  artist: string;
  label: string | null;
  genres: string[];
  year: number | null;
  tracks: Track[];
}

/** Why an album is in the universe; shown to the user. */
export type Reason = 'seed' | 'titles' | 'performers' | 'artist' | 'label' | 'words' | 'genre';

export interface UniverseAlbum {
  album: AlbumInfo;
  /** 0..1, how firmly it belongs. */
  weight: number;
  reasons: Reason[];
}

export interface Universe {
  seedAlbumId: string;
  albums: UniverseAlbum[];
  /** Short human labels for what defines it, most important first. */
  labels: string[];
}

/** Album artists that say nothing about a universe. */
const GENERIC_ARTISTS = new Set(['various artists', 'various', 'va', 'unknown artist', '']);
const GENERIC_LABELS = new Set(['[no label]', 'no label', 'self-released', 'independent', '']);
/** Words in more album titles than this are too common to define anything. */
const MAX_WORD_DF = 20;
const STOPWORDS = new Set(
  'the of and for with from feat vol disc edition original soundtrack ost best live remaster remastered deluxe collection complete album single version mix remix instrumental music songs song'.split(' '),
);

/** Splits Japanese text into words; injected so tests need no dictionary. */
export type Segmenter = (text: string) => string[];
const BELONGS = 1;
/** Below this many tracks the universe is widened with weaker evidence. */
const MIN_TRACKS = 80;

interface AlbumFeatures {
  album: AlbumInfo;
  titles: Set<string>;
  performers: Set<string>;
  words: Set<string>;
}

export class UniverseBuilder {
  readonly #albums: AlbumFeatures[];
  readonly #byId: Map<string, AlbumFeatures>;
  readonly #wordDf = new Map<string, number>();
  readonly #labelDf = new Map<string, number>();
  readonly #artistDf = new Map<string, number>();
  readonly #titleDf = new Map<string, number>();

  readonly #segment: Segmenter;

  constructor(albums: AlbumInfo[], segment: Segmenter = () => []) {
    this.#segment = segment;
    this.#albums = albums.map((album) => ({
      album,
      titles: new Set(album.tracks.map((t) => titleKey(t.title)).filter((k) => k.length >= 4)),
      performers: new Set(
        album.tracks.map((t) => searchKey(t.artist)).filter((a) => a && !GENERIC_ARTISTS.has(a) && a !== searchKey(album.artist)),
      ),
      words: titleWords(album.title, segment),
    }));
    this.#byId = new Map(this.#albums.map((f) => [f.album.id, f]));
    for (const f of this.#albums) {
      for (const w of f.words) bump(this.#wordDf, w);
      for (const t of f.titles) bump(this.#titleDf, t);
      const label = labelKey(f.album.label);
      if (label) bump(this.#labelDf, label);
      bump(this.#artistDf, searchKey(f.album.artist));
    }
  }

  album(id: string): AlbumInfo | undefined {
    return this.#byId.get(id)?.album;
  }

  /**
   * `exclude`/`include` are album ids the user removed from / added to a
   * universe; they always win over inference.
   */
  build(seedAlbumId: string, overrides: { exclude?: Iterable<string>; include?: Iterable<string> } = {}): Universe {
    const seed = this.#byId.get(seedAlbumId);
    if (!seed) return { seedAlbumId, albums: [], labels: [] };
    const exclude = new Set(overrides.exclude);

    // Core: the seed album plus albums tied to it by strong evidence; then
    // one more hop from the core (e.g. other volumes of an arrangement series).
    const result = new Map<string, UniverseAlbum>([[seed.album.id, { album: seed.album, weight: 1, reasons: ['seed'] }]]);
    let frontier = [seed];
    for (let hop = 0; hop < 2 && frontier.length; hop++) {
      const next: AlbumFeatures[] = [];
      for (const f of this.#albums) {
        if (result.has(f.album.id) || exclude.has(f.album.id)) continue;
        // Compare with each new core album, and with the core as a whole so
        // evidence spread over several volumes adds up.
        let best: { score: number; reasons: Reason[] } = this.#relate(merge(seed, [...result.values()]), f);
        best = { score: best.score * 0.9, reasons: best.reasons };
        for (const core of frontier) {
          const s = this.#relate(core, f);
          const scaled = { score: s.score * (result.get(core.album.id)?.weight ?? 1), reasons: s.reasons };
          if (scaled.score > best.score) best = scaled;
        }
        if (best.score >= BELONGS) {
          const weight = Math.min(1, best.score / 3) * (hop === 0 ? 1 : 0.8);
          result.set(f.album.id, { album: f.album, weight, reasons: best.reasons });
          next.push(f);
        }
      }
      frontier = next;
    }

    // Small universe: widen to the seed's label (e.g. an idol agency or
    // a game publisher) and, if still small, to albums sharing its genres.
    const label = labelKey(seed.album.label);
    if (count(result) < MIN_TRACKS && label) {
      for (const f of this.#albums) {
        if (result.has(f.album.id) || exclude.has(f.album.id) || labelKey(f.album.label) !== label) continue;
        result.set(f.album.id, { album: f.album, weight: 0.3, reasons: ['label'] });
      }
    }
    if (count(result) < MIN_TRACKS && seed.album.genres.length) {
      const genres = new Set(seed.album.genres);
      for (const f of this.#albums) {
        if (result.has(f.album.id) || exclude.has(f.album.id)) continue;
        const shared = f.album.genres.filter((g) => genres.has(g)).length / genres.size;
        if (shared >= 0.5) result.set(f.album.id, { album: f.album, weight: 0.2 * shared, reasons: ['genre'] });
      }
    }

    for (const id of overrides.include ?? []) {
      const f = this.#byId.get(id);
      if (f && !result.has(id)) result.set(id, { album: f.album, weight: 1, reasons: [] });
    }

    const albums = [...result.values()].sort((a, b) => b.weight - a.weight);
    return { seedAlbumId, albums, labels: this.#describe(seed, albums) };
  }

  /** Evidence that `b` belongs with `a`, as a score (>= 1 means it does). */
  #relate(a: AlbumFeatures, b: AlbumFeatures): { score: number; reasons: Reason[] } {
    const reasons: Reason[] = [];
    let score = 0;

    // Shared track titles: arrangements and covers. Rare titles count more.
    let titles = 0;
    for (const t of b.titles) if (a.titles.has(t)) titles += 1 / Math.max(1, (this.#titleDf.get(t) ?? 1) - 1) ** 0.5;
    if (titles >= 1.6) {
      score += Math.min(3, titles * 0.9);
      reasons.push('titles');
    }

    // The same people performing (track artists other than the album artist).
    let performers = 0;
    for (const p of b.performers) if (a.performers.has(p) || p === searchKey(a.album.artist)) performers++;
    for (const p of a.performers) if (p === searchKey(b.album.artist)) performers++;
    if (performers) {
      score += Math.min(2, performers * 0.8);
      reasons.push('performers');
    }

    const artist = searchKey(a.album.artist);
    if (!GENERIC_ARTISTS.has(artist) && artist === searchKey(b.album.artist)) {
      // Same album artist is enough, except for very prolific ones (cover
      // channels, labels-as-artist) that span many universes.
      score += 1.2 * Math.min(1, Math.sqrt(40 / (this.#artistDf.get(artist) ?? 1)));
      reasons.push('artist');
    }

    const label = labelKey(a.album.label);
    if (label && label === labelKey(b.album.label)) {
      const df = this.#labelDf.get(label) ?? 1;
      // A label alone never decides; it adds to genre or other evidence.
      const sharesGenre = a.album.genres.some((g) => b.album.genres.includes(g));
      score += (sharesGenre || score > 0 ? 0.7 : 0.35) * Math.min(1, 6 / Math.log2(2 + df));
      reasons.push('label');
    }

    // Rare words shared by the album titles ("Final Fantasy", "幻想"): a
    // shared two-word phrase or Japanese word, or at least two rare words.
    let rare = 0;
    let phrase = false;
    for (const w of b.words) {
      if (!a.words.has(w) || (this.#wordDf.get(w) ?? 1) > MAX_WORD_DF) continue;
      rare++;
      if (w.includes(' ') || !/^[a-z0-9]+$/.test(w)) phrase = true;
    }
    if (phrase || rare >= 2) {
      score += phrase ? 0.9 : 0.6;
      reasons.push('words');
    }

    return { score, reasons };
  }

  #describe(seed: AlbumFeatures, albums: UniverseAlbum[]): string[] {
    const labels: string[] = [];
    const strong = albums.filter((a) => a.weight >= 0.5);
    // The rarest phrase from the seed's own title that other albums share.
    const strongWords = strong.filter((a) => a.album.id !== seed.album.id).map((a) => this.#byId.get(a.album.id)?.words);
    const shared = [...titleWords(seed.album.title, this.#segment, false)]
      .map((w) => {
        const key = w.includes(' ') ? w.split(' ').map(searchKey).join(' ') : /^[\p{Script=Latin}\p{N}]+$/u.test(w) ? searchKey(w) : w;
        return { w, n: strongWords.filter((s) => s?.has(key)).length, phrase: / /.test(w) || !/^[a-z0-9]+$/i.test(w) };
      })
      .filter((x) => x.n >= 1)
      .sort((x, y) => Number(y.phrase) - Number(x.phrase) || y.n - x.n);
    if (shared[0]) labels.push(titleCase(shared[0].w));
    const artists = new Map<string, number>();
    for (const a of strong) if (!GENERIC_ARTISTS.has(searchKey(a.album.artist))) bump(artists, a.album.artist);
    labels.push(...[...artists.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([a]) => a));
    if (seed.album.label && labelKey(seed.album.label) && strong.filter((a) => a.reasons.includes('label')).length >= 2) {
      labels.push(seed.album.label);
    }
    return [...new Set(labels)].slice(0, 5);
  }
}

/** The core so far as one pseudo-album: union of its titles, performers and words. */
function merge(seed: AlbumFeatures, core: UniverseAlbum[]): AlbumFeatures {
  const members = core.filter((a) => a.weight >= 0.6);
  return {
    album: seed.album,
    titles: new Set(members.flatMap((a) => a.album.tracks.map((t) => titleKey(t.title)).filter((k) => k.length >= 4))),
    performers: new Set(members.flatMap((a) => a.album.tracks.map((t) => searchKey(t.artist)).filter((p) => p && !GENERIC_ARTISTS.has(p)))),
    words: seed.words,
  };
}

function count(result: Map<string, UniverseAlbum>): number {
  let n = 0;
  for (const a of result.values()) n += a.album.tracks.length;
  return n;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function labelKey(label: string | null): string | null {
  const k = searchKey(label ?? '');
  return GENERIC_LABELS.has((label ?? '').trim().toLowerCase()) || !k ? null : k;
}

/** Track title without version suffixes, so "Main Theme (Jazz ver.)" matches "Main Theme". */
export function titleKey(title: string): string {
  return searchKey(
    title
      .replace(/\s*[([（【［].*?[)\]）】］]\s*/g, ' ')
      .replace(/\s+[-~～〜–—]\s*.*$/, '')
      .replace(/\b(ver(sion)?|remix|arrange|instrumental|inst|off vocal|live|cover|mix)\b.*$/i, ''),
  );
}

/**
 * Words of an album title: Latin words (minus stopwords) and adjacent
 * pairs of them, plus Japanese words. `keys` false keeps the original
 * spelling for display.
 */
export function titleWords(title: string, segment: Segmenter, keys = true): Set<string> {
  const out = new Set<string>();
  const latin = (title.match(/[\p{Script=Latin}\p{N}]{3,}/gu) ?? []).filter((w) => !/^\d+$/.test(w));
  latin.forEach((w, i) => {
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) return;
    out.add(keys ? searchKey(w) : w);
    const next = latin[i + 1];
    if (next && !STOPWORDS.has(next.toLowerCase())) out.add(keys ? `${searchKey(w)} ${searchKey(next)}` : `${w} ${next}`);
  });
  for (const w of segment(title)) out.add(w);
  return out;
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
