/**
 * Seeded xorshift128 PRNG.
 *
 * The sim never calls Math.random. Anything that needs randomness (surface
 * noise, cosmetic-but-sim-visible jitter) draws from here, seeded from the
 * route's `seed` field, so a given route plays out identically for every player
 * and on every replay.
 *
 * State is four uint32s. All arithmetic is forced back to uint32 with |0 and
 * >>> 0, which is exactly specified in ECMA-262, so the stream is identical
 * across engines.
 */
export interface Rng {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

/**
 * Expand a single 32-bit seed into the four-word state using splitmix32.
 * A raw seed like 1 leaves xorshift with too few set bits and produces a
 * visibly poor first few hundred outputs; splitmix avalanches it first.
 */
export function createRng(seed: number): Rng {
  let z = seed >>> 0;
  const next = (): number => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
  const rng: Rng = { s0: next(), s1: next(), s2: next(), s3: next() };
  // Guard against the all-zero state, which xorshift cannot escape.
  if ((rng.s0 | rng.s1 | rng.s2 | rng.s3) === 0) rng.s0 = 0x9e3779b9;
  return rng;
}

export function cloneRng(rng: Rng): Rng {
  return { s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 };
}

/** Next raw uint32. */
export function nextUint32(rng: Rng): number {
  let t = rng.s3;
  const s = rng.s0;
  rng.s3 = rng.s2;
  rng.s2 = rng.s1;
  rng.s1 = s;
  t ^= t << 11;
  t >>>= 0;
  t ^= t >>> 8;
  rng.s0 = (t ^ s ^ (s >>> 19)) >>> 0;
  return rng.s0;
}

/** Uniform in [0, 1). Division by 2^32 is exact in binary floating point. */
export function nextFloat(rng: Rng): number {
  return nextUint32(rng) / 4294967296;
}

/** Uniform in [lo, hi). */
export function nextRange(rng: Rng, lo: number, hi: number): number {
  return lo + nextFloat(rng) * (hi - lo);
}
