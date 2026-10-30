# How transitions work

[← Back to the README](../README.md) · [Getting started](getting-started.md) · [Architecture](architecture.md)

Every hand-over between two tracks that aren't consecutive on an album is planned and rendered in the browser while the outgoing track plays. Nothing is configurable: the analysis decides the length, the transition points, the tempo treatment and the style.

```
  outgoing track ─┐                              ┌─ incoming track
                  ▼                              ▼
   decode ─▶ beat grid ─▶ beat features ─▶ compatibility ─▶ cue search × style simulation
                                                                        │
            splice into the incoming voice ◀── offline render ◀── plan (points, style, key)
```

| Stage | Code |
|---|---|
| Beat grid | `shared/beat.ts` |
| Beat features: timbre, chroma, loudness, bass, notes, voice, band energy, downbeat, key, sections, drops | `shared/features.ts` |
| Compatibility, cue search with mix simulation, styles, time maps, control lanes | `shared/mix.ts` |
| Time-stretch (WSOLA) and pitch shift | `shared/stretch.ts` |
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
- **Bass:** power below 150 Hz, against the region's 90th percentile (about 1 where the bass line plays).
- **Notes:** the size of clear spectral peaks (at least 3× their 17-bin neighbourhood) from 55 Hz to 1.76 kHz, against the 90th percentile, up to 1.5. Noise and drums barely count; chords and melodies do.
- **Voice or lead:** after Regnier and Peeters (ICASSP 2009). Every clear peak from 200 Hz to 3 kHz is followed two frames back and forward (about 200 ms). After removing the straight-line trend, a voice's partials wander 16 cents or more (vibrato, scoops, drift), while keys, synths and pads hold still. The share of note energy on wandering partials is averaged over a bar, scaled within the region (its quiet quarter to its busy tenth) and kept only where there are notes. Bowed strings, sax and bent guitars wander too, so it marks where the melodic foreground is busy rather than proving there is a singer.
- **Band energy:** raw power below 250 Hz, 250 Hz–2.5 kHz and above, analysed after the track's loudness normalization so it compares across tracks. The simulation uses it to predict the mix's level.

From those:

- **Downbeat:** the beat position (0–3) where the bar most often starts, measured as `0.5·timbre change + 2·loudness rise` accumulated per position. Bars begin where the sound changes and gets louder.
- **Key:** the summed chroma is correlated with the Krumhansl–Kessler major and minor profiles in all 12 rotations; the best match wins.
- **Sections:** a novelty curve compares the mean of the 8 beats before and after each beat: timbre plus 4× chroma, plus 3× loudness. A bar line starts a section when its novelty beats the bar lines on either side and exceeds the mean by half a standard deviation. An FFT frame smears a change over neighbouring beats, so each bar line takes the strongest novelty within one beat of it.
- **Drops:** section starts where the low-band energy after is more than 1.6× the energy before.

## 4. Compatibility

After Spotify's mashup patent (US 11475867):

```
gap    = |log2(bpmB / bpmA)|                          (incoming tempo folded to ×2 or ×½ if closer)
tempo  = max(0.01, 1 − 3.5·gap)
key    = keyFit(keyA, keyB)                           (see below; 0.75 when a key is unknown)
bars   = 16 if gap < 0.045 (about 3%), else 8         (2 when either beat is unsteady)
```

A key clash only matters where both tracks play chords, which the simulation measures beat by beat in the actual regions, so the preferred length comes from the tempo gap alone: a bigger gap wants a shorter glide.

`keyFit` compares the keys' relative-major roots: `1 − 0.4·semitones` apart, ×0.9 when one is major and the other minor, raised to at least 0.9 for Camelot neighbours (a fifth apart in the same mode, or relative major/minor). So the same key gives 1, the relative key or a fifth 0.9, and a tritone 0.

Three paths follow:

| Situation | Treatment |
|---|---|
| Either beat missing or unsteady (confidence under 0.2, or steadiness under 0.25) | **Free fade:** no beat-matching. An equal-power crossfade of the bar count nearest 10 s, each track at its own speed, from where the outgoing music really ends (the window ends 15% past it) into where the incoming music really starts. |
| Tempos more than 20% apart (gap > 0.26) | **Exit:** 2 bars ending on the outgoing track's last downbeat, each track at its own speed. Echo (70%), spinback (15%) or brake (15%); a reverb melt over 4 bars when the incoming track is 6 dB quieter or more. |
| Otherwise | **Locked:** time-stretched and beat-matched, with points and style from the search below. |

## 5. Transition points and style, together

