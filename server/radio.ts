// The radio: picks the next track after `from` for a station started
// from `seed`. Mostly from the seed's universe, ordered by how close each
// track sounds to what just played (so the station drifts naturally),
// with variety rules and a little exploration outside the universe.

import type { RadioContext, RadioPick, Track } from '../shared/types.ts';
import type { Library } from './library.ts';
import { searchKey } from './romaji.ts';
import type { JsonStore } from './store.ts';
import type { TempoAnalyzer } from './tempo.ts';
import { titleKey, UniverseBuilder, type AlbumInfo, type Universe } from './universe.ts';

export interface Candidate {
  track: Track;
  /** Universe membership 0..1 (0 = outside). */
  weight: number;
  /** Plex sonic distance from the track that just played; undefined = not among its neighbours. */
  distance: number | undefined;
  /** How well its start follows the current track's end, 0..1 (undefined = unknown). */
  fit?: number;
}

export interface Overrides {
  exclude: string[];
  include: string[];
}

/** Chance of a deliberate step outside the universe. */
const EXPLORE = 0.12;
/** Below this many fresh in-universe candidates, explore more (the universe widens itself). */
const THIN_UNIVERSE = 12;
/** Sampling: among the best K, probability ∝ score^(1/T). */
const TOP_K = 14;
const TEMPERATURE = 0.8;
/** Candidates whose edges are measured before the draw (each costs a Plex request once). */
const SHORTLIST = 20;
/** A start this much quieter or louder than the end it follows still flows (dB). */
const EDGE_TOLERANCE = 2.5;
/** Longest a pick waits for tempo analysis of its shortlist (ms). */
const TEMPO_WAIT_MS = 4000;
/** Tempo factors: beats that can lock, not analysed yet, and clashing. */
const TEMPO_UNKNOWN = 0.85;
const TEMPO_CLASH = 0.6;
/** How many recent tracks block a song from repeating. */
const NO_REPEAT = 120;
/** How far back another arrangement of the same composition is held back. */
const COMPOSITION_MEMORY = 60;

/** Tracks rated one star or less never come up on the radio (Plex rating 0-10). */
const DISLIKED = 2;

/**
 * Preference for tracks the user rated 3 stars or more (Plex rating 0-10).
 * Unrated and 2-star tracks are neutral; 1-star tracks never play anyway.
 */
export function starBoost(rating: number | null): number {
  if (rating === null || rating < 6) return 1;
  return rating >= 10 ? 2 : rating >= 8 ? 1.6 : 1.3;
}

/** Same song in another copy (re-release, compilation) counts as a repeat. */
export function songKey(t: Track): string {
  return `${searchKey(t.title)}|${searchKey(t.artist)}`;
}

/** Score of each candidate given what played recently (newest last). Pure. */
export function score(c: Candidate, recent: Track[], nearestMax: number): number {
  // Unknown distance = farther than anything Plex listed as a neighbour.
  const d = c.distance ?? nearestMax + 0.1;
  const mood = Math.exp(-d / 0.12);
  let s = mood * (c.weight > 0 ? 0.3 + 0.7 * c.weight : 0.25) * starBoost(c.track.rating);

  const composition = titleKey(c.track.title);
  const last = recent.slice(-COMPOSITION_MEMORY);
  last.forEach((t, i) => {
    const age = last.length - i; // 1 = just played
    if (age <= 12) {
      if (t.albumId === c.track.albumId) s *= age <= 3 ? 0.3 : 0.75;
      if (t.albumArtist === c.track.albumArtist) s *= age <= 2 ? 0.55 : 0.92;
    }
    // Arrangement-heavy universes (OST, jazz, rock versions) would otherwise
    // keep serving the same composition: a noticeable repeat.
    if (composition.length >= 3 && titleKey(t.title) === composition) s *= age <= 25 ? 0.03 : 0.3;
  });
  return s;
}

function eligible(t: Track): boolean {
  return t.playable && (t.rating === null || t.rating > DISLIKED);
}

