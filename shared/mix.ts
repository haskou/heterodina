// DJ transitions, in the spirit of Spotify's Mix, fully automatic.
//
// Where: transition points follow Bittner et al., "Automatic Playlist
// Sequencing and Transitions" (ISMIR 2017, Spotify). Candidates are
// downbeats; the outgoing region ends in the last quarter of its track and
// the incoming one starts in its first fifth; each pair is scored on
// timbre and harmony distance, loudness, harmonic change balance, and
// whether the regions end on a section boundary or a drop.
//
// How long and how: song compatibility after Spotify's mashup patent
// (US 11475867) — a tempo score and a key score — sets the preferred
// length, and the style comes from it and from the energy of the
// hand-over: long blends for close matches, filtered washes when keys
// clash, echo or brake exits when tempos are far apart, risers and loop
// rolls into louder tracks, and the mix styles of Spotify's mixing patent
// (US 2020/0374625: beat mix, sound bomb, beat storm, signature bar).
//
// Inside the window both tracks share a tempo gliding from the outgoing
// BPM to the incoming one (time-stretched, pitch kept) when their beats can
// lock; otherwise each keeps its own speed and the style hides the clash.
// Pure: the browser renders the plan (web/src/mixer.ts).

import type { BeatGrid } from './beat.ts';
import { correlation, distance, keyFit, type BeatFeatures } from './features.ts';
import type { TransitionProfile } from './types.ts';

export type MixStyle = 'blend' | 'rise' | 'wave' | 'melt' | 'echo' | 'roll' | 'brake' | 'beatmix' | 'bomb' | 'storm' | 'signature';

export interface MixPlan {
  style: MixStyle;
  /** Beats locked with time-stretching; otherwise each track keeps its own speed. */
  locked: boolean;
  /** Window length in beats (4 per bar). */
  beats: number;
  /** Outgoing tempo, and incoming tempo folded by 2× to the nearest (BPM). */
  bpmA: number;
  bpmB: number;
  /** Outgoing-track time of the window's first beat. */
  cueA: number;
  /** Incoming-track time of its first beat in the window. */
  cueB: number;
  /** The incoming bass waits for the window's last beat (it ends on a drop or a new section). */
  bassOnDrop: boolean;
  /** Rendered seconds before the window (outgoing at its own tempo). */
  pre: number;
  /** Rendered seconds of window. */
  window: number;
  /** Rendered seconds after the window (incoming at its own tempo, plus effect tails). */
  post: number;
}

/** What is known about one track's edge: its beat and, beat by beat, its sound. */
export interface Side {
  grid: BeatGrid | null;
  features: BeatFeatures | null;
}

/** Loudness of the outgoing track's last seconds and the incoming one's first, after normalization (dB). */
export interface EdgeLevels {
  outEnd: number;
  inStart: number;
}

/** Furthest each track is stretched from its own tempo. */
export const MAX_STRETCH = 0.08;
/** Below this the beat grid is too shaky to hold two tracks together for bars. */
export const MIN_MIX_CONFIDENCE = 0.2;
/** Longest window, and its share of each track's audible length. */
const MAX_WINDOW_S = 32;
const OUT_SHARE = 0.35;
const IN_SHARE = 0.5;
/** Rendered lead-in: room for the stretcher to settle before the splice. */
const PRE_S = 0.5;
/** Rendered lead-out: the incoming track alone, plus echo and reverb tails where used. */
const POST_S = 0.5;
const TAIL_S = 3.5;
/** Tempo assumed for timing when the outgoing track has no steady beat. */
const NOMINAL_BPM = 120;
/** Bittner et al.: the outgoing region ends in the last quarter, the incoming starts in the first fifth. */
const OUT_REGION = 0.75;
const IN_REGION = 0.2;

/** Longest window each style is worth (beats); the chosen length never exceeds it. */
const MAX_BEATS: Record<MixStyle, number> = {
  blend: 64,
  rise: 32,
  wave: 32,
  melt: 16,
  echo: 8,
  roll: 16,
  brake: 8,
  beatmix: 32,
  bomb: 32,
  storm: 32,
  signature: 32,
};

export interface Compatibility {
  /** 0.01..1: 1 for equal tempos, falling with the ratio. */
  tempo: number;
  /** 0..1, see keyFit. */
  key: number;
  /** 0..1: how steady both rhythms are. */
  steady: number;
  /** Preferred window length in bars. */
  bars: number;
}

