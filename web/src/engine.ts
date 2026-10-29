// Playback engine on the Web Audio clock. As soon as a track starts, the
// next one is loaded, its transition planned and every start, fade and
// stop scheduled on AudioContext time. The handover itself therefore needs
// no JS timer: it stays exact even when a background tab throttles timers.

import {
  fadeCurve,
  fitPlan,
  isContiguous,
  planCrossfade,
  planGapless,
  planSkip,
  profileOf,
  shiftPlan,
  type TransitionPlan,
} from '../../shared/transition.ts';
import { beatGrid, beatShift, type BeatGrid } from '../../shared/beat.ts';
import { beatFeatures, type BeatFeatures, type Key } from '../../shared/features.ts';
import { MIN_MIX_CONFIDENCE, planMix, type Side } from '../../shared/mix.ts';
import type { Track } from '../../shared/types.ts';
import { api } from './api.ts';
import { ClockTimers } from './clock.ts';
import { normalizationGain, volumeCurve } from './loudness.ts';
import { RENDER_MARGIN_S, renderMix, SPLICE_S } from './mixer.ts';
import { BufferVoice, StreamVoice, type Voice } from './voice.ts';

export type PlayState = 'idle' | 'loading' | 'playing' | 'paused';

/** Where the engine gets upcoming tracks from. */
export interface QueueSource {
  /** The n-th track after the current one (0 = next), without consuming it. */
  peek(n?: number): Track | null;
  /** The peeked next track has started playing. */
  advance(track: Track): void;
  /** The track cannot be played; drop it from the queue. */
  discard(track: Track): void;
}

export interface EngineListener {
  state(state: PlayState, track: Track | null): void;
  trackChanged(track: Track): void;
  error(track: Track, err: unknown): void;
}

interface Scheduled {
  voice: Voice;
  from: Voice;
  /** Context time at which the incoming track starts. */
  when: number;
  plan: TransitionPlan;
  cancelTimers: () => void;
}

/** Longer tracks stream through a media element instead of being decoded whole. */
const STREAM_OVER_S = 12 * 60;
/** How far ahead of "now" a schedule must be to be safe. */
const LEAD = 0.08;
/** Matches the planner's skip fade. */
const SKIP_FADE_S = 0.6;

export class AudioEngine {
  readonly #ctx = new AudioContext({ latencyHint: 'playback' });
  readonly #master = this.#ctx.createGain();
  readonly #timers = new ClockTimers(this.#ctx);
  readonly #queue: QueueSource;
  readonly #listener: EngineListener;
  readonly #buffers = new Map<string, Promise<AudioBuffer>>();
  readonly #details = new Map<string, Promise<Track>>();
  readonly #fading = new Set<Voice>();
  #current: Voice | null = null;
  #next: Scheduled | null = null;
  #state: PlayState = 'idle';
  /** Bumped by every manual switch so stale async work bails out. */
  #switchToken = 0;
  #prepareToken = 0;
  /** The transition being prepared (loading, analysing, rendering), so a queue change doesn't start a second one. */
  #preparing: { from: Voice; trackId: string } | null = null;

  constructor(queue: QueueSource, listener: EngineListener) {
    this.#queue = queue;
    this.#listener = listener;
    this.#master.connect(this.#ctx.destination);
  }

  get state(): PlayState {
    return this.#state;
  }

  get track(): Track | null {
    return this.#current?.track ?? null;
  }

  get position(): number {
    return this.#current?.position() ?? 0;
  }

  get duration(): number {
    return this.#current?.duration ?? 0;
  }

