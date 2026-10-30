// Renders a beat-matched transition (shared/mix.ts) into one buffer: both
// tracks time-stretched onto the shared tempo (the incoming one pitch
// shifted when the plan matches keys), then mixed offline through
// a three-band EQ, filters, echo, reverb and a noise riser automated by
// the plan's style. The engine splices the result between the two tracks.

import { controls, HP_CLOSED_HZ, LP_CLOSED_HZ, mixLength, sourceA, sourceB, type Controls, type MixPlan } from '../../shared/mix.ts';
import { pitchStretch, stretch } from '../../shared/stretch.ts';

/** Band edges of the three-band EQ (Hz). */
const LOW_MID_HZ = 250;
const MID_HIGH_HZ = 2500;
/**
 * Butterworth Q for Web Audio low/high-pass biquads, whose Q is in dB
 * (1/sqrt(2) as a plain number resonates and the crossover bands no
 * longer sum flat: the whole mix came out up to 7 dB louder).
 */
const BUTTERWORTH_Q_DB = -3.0103;
/** Undoes the fixed makeup gain Web Audio's compressor adds with our settings (about +1 dB). */
const LIMITER_MAKEUP = 10 ** (-1.01 / 20);
/** Automation resolution: points per rendered second. */
const POINTS_PER_S = 100;
/** Effect levels against the normalized music. */
const RISER_LEVEL = 0.22;
const REVERB_LEVEL = 0.6;
const ECHO_FEEDBACK = 0.5;
/** Seconds of the splice at each end where render and original overlap. */
export const SPLICE_S = 0.01;
/** Where playback of the render starts and stops: the stretcher's first and last frames are partial. */
export const RENDER_MARGIN_S = 0.06;

export interface RenderedMix {
  buffer: AudioBuffer;
  /** Incoming-track time heard at rendered time t (negative before it enters). */
  incomingAt: (t: number) => number;
  /** Outgoing-track time heard at rendered time t. */
  outgoingAt: (t: number) => number;
}

/**
 * `gainA` and `gainB` are the tracks' normalization gains. The render is
 * played through the incoming voice (which applies gainB), so the outgoing
 * side is scaled by gainA / gainB.
 */
