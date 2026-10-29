import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A small JSON-file map, loaded once and written back (debounced) on change. */
export class JsonStore<T> {
  readonly #file: string | null;
  readonly #data: Map<string, T>;
  #timer: NodeJS.Timeout | null = null;

  /** `file` null keeps the store in memory only (tests). */
  constructor(file: string | null) {
    this.#file = file;
    this.#data = new Map(file ? Object.entries(readJson<Record<string, T>>(file) ?? {}) : []);
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
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#data)));
    renameSync(tmp, this.#file);
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
