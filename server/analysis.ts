import type { TransitionProfile } from '../shared/types.ts';

/** Plex clamps its loudness curve at -40 LUFS; anything at the floor is silence. */
const SILENCE = -39.5;
/** A track is "at body level" within this many dB of its loud passages. */
const BODY_WINDOW_DB = 6;

/**
 * Derives a transition profile from Plex's per-stream loudness curve
 * (`/library/streams/{id}/levels`, one value per `1/rate` seconds).
 */
export function analyzeLevels(levels: number[], rate: number, duration: number): TransitionProfile {
  const n = levels.length;
  const first = levels.findIndex((v) => v > SILENCE);
  if (first < 0 || rate <= 0) return flatProfile(duration);
  let last = n - 1;
  while (last > first && (levels[last] ?? SILENCE) <= SILENCE) last--;

  const leadIn = first / rate;
  const audioEnd = Math.min((last + 1) / rate, duration);

  // Smooth over ~0.5 s so single transients don't count as "body".
  const half = Math.max(1, Math.round(rate / 4));
  const smooth = levels.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += levels[j] ?? SILENCE;
      count++;
    }
    return sum / count;
  });

  const audible = levels.slice(first, last + 1).filter((v) => v > SILENCE).sort((a, b) => a - b);
  const body = audible[Math.floor(audible.length * 0.75)] ?? SILENCE;
  const threshold = body - BODY_WINDOW_DB;

  let introIdx = first;
  while (introIdx < last && (smooth[introIdx] ?? SILENCE) < threshold) introIdx++;
  let outroIdx = last;
  while (outroIdx > introIdx && (smooth[outroIdx] ?? SILENCE) < threshold) outroIdx--;

  return {
    duration,
    leadIn,
    audioEnd,
    introEnd: Math.max(leadIn, introIdx / rate),
    outroStart: Math.min(audioEnd, (outroIdx + 1) / rate),
  };
}

/** How loud the start and the end of a track are, in dB (power mean). */
export interface Edges {
  /** The first EDGE_WINDOW seconds of sound. */
  start: number;
  /** The last EDGE_WINDOW seconds of sound: what plays while the next track comes in. */
  end: number;
}

/** About the length of a crossfade, plus the moments around it. */
const EDGE_WINDOW = 10;

/**
 * Loudness of the edges of a track. Comparing one track's end with the
 * next one's start tells whether they hand over smoothly (a loud ending
 * into a quiet intro does not, however well it is faded).
 */
export function edgeLoudness(levels: number[], rate: number, profile: TransitionProfile): Edges | null {
  if (!levels.length || rate <= 0) return null;
  const span = (from: number, to: number): number => {
    const a = Math.max(0, Math.floor(from * rate));
    const b = Math.min(levels.length, Math.max(a + 1, Math.ceil(to * rate)));
    let power = 0;
    for (let i = a; i < b; i++) power += 10 ** (Math.max(levels[i] ?? SILENCE, SILENCE) / 10);
    return 10 * Math.log10(power / (b - a));
  };
  return {
    start: span(profile.leadIn, profile.leadIn + EDGE_WINDOW),
    end: span(profile.audioEnd - EDGE_WINDOW, profile.audioEnd),
  };
}

/** Profile for tracks without analysis: no trimming, no known fades. */
export function flatProfile(duration: number): TransitionProfile {
  return { duration, leadIn: 0, audioEnd: duration, introEnd: 0, outroStart: duration };
}