/**
 * Song-level compatibility (after US 11475867): tempo score
 * max(0.01, 1 - 3.5·|log2 ratio|) times key score; the better they
 * fit, the longer they may overlap. Unsteady rhythms keep it to 2 bars.
 */
export function compatibility(bpmA: number, bpmB: number, a: Side, b: Side): Compatibility {
  const tempo = Math.max(0.01, 1 - Math.abs(Math.log2(bpmB / bpmA)) * 3.5);
  const key = a.features && b.features ? keyFit(a.features.key, b.features.key) : 0.75;
  const steady = Math.min(Math.max((Math.min(a.grid?.confidence ?? 0, b.grid?.confidence ?? 0) - 0.15) / 0.25, 0), 1);
  const score = tempo * key;
  const bars = steady < 0.25 ? 2 : score >= 0.9 ? 16 : score >= 0.75 ? 8 : score >= 0.5 ? 4 : 2;
  return { tempo, key, steady, bars };
}

/**
 * The transition from `out` into `inc` (each with what is known of its
 * edge), or null when there is no room for even two bars; the caller then
 * crossfades.
 */
export function planMix(
  out: TransitionProfile,
  inc: TransitionProfile,
  a: Side,
  b: Side,
  levels: EdgeLevels,
  random: () => number = Math.random,
): MixPlan | null {
  const steadyA = a.grid && a.grid.confidence >= MIN_MIX_CONFIDENCE ? a.grid : null;
  const steadyB = b.grid && b.grid.confidence >= MIN_MIX_CONFIDENCE ? b.grid : null;
  const bpmA = steadyA ? 60 / steadyA.period : NOMINAL_BPM;
  const folded = steadyB ? foldTempo(60 / steadyB.period, bpmA) : 0;
  const locked = !!steadyA && !!steadyB && Math.abs(Math.log(folded / bpmA)) <= Math.log(1 + MAX_STRETCH);
  // Unlocked, the incoming track runs at its own speed through the window.
  const bpmB = locked ? folded : bpmA;
  const fit = compatibility(bpmA, steadyB ? folded : bpmA, a, b);
  const limit = Math.min(MAX_WINDOW_S, OUT_SHARE * (out.audioEnd - out.leadIn), IN_SHARE * (inc.audioEnd - inc.leadIn));

  const cues = locked && a.features && b.features && steadyB ? pickCues(out, inc, a.features, b.features, bpmA, folded, 60 / steadyB.period, fit.bars, limit) : null;
  const style = chooseStyle({
    locked,
    weak: fit.steady < 0.25,
    key: fit.key,
    lift: levels.inStart - levels.outEnd,
    abrupt: out.audioEnd - out.outroStart < 1,
    outHasBeat: !!steadyA,
    intoDrop: !!cues?.drop,
    bars: cues ? cues.beats / 4 : fit.bars,
    random,
  });

  // Length: what the cue search chose (or the preferred length), capped by
  // what the style is worth and what fits.
  // Unlocked: four bars of wave or wash hide a tempo clash; exits take two.
  const fallback = locked ? Math.max(8, fit.bars * 4) : 16;
  let beats = Math.min(cues?.beats ?? fallback, MAX_BEATS[style]);
  while (beats > 8 && windowSeconds(beats, bpmA, bpmB) > limit) beats /= 2;
  const window = windowSeconds(beats, bpmA, bpmB);
  if (window > limit) return null;

  let cueA: number;
  let cueB: number;
  if (cues) {
    // A shorter window keeps the same end: the moment the cue search chose.
    cueA = cues.cueA + ((cues.beats - beats) * 60) / bpmA;
    cueB = cues.cueB + ((cues.beats - beats) * 60) / bpmB;
  } else {
    // The window ends where the outgoing sound does, on a downbeat when
    // known; the incoming track enters on its first beat (or sound).
    const latest = out.audioEnd - (beats * 60) / bpmA;
    cueA = steadyA ? lastDownbeat(steadyA, a.features, latest) : latest;
    cueB = locked && steadyB ? firstBeat(steadyB, b.features, inc.leadIn - 0.01) : Math.max(0, inc.leadIn - 0.05);
  }
  if (cueA - PRE_S < out.leadIn) return null;
  const post = style === 'echo' || style === 'melt' || style === 'brake' ? TAIL_S : POST_S;
  const bassOnDrop = !!cues && (cues.drop || cues.section) && !['echo', 'roll', 'brake', 'melt'].includes(style);
  return { style, locked, beats, bpmA, bpmB, cueA, cueB: Math.max(0, cueB), bassOnDrop, pre: PRE_S, window, post };
}

