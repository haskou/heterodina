// Time-stretching with the pitch kept (WSOLA): short windowed frames are
// laid out at a fixed hop in the output and read from wherever a time map
// says the source should be, each nudged (within a few ms) to the spot that
// best continues the previous frame, so waveforms join without phasing.
// Pure: works on raw channel data, so it is testable without Web Audio.

/** Frame length (s): long enough for bass periods, short enough for transients. */
const FRAME_S = 0.04;
/** How far a frame may move from its target to find a seamless join (s). */
const TOLERANCE_S = 0.012;
/** The coarse similarity search runs on every DECIMATE-th sample. */
const DECIMATE = 4;

/**
 * Renders `seconds` of output whose sample at output time t comes from
 * source time `map(t)` (seconds). A map with slope 1 is plain playback; a
 * slope of 1.05 plays 5% faster at the same pitch. Frames start at the
 * map's target, so the first and last half frame are windowed and should
 * not be played on their own.
 */
export function stretch(
  channels: readonly Float32Array[],
  rate: number,
  map: (t: number) => number,
  seconds: number,
): Float32Array<ArrayBuffer>[] {
  const n = 2 * Math.round((FRAME_S * rate) / 2);
  const hop = n / 2;
  const tolerance = Math.round(TOLERANCE_S * rate);
  const outLength = Math.ceil(seconds * rate);
  const frames = Math.ceil(outLength / hop) + 1;

  // Source position of each frame's start, and the source region they span.
  const targets = new Float64Array(frames);
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < frames; k++) {
    const p = map((k * hop + n / 2) / rate) * rate - n / 2;
    targets[k] = p;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const base = Math.floor(lo) - n - tolerance - DECIMATE;
  const span = Math.ceil(hi) - base + 2 * n + 2 * tolerance + 2 * DECIMATE;
  const region = channels.map((source) => {
    const r = new Float32Array(span);
    const from = Math.max(0, base);
    const to = Math.min(source.length, base + span);
    if (to > from) r.set(source.subarray(from, to), from - base);
    return r;
  });
  const mono = new Float32Array(span);
  for (const r of region) for (let i = 0; i < span; i++) mono[i] = (mono[i] ?? 0) + (r[i] ?? 0);
  const coarse = new Float32Array(Math.floor(span / DECIMATE));
  for (let i = 0; i < coarse.length; i++) {
    let s = 0;
    for (let j = 0; j < DECIMATE; j++) s += mono[i * DECIMATE + j] ?? 0;
    coarse[i] = s;
  }

  const window = hann(n);
  const out = region.map(() => new Float32Array(outLength + n));
  const nc = n / DECIMATE;
  let previous = -1;
  for (let k = 0; k < frames; k++) {
    const target = Math.round((targets[k] ?? 0) - base);
    let best = target;
    if (previous >= 0) {
      // Where the previous frame would naturally continue: the frame that
      // matches it best near the target joins without a phase jump.
      const natural = previous + hop;
      const nd = Math.floor(natural / DECIMATE);
      let score = -Infinity;
      if (nd + nc < coarse.length) {
        for (let d = -tolerance; d <= tolerance; d += DECIMATE) {
          const p = Math.floor((target + d) / DECIMATE);
          if (p < 0 || p + nc >= coarse.length) continue;
          const s = similarity(coarse, p, nd, nc, 1);
          if (s > score) {
            score = s;
            best = target + d;
          }
        }
        // Refine to the sample around the coarse winner.
        const around = best;
        score = -Infinity;
        for (let d = -DECIMATE + 1; d < DECIMATE; d++) {
          const p = around + d;
          if (p < 0 || p + n >= span || natural + n >= span) continue;
          const s = similarity(mono, p, natural, n, 2);
          if (s > score) {
            score = s;
            best = p;
          }
        }
      }
    }
    best = Math.min(Math.max(best, 0), span - n - 1);
    const at = k * hop;
    for (let c = 0; c < region.length; c++) {
      const r = region[c]!;
      const q = out[c]!;
      for (let j = 0; j < n && at + j < q.length; j++) q[at + j] = (q[at + j] ?? 0) + (r[best + j] ?? 0) * (window[j] ?? 0);
    }
    previous = best;
  }
  return out.map((q) => q.slice(0, outLength));
}

/** Normalized cross-correlation of x[a..a+len) with x[b..b+len). */
function similarity(x: Float32Array, a: number, b: number, len: number, step: number): number {
  let c = 0;
  let e = 1e-9;
  for (let j = 0; j < len; j += step) {
    const v = x[a + j] ?? 0;
    c += v * (x[b + j] ?? 0);
    e += v * v;
  }
  return c / Math.sqrt(e);
}

/** Periodic Hann window: overlapping by half, copies sum to exactly 1. */
function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
