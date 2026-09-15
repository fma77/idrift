import { clamp } from './math/trig.ts';
import { FLAG_HANDBRAKE, STEER_QUANT, THROTTLE_QUANT } from './types.ts';
import type { SimInput } from './types.ts';

/**
 * Input quantisation.
 *
 * Quantising before the input reaches the sim -- not just before it is written
 * to disk -- is the point. If the sim consumed raw float touch coordinates and
 * the replay stored rounded ones, replaying a run would feed the sim slightly
 * different numbers than the live run did, and the two would diverge. The live
 * run and the replay must see byte-identical input, so everything goes through
 * the quantiser.
 *
 * 4 bytes per sample: steer int16, throttle int8, flags uint8.
 */

export const BYTES_PER_SAMPLE = 4;

export interface QuantisedInput {
  steer: number;
  throttle: number;
  flags: number;
}

export function quantiseInput(steer: number, throttle: number, handbrake: boolean): QuantisedInput {
  return {
    steer: Math.round(clamp(steer, -1, 1) * STEER_QUANT),
    throttle: Math.round(clamp(throttle, -1, 1) * THROTTLE_QUANT),
    flags: handbrake ? FLAG_HANDBRAKE : 0,
  };
}

export function dequantiseInput(q: QuantisedInput, out: SimInput): SimInput {
  out.steer = q.steer / STEER_QUANT;
  out.throttle = q.throttle / THROTTLE_QUANT;
  out.handbrake = (q.flags & FLAG_HANDBRAKE) !== 0;
  return out;
}

/**
 * Growable buffer of quantised input samples, one per 60Hz sample.
 * Backed by a flat Int16Array-compatible layout rather than an array of objects
 * so that encoding is a straight walk with no allocation.
 */
export class InputRecorder {
  private steer: Int16Array;
  private throttle: Int8Array;
  private flags: Uint8Array;
  private count = 0;

  constructor(capacitySamples = 60 * 180) {
    this.steer = new Int16Array(capacitySamples);
    this.throttle = new Int8Array(capacitySamples);
    this.flags = new Uint8Array(capacitySamples);
  }

  get length(): number {
    return this.count;
  }

  push(q: QuantisedInput): void {
    if (this.count >= this.steer.length) this.grow();
    this.steer[this.count] = q.steer;
    this.throttle[this.count] = q.throttle;
    this.flags[this.count] = q.flags;
    this.count++;
  }

  at(index: number, out: QuantisedInput): QuantisedInput {
    const i = Math.min(index, this.count - 1);
    if (i < 0) {
      out.steer = 0;
      out.throttle = 0;
      out.flags = 0;
      return out;
    }
    out.steer = this.steer[i];
    out.throttle = this.throttle[i];
    out.flags = this.flags[i];
    return out;
  }

  reset(): void {
    this.count = 0;
  }

  private grow(): void {
    const next = this.steer.length * 2;
    const s = new Int16Array(next);
    s.set(this.steer);
    this.steer = s;
    const t = new Int8Array(next);
    t.set(this.throttle);
    this.throttle = t;
    const f = new Uint8Array(next);
    f.set(this.flags);
    this.flags = f;
  }

  /**
   * Delta-encode to a byte stream.
   *
   * Steering is a continuous signal sampled at 60Hz, so consecutive samples are
   * nearly identical and their deltas are mostly small. That turns a stream of
   * arbitrary int16s into a stream of near-zero bytes, which is what makes the
   * gzip pass afterwards actually pay off -- gzip on the raw values barely
   * compresses at all.
   */
  encode(): Uint8Array {
    const out = new Uint8Array(this.count * BYTES_PER_SAMPLE);
    const view = new DataView(out.buffer);
    let prevSteer = 0;
    let prevThrottle = 0;
    for (let i = 0; i < this.count; i++) {
      // Deltas are stored modulo the field width rather than clamped. A jump
      // from full left to full right in one sample is a delta of 65534, which
      // does not fit in an int16 -- clamping it silently corrupts the replay
      // from that sample onward, and it only happens on inputs violent enough
      // that nobody would think to test them. Wrapping is exact for every
      // possible pair of values, because the decoder wraps identically.
      const dSteer = (this.steer[i] - prevSteer) & 0xffff;
      const dThrottle = (this.throttle[i] - prevThrottle) & 0xff;
      prevSteer = this.steer[i];
      prevThrottle = this.throttle[i];
      view.setUint16(i * BYTES_PER_SAMPLE, dSteer, true);
      view.setUint8(i * BYTES_PER_SAMPLE + 2, dThrottle);
      view.setUint8(i * BYTES_PER_SAMPLE + 3, this.flags[i]);
    }
    return out;
  }

  static decode(bytes: Uint8Array): InputRecorder {
    const count = Math.floor(bytes.length / BYTES_PER_SAMPLE);
    const rec = new InputRecorder(Math.max(count, 1));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let steer = 0;
    let throttle = 0;
    for (let i = 0; i < count; i++) {
      // Wrap, then sign-extend back to the signed field width. Exactly inverts
      // the modular delta the encoder wrote.
      steer = ((steer + view.getUint16(i * BYTES_PER_SAMPLE, true)) << 16) >> 16;
      throttle = ((throttle + view.getUint8(i * BYTES_PER_SAMPLE + 2)) << 24) >> 24;
      rec.push({ steer, throttle, flags: view.getUint8(i * BYTES_PER_SAMPLE + 3) });
    }
    return rec;
  }
}

/** Header stored alongside every run. Everything needed to reproduce it exactly. */
export interface RunRecord {
  simVersion: number;
  routeId: string;
  routeVersion: number;
  carId: string;
  mode: string;
  assist: number;
  seed: number;
  tickCount: number;
  /** Final score or time, as shown to the player. */
  score: number;
  timeSeconds: number;
  /** State hash every HASH_INTERVAL ticks, for divergence detection. */
  hashes: number[];
  /** Delta-encoded, gzipped input stream. */
  input: Uint8Array;
  recordedAt: number;
}
