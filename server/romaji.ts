// Romaji readings for Japanese text, so a search for "tokyo" finds
// 東京. Kanji readings come from kuromoji's dictionary
// (pronunciation, so は reads "wa"); kana are converted by wanakana.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import kuromoji from 'kuromoji';
import { toRomaji } from 'wanakana';

const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

export class Romanizer {
  readonly #tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures>;
  readonly #cache = new Map<string, string>();

  private constructor(tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures>) {
    this.#tokenizer = tokenizer;
  }

  static create(): Promise<Romanizer> {
    const dicPath = join(dirname(createRequire(import.meta.url).resolve('kuromoji/package.json')), 'dict');
    return new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => (err ? reject(err) : resolve(new Romanizer(tokenizer))));
    });
  }

  /** Japanese nouns of 2+ characters in `text` (e.g. 東方, コンプレックス). */
  words(text: string): string[] {
    if (!JAPANESE.test(text)) return [];
    return this.#tokenizer
      .tokenize(text)
      .filter((t) => t.pos === '名詞' && [...t.surface_form].length >= 2 && JAPANESE.test(t.surface_form))
      .map((t) => t.surface_form);
  }

  /** Romaji reading of `text`; text without Japanese comes back unchanged. */
  romaji(text: string): string {
    if (!JAPANESE.test(text)) return text;
    let out = this.#cache.get(text);
    if (out === undefined) {
      const reading = this.#tokenizer
        .tokenize(text)
        .map((t) => (t.pronunciation && t.pronunciation !== '*' ? t.pronunciation : t.surface_form))
        .join('');
      out = toRomaji(reading);
      this.#cache.set(text, out);
    }
    return out;
  }
}

/**
 * Comparable form of a string: lowercase, no accents, no punctuation or
 * spaces, and romanization variants folded together (long vowels,
 * "tch"/"cch", "m"/"n" before b/p), so "Tōkyō", "toukyou" and "tookyoo"
 * all become "tokyo". Japanese characters are kept as they are.
 */
export function searchKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/ou/g, 'o')
    .replace(/([aeiou])\1+/g, '$1')
    .replace(/ei/g, 'e')
    .replace(/tch/g, 'cch')
    .replace(/m(?=[bp])/g, 'n');
}
