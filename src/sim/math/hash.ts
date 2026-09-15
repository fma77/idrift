/**
 * FNV-1a over the sim's numeric state, used for divergence detection.
 *
 * A hash is recorded every HASH_INTERVAL ticks alongside a stored run. If we
 * ever add server-side re-simulation, comparing hash streams tells us the exact
 * tick where a replay stopped matching, instead of just "the final score is
 * different". It also catches accidental determinism regressions in CI: run the
 * same input stream twice on different Node versions and diff the hashes.
 */
export const HASH_INTERVAL = 300;

const scratch = new DataView(new ArrayBuffer(8));

/** Mix one float64 into a running 32-bit FNV-1a hash, byte by byte. */
export function hashFloat(hash: number, value: number): number {
  // Normalise -0 to 0 and NaN to a single canonical pattern so that two states
  // that are numerically equal always hash equal.
  const v = value === 0 ? 0 : Number.isNaN(value) ? Number.NaN : value;
  scratch.setFloat64(0, v, true);
  let h = hash;
  for (let i = 0; i < 8; i++) {
    h ^= scratch.getUint8(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function hashInt(hash: number, value: number): number {
  let h = hash;
  const v = value | 0;
  for (let i = 0; i < 4; i++) {
    h ^= (v >>> (i * 8)) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export const HASH_SEED = 0x811c9dc5;
