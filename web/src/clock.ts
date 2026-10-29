// Callbacks keyed to AudioContext time rather than wall time. While the
// context is suspended (paused) nothing fires; on resume everything is
// re-armed against the frozen-then-resumed audio clock.

interface Entry {
  when: number;
  fn: () => void;
  handle: number;
}

export class ClockTimers {
  readonly #ctx: BaseAudioContext;
  readonly #entries = new Set<Entry>();
  #paused = false;

  constructor(ctx: BaseAudioContext) {
    this.#ctx = ctx;
  }

  /** Runs `fn` once the audio clock reaches `when`. Returns a cancel function. */
  at(when: number, fn: () => void): () => void {
    const entry: Entry = { when, fn, handle: 0 };
    this.#entries.add(entry);
    if (!this.#paused) this.#arm(entry);
    return () => {
      window.clearTimeout(entry.handle);
      this.#entries.delete(entry);
    };
  }

  pause(): void {
    this.#paused = true;
    for (const e of this.#entries) window.clearTimeout(e.handle);
  }

  resume(): void {
    this.#paused = false;
    for (const e of this.#entries) this.#arm(e);
  }

  #arm(entry: Entry): void {
    window.clearTimeout(entry.handle);
    const delay = Math.max(0, (entry.when - this.#ctx.currentTime) * 1000);
    entry.handle = window.setTimeout(() => {
      if (!this.#entries.has(entry) || this.#paused) return;
      // Timers can fire early relative to the audio clock; wait it out.
      if (this.#ctx.currentTime < entry.when - 0.005) return this.#arm(entry);
      this.#entries.delete(entry);
      entry.fn();
    }, delay);
  }
}
