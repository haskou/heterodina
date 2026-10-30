import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BeatFeatures } from './features.ts';
import { compatibility, controls, foldTempo, keyShift, mixLength, pickCues, planMix, sourceA, sourceB, type MixPlan, type MixStyle, type Side } from './mix.ts';
import type { TransitionProfile } from './types.ts';

const profile = (duration: number, p: Partial<TransitionProfile> = {}): TransitionProfile => ({
  duration,
  leadIn: 0.2,
  audioEnd: duration - 0.5,
  introEnd: 5,
  outroStart: duration - 6,
  ...p,
});
const grid = (bpm: number, phase = 0.1, confidence = 0.4) => ({ period: 60 / bpm, phase, confidence });
const side = (bpm: number | null, confidence = 0.4): Side => ({ grid: bpm ? grid(bpm, 0.1, confidence) : null, features: null });
const even = { outEnd: -14, inStart: -14 };
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const fixed = (r: number) => () => r;
const ALL: MixStyle[] = [
  'djmix',
  'djdrop',
  'tease',
  'blend',
  'fade',
  'rise',
  'wave',
  'melt',
  'echo',
  'roll',
  'brake',
  'spinback',
  'beatmix',
  'bomb',
  'storm',
  'signature',
];

/** Flat features on a grid, with optional section starts and drops (beat indices). */
function features(
  bpm: number,
  from: number,
  beats: number,
  marks: { sections?: number[]; drops?: number[]; downbeat?: number; chord?: number[]; voice?: number; key?: BeatFeatures['key'] } = {},
): BeatFeatures {
  const times = Array.from({ length: beats }, (_, i) => from + (i * 60) / bpm);
  const flat = (): Float64Array => new Float64Array(12).fill(1 / 12);
  const chord = (): Float64Array => {
    const c = new Float64Array(12);
    for (const p of marks.chord ?? []) c[p] = 1 / marks.chord!.length;
    return c;
  };
  const each = (v: number): number[] => times.map(() => v);
  return {
    times,
    timbre: times.map(flat),
    chroma: times.map(marks.chord ? chord : flat),
    loud: each(0.8),
    bass: each(1),
    tonal: each(1),
    voice: each(marks.voice ?? 0),
    bands: [each(1), each(1), each(1)],
    downbeat: marks.downbeat ?? 0,
    key: marks.key ?? { root: 0, minor: false },
    sections: new Set(marks.sections ?? []),
    drops: new Set(marks.drops ?? []),
  };
}

test('folds half and double tempo to the nearest', () => {
  near(foldTempo(64, 126), 128);
  near(foldTempo(250, 124), 125);
  near(foldTempo(120, 118), 120);
});

test('compatibility: the tempo gap sets the length, an unsteady beat keeps it short', () => {
  const steady = side(120);
  assert.equal(compatibility(120, 121, steady, steady).bars, 16);
  assert.equal(compatibility(120, 130, steady, steady).bars, 8);
  assert.equal(compatibility(120, 120, side(120, 0.16), steady).bars, 2);
  assert.equal(compatibility(120, 120, side(120, 0.16), steady).weak, true);
});

test('key shift: semitones that move the incoming key onto the outgoing one', () => {
  assert.equal(keyShift({ root: 0, minor: false }, { root: 2, minor: false }), -2);
  assert.equal(keyShift({ root: 0, minor: false }, { root: 9, minor: true }), 0);
  assert.equal(keyShift({ root: 0, minor: false }, { root: 7, minor: false }), 5);
  assert.equal(keyShift({ root: 7, minor: false }, { root: 0, minor: false }), -5);
});

test('without a steady beat: a ten-second crossfade, each track at its own speed', () => {
  const a = profile(200);
  const b = profile(200, { leadIn: 0.8 });
  for (const m of [planMix(a, b, side(null), side(120), even), planMix(a, b, side(120, 0.1), side(120), even), planMix(a, b, side(120), side(null), even)]) {
    assert.ok(m);
    assert.equal(m.style, 'fade');
    assert.equal(m.locked, false);
    assert.equal(m.bpmB, m.bpmA);
    near(m.window, 8, 1e-9); // 16 beats at 120 BPM: the nearest to 10 s
    // From where the outgoing music ends (the window never runs past the track) into where the incoming music starts.
    near(m.cueA, Math.min(a.audioEnd - 0.85 * m.window, a.duration - m.window), 1e-9);
    near(m.cueB, 0.75);
    near(sourceB(m, m.pre + 1) - sourceB(m, m.pre), 1);
    near(sourceA(m, m.pre + 1) - sourceA(m, m.pre), 1);
  }
});

