import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** A small JSON-file map, loaded once and written back (debounced) on change. */
export class JsonStore<T> {
  readonly #file: string | null;
  readonly #data: Map<string, T>;
  #timer: NodeJS.Timeout | null = null;
  #warned = false;

  /** `file` null keeps the store in memory only (tests). */
  constructor(file: string | null) {
    this.#file = file;
    this.#data = new Map(file ? Object.entries(readJson<Record<string, T>>(file) ?? {}) : []);
  }

  get size(): number {
    return this.#data.size;
  }

  get(key: string): T | undefined {
    return this.#data.get(key);
  }

  set(key: string, value: T): void {
    this.#data.set(key, value);
    this.#scheduleSave();
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#file) return;
    // A cache that can't be written (read-only or foreign-owned volume) must
    // not take the server down: keep working from memory and say why once.
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#data)));
      renameSync(tmp, this.#file);
      this.#warned = false;
    } catch (err) {
      if (this.#warned) return;
      this.#warned = true;
      const code = (err as NodeJS.ErrnoException).code ?? String(err);
      console.error(`[cache] cannot write ${resolve(this.#file)} (${code}); keeping it in memory. Make the cache folder writable by uid ${process.getuid?.() ?? '?'}.`);
    }
  }

  #scheduleSave(): void {
    if (!this.#file || this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), 2000);
    this.#timer.unref();
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
