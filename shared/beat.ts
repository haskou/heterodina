// Beat grid of a stretch of audio, and how to shift a transition so the
// incoming track's beats land on the outgoing track's. Pure: works on
// mono samples, so it is testable without Web Audio.

export interface BeatGrid {
  /** Seconds per beat. */
  period: number;
  /** Time of one beat, in seconds of the analysed track's own timeline. */
  phase: number;
  /** 0..1: how periodic the onsets are (1 = a perfect click track, noise ~0.04). */
  confidence: number;
}

/** Envelope resolution: 10 ms (refined below a frame by interpolation). */
const FRAME_S = 0.01;
/** Kick and bass band; the rest (snare, hats) comes from the signal's slope. */
const LOWPASS_HZ = 150;
/** Tempo search range: 200 down to 60 BPM. */
const MIN_PERIOD_S = 0.3;
const MAX_PERIOD_S = 1;
/** Tempo prior centred on 120 BPM, so half/double tempo ambiguities resolve sensibly. */
const PRIOR_PERIOD_S = 0.5;
/** Below this the onsets are not periodic enough to align anything. */
export const MIN_CONFIDENCE = 0.15;

/**
 * Beat grid of `samples` (mono, `rate` Hz) whose first sample is at track
 * time `t0`. Null when there is no steady beat.
 */
export function beatGrid(samples: Float32Array, rate: number, t0 = 0): BeatGrid | null {
  const hop = Math.max(1, Math.round(rate * FRAME_S));
  const frameS = hop / rate;
  const frames = Math.floor(samples.length / hop);
  if (frames * frameS < MAX_PERIOD_S * 6) return null;

  // Per frame: energy of the low band (kicks, bass) and of the first
  // difference (a cheap high-pass: snares, hats), log-compressed. Onsets are
  // their rises, lightly smoothed.
  const a = Math.exp((-2 * Math.PI * LOWPASS_HZ) / rate);
  let low = 0;
  let prev = 0;
  const lo = new Float32Array(frames);
  const hi = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let el = 0;
    let eh = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const x = samples[i] ?? 0;
      low = (1 - a) * x + a * low;
      el += low * low;
      eh += (x - prev) ** 2;
      prev = x;
    }
    lo[f] = Math.log1p((1000 * el) / hop);
    hi[f] = Math.log1p((1000 * eh) / hop);
  }
  const raw = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    raw[f] = Math.max(0, (lo[f] ?? 0) - (lo[f - 1] ?? 0)) + Math.max(0, (hi[f] ?? 0) - (hi[f - 1] ?? 0));
  }
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames - 1; f++) {
    onset[f] = ((raw[f - 1] ?? 0) + 2 * (raw[f] ?? 0) + (raw[f + 1] ?? 0)) / 4;
    mean += onset[f] ?? 0;
  }
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] = (onset[f] ?? 0) - mean;

  const acf = (lag: number): number => {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += (onset[f] ?? 0) * (onset[f + lag] ?? 0);
    return s / (frames - lag);
  };

  const minLag = Math.round(MIN_PERIOD_S / frameS);
  const maxLag = Math.round(MAX_PERIOD_S / frameS);
  const values = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) values[lag] = acf(lag);
  // A real beat repeats at 2 and 4 periods too; noise peaks don't.
  const harmonic = (lag: number): number => (values[lag] ?? 0) + 0.5 * acf(2 * lag) + 0.25 * acf(4 * lag);
  const scores = new Float64Array(maxLag + 1);
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    scores[lag] = harmonic(lag);
    const prior = Math.exp(-0.5 * (Math.log2((lag * frameS) / PRIOR_PERIOD_S) / 0.9) ** 2);
    const score = (scores[lag] ?? 0) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Relative to a perfectly periodic signal (all three terms = acf(0)).
  const zero = acf(0);
  const confidence = zero > 0 ? (scores[best] ?? 0) / (1.75 * zero) : 0;
  if (confidence < MIN_CONFIDENCE) return null;

  // Sub-frame period from a parabola through the peak.
  const l = values[best - 1] ?? 0;
  const c = values[best] ?? 0;
  const r = values[best + 1] ?? 0;
  const denom = l - 2 * c + r;
  const lag = best + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / denom)) : 0);

  // Phase: the offset whose comb of beats collects the most onset.
  let phaseFrame = 0;
  let phaseScore = -Infinity;
  for (let p = 0; p < Math.ceil(lag); p++) {
    let s = 0;
    for (let k = 0; ; k++) {
      const f = Math.round(p + k * lag);
      if (f >= frames) break;
      s += onset[f] ?? 0;
    }
    if (s > phaseScore) {
      phaseScore = s;
      phaseFrame = p;
    }
  }
  return { period: lag * frameS, phase: t0 + phaseFrame * frameS, confidence };
}

/** Largest drift between the two grids over a blend that still sounds locked (s). */
const MAX_DRIFT_S = 0.05;

/**
 * Shift (seconds, within half a beat) to apply to a transition that starts
 * the incoming track (from `inOffset`) at outgoing time `start`, so that
 * its beats coincide with the outgoing ones for `overlap` seconds. Null
 * when the tempos are not compatible (equal, double or half, within the
 * drift the blend tolerates).
 */
export function beatShift(out: BeatGrid, inc: BeatGrid, start: number, inOffset: number, overlap: number): number | null {
  // Half/double tempos lock every other beat: compare the slower pulse with
  // a whole number of the faster one.
  const slow = Math.max(out.period, inc.period);
  const fast = Math.min(out.period, inc.period);
  const k = Math.round(slow / fast);
  if (k < 1 || k > 2) return null;
  const drift = (Math.abs(slow - k * fast) * overlap) / slow;
  if (drift > MAX_DRIFT_S) return null;

  // First incoming beat at or after where it starts playing, in outgoing
  // time, moved onto the nearest outgoing beat.
  const firstIn = inc.phase + Math.ceil((inOffset - inc.phase) / inc.period) * inc.period;
  const lands = start + (firstIn - inOffset);
  const target = out.phase + Math.round((lands - out.phase) / out.period) * out.period;
  return target - lands;
}
