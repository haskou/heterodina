// A voice is one track sounding through: source -> norm gain -> bass EQ -> fade gain -> master.
// BufferVoice plays a decoded AudioBuffer with sample-exact scheduling;
// StreamVoice plays very long tracks through a media element so they
// never have to be decoded into memory whole.

import type { Track } from '../../shared/types.ts';
import { api } from './api.ts';
import type { ClockTimers } from './clock.ts';

const DECLICK = 0.03;
/** Kick and bass live below this. */
const BASS_SHELF_HZ = 200;

export interface Voice {
  readonly track: Track;
  readonly duration: number;
  /** Fade automation for transitions. */
  readonly fade: GainNode;
  /** Low-shelf EQ for bass hand-overs during transitions (gain in dB, 0 = flat). */
  readonly bass: BiquadFilterNode;
  /** Decoded audio, when the whole track is in memory (for beat analysis). */
  readonly buffer: AudioBuffer | null;
  /** Whether sample-exact timing is available (needed for gapless). */
  readonly exact: boolean;
  /** Normalization gain applied to this track. */
  readonly level: number;
  start(when: number, offset: number): void;
  /** Current position in the track, in seconds. */
  position(): number;
  /** Context time at which track time `t` plays (or is expected to). */
  timeAt(t: number): number;
  seek(offset: number): void;
  pause(): void;
  resume(): void;
  /** Quick declicked stop; fires onEnded. */
  kill(): void;
  /** Immediate teardown; does not fire onEnded. */
  dispose(): void;
  onEnded: (() => void) | null;
}

/**
 * A rendered transition that a BufferVoice plays before the rest of its
 * own track: from rendered time `from` to `to`, then the track itself from
 * `trackAt(to)`, with a short overlap so the splice never clicks.
 */
export interface Intro {
  buffer: AudioBuffer;
  from: number;
  to: number;
  /** Track time heard at rendered time t. */
  trackAt: (t: number) => number;
  /** Overlap at each splice (s). */
  splice: number;
}

abstract class BaseVoice {
  readonly track: Track;
  readonly fade: GainNode;
  readonly bass: BiquadFilterNode;
  protected readonly ctx: AudioContext;
  protected readonly norm: GainNode;
  onEnded: (() => void) | null = null;
  protected disposed = false;

  get level(): number {
    return this.norm.gain.value;
  }

  constructor(ctx: AudioContext, destination: AudioNode, track: Track, normGain: number) {
    this.ctx = ctx;
    this.track = track;
    this.norm = ctx.createGain();
    this.norm.gain.value = normGain;
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = BASS_SHELF_HZ;
    this.bass.gain.value = 0;
    this.fade = ctx.createGain();
    this.norm.connect(this.bass).connect(this.fade).connect(destination);
  }

  protected rampFadeToZero(): number {
    const now = this.ctx.currentTime;
    const g = this.fade.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + DECLICK);
    return now + DECLICK;
  }

  protected teardown(): void {
    this.disposed = true;
    this.norm.disconnect();
    this.bass.disconnect();
    this.fade.disconnect();
  }
}

export class BufferVoice extends BaseVoice implements Voice {
  readonly exact = true;
  readonly #buffer: AudioBuffer;

  get buffer(): AudioBuffer {
    return this.#buffer;
  }
  #source: AudioBufferSourceNode | null = null;
  #sourceGain: GainNode | null = null;
  #t0 = 0;
  #offset = 0;
  #started = false;
  #intro: Intro | null = null;
  #introSource: AudioBufferSourceNode | null = null;
  /** Context time at which the intro's `from` plays. */
  #introAt = 0;

  constructor(ctx: AudioContext, destination: AudioNode, track: Track, normGain: number, buffer: AudioBuffer) {
    super(ctx, destination, track, normGain);
    this.#buffer = buffer;
  }

  get duration(): number {
    return this.#buffer.duration;
  }

  /** Plays `intro` first on the next start(); the start offset is then ignored. */
  setIntro(intro: Intro | null): void {
    this.#intro = intro;
  }

