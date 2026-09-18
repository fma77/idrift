import type { VoiceParams } from './profiles.ts';

/**
 * The engine voice, sample by sample.
 *
 * An engine note is a train of exhaust pulses, one per firing. So that is what
 * this makes: a pulse at every firing, each one a short ringing burst whose
 * pitch, length and grit come from the voice, spaced by the engine's firing
 * pattern. Everything characterful is a variation on that train -- a flat
 * four's bunched pulses, a rotary's pulses gathering into groups at idle --
 * plus a few separate layers: intake noise, turbo whistle, the flutter of air
 * surging back through the turbo on lift-off, and overrun pops.
 *
 * Pure DSP with no Web Audio in it, so it runs the same in the audio worklet
 * and in a Node test.
 */

export interface SynthControls {
  rpm: number;
  /** 0..1 of redline. */
  rpmFraction: number;
  load: number;
  boost: number;
  overrun: number;
  cut: boolean;
  idleRpm: number;
}

const TWO_PI = Math.PI * 2;
/** Overlapping pulses kept ringing at once. At 9,000 rpm a pulse arrives every 3ms. */
const VOICES = 6;
/** Seconds the flutter lasts at full strength. */
const FLUTTER_TIME = 0.7;

/** State-variable filter, for the noise layers. */
class Svf {
  private low = 0;
  private band = 0;
  bandpass(x: number, cutoff: number, q: number, sampleRate: number): number {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, sampleRate * 0.2)) / sampleRate);
    const damping = 1 / q;
    this.low += f * this.band;
    const high = x - this.low - damping * this.band;
    this.band += f * high;
    return this.band;
  }
}

export class EngineSynth {
  voice: VoiceParams;
  private readonly sampleRate: number;
  private seed: number;

  // Firing
  private phase = 0;
  private slot = 0;
  private readonly amp = new Float32Array(VOICES);
  private readonly env = new Float32Array(VOICES);
  private readonly ring = new Float32Array(VOICES);
  private readonly ringStep = new Float32Array(VOICES);
  private next = 0;
  private lopePhase = 0;

  // Layers
  private readonly intakeFilter = new Svf();
  private readonly flutterFilter = new Svf();
  private readonly popFilter = new Svf();
  private whistlePhase = 0;
  private flutterLeft = 0;
  private flutterStrength = 0;
  private flutterPhase = 0;
  private flutterEnv = 0;
  private popEnv = 0;
  private lastOut = 0;

  constructor(voice: VoiceParams, sampleRate: number, seed = 0x9e3779b9) {
    this.voice = voice;
    this.sampleRate = sampleRate;
    this.seed = seed >>> 0 || 1;
  }

  /** Air surging back through the turbo: a train of chuffs that slows as it dies. */
  triggerFlutter(strength: number): void {
    this.flutterStrength = Math.max(this.flutterStrength * (this.flutterLeft / FLUTTER_TIME), strength);
    this.flutterLeft = FLUTTER_TIME;
    this.flutterPhase = 0.999;
  }

  /** xorshift32, -1..1. Seeded, so tests hear the same thing every time. */
  private noise(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 2147483648 - 1;
  }