  /** Voices currently alive (current, scheduled next, fading); for diagnostics. */
  get voiceCount(): number {
    return [...this.#voices()].length;
  }

  /** Voices that have started and not yet been stopped; for diagnostics. */
  get soundingCount(): number {
    const pending = this.#next && this.#next.when > this.#ctx.currentTime ? 1 : 0;
    return this.voiceCount - pending;
  }

  setVolume(v: number): void {
    this.#master.gain.setTargetAtTime(volumeCurve(v), this.#ctx.currentTime, 0.015);
  }

  /** Plays `track` now, fading out whatever is playing. */
  play(track: Track): Promise<void> {
    return this.#switchTo(track, false);
  }

  /** Jumps to the next queued track with a short fade. */
  async skip(): Promise<void> {
    const next = this.#queue.peek();
    if (next) await this.#switchTo(next, true);
  }

  async pause(): Promise<void> {
    if (this.#state !== 'playing') return;
    this.#setState('paused');
    this.#timers.pause();
    for (const v of this.#voices()) v.pause();
    await this.#ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.#state !== 'paused') return;
    this.#setState('playing');
    await this.#ctx.resume();
    for (const v of this.#voices()) v.resume();
    this.#timers.resume();
  }

  toggle(): Promise<void> {
    return this.#state === 'playing' ? this.pause() : this.resume();
  }

  seek(seconds: number): void {
    const cur = this.#current;
    if (!cur) return;
    this.#cancelNext();
    // A seek during a transition abandons the outgoing track.
    for (const v of this.#fading) v.kill();
    this.#fading.clear();
    resetTransition(cur, this.#ctx.currentTime);
    cur.seek(seconds);
    // Whatever was being prepared was planned from the old position.
    this.#prepareToken++;
    this.#preparing = null;
    void this.#prepareNext();
  }

  /** Call when the queue changed: re-plans the upcoming transition if needed. */
  queueChanged(): void {
    const next = this.#next;
    const wanted = this.#queue.peek();
    if (next && next.when > this.#ctx.currentTime + LEAD && next.voice.track.id !== wanted?.id) this.#cancelNext();
    if (!this.#next) void this.#prepareNext();
  }

  async #switchTo(track: Track, fromQueue: boolean): Promise<void> {
    const token = ++this.#switchToken;
    this.#prepareToken++;
    this.#cancelNext();
    if (!this.#current) this.#setState('loading', track);
    let voice: Voice;
    try {
      const full = await this.#detail(track);
      voice = await this.#createVoice(full, null, fromQueue ? 1 : 0);
      await this.#ctx.resume();
    } catch (err) {
      if (token !== this.#switchToken) return;
      if (!this.#current) this.#setState('idle', null);
      if (fromQueue) this.#queue.discard(track);
      this.#listener.error(track, err);
      return;
    }
    if (token !== this.#switchToken) {
      voice.dispose();
      return;
    }
    this.#timers.resume();
    const from = this.#current;
    const now = this.#ctx.currentTime + LEAD;
    // Whatever is still fading from an automatic crossfade (up to 12 s) goes
    // with the same short fade, so a manual switch never stacks three tracks.
    for (const v of this.#fading) fadeOutNow(v, this.#timers, SKIP_FADE_S);
    if (from) {
      const plan = planSkip(from.position() + LEAD, profileOf(voice.track));
      this.#apply(from, voice, now, plan);
    } else {
      voice.start(now, Math.max(0, profileOf(voice.track).leadIn - 0.05));
    }
    if (fromQueue) this.#queue.advance(track);
    // A manual switch always plays, even from pause.
    for (const v of this.#voices()) v.resume();
    this.#state = 'playing';
    this.#makeCurrent(voice);
  }

  async #prepareNext(): Promise<void> {
    const cur = this.#current;
    const track = this.#queue.peek();
    if (!cur || !track || this.#next) return;
    if (this.#preparing?.from === cur && this.#preparing.trackId === track.id) return;
    const token = ++this.#prepareToken;
    this.#preparing = { from: cur, trackId: track.id };
    try {
      await this.#prepare(cur, track, token);
    } finally {
      if (token === this.#prepareToken) this.#preparing = null;
    }
  }

  async #prepare(cur: Voice, track: Track, token: number): Promise<void> {
    let voice: Voice;
    try {
      const full = await this.#detail(track);
      voice = await this.#createVoice(full, cur.track, 1);
    } catch (err) {
      if (token !== this.#prepareToken) return;
      this.#queue.discard(track);
      this.#listener.error(track, err);
      void this.#prepareNext();
      return;
    }
    if (token !== this.#prepareToken || cur !== this.#current || this.#next) {
      voice.dispose();
      return;
    }
    const gapless = cur.exact && voice.exact && isContiguous(cur.track, voice.track);
    const out = profileOf(cur.track);
    let mixed: TransitionPlan | null = null;
    if (!gapless) {
      try {
        mixed = await this.#mix(cur, voice);
      } catch (err) {
        console.error('[transition] mix failed, crossfading instead', err);
      }
      if (token !== this.#prepareToken || cur !== this.#current || this.#next) {
        voice.dispose();
        return;
      }
    }
    // Rendering took a while: a mix whose splice has already passed can't be used.
    if (mixed && mixed.start < cur.position() + LEAD) {
      if (voice instanceof BufferVoice) voice.setIntro(null);
      mixed = null;
    }
    const planned = gapless ? planGapless(out) : (mixed ?? alignToBeat(planCrossfade(out, profileOf(voice.track)), cur, voice));
    const plan = fitPlan(planned, cur.position() + LEAD);
    try {
      this.#apply(cur, voice, cur.timeAt(plan.start), plan);
    } catch (err) {
      // Nothing was started; the end of the track falls back to a cut.
      console.error('[transition] could not schedule', err);
    }
  }

  /**
   * Beat-matched transition, rendered into `to` as an intro: null when the
   * tempos can't lock or it is too late to place one.
   */
  async #mix(from: Voice, to: Voice): Promise<TransitionPlan | null> {
    if (!from.buffer || !to.buffer || !(to instanceof BufferVoice)) return null;
    const out = profileOf(from.track);
    const inc = profileOf(to.track);
    // The outgoing track's last quarter (plus room for a 16-bar window), the incoming one's first fifth (plus the same).
    const sideA = sideOf(from.buffer, Math.max(out.leadIn, Math.min(OUT_REGION * out.duration, out.audioEnd - EDGE_S) - MIX_CONTEXT_S), out.audioEnd, [
      out.audioEnd - BEAT_EDGE_S,
      out.audioEnd,
    ]);
    const sideB = sideOf(to.buffer, inc.leadIn, Math.min(inc.audioEnd, IN_REGION * inc.duration + MIX_CONTEXT_S), [inc.leadIn, inc.leadIn + BEAT_EDGE_S]);
    const gridA = sideA.grid;
    const gridB = sideB.grid;
    const levels = {
      outEnd: levelDb(from.buffer, out.audioEnd - EDGE_S, out.audioEnd, from.level),
      inStart: levelDb(to.buffer, inc.leadIn, inc.leadIn + EDGE_S, to.level),
    };
    const plan = planMix(out, inc, sideA, sideB, levels);
    if (import.meta.env.DEV) {
      const bpm = (g: BeatGrid | null): string => (g ? (60 / g.period).toFixed(1) : '?');
      console.debug(
        `[transition] ${bpm(gridA)} -> ${bpm(gridB)} BPM, edges ${levels.outEnd.toFixed(1)} -> ${levels.inStart.toFixed(1)} dB:`,
        plan ? `${plan.style}${plan.locked ? ' (beat-matched)' : ''}${plan.bassOnDrop ? ', bass on the drop' : ''}, ${plan.beats / 4} bars, ${plan.window.toFixed(1)} s` : 'crossfade',
        sideA.features && sideB.features ? `keys ${keyName(sideA.features.key)} -> ${keyName(sideB.features.key)}` : '',
      );
    }
    if (!plan) return null;
    // The splice into the render: the outgoing track hands over this early.
    const start = plan.cueA - plan.pre + RENDER_MARGIN_S;
    if (start < from.position() + LEAD + 1) return null;
    const t0 = performance.now();
    const rendered = await renderMix(from.buffer, to.buffer, plan, from.level, to.level);
    if (import.meta.env.DEV) console.debug(`[transition] rendered in ${Math.round(performance.now() - t0)} ms`);
    const end = rendered.buffer.duration - RENDER_MARGIN_S;
    to.setIntro({ buffer: rendered.buffer, from: RENDER_MARGIN_S, to: end, trackAt: rendered.incomingAt, splice: SPLICE_S });
    return {
      kind: 'mix',
      start,
      inOffset: 0,
      outFade: null,
      inFade: null,
      outStop: start + SPLICE_S,
      bassSwap: null,
    };
  }

  /** Schedules `plan`: `voice` starts at context time `when` while `from` fades and stops. */
  #apply(from: Voice, voice: Voice, when: number, plan: TransitionPlan): void {
    // Automation first: if scheduling it fails, nothing has started yet.
    try {
      if (plan.inFade) {
        automate(voice.fade, 'in', when + (plan.inFade.at - plan.inOffset), plan.inFade.duration);
      }
      if (plan.outFade) automate(from.fade, 'out', from.timeAt(plan.outFade.at), plan.outFade.duration);
      if (plan.kind === 'mix') {
        // The render starts with the outgoing track itself: a short linear
        // overlap (same material on both sides) hands over to it.
        const g = from.fade.gain;
        holdFrom(g, when);
        g.setValueAtTime(1, when);
        g.linearRampToValueAtTime(0, when + SPLICE_S);
      }
      if (plan.bassSwap) {
        const at = from.timeAt(plan.bassSwap.at);
        swapBass(voice.bass, at, plan.bassSwap.duration, 'in');
        swapBass(from.bass, at, plan.bassSwap.duration, 'out');
      }
    } catch (err) {
      resetTransition(from, this.#ctx.currentTime);
      if (plan.kind !== 'skip') {
        voice.dispose();
        throw err;
      }
      // A manual switch still happens, as a cut.
      fadeOutNow(from, this.#timers, 0.05);
      resetTransition(voice, this.#ctx.currentTime);
    }
    voice.start(when, plan.inOffset);

    // Fades already run on the audio clock; timers only do bookkeeping, and
    // the stop lands after the fade has reached silence. Gapless sources
    // simply run out at the end of their buffer.
    const cancelStop =
      plan.kind === 'gapless' ? () => {} : this.#timers.at(from.timeAt(plan.outStop) + 0.05, () => from.kill());
    if (plan.kind === 'skip') {
      // Manual switches take effect at once; the caller makes `voice` current.
      this.#retire(from);
      return;
    }
    const scheduled: Scheduled = { voice, from, when, plan, cancelTimers: () => {} };
    const promoteIfPending = (): void => {
      if (this.#next === scheduled) this.#promote();
    };
    const cancelPromote = this.#timers.at(when, promoteIfPending);
    scheduled.cancelTimers = () => {
      cancelPromote();
      cancelStop();
    };
    this.#next = scheduled;
    from.onEnded = () => {
      // Fallback in case the promote timer ran late.
      promoteIfPending();
      this.#fading.delete(from);
    };
  }

  #promote(): void {
    const next = this.#next;
    if (!next) return;
    this.#next = null;
    this.#retire(next.from);
    this.#queue.advance(next.voice.track);
    this.#makeCurrent(next.voice);
  }

  #retire(voice: Voice): void {
    this.#fading.add(voice);
    voice.onEnded = () => this.#fading.delete(voice);
  }

  #makeCurrent(voice: Voice): void {
    this.#current = voice;
    this.#watchEnd(voice);
    this.#setState(this.#state === 'paused' ? 'paused' : 'playing', voice.track);
    this.#listener.trackChanged(voice.track);
    this.#evictBuffers();
    void this.#prepareNext();
  }

  #cancelNext(): void {
    const next = this.#next;
    if (!next) return;
    this.#next = null;
    next.cancelTimers();
    next.voice.dispose();
    if (next.voice instanceof BufferVoice) next.voice.setIntro(null);
    resetTransition(next.from, this.#ctx.currentTime);
    if (next.from === this.#current) this.#watchEnd(next.from);
  }

  /** End of the current track: hand over if a transition is pending, else stop. */
  #watchEnd(voice: Voice): void {
    voice.onEnded = () => {
      if (this.#current !== voice) return;
      if (this.#next) return this.#promote();
      const queued = this.#queue.peek();
      if (queued) return void this.#switchTo(queued, true);
      this.#current = null;
      this.#setState('idle', null);
    };
  }

  #detail(track: Track): Promise<Track> {
    if (track.transition && track.loudness) return Promise.resolve(track);
    let pending = this.#details.get(track.id);
    if (!pending) {
      pending = api.track(track.id);
      pending.catch(() => this.#details.delete(track.id));
      this.#details.set(track.id, pending);
    }
    return pending;
  }

  /**
   * `prev` is the track before this one (null for a manual start);
   * `lookahead` is the queue index of the track after it. Contiguous album
   * tracks use album gain so the album keeps its own dynamics.
   */
  async #createVoice(track: Track, prev: Track | null, lookahead: number): Promise<Voice> {
    if (!track.playable) throw new Error(`codec ${track.codec} not supported`);
    const after = this.#queue.peek(lookahead);
    const albumMode = (prev && isContiguous(prev, track)) || (after && isContiguous(track, after));
    const norm = normalizationGain(track.loudness, albumMode ? 'album' : 'track');
    if (track.durationMs / 1000 > STREAM_OVER_S) {
      return StreamVoice.create(this.#ctx, this.#master, track, norm, this.#timers);
    }
    const buffer = await this.#buffer(track);
    return new BufferVoice(this.#ctx, this.#master, track, norm, buffer);
  }

  #buffer(track: Track): Promise<AudioBuffer> {
    const cached = this.#buffers.get(track.id);
    if (cached) return cached;
    const pending = fetch(api.audioUrl(track.id))
      .then((res) => {
        if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => this.#ctx.decodeAudioData(bytes));
    pending.catch(() => this.#buffers.delete(track.id));
    this.#buffers.set(track.id, pending);
    return pending;
  }

  /** Decoded audio is large (~23 MB/min): keep only what is playing or queued next. */
  #evictBuffers(): void {
    const keep = new Set([...this.#voices()].map((v) => v.track.id));
    const next = this.#queue.peek();
    if (next) keep.add(next.id);
    for (const id of this.#buffers.keys()) if (!keep.has(id)) this.#buffers.delete(id);
  }

  *#voices(): Iterable<Voice> {
    if (this.#current) yield this.#current;
    if (this.#next) yield this.#next.voice;
    yield* this.#fading;
  }

  #setState(state: PlayState, track: Track | null = this.track): void {
    this.#state = state;
    this.#listener.state(state, track);
  }
}

/** Fades a voice from wherever its gain is now to silence, then kills it. */
function fadeOutNow(voice: Voice, timers: ClockTimers, duration: number): void {
  const g = voice.fade.gain;
  const now = voice.fade.context.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + duration);
  timers.at(now + duration + 0.05, () => voice.kill());
}

/** Drops pending fade and EQ automation: full level, flat bass. */
function resetTransition(voice: Voice, now: number): void {
  for (const [param, value] of [
    [voice.fade.gain, 1],
    [voice.bass.gain, 0],
  ] as const) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }
}

/** Bass cut while the other track carries the low end, in dB. */
const BASS_CUT_DB = -18;

/** Incoming ('in') gets its bass back over the window; outgoing ('out') hands it over. */
function swapBass(filter: BiquadFilterNode, at: number, duration: number, shape: 'in' | 'out'): void {
  const p = filter.gain;
  const now = filter.context.currentTime;
  const [from, to] = shape === 'in' ? [BASS_CUT_DB, 0] : [0, BASS_CUT_DB];
  const begin = Math.max(at, now);
  p.cancelScheduledValues(now);
  p.setValueAtTime(from, now);
  p.setValueAtTime(from, begin);
  p.linearRampToValueAtTime(to, begin + duration);
}

/** Seconds analysed beyond each cue region, so a 16-bar window fits. */
const MIX_CONTEXT_S = 32;
/** Bittner et al.: cue regions are the outgoing track's last quarter and the incoming one's first fifth. */
const OUT_REGION = 0.75;
const IN_REGION = 0.2;

/** Seconds next to the edge that the beat falls back to when the whole region has none steady enough. */
const BEAT_EDGE_S = 20;

/**
 * Beat grid and beat-by-beat features of buffer[from..to). A long region
 * can hold beatless passages that blur the beat: then the grid comes from
 * `edge` alone (where the tracks actually meet).
 */
function sideOf(buffer: AudioBuffer, from: number, to: number, edge: [number, number]): Side {
  const rate = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(buffer.length, Math.floor(to * rate));
  if (b - a < rate * 6) return { grid: null, features: null };
  const mono = new Float32Array(b - a);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch).subarray(a, b);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / buffer.numberOfChannels;
  }
  const whole = beatGrid(mono, rate, a / rate);
  const grid = whole && whole.confidence >= MIN_MIX_CONFIDENCE ? whole : (gridOf(buffer, edge[0], edge[1]) ?? whole);
  const features: BeatFeatures | null = grid ? beatFeatures(mono, rate, a / rate, grid) : null;
  return { grid, features };
}

const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const keyName = (k: Key): string => `${NOTES[k.root]}${k.minor ? 'm' : ''}`;
/** Seconds of each edge whose loudness sets the mix's style. */
const EDGE_S = 10;

/** RMS level of buffer[from..to) after `gain`, in dB. */
function levelDb(buffer: AudioBuffer, from: number, to: number, gain: number): number {
  const rate = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(buffer.length, Math.floor(to * rate));
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = a; i < b; i += 4) {
      sum += (d[i] ?? 0) ** 2;
      n++;
    }
  }
  return 10 * Math.log10((sum / Math.max(n, 1)) * gain * gain + 1e-12);
}

/** Seconds of steady beat looked at on each side of a blend. */
const BEAT_CONTEXT_S = 10;

/**
 * Moves a crossfade by under half a beat so the incoming track's beats
 * fall on the outgoing one's (when both are decoded and their tempos are
 * compatible), and snaps the bass swap to a beat.
 */
function alignToBeat(plan: TransitionPlan, from: Voice, to: Voice): TransitionPlan {
  if (plan.kind !== 'crossfade' || !from.buffer || !to.buffer) return plan;
  const overlap = plan.outStop - plan.start;
  const out = gridOf(from.buffer, plan.start - BEAT_CONTEXT_S, plan.outStop);
  const inc = gridOf(to.buffer, plan.inOffset, plan.inOffset + overlap + BEAT_CONTEXT_S);
  if (!out || !inc) return plan;
  const delta = beatShift(out, inc, plan.start, plan.inOffset, overlap);
  if (import.meta.env.DEV) {
    const bpm = (g: BeatGrid): string => (60 / g.period).toFixed(1);
    console.debug(`[transition] ${bpm(out)} -> ${bpm(inc)} BPM, ${delta === null ? 'not locked' : `shift ${delta.toFixed(3)} s`}`);
  }
  return delta === null ? plan : shiftPlan(plan, delta, from.duration, out);
}

function gridOf(buffer: AudioBuffer, from: number, to: number): BeatGrid | null {
  const rate = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(buffer.length, Math.floor(to * rate));
  if (b - a < rate * 6) return null;
  const mono = new Float32Array(b - a);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch).subarray(a, b);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / buffer.numberOfChannels;
  }
  return beatGrid(mono, rate, a / rate);
}

function automate(gain: GainNode, shape: 'in' | 'out', at: number, duration: number): void {
  const p = gain.gain;
  const now = gain.context.currentTime;
  const start = Math.max(at, now);
  const dur = Math.max(duration - (start - at), 0.01);
  if (shape === 'in') {
    // A fresh voice: silent until its fade starts.
    p.cancelScheduledValues(now);
    p.setValueAtTime(0, now);
  } else {
    // The outgoing voice may still be in its own fade-in (up to 12 s).
    // Writing a value inside a running curve throws, which used to leave
    // the incoming track playing over this one at full level; keep
    // whatever runs before `start` instead.
    holdFrom(p, start);
  }
  p.setValueCurveAtTime(fadeCurve(shape), start, dur);
}

/** Drops automation from `t` on, keeping the value reached there. */
function holdFrom(p: AudioParam, t: number): void {
  // Firefox lacks cancelAndHoldAtTime.
  const hold = (p as Partial<AudioParam>).cancelAndHoldAtTime;
  if (hold) hold.call(p, t);
  else p.cancelScheduledValues(t);
}