test('tempos more than 20% apart: a short exit, nothing stretched', () => {
  const a = profile(200);
  const b = profile(200, { leadIn: 0.8 });
  const seen = new Set<string>();
  for (let r = 0; r < 1; r += 0.05) {
    const m = planMix(a, b, side(120), side(150), even, fixed(r));
    assert.ok(m);
    assert.equal(m.locked, false);
    assert.equal(m.beats, 8);
    near(m.cueB, 0.75);
    seen.add(m.style);
  }
  assert.deepEqual([...seen].sort(), ['brake', 'echo', 'spinback']);
  assert.equal(planMix(a, b, side(120), side(150), { outEnd: -8, inStart: -16 })?.style, 'melt');
  // 12.5% is still stretched.
  assert.equal(planMix(a, b, side(120), side(135), even)?.locked, true);
});

test('locked without features: window ends on an outgoing beat at the end of the sound', () => {
  const a = profile(200);
  const b = profile(180, { leadIn: 1.03 });
  const m = planMix(a, b, side(120), { grid: grid(124, 0.25), features: null }, even, fixed(0.1));
  assert.ok(m);
  assert.equal(m.locked, true);
  near(m.bpmB, 124);
  near(((m.cueA - 0.1) / 0.5) % 1, 0, 1e-9);
  assert.ok(m.cueA + (m.beats * 60) / m.bpmA <= a.audioEnd + 1e-9);
  assert.ok(m.cueB >= b.leadIn - 0.01 && m.cueB < b.leadIn + 60 / 124);
});

test('short tracks get shorter windows, or none', () => {
  const m = planMix(profile(40), profile(200), side(120), side(120), even, fixed(0.1));
  assert.ok(m);
  assert.ok(m.window <= 0.35 * (40 - 0.5 - 0.2));
  assert.equal(planMix(profile(10), profile(200), side(120), side(120), even), null);
});

test('cue search: outgoing region in the last quarter, incoming in the first fifth, on downbeats, ending on a drop', () => {
  const out = profile(200);
  const inc = profile(200);
  // A: beats from 120 s to the end; B: from 0.2 s for 60 s, a drop on beat 36.
  const A = features(120, 120, 158, { downbeat: 2 });
  const B = features(120, 0.2, 120, { sections: [36], drops: [36] });
  const c = pickCues(out, inc, A, B, 120, 120, 120, compatibility(120, 120, side(120), side(120)), 30);
  assert.ok(c);
  const i = Math.round((c.cueA - 120) / 0.5);
  const j = Math.round((c.cueB - 0.2) / 0.5);
  assert.equal((i - 2) % 4, 0);
  assert.equal(j % 4, 0);
  assert.ok(c.cueA + (c.beats * 60) / 120 >= 0.75 * 200);
  assert.ok(c.cueB <= 0.2 * 200);
  // The drop is worth ending on.
  assert.equal(j + c.beats, 36);
  assert.equal(c.drop, true);
});

test('a planned mix ending on a drop holds the incoming bass for it', () => {
  const out = profile(200);
  const inc = profile(200);
  const a: Side = { grid: grid(120, 0), features: features(120, 120, 158) };
  const b: Side = { grid: grid(120, 0.2), features: features(120, 0.2, 120, { sections: [32], drops: [32] }) };
  const m = planMix(out, inc, a, b, even, fixed(0.05));
  assert.ok(m);
  assert.equal(m.style, 'rise');
  near(m.cueB + (m.beats * 60) / m.bpmB, 0.2 + 16);
  // Otherwise the simulated style lands it, keeping the same end.
  const plain = planMix(out, inc, a, b, even, fixed(0.5));
  assert.ok(plain);
  near(plain.cueB + (plain.beats * 60) / plain.bpmB, 0.2 + 16);
});

test('the simulation keeps two bass lines and two voices apart', () => {
  const out = profile(200);
  const inc = profile(200);
  const A = features(120, 120, 158, { voice: 1 });
  const B = features(120, 0.2, 120, { voice: 1 });
  const c = pickCues(out, inc, A, B, 120, 120, 120, compatibility(120, 120, side(120), side(120)), 30);
  assert.ok(c);
  // Full linear or equal-power crossfades overlap both all through: never the pick.
  assert.ok(!['fade', 'beatmix'].includes(c.ranked[0]!.style), c.ranked[0]!.style);
  const at = (s: MixStyle): number => c.ranked.findIndex((r) => r.style === s);
  assert.ok(at('djmix') < at('fade'));
  assert.ok(at('djmix') < at('beatmix'));
  // Two voices all through: as short as allowed.
  assert.equal(c.beats, 8);
});

test('clashing chords: the incoming track starts in the outgoing key', () => {
  const out = profile(200);
  const inc = profile(200);
  const cMajor = { root: 0, minor: false };
  const dMajor = { root: 2, minor: false };
  const A = features(120, 120, 158, { chord: [0, 4, 7], key: cMajor });
  const B = features(120, 0.2, 120, { chord: [2, 6, 9], key: dMajor });
  const steady = (f: BeatFeatures): Side => ({ grid: grid(120), features: f });
  const c = pickCues(out, inc, A, B, 120, 120, 120, compatibility(120, 120, steady(A), steady(B)), 30);
  assert.ok(c);
  assert.equal(c.pitch, -2);
  // Same key: nothing to shift.
  const same = features(120, 0.2, 120, { chord: [0, 4, 7], key: cMajor });
  assert.equal(pickCues(out, inc, A, same, 120, 120, 120, compatibility(120, 120, steady(A), steady(same)), 30)?.pitch, 0);
});