interface StyleContext {
  locked: boolean;
  /** Rhythm too unsteady to hold an overlap. */
  weak: boolean;
  key: number;
  /** Incoming start minus outgoing end, dB. */
  lift: number;
  abrupt: boolean;
  outHasBeat: boolean;
  /** The chosen window ends on a drop of the incoming track. */
  intoDrop: boolean;
  bars: number;
  random: () => number;
}

/**
 * Never two tracks overlapping long when they can't lock: short echo or
 * brake exits, reverb washes, filter waves. Locked: keys that clash get
 * filtered washes; into louder tracks (or drops) risers and loop rolls;
 * otherwise long blends and the patent's mix styles, drawn for variety.
 */
export function chooseStyle(c: StyleContext): MixStyle {
  const r = c.random();
  if (!c.locked) {
    if (c.lift <= -6) return 'melt';
    if (c.outHasBeat && (c.abrupt || r < 0.45)) return r < 0.15 ? 'brake' : 'echo';
    return r < 0.75 ? 'wave' : 'melt';
  }
  if (c.weak) return r < 0.5 ? 'wave' : 'melt';
  if (c.key < 0.6) return c.lift <= -6 || r < 0.6 ? 'melt' : 'wave';
  if (c.lift >= 3 || c.intoDrop) return r < 0.65 ? 'rise' : 'roll';
  if (c.lift <= -6) return 'melt';
  if (c.abrupt && r < 0.3) return 'echo';
  const pool: [MixStyle, number][] = [
    ['blend', c.bars >= 16 ? 3 : 1],
    ['wave', 2],
    ['beatmix', 1.5],
    ['bomb', 1.5],
    ['storm', 1],
    ['signature', 1],
    ['rise', 1],
  ];
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [style, w] of pool) {
    if ((x -= w) < 0) return style;
  }
  return 'blend';
}

interface Cues {
  cueA: number;
  cueB: number;
  beats: number;
  /** The window ends on a drop / a new section of the incoming track. */
  drop: boolean;
  section: boolean;
}

/**
 * Bittner et al.: every pair of downbeats (outgoing region ending in the
 * last quarter, incoming starting in the first fifth) and every length is
 * scored on timbre and chroma distance, loudness, harmonic change balance,
 * quietness mismatch and whether both end on a drop or section boundary.
 * Each cost is scaled to 0..1 over all candidates; the lowest mean wins,
 * with a prior towards the compatibility's preferred length.
 */
