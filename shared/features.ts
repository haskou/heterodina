// What a stretch of music sounds like, beat by beat: timbre, harmony and
// loudness per beat, which beat starts the bar, the key, and where
// sections change and drops hit. The transition chooser compares these to
// find where two tracks can meet. Pure: works on mono samples.

import type { BeatGrid } from './beat.ts';

export interface Key {
  /** Root pitch class, 0 = C. */
  root: number;
  minor: boolean;
}

export interface BeatFeatures {
  /** Track time of each beat analysed. */
  times: number[];
  /** Per beat: spectral shape in 12 log-spaced bands, normalized. */
  timbre: Float64Array[];
  /** Per beat: pitch-class profile, summing to 1. */
  chroma: Float64Array[];
  /** Per beat: loudness, 0..1 against this region's loud beats. */
  loud: number[];
  /** Index (0..3) of the first beat that starts a bar. */
  downbeat: number;
  key: Key;
  /** Beat indices where a new section starts (always on a downbeat). */
  sections: Set<number>;
  /** Section starts where the bass comes in much harder. */
  drops: Set<number>;
}

/** Analysis rate: harmony and timbre need nothing above ~5 kHz. */
const RATE = 11025;
const FFT = 2048;
const HOP = 512;
/** Krumhansl-Kessler key profiles. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
/** Beats compared on each side of a candidate section boundary. */
const SECTION_SPAN = 8;

