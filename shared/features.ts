// What a stretch of music sounds like, beat by beat: timbre, harmony,
// loudness, bass, notes, vocal or lead activity and band energy per beat,
// which beat starts the bar, the key, and where sections change and drops
// hit. The transition chooser compares these to
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
  /** Per beat: bass (below 150 Hz) against this region's busy beats (about 1 where the bass line plays). */
  bass: number[];
  /** Per beat: energy in clear notes (spectral peaks), against this region's busy beats, up to 1.5. */
  tonal: number[];
  /** Per beat: vocal or lead activity, 0..1 (see voiceActivity). */
  voice: number[];
  /** Per beat: raw low, mid and high energy, comparable across tracks analysed at the same gain. */
  bands: [number[], number[], number[]];
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
  const bin = (hz: number): number => Math.round((hz * FFT) / RATE);
  const lowBin = Math.ceil((150 * FFT) / RATE);
  const [noteLo, noteHi] = [bin(55), bin(1760)];
  const [voiceLo, voiceHi] = [bin(200), bin(3000)];
  const [bandMid, bandHigh] = [bin(250), bin(2500)];

  const end = t0 + samples.length / rate;
  const times: number[] = [];
  for (let t = grid.phase + Math.ceil((t0 - grid.phase) / grid.period) * grid.period; t + grid.period <= end; t += grid.period) times.push(t);
  const n = times.length;
  const timbre = times.map(() => new Float64Array(12));
  const chroma = times.map(() => new Float64Array(12));
  const energy = new Float64Array(n);
  const low = new Float64Array(n);
  const notes = new Float64Array(n);
  const bandE = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
  const counts = new Float64Array(n);
  const total = new Float64Array(12);
  const mag = new Float64Array(bins);
  // Per frame: its beat, and the pitch (cents) and size of each clear peak where voices and leads sit.
  const frameBeat = new Int32Array(frames);
  const partials: { cents: number[]; size: number[] }[] = [];

  for (let f = 0; f < frames; f++) {
    const centre = t0 + (f * HOP + FFT / 2) / RATE;
    const b = Math.floor((centre - (times[0] ?? 0)) / grid.period);
    frameBeat[f] = b;
    for (let i = 0; i < FFT; i++) {
      re[i] = (x[f * HOP + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < bins; k++) mag[k] = Math.hypot(re[k] ?? 0, im[k] ?? 0);
    const cents: number[] = [];
    const size: number[] = [];
    for (let k = voiceLo; k < voiceHi; k++) {
      if (!clearPeak(mag, k)) continue;
      // Parabolic interpolation on the log magnitude finds the peak between bins.
      const y0 = Math.log((mag[k - 1] ?? 0) + 1e-12);
      const y1 = Math.log(mag[k] ?? 0);
      const y2 = Math.log((mag[k + 1] ?? 0) + 1e-12);
      const den = y0 - 2 * y1 + y2;
      const d = den ? (0.5 * (y0 - y2)) / den : 0;
      cents.push(1200 * Math.log2(((k + d) * RATE) / FFT / 440));
      size.push(mag[k] ?? 0);
    }
    partials.push({ cents, size });
    if (b < 0 || b >= n) continue;
    counts[b] = (counts[b] ?? 0) + 1;
    for (let k = 1; k < bins; k++) {
      const power = (mag[k] ?? 0) ** 2;
      const m = Math.log1p(mag[k] ?? 0);
      const p = pitch[k] ?? -1;
      if (p >= 0) {
        chroma[b]![p] = (chroma[b]![p] ?? 0) + m;
        total[p] = (total[p] ?? 0) + m;
      }
      const t = band[k] ?? -1;
      if (t >= 0) timbre[b]![t] = (timbre[b]![t] ?? 0) + power;
      energy[b] = (energy[b] ?? 0) + power;
      if (k < lowBin) low[b] = (low[b] ?? 0) + power;
      const e = bandE[k < bandMid ? 0 : k < bandHigh ? 1 : 2];
      e[b] = (e[b] ?? 0) + power;
      if (k >= noteLo && k < noteHi && clearPeak(mag, k)) notes[b] = (notes[b] ?? 0) + (mag[k] ?? 0);
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
    notes[b] = (notes[b] ?? 0) / c;
    for (const e of bandE) e[b] = (e[b] ?? 0) / c;
  }
  const loudTop = [...energy].sort((p, q) => p - q)[Math.floor(n * 0.95)] || 1;
  const loud = [...energy].map((e) => Math.min(1, e / loudTop));
  const bass = scaled(low, 1);
  const tonal = scaled(notes, 1.5);
  const voice = voiceActivity(partials, frameBeat, tonal);
  const bands: BeatFeatures['bands'] = [Array.from(bandE[0]), Array.from(bandE[1]), Array.from(bandE[2])];

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

  return { times, timbre, chroma, loud, bass, tonal, voice, bands, downbeat, key: findKey(total), sections, drops };
}

/** A spectral peak standing at least 3× over its 17-bin neighbourhood: a note, not noise. */
function clearPeak(mag: Float64Array, k: number): boolean {
  const m = mag[k] ?? 0;
  if (m <= (mag[k - 1] ?? 0) || m < (mag[k + 1] ?? 0)) return false;
  let around = 0;
  for (let d = -8; d <= 8; d++) around += mag[k + d] ?? 0;
  return m >= (3 * around) / 17;
}

/** `v` against its 90th percentile, capped at `max`. */
function scaled(v: ArrayLike<number>, max: number): number[] {
  const all = Array.from(v);
  const top = [...all].sort((p, q) => p - q)[Math.floor(all.length * 0.9)] || 1;
  return all.map((x) => Math.min(max, x / top));
}

/**
 * Vocal or lead activity per beat, from frequency modulation (after
 * Regnier and Peeters, ICASSP 2009): each clear peak from 200 Hz to 3 kHz
 * is followed two frames back and forward (about 200 ms); after removing
 * the straight-line trend, a voice's partials wander 16 cents or more
 * (vibrato, scoops, drift), while keys, synths and pads hold still. The
 * share of tonal energy on wandering partials is averaged over a bar,
 * scaled within the region (its quiet quarter to its busy tenth) and kept
 * only where there are notes. Bowed strings, sax and bent guitars wander
 * too, so it marks where the melodic foreground is busy, not a singer.
 */
function voiceActivity(partials: { cents: number[]; size: number[] }[], frameBeat: Int32Array, tonal: number[]): number[] {
  const n = tonal.length;
  const sum = new Float64Array(n);
  const count = new Float64Array(n);
  const reach = 2;
  for (let t = reach; t + reach < partials.length; t++) {
    const p = partials[t]!;
    let wandering = 0;
    let all = 0;
    for (let q = 0; q < p.cents.length; q++) {
      all += p.size[q] ?? 0;
      const xs = [0];
      const ys = [p.cents[q] ?? 0];
      let found = true;
      for (const dir of [-1, 1]) {
        let cur = p.cents[q] ?? 0;
        for (let s = 1; s <= reach && found; s++) {
          // A partial may move this far between frames 46 ms apart (a 5-6 Hz vibrato does).
          let next = NaN;
          let gap = 120;
          for (const c of partials[t + dir * s]!.cents) {
            if (Math.abs(c - cur) < gap) {
              gap = Math.abs(c - cur);
              next = c;
            }
          }
          if (Number.isNaN(next)) found = false;
          else {
            cur = next;
            xs.push(dir * s);
            ys.push(next);
          }
        }
      }
      if (!found) continue;
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0;
      let sxx = 0;
      for (let r = 0; r < xs.length; r++) {
        sxy += (xs[r]! - mx) * (ys[r]! - my);
        sxx += (xs[r]! - mx) ** 2;
      }
      const slope = sxy / sxx;
      let lo = Infinity;
      let hi = -Infinity;
      for (let r = 0; r < xs.length; r++) {
        const e = ys[r]! - my - slope * (xs[r]! - mx);
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
      }
      if (hi - lo >= 16 && hi - lo <= 300) wandering += p.size[q] ?? 0;
    }
    const b = frameBeat[t] ?? -1;
    if (b >= 0 && b < n && all > 0) {
      sum[b] = (sum[b] ?? 0) + wandering / all;
      count[b] = (count[b] ?? 0) + 1;
    }
  }
  const raw = Array.from(sum, (s, i) => (count[i] ? s / count[i]! : 0));
  const bar = raw.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = i - 2; k <= i + 1; k++) {
      if (k >= 0 && k < n) {
        s += raw[k]!;
        c++;
      }
    }
    return s / c;
  });
  const sorted = [...bar].sort((p, q) => p - q);
  const quiet = sorted[Math.floor(n * 0.25)] ?? 0;
  const busy = sorted[Math.floor(n * 0.9)] ?? 0;
  const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
  return bar.map((s, i) => clamp01((s - quiet) / Math.max(0.04, busy - quiet)) * clamp01(s / 0.12) * Math.min(1, 1.5 * (tonal[i] ?? 0)));
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
