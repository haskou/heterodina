// Turns a cover into a theme: background from its main colour (kept dark
// enough for light text), an accent from a second colour, text tinted
// towards the same hue. Pure functions over RGBA pixels.

export interface Theme {
  bg: string;
  bgDeep: string;
  text: string;
  muted: string;
  accent: string;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

interface Cluster {
  r: number;
  g: number;
  b: number;
  count: number;
}

export const DEFAULT_THEME: Theme = {
  bg: 'hsl(220 8% 9%)',
  bgDeep: 'hsl(220 8% 5%)',
  text: 'hsl(40 8% 90%)',
  muted: 'hsl(220 5% 58%)',
  accent: 'hsl(40 67% 55%)',
};

export function themeFromPixels(rgba: Uint8ClampedArray): Theme {
  const clusters = kmeans(rgba, 6);
  if (!clusters.length) return DEFAULT_THEME;
  const total = clusters.reduce((n, c) => n + c.count, 0);
  // Colourfulness is chroma (max - min channel), not HSL saturation: near
  // black or white a faint JPEG tint has a huge saturation but no colour.
  const colours = clusters.map((c) => ({ ...rgbToHsl(c.r, c.g, c.b), chroma: (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255, share: c.count / total }));

  // Main colour: large and colourful wins; near-black/white only if nothing else is there.
  const score = (c: (typeof colours)[number]): number => {
    const extreme = c.l < 0.07 || c.l > 0.93;
    return c.share * (0.25 + 2 * c.chroma) * (extreme ? 0.15 : 1);
  };
  const main = [...colours].sort((a, b) => score(b) - score(a))[0]!;
  const neutral = main.chroma < 0.1;

  const bgL = clamp(main.l, 0.14, 0.3);
  const bgS = neutral ? Math.min(main.s, 0.04) : clamp(main.s, 0.25, 0.6);
  const bg: Hsl = { h: main.h, s: bgS, l: bgL };

  // Accent: a second, clearly different and lively colour; else a light tint of the main hue.
  const others = colours
    .filter((c) => c !== main && c.s > 0.25 && c.chroma > 0.15 && c.l > 0.25 && c.l < 0.9 && c.share > 0.03)
    .filter((c) => hueDistance(c.h, main.h) > 30 || Math.abs(c.l - main.l) > 0.3)
    .sort((a, b) => b.share * b.s - a.share * a.s);
  const pick = others[0];
  let accent: Hsl = pick ? { h: pick.h, s: clamp(pick.s, 0.45, 0.85), l: clamp(pick.l, 0.6, 0.78) } : { h: main.h, s: neutral ? 0.1 : 0.6, l: 0.75 };
  if (contrast(accent, bg) < 3) accent = { ...accent, l: 0.82 };

  return {
    bg: css(bg),
    bgDeep: css({ ...bg, l: bg.l * 0.45 }),
    text: css({ h: main.h, s: neutral ? 0.05 : 0.25, l: 0.95 }),
    muted: css({ h: main.h, s: neutral ? 0.05 : 0.2, l: 0.74 }),
    accent: css(accent),
  };
}

function kmeans(rgba: Uint8ClampedArray, k: number): Cluster[] {
  const px: [number, number, number][] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    px.push([rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0]);
  }
  if (!px.length) return [];

  // Deterministic farthest-point init from the first pixel.
  const centres: [number, number, number][] = [px[0]!];
  while (centres.length < k) {
    let best = px[0]!;
    let bestD = -1;
    for (const p of px) {
      const d = Math.min(...centres.map((c) => dist2(p, c)));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    if (bestD <= 0) break;
    centres.push(best);
  }

  let sums = centres.map(() => [0, 0, 0, 0]);
  for (let iter = 0; iter < 8; iter++) {
    sums = centres.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0;
      let bd = Infinity;
      centres.forEach((c, i) => {
        const d = dist2(p, c);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      const s = sums[bi]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]! += 1;
    }
    sums.forEach((s, i) => {
      if (s[3]) centres[i] = [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]];
    });
  }
  return centres
    .map((c, i) => ({ r: c[0], g: c[1], b: c[2], count: sums[i]![3]! }))
    .filter((c) => c.count > 0);
}

function dist2(a: readonly number[], b: readonly number[]): number {
  return ((a[0] ?? 0) - (b[0] ?? 0)) ** 2 + ((a[1] ?? 0) - (b[1] ?? 0)) ** 2 + ((a[2] ?? 0) - (b[2] ?? 0)) ** 2;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: Hsl, b: Hsl): number {
  const lum = (c: Hsl): number => {
    const [r, g, bl] = hslToRgb(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function css({ h, s, l }: Hsl): string {
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}
