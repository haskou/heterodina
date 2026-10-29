import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fadeCurve, fitPlan, isContiguous, planCrossfade, planGapless, planSkip, shiftPlan } from './transition.ts';
import type { Track, TransitionProfile } from './types.ts';

const profile = (p: Partial<TransitionProfile> & { duration: number }): TransitionProfile => ({
  leadIn: 0,
  audioEnd: p.duration,
  introEnd: 0,
  outroStart: p.duration,
  ...p,
});

const close = (a: number, b: number, tol = 1e-6): void => assert.ok(Math.abs(a - b) <= tol, `expected ~${b}, got ${a}`);

test('natural fade-out: the crossfade spans it, both sides at once', () => {
  const out = profile({ duration: 240, audioEnd: 238, outroStart: 230 }); // 8 s fade
  const inc = profile({ duration: 200, leadIn: 0.5, introEnd: 0.6 });
  const p = planCrossfade(out, inc);
  close(p.start, 230);
  close(p.inOffset, 0.45);
  assert.deepEqual(p.inFade, { at: 0.45, duration: 8 });
  assert.deepEqual(p.outFade, { at: 230, duration: 8 });
  close(p.outStop, 238);
});

test('no fade-out of its own: 6 s symmetric crossfade, silence trimmed', () => {
  const out = profile({ duration: 180, audioEnd: 179.6, outroStart: 179.4 });
  const inc = profile({ duration: 200, leadIn: 1, introEnd: 1.2 });
  const p = planCrossfade(out, inc);
  close(p.start, 179.6 - 6);
  close(p.inOffset, 0.95);
  assert.deepEqual(p.outFade, { at: 179.6 - 6, duration: 6 });
  assert.deepEqual(p.inFade, { at: 0.95, duration: 6 });
});

test('a very long fade-out is capped at 12 s', () => {
  const out = profile({ duration: 300, audioEnd: 300, outroStart: 270 });
  const p = planCrossfade(out, profile({ duration: 200 }));
  close(p.start, 288);
});

test('both sides always overlap by seconds, never a gap', () => {
  const shapes = [
    profile({ duration: 200, audioEnd: 199, outroStart: 199 }),
    profile({ duration: 200, audioEnd: 195, outroStart: 185 }),
    profile({ duration: 200, audioEnd: 200, outroStart: 198.5 }),
  ];
  const intros = [profile({ duration: 200 }), profile({ duration: 200, introEnd: 6 }), profile({ duration: 200, leadIn: 2, introEnd: 2.2 })];
  for (const out of shapes) {
    for (const inc of intros) {
      const p = planCrossfade(out, inc);
      assert.ok(out.audioEnd - p.start >= 4, `overlap ${out.audioEnd - p.start}`);
      // The outgoing track is not silenced before the incoming one starts.
      assert.ok((p.outFade?.at ?? 0) >= p.start - 1e-9);
    }
  }
});

test('overlap never exceeds 30% of a short outgoing track', () => {
  const out = profile({ duration: 10, audioEnd: 10, outroStart: 2 });
  const p = planCrossfade(out, profile({ duration: 200 }));
  assert.ok(10 - p.start <= 3 + 1e-9);
});

test('gapless plays the whole file, no fades, no trimming', () => {
  const p = planGapless(profile({ duration: 123.4, audioEnd: 120 }));
  assert.equal(p.start, 123.4);
  assert.equal(p.inOffset, 0);
  assert.equal(p.outFade, null);
  assert.equal(p.inFade, null);
});

test('skip: short fade starting now', () => {
  const p = planSkip(42, profile({ duration: 200, leadIn: 2 }));
  assert.equal(p.start, 42);
  close(p.inOffset, 1.95);
  assert.deepEqual(p.outFade, { at: 42, duration: 0.6 });
  close(p.outStop, 42.6);
});

test('fitPlan moves a late plan to now and keeps it within the outgoing audio', () => {
  const out = profile({ duration: 240, audioEnd: 238, outroStart: 228 });
  const p = fitPlan(planCrossfade(out, profile({ duration: 200 })), 236);
  assert.equal(p.start, 236);
  assert.ok((p.outFade?.at ?? 0) >= 236);
  assert.ok((p.outFade?.at ?? 0) + (p.outFade?.duration ?? 0) <= p.outStop + 1e-9);
  close(p.outStop, 238);
});

test('equal-power curves keep constant power', () => {
  const fin = fadeCurve('in', 33);
  const fout = fadeCurve('out', 33);
  for (let i = 0; i < 33; i++) close((fin[i] ?? 0) ** 2 + (fout[i] ?? 0) ** 2, 1, 1e-6);
});

test('isContiguous across tracks and discs', () => {
  const t = (albumId: string, disc: number, index: number): Track =>
    ({ albumId, disc, index }) as Track;
  assert.ok(isContiguous(t('a', 1, 3), t('a', 1, 4)));
  assert.ok(isContiguous(t('a', 1, 12), t('a', 2, 1)));
  assert.ok(!isContiguous(t('a', 1, 3), t('a', 1, 5)));
  assert.ok(!isContiguous(t('a', 1, 3), t('b', 1, 4)));
  assert.ok(!isContiguous(t('', 1, 3), t('', 1, 4)));
});

test('bass swaps mid-blend; beat shift moves the blend and snaps the swap to a beat', () => {
  const out = profile({ duration: 200, audioEnd: 199, outroStart: 198.5 });
  const plan = planCrossfade(out, profile({ duration: 180 }));
  assert.ok(plan.bassSwap && plan.bassSwap.at > plan.start && plan.bassSwap.at + plan.bassSwap.duration < plan.outStop);
  assert.equal(planGapless(out).bassSwap, null);
  assert.equal(planSkip(50, profile({ duration: 180 })).bassSwap, null);

  const shifted = shiftPlan(plan, 0.2, 200, { phase: 0.1, period: 0.5 });
  close(shifted.start, plan.start + 0.2);
  close(shifted.outStop, plan.outStop + 0.2);
  close(shifted.outFade?.duration ?? 0, plan.outStop - plan.start);
  // One beat long, centred on a beat.
  close(shifted.bassSwap?.duration ?? 0, 0.5);
  const centre = (shifted.bassSwap?.at ?? 0) + 0.25;
  close(((centre - 0.1) / 0.5) % 1, 0, 1e-9);
  // Never past the end of the file.
  assert.ok(shiftPlan(plan, 3, 200).outStop <= 200);
});
