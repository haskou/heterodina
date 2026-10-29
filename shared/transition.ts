// Decides how one track hands over to the next. Pure: the engine turns a
// plan into AudioContext automation.

import type { Track, TransitionProfile } from './types.ts';

export type FadeShape = 'in' | 'out';

export interface Fade {
  /** Start, in seconds of that track's own timeline. */
  at: number;
  duration: number;
}

export interface TransitionPlan {
  kind: 'gapless' | 'crossfade' | 'skip';
  /** Outgoing-track time at which the incoming track starts sounding. */
  start: number;
  /** Where in the incoming file playback begins (skips leading silence). */
  inOffset: number;
  /** Outgoing fade to silence (equal-power), or null to let it play out. */
  outFade: Fade | null;
  /** Incoming fade from silence (equal-power), or null to start at full level. */
  inFade: Fade | null;
  /** Outgoing-track time at which the outgoing source is stopped. */
  outStop: number;
  /**
   * Bass hand-over, in outgoing-track time: the incoming track enters with
   * its low end cut and the two swap bass here (like a DJ's EQ blend), so
   * two basslines and kicks never stack into mud. Null = flat EQ.
   */
  bassSwap: Fade | null;
}

/** Longest overlap we ever allow, in seconds. */
const MAX_OVERLAP = 12;
/** An outro this long or longer is a natural fade-out; the crossfade spans it. */
const NATURAL_OUTRO = 2.5;
/** Manual skip: quick but click-free. */
const SKIP_FADE = 0.6;
/** Crossfade length when the outgoing track has no fade-out of its own. */
const CROSSFADE = 6;
/** Blends shorter than this are too quick for a bass hand-over. */
const MIN_BASS_SWAP = 3;
/** How long the bass hand-over takes without a beat grid (s). */
const BASS_SWAP = 1;
/** Floor for very short tracks, so the seam never clicks or gaps. */
const SPLICE = 0.15;

export function profileOf(track: Track): TransitionProfile {
  const duration = track.durationMs / 1000;
  return track.transition ?? { duration, leadIn: 0, audioEnd: duration, introEnd: 0, outroStart: duration - 3 };
}

/** True when `b` is the track right after `a` on the same album. */
export function isContiguous(a: Track, b: Track): boolean {
  if (!a.albumId || a.albumId !== b.albumId) return false;
  return (b.disc === a.disc && b.index === a.index + 1) || (b.disc === a.disc + 1 && b.index === 1);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export function planGapless(out: TransitionProfile): TransitionPlan {
  return { kind: 'gapless', start: out.duration, inOffset: 0, outFade: null, inFade: null, outStop: out.duration, bassSwap: null };
}

/**
 * Automatic transition at the natural end of `out`, like Spotify's
 * crossfade: for the last N seconds of audio both tracks sound together,
 * the outgoing one fading out while the incoming one fades in. N is chosen
 * per pair instead of being a setting: a natural fade-out sets it, else a
 * fixed default. Leading and trailing silence never count.
 */
export function planCrossfade(out: TransitionProfile, inc: TransitionProfile): TransitionPlan {
  const outEnd = out.audioEnd;
  const inOffset = Math.max(0, inc.leadIn - 0.05);
  const outroLen = Math.max(0, outEnd - out.outroStart);
  const limit = Math.min(
    MAX_OVERLAP,
    0.3 * Math.max(0, out.audioEnd - out.leadIn),
    0.5 * Math.max(0, inc.audioEnd - inc.leadIn),
  );
  let overlap = outroLen >= NATURAL_OUTRO ? clamp(outroLen, CROSSFADE, MAX_OVERLAP) : CROSSFADE;
  overlap = Math.max(Math.min(overlap, limit), Math.min(SPLICE, limit));
  const start = outEnd - overlap;
  return {
    kind: 'crossfade',
    start,
    inOffset,
    outFade: { at: start, duration: overlap },
    inFade: { at: inOffset, duration: overlap },
    outStop: outEnd,
    bassSwap: overlap >= MIN_BASS_SWAP ? { at: start + overlap / 2 - BASS_SWAP / 2, duration: BASS_SWAP } : null,
  };
}

/** Manual skip at outgoing time `now`. */
export function planSkip(now: number, inc: TransitionProfile): TransitionPlan {
  const inOffset = Math.max(0, inc.leadIn - 0.05);
  return {
    kind: 'skip',
    start: now,
    inOffset,
    outFade: { at: now, duration: SKIP_FADE },
    inFade: { at: inOffset, duration: SKIP_FADE / 2 },
    outStop: now + SKIP_FADE,
    bassSwap: null,
  };
}

/** Moves a plan so it starts no earlier than outgoing time `earliest`, shrinking overlaps to fit. */
export function fitPlan(plan: TransitionPlan, earliest: number): TransitionPlan {
  if (plan.start >= earliest) return plan;
  const room = Math.max(plan.outStop - earliest, SPLICE);
  const outStop = earliest + room;
  const at = Math.max(plan.outFade?.at ?? earliest, earliest);
  return {
    ...plan,
    start: earliest,
    outFade: { at, duration: Math.max(Math.min(plan.outFade?.duration ?? room, outStop - at), 0.05) },
    inFade: plan.inFade && { at: plan.inFade.at, duration: Math.min(plan.inFade.duration, room) },
    outStop,
    // Squeezed by a late start: keep the bass swap only if it still fits.
    bassSwap: plan.bassSwap && plan.bassSwap.at >= earliest && plan.bassSwap.at + plan.bassSwap.duration <= outStop ? plan.bassSwap : null,
  };
}

/**
 * Moves a crossfade by `delta` seconds (beat alignment) without running
 * past the outgoing file. With `beat`, the bass swap snaps to the beat
 * nearest the middle of the blend and takes one beat.
 */
export function shiftPlan(plan: TransitionPlan, delta: number, outDuration: number, beat?: { phase: number; period: number }): TransitionPlan {
  if (plan.kind !== 'crossfade') return plan;
  const start = plan.start + delta;
  const outStop = Math.min(plan.outStop + delta, outDuration);
  const overlap = outStop - start;
  let bassSwap = plan.bassSwap && { at: plan.bassSwap.at + delta, duration: plan.bassSwap.duration };
  if (bassSwap && beat) {
    const mid = start + overlap / 2;
    const at = beat.phase + Math.round((mid - beat.phase) / beat.period) * beat.period;
    bassSwap = { at: at - beat.period / 2, duration: beat.period };
  }
  if (bassSwap && (bassSwap.at < start || bassSwap.at + bassSwap.duration > outStop)) bassSwap = null;
  return {
    ...plan,
    start,
    outFade: plan.outFade && { at: start, duration: overlap },
    inFade: plan.inFade && { at: plan.inFade.at, duration: overlap },
    outStop,
    bassSwap,
  };
}

/** Equal-power gain curve: sin for fade-in, cos for fade-out. Constant power for uncorrelated material. */
export function fadeCurve(shape: FadeShape, points = 128): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    curve[i] = shape === 'in' ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
  }
  return curve;
}
