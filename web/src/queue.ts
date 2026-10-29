import type { Track } from '../../shared/types.ts';
import type { QueueSource } from './engine.ts';

/** Upcoming tracks. Each entry gets its own key so the same track can be queued twice. */
export interface QueueEntry {
  key: number;
  track: Track;
}

export class Queue implements QueueSource {
  #entries: QueueEntry[] = [];
  #nextKey = 1;
  readonly #listeners = new Set<() => void>();

  get entries(): readonly QueueEntry[] {
    return this.#entries;
  }

  onChange(fn: () => void): void {
    this.#listeners.add(fn);
  }

  add(track: Track): void {
    this.#entries.push({ key: this.#nextKey++, track });
    this.#emit();
  }

  remove(key: number): void {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.key !== key);
    if (this.#entries.length !== before) this.#emit();
  }

  clear(): void {
    if (!this.#entries.length) return;
    this.#entries = [];
    this.#emit();
  }

  peek(n = 0): Track | null {
    return this.#entries[n]?.track ?? null;
  }

  advance(track: Track): void {
    if (this.#entries[0]?.track.id === track.id) {
      this.#entries.shift();
      this.#emit();
    }
  }

  discard(track: Track): void {
    const i = this.#entries.findIndex((e) => e.track.id === track.id);
    if (i < 0) return;
    this.#entries.splice(i, 1);
    this.#emit();
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
}
