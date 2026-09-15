/**
 * Deterministic trigonometry.
 *
 * ECMA-262 leaves Math.sin/cos/atan2/pow/exp/log "implementation-approximated":
 * V8, JavaScriptCore and SpiderMonkey are each free to return different
 * last-place bits, and they do. A sim that calls Math.sin diverges between an
 * iPhone and a desktop Chrome within a few thousand ticks, which silently
 * breaks replays, ghosts and any later server-side verification.
 *
 * IMPORTANT, and the part that is easy to get wrong: the lookup table below is
 * NOT built with Math.sin. Doing that would just move the non-determinism from
 * every call into table construction, where it is far harder to spot. The table
 * is generated from a Taylor kernel evaluated with +, - and * only -- operations
 * IEEE-754 specifies exactly -- so the table itself is bit-identical everywhere.
 *
 * Math.sqrt is used elsewhere in the sim and is deliberately allowed: unlike the
 * transcendentals it maps to the hardware SQRTSD instruction on every engine,
 * which IEEE-754 requires to be correctly rounded. Math.abs/min/max/floor/sign
 * are exactly specified and are likewise fine.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const QUARTER_PI = 0.7853981633974483;
export const DEG_TO_RAD = 0.017453292519943295;
export const RAD_TO_DEG = 57.29577951308232;

/** sin(x) for |x| <= PI/4. Odd Taylor series to x^11; error < 1e-11 on range. */
function sinKernel(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800))))))
  );
}

/** cos(x) for |x| <= PI/4. Even Taylor series to x^12; error < 1e-12 on range. */
function cosKernel(x: number): number {
  const x2 = x * x;
  return (
    1 +
    x2 *
      (-1 / 2 +
        x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600))))))
  );
}

/** Exact sin over the full circle, via quadrant reduction onto the kernels. */
function sinExact(a: number): number {
  // Reduce to [0, TWO_PI).
  let t = a - Math.floor(a / TWO_PI) * TWO_PI;
  // Reduce to [0, HALF_PI) plus a quadrant index, then to [-PI/4, PI/4].
  const quadrant = Math.floor(t / HALF_PI) % 4;
  t -= quadrant * HALF_PI;
  const r = t - QUARTER_PI;
  switch (quadrant) {
    // sin(q*PI/2 + QUARTER_PI + r), expanded per quadrant so both kernels stay in range.
    case 0: return sinKernel(r) * 0.7071067811865476 + cosKernel(r) * 0.7071067811865476;
    case 1: return cosKernel(r) * 0.7071067811865476 - sinKernel(r) * 0.7071067811865476;
    case 2: return -(sinKernel(r) * 0.7071067811865476) - cosKernel(r) * 0.7071067811865476;
    default: return sinKernel(r) * 0.7071067811865476 - cosKernel(r) * 0.7071067811865476;
  }
}

const TABLE_BITS = 13;
/** 8192 entries over [0, TWO_PI). Linear interpolation error ~7e-8 rad. */
export const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_SCALE = TABLE_SIZE / TWO_PI;

/**
 * One extra entry so interpolation at the last index does not wrap-index.
 * Built once at module load, from sinExact -- never from Math.sin.
 */
const SIN_TABLE = buildSinTable();

function buildSinTable(): Float64Array {
  const table = new Float64Array(TABLE_SIZE + 1);
  for (let i = 0; i <= TABLE_SIZE; i++) {
    table[i] = sinExact((i * TWO_PI) / TABLE_SIZE);
  }
  return table;
}

/** Deterministic sin. Table lookup with linear interpolation. */
export function sin(a: number): number {
  let t = a * TABLE_SCALE;
  t -= Math.floor(t / TABLE_SIZE) * TABLE_SIZE;
  let i = Math.floor(t);
  const f = t - i;
  // A tiny negative angle -- heading is routinely around -5e-17 when driving in
  // a straight line -- reduces to TABLE_SIZE minus something far below the
  // precision of a double, which rounds to exactly TABLE_SIZE and indexes one
  // past the end of the table. Reading past a TypedArray yields undefined
  // rather than throwing, so this silently poisoned position with NaN.
  if (i >= TABLE_SIZE) i -= TABLE_SIZE;
  else if (i < 0) i += TABLE_SIZE;
  const s0 = SIN_TABLE[i];
  return s0 + (SIN_TABLE[i + 1] - s0) * f;
}

/** Deterministic cos, as a quarter-turn phase shift on the same table. */
export function cos(a: number): number {
  return sin(a + HALF_PI);
}

/** Deterministic tan. Guarded against the asymptote so the sim cannot produce Infinity. */
export function tan(a: number): number {
  const c = cos(a);
  const safe = Math.abs(c) < 1e-9 ? (c < 0 ? -1e-9 : 1e-9) : c;
  return sin(a) / safe;
}

/**
 * atan(z) for |z| <= 1. Odd minimax polynomial, max error ~1e-7 rad.
 * Uses only + and *, so it is bit-identical across engines.
 */
function atanUnit(z: number): number {
  const z2 = z * z;
  return (
    z *
    (0.9999772 +
      z2 *
        (-0.33262347 +
          z2 * (0.19354346 + z2 * (-0.11643287 + z2 * (0.05265332 + z2 * -0.0117212)))))
  );
}

/** Deterministic atan over the whole real line. */
export function atan(z: number): number {
  if (z > 1) return HALF_PI - atanUnit(1 / z);
  if (z < -1) return -HALF_PI - atanUnit(1 / z);
  return atanUnit(z);
}

/** Deterministic atan2. Returns a value in (-PI, PI]; atan2(0, 0) is 0. */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax >= ay) {
    const t = atanUnit(y / x);
    if (x < 0) return y >= 0 ? t + PI : t - PI;
    return t;
  }
  const t = atanUnit(x / y);
  return y > 0 ? HALF_PI - t : -HALF_PI - t;
}

/** Integer power by squaring. Exact for small integer exponents; replaces `**`. */
export function powi(base: number, exp: number): number {
  let e = exp < 0 ? -exp : exp;
  let result = 1;
  let b = base;
  while (e > 0) {
    if (e & 1) result *= b;
    b *= b;
    e >>= 1;
  }
  return exp < 0 ? 1 / result : result;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let t = a;
  while (t > PI) t -= TWO_PI;
  while (t <= -PI) t += TWO_PI;
  return t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation. Ordered so that lerp(a, b, 1) returns exactly b. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Signed value moved toward zero by `amount`, never overshooting past zero. */
export function moveToward(value: number, target: number, amount: number): number {
  const d = target - value;
  if (d > amount) return value + amount;
  if (d < -amount) return value - amount;
  return target;
}
