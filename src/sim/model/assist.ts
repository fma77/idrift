import { sin, cos, clamp } from '../math/trig.ts';
import { WALL_MARGIN } from './progress.ts';
import type { AssistParams, RouteData, SimState } from '../types.ts';

const GRAVITY = 9.80665;
/** Metres. The furthest the car looks ahead for a corner to brake for. */
const MAX_LOOKAHEAD = 160;
/** Seconds. How far ahead road keeping predicts where the car will be. */
const PREDICT_SECONDS = 0.45;
/** Fraction of the half width past which road keeping starts to act. */
const KEEPING_EDGE = 0.55;
/** rad/s. How fast road keeping can bend the path at full strength. */
const MAX_KEEPING_RATE = 2.2;
/**
 * Below this, the thumb is resting rather than steering. Deliberately tiny:
 * a player easing off mid-corner is still driving, and at 0.08 the help cut
 * out exactly when someone unwound the steering early and ran wide.
 */
const STEERING_THRESHOLD = 0.03;

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

  let limit = Infinity;
  for (let j = 0; j <= count; j++) {
    const i = state.sampleIndex + j;
    if (i > last) break;
    const k = Math.abs(s.curvature[i]);
    if (k < 1e-4) continue;
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
