import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime } from './format.ts';
import { normalizationGain, volumeCurve } from './loudness.ts';

test('normalizationGain applies track gain in dB', () => {
  const g = normalizationGain({ gainDb: -6, albumGainDb: -3, peak: 0.5, albumPeak: 0.5 });
  assert.ok(Math.abs(g - 10 ** (-6 / 20)) < 1e-9);
});

test('normalizationGain can use album gain', () => {
  const g = normalizationGain({ gainDb: -6, albumGainDb: -3, peak: 0.5, albumPeak: 0.5 }, 'album');
  assert.ok(Math.abs(g - 10 ** (-3 / 20)) < 1e-9);
});

test('normalizationGain never boosts the peak past full scale', () => {
  assert.equal(normalizationGain({ gainDb: 12, albumGainDb: 12, peak: 0.8, albumPeak: 0.8 }), 1 / 0.8);
});

test('normalizationGain is neutral without analysis', () => {
  assert.equal(normalizationGain(null), 1);
});

test('volumeCurve is clamped and quadratic', () => {
  assert.equal(volumeCurve(-1), 0);
  assert.equal(volumeCurve(0.5), 0.25);
  assert.equal(volumeCurve(2), 1);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(75.9), '1:15');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(Number.NaN), '0:00');
});