/** Fresh, eligible candidates, best first, with their scores. */
export function rank(cands: Candidate[], recent: Track[]): { c: Candidate; s: number }[] {
  const recentSongs = new Set(recent.slice(-NO_REPEAT).map(songKey));
  const fresh = cands.filter((c) => eligible(c.track) && !recentSongs.has(songKey(c.track)));
  const nearestMax = Math.max(0, ...fresh.map((c) => c.distance ?? 0));
  return fresh.map((c) => ({ c, s: score(c, recent, nearestMax) * (c.fit ?? 1) })).sort((a, b) => b.s - a.s);
}

/**
 * How well a track starting at `start` dB follows one ending at `end` dB
 * (both after normalization). A drop (loud ending, quiet start) is what
 * jars most; a lift is tolerated a little more.
 */
export function edgeFit(end: number, start: number): number {
  const diff = start - end;
  const miss = Math.max(0, (diff < 0 ? -diff : diff * 0.6) - EDGE_TOLERANCE);
  return Math.exp(-miss / 4);
}

/**
 * How well a start with beat period `start` (s) can lock onto an ending
 * with period `end`: same tempo, or double/half. Undefined = not analysed;
 * null = no steady beat there, which never clashes.
 */
export function tempoFit(end: number | null | undefined, start: number | null | undefined): number {
  if (end === undefined || start === undefined) return TEMPO_UNKNOWN;
  if (end === null || start === null) return 1;
  const slow = Math.max(end, start);
  const fast = Math.min(end, start);
  const k = Math.round(slow / fast);
  if (k < 1 || k > 2) return TEMPO_CLASH;
  const miss = Math.abs(slow - k * fast) / slow;
  return miss <= 0.01 ? 1 : miss <= 0.03 ? 0.85 : TEMPO_CLASH;
}

/** Weighted draw among the best candidates: good, but not always the most obvious. */
export function draw(cands: Candidate[], recent: Track[], random: () => number = Math.random): Candidate | null {
  const ranked = rank(cands, recent).slice(0, TOP_K);
  const weights = ranked.map((r) => r.s ** (1 / TEMPERATURE));
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ranked.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return ranked[i]?.c ?? null;
  }
  return ranked[0]?.c ?? null;
}

/** Starting points shown before anything plays. */
const SUGGESTIONS = 6;

/**
 * A few tracks to start a station from, as different from each other as
 * the library allows: no shared universe (`related`: the albums a pick's
 * station would play), album artist, label or genre when it can be helped.
 * Starred tracks come up more often. Pure, given `related` and `random`.
 */
