import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLevels, flatProfile } from './analysis.ts';

const RATE = 10;
const sec = (n: number, v: number): number[] => Array.from({ length: Math.round(n * RATE) }, () => v);
const ramp = (n: number, from: number, to: number): number[] => {
  const len = Math.round(n * RATE);
  return Array.from({ length: len }, (_, i) => from + ((to - from) * i) / (len - 1));
};

const close = (actual: number, expected: number, tol = 0.35): void =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

test('trims leading and trailing silence', () => {
  const levels = [...sec(1, -39.9), ...sec(30, -10), ...sec(2, -39.9)];
  const p = analyzeLevels(levels, RATE, 33);
  close(p.leadIn, 1);
  close(p.audioEnd, 31);
  close(p.introEnd, 1);
  close(p.outroStart, 31);
});

test('detects a natural fade-out', () => {
  const levels = [...sec(60, -9), ...ramp(10, -9, -39), ...sec(1, -39.9)];
  const p = analyzeLevels(levels, RATE, 71);
  close(p.audioEnd, 70);
  // Body is -9 dB; the fade crosses -15 dB two seconds in.
  close(p.outroStart, 62, 0.5);
});

test('detects a quiet intro', () => {
  const levels = [...ramp(8, -35, -8), ...sec(60, -8)];
  const p = analyzeLevels(levels, RATE, 68);
  close(p.leadIn, 0);
  close(p.introEnd, 6.2, 0.5);
});

test('hard ending keeps outroStart at the end', () => {
  const levels = [...sec(40, -7), ...sec(0.3, -39.9)];
  const p = analyzeLevels(levels, RATE, 40.3);
  // Smoothing blurs the cut by a couple of samples at most.
  close(p.audioEnd - p.outroStart, 0, 0.3);
});

test('all silence or no data falls back to a flat profile', () => {
  assert.deepEqual(analyzeLevels(sec(5, -39.9), RATE, 5), flatProfile(5));
  assert.deepEqual(analyzeLevels([], RATE, 5), flatProfile(5));
});
