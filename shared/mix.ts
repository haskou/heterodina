// DJ transitions, in the spirit of Spotify's Mix, fully automatic.
//
// Where and how, together: candidate transition points follow Bittner et
// al., "Automatic Playlist Sequencing and Transitions" (ISMIR 2017,
// Spotify). Every pair of downbeats (the outgoing region ending in the
// last quarter of its track, the incoming one starting in its first fifth)
// is scored on timbre and harmony distance, loudness, harmonic change
// balance, section boundaries, drops, phrase lines, and how much of either
// track it skips. For each pair, every blend style is played through a
// beat-by-beat simulation of its real automation on both tracks' measured
// bass, notes, vocal or lead activity and band energies, scoring what a
// dance floor would hear: two bass lines at once, beats with no bass,
// clashing chords, two voices at once, two full arrangements at once, and
// level jumps. Pair and style are chosen together.
//
// The tempo gap sets the preferred length. Music without a steady beat gets a
// long crossfade at its own speed; tempos more than 20% apart get an echo,
// brake or spinback exit. Into louder tracks or drops, risers and loop
// rolls; long DJ mixes sometimes tease the incoming track in. When keys
// clash where both play chords, the incoming track starts shifted into the
// outgoing key and glides back to its own pitch.
//
// Inside the window both tracks share a tempo gliding from the outgoing
// BPM to the incoming one (time-stretched, pitch kept). Pure: the browser
// renders the plan (web/src/mixer.ts).

import type { BeatGrid } from './beat.ts';
import { correlation, distance, keyFit, type BeatFeatures, type Key } from './features.ts';
import type { TransitionProfile } from './types.ts';

export type MixStyle =
  | 'djmix'
  | 'djdrop'
  | 'tease'
  | 'blend'
  | 'fade'
  | 'rise'
  | 'wave'
  | 'melt'
  | 'echo'
  | 'roll'
  | 'brake'
  | 'spinback'
  | 'beatmix'
  | 'bomb'
  | 'storm'
  | 'signature';

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
  /** Semitones the incoming track starts shifted into the outgoing key, gliding back to its own pitch by the window's end (0 = none). */
  pitch: number;
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

/** Widest tempo gap that is still stretched (octaves): past 20% stretching sounds wrong. */
export const MAX_GAP = 0.26;
/** Below this the beat grid is too shaky to hold two tracks together for bars. */
export const MIN_MIX_CONFIDENCE = 0.2;
/** Filter sweeps: a closed low-pass sits here, a closed high-pass here (Hz). */
export const LP_CLOSED_HZ = 120;
export const HP_CLOSED_HZ = 1800;
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
/** Length of the crossfade between tracks without a steady beat (s). */
const FREE_S = 10;
/** Bittner et al.: the outgoing region ends in the last quarter, the incoming starts in the first fifth. */
const OUT_REGION = 0.75;
const IN_REGION = 0.2;
/** Styles scoring within this of the best are drawn among, for variety. */
const VARIETY = 0.02;

/** Longest window each style is worth (beats); the chosen length never exceeds it. */
const MAX_BEATS: Record<MixStyle, number> = {
  djmix: 64,
  djdrop: 64,
  tease: 64,
  blend: 64,
  fade: 64,
  rise: 32,
  wave: 32,
  melt: 16,
  echo: 8,
  roll: 16,
  brake: 8,
  spinback: 8,
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
  /** |log2| of the tempo ratio. */
  gap: number;
  /** Too unsteady to beat-match. */
  weak: boolean;
  /** Preferred window length in bars. */
  bars: number;
}

/**
 * Song-level compatibility: tempo score
 * max(0.01, 1 - 3.5·|log2 ratio|) and key score. A key clash only matters
 * where both tracks play chords, which the simulation measures, so the
 * preferred length comes from the tempo gap alone: 16 bars when the tempos
 * are within about 3%, otherwise 8 so the glide stays gentle. Unsteady
 * rhythms keep it to 2.
 */