export async function suggest(
  tracks: Track[],
  albums: ReadonlyMap<string, AlbumInfo>,
  related: (albumId: string) => ReadonlySet<string> | Promise<ReadonlySet<string>> = (id) => new Set([id]),
  count = SUGGESTIONS,
  random: () => number = Math.random,
): Promise<Track[]> {
  const pool = tracks.filter(eligible);
  const picks: Track[] = [];
  const genresOf = (t: Track): string[] => albums.get(t.albumId)?.genres ?? [];
  const labelOf = (t: Track): string | null => albums.get(t.albumId)?.label ?? null;
  // A random sample keeps this cheap on big libraries and varied between calls.
  const sample = Array.from({ length: Math.min(400, pool.length) }, () => pool[Math.floor(random() * pool.length)]!);
  const taken = new Set<string>();
  while (picks.length < count) {
    let best: Track | null = null;
    let bestScore = 0;
    for (const t of sample) {
      if (picks.some((p) => p.albumArtist === t.albumArtist || songKey(p) === songKey(t))) continue;
      let score = starBoost(t.rating) ** 2 * (0.5 + random());
      if (taken.has(t.albumId)) score *= 0.02;
      const genres = genresOf(t);
      for (const p of picks) {
        if (genres.some((g) => genresOf(p).includes(g))) score *= 0.15;
        const label = labelOf(t);
        if (label && label === labelOf(p)) score *= 0.1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) break;
    picks.push(best);
    for (const id of await related(best.albumId)) taken.add(id);
  }
  return picks;
}

export class Radio {
  readonly #library: Library;
  readonly #overrides: JsonStore<Overrides>;
  readonly #segment: (text: string) => string[];
  readonly #tempo: TempoAnalyzer | null;
  #builder: { albums: unknown; builder: UniverseBuilder } | null = null;
  readonly #universes = new Map<string, Universe>();
  /** Strong universe members per album, for keeping suggestions apart. */
  readonly #related = new Map<string, ReadonlySet<string>>();
  readonly #nextSuggestions = new Map<string, Promise<Track[]>>();
  readonly #nearest = new Map<string, Promise<Map<string, number>>>();

  constructor(
    library: Library,
    overrides: JsonStore<Overrides>,
    segment: (text: string) => string[],
    tempo: TempoAnalyzer | null = null,
  ) {
    this.#library = library;
    this.#tempo = tempo;
    this.#overrides = overrides;
    this.#segment = segment;
  }

  /**
   * Varied starting points, from `pool` (e.g. a playlist; `key` names it)
   * when given. The next set is prepared in the background, so asking for
   * others is instant.
   */
  async suggestions(pool?: ReadonlySet<string>, key = ''): Promise<Track[]> {
    const ready = this.#nextSuggestions.get(key);
    this.#nextSuggestions.delete(key);
    const result = await (ready ?? this.#suggest(pool));
    const next = this.#suggest(pool);
    next.catch(() => this.#nextSuggestions.delete(key));
    this.#nextSuggestions.set(key, next);
    return result;
  }

  async #suggest(pool?: ReadonlySet<string>): Promise<Track[]> {
    const tracks = pool ? [...pool].flatMap((id) => this.#library.cached(id) ?? []) : [...this.#library.all()];
    const albums = new Map(this.#library.albums().map((a) => [a.id, a]));
    const builder = this.#builderNow();
    const related = async (albumId: string): Promise<ReadonlySet<string>> => {
      let set = this.#related.get(albumId);
      if (!set) {
        // Building a universe takes a while: let requests (audio!) through first.
        await new Promise((r) => setImmediate(r));
        // Only strong members: a widened universe (whole label/genre) would rule out too much.
        set = new Set(builder.build(albumId).albums.filter((a) => a.weight >= 0.5).map((a) => a.album.id));
        this.#related.set(albumId, set);
      }
      return set;
    };
    return suggest(tracks, albums, related);
  }

  /** The inferred (and user-corrected) universe for a station seeded with `seedId`. */
  context(seedId: string): RadioContext | null {
    const u = this.#universe(seedId);
    if (!u) return null;
    const o = this.#overrides.get(u.seedAlbumId) ?? { exclude: [], include: [] };
    const builder = this.#builderNow();
    return {
      seedAlbumId: u.seedAlbumId,
      labels: u.labels,
      trackCount: u.albums.reduce((n, a) => n + a.album.tracks.length, 0),
      albums: u.albums.map((a) => ({
        id: a.album.id,
        title: a.album.title,
        artist: a.album.artist,
        art: a.album.tracks[0]?.art ?? null,
        weight: a.weight,
        reasons: a.reasons,
      })),
      excluded: o.exclude.flatMap((id) => {
        const album = builder.album(id);
        return album ? [{ id, title: album.title, artist: album.artist, art: album.tracks[0]?.art ?? null }] : [];
      }),
    };
  }

  /** Removes (`excluded` true) or restores/adds an album for this station's universe. */
  correct(seedAlbumId: string, albumId: string, excluded: boolean): void {
    const o = this.#overrides.get(seedAlbumId) ?? { exclude: [], include: [] };
    const without = (list: string[]): string[] => list.filter((id) => id !== albumId);
    // Restoring an album the user removed only undoes the removal; anything
    // else is a deliberate addition.
    const next = excluded
      ? { exclude: [...without(o.exclude), albumId], include: without(o.include) }
      : o.exclude.includes(albumId)
        ? { exclude: without(o.exclude), include: o.include }
        : { exclude: o.exclude, include: [...without(o.include), albumId] };
    this.#overrides.set(seedAlbumId, next);
    this.#universes.delete(seedAlbumId);
  }

  /** Next pick; `pool` (e.g. a playlist's track ids) limits what may play. */
  async next(seedId: string, fromId: string, recentIds: string[], pool?: ReadonlySet<string>): Promise<RadioPick | null> {
    const universe = this.#universe(seedId);
    const recent = recentIds.map((id) => this.#library.cached(id)).filter((t): t is Track => !!t);
    const from = this.#library.cached(fromId);
    if (from && recent.at(-1)?.id !== from.id) recent.push(from);

    const distances = await this.#distancesFrom(fromId);
    const inUniverse = new Map<string, number>();
    const allowed = (id: string): boolean => !pool || pool.has(id);
    for (const a of universe?.albums ?? []) for (const t of a.album.tracks) if (allowed(t.id)) inUniverse.set(t.id, a.weight);

    const inside: Candidate[] = [...inUniverse].flatMap(([id, weight]) => {
      const track = this.#library.cached(id);
      return track ? [{ track, weight, distance: distances.get(id) }] : [];
    });
    const outside: Candidate[] = [...distances].flatMap(([id, distance]) => {
      const track = inUniverse.has(id) || !allowed(id) ? undefined : this.#library.cached(id);
      return track ? [{ track, weight: 0, distance }] : [];
    });

    const recentSongs = new Set(recent.slice(-NO_REPEAT).map(songKey));
    const freshInside = inside.filter((c) => eligible(c.track) && !recentSongs.has(songKey(c.track))).length;
    const explore = Math.random() < (freshInside < THIN_UNIVERSE ? 0.5 : EXPLORE);

    const end = (await this.#library.edges(fromId).catch(() => null))?.end;
    const choose = async (cands: Candidate[]): Promise<Candidate | null> => {
      const short = rank(cands, recent).slice(0, SHORTLIST).map((r) => r.c);
      await this.#tempo?.ensure([fromId, ...short.map((c) => c.track.id)], TEMPO_WAIT_MS);
      const endTempo = this.#tempo?.get(fromId)?.end;
      await Promise.all(short.map((c) => this.#fit(c, end, endTempo)));
      return draw(short, recent);
    };
    const pick = (explore ? await choose(outside) : null) ?? (await choose(inside)) ?? (await choose(outside));
    if (pick) return { track: pick.track, explored: pick.weight === 0 };

    // Nothing near and nothing left in the universe: wander anywhere new.
    const anywhere = pool
      ? [...pool].flatMap((id) => this.#library.cached(id) ?? [])
      : [...this.#library.all()];
    const any = draw(
      Array.from({ length: Math.min(60, anywhere.length) }, () => ({
        track: anywhere[Math.floor(Math.random() * anywhere.length)]!,
        weight: 0,
        distance: undefined,
      })),
      recent,
    );
    return any ? { track: any.track, explored: true } : null;
  }

  /** Scores how smoothly `c` would follow an ending at `end` dB with beat period `endTempo`. */
  async #fit(c: Candidate, end: number | undefined, endTempo: number | null | undefined): Promise<void> {
    let fit = 1;
    if (end !== undefined) {
      const edges = await this.#library.edges(c.track.id).catch(() => null);
      if (edges) fit *= edgeFit(end, edges.start);
    }
    if (this.#tempo) fit *= tempoFit(endTempo, this.#tempo.get(c.track.id)?.start);
    c.fit = fit;
  }

  #universe(seedId: string): Universe | null {
    const seed = this.#library.cached(seedId);
    if (!seed) return null;
    let u = this.#universes.get(seed.albumId);
    if (!u) {
      const o = this.#overrides.get(seed.albumId);
      u = this.#builderNow().build(seed.albumId, o ?? {});
      this.#universes.set(seed.albumId, u);
      // Analyse the universe's tempos in the background, strongest albums first.
      this.#tempo?.want(u.albums.flatMap((a) => a.album.tracks.map((t) => t.id)));
    }
    return u;
  }

  /** Rebuilt whenever the library index is refreshed. */
  #builderNow(): UniverseBuilder {
    const albums = this.#library.albums();
    if (this.#builder?.albums !== albums) {
      this.#builder = { albums, builder: new UniverseBuilder(albums, this.#segment) };
      this.#universes.clear();
      this.#related.clear();
      this.#nextSuggestions.clear();
    }
    return this.#builder.builder;
  }

  /** Sonic distances from a track to its ~900 nearest neighbours (cached). */
  #distancesFrom(id: string): Promise<Map<string, number>> {
    let pending = this.#nearest.get(id);
    if (!pending) {
      pending = this.#library
        .nearest(id, 2000, 1)
        .then((list) => new Map(list.map((n) => [n.track.id, n.distance])))
        .catch(() => new Map<string, number>());
      this.#nearest.set(id, pending);
      if (this.#nearest.size > 300) this.#nearest.delete(this.#nearest.keys().next().value!);
    }
    return pending;
  }
}
