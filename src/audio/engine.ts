import type { AudioParams, CarParams, SimState } from '../sim/types.ts';

/**
 * Procedural engine audio. No samples.
 *
 * An oscillator bank stands in for the firing pulses, run through a lowpass
 * whose cutoff tracks load, plus a waveshaper for grit and a noise bed for
 * tyre scrub. Each car differs by a handful of synthesis parameters rather
 * than a recorded loop, which means a new car needs numbers, not a recording
 * session -- and the whole engine layer is a few KB instead of a few MB.
 *
 * Completely separate from the physics. It reads sim state and makes noise; it
 * cannot affect anything. Tuning the sound never touches a leaderboard.
 */

/** Firing pulses per revolution for a four-stroke: one per two cylinders. */
function firingOrder(cylinders: number): number {
  return cylinders / 2;
}

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private whineOsc: OscillatorNode | null = null;
  private whineGain: GainNode | null = null;
  private noise: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private started = false;

  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Must be called from a user gesture. Browsers refuse to start an AudioContext
   * otherwise, and a silently-failing one is worse than none: the game would
   * appear to work and simply have no sound with no indication why.
   */
  async start(params: AudioParams): Promise<void> {
    if (!this.enabled || this.started) return;
    try {
      this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    } catch {
      this.ctx = null;
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeDistortionCurve(params.distortion);
    this.shaper.oversample = '2x';
    this.shaper.connect(this.master);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterBase;
    this.filter.Q.value = 3.2;
    this.filter.connect(this.shaper);

    // One oscillator per notional firing pulse, plus two harmonics. Detuning
    // them very slightly is what stops the result sounding like a test tone.
    const partials = [1, 2, 3, 4.5];
    const levels = [1, 0.55, 0.3, 0.12];
    for (let i = 0; i < partials.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = params.basePitch * partials[i];
      osc.detune.value = (i - 1.5) * 7;

      const gain = ctx.createGain();
      gain.gain.value = levels[i] * 0.22;
      osc.connect(gain).connect(this.filter);
      osc.start(now);

      this.oscillators.push(osc);
      this.oscGains.push(gain);
    }

    // Induction / turbo whine: a high partial that only comes in under load.
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'triangle';
    this.whineOsc.frequency.value = params.basePitch * 12;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineOsc.connect(this.whineGain).connect(this.master);
    this.whineOsc.start(now);

    // Tyre scrub: filtered noise, driven by rear slip.
    this.noise = ctx.createBufferSource();
    this.noise.buffer = makeNoiseBuffer(ctx);
    this.noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1400;
    noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(noiseFilter).connect(this.noiseGain).connect(this.master);
    this.noise.start(now);

    this.master.gain.setTargetAtTime(0.5, now, 0.15);
    this.started = true;
  }

  /**
   * Drive the synth from sim state.
   *
   * Every parameter uses setTargetAtTime rather than a direct assignment: an
   * abrupt frequency change on a running oscillator is an audible click, and at
   * 60fps there would be one every frame.
   */
  update(state: SimState, car: CarParams): void {
    if (!this.started || !this.ctx || !this.filter || !this.master) return;

    const params = car.audio;
    const now = this.ctx.currentTime;
    const smooth = 0.035;

    // There is no engine model any more, so the rev note is invented from road
    // speed: a notional five-speed box, each gear sweeping the upper part of
    // the rev range. Wheelspin in a slide lifts the revs a little, as a real
    // car's would.
    const speedFraction = clamp01(state.speed / car.handling.topSpeed);
    const gearSpan = 1 / 5;
    const inGear = Math.min(speedFraction, 0.999) % gearSpan / gearSpan;
    const slideRev = state.sliding ? clamp01(Math.abs(state.slipAngle) / 0.8) * 0.25 : 0;
    const rpmFraction = clamp01(0.3 + inGear * 0.65 + slideRev);
    const fundamental = params.basePitch * firingOrder(params.cylinders) * (0.55 + rpmFraction * 1.85);

    const partials = [1, 2, 3, 4.5];
    for (let i = 0; i < this.oscillators.length; i++) {
      this.oscillators[i].frequency.setTargetAtTime(fundamental * partials[i], now, smooth);
    }

    // Load, not throttle position: a car at full throttle near the redline is a
    // different sound from one bogging at 2000rpm, and load is what separates
    // them.
    // Always on the throttle, so load is high whenever the car is still pulling.
    const load = clamp01((1 - speedFraction * 0.5) * (0.35 + rpmFraction * 0.65));
    this.filter.frequency.setTargetAtTime(
      params.filterBase + params.filterRange * load,
      now,
      smooth,
    );

    if (this.whineGain) {
      this.whineGain.gain.setTargetAtTime(params.whine * load * 0.06, now, smooth);
    }
    if (this.whineOsc) {
      this.whineOsc.frequency.setTargetAtTime(fundamental * 12, now, smooth);
    }

    // Tyre scrub follows rear slip, so the player hears the drift starting
    // slightly before they can see it in a top-down view.
    if (this.noiseGain) {
      const scrub = state.sliding
        ? clamp01((Math.abs(state.slipAngle) - 0.1) / 0.5) * clamp01(state.speed / 12)
        : 0;
      this.noiseGain.gain.setTargetAtTime(scrub * 0.16, now, 0.05);
    }

    // Duck everything when stationary so idle is not a drone over the menus.
    const presence = 0.25 + clamp01(state.speed / 25) * 0.75;
    this.master.gain.setTargetAtTime(0.5 * presence, now, 0.1);
  }

  stop(): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0, now, 0.08);
    const ctx = this.ctx;
    setTimeout(() => {
      for (const osc of this.oscillators) safeStop(osc);
      safeStop(this.whineOsc);
      safeStop(this.noise);
      void ctx.close();
    }, 300);
    this.oscillators = [];
    this.oscGains = [];
    this.whineOsc = null;
    this.noise = null;
    this.ctx = null;
    this.started = false;
  }
}

function safeStop(node: OscillatorNode | AudioBufferSourceNode | null): void {
  try {
    node?.stop();
  } catch {
    // Already stopped.
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Waveshaper transfer curve. `amount` 0..1 sets how hard the knee is; the
 * classic arctangent-style curve, which adds odd harmonics without the
 * fold-over a hard clip produces.
 *
 * The return type is spelled out because lib.dom requires WaveShaperNode.curve
 * to be backed by an ArrayBuffer specifically, while `new Float32Array(n)` is
 * inferred as the wider ArrayBufferLike. Identical at runtime.
 */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** Two seconds of white noise, looped. Long enough that the loop is inaudible. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