  render(out: Float32Array, c: SynthControls): void {
    const v = this.voice;
    const sr = this.sampleRate;
    const dt = 1 / sr;
    const pattern = v.pattern.length > 0 ? v.pattern : [1];
    const levels = v.levels.length > 0 ? v.levels : [1];

    const firingHz = (Math.max(c.rpm, 100) / 60) * v.firesPerRev;
    // Pulses shorten as revs rise, or at 8,000 rpm they would smear into a drone.
    const decay = v.pulseDecay * (1 - 0.55 * Math.min(1, c.rpmFraction));
    const decayMul = Math.exp(-dt / Math.max(decay, 0.0003));
    const ringHz = v.resonance * (1 + v.resonanceTrack * Math.min(1.1, c.rpmFraction));
    // Idle lope fades out as revs rise: the rotary smooths out when it is working.
    const lopeAmount = v.lope * Math.max(0, Math.min(1, 1 - (c.rpm - c.idleRpm) / (c.idleRpm * 1.2)));
    const loud = 0.28 + 0.72 * c.load;
    const intakeCut = 350 + 2600 * Math.min(1, c.rpmFraction);
    const whistleHz = v.whistleHz * (0.35 + 0.65 * c.boost);

    for (let i = 0; i < out.length; i++) {
      // --- Firings ---
      this.phase += (firingHz * dt) / pattern[this.next % pattern.length];
      this.lopePhase += v.lopeHz * dt;
      if (this.lopePhase >= 1) this.lopePhase -= 1;
      if (this.phase >= 1) {
        this.phase -= 1;
        const k = this.next % levels.length;
        this.next = (this.next + 1) % (pattern.length * levels.length);

        let a = levels[k] * loud * (1 + v.jitter * this.noise());
        if (lopeAmount > 0) {
          // Groups: loud in one part of the lope cycle, near-silent in the other.
          const g = Math.sin(TWO_PI * this.lopePhase);
          a *= 1 - lopeAmount * (0.85 - 0.85 * Math.max(0, g));
          if (this.noise() < -1 + lopeAmount * 0.3) a *= 0.2;
        }
        if (c.cut) {
          a *= 0.15;
          // Fuel cut crackles, a little.
          if (this.noise() > 0.4) this.popEnv = Math.max(this.popEnv, 0.35 * v.pops);
        }
        // Overrun: unburnt fuel popping in the exhaust after lift-off.
        if (c.overrun > 0.05 && this.noise() > 1 - 0.18 * v.pops * c.overrun) {
          this.popEnv = Math.max(this.popEnv, (0.6 + 0.4 * this.noise()) * Math.min(1, v.pops));
        }

        const s = this.slot;
        this.slot = (this.slot + 1) % VOICES;
        this.amp[s] = a;
        this.env[s] = 1;
        this.ring[s] = 0;
        this.ringStep[s] = (ringHz * (1 + 0.04 * this.noise()) * dt) % 1;
      }

      let pulse = 0;
      for (let p = 0; p < VOICES; p++) {
        const e = this.env[p];
        if (e < 1e-4) continue;
        this.ring[p] += this.ringStep[p];
        if (this.ring[p] >= 1) this.ring[p] -= 1;
        // A decaying ring with a sharp front, roughened by noise.
        const body = Math.sin(TWO_PI * this.ring[p]) + 0.5 * Math.sin(2 * TWO_PI * this.ring[p]);
        pulse += this.amp[p] * e * (body * (1 - v.rasp * 0.6) + v.rasp * this.noise());
        this.env[p] = e * decayMul;
      }

      // --- Intake howl, under load ---
      const intake = v.intake > 0 ? this.intakeFilter.bandpass(this.noise(), intakeCut, 2.2, sr) * v.intake * c.load * 0.9 : 0;

      // --- Turbo whistle ---
      let whistle = 0;
      if (v.whistle > 0 && c.boost > 0.02) {
        this.whistlePhase += whistleHz * dt;
        if (this.whistlePhase >= 1) this.whistlePhase -= 1;
        whistle = Math.sin(TWO_PI * this.whistlePhase) * v.whistle * c.boost * c.boost * 0.09;
      }

      // --- Flutter: stu-tu-tu-tu ---
      let flutter = 0;
      if (this.flutterLeft > 0 && v.flutter > 0) {
        const t = 1 - this.flutterLeft / FLUTTER_TIME;
        this.flutterPhase += v.flutterHz * (1 - 0.45 * t) * dt;
        if (this.flutterPhase >= 1) {
          this.flutterPhase -= 1;
          this.flutterEnv = 1;
        }
        this.flutterEnv *= Math.exp(-dt / 0.014);
        const chuff = this.flutterFilter.bandpass(this.noise(), 1500 - 500 * t, 1.6, sr);
        flutter = chuff * this.flutterEnv * this.flutterStrength * v.flutter * (1 - t) * 4.5;
        this.flutterLeft -= dt;
      }

      // --- Pops ---
      let pop = 0;
      if (this.popEnv > 1e-3) {
        pop = this.popFilter.bandpass(this.noise(), 900, 0.9, sr) * this.popEnv * 2.2;
        this.popEnv *= Math.exp(-dt / 0.02);
      }

      // --- Exhaust: drive the pulse train, then mix ---
      const driven = Math.tanh(pulse * v.drive) / Math.tanh(v.drive);
      let sample = (driven * 0.55 + intake + whistle + flutter + pop) * v.gain * 1.3;
      // A gentle one-pole to take the fizz off the top.
      sample = this.lastOut + (sample - this.lastOut) * 0.6;
      this.lastOut = sample;
      // Soft ceiling rather than a hard clip: loud moments saturate like an
      // overdriven exhaust instead of crackling like a broken speaker.
      out[i] = Math.tanh(sample);
    }
  }
}