  start(when: number, offset: number): void {
    this.#started = true;
    const intro = this.#intro;
    if (!intro) return this.#play(when, offset, false);
    // Render first, then the track from where the render leaves it. Both
    // are scheduled now, so the splice is sample-exact; the two overlap by
    // `splice` with linear ramps (same material on both sides).
    const source = this.ctx.createBufferSource();
    source.buffer = intro.buffer;
    const gain = this.ctx.createGain();
    const length = intro.to - intro.from;
    const end = when + length;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + intro.splice);
    gain.gain.setValueAtTime(1, end - intro.splice);
    gain.gain.linearRampToValueAtTime(0, end);
    source.connect(gain).connect(this.norm);
    source.start(when, intro.from);
    stopQuietly(source, end + 0.01);
    source.onended = () => gain.disconnect();
    this.#introSource = source;
    this.#introAt = when;
    const resume = intro.trackAt(intro.to - intro.splice);
    this.#play(end - intro.splice, resume, true, intro.splice);
  }

  #play(when: number, offset: number, declickIn: boolean, ramp = DECLICK): void {
    const source = this.ctx.createBufferSource();
    source.buffer = this.#buffer;
    const gain = this.ctx.createGain();
    if (declickIn) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + ramp);
    }
    source.connect(gain).connect(this.norm);
    source.start(when, offset);
    source.onended = () => {
      if (this.#source !== source) return;
      this.dispose();
      this.onEnded?.();
    };
    this.#source = source;
    this.#sourceGain = gain;
    this.#t0 = when - offset;
    this.#offset = offset;
  }

  position(): number {
    if (!this.#started) return this.#offset;
    const now = this.ctx.currentTime;
    const intro = this.#intro;
    if (this.#introSource && intro && now < this.#t0 + this.#offset) {
      // Inside the rendered transition: where the track's own music is.
      return Math.min(Math.max(intro.trackAt(intro.from + now - this.#introAt), 0), this.duration);
    }
    return Math.min(Math.max(now - this.#t0, 0), this.duration);
  }

  timeAt(t: number): number {
    return this.#t0 + t;
  }

  seek(offset: number): void {
    if (!this.#source || !this.#sourceGain) return;
    this.#stopIntro();
    const old = this.#source;
    const oldGain = this.#sourceGain;
    const now = this.ctx.currentTime;
    oldGain.gain.setValueAtTime(oldGain.gain.value, now);
    oldGain.gain.linearRampToValueAtTime(0, now + DECLICK);
    old.onended = null;
    stopQuietly(old, now + DECLICK);
    window.setTimeout(() => oldGain.disconnect(), 200);
    this.#play(now + 0.01, Math.min(Math.max(offset, 0), this.duration - 0.05), true);
  }

  pause(): void {}

  resume(): void {}

  kill(): void {
    if (this.disposed) return;
    const end = this.rampFadeToZero();
    const source = this.#source;
    const finish = (): void => {
      this.dispose();
      this.onEnded?.();
    };
    if (source) {
      source.onended = finish;
      stopQuietly(source, end + 0.005);
    } else finish();
  }

  #stopIntro(): void {
    if (!this.#introSource) return;
    this.#introSource.onended = null;
    stopQuietly(this.#introSource);
    this.#introSource.disconnect();
    this.#introSource = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.#stopIntro();
    if (this.#source) {
      this.#source.onended = null;
      stopQuietly(this.#source);
    }
    this.#source = null;
    this.#sourceGain?.disconnect();
    this.teardown();
  }
}

export class StreamVoice extends BaseVoice implements Voice {
  readonly exact = false;
  readonly buffer = null;
  readonly #el: HTMLAudioElement;
  readonly #timers: ClockTimers;
  #cancelStart: (() => void) | null = null;
  #wantsPlay = false;

  private constructor(ctx: AudioContext, destination: AudioNode, track: Track, normGain: number, timers: ClockTimers) {
    super(ctx, destination, track, normGain);
    this.#timers = timers;
    this.#el = new Audio();
    this.#el.preload = 'auto';
    ctx.createMediaElementSource(this.#el).connect(this.norm);
    this.#el.addEventListener('ended', () => {
      if (this.disposed) return;
      this.dispose();
      this.onEnded?.();
    });
  }

  static async create(
    ctx: AudioContext,
    destination: AudioNode,
    track: Track,
    normGain: number,
    timers: ClockTimers,
  ): Promise<StreamVoice> {
    const voice = new StreamVoice(ctx, destination, track, normGain, timers);
    const el = voice.#el;
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('canplay', () => resolve(), { once: true });
      el.addEventListener('error', () => reject(new Error(`stream error ${el.error?.code ?? ''}`)), { once: true });
      el.src = api.audioUrl(track.id);
    });
    return voice;
  }

  get duration(): number {
    return Number.isFinite(this.#el.duration) ? this.#el.duration : this.track.durationMs / 1000;
  }

  start(when: number, offset: number): void {
    this.#el.currentTime = offset;
    this.#cancelStart = this.#timers.at(when, () => {
      this.#cancelStart = null;
      this.#wantsPlay = true;
      void this.#el.play();
    });
  }

  position(): number {
    return this.#el.currentTime;
  }

  timeAt(t: number): number {
    return this.ctx.currentTime + (t - this.#el.currentTime);
  }

  seek(offset: number): void {
    this.#el.currentTime = Math.min(Math.max(offset, 0), this.duration - 0.05);
  }

  pause(): void {
    if (this.#wantsPlay) this.#el.pause();
  }

  resume(): void {
    if (this.#wantsPlay) void this.#el.play();
  }

  kill(): void {
    if (this.disposed) return;
    this.rampFadeToZero();
    window.setTimeout(() => {
      this.dispose();
      this.onEnded?.();
    }, DECLICK * 1000 + 20);
  }

  dispose(): void {
    if (this.disposed) return;
    this.#cancelStart?.();
    this.#wantsPlay = false;
    this.#el.pause();
    this.#el.removeAttribute('src');
    this.#el.load();
    this.teardown();
  }
}

function stopQuietly(source: AudioScheduledSourceNode, when?: number): void {
  try {
    source.stop(when);
  } catch {
    // Never started or already stopped.
  }
}
