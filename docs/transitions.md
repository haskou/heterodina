# How transitions work

[← Back to the README](../README.md) · [Getting started](getting-started.md) · [Architecture](architecture.md)

Every hand-over between two tracks that aren't consecutive on an album is planned and rendered in the browser while the outgoing track plays. Nothing is configurable: the analysis decides the length, the transition points, the tempo treatment and the style.

```
  outgoing track ─┐                              ┌─ incoming track
                  ▼                              ▼
   decode ─▶ beat grid ─▶ beat features ─▶ compatibility ─▶ cue search
                                                               │
       splice into the incoming voice ◀── offline render ◀── style + plan
```

| Stage | Code |
|---|---|
| Beat grid | `shared/beat.ts` |
| Beat features: timbre, chroma, loudness, downbeat, key, sections, drops | `shared/features.ts` |
| Compatibility, cue search, styles, time maps, control lanes | `shared/mix.ts` |
| Time-stretch (WSOLA) | `shared/stretch.ts` |
| Offline render (EQ, filters, effects, limiter) | `web/src/mixer.ts` |
| Scheduling and splice | `web/src/engine.ts`, `web/src/voice.ts` |
| Fallback crossfade | `shared/transition.ts` |

All of `shared/` is pure TypeScript over plain sample arrays, so the planner is unit-tested without Web Audio.

## 1. When it runs