test('tease: the incoming track taps in on the last beat of every second bar, then stays', () => {
  const beat = 1 / 64;
  const vol = (b: number): number => controls('tease', 'in', (b + 0.5) * beat, beat).vol;
  for (let b = 0; b < 32; b++) assert.equal(vol(b) > 0.5, b % 8 === 7, `beat ${b}`);
  for (let b = 32; b < 64; b++) assert.equal(vol(b), 1);
});

const plan: MixPlan = { style: 'blend', locked: true, beats: 32, bpmA: 120, bpmB: 126, cueA: 150, cueB: 2, pitch: 0, pre: 0.5, window: (32 * 120) / 246, post: 0.5 };

test('both tracks play at their own speed outside the window and glide inside it', () => {
  near(sourceA(plan, 0), 149.5);
  near(sourceA(plan, 0.5), 150);
  const end = plan.pre + plan.window;
  near(sourceA(plan, end), 150 + 16);
  near(sourceB(plan, end), 2 + (32 * 60) / 126);
  near(sourceB(plan, mixLength(plan)) - sourceB(plan, end), plan.post);
  near((sourceA(plan, 0.501) - sourceA(plan, 0.5)) / 0.001, 1, 1e-3);
  near((sourceA(plan, end) - sourceA(plan, end - 0.001)) / 0.001, 126 / 120, 1e-3);
  near((sourceB(plan, end) - sourceB(plan, end - 0.001)) / 0.001, 1, 1e-3);
});

test('beats coincide all through the window', () => {
  for (let k = 0; k <= 32; k++) {
    let lo = plan.pre;
    let hi = plan.pre + plan.window;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (sourceA(plan, mid) < plan.cueA + (k * 60) / 120) lo = mid;
      else hi = mid;
    }
    near(sourceB(plan, lo), plan.cueB + (k * 60) / 126, 1e-6);
  }
});

test('a loop roll repeats ever shorter loops from the midpoint', () => {
  const roll: MixPlan = { ...plan, style: 'roll', beats: 16, bpmB: 120, window: 8 };
  const at = (beat: number): number => (sourceA(roll, roll.pre + beat * 0.5) - roll.cueA) / 0.5;
  near(at(4), 4, 1e-9);
  // Second half: 2-beat loop, then 1, then ½, then ¼.
  near(at(8.5), 8.5, 1e-9);
  near(at(9.5), 8 + (1.5 % 2), 1e-9);
  near(at(10.5), 8 + (0.5 % 1), 1e-9);
  near(at(12.25), 8 + (0.25 % 0.5), 1e-9);
});

test('outgoing is silent after the window, incoming before it, and each is itself at its edge', () => {
  for (const style of ALL) {
    assert.equal(controls(style, 'out', 1.01, 1 / 32).vol, 0);
    assert.equal(controls(style, 'in', -0.01, 1 / 32).vol, 0);
    const end = controls(style, 'in', 1.2, 1 / 32);
    assert.deepEqual([end.vol, end.low, end.mid, end.high, end.lp, end.hp], [1, 1, 1, 1, 1, 1], style);
    const start = controls(style, 'out', -0.2, 1 / 32);
    assert.deepEqual([start.vol, start.low, start.mid, start.high, start.lp, start.hp], [1, 1, 1, 1, 1, 1], style);
  }
});

test('never both basses up at once', () => {
  // Except the plain crossfade for music without a beat, which the simulation steers away from.
  for (const style of ALL.filter((s) => s !== 'fade')) {
    for (let u = 0; u <= 1; u += 0.01) {
      const a = controls(style, 'out', u, 1 / 32);
      const b = controls(style, 'in', u, 1 / 32);
      assert.ok(a.vol * a.low + b.vol * b.low <= 1.3, `${style} u=${u.toFixed(2)}`);
    }
  }
});

test('filter sweeps start and stop gently: no jump at the first step', () => {
  for (const style of ALL) {
    for (const side of ['out', 'in'] as const) {
      let prev = controls(style, side, 0, 1 / 32);
      for (let k = 1; k <= 100; k++) {
        const u = k / 100;
        const c = controls(style, side, u, 1 / 32);
        // Leaving fully open or fully closed, the first 1% of the window moves it by under 1%.
        for (const k of ['lp', 'hp'] as const) {
          if (prev[k] === 0 || prev[k] === 1) assert.ok(Math.abs(c[k] - prev[k]) < 0.01, `${style} ${side} ${k} u=${u.toFixed(2)}`);
        }
        prev = c;
      }
    }
  }
});
