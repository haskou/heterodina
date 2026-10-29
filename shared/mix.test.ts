import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BeatFeatures } from './features.ts';
import { chooseStyle, compatibility, controls, foldTempo, mixLength, pickCues, planMix, sourceA, sourceB, type MixPlan, type MixStyle, type Side } from './mix.ts';
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
const ALL: MixStyle[] = ['blend', 'rise', 'wave', 'melt', 'echo', 'roll', 'brake', 'beatmix', 'bomb', 'storm', 'signature'];

/** Flat features on a grid, with optional section starts and drops (beat indices). */
function features(bpm: number, from: number, beats: number, marks: { sections?: number[]; drops?: number[]; downbeat?: number } = {}): BeatFeatures {
  const times = Array.from({ length: beats }, (_, i) => from + (i * 60) / bpm);
  const flat = (): Float64Array => new Float64Array(12).fill(1 / 12);
  return {
    times,
    timbre: times.map(flat),
    chroma: times.map(flat),
    loud: times.map(() => 0.8),
    downbeat: marks.downbeat ?? 0,
    key: { root: 0, minor: false },
    sections: new Set(marks.sections ?? []),
    drops: new Set(marks.drops ?? []),
  };
}

test('folds half and double tempo to the nearest', () => {
  near(foldTempo(64, 126), 128);
  near(foldTempo(250, 124), 125);
  near(foldTempo(120, 118), 120);
});

test('compatibility: close tempo and key overlap long, a clash or an unsteady beat short', () => {
  const steady = side(120);
  assert.equal(compatibility(120, 121, steady, steady).bars, 4); // unknown keys count as 0.75
  assert.equal(compatibility(120, 150, steady, steady).bars, 2);
  assert.equal(compatibility(120, 120, side(120, 0.16), steady).bars, 2);
});

test('without a steady, compatible beat nothing is stretched and the style hides the clash', () => {
  const a = profile(200);
  const b = profile(200, { leadIn: 0.8 });
  // 120 -> 135 BPM is 12.5%: too far to stretch.
  for (const m of [planMix(a, b, side(null), side(120), even), planMix(a, b, side(120, 0.1), side(120), even), planMix(a, b, side(120), side(135), even)]) {
    assert.ok(m);
    assert.equal(m.locked, false);
    assert.ok(['wave', 'melt', 'echo', 'brake'].includes(m.style), m.style);
    assert.equal(m.bpmB, m.bpmA);
    // The incoming track plays at its own speed from where its sound starts.
    near(m.cueB, 0.75);
    near(sourceB(m, m.pre + 1) - sourceB(m, m.pre), 1);
    near(sourceA(m, m.pre + 1) - sourceA(m, m.pre), 1);
    assert.ok(m.beats <= 16);
  }
  // No beat at all on the outgoing side: no echo or brake (they need a tempo).
  for (let r = 0; r < 1; r += 0.05) assert.ok(!['echo', 'brake'].includes(planMix(a, b, side(null), side(null), even, fixed(r))?.style ?? ''));
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
  const c = pickCues(out, inc, A, B, 120, 120, 120, 8, 30);
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
  assert.ok(['rise', 'roll'].includes(m.style), m.style);
  if (m.style === 'rise') assert.equal(m.bassOnDrop, true);
  near(m.cueB + (m.beats * 60) / m.bpmB, 0.2 + 16);
});

test('styles follow the hand-over', () => {
  const base = { locked: true, weak: false, key: 1, lift: 0, abrupt: false, outHasBeat: true, intoDrop: false, bars: 8, random: fixed(0.1) };
  assert.ok(['rise', 'roll'].includes(chooseStyle({ ...base, lift: 5 })));
  assert.equal(chooseStyle({ ...base, lift: -8 }), 'melt');
  assert.ok(['melt', 'wave'].includes(chooseStyle({ ...base, key: 0.4 })));
  assert.ok(['echo', 'brake'].includes(chooseStyle({ ...base, locked: false, abrupt: true })));
  // Locked and compatible: every patent style comes up over the draw.
  const seen = new Set<MixStyle>();
  for (let r = 0; r < 1; r += 0.01) seen.add(chooseStyle({ ...base, random: fixed(r) }));
  for (const s of ['blend', 'wave', 'beatmix', 'bomb', 'storm', 'signature'] as const) assert.ok(seen.has(s), s);
});

const plan: MixPlan = { style: 'blend', locked: true, beats: 32, bpmA: 120, bpmB: 126, cueA: 150, cueB: 2, bassOnDrop: false, pre: 0.5, window: (32 * 120) / 246, post: 0.5 };

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
    const end = controls(style, 'in', 1.2, 1 / 32, true);
    assert.deepEqual([end.vol, end.low, end.mid, end.high, end.lp, end.hp], [1, 1, 1, 1, 1, 1], style);
    const start = controls(style, 'out', -0.2, 1 / 32);
    assert.deepEqual([start.vol, start.low, start.mid, start.high, start.lp, start.hp], [1, 1, 1, 1, 1, 1], style);
  }
});

test('never both basses up at once', () => {
  for (const style of ALL) {
    for (const drop of [false, true]) {
      for (let u = 0; u <= 1; u += 0.01) {
        const a = controls(style, 'out', u, 1 / 32, drop);
        const b = controls(style, 'in', u, 1 / 32, drop);
        assert.ok(a.vol * a.low + b.vol * b.low <= 1.3, `${style} u=${u.toFixed(2)}`);
      }
    }
  }
});
