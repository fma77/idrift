import { sin, cos, clamp, wrapAngle } from '../math/trig.ts';
import { WALL_MARGIN } from './progress.ts';
import type { AssistParams, RouteData, SimState } from '../types.ts';

const GRAVITY = 9.80665;
/**
 * Metres. The furthest the car looks ahead for a corner to brake for. Braking
 * from 195km/h to a hairpin takes most of it, and when the cars were slower
 * 160m was enough; raising their top speeds without raising this had the fast
 * ones arriving at Harunas hairpins still braking.
 */
const MAX_LOOKAHEAD = 340;
/** Seconds. How far ahead road keeping predicts where the car will be. */
const PREDICT_SECONDS = 0.45;
/** Fraction of the half width past which road keeping starts to act. */
const KEEPING_EDGE = 0.8;
/** rad/s. How fast road keeping can bend the path at full strength. */
const MAX_KEEPING_RATE = 2.2;
/**
 * Below this, the thumb is resting rather than steering. Deliberately tiny:
 * a player easing off mid-corner is still driving, and at 0.08 the help cut
 * out exactly when someone unwound the steering early and ran wide.
 */
const STEERING_THRESHOLD = 0.03;

// --- Racing lines ------------------------------------------------------------

/** Metres kept clear of the edge: half a car and a little air. */
const LINE_EDGE = 1.2;
/** The widest line is never taken as more than this many times the centreline radius. */
const MAX_LINE_GAIN = 3;

interface LineInfo {
  /** Corner index for each sample inside a corner, -1 elsewhere. */
  cornerOf: Int16Array;
  /** Per corner: centreline radius, the widest line's radius, usable half-width, and which way it turns. */
  radius: Float64Array;
  lineRadius: Float64Array;
  usable: Float64Array;
  sign: Int8Array;
}

// The last route's lines. One route is driven at a time, so one entry is enough.
let lineRoute: RouteData | null = null;
let lineCached: LineInfo | null = null;

/**
 * Each corner's widest line, worked out once per route.
 *
 * The line from the outside edge on the way in, clipping the inside at the
 * apex, to the outside edge on the way out, is a circle tangent to both
 * outside edges through the inside apex. For a corner turning through theta
 * with centreline radius R and usable half-width w, with c = cos(theta/2):
 *
 *   R_line = (R + w - (R - w) c) / (1 - c)
 *
 * which is R + w for a hairpin and grows without bound as the corner flattens
 * into a kink -- hence the cap.
 */
function lineInfo(route: RouteData): LineInfo {
  if (route === lineRoute && lineCached) return lineCached;
  const s = route.samples;
  const n = route.corners.length;
  const info: LineInfo = {
    cornerOf: new Int16Array(s.x.length).fill(-1),
    radius: new Float64Array(n),
    lineRadius: new Float64Array(n),
    usable: new Float64Array(n),
    sign: new Int8Array(n),
  };
  for (let c = 0; c < n; c++) {
    const corner = route.corners[c];
    for (let i = corner.startIndex; i <= corner.endIndex && i < s.x.length; i++) info.cornerOf[i] = c;
    const R = 1 / Math.max(corner.peakCurvature, 1e-4);
    const w = Math.max(0, s.halfWidth[corner.apexIndex] - LINE_EDGE);
    const theta = Math.abs(wrapAngle(s.heading[corner.endIndex] - s.heading[corner.startIndex]));
    const half = cos(theta / 2);
    const line = half > 0.999 ? R * MAX_LINE_GAIN : (R + w - (R - w) * half) / (1 - half);
    info.radius[c] = R;
    info.lineRadius[c] = clamp(line, R, R * MAX_LINE_GAIN);
    info.usable[c] = w;
    info.sign[c] = corner.sign;
  }
  lineRoute = route;
  lineCached = info;
  return info;
}

/** Where the car sits across the road for this corner: 1 on the outside edge, -1 the inside. */
function lineQualityFor(state: SimState, info: LineInfo, c: number): number {
  // Left-hand corners (sign +1) have their outside on the right, where the
  // lateral offset is negative.
  const outside = -info.sign[c] * state.lateralOffset;
  return clamp(outside / Math.max(0.5, info.usable[c]), -1, 1);
}

/** The radius the car can use through a corner, entered on the given line. */
function usableRadius(info: LineInfo, c: number, quality: number): number {
  const R = info.radius[c];
  return quality >= 0
    ? R + quality * (info.lineRadius[c] - R)
    : Math.max(R * 0.5, R + quality * info.usable[c]);
}

/**
 * Judge the line into each corner as the car turns in, and keep that verdict
 * until it leaves: the apex is meant to be on the inside, so reading the
 * position mid-corner would punish a good line.
 */