export function pickCues(
  out: TransitionProfile,
  inc: TransitionProfile,
  A: BeatFeatures,
  B: BeatFeatures,
  bpmA: number,
  bpmB: number,
  rawB: number,
  preferBars: number,
  limit: number,
): Cues | null {
  // Incoming beats per shared beat (2 or 0.5 when its tempo was folded).
  const stepB = rawB / bpmB;
  const changeA = changeRate(A);
  const changeB = changeRate(B);
  const isDown = (f: BeatFeatures, i: number): boolean => (((i - f.downbeat) % 4) + 4) % 4 === 0;
  type Candidate = { i: number; j: number; bars: number; c: number[]; drop: boolean; section: boolean };
  const candidates: Candidate[] = [];
  for (const bars of [2, 4, 8, 16]) {
    const n = bars * 4;
    if (windowSeconds(n, bpmA, bpmB) > limit) continue;
    const nB = Math.round(n * stepB);
    for (let i = 0; i + n < A.times.length; i++) {
      const endA = A.times[i + n] ?? Infinity;
      if (!isDown(A, i) || endA > out.audioEnd + 0.05 || endA < OUT_REGION * out.duration) continue;
      for (let j = 0; j + nB < B.times.length; j++) {
        const startB = B.times[j] ?? 0;
        if (startB < inc.leadIn - 0.05) continue;
        if (startB > Math.max(IN_REGION * inc.duration, inc.leadIn + 4 * 60 / bpmB)) break;
        if (!isDown(B, j)) continue;
        let timbre = 0;
        let harmony = 0;
        let quiet = 0;
        let balance = 0;
        let la = 0;
        let lb = 0;
        for (let k = 0; k < n; k++) {
          const kb = j + Math.floor(k * stepB);
          timbre += distance(A.timbre[i + k]!, B.timbre[kb]!);
          harmony += distance(A.chroma[i + k]!, B.chroma[kb]!);
          quiet += 2 - (A.loud[i + k] ?? 0) - (B.loud[kb] ?? 0);
          // Harmony should settle in one track while it moves in the other.
          balance += 1 - Math.abs((changeA[i + k] ?? 0) - (1 - (changeB[kb] ?? 0)));
          la += A.loud[i + k] ?? 0;
          lb += B.loud[kb] ?? 0;
        }
        const ie = i + n;
        const je = j + nB;
        const drop = B.drops.has(je);
        const section = B.sections.has(je);
        candidates.push({
          i,
          j,
          bars,
          drop,
          section,
          c: [
            timbre / n,
            harmony / n,
            quiet / n,
            1 - balance / n,
            1 - Math.min(la, lb) / (Math.max(la, lb) || 1),
            (A.drops.has(ie) ? 0 : 1) + (drop ? 0 : 1),
            (A.sections.has(ie) ? 0 : 1) + (section ? 0 : 1),
          ],
        });
      }
    }
  }
  if (!candidates.length) return null;
  const terms = candidates[0]!.c.length;
  for (let t = 0; t < terms; t++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candidates) {
      lo = Math.min(lo, c.c[t]!);
      hi = Math.max(hi, c.c[t]!);
    }
    // A term that doesn't really vary (rounding only) must not decide anything.
    const varies = hi - lo > 1e-6 * Math.max(1, Math.abs(hi));
    for (const c of candidates) c.c[t] = varies ? (c.c[t]! - lo) / (hi - lo) : 0;
  }
  let best = candidates[0]!;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = c.c.reduce((s, v) => s + v, 0) / terms + 0.12 * Math.abs(Math.log2(c.bars / preferBars));
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { cueA: A.times[best.i]!, cueB: B.times[best.j]!, beats: best.bars * 4, drop: best.drop, section: best.section };
}

/** Per beat: how much the harmony stays put from the beat before (0..1). */
function changeRate(f: BeatFeatures): Float64Array {
  const rate = new Float64Array(f.chroma.length);
  for (let i = 1; i < f.chroma.length; i++) rate[i] = (correlation(f.chroma[i]!, f.chroma[i - 1]!) + 1) / 2;
  return rate;
}

/** Latest bar start (or beat) of `grid` at or before `t`. */
function lastDownbeat(grid: BeatGrid, f: BeatFeatures | null, t: number): number {
  const k = Math.floor((t - grid.phase) / grid.period);
  if (!f?.times.length) return grid.phase + k * grid.period;
  const first = f.times[0]!;
  for (let m = k; m > k - 4; m--) {
    const at = grid.phase + m * grid.period;
    const idx = Math.round((at - first) / grid.period);
    if ((((idx - f.downbeat) % 4) + 4) % 4 === 0) return at;
  }
  return grid.phase + k * grid.period;
}

/** First bar start (or beat) of `grid` at or after `t`. */
function firstBeat(grid: BeatGrid, f: BeatFeatures | null, t: number): number {
  const k = Math.ceil((t - grid.phase) / grid.period);
  if (!f?.times.length) return grid.phase + k * grid.period;
  const first = f.times[0]!;
  for (let m = k; m < k + 4; m++) {
    const at = grid.phase + m * grid.period;
    const idx = Math.round((at - first) / grid.period);
    if ((((idx - f.downbeat) % 4) + 4) % 4 === 0) return at;
  }
  return grid.phase + k * grid.period;
}

/** The incoming tempo, doubled or halved when that is nearer the outgoing one. */
export function foldTempo(bpm: number, to: number): number {
  return [bpm, bpm * 2, bpm / 2].reduce((best, c) => (Math.abs(Math.log(c / to)) < Math.abs(Math.log(best / to)) ? c : best));
}

/** Seconds that `beats` take while the tempo glides linearly from a to b BPM. */
function windowSeconds(beats: number, a: number, b: number): number {
  return (beats * 120) / (a + b);
}

/** Beats elapsed `t` seconds into the window. */
function beatsAt(plan: MixPlan, t: number): number {
  const { bpmA: a, bpmB: b, window: w } = plan;
  return (a * t + ((b - a) * t * t) / (2 * w)) / 60;
}

/** Total rendered seconds. */
export function mixLength(plan: MixPlan): number {
  return plan.pre + plan.window + plan.post;
}

