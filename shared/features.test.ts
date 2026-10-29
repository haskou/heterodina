import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatFeatures, findKey, keyFit } from './features.ts';

const RATE = 22050;

test('keys: same and relative fit fully, neighbours well, distant keys badly', () => {
  const C = { root: 0, minor: false };
  assert.equal(keyFit(C, C), 1);
  assert.equal(keyFit(C, { root: 9, minor: true }), 0.9 * 1); // A minor: relative
  assert.ok(keyFit(C, { root: 7, minor: false }) >= 0.9); // G: a fifth up
  assert.ok(keyFit(C, { root: 6, minor: false }) < 0.2); // F#: tritone
});

test('finds the key of a chord progression', () => {
  // I-IV-V-I in G major, as pitch-class weights.
  const totals = new Array(12).fill(0);
  for (const chord of [[7, 11, 2], [0, 4, 7], [2, 6, 9], [7, 11, 2]]) for (const pc of chord) totals[pc] += 1;
  assert.deepEqual(findKey(totals), { root: 7, minor: false });
});

/** Bars of four beats: a low thump on every beat, loudest on the first; then a bassier second half. */
function song(bpm: number, bars: number, dropAtBar: number): Float32Array {
  const beat = 60 / bpm;
  const out = new Float32Array(Math.ceil(bars * 4 * beat * RATE));
  for (let b = 0; b < bars * 4; b++) {
    const at = Math.round(b * beat * RATE);
    const accent = b % 4 === 0 ? 1 : 0.35;
    const bass = b >= dropAtBar * 4 ? 1 : 0.15;
    for (let i = 0; i < beat * RATE && at + i < out.length; i++) {
      const t = i / RATE;
      out[at + i] = accent * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.08) * bass + 0.2 * Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t / 0.2);
    }
  }
  return out;
}

test('beat features: downbeat on the accent, a section and a drop where the bass comes in', () => {
  const bpm = 120;
  const f = beatFeatures(song(bpm, 16, 8), RATE, 0, { period: 60 / bpm, phase: 0, confidence: 0.5 });
  assert.equal(f.times.length, 64);
  assert.equal(f.downbeat, 0);
  assert.ok(f.sections.has(32), [...f.sections].join(','));
  assert.ok(f.drops.has(32), [...f.drops].join(','));
  assert.equal(f.key.root, 9); // A: 55 Hz and 440 Hz
  for (const c of f.chroma) assert.ok(Math.abs(c.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});
