import { clamp } from './math/trig.ts';
import { FLAG_BRAKE, FLAG_INITIATE, STEER_QUANT, THROTTLE_QUANT } from './types.ts';
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
 * 4 bytes per sample: steer int16, throttle uint8, flags uint8 (bit 0: the
 * drift button). Steering runs use only the first field; the others stay at a
 * constant value and compress to almost nothing.
 */

export const BYTES_PER_SAMPLE = 4;

export interface QuantisedInput {
  steer: number;
  throttle: number;
  flags: number;
}

export function quantiseInput(steer: number, throttle = 1, initiate = false, brake = false): QuantisedInput {
  return {
    steer: Math.round(clamp(steer, -1, 1) * STEER_QUANT),
    throttle: Math.round(clamp(throttle, 0, 1) * THROTTLE_QUANT),
    flags: (initiate ? FLAG_INITIATE : 0) | (brake ? FLAG_BRAKE : 0),
  };
}

export function dequantiseInput(q: QuantisedInput, out: SimInput): SimInput {
  out.steer = q.steer / STEER_QUANT;
  out.throttle = q.throttle / THROTTLE_QUANT;
  out.initiate = (q.flags & FLAG_INITIATE) !== 0;
  out.brake = (q.flags & FLAG_BRAKE) !== 0;
  return out;
}

/**
 * Growable buffer of quantised input samples, one per 60Hz sample.
 * Backed by flat typed arrays rather than an array of objects so that encoding
 * is a straight walk with no allocation.
 */
export class InputRecorder {
  private steer: Int16Array;
  private throttle: Uint8Array;
  private flags: Uint8Array;
  private count = 0;

  constructor(capacitySamples = 60 * 180) {
    this.steer = new Int16Array(capacitySamples);
    this.throttle = new Uint8Array(capacitySamples);
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
    out.steer = i < 0 ? 0 : this.steer[i];
    out.throttle = i < 0 ? 0 : this.throttle[i];
    out.flags = i < 0 ? 0 : this.flags[i];
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
    const t = new Uint8Array(next);
    t.set(this.throttle);
    this.throttle = t;
    const f = new Uint8Array(next);
    f.set(this.flags);
    this.flags = f;
  }

  /**
   * Delta-encode to a byte stream.
   *
   * Steering and throttle are continuous signals sampled at 60Hz, so
   * consecutive samples are nearly identical and their deltas are mostly small.
   * That turns a stream of arbitrary values into a stream of near-zero bytes,
   * which is what makes the gzip pass afterwards actually pay off.
   *
   * Laid out in planes -- every steer delta, then every throttle delta, then
   * every flag byte -- rather than sample by sample. A steering run's throttle
   * and flag planes are one long run of zeros that gzip all but deletes;
   * interleaved, those same zeros broke up the steering pattern and cost a
   * third more space.
   */
  encode(): Uint8Array {
    const n = this.count;
    const out = new Uint8Array(n * BYTES_PER_SAMPLE);
    const view = new DataView(out.buffer);
    let prevSteer = 0;
    let prevThrottle = 0;
    for (let i = 0; i < n; i++) {
      // Deltas are stored modulo the field width rather than clamped. A jump
      // from full left to full right in one sample is a delta of 65534, which
      // does not fit in an int16 -- clamping it silently corrupts the replay
      // from that sample onward. Wrapping is exact for every possible pair of
      // values, because the decoder wraps identically.
      view.setUint16(i * 2, (this.steer[i] - prevSteer) & 0xffff, true);
      out[n * 2 + i] = (this.throttle[i] - prevThrottle) & 0xff;
      out[n * 3 + i] = this.flags[i];
      prevSteer = this.steer[i];
      prevThrottle = this.throttle[i];
    }
    return out;
  }

  static decode(bytes: Uint8Array): InputRecorder {
    const n = Math.floor(bytes.length / BYTES_PER_SAMPLE);
    const rec = new InputRecorder(Math.max(n, 1));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let steer = 0;
    let throttle = 0;
    for (let i = 0; i < n; i++) {
      // Wrap, then sign-extend steer back to int16. Exactly inverts the
      // modular deltas the encoder wrote.
      steer = ((steer + view.getUint16(i * 2, true)) << 16) >> 16;
      throttle = (throttle + bytes[n * 2 + i]) & 0xff;
      rec.push({ steer, throttle, flags: bytes[n * 3 + i] });
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
  controls: string;
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
