import type { Track } from '../shared/types.ts';
import { searchKey } from './romaji.ts';

/** Anything that can read Japanese text out loud in romaji. */
export interface Reader {
  romaji(text: string): string;
}

interface Entry {
  track: Track;
  /** Comparable keys per field: the original text and its romaji reading. */
  title: string[];
  artist: string[];
  album: string[];
}

const WEIGHT = { title: 3, artist: 2, album: 1 } as const;

/**
 * In-memory search over the whole library. Every word of the query must
 * match some field, in its original script or in romaji.
 */
export class SearchIndex {
  readonly #reader: Reader;
  #entries: Entry[] = [];

  constructor(reader: Reader) {
    this.#reader = reader;
  }

  get size(): number {
    return this.#entries.length;
  }

  build(tracks: Track[]): void {
    this.#entries = tracks.map((track) => ({
      track,
      title: this.#keys(track.title),
      artist: [...new Set([...this.#keys(track.artist), ...this.#keys(track.albumArtist)])],
      album: this.#keys(track.album),
    }));
  }

  /** Best matches for `query`; `within` restricts the candidates (e.g. to a playlist). */
  search(query: string, limit = 40, within?: (track: Track) => boolean): Track[] {
    const words = query.split(/\s+/).map((w) => this.#keys(w)).filter((alts) => alts.length > 0);
    if (!words.length) return [];
    const whole = this.#keys(query.replace(/\s+/g, ''));

    const hits: { track: Track; score: number }[] = [];
    for (const e of this.#entries) {
      if (within && !within(e.track)) continue;
      let score = 0;
      let ok = true;
      for (const alts of words) {
        const has = (keys: string[]): boolean => keys.some((k) => alts.some((a) => k.includes(a)));
        const best = has(e.title) ? WEIGHT.title : has(e.artist) ? WEIGHT.artist : has(e.album) ? WEIGHT.album : 0;
        if (!best) {
          ok = false;
          break;
        }
        score += best;
      }
      if (!ok) continue;
      if (e.title.some((k) => whole.includes(k))) score += 10;
      else if (e.title.some((k) => whole.some((w) => k.startsWith(w)))) score += 4;
      hits.push({ track: e.track, score });
    }
    hits.sort((a, b) => b.score - a.score || a.track.title.length - b.track.title.length);
    return hits.slice(0, limit).map((h) => h.track);
  }

  #keys(text: string): string[] {
    const keys = new Set([searchKey(text), searchKey(this.#reader.romaji(text))]);
    keys.delete('');
    return [...keys];
  }
}