export function compatibility(bpmA: number, bpmB: number, a: Side, b: Side): Compatibility {
  const gap = Math.abs(Math.log2(bpmB / bpmA));
  const tempo = Math.max(0.01, 1 - gap * 3.5);
  const key = a.features && b.features ? keyFit(a.features.key, b.features.key) : 0.75;
  const steady = Math.min(Math.max((Math.min(a.grid?.confidence ?? 0, b.grid?.confidence ?? 0) - 0.15) / 0.25, 0), 1);
  const weak = steady < 0.25;
  const bars = weak ? 2 : gap < 0.045 ? 16 : 8;
  return { tempo, key, steady, gap, weak, bars };
}

/** Semitones that move key `b` onto key `a` (relative majors compared), within ±6. */
export function keyShift(a: Key, b: Key): number {
  const major = (k: Key): number => (k.minor ? (k.root + 3) % 12 : k.root);
  const d = (((major(a) - major(b)) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/**
 * The transition from `out` into `inc` (each with what is known of its
 * edge), or null when there is no room for it; the caller then crossfades.
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
  const rawB = steadyB ? 60 / steadyB.period : bpmA;
  const folded = foldTempo(rawB, bpmA);
  const fit = compatibility(bpmA, folded, a, b);
  const lift = levels.inStart - levels.outEnd;
  const limit = Math.min(MAX_WINDOW_S, OUT_SHARE * (out.audioEnd - out.leadIn), IN_SHARE * (inc.audioEnd - inc.leadIn));

  if (!steadyA || !steadyB || fit.weak) return freeFade(out, inc, bpmA, limit);
  if (fit.gap > MAX_GAP) return exit(out, inc, steadyA, a.features, bpmA, lift, limit, random());

  const cues = a.features && b.features ? pickCues(out, inc, a.features, b.features, bpmA, folded, rawB, fit, limit) : null;
  let style: MixStyle = 'djmix';
  if (cues) {
    const best = cues.ranked[0]!.score;
    const near = cues.ranked.filter((s) => s.score <= best + VARIETY);
    style = near[Math.min(near.length - 1, Math.floor(random() * near.length))]!.style;
  }
  style = flourish(style, lift, !!cues?.drop, cues?.beats ?? fit.bars * 4, random());

  // Length: what the cue search chose (or the preferred length), capped by
  // what the style is worth and what fits.
  let beats = Math.min(cues?.beats ?? Math.max(8, fit.bars * 4), MAX_BEATS[style]);
  while (beats > 8 && windowSeconds(beats, bpmA, folded) > limit) beats /= 2;
  const window = windowSeconds(beats, bpmA, folded);
  if (window > limit) return null;

  let cueA: number;
  let cueB: number;
  if (cues) {
    // A shorter window keeps the same end: the moment the cue search chose.
    cueA = cues.cueA + ((cues.beats - beats) * 60) / bpmA;
    cueB = cues.cueB + ((cues.beats - beats) * 60) / folded;
  } else {
    // The window ends on the outgoing track's last downbeat before its sound
    // does; the incoming track enters on its first downbeat.
    cueA = lastDownbeat(steadyA, a.features, out.audioEnd - (beats * 60) / bpmA);
    cueB = firstBeat(steadyB, b.features, inc.leadIn - 0.01);
  }
  if (cueA - PRE_S < out.leadIn) return null;
  const pitch = style === 'roll' ? 0 : (cues?.pitch ?? 0);
  return { style, locked: true, beats, bpmA, bpmB: folded, cueA, cueB: Math.max(0, cueB), pitch, pre: PRE_S, window, post: POST_S };
}

/**
 * No steady beat (ambient, classical, rubato): beat-matching would do
 * harm, so both tracks keep their own speed and an equal-power crossfade of
 * about ten seconds runs from where the outgoing music really ends into
 * where the incoming music really starts.
 */
function freeFade(out: TransitionProfile, inc: TransitionProfile, bpm: number, limit: number): MixPlan | null {
  let beats = [8, 16, 32, 64].reduce((p, q) => (Math.abs((q * 60) / bpm - FREE_S) < Math.abs((p * 60) / bpm - FREE_S) ? q : p));
  while (beats > 8 && (beats * 60) / bpm > limit) beats /= 2;
  const window = (beats * 60) / bpm;
  if (window > limit) return null;
  const cueA = Math.min(out.audioEnd - 0.85 * window, out.duration - window);
  if (cueA - PRE_S < out.leadIn) return null;
  return { style: 'fade', locked: false, beats, bpmA: bpm, bpmB: bpm, cueA, cueB: Math.max(0, inc.leadIn - 0.05), pitch: 0, pre: PRE_S, window, post: POST_S };
}

/**
 * Tempos too far apart to stretch: a short exit with both tracks at their
 * own speed, ending on the outgoing track's last downbeat. Mostly an echo,
 * sometimes a spinback or a turntable brake; into a much quieter track, a
 * reverb melt.
 */
function exit(out: TransitionProfile, inc: TransitionProfile, grid: BeatGrid, f: BeatFeatures | null, bpm: number, lift: number, limit: number, r: number): MixPlan | null {
  const style: MixStyle = lift <= -6 ? 'melt' : r < 0.7 ? 'echo' : r < 0.85 ? 'spinback' : 'brake';
  const beats = style === 'melt' ? 16 : 8;
  const window = (beats * 60) / bpm;
  if (window > limit) return null;
  const cueA = lastDownbeat(grid, f, out.audioEnd - window);
  if (cueA - PRE_S < out.leadIn) return null;
  return { style, locked: false, beats, bpmA: bpm, bpmB: bpm, cueA, cueB: Math.max(0, inc.leadIn - 0.05), pitch: 0, pre: PRE_S, window, post: TAIL_S };
}

/**
 * DJ moves on top of the simulated choice: into a louder track or a drop,
 * sometimes a noise riser or a loop roll; a long DJ mix sometimes teases
 * the incoming track in first.
 */
function flourish(style: MixStyle, lift: number, drop: boolean, beats: number, r: number): MixStyle {
  if ((lift >= 3 || drop) && r < 0.4) return r < 0.25 ? 'rise' : 'roll';
  if (style === 'djmix' && beats >= 32 && r >= 0.8) return 'tease';
  return style;
}

/** Blend styles the simulation plays for every candidate pair. */
const SIM_STYLES = ['djmix', 'djdrop', 'blend', 'fade', 'wave', 'melt', 'bomb', 'beatmix', 'storm', 'signature'] as const;
/** Simulated terms: bass overlap, beats without bass, chord clash, level jumps, two voices, clutter. */
const SIM_TERMS = 6;
const [BASS, GAP, HARM, LEVEL, VOICE, CLUTTER] = [0, 1, 2, 3, 4, 5];

/** A small preference for the DJ standard; the drop swap only without a penalty when there is a drop to land on. */
function stylePrior(style: MixStyle, drop: boolean): number {
  if (style === 'djmix') return 0;
  if (style === 'djdrop') return drop ? 0 : 0.05;
  return style === 'blend' || style === 'bomb' ? 0.03 : 0.05;
}

/** Amplitude gain on the low, mid and high bands of one side, with the filters' effect on each band. */
function bandGains(c: Controls): [number, number, number] {
  const lpc = LP_CLOSED_HZ * (20000 / LP_CLOSED_HZ) ** c.lp;
  const hpc = HP_CLOSED_HZ * (20 / HP_CLOSED_HZ) ** c.hp;
  const at = (fc: number, band: number): number => (c.vol * band) / Math.sqrt(1 + (fc / lpc) ** 4) / Math.sqrt(1 + (hpc / fc) ** 4);
  return [at(100, c.low), at(900, c.mid), at(6000, c.high)];
}

/** Per style and window beat: band gains of the outgoing [0..2] and incoming [3..5] track. */
const gainTables = new Map<number, Map<MixStyle, number[][]>>();
function gainTable(beats: number): Map<MixStyle, number[][]> {
  let table = gainTables.get(beats);
  if (table) return table;
  table = new Map();
  for (const style of SIM_STYLES) {
    const rows: number[][] = [];
    for (let k = 0; k < beats; k++) {
      const u = (k + 0.5) / beats;
      rows.push([...bandGains(controls(style, 'out', u, 1 / beats)), ...bandGains(controls(style, 'in', u, 1 / beats))]);
    }
    table.set(style, rows);
  }
  gainTables.set(beats, table);
  return table;
}

/** Roughness of two intervals sounding together, by interval class: seconds and the tritone grate, thirds and fifths blend. */
const DISSONANCE = [0, 1, 0.55, 0.2, 0.12, 0.08, 0.75];
/** Roughness of two pitch-class profiles together, the second shifted `shift` semitones. */
function chordClash(a: Float64Array, b: Float64Array, shift: number): number {
  let d = 0;
  for (let x = 0; x < 12; x++) {
    if ((a[x] ?? 0) < 0.01) continue;
    for (let y = 0; y < 12; y++) {
      const ic = (((x - y - shift) % 12) + 12) % 12;
      d += (a[x] ?? 0) * (b[y] ?? 0) * (DISSONANCE[Math.min(ic, 12 - ic)] ?? 0);
    }
  }
  return d;
}

/**
 * Phrase lines: dance music changes every 8 bars, so both ends of a mix
 * should sit on one (4 at worst). Counted from the nearest section start,
 * or from the first downbeat when none was found. 0 on an 8-bar line, ½ on
 * a 4-bar one, 1 elsewhere.
 */
function phraseCost(f: BeatFeatures, i: number): number {
  let anchor = f.downbeat;
  for (const s of f.sections) if (Math.abs(s - i) < Math.abs(anchor - i)) anchor = s;
  const r = (((i - anchor) % 32) + 32) % 32;
  return r === 0 ? 0 : r % 16 === 0 ? 0.5 : 1;
}

interface Cues {
  cueA: number;
  cueB: number;
  beats: number;
  /** The window ends on a drop / a new section of the incoming track. */
  drop: boolean;
  section: boolean;
  /** Blend styles for this pair, best first. */
  ranked: { style: MixStyle; score: number }[];
  /** Key shift worth applying (semitones), 0 for none. */
  pitch: number;
}

/**
 * Every pair of downbeats (outgoing region ending in the last quarter,
 * incoming starting in the first fifth) and every length is scored on
 * timbre and chroma distance, loudness, harmonic change balance, whether
 * the outgoing region starts on a section (its outro) and the incoming one
 * ends on a section or a drop, phrase lines, how much of either track it
 * skips, and the best simulated style. Each term is scaled to 0..1 over all
 * candidates; the lowest weighted mean wins, with a prior towards the
 * preferred length and an absolute cost for overlapping two full
 * arrangements or two voices.
 */
export function pickCues(
  out: TransitionProfile,
  inc: TransitionProfile,
  A: BeatFeatures,
  B: BeatFeatures,
  bpmA: number,
  bpmB: number,
  rawB: number,
  fit: Compatibility,
  limit: number,
): Cues | null {
  // Incoming beats per shared beat (2 or 0.5 when its tempo was folded).
  const stepB = rawB / bpmB;
  const changeA = changeRate(A);
  const changeB = changeRate(B);
  const isDown = (f: BeatFeatures, i: number): boolean => (((i - f.downbeat) % 4) + 4) % 4 === 0;
  const ks = keyShift(A.key, B.key);
  const tryPitch = fit.key < 0.6 && ks !== 0 && Math.abs(ks) <= 3 && fit.tempo >= 0.5;
  const shift = tryPitch ? ks : 0;
  // Level the floor hears: bass counts less, as the ear does.
  const level = (f: BeatFeatures, b: number, g0 = 1, g1 = 1, g2 = 1): number =>
    0.25 * (f.bands[0][b] ?? 0) * g0 + (f.bands[1][b] ?? 0) * g1 + (f.bands[2][b] ?? 0) * g2;
  type Candidate = { i: number; j: number; bars: number; c: number[]; sims: Float64Array; drop: boolean; section: boolean };
  const candidates: Candidate[] = [];
  for (const bars of fit.weak ? [2] : [2, 4, 8, 16]) {
    const n = bars * 4;
    if (windowSeconds(n, bpmA, bpmB) > limit) continue;
    const nB = Math.round(n * stepB);
    const gains = gainTable(n);
    for (let i = 0; i + n < A.times.length; i++) {
      const endA = A.times[i + n] ?? Infinity;
      if (!isDown(A, i) || endA > out.audioEnd + 0.05 || endA < OUT_REGION * out.duration) continue;
      let refA = 0;
      let na = 0;
      for (let k = Math.max(0, i - 8); k < i; k++, na++) refA += level(A, k);
      refA = na ? refA / na : level(A, i);
      for (let j = 0; j + nB < B.times.length; j++) {
        const startB = B.times[j] ?? 0;
        if (startB < inc.leadIn - 0.05) continue;
        if (startB > Math.max(IN_REGION * inc.duration, inc.leadIn + (4 * 60) / bpmB)) break;
        if (!isDown(B, j)) continue;
        const je = j + nB;
        let refB = 0;
        let nb = 0;
        for (let k = je; k < Math.min(B.times.length, je + 8); k++, nb++) refB += level(B, k);
        refB = nb ? refB / nb : level(B, je - 1);
        const lA = Math.log(refA + 1e-9);
        const lB = Math.log(refB + 1e-9);
        let timbre = 0;
        let harmony = 0;
        let quiet = 0;
        let balance = 0;
        const sims = new Float64Array(SIM_STYLES.length * SIM_TERMS);
        for (let k = 0; k < n; k++) {
          const ka = i + k;
          const kb = j + Math.floor(k * stepB);
          timbre += distance(A.timbre[ka]!, B.timbre[kb]!);
          harmony += distance(A.chroma[ka]!, B.chroma[kb]!);
          quiet += 2 - (A.loud[ka] ?? 0) - (B.loud[kb] ?? 0);
          // Harmony should settle in one track while it moves in the other.
          balance += 1 - Math.abs((changeA[ka] ?? 0) - (1 - (changeB[kb] ?? 0)));
          const clash = chordClash(A.chroma[ka]!, B.chroma[kb]!, shift);
          const u = (k + 0.5) / n;
          const expected = lA * (1 - u) + lB * u;
          for (let s = 0; s < SIM_STYLES.length; s++) {
            const q = gains.get(SIM_STYLES[s]!)![k]!;
            const o = s * SIM_TERMS;
            const aL = (A.bass[ka] ?? 0) * q[0]!;
            const bL = (B.bass[kb] ?? 0) * q[3]!;
            sims[o + BASS]! += Math.min(aL, bL);
            const most = Math.max(aL, bL);
            if (most < 0.35) sims[o + GAP]! += 0.35 - most;
            sims[o + HARM]! += (A.tonal[ka] ?? 0) * q[1]! * (B.tonal[kb] ?? 0) * q[4]! * clash;
            // Two voices at once is the classic train wreck, worse than clashing chords.
            sims[o + VOICE]! += (A.voice[ka] ?? 0) * Math.min(1, q[1]! + q[2]!) * (B.voice[kb] ?? 0) * Math.min(1, q[4]! + q[5]!);
            // Clutter: both arrangements audibly full at once (notes or a lead through the mids and highs).
            sims[o + CLUTTER]! += Math.min(
              (Math.min(1, Math.max(A.tonal[ka] ?? 0, A.voice[ka] ?? 0)) * (q[1]! + q[2]!)) / 2,
              (Math.min(1, Math.max(B.tonal[kb] ?? 0, B.voice[kb] ?? 0)) * (q[4]! + q[5]!)) / 2,
            );
            const e = level(A, ka, q[0]! ** 2, q[1]! ** 2, q[2]! ** 2) + level(B, kb, q[3]! ** 2, q[4]! ** 2, q[5]! ** 2);
            sims[o + LEVEL]! += Math.abs(Math.log(e + 1e-9) - expected);
          }
        }
        // Clutter, chord clash and two voices count in total over the overlap
        // (per 4 bars): 16 bars of two full songs is far worse than 2. Bass,
        // missing bass and level jumps are about any moment, so per beat.
        for (let s = 0; s < SIM_STYLES.length; s++) {
          const o = s * SIM_TERMS;
          for (const t of [BASS, GAP, LEVEL]) sims[o + t]! /= n;
          for (const t of [HARM, VOICE, CLUTTER]) sims[o + t]! /= 16;
        }
        const drop = B.drops.has(je);
        const section = B.sections.has(je);
        const skipped = Math.max(0, out.audioEnd - endA) / (0.25 * out.duration) + Math.max(0, startB - inc.leadIn) / (0.2 * inc.duration);
        candidates.push({
          i,
          j,
          bars,
          drop,
          section,
          sims,
          // Weighted: timbre, chroma, quietness, balance, drop, sections, skipped, phrase.
          c: [
            timbre / n,
            harmony / n,
            quiet / n,
            1 - balance / n,
            drop ? 0 : 1,
            (A.sections.has(i) ? 0 : 1) + (section ? 0 : 1),
            skipped,
            phraseCost(A, i) + phraseCost(B, je),
          ],
        });
      }
    }
  }
  if (!candidates.length) return null;

  // Simulated terms are scaled over every candidate and style together, then
  // each candidate keeps its styles' scores.
  const range = (get: (c: Candidate, k: number) => Iterable<number>): ((v: number) => number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [k, c] of candidates.entries()) {
      for (const v of get(c, k)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    // A term that doesn't really vary (rounding only) must not decide anything.
    const varies = hi - lo > 1e-6 * Math.max(1, Math.abs(hi));
    return (v) => (varies ? (v - lo) / (hi - lo) : 0);
  };
  const simScale = Array.from({ length: SIM_TERMS }, (_, t) => range((c) => SIM_STYLES.map((_, s) => c.sims[s * SIM_TERMS + t]!)));
  const styleScore = (c: Candidate, s: number): number => {
    const o = s * SIM_TERMS;
    const v = (t: number): number => simScale[t]!(c.sims[o + t]!);
    return (1.5 * v(BASS) + 2 * v(GAP) + 1.5 * v(HARM) + v(LEVEL) + 2.5 * v(VOICE) + 2.5 * v(CLUTTER)) / 11 + stylePrior(SIM_STYLES[s]!, c.drop);
  };
  const ranked = candidates.map((c) =>
    SIM_STYLES.map((style, s) => ({ style: style as MixStyle, score: styleScore(c, s), s })).sort((p, q) => p.score - q.score),
  );
  const WEIGHTS = [1, 0.5, 0.5, 0.5, 1, 1.5, 1.5, 1];
  const scales = WEIGHTS.map((_, t) => range((c) => [c.c[t]!]));
  const simBest = range((_, k) => [ranked[k]![0]!.score]);
  let best = 0;
  let bestScore = Infinity;
  candidates.forEach((c, k) => {
    const top = ranked[k]![0]!;
    const o = top.s * SIM_TERMS;
    const terms = WEIGHTS.reduce((sum, w, t) => sum + w * scales[t]!(c.c[t]!), 0);
    // On top of the relative scores, an absolute cost of real clutter and two
    // voices: when every option overlaps two full songs, keep it short.
    const score = (terms + 4 * simBest(top.score)) / 11.5 + 0.05 * Math.abs(Math.log2(c.bars / fit.bars)) + 0.12 * c.sims[o + CLUTTER]! + 0.25 * c.sims[o + VOICE]!;
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  });
  const c = candidates[best]!;
  const n = c.bars * 4;
  // A key shift is only worth its artefacts when the chosen region's chords
  // would clash without it.
  let pitch = 0;
  if (tryPitch) {
    const q = gainTable(n).get(ranked[best]![0]!.style)!;
    let clash = 0;
    for (let k = 0; k < n; k++) {
      const ka = c.i + k;
      const kb = c.j + Math.floor(k * stepB);
      clash += (A.tonal[ka] ?? 0) * q[k]![1]! * (B.tonal[kb] ?? 0) * q[k]![4]! * chordClash(A.chroma[ka]!, B.chroma[kb]!, 0);
    }
    if (simScale[HARM]!(clash / 16) >= 0.25) pitch = ks;
  }
  return {
    cueA: A.times[c.i]!,
    cueB: B.times[c.j]!,
    beats: n,
    drop: c.drop,
    section: c.section,
    ranked: ranked[best]!.map(({ style, score }) => ({ style, score })),
    pitch,
  };
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
// What club DJs do by hand: faders on eased curves, like a hand on a fader.
const rideOut: Lane = (u) => ({ vol: smooth(down(u, 0.75, 1)) });
const rideIn: Lane = (u) => ({ vol: smooth(up(u, 0, 0.25)) });
/**
 * DJ swap: the incoming track comes in with its bass killed and mids 8 dB
 * down; the bass lines swap in the last quarter beat before the downbeat at
 * `at`, so that downbeat's kick is the new one; then the mids trade.
 */
const djSwap = (at: number): [Lane, Lane] => [
  (u, beat) => ({ low: down(u, at - beat / 4, at - beat / 32), mid: 1 - 0.6 * up(u, 0.5, 0.75) }),
  (u, beat) => ({ low: up(u, at - beat / 4, at - beat / 32), mid: 0.4 + 0.6 * up(u, 0.5, 0.75) }),
];
/**
 * Tease: through the first half the incoming track is let in only on the
 * last beat of every second bar (every bar on short windows), like a DJ
 * tapping the fader; from the midpoint its fader stays up.
 */
const teaseIn: Lane = (u, beat) => {
  if (u >= 0.5) return { vol: 1 };
  const n = Math.round(1 / beat);
  const k = n >= 32 ? 8 : 4;
  const b = u * n + 1e-6;
  const i = Math.floor(b);
  const ph = b - i;
  if (i % k !== k - 1) return { vol: 0 };
  return { vol: i === n / 2 - 1 ? Math.min(1, ph / 0.04) : Math.min(1, ph / 0.04, (1 - ph) / 0.04) };
};

const RECIPES: Record<MixStyle, Recipe> = {
  // Bass killed and mids down on the way in, bass swap before the midpoint downbeat, mids trade, outgoing fader last.
  djmix: { out: [rideOut, djSwap(0.5)[0]], in: [rideIn, djSwap(0.5)[1]] },
  // The same, with the incoming bass held back for the drop at the window's end.
  djdrop: { out: [rideOut, djSwap(1)[0]], in: [rideIn, djSwap(1)[1]] },
  // Taps of the incoming track, then a full DJ swap.
  tease: { out: [rideOut, djSwap(0.5)[0]], in: [teaseIn, djSwap(0.5)[1]] },
  // Equal-power crossfade over the whole window.
  fade: { out: [curvyOut], in: [curvyIn] },
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
  // On the last beat the outgoing record is pulled backwards by hand and let go.
  spinback: { out: [(u) => ({ verb: u < 1 ? 0.4 * up(u, 0.85, 1) : 0 })], in: [cutIn] },
  // Classic beat mix: tempos matched, linear crossfade.
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
 */
export function controls(style: MixStyle, side: 'out' | 'in', u: number, beat: number): Controls {
  if (side === 'out' && u > 1) return { ...NEUTRAL, vol: 0 };
  if (side === 'in' && u < 0) return { ...NEUTRAL, vol: 0 };
  const x = clamp01(u);
  const c = { ...NEUTRAL };
  for (const lane of RECIPES[style][side]) Object.assign(c, lane(x, beat));
  // Filters ease in and out of a sweep: a linear start is heard as a jolt.
  c.lp = smooth(c.lp);
  c.hp = smooth(c.hp);
  return c;
}
