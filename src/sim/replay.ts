import { clamp } from './math/trig.ts';
import { STEER_QUANT } from './types.ts';
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
 * 2 bytes per sample: steer as int16. Steering is the only input there is.
 */

export const BYTES_PER_SAMPLE = 2;

export interface QuantisedInput {
  steer: number;
}

export function quantiseInput(steer: number): QuantisedInput {
  return { steer: Math.round(clamp(steer, -1, 1) * STEER_QUANT) };
}

export function dequantiseInput(q: QuantisedInput, out: SimInput): SimInput {
  out.steer = q.steer / STEER_QUANT;
  return out;
}

/**
 * Growable buffer of quantised input samples, one per 60Hz sample.
 * Backed by a flat typed array rather than an array of objects so that
 * encoding is a straight walk with no allocation.
 */
export class InputRecorder {
  private steer: Int16Array;
  private count = 0;

  constructor(capacitySamples = 60 * 180) {
    this.steer = new Int16Array(capacitySamples);
  }

  get length(): number {
    return this.count;
  }

  push(q: QuantisedInput): void {
    if (this.count >= this.steer.length) this.grow();
    this.steer[this.count] = q.steer;
    this.count++;
  }

  at(index: number, out: QuantisedInput): QuantisedInput {
    const i = Math.min(index, this.count - 1);
    out.steer = i < 0 ? 0 : this.steer[i];
    return out;
  }

  reset(): void {
    this.count = 0;
  }

  private grow(): void {
    const s = new Int16Array(this.steer.length * 2);
    s.set(this.steer);
    this.steer = s;
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
    for (let i = 0; i < this.count; i++) {
      // Deltas are stored modulo the field width rather than clamped. A jump
      // from full left to full right in one sample is a delta of 65534, which
      // does not fit in an int16 -- clamping it silently corrupts the replay
      // from that sample onward, and it only happens on inputs violent enough
      // that nobody would think to test them. Wrapping is exact for every
      // possible pair of values, because the decoder wraps identically.
      const dSteer = (this.steer[i] - prevSteer) & 0xffff;
      prevSteer = this.steer[i];
      view.setUint16(i * BYTES_PER_SAMPLE, dSteer, true);
    }
    return out;
  }

  static decode(bytes: Uint8Array): InputRecorder {
    const count = Math.floor(bytes.length / BYTES_PER_SAMPLE);
    const rec = new InputRecorder(Math.max(count, 1));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let steer = 0;
    for (let i = 0; i < count; i++) {
      // Wrap, then sign-extend back to int16. Exactly inverts the modular delta
      // the encoder wrote.
      steer = ((steer + view.getUint16(i * BYTES_PER_SAMPLE, true)) << 16) >> 16;
      rec.push({ steer });
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