After Bittner et al., *Automatic Playlist Sequencing and Transitions* (ISMIR 2017), with the mix simulation of Segue. For locked pairs with features, `pickCues()` enumerates every candidate:

- **Lengths:** 2, 4, 8 and 16 bars, as long as the window fits (at most 32 s, 35% of the outgoing track's sound and 50% of the incoming one's).
- **Outgoing region:** starts on a downbeat, and its last beat falls in the outgoing track's last quarter and before its sound ends.
- **Incoming region:** starts on a downbeat in the incoming track's first fifth, or within its first bar of sound.

### The simulation

For every candidate, each blend style (DJ mix, DJ swap on the drop, blend, fade, wave, melt, sound bomb, beat mix, beat storm, signature) is played through its real automation curves, beat by beat. The curves give each track's gain on the low, mid and high bands at that beat, including what the low-pass and high-pass filters take away. Against both tracks' measured features, it adds up what a dance floor would hear:

| Term | Per beat | Weight |
|---|---|---|
| Bass overlap | the smaller of the two audible bass lines (mud) | 1.5 |
| Missing bass | how far the louder audible bass falls below 0.35 (the floor loses the groove) | 2 |
| Chord clash | notes × notes × roughness of the two chroma profiles, by interval class (seconds and the tritone grate, thirds and fifths blend) | 1.5 |
| Level jump | distance of the predicted level from a straight line between the 8 beats before the mix and the 8 after | 1 |
| Two voices | voice × voice, through each track's mids and highs: the classic train wreck | 2.5 |
| Clutter | both arrangements audibly full at once (notes or a lead line) | 2.5 |

Bass, missing bass and level are averaged per beat, since they are about any moment. Clash, voices and clutter are totals per 4 bars, since 16 bars of two full songs on top of each other is far worse than 2. Every term is scaled to 0..1 over all candidates and styles together. A style's score is the weighted mean, plus a small prior: 0 for DJ mix, 0 for DJ swap on the drop when the window ends on a drop (else 0.05), 0.03 for blend and sound bomb, 0.05 for the rest.

### The pair

Each candidate also gets these costs:

| Cost | Low when | Weight |
|---|---|---|
| Timbre distance | Both regions sound alike | 1 |
| Chroma distance | Both regions share harmony | 0.5 |
| Quietness | Both regions are loud enough to carry the mix | 0.5 |
| Harmonic balance | Harmony settles in one track while it moves in the other | 0.5 |
| Drop | The incoming region ends on a drop | 1 |
| Sections | The outgoing region starts on a section (its outro plays under the incoming intro), and the incoming one ends on a section | 1.5 |
| Skipped | Little of the outgoing track's end or the incoming track's start is skipped | 1.5 |
| Phrase | Both ends sit on an 8-bar phrase line (4 at worst), counted from the nearest section start | 1 |
| Simulation | Its best style scores well | 4 |

Every cost is scaled to 0..1 over all candidates; a term that doesn't really vary (only rounding noise) counts as zero. The score is the weighted mean, plus a length prior `0.05·|log2(bars / preferredBars)|`, plus an absolute cost for the best style's clutter (×0.12) and two voices (×0.25): when every option overlaps two full songs, relative scaling can't see it, but a DJ would still keep that transition short. The lowest score wins, with its styles ranked.

A search over a typical pair (thousands of candidates, ten styles each) takes about 25 ms.

### Key match

When the keys clash (key fit under 0.6), the shift that moves the incoming key onto the outgoing one is at most 3 semitones, and the tempos are close (tempo score ≥ 0.5), chord clash is simulated with the incoming track shifted. Once the pair is chosen, the shift is kept only if that region's chords would really clash without it (its unshifted clash scores at least 0.25 on the shared scale). The incoming track then starts in the outgoing key and glides back to its own pitch by the window's end.

Without features, the window ends on the outgoing track's last downbeat before its sound ends, the incoming track enters on its first downbeat, and the style is DJ mix.

## 6. Style

The style is drawn among the simulated styles scoring within 0.02 of the best, for variety. Then come a few DJ moves on top. `lift` is the incoming track's first 10 s minus the outgoing track's last 10 s, in normalized dB.

| Situation | Change |
|---|---|
| Into a louder track (lift ≥ 3 dB) or a drop | 40% of the time: a noise riser (25%) or a loop roll (15%) |
| A DJ mix of 8 bars or more | 20% of the time: a tease |

