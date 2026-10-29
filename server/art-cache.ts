// Resized covers kept on disk. Plex resizes on every request, which is slow
// on a small server; the art path carries a timestamp that changes with the
// image, so a cached file never goes stale.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Art {
  type: string;
  body: Buffer;
}

export class ArtCache {
  readonly #dir: string | null;
  /** Fetches in flight, so a burst of identical requests costs Plex one resize. */
  readonly #pending = new Map<string, Promise<Art | null>>();
  #warned = false;

  /** `dir` null keeps nothing (tests). */
  constructor(dir: string | null) {
    this.#dir = dir;
  }

  /** The cover from disk, or from `fetch` (then stored). Null when Plex has none. */
  get(path: string, size: number, fetch: () => Promise<Art | null>): Promise<Art | null> {
    const key = createHash('sha1').update(`${path}@${size}`).digest('hex');
    const cached = this.#read(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = fetch()
        .then((art) => {
          if (art) this.#write(key, art);
          return art;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return pending;
  }

  #file(key: string): string {
    return join(this.#dir!, key.slice(0, 2), key);
  }

  #read(key: string): Art | null {
    if (!this.#dir) return null;
    try {
      const body = readFileSync(this.#file(key));
      return { type: sniff(body), body };
    } catch {
      return null;
    }
  }

  #write(key: string, art: Art): void {
    if (!this.#dir) return;
    const file = this.#file(key);
    try {
      mkdirSync(join(this.#dir, key.slice(0, 2)), { recursive: true });
      writeFileSync(`${file}.tmp`, art.body);
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      if (this.#warned) return;
      this.#warned = true;
      console.error(`[art] cannot cache covers in ${this.#dir} (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
    }
  }
}

/** Plex returns JPEG or PNG. */
function sniff(body: Buffer): string {
  return body[0] === 0x89 && body[1] === 0x50 ? 'image/png' : 'image/jpeg';
}
