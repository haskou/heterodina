import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_THEME, contrast, rgbToHsl, themeFromPixels } from './palette.ts';

/** Builds an RGBA buffer from [colour, pixel count] pairs. */
function pixels(...parts: [[number, number, number], number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [[r, g, b], n] of parts) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  return new Uint8ClampedArray(out);
}

const hue = (css: string): number => Number(/hsl\((\d+)/.exec(css)?.[1]);
const light = (css: string): number => Number(/(\d+)%\)$/.exec(css)?.[1]) / 100;
const parse = (css: string) => {
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(css)!;
  return { h: Number(m[1]), s: Number(m[2]) / 100, l: Number(m[3]) / 100 };
};

test('blue and white cover: blue background, light text', () => {
  const t = themeFromPixels(pixels([[30, 90, 200], 700], [[245, 245, 250], 300]));
  assert.ok(Math.abs(hue(t.bg) - 220) < 10, `bg hue ${t.bg}`);
  assert.ok(light(t.bg) <= 0.3);
  assert.ok(light(t.text) >= 0.9);
  assert.ok(contrast(parse(t.text), parse(t.bg)) >= 7, 'text must be clearly readable');
});

test('a small saturated area beats a large grey one for the main colour', () => {
  const t = themeFromPixels(pixels([[128, 128, 128], 600], [[220, 40, 60], 400]));
  assert.ok(hue(t.bg) < 10 || hue(t.bg) > 340, `bg ${t.bg}`);
});

test('second distinct colour becomes the accent', () => {
  const t = themeFromPixels(pixels([[30, 90, 200], 600], [[240, 200, 40], 250], [[10, 10, 10], 150]));
  assert.ok(Math.abs(hue(t.accent) - 48) < 12, `accent ${t.accent}`);
});

test('black and white cover stays neutral', () => {
  const t = themeFromPixels(pixels([[0, 0, 0], 500], [[255, 255, 255], 500]));
  assert.ok(parse(t.bg).s <= 0.08, t.bg);
});

test('transparent or empty input falls back to the default theme', () => {
  assert.deepEqual(themeFromPixels(new Uint8ClampedArray(0)), DEFAULT_THEME);
});

test('rgbToHsl', () => {
  assert.deepEqual(rgbToHsl(255, 0, 0), { h: 0, s: 1, l: 0.5 });
  assert.equal(Math.round(rgbToHsl(0, 0, 255).h), 240);
});

test('black-and-white cover with a faint JPEG tint: grey background, no orange', () => {
  // Near-black and near-white with a warm tint: huge HSL saturation, almost no colour.
  const t = themeFromPixels(pixels([[18, 12, 10], 500], [[250, 244, 238], 350], [[120, 116, 112], 150]));
  const bg = parse(t.bg);
  assert.ok(bg.s <= 0.05, `bg ${t.bg}`);
  assert.ok(parse(t.accent).s <= 0.15, `accent ${t.accent}`);
});