Each style caps the length it is worth: DJ mix, DJ swap on the drop, tease, blend and fade up to 16 bars; rise, wave and the patent styles 8; melt and roll 4; echo, brake and spinback 2. A shorter window keeps the same end, the moment the search chose.

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

Both tracks therefore hit beat *k* of the window at the same instant, for every *k*, and each plays at its own speed outside it. The outgoing track reaches the incoming tempo by the end; the incoming one starts at the outgoing tempo and settles into its own. A stretch never exceeds 20%.

Loop roll modifies `sourceA`: from the midpoint, the outgoing track repeats a loop that halves every quarter of the remaining window (1 bar, 2 beats, 1 beat, ½ beat).

## 8. Time-stretch

`stretch()` is WSOLA (waveform-similarity overlap-add) driven by an arbitrary time map, so pitch is kept:

- 40 ms frames with a periodic Hann window at 50% overlap (copies sum exactly to 1).
- Each frame may move ±12 ms from its target source position to the offset whose waveform best continues the previous frame, found by normalized cross-correlation. The search runs on every 4th sample first, then refines.

**Pitch shift** (`pitchStretch()`) for a key match: with `R(t) = ∫ 2^(semitones(t)/12) dt`, the stretched signal at `R(t)` must hold the source moment `map(t)`. So WSOLA runs on `map(R⁻¹(τ))` for `R(T)` seconds, and the output reads that back at `R(t)` with linear interpolation, which resamples it into the new pitch while every beat stays where the time map puts it.

Two exits are done afterwards on the stretched data:

- **Brake:** the last beat of the outgoing track is resampled with a linearly falling rate down to standstill, like a turntable switched off.
- **Spinback:** from where the last beat starts, the record is read backwards, at 4× speed first and slowing as `(1 − x)^1.5`, like a hand pulling the record back and letting go, fading out over the last fifth.

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
| DJ mix | Full until the last quarter, then an eased fader; mids down 8 dB over the third quarter; bass out in the last quarter beat before the midpoint downbeat | Eased fader up over the first quarter with its bass killed and mids 8 dB down; bass in at the same moment, so that downbeat's kick is the new one; mids up over the third quarter |
| DJ swap on the drop | As DJ mix, but the bass swaps just before the window's last downbeat | Same, so its bass lands with the drop |
| tease | As DJ mix | Through the first half, let in only on the last beat of every second bar (every bar on short windows), like a DJ tapping the fader; from the midpoint, a DJ mix |
| fade | Equal-power fade over the whole window | Equal-power fade in over the whole window |
| blend | Full until the last quarter, then an equal-power fade; bass out in the half beat before the midpoint | Equal-power fade in over the first quarter; bass in the half beat after the midpoint |
| wave | Lows, mids, highs fade one after another; low-pass closes over the second half | Highs, mids, lows come in one after another; low-pass opens over the first half |
| rise | High-pass closes over the second half under a noise sweep (300 Hz → 9 kHz); bass out on the last half beat | Fades in over the first quarter; bass lands on the last half beat |
| roll | Bass out over the first beat, high-pass closes in the second half, loops halving | Cuts in on the window's last moment; bass on the last half beat |
| melt | Fades with its bass, low-pass closes, reverb wash over the last 45% | Equal-power fade in over the first half; bass comes up across the window |
| echo | High-pass closes and a dotted-eighth echo takes it over the second half | Cuts in on the window's last moment |
| brake | Turntable stop on the last beat, a touch of reverb | Cuts in on the window's last moment |
| spinback | Pulled back by hand on the last beat, a touch of reverb | Cuts in on the window's last moment |
| beat mix | Linear fade out | Linear fade in |
| sound bomb | Linear fade out; bass out across the middle third | Linear fade in; bass in across the middle third |
| beat storm | As sound bomb, plus the outgoing kicks into the echo in the first third | As sound bomb |
| signature | Linear fade out; bass and mids fade across the window; flanger from the middle third on | Comes up fast; bass and mids rise across the window |

Faders on DJ styles move on smoothstep curves, like a hand that starts and stops gently. A test sweeps every style except the plain fade and checks that the two basses never add up to more than 1.3× one bass; the simulation steers the fade away from music with bass in both tracks.

Patent styles follow US 2020/0374625 (Spotify's mixing patent).

## 10. Offline render

`renderMix()` renders `pre + window + post` seconds in an `OfflineAudioContext` at the tracks' sample rate:

- `pre` is 0.5 s of the outgoing track alone, so the stretcher settles before the splice.
- `post` is 0.5 s of the incoming track alone, or 3.5 s for the exits (melt, echo, brake, spinback), so effect tails ring out.

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
