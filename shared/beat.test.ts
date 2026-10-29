import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatGrid, beatShift, type BeatGrid } from './beat.ts';

const RATE = 8000;

/** Kick-like thumps (decaying 60 Hz) every `period` s from `phase`, over noise. */
function clicks(seconds: number, period: number, phase: number, noise = 0.02): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let seed = 1;
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = noise * rand();
  for (let t = phase; t < seconds; t += period) {
    const at = Math.round(t * RATE);
    for (let i = 0; i < 0.12 * RATE && at + i < out.length; i++) {
      out[at + i] = (out[at + i] ?? 0) + Math.sin((2 * Math.PI * 60 * i) / RATE) * Math.exp(-i / (0.03 * RATE));
    }
  }
  return out;
}

const near = (a: number, b: number, eps: number): void => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
/** Distance from t to the nearest beat of the grid. */
const offGrid = (g: BeatGrid, t: number): number => {
  const x = (((t - g.phase) % g.period) + g.period) % g.period;
  return Math.min(x, g.period - x);
};

test('finds tempo and phase of a steady beat', () => {
  const g = beatGrid(clicks(20, 0.5, 0.13), RATE, 100);
  assert.ok(g);
  near(g.period, 0.5, 0.004);
  near(offGrid(g, 100.13), 0, 0.012);
  assert.ok(g.confidence > 0.25);
});

test('128 BPM is not mistaken for half or double', () => {
  const g = beatGrid(clicks(20, 60 / 128, 0.05), RATE);
  assert.ok(g);
  near(g.period, 60 / 128, 0.004);
});

test('no beat in noise', () => {
  assert.equal(beatGrid(clicks(20, 100, 50, 0.3), RATE), null);
});

test('shift lands the first incoming beat on an outgoing beat', () => {
  const out = { period: 0.5, phase: 200.1, confidence: 1 };
  const inc = { period: 0.5, phase: 0.37, confidence: 1 };
  const d = beatShift(out, inc, 210, 0, 6);
  assert.ok(d !== null && Math.abs(d) <= 0.25);
  near(offGrid(out, 210 + d + 0.37), 0, 1e-9);
});

test('half and double tempo lock; unrelated tempos do not', () => {
  const out = { period: 0.5, phase: 0, confidence: 1 };
  assert.notEqual(beatShift(out, { period: 1, phase: 0.2, confidence: 1 }, 10, 0, 6), null);
  assert.notEqual(beatShift(out, { period: 0.25, phase: 0.1, confidence: 1 }, 10, 0, 6), null);
  assert.equal(beatShift(out, { period: 0.6, phase: 0, confidence: 1 }, 10, 0, 6), null);
  // 2% apart drifts ~120 ms over 6 s: not locked.
  assert.equal(beatShift(out, { period: 0.51, phase: 0, confidence: 1 }, 10, 0, 6), null);
});