/**
 * Loop roll: from the midpoint the outgoing track repeats a loop that
 * halves every quarter of the remaining window (1 bar, 2 beats, 1, ½).
 */
function rollBeat(plan: MixPlan, beat: number): number {
  if (plan.style !== 'roll') return beat;
  const half = plan.beats / 2;
  if (beat < half) return beat;
  const quarter = half / 4;
  const step = Math.min(3, Math.floor((beat - half) / quarter));
  const length = Math.min(4, quarter) / 2 ** step;
  return half + ((beat - half - step * quarter) % length);
}

/** Outgoing-track time heard at rendered time `t`. */
export function sourceA(plan: MixPlan, t: number): number {
  const w = t - plan.pre;
  if (w < 0) return plan.cueA + w;
  if (w <= plan.window) return plan.cueA + (rollBeat(plan, beatsAt(plan, w)) * 60) / plan.bpmA;
  return plan.cueA + (rollBeat(plan, plan.beats) * 60) / plan.bpmA + ((w - plan.window) * plan.bpmB) / plan.bpmA;
}

/** Incoming-track time heard at rendered time `t` (negative before it starts). */
export function sourceB(plan: MixPlan, t: number): number {
  const w = t - plan.pre;
  if (w < 0) return plan.cueB + (w * plan.bpmA) / plan.bpmB;
  if (w <= plan.window) return plan.cueB + (beatsAt(plan, w) * 60) / plan.bpmB;
  return plan.cueB + (plan.beats * 60) / plan.bpmB + (w - plan.window);
}

/**
 * Per-track controls at one moment, each 0..1:
 * - vol: level;
 * - low, mid, high: three-band EQ (1 = flat, 0 = band killed);
 * - lp, hp: low-pass / high-pass position (1 = fully open);
 * - echo, verb: effect sends; bassEcho: the lows alone into the echo;
 * - flange: flanger level; riser: the noise riser (outgoing side only).
 */
export interface Controls {
  vol: number;
  low: number;
  mid: number;
  high: number;
  lp: number;
  hp: number;
  echo: number;
  verb: number;
  bassEcho: number;
  flange: number;
  riser: number;
}

const NEUTRAL: Controls = { vol: 1, low: 1, mid: 1, high: 1, lp: 1, hp: 1, echo: 0, verb: 0, bassEcho: 0, flange: 0, riser: 0 };

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
/** Smoothstep: same ends, no corner where it starts or stops moving. */
const smooth = (v: number): number => v * v * (3 - 2 * v);
/** 0 before a, 1 after b, linear between. */
const up = (u: number, a: number, b: number): number => clamp01((u - a) / (b - a));
const down = (u: number, a: number, b: number): number => 1 - up(u, a, b);
/** Equal-power versions, for levels of unrelated material. */
const upPower = (u: number, a: number, b: number): number => Math.sin((up(u, a, b) * Math.PI) / 2);
const downPower = (u: number, a: number, b: number): number => Math.cos((up(u, a, b) * Math.PI) / 2);

type Lane = (u: number, beat: number) => Partial<Controls>;
interface Recipe {
  out: Lane[];
  in: Lane[];
}

// Volume shapes.
const overlapOut: Lane = (u) => ({ vol: downPower(u, 0.75, 1) });
const overlapIn: Lane = (u) => ({ vol: upPower(u, 0, 0.25) });
const curvyOut: Lane = (u) => ({ vol: downPower(u, 0, 1) });
const curvyIn: Lane = (u) => ({ vol: upPower(u, 0, 1) });
const linearOut: Lane = (u) => ({ vol: 1 - u });
const linearIn: Lane = (u) => ({ vol: u });
const quickIn: Lane = (u) => ({ vol: up(u, 0, 0.15) });
/** The incoming track drops in on the window's end. */
const cutIn: Lane = (u, beat) => ({ vol: up(u, 1 - beat * 0.06, 1) });
// Bass hand-overs.
const centreSwap: [Lane, Lane] = [(u, beat) => ({ low: down(u, 0.5 - beat / 2, 0.5) }), (u, beat) => ({ low: up(u, 0.5, 0.5 + beat / 2) })];
const endSwap: [Lane, Lane] = [(u, beat) => ({ low: down(u, 1 - beat / 2, 1) }), (u, beat) => ({ low: up(u, 1 - beat / 2, 1) })];
const midThird: [Lane, Lane] = [(u) => ({ low: down(u, 1 / 3, 2 / 3) }), (u) => ({ low: up(u, 1 / 3, 2 / 3) })];

