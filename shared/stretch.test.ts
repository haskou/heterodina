import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stretch } from './stretch.ts';

const RATE = 8000;

function sine(seconds: number, hz: number): Float32Array {
  const out = new Float32Array(seconds * RATE);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

/** Upward zero crossings per second over x[a..b). */
function frequency(x: Float32Array, a: number, b: number): number {
  let n = 0;
  for (let i = a + 1; i < b; i++) if ((x[i - 1] ?? 0) < 0 && (x[i] ?? 0) >= 0) n++;
  return n / ((b - a) / RATE);
}

test('slope 1 reproduces the source past the first frame', () => {
  const src = sine(3, 220);
  const [out] = stretch([src], RATE, (t) => 1 + t, 1.5);
  assert.ok(out);
  assert.equal(out.length, 1.5 * RATE);
  let worst = 0;
  for (let i = 0.05 * RATE; i < 1.4 * RATE; i++) worst = Math.max(worst, Math.abs((out[i] ?? 0) - (src[RATE + i] ?? 0)));
  assert.ok(worst < 1e-4, `max error ${worst}`);
});

test('a faster map keeps the pitch and covers more source', () => {
  const src = sine(4, 220);
  const [out] = stretch([src], RATE, (t) => 0.5 + 1.08 * t, 2);
  assert.ok(out);
  const hz = frequency(out, 0.1 * RATE, 1.9 * RATE);
  assert.ok(Math.abs(hz - 220) < 3, `${hz} Hz`);
});

test('a gliding map keeps the pitch and the level', () => {
  const src = sine(5, 330);
  // Rate glides from 0.93 to 1.07.
  const [out] = stretch([src], RATE, (t) => 0.5 + 0.93 * t + 0.035 * t * t, 2);
  assert.ok(out);
  const hz = frequency(out, 0.1 * RATE, 1.9 * RATE);
  assert.ok(Math.abs(hz - 330) < 4, `${hz} Hz`);
  let peak = 0;
  for (let i = 0.1 * RATE; i < 1.9 * RATE; i++) peak = Math.max(peak, Math.abs(out[i] ?? 0));
  assert.ok(peak > 0.9 && peak < 1.1, `peak ${peak}`);
});

test('stereo channels move together', () => {
  const l = sine(3, 200);
  const r = l.map((v) => -v);
  const [a, b] = stretch([l, r], RATE, (t) => 0.5 + 1.05 * t, 1);
  assert.ok(a && b);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs((a[i] ?? 0) + (b[i] ?? 0)) < 1e-6);
});