/** Features of `samples` (mono, `rate` Hz, first sample at track time `t0`) on the beats of `grid`. */
export function beatFeatures(samples: Float32Array, rate: number, t0: number, grid: BeatGrid): BeatFeatures {
  const x = resample(samples, rate);
  const frames = Math.max(0, Math.floor((x.length - FFT) / HOP) + 1);
  const bins = FFT / 2;
  const window = new Float64Array(FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  // Bin -> pitch class (55 Hz..1.76 kHz) and bin -> timbre band (log spaced from 40 Hz).
  const pitch = new Int8Array(bins).fill(-1);
  const band = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const hz = (k * RATE) / FFT;
    if (hz >= 55 && hz < 1760) pitch[k] = (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;
    if (hz >= 40) band[k] = Math.min(11, Math.floor(12 * (Math.log(hz / 40) / Math.log(RATE / 2 / 40))));
  }
  const lowBin = Math.ceil((150 * FFT) / RATE);

  const end = t0 + samples.length / rate;
  const times: number[] = [];
  for (let t = grid.phase + Math.ceil((t0 - grid.phase) / grid.period) * grid.period; t + grid.period <= end; t += grid.period) times.push(t);
  const n = times.length;
  const timbre = times.map(() => new Float64Array(12));
  const chroma = times.map(() => new Float64Array(12));
  const energy = new Float64Array(n);
  const low = new Float64Array(n);
  const counts = new Float64Array(n);
  const total = new Float64Array(12);

  for (let f = 0; f < frames; f++) {
    const centre = t0 + (f * HOP + FFT / 2) / RATE;
    const b = Math.floor((centre - (times[0] ?? 0)) / grid.period);
    for (let i = 0; i < FFT; i++) {
      re[i] = (x[f * HOP + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    if (b < 0 || b >= n) continue;
    counts[b] = (counts[b] ?? 0) + 1;
    for (let k = 1; k < bins; k++) {
      const power = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
      const m = Math.log1p(Math.sqrt(power));
      const p = pitch[k] ?? -1;
      if (p >= 0) {
        chroma[b]![p] = (chroma[b]![p] ?? 0) + m;
        total[p] = (total[p] ?? 0) + m;
      }
      const t = band[k] ?? -1;
      if (t >= 0) timbre[b]![t] = (timbre[b]![t] ?? 0) + power;
      energy[b] = (energy[b] ?? 0) + power;
      if (k < lowBin) low[b] = (low[b] ?? 0) + power;
    }
  }
  for (let b = 0; b < n; b++) {
    const c = counts[b] || 1;
    const t = timbre[b]!;
    for (let k = 0; k < 12; k++) t[k] = Math.log1p((t[k] ?? 0) / c);
    normalize(t);
    normalize(chroma[b]!, true);
    energy[b] = Math.log1p((energy[b] ?? 0) / c);
    low[b] = (low[b] ?? 0) / c;
  }
  const loudTop = [...energy].sort((p, q) => p - q)[Math.floor(n * 0.95)] || 1;
  const loud = [...energy].map((e) => Math.min(1, e / loudTop));

  // The bar starts where the sound changes most from the beat before, and
  // most of all where it gets louder (the accent, the kick on one).
  const change = [0, 0, 0, 0];
  for (let b = 1; b < n; b++) {
    change[b % 4] = (change[b % 4] ?? 0) + 0.5 * distance(timbre[b]!, timbre[b - 1]!) + 2 * Math.max(0, (loud[b] ?? 0) - (loud[b - 1] ?? 0));
  }
  const downbeat = change.indexOf(Math.max(...change));

  // Sections: downbeats where the 8 beats before and after differ most.
  const novelty = new Float64Array(n);
  for (let c = SECTION_SPAN; c + SECTION_SPAN <= n; c++) {
    let s = 0;
    for (let d = 0; d < 12; d++) {
      let l = 0;
      let r = 0;
      for (let k = 0; k < SECTION_SPAN; k++) {
        l += (timbre[c - SECTION_SPAN + k]![d] ?? 0) + 4 * (chroma[c - SECTION_SPAN + k]![d] ?? 0);
        r += (timbre[c + k]![d] ?? 0) + 4 * (chroma[c + k]![d] ?? 0);
      }
      s += ((l - r) / SECTION_SPAN) ** 2;
    }
    let l = 0;
    let r = 0;
    for (let k = 0; k < SECTION_SPAN; k++) {
      l += loud[c - SECTION_SPAN + k] ?? 0;
      r += loud[c + k] ?? 0;
    }
    novelty[c] = Math.sqrt(s + ((3 * (l - r)) / SECTION_SPAN) ** 2);
  }
  const mean = novelty.reduce((p, q) => p + q, 0) / Math.max(n, 1);
  const sd = Math.sqrt(novelty.reduce((p, q) => p + (q - mean) ** 2, 0) / Math.max(n, 1));
  const sections = new Set<number>();
  const drops = new Set<number>();
  // Analysis frames smear a change over neighbouring beats: a bar line
  // takes the strongest novelty within a beat of it, and must beat the bar
  // lines on either side.
  const atBar = (c: number): number => Math.max(novelty[c - 1] ?? 0, novelty[c] ?? 0, novelty[c + 1] ?? 0);
  for (let c = SECTION_SPAN; c + SECTION_SPAN <= n; c++) {
    if ((((c - downbeat) % 4) + 4) % 4) continue;
    const here = atBar(c);
    if (here < atBar(c - 4) || here < atBar(c + 4) || here < mean + 0.5 * sd) continue;
    sections.add(c);
    let before = 0;
    let after = 0;
    for (let k = 0; k < SECTION_SPAN; k++) {
      before += low[c - SECTION_SPAN + k] ?? 0;
      after += low[c + k] ?? 0;
    }
    if (after > 1.6 * before && after > 0) drops.add(c);
  }

  return { times, timbre, chroma, loud, downbeat, key: findKey(total), sections, drops };
}

/** Key whose profile correlates best with the pitch-class totals. */
export function findKey(totals: ArrayLike<number>): Key {
  let best: Key = { root: 0, minor: false };
  let score = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR : MAJOR;
      const rotated = profile.map((_, i) => profile[(i - root + 12) % 12] ?? 0);
      const c = correlation(Array.from(totals), rotated);
      if (c > score) {
        score = c;
        best = { root, minor };
      }
    }
  }
  return best;
}

/**
 * How well two keys mix, 0..1: the same or relative key scores 1, each
 * semitone between (relative-major) roots costs 0.4, a mode change ×0.9,
 * and Camelot-wheel neighbours (a fifth apart, or relative) at least 0.9.
 */
export function keyFit(a: Key, b: Key): number {
  const major = (k: Key): number => (k.minor ? (k.root + 3) % 12 : k.root);
  let semis = Math.abs(major(a) - major(b));
  semis = Math.min(semis, 12 - semis);
  let fit = Math.min(Math.max(1 - 0.4 * semis, 0), 1) * (a.minor !== b.minor ? 0.9 : 1);
  const camelot = (k: Key): number => (major(k) * 7) % 12;
  let step = Math.abs(camelot(a) - camelot(b));
  step = Math.min(step, 12 - step);
  if ((a.minor === b.minor && step <= 1) || step === 0) fit = Math.max(fit, 0.9);
  return fit;
}

export function distance(p: ArrayLike<number>, q: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < p.length; k++) s += ((p[k] ?? 0) - (q[k] ?? 0)) ** 2;
  return Math.sqrt(s);
}

export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let c = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    c += x * y;
    da += x * x;
    db += y * y;
  }
  return c / Math.sqrt(da * db + 1e-12);
}

/** Scales to sum 1 (`sum`) or to unit length. */
function normalize(v: Float64Array, sum = false): void {
  let s = 0;
  for (const x of v) s += sum ? x : x * x;
  s = sum ? s : Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / s;
}

/** Box-filtered decimation to about RATE Hz (features don't need more). */
function resample(samples: Float32Array, rate: number): Float32Array {
  const step = rate / RATE;
  const out = new Float32Array(Math.floor(samples.length / step));
  const width = Math.max(1, Math.floor(step));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * step);
    let s = 0;
    for (let j = 0; j < width; j++) s += samples[a + j] ?? 0;
    out[i] = s / width;
  }
  return out;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = (re[b] ?? 0) * cr - (im[b] ?? 0) * ci;
        const ti = (re[b] ?? 0) * ci + (im[b] ?? 0) * cr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}