export async function renderMix(a: AudioBuffer, b: AudioBuffer, plan: MixPlan, gainA: number, gainB: number): Promise<RenderedMix> {
  const rate = a.sampleRate;
  const seconds = mixLength(plan);
  const length = Math.ceil(seconds * rate);
  const windowEnd = plan.pre + plan.window;
  const u = (t: number): number => (t - plan.pre) / plan.window;
  const stretched = {
    out: stretch(channels(a), rate, (t) => sourceA(plan, t), seconds),
    // A key match: the incoming track starts in the outgoing key and glides back to its own pitch.
    in: pitchStretch(channels(b), rate, (t) => sourceB(plan, t), seconds, (t) => plan.pitch * (1 - Math.min(Math.max(u(t), 0), 1))),
  };
  // Hard edges in the data itself (automation points are 10 ms apart): the
  // outgoing track ends on the window's last beat, the incoming starts on its first.
  if (plan.style === 'brake') brake(stretched.out, Math.round(windowEnd * rate), Math.round((60 / plan.bpmB) * rate));
  if (plan.style === 'spinback') spinback(stretched.out, Math.round(windowEnd * rate), Math.round((60 / plan.bpmB) * rate));
  cut(stretched.out, Math.round(windowEnd * rate), rate, 'after');
  cut(stretched.in, Math.round(plan.pre * rate), rate, 'before');

  const ctx = new OfflineAudioContext(2, length, rate);
  // Two full tracks overlapping can peak over 0 dBFS: catch only the peaks.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  const trim = ctx.createGain();
  trim.gain.value = LIMITER_MAKEUP;
  limiter.connect(trim).connect(ctx.destination);

  const beat = 1 / plan.beats;
  const points = Math.max(2, Math.ceil(seconds * POINTS_PER_S));
  const automate = (param: AudioParam, value: (t: number) => number): void => {
    const curve = new Float32Array(points);
    for (let i = 0; i < points; i++) curve[i] = value((i / (points - 1)) * seconds);
    param.setValueCurveAtTime(curve, 0, seconds);
  };
  const filter = (type: BiquadFilterType, hz: number, q = BUTTERWORTH_Q_DB): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    return f;
  };
  const chain = (...nodes: AudioNode[]): AudioNode => {
    for (let i = 1; i < nodes.length; i++) nodes[i - 1]!.connect(nodes[i]!);
    return nodes.at(-1)!;
  };

  // Shared effect buses: an echo a dotted eighth long at the incoming
  // tempo, and a plain synthetic reverb.
  const echo = ctx.createDelay(2);
  echo.delayTime.value = (0.75 * 60) / plan.bpmB;
  const feedback = ctx.createGain();
  feedback.gain.value = ECHO_FEEDBACK;
  const echoTone = filter('lowpass', 3200);
  chain(echo, echoTone, feedback, echo);
  echoTone.connect(limiter);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 3.2);
  const reverbLevel = ctx.createGain();
  reverbLevel.gain.value = REVERB_LEVEL;
  chain(reverb, reverbLevel, limiter);

  for (const side of ['out', 'in'] as const) {
    const data = stretched[side];
    const buffer = ctx.createBuffer(2, length, rate);
    buffer.copyToChannel(data[0]!, 0);
    buffer.copyToChannel(data[1] ?? data[0]!, 1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = side === 'out' ? gainA / gainB : 1;
    source.connect(level);

    // Linkwitz-Riley crossovers (two Butterworths each): the bands sum flat.
    const low = ctx.createGain();
    const mid = ctx.createGain();
    const high = ctx.createGain();
    chain(level, filter('lowpass', LOW_MID_HZ), filter('lowpass', LOW_MID_HZ), low);
    chain(level, filter('highpass', LOW_MID_HZ), filter('highpass', LOW_MID_HZ), filter('lowpass', MID_HIGH_HZ), filter('lowpass', MID_HIGH_HZ), mid);
    chain(level, filter('highpass', MID_HIGH_HZ), filter('highpass', MID_HIGH_HZ), high);
    const sum = ctx.createGain();
    for (const band of [low, mid, high]) band.connect(sum);
    // Butterworth Q: a resonant bump at the cutoff makes the sweep itself stand out.
    const lp = filter('lowpass', 20000);
    const hp = filter('highpass', 20);
    const vol = ctx.createGain();
    chain(sum, lp, hp, vol, limiter);
    const echoSend = ctx.createGain();
    const reverbSend = ctx.createGain();
    chain(hp, echoSend, echo);
    chain(hp, reverbSend, reverb);

    const at = (t: number): Controls => controls(plan.style, side, u(t), beat);
    if (side === 'out' && plan.style === 'storm') {
      // Only the kicks and bass feed the echo.
      const send = ctx.createGain();
      chain(low, send, echo);
      automate(send.gain, (t) => at(t).bassEcho);
    }
    if (side === 'out' && plan.style === 'signature') {
      // Jet-plane flanger: a 1-5 ms delay swept slowly, with feedback, after the fader.
      const delay = ctx.createDelay(0.02);
      delay.delayTime.value = 0.003;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.25;
      const depth = ctx.createGain();
      depth.gain.value = 0.0022;
      chain(lfo, depth);
      depth.connect(delay.delayTime);
      const loop = ctx.createGain();
      loop.gain.value = 0.55;
      chain(delay, loop, delay);
      const wet = ctx.createGain();
      chain(vol, delay, wet, limiter);
      automate(wet.gain, (t) => 0.8 * at(t).flange);
      lfo.start(0);
    }
    automate(low.gain, (t) => at(t).low);
    automate(mid.gain, (t) => at(t).mid);
    automate(high.gain, (t) => at(t).high);
    // Sweeps move on a log scale, as the ear hears frequency.
    automate(lp.frequency, (t) => LP_CLOSED_HZ * (20000 / LP_CLOSED_HZ) ** at(t).lp);
    automate(hp.frequency, (t) => HP_CLOSED_HZ * (20 / HP_CLOSED_HZ) ** at(t).hp);
    automate(vol.gain, (t) => at(t).vol);
    automate(echoSend.gain, (t) => at(t).echo);
    automate(reverbSend.gain, (t) => at(t).verb);
    source.start(0);
  }

  if (plan.style === 'rise') {
    // White noise through a band-pass sweeping up: tension into the drop.
    const noise = ctx.createBuffer(1, length, rate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const band = filter('bandpass', 400, 1.4);
    const level = ctx.createGain();
    chain(source, band, level, limiter);
    level.connect(reverb);
    automate(band.frequency, (t) => 300 * (9000 / 300) ** Math.min(Math.max(u(t), 0), 1));
    automate(level.gain, (t) => (RISER_LEVEL * controls('rise', 'out', u(t), beat).riser) / gainB);
    source.start(0);
  }

  return {
    buffer: await ctx.startRendering(),
    incomingAt: (t) => sourceB(plan, t),
    outgoingAt: (t) => sourceA(plan, t),
  };
}

function channels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** Turntable stop: the `length` samples before `end` slow from full speed to standstill. */
function brake(data: Float32Array[], end: number, length: number): void {
  for (const q of data) {
    const start = end - length;
    if (start < 0) continue;
    const source = q.slice(start, end);
    let pos = 0;
    for (let j = 0; j < length; j++) {
      const i = Math.floor(pos);
      const f = pos - i;
      q[start + j] = (source[i] ?? 0) * (1 - f) + (source[i + 1] ?? 0) * f;
      pos += 1 - j / length;
    }
  }
}

/**
 * Spinback: a hand pulls the record backwards from where the last beat
 * starts, fast at first, then lets go; it fades out over the last fifth.
 */
function spinback(data: Float32Array[], end: number, length: number): void {
  for (const q of data) {
    const start = end - length;
    if (start < 0) continue;
    let pos = start;
    for (let j = 0; j < length; j++) {
      const i = Math.floor(pos);
      const f = pos - i;
      const v = i >= 0 ? (q[i] ?? 0) * (1 - f) + (q[i + 1] ?? 0) * f : 0;
      q[start + j] = v * Math.min(1, (length - j) / (0.2 * length));
      pos -= 4 * (1 - j / length) ** 1.5;
    }
  }
}

/** Silences one side of sample `at`, with a 5 ms ramp so the edge doesn't click. */
function cut(data: Float32Array[], at: number, rate: number, side: 'before' | 'after'): void {
  const ramp = Math.round(0.005 * rate);
  for (const q of data) {
    for (let i = 0; i < ramp; i++) {
      const j = side === 'after' ? at - ramp + i : at + i;
      if (j >= 0 && j < q.length) q[j] = (q[j] ?? 0) * (side === 'after' ? 1 - i / ramp : i / ramp);
    }
    if (side === 'after') q.fill(0, Math.max(0, at));
    else q.fill(0, 0, Math.max(0, at));
  }
}

/** Decaying stereo noise: a smooth, neutral room. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(seconds * ctx.sampleRate);
  const ir = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2 * 0.5;
  }
  return ir;
}