const RECIPES: Record<MixStyle, Recipe> = {
  // Both play; the basses trade places in half a beat at the midpoint.
  blend: { out: [overlapOut, centreSwap[0]], in: [overlapIn, centreSwap[1]] },
  // The outgoing track thins out under a noise sweep; the incoming bass lands on the last beat.
  rise: {
    out: [() => ({}), endSwap[0], (u) => ({ hp: down(u, 0.5, 1), riser: u < 1 ? up(u, 0, 1) ** 2 : 0 })],
    in: [overlapIn, endSwap[1]],
  },
  // Lows, mids and highs hand over one after another, through low-pass filters.
  wave: {
    out: [curvyOut, (u) => ({ low: down(u, 0, 0.5), mid: down(u, 0.25, 0.75), high: down(u, 0.5, 1), lp: down(u, 0.5, 1) })],
    in: [curvyIn, (u) => ({ high: up(u, 0, 0.5), mid: up(u, 0.25, 0.75), low: up(u, 0.5, 1), lp: up(u, 0, 0.5) })],
  },
  // The outgoing track closes down into a reverb wash.
  melt: {
    out: [(u) => ({ vol: down(u, 0, 1), low: down(u, 0, 1), lp: down(u, 0.5, 1), verb: u < 1 ? up(u, 0.55, 1) : 0 })],
    in: [(u) => ({ vol: upPower(u, 0, 0.5), low: up(u, 0, 1) })],
  },
  // The outgoing track thins out and trails off in tempo-synced echoes.
  echo: { out: [(u) => ({ hp: down(u, 0.5, 1), echo: u < 1 ? up(u, 0.5, 1) : 0 })], in: [cutIn] },
  // From the midpoint the outgoing loop halves every quarter, building into the drop.
  roll: { out: [(u, beat) => ({ low: down(u, 0, beat), hp: down(u, 0.5, 1) })], in: [cutIn, (u, beat) => ({ low: up(u, 1 - beat / 2, 1) })] },
  // The outgoing track slows to a stop over its last beat, like a turntable switched off.
  brake: { out: [(u) => ({ verb: u < 1 ? 0.35 * up(u, 0.8, 1) : 0 })], in: [cutIn] },
  // Mixing patent, "classic beat mix": tempos matched, linear crossfade.
  beatmix: { out: [linearOut], in: [linearIn] },
  // "Sound bomb": a fast bass hand-over in the middle third.
  bomb: { out: [linearOut, midThird[0]], in: [linearIn, midThird[1]] },
  // "Beat storm": sound bomb plus an echo on the outgoing kicks in the first third.
  storm: { out: [linearOut, midThird[0], (u) => ({ bassEcho: 1.2 * down(u, 0.28, 1 / 3) })], in: [linearIn, midThird[1]] },
  // "Signature bar": bass and mids trade over the whole window, a flanger on
  // the outgoing track through the middle and last thirds, the incoming one comes up fast.
  signature: {
    out: [linearOut, (u) => ({ low: down(u, 0, 1), mid: down(u, 0, 1), flange: u < 1 ? up(u, 1 / 3, 0.42) : 0 })],
    in: [quickIn, (u) => ({ low: up(u, 0, 1), mid: up(u, 0, 1) })],
  },
};

/**
 * Controls of the outgoing ('out') or incoming ('in') track at window
 * progress `u` (0 = first beat, 1 = last; outside the window the edge
 * values hold, except that the outgoing track is silent after it and the
 * incoming one before it). `beat` is one beat as a fraction of the window.
 * With `bassOnDrop`, the incoming bass waits for the last beat.
 */
export function controls(style: MixStyle, side: 'out' | 'in', u: number, beat: number, bassOnDrop = false): Controls {
  if (side === 'out' && u > 1) return { ...NEUTRAL, vol: 0 };
  if (side === 'in' && u < 0) return { ...NEUTRAL, vol: 0 };
  const x = clamp01(u);
  const c = { ...NEUTRAL };
  for (const lane of RECIPES[style][side]) Object.assign(c, lane(x, beat));
  if (bassOnDrop) Object.assign(c, endSwap[side === 'out' ? 0 : 1](x, beat));
  // Filters ease in and out of a sweep: a linear start is heard as a jolt.
  c.lp = smooth(c.lp);
  c.hp = smooth(c.hp);
  return c;
}