- As soon as a track starts, the engine fetches and decodes the next track in the queue and plans the hand-over.
- Tracks up to 12 minutes are decoded whole (`AudioBuffer`), which allows sample-exact work. Longer tracks stream through an `<audio>` element and use the [fallback crossfade](#fallback-crossfade).
- Consecutive tracks of the same album are not mixed at all: they play gapless, with album gain.
- A transition already rendered is kept until a seek invalidates it. If rendering finishes after the transition's start time has passed, it is dropped and the fallback crossfade is used instead.

## 2. Beat grid

`beatGrid()` estimates tempo and phase on a region of mono audio:

- **Onsets:** per 10 ms frame, the log energy of a one-pole low-pass at 150 Hz (kicks, bass) and of the first difference of the signal (a cheap high-pass: snares, hats). Onsets are the positive rises of both, lightly smoothed and mean-removed.
- **Tempo:** autocorrelation over beat periods from 0.3 to 1 s (60–200 BPM). Each lag also collects half its autocorrelation at 2 periods and a quarter at 4, because a real beat repeats and noise doesn't. A log-normal prior centred on 0.5 s (120 BPM) resolves double/half ambiguity, and a parabola through the peak gives a sub-frame period.
- **Phase:** the offset whose comb of beats collects the most onset energy.
- **Confidence** (0..1): the winning score against a perfectly periodic signal. A click track scores 1, noise about 0.04, and anything below 0.15 counts as no beat.

The engine analyses the outgoing side from `max(leadIn, min(0.75·duration, audioEnd − 10 s) − 32 s)` to the end of its sound, and the incoming side from its first sound to `min(audioEnd, 0.2·duration + 32 s)`. If the grid over that whole region is shaky (confidence below 0.2), it retries on the last or first 20 s, where tempo changes matter least.

## 3. Beat features

`beatFeatures()` resamples to 11,025 Hz (harmony and timbre need nothing above ~5 kHz) and runs a 2,048-point FFT with a hop of 512 samples. For every beat of the grid it keeps:

- **Timbre:** spectral power in 12 log-spaced bands from 40 Hz, normalized.
- **Chroma:** power folded into 12 pitch classes (55 Hz–1.76 kHz), summing to 1.
- **Loudness:** relative to the region's loud beats, 0..1.

From those:

- **Downbeat:** the beat position (0–3) where the bar most often starts, measured as `0.5·timbre change + 2·loudness rise` accumulated per position. Bars begin where the sound changes and gets louder.
- **Key:** the summed chroma is correlated with the Krumhansl–Kessler major and minor profiles in all 12 rotations; the best match wins.
- **Sections:** a novelty curve compares the mean of the 8 beats before and after each beat: timbre plus 4× chroma, plus 3× loudness. A bar line starts a section when its novelty beats the bar lines on either side and exceeds the mean by half a standard deviation. An FFT frame smears a change over neighbouring beats, so each bar line takes the strongest novelty within one beat of it.
- **Drops:** section starts where the low-band energy after is more than 1.6× the energy before.

## 4. Compatibility

After Spotify's mashup patent (US 11475867):

```
tempo  = max(0.01, 1 − 3.5·|log2(bpmB / bpmA)|)      (incoming tempo folded to ×2 or ×½ if closer)
key    = keyFit(keyA, keyB)                           (see below; 0.75 when a key is unknown)
score  = tempo · key
bars   = 16 if score ≥ 0.9, 8 if ≥ 0.75, 4 if ≥ 0.5, else 2
```

`keyFit` compares the keys' relative-major roots: `1 − 0.4·semitones` apart, ×0.9 when one is major and the other minor, raised to at least 0.9 for Camelot neighbours (a fifth apart in the same mode, or relative major/minor). So the same key gives 1, the relative key or a fifth 0.9, and a tritone 0.

If either beat is unsteady, the preferred length is 2 bars, whatever the score.

The two tracks are **locked** when both grids are steady (confidence ≥ 0.2) and the folded tempos are within 8% of each other. Only locked pairs are time-stretched and beat-matched.

## 5. Transition points

After Bittner et al., *Automatic Playlist Sequencing and Transitions* (ISMIR 2017). For locked pairs with features, `pickCues()` enumerates every candidate:

- **Lengths:** 2, 4, 8 and 16 bars, as long as the window fits (at most 32 s, 35% of the outgoing track's sound and 50% of the incoming one's).
- **Outgoing region:** starts on a downbeat, and its last beat falls in the outgoing track's last quarter and before its sound ends.
- **Incoming region:** starts on a downbeat in the incoming track's first fifth, or within its first bar of sound.

Each candidate gets seven costs, averaged beat by beat over the overlap:

| Cost | Low when |
|---|---|
| Timbre distance | Both regions sound alike |
| Chroma distance | Both regions share harmony |
| Quietness | Both regions are loud enough to carry the mix |
| Harmonic balance | Harmony settles in one track while it moves in the other |
| Loudness mismatch | Both regions are about equally loud |
| Drops | Both regions end on a drop |
| Sections | Both regions end on a section boundary |

Every cost is scaled to 0..1 over all candidates; a term that doesn't really vary (only rounding noise) counts as zero. The lowest mean, plus a length prior `0.12·|log2(bars / preferredBars)|`, wins. Ending on a drop or section of the incoming track is recorded so the style can hold its bass for that moment.

Without features or without a lock, the window simply ends on the outgoing track's last downbeat before its sound ends, and the incoming track enters on its first beat (locked) or its first sound (unlocked).

## 6. Style

`chooseStyle()` picks the hand-over from what the analysis found. `lift` is the incoming track's first 10 s minus the outgoing track's last 10 s, in normalized dB.

| Situation | Styles |
|---|---|
| Not locked, incoming much quieter (lift ≤ −6 dB) | melt |
| Not locked, outgoing has a beat | echo or brake (always when it ends abruptly), else wave or melt |
| Locked but unsteady | wave or melt |
| Keys clash (key fit < 0.6) | melt or wave |
| Into a louder track (lift ≥ 3 dB) or a drop | rise or roll |
| Otherwise | weighted draw: blend (3× when 16 bars fit), wave, beat mix, sound bomb, beat storm, signature, rise |

Each style caps the length it is worth: blend up to 16 bars; rise, wave and the patent styles 8; melt and roll 4; echo and brake 2.

Unlocked pairs never overlap long: 4 bars of a filter wave or a reverb wash hide a tempo clash, and the exits take 2.

## 7. Tempo: the time maps

A plan has the outgoing tempo `bpmA`, the incoming tempo `bpmB` (equal to `bpmA` when not locked), the cue points and the window length in beats. During the window the tempo glides linearly from `bpmA` to `bpmB`, so after `w` seconds

```
beats(w) = (bpmA·w + (bpmB − bpmA)·w² / (2·window)) / 60
window   = beats · 120 / (bpmA + bpmB)
```

and each track's source position is

```
sourceA(w) = cueA + beats(w)·60 / bpmA
sourceB(w) = cueB + beats(w)·60 / bpmB
```

Both tracks therefore hit beat *k* of the window at the same instant, for every *k*, and each plays at its own speed outside it. The outgoing track reaches the incoming tempo by the end; the incoming one starts at the outgoing tempo and settles into its own. A stretch never exceeds 8%.

Loop roll modifies `sourceA`: from the midpoint, the outgoing track repeats a loop that halves every quarter of the remaining window (1 bar, 2 beats, 1 beat, ½ beat).

## 8. Time-stretch

`stretch()` is WSOLA (waveform-similarity overlap-add) driven by an arbitrary time map, so pitch is kept:

- 40 ms frames with a periodic Hann window at 50% overlap (copies sum exactly to 1).
- Each frame may move ±12 ms from its target source position to the offset whose waveform best continues the previous frame, found by normalized cross-correlation. The search runs on every 4th sample first, then refines.

Brake is done afterwards on the stretched data: the last beat of the outgoing track is resampled with a linearly falling rate down to standstill, like a turntable switched off.

## 9. Control lanes

Each style is a recipe of lanes that set, for each track at window progress `u` (0..1), these controls:

| Control | Meaning |
|---|---|
| `vol` | Level |
| `low`, `mid`, `high` | Three-band EQ, 1 = flat, 0 = band killed |
| `lp`, `hp` | Low-pass and high-pass position, 1 = fully open |
| `echo`, `verb` | Sends to the echo and reverb buses |
| `bassEcho` | Lows alone into the echo (beat storm) |
| `flange` | Flanger level (signature) |
| `riser` | Noise riser level (rise) |

| Style | Outgoing | Incoming |
|---|---|---|
| blend | Full until the last quarter, then an equal-power fade; bass out in the half beat before the midpoint | Equal-power fade in over the first quarter; bass in the half beat after the midpoint |
| wave | Lows, mids, highs fade one after another; low-pass closes over the second half | Highs, mids, lows come in one after another; low-pass opens over the first half |
| rise | High-pass closes over the second half under a noise sweep (300 Hz → 9 kHz); bass out on the last half beat | Fades in over the first quarter; bass lands on the last half beat |
| roll | Bass out over the first beat, high-pass closes in the second half, loops halving | Cuts in on the window's last moment; bass on the last half beat |
| melt | Fades with its bass, low-pass closes, reverb wash over the last 45% | Equal-power fade in over the first half; bass comes up across the window |
| echo | High-pass closes and a dotted-eighth echo takes it over the second half | Cuts in on the window's last moment |
| brake | Turntable stop on the last beat, a touch of reverb | Cuts in on the window's last moment |
| beat mix | Linear fade out | Linear fade in |
| sound bomb | Linear fade out; bass out across the middle third | Linear fade in; bass in across the middle third |
| beat storm | As sound bomb, plus the outgoing kicks into the echo in the first third | As sound bomb |
| signature | Linear fade out; bass and mids fade across the window; flanger from the middle third on | Comes up fast; bass and mids rise across the window |

With a drop or section at the end of the window (`bassOnDrop`), both basses use an end swap instead, so the incoming bass hits exactly on the drop. A test sweeps every style and checks that the two basses never add up to more than 1.3× one bass.

Patent styles follow US 2020/0374625 (Spotify's mixing patent).

## 10. Offline render

`renderMix()` renders `pre + window + post` seconds in an `OfflineAudioContext` at the tracks' sample rate:

- `pre` is 0.5 s of the outgoing track alone, so the stretcher settles before the splice.
- `post` is 0.5 s of the incoming track alone, or 3.5 s for melt, echo and brake, so effect tails ring out.

Per track:

```
source ─ level ─┬─ LR4 low  (<250 Hz) ─ gain(low)  ─┐
                ├─ LR4 mid  (250–2.5k) ─ gain(mid) ─┼─ sum ─ low-pass ─ high-pass ─┬─ vol ─▶ limiter
                └─ LR4 high (>2.5 kHz) ─ gain(high) ┘                             ├─ echo send
                                                                                  └─ reverb send
```

- **EQ:** Linkwitz–Riley 4th-order crossovers (two cascaded Butterworths), so the bands sum flat when all gains are 1.
- **Filters:** sweeps move on a log scale, as the ear hears frequency: low-pass from 20 kHz down to 120 Hz, high-pass from 20 Hz up to 1.8 kHz.
- **Echo bus:** a dotted eighth at the incoming tempo, 50% feedback through a 3.2 kHz low-pass.
- **Reverb bus:** convolution with 3.2 s of decaying stereo noise.
- **Limiter:** a compressor at −3 dB, 8:1, 3 ms attack, catching the peaks of two full tracks overlapping.
- **Automation:** every control is a value curve with 100 points per second.
- Hard edges are cut into the data itself, with 5 ms ramps, because automation points are 10 ms apart: the outgoing track stops exactly on the window's last beat, and the incoming one starts on its first.
- **Levels:** both tracks are loudness-normalized. The render plays through the incoming voice, which already applies the incoming gain, so the outgoing side is scaled by `gainA / gainB`.

Rendering takes roughly 0.3–1 s on the main thread per transition, well ahead of time.

## 11. Splice

The render becomes the incoming voice's **intro**:

- It starts 60 ms into the render (the stretcher's first and last frames are partial) at the moment the outgoing track reaches `cueA − pre`.
- The outgoing track fades out over 10 ms there, while the intro fades in over the same 10 ms. The material is the same audio, so nothing is heard.
- At the intro's end, the incoming track's own source starts at the matching position, again with a 10 ms overlap.
- All of it is scheduled on the `AudioContext` clock, so timing stays exact in a background tab.
- While the intro plays, the reported position follows the incoming track's time map, so the progress bar and seeking stay correct.

## Fallback crossfade

Used for tracks that stream (over 12 minutes), when the window doesn't fit, or when the render is late:

- **Overlap:** for the last N seconds of sound, the outgoing track fades out while the incoming one fades in, with equal-power (sine/cosine) curves. N is 6 s, or the length of the track's own fade-out, up to 12 s. Leading and trailing silence are trimmed.
- **Bass swap:** a low-shelf EQ at 200 Hz, −18 dB. The incoming track enters without bass and takes it over mid-blend.
- **Beat alignment:** with both tracks decoded and compatible tempos (same, double or half, under 50 ms of drift across the blend), the blend moves by less than half a beat so beats coincide, and the bass swap lasts one beat, centred on a beat.
- **Manual skip or a new track:** 0.6 s fades. Anything still fading out goes with it, so three tracks never sound at once.
