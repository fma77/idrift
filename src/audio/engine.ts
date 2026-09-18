import workletUrl from './engineWorklet.ts?worker&url';
import { EngineModel, type EngineInputs, type EngineReading } from './engineModel.ts';
import { PROFILES, type EngineProfile, type VoiceParams } from './profiles.ts';
import type { CarParams, EngineKind, SimState } from '../sim/types.ts';

/**
 * Engine and tyre sound. No recordings: the engine note is synthesised pulse
 * by pulse in an audio worklet (engineSynth.ts), driven by an invented engine
 * (engineModel.ts) that turns road speed and throttle into revs, gears, boost
 * and lift-off moments.
 *
 * Completely separate from the physics. It reads sim state and makes noise; it
 * cannot affect anything. Tuning the sound never touches a leaderboard.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private exhaust: BiquadFilterNode | null = null;
  private node: AudioWorkletNode | null = null;
  private squealGain: GainNode | null = null;
  private squealBands: BiquadFilterNode[] = [];
  private lockGain: GainNode | null = null;
  private lastFlick = 0;
  private noise: AudioBufferSourceNode | null = null;
  private model: EngineModel | null = null;
  private profile: EngineProfile | null = null;
  private lastTime = 0;
  private started = false;
  private readonly enabled: boolean;

  /** The latest reading, for the sound lab's display. */
  reading: EngineReading | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Must be called from a user gesture. Browsers refuse to start an AudioContext
   * otherwise, and a silently-failing one is worse than none: the game would
   * appear to work and simply have no sound with no indication why.
   */
  async start(kind: EngineKind): Promise<void> {
    if (!this.enabled || this.started) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      this.ctx = ctx;
      // Resume without waiting: on some phones the promise only settles once
      // the page has been touched again, and the rest of setup must not wait.
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      this.ctx = null;
      return;
    }
    this.started = true;
    this.profile = PROFILES[kind];
    this.model = new EngineModel(this.profile.spec);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // The exhaust opens up with load: muffled off the throttle, bright on it.
    this.exhaust = ctx.createBiquadFilter();
    this.exhaust.type = 'lowpass';
    this.exhaust.frequency.value = 1200;
    this.exhaust.Q.value = 0.9;
    this.exhaust.connect(this.master);

    // Tyre squeal: narrow bands of noise, the sound of rubber sliding. Their
    // pitch rises a little with the angle, so a bigger slide sounds harder.
    this.noise = ctx.createBufferSource();
    this.noise.buffer = makeNoiseBuffer(ctx);
    this.noise.loop = true;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealBands = [];
    for (const [freq, q] of SQUEAL_BANDS) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = q;
      this.noise.connect(band).connect(this.squealGain);
      this.squealBands.push(band);
    }
    this.squealGain.connect(this.master);

    // Locked rear wheels, for the handbrake in a flick: lower and rougher than
    // a slide's squeal -- rubber dragged, not rolled.
    this.lockGain = ctx.createGain();
    this.lockGain.gain.value = 0;
    for (const [freq, q] of [
      [620, 2.2],
      [1450, 3.5],
    ]) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = q;
      this.noise.connect(band).connect(this.lockGain);
    }
    this.lockGain.connect(this.master);
    this.noise.start();

    this.master.gain.setTargetAtTime(0.55, ctx.currentTime, 0.15);
    this.lastTime = ctx.currentTime;

    try {
      await ctx.audioWorklet.addModule(workletUrl);
      if (this.ctx !== ctx) return; // stopped while loading
      this.node = new AudioWorkletNode(ctx, 'engine-voice', {
        numberOfInputs: 0,
        outputChannelCount: [1],
        processorOptions: { voice: this.profile.voice },
      });
      this.node.connect(this.exhaust);
    } catch {
      // No worklet support: tyres only. Rare enough on current browsers not to
      // warrant a second, worse engine synth.
      this.node = null;
    }
  }

  /** Drive the sound from the sim, once per rendered frame. */
  update(state: SimState, car: CarParams): void {
    // A flick starting (or a switch of sides) is the handbrake going on.
    if (state.flickTicks > 0 && this.lastFlick === 0) this.triggerLock();
    this.lastFlick = state.flickTicks;

    this.drive(
      {
        speed: state.speed,
        topSpeed: car.handling.topSpeed,
        throttle: state.throttle,
        sliding: state.sliding,
        slip: state.slipAngle,
      },
      state.sliding ? Math.abs(state.slipAngle) : 0,
    );
  }

  /** Drive the sound from anything: the game above, or the sound lab. */
  drive(inputs: EngineInputs, slide: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.model || !this.profile || !this.master) return;
    const now = ctx.currentTime;
    const dt = Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;

    const r = this.model.update(dt, inputs);
    this.reading = r;

    this.node?.port.postMessage({
      type: 'controls',
      controls: {
        rpm: r.rpm,
        rpmFraction: r.rpmFraction,
        load: r.load,
        boost: r.boost,
        overrun: r.overrun,
        cut: r.cut,
        idleRpm: this.profile.spec.idleRpm,
      },
    });
    if (r.flutter > 0) this.node?.port.postMessage({ type: 'flutter', strength: r.flutter });

    const smooth = 0.03;
    this.exhaust?.frequency.setTargetAtTime(700 + 5200 * r.load * (0.4 + 0.6 * Math.min(1, r.rpmFraction)), now, smooth);

    // Squeal follows the slide, and needs some speed to be heard.
    const squeal = clamp01((slide - 0.12) / 0.5) * clamp01(inputs.speed / 12);
    this.squealGain?.gain.setTargetAtTime(squeal * 0.32, now, 0.05);
    for (let i = 0; i < this.squealBands.length; i++) {
      // A slow waver, as the tyres' grip comes and goes through a slide.
      const waver = 1 + 0.03 * Math.sin(now * (5.3 + i * 2.1));
      const pitch = SQUEAL_BANDS[i][0] * (0.92 + 0.22 * clamp01(slide / 0.9)) * waver;
      this.squealBands[i].frequency.setTargetAtTime(pitch, now, 0.06);
    }
  }

  /**
   * Rear wheels locking: a short, harsh skid. Played when the drift button
   * flicks the car, and from the sound lab.
   */
  triggerLock(): void {
    const ctx = this.ctx;
    if (!ctx || !this.lockGain || !this.master) return;
    const now = ctx.currentTime;
    const g = this.lockGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1.3, now + 0.015);
    g.linearRampToValueAtTime(0.75, now + 0.22);
    g.linearRampToValueAtTime(0, now + 0.46);

    // The tonal part of a skid: a rough note that falls as the wheels scrub
    // speed off.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(560, now);
    osc.frequency.exponentialRampToValueAtTime(360, now + 0.38);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 5;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.25, now + 0.02);
    env.gain.linearRampToValueAtTime(0, now + 0.4);
    osc.connect(band).connect(env).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.45);
  }

  /** Swap the voice live, for the sound lab. */
  setVoice(voice: VoiceParams): void {
    this.node?.port.postMessage({ type: 'voice', voice });
  }

  /** Pause: silence without tearing down, so resuming is instant. */
  suspend(): void {
    void this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    if (!this.ctx) return;
    void this.ctx.resume().catch(() => undefined);
    this.lastTime = this.ctx.currentTime;
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
    setTimeout(() => {
      try {
        this.noise?.stop();
      } catch {
        // Already stopped.
      }
      void ctx.close().catch(() => undefined);
    }, 250);
    this.ctx = null;
    this.node = null;
    this.started = false;
  }
}

/** Centre frequency and sharpness of each squeal band. */
const SQUEAL_BANDS: [number, number][] = [
  [1250, 9],
  [2150, 12],
  [3100, 14],
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
