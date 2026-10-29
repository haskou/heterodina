// Tempo of the start and the end of tracks, so the radio can prefer
// hand-overs whose beats can lock. Plex stores no BPM, so a short window of
// each edge is transcoded by Plex to MP3 (works for every codec, and can
// start anywhere), decoded here and run through the same beat detector the
// player uses. Each track is analysed once, in the background, and cached.

import { randomUUID } from 'node:crypto';
import { MPEGDecoder } from 'mpg123-decoder';
import { beatGrid } from '../shared/beat.ts';
import type { Library } from './library.ts';
import type { PlexClient } from './plex.ts';
import type { JsonStore } from './store.ts';

/** Seconds per beat at each edge; null when there is no steady beat there. */
export interface TrackTempo {
  start: number | null;
  end: number | null;
}

/** Seconds analysed at each edge. */
const WINDOW_S = 20;
/** The end window stops this long before the sound does (outros thin out). */
const END_MARGIN_S = 3;
/** Plex transcodes are cheap but not free: a few at a time. */
const CONCURRENCY = 3;
/** A window that fails (Plex busy, connection dropped) is tried this many times. */
const ATTEMPTS = 2;
/**
 * Background work (whole universes, thousands of tracks) gets one worker
 * and a rest after each track, so decoding never starves the API: the
 * server stays responsive and a pick the radio is waiting for goes first.
 */
const BACKGROUND_WORKERS = 1;
const BACKGROUND_REST_MS = 1500;

export class TempoAnalyzer {
  readonly #plex: PlexClient;
  readonly #library: Library;
  readonly #store: JsonStore<TrackTempo>;
  /** Waiting ids, most urgent first. */
  #queue: string[] = [];
  readonly #pending = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Ids someone is waiting for (ensure). */
  readonly #urgent = new Set<string>();
  #background = 0;
  #resting = false;
  /**
   * Plex identities of idle workers. The transcoder only serves clients it
   * has made a decision for, and concurrent decisions under one identity
   * cut each other's streams, so each worker has its own.
   */
  readonly #idle: string[];

  constructor(plex: PlexClient, library: Library, store: JsonStore<TrackTempo>, client = 'heterodina-tempo') {
    this.#plex = plex;
    this.#library = library;
    this.#store = store;
    this.#idle = Array.from({ length: CONCURRENCY }, (_, i) => `${client}-${i + 1}`);
  }

  /** Cached tempo, or undefined when not analysed yet. */
  get(id: string): TrackTempo | undefined {
    return this.#store.get(id);
  }

  /** Queues tracks for analysis behind anything urgent. */
  want(ids: Iterable<string>): void {
    for (const id of ids) this.#enqueue(id, false);
    this.#pump();
  }

  /** Analyses these first and waits for them, but no longer than `timeoutMs`. */
  async ensure(ids: string[], timeoutMs: number): Promise<void> {
    const waits = ids.flatMap((id) => (this.#store.get(id) ? [] : [this.#enqueue(id, true)]));
    this.#pump();
    if (!waits.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(waits), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  #enqueue(id: string, urgent: boolean): Promise<void> {
    let entry = this.#pending.get(id);
    if (!entry) {
      let resolve = (): void => {};
      const promise = new Promise<void>((r) => (resolve = r));
      entry = { promise, resolve };
      this.#pending.set(id, entry);
      this.#queue.push(id);
    }
    if (urgent) {
      this.#urgent.add(id);
      this.#queue = [id, ...this.#queue.filter((q) => q !== id)];
    }
    return entry.promise;
  }

  #pump(): void {
    while (this.#idle.length && this.#queue.length) {
      const id = this.#queue[0]!;
      const urgent = this.#urgent.has(id);
      if (!urgent && (this.#background >= BACKGROUND_WORKERS || this.#resting)) return;
      this.#queue.shift();
      if (this.#store.get(id)) {
        this.#done(id);
        continue;
      }
      const client = this.#idle.pop()!;
      if (!urgent) this.#background++;
      this.#analyze(id, client)
        .catch((err: unknown) => console.error(`[tempo] ${id}: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          this.#idle.push(client);
          this.#done(id);
          if (urgent) return this.#pump();
          this.#background--;
          this.#resting = true;
          setTimeout(() => {
            this.#resting = false;
            this.#pump();
          }, BACKGROUND_REST_MS).unref();
          this.#pump();
        });
    }
  }

  #done(id: string): void {
    this.#urgent.delete(id);
    this.#pending.get(id)?.resolve();
    this.#pending.delete(id);
  }

  async #analyze(id: string, client: string): Promise<void> {
    const track = await this.#library.track(id);
    if (!track) return this.#store.set(id, { start: null, end: null });
    const duration = track.durationMs / 1000;
    const leadIn = track.transition?.leadIn ?? 0;
    const audioEnd = track.transition?.audioEnd ?? duration;
    const start = await this.#retry(() => this.#window(id, leadIn, client));
    const end = await this.#retry(() => this.#window(id, Math.max(leadIn, audioEnd - END_MARGIN_S - WINDOW_S), client));
    this.#store.set(id, { start, end });
  }

  async #retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        if (attempt >= ATTEMPTS) throw err;
      }
    }
  }

  /** Beat period of WINDOW_S seconds from `offset`, or null when there is no steady beat. */
  async #window(id: string, offset: number, client: string): Promise<number | null> {
    const identity = { 'X-Plex-Client-Identifier': client, 'X-Plex-Product': 'Heterodina', 'X-Plex-Platform': 'Chrome' };
    const params = {
      path: `/library/metadata/${id}`,
      protocol: 'http',
      directPlay: 0,
      directStream: 0,
      offset: Math.floor(offset),
      session: randomUUID(),
      ...identity,
    };
    const decision = await this.#plex.fetch('/music/:/transcode/universal/decision', params);
    await decision.body?.cancel();
    if (!decision.ok) throw new Error(`decision HTTP ${decision.status}`);

    const abort = new AbortController();
    const res = await this.#plex.fetch('/music/:/transcode/universal/start.mp3', params, {}, abort.signal);
    if (!res.ok || !res.body) {
      abort.abort();
      throw new Error(`transcode HTTP ${res.status}`);
    }
    // One decoder per window: windows are decoded concurrently.
    const decoder = new MPEGDecoder();
    await decoder.ready;
    const chunks: Float32Array[] = [];
    let samples = 0;
    let rate = 0;
    try {
      for await (const bytes of res.body) {
        const out = decoder.decode(bytes as Uint8Array);
        if (!out.samplesDecoded) continue;
        rate = out.sampleRate;
        // Mono: the beat detector wants one channel.
        const mono = new Float32Array(out.samplesDecoded);
        for (const ch of out.channelData) for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / out.channelData.length;
        chunks.push(mono);
        samples += mono.length;
        if (samples >= WINDOW_S * rate) break;
      }
    } finally {
      // We only needed the start of its output. Closing the connection does
      // not end a Plex transcode, so stop it explicitly.
      abort.abort();
      decoder.free();
      await this.#plex
        .fetch('/music/:/transcode/universal/stop', { session: params.session, ...identity })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
    if (!rate) return null;
    const all = new Float32Array(Math.min(samples, WINDOW_S * rate));
    let at = 0;
    for (const c of chunks) {
      all.set(c.subarray(0, all.length - at), at);
      at += c.length;
      if (at >= all.length) break;
    }
    return beatGrid(all, rate)?.period ?? null;
  }
}