export function updateLineQuality(state: SimState, route: RouteData): void {
  const info = lineInfo(route);
  const c = info.cornerOf[state.sampleIndex];
  if (c === state.lineCorner) return;
  state.lineCorner = c;
  state.lineQuality = c >= 0 ? lineQualityFor(state, info, c) : 0;
}

/**
 * The fastest the car may be going right now and still make every corner in
 * view, braking at no more than `braking`.
 *
 * For each centreline sample ahead, grip gives a corner speed, and the distance
 * to it gives how much faster than that the car can be now and still brake in
 * time. The tightest of those is the limit. Returns Infinity when corner
 * braking is switched off or nothing ahead needs it.
 */
export function cornerSpeedLimit(
  state: SimState,
  route: RouteData,
  assist: AssistParams,
  lateralGrip: number,
): number {
  if (assist.cornerSpeed <= 0 || assist.cornerBraking <= 0) return Infinity;

  const s = route.samples;
  const spacing = route.sampleSpacing;
  const last = s.x.length - 1;
  const braking = assist.cornerBraking;
  const lookahead = Math.min(MAX_LOOKAHEAD, (state.speed * state.speed) / (2 * braking) + 20);
  const count = Math.ceil(lookahead / spacing);
  // How far past its nearest sample the car already is.
  const past = state.distance - state.sampleIndex * spacing;
  const mu = lateralGrip * GRAVITY;

  // Line-aware: a corner is judged by the radius the car's line gives it. The
  // corner it is in keeps the line it turned in on; one still ahead counts the
  // outside if the car is already there, and never less than the centreline
  // -- there is still time to get across.
  const info = assist.lineAware > 0 ? lineInfo(route) : null;
  let limit = Infinity;
  for (let j = 0; j <= count; j++) {
    const i = state.sampleIndex + j;
    if (i > last) break;
    let k = Math.abs(s.curvature[i]);
    if (k < 1e-4) continue;
    const c = info ? info.cornerOf[i] : -1;
    if (info && c >= 0) {
      const quality = c === state.lineCorner ? state.lineQuality : Math.max(0, lineQualityFor(state, info, c));
      k *= info.radius[c] / usableRadius(info, c, quality * assist.lineAware);
    }
    const corner = Math.sqrt(mu / k) * assist.cornerSpeed;
    const distance = Math.max(0, j * spacing - past);
    const allowed = Math.sqrt(corner * corner + 2 * braking * distance);
    if (allowed < limit) limit = allowed;
  }
  return limit;
}

/**
 * Bend the car's path back towards the road -- if the player is helping.
 *
 * Predicts where the car will be shortly. Once that is heading towards the
 * edge, the car and its velocity are turned together towards the road, which
 * reads on screen as the car tightening its line rather than being shoved
 * sideways, and changes neither speed nor slide angle.
 *
 * The condition is the whole point. It only acts while the player is steering
 * roughly the right way: into the corner ahead, or back towards the road. Not
 * steering, or steering the wrong way, gets no help, so the car still crashes
 * and the player is still driving.
 *
 * Returns the angle turned this tick, positive = left.
 */
export function roadKeepingTurn(
  state: SimState,
  route: RouteData,
  assist: AssistParams,
  steer: number,
  dt: number,
): number {
  if (assist.roadKeeping <= 0 || state.speed < 2 || Math.abs(steer) < STEERING_THRESHOLD) return 0;

  const s = route.samples;
  const i = state.sampleIndex;
  const roadHeading = s.heading[i];

  // Velocity across the road, world frame, positive = towards the left edge.
  const sinH = sin(state.heading);
  const cosH = cos(state.heading);
  const wx = state.vx * cosH - state.vy * sinH;
  const wy = state.vx * sinH + state.vy * cosH;
  const across = -wx * sin(roadHeading) + wy * cos(roadHeading);

  const predicted = state.lateralOffset + across * PREDICT_SECONDS;
  const half = s.halfWidth[i];
  const edge = half * KEEPING_EDGE;
  const overshoot = Math.abs(predicted) - edge;
  if (overshoot <= 0) return 0;

  // Roughly the right way: steering back towards the road (right when heading
  // off the left edge), or into the corner that is coming.
  const ahead = Math.min(s.x.length - 1, i + Math.round((state.speed * 0.5) / route.sampleSpacing));
  const towardsRoad = steer * predicted > 0;
  const intoCorner = -steer * s.curvature[ahead] > 0;
  if (!towardsRoad && !intoCorner) return 0;

  const strength = clamp(overshoot / (half - edge + WALL_MARGIN), 0, 1);
  const rate = assist.roadKeeping * MAX_KEEPING_RATE * strength;
  return (predicted > 0 ? -1 : 1) * rate * dt;
}
