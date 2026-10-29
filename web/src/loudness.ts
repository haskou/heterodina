import type { Loudness } from '../../shared/types.ts';

/**
 * Linear gain that brings a track to Plex's reference loudness without
 * pushing its peak past full scale. Unknown loudness plays untouched.
 */
export function normalizationGain(loudness: Loudness | null, mode: 'track' | 'album' = 'track'): number {
  if (!loudness) return 1;
  const db = mode === 'album' ? loudness.albumGainDb : loudness.gainDb;
  const peak = mode === 'album' ? loudness.albumPeak : loudness.peak;
  const gain = 10 ** (db / 20);
  return peak > 0 ? Math.min(gain, 1 / peak) : gain;
}

/** Perceptual volume curve for a 0..1 slider. */
export function volumeCurve(v: number): number {
  const x = Math.min(Math.max(v, 0), 1);
  return x * x;
}
