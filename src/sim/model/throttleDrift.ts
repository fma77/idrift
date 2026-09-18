import { atan2, sin, cos, clamp, wrapAngle, moveToward, HALF_PI } from '../math/trig.ts';
import { stepVehicle } from './vehicle.ts';
import { cornerSpeedLimit } from './assist.ts';
import { WALL_MARGIN } from './progress.ts';
import type { AssistParams, CarParams, RouteData, SimConfig, SimInput, SimState } from '../types.ts';

/**
 * Drift Run with throttle controls: the game steers, the player drives.
 *
 * The player holds a throttle and taps a drift button. Until they tap, the car
 * goes round corners on grip, steered by the game along the road. A tap flicks
 * the car sideways into the corner ahead -- a small swing the other way first,
 * then into it, the way a driver sets up a Scandinavian flick. From then on the
 * throttle sets the angle:
 *
 *   more throttle -> more angle, less -> the car straightens;
 *   past the limit angle the slide feeds itself and runs away to a spin.
 *
 * So the skill is balance: enough angle to score, not so much that it spins.
 * While sideways the game keeps steering the car's path along the road, and a
 * big angle takes the line wider, where the tail can reach the wall.
 *
 * The drift phase is kinematic rather than force-based: the direction of
 * travel follows the road within a grip budget, and the body is placed at the
 * drift angle to it. That is what makes the angle respond to the throttle
 * directly and legibly, which is the whole game here.
 */

const GRAVITY = 9.80665;
/** m/s. Below this a tap does nothing: there is not enough speed to throw sideways. */
const MIN_INITIATE_SPEED = 8;
/**
 * Radians (~8 degrees). Below this, once the flick is over, the drift has
 * ended. Not lower: from above, a car at 5 degrees looks straight, and a drift
 * the player cannot see is one they cannot tell has not finished.
 */
const END_ANGLE = 0.14;
/** Metres of straight road ahead that count as the corner being over. */
const EXIT_REACH = 25;
/** Radians. The swing away from the corner at the start of a flick. */
const FLICK_SWING = 0.15;
/** rad/s. How fast the flick moves the angle. */
const FLICK_RATE = 7;
/** Fraction of speed the handbrake takes off at the flick. */
const FLICK_SCRUB = 0.06;
/** m/s^2 of engine braking with the throttle fully closed. */
const ENGINE_BRAKE = 2.5;
const SPIN_SECONDS = 0.9;
const SPIN_YAW = 7;
const SPIN_DECEL = 14;
/** How the game steers: rad/s per radian of heading error, and the pull back to the line. */
const HEADING_GAIN = 5;
const LINE_GAIN = 1.2;
/** Radius under which a bend counts as a corner to flick into. */
const CORNER_CURVATURE = 1 / 90;
/** Metres. How close a corner the other way has to be before an unswitched drift unwinds. */
const OPPOSING_REACH = 12;
/** rad/s. How fast it unwinds. */
const OPPOSING_UNWIND = 2.5;

export function stepThrottleControls(
  state: SimState,
  car: CarParams,
  input: SimInput,
  config: SimConfig,
  route: RouteData,
  surfaceGrip: number,
  dt: number,
): void {
  const throttle = clamp(input.throttle, 0, 1);
  // Sawing at the throttle is the equivalent of sawing at the wheel: a save,
  // not a clean drift. Scoring reads it from here.
  state.steerChange = Math.abs(throttle - state.throttle);
  const tapped = input.initiate && !state.initiateHeld;
  state.initiateHeld = input.initiate;

  if (state.spinTicks > 0) {
    stepSpin(state, route, config, surfaceGrip, dt);
    return;
  }

  if (tapped && state.speed > MIN_INITIATE_SPEED) {
    const sign = upcomingCornerSign(state, route);
    if (sign !== 0 && sign !== state.driftDir) {
      if (state.driftDir === 0) {
        // From grip: the handbrake part of the flick costs a little speed.
        state.vx *= 1 - FLICK_SCRUB;
        state.vy *= 1 - FLICK_SCRUB;
        state.speed *= 1 - FLICK_SCRUB;
        state.drift.entryFactor = entryTiming(state, route);
        state.driftAngle = 0;
      } else {
        // A transition: the angle is now measured against the new direction,
        // so the nose swings through straight to the other side.
        state.driftAngle = -state.driftAngle;
      }
      state.driftDir = sign;
      state.flickTicks = Math.max(1, Math.round(config.drift.flickTime / dt));
    }
  }

  if (state.driftDir === 0) {
    // Not drifting: the game steers along the road and the normal model does
    // the rest, braking for corners it can see.
    const h = car.handling;
    const yaw = autoSteerYaw(state, route, 0);
    const turnScale = clamp(state.speed / h.turnInSpeed, 0.2, 1);
    const steer = clamp(-yaw / (h.turnRate * turnScale), -1, 1);
    stepVehicle(state, car, { steer, throttle, initiate: false }, gripAssist(config), route, surfaceGrip, dt, throttle);
    return;
  }

  stepDrift(state, car, throttle, config, route, surfaceGrip, dt);
}

function stepDrift(
  state: SimState,
  car: CarParams,
  throttle: number,
  config: SimConfig,
  route: RouteData,
  surfaceGrip: number,
  dt: number,
): void {
  const d = config.drift;
  const h = car.handling;
  const dir = state.driftDir;

  // --- Angle ---
  let angle = state.driftAngle;
  if (state.flickTicks > 0) {
    const total = Math.max(1, Math.round(d.flickTime / dt));
    const elapsed = total - state.flickTicks;
    // Away from the corner for the first part, then into it. Never pulls an
    // angle that is already bigger back down.
    const target = elapsed < total * 0.3 ? -FLICK_SWING : d.flickAngle;
    if (elapsed < total * 0.3 || angle < target) angle = moveToward(angle, target, FLICK_RATE * dt);
    state.flickTicks--;
  } else if (onStraight(state, route)) {
    // Corner exit. The corner is behind and the road ahead is straight, so the
    // car straightens -- whatever the throttle is doing, because on a straight
    // the throttle is for speed. Without this, getting back on the power out
    // of a corner read as "more angle", and the car slid on down the straight
    // bleeding speed while looking, from above, as if it had finished.
    angle = Math.max(0, angle - d.exitRate * dt);
  } else {
    // Balance: throttle holds an angle in proportion to itself, so a steady
    // throttle gives a steady angle -- until the limit, past which the slide
    // feeds itself.
    const balance = d.angleRate * (throttle - angle / d.holdAngle);
    const runaway = d.runaway * Math.max(0, angle - d.limitAngle);
    angle += (balance + runaway) * dt;
    // The road has turned the other way and the player has not tapped to
    // switch sides: the drift unwinds instead of carrying the tail into the
    // wall. Holding the old angle through an S-bend is not a thing a car does.
    if (upcomingCornerSign(state, route, OPPOSING_REACH) === -dir) {
      angle = Math.max(0, angle - OPPOSING_UNWIND * dt);
    }
  }

  if (angle > d.spinAngle) {
    state.driftAngle = angle;
    state.spinTicks = Math.round(SPIN_SECONDS / dt);
    stepSpin(state, route, config, surfaceGrip, dt);
    return;
  }

  // --- Path: the game steers the direction of travel along the road ---
  // A bigger angle pushes the line towards the outside of the corner.
  const i = state.sampleIndex;
  const half = route.samples.halfWidth[i];
  const outside = -dir * clamp(angle / d.limitAngle, 0, 1.3) * half * d.angleWidening;
  const want = autoSteerYaw(state, route, outside);
  let v = state.speed;
  const maxTurn = (d.driftGrip * GRAVITY * surfaceGrip) / Math.max(v, 1);
  let travel = travelHeading(state);
  travel = wrapAngle(travel + clamp(want, -maxTurn, maxTurn) * dt);

  // --- Speed ---
  // The throttle drives, the angle scrubs, a closed throttle engine-brakes,
  // and the game brakes if the corner ahead needs it.
  v += h.acceleration * (1 - v / h.topSpeed) * throttle * dt;
  let decel = d.angleDrag * clamp(angle / HALF_PI, 0, 1) + (1 - throttle) * ENGINE_BRAKE;
  // Corner speed is judged at the drift grip, with no allowance over it: a
  // drift carried in too fast runs wide, and the tail finds the wall.
  const assist = gripAssist(config);
  const limit = cornerSpeedLimit(state, route, assist, d.driftGrip * surfaceGrip);
  if (v > limit) decel += Math.min(assist.cornerBraking, (v - limit) * 6);
  v = Math.max(0, v - decel * dt);

  placeCar(state, car, travel, dir * angle, v, dt);
  state.driftAngle = angle;
  state.throttle = throttle;
  state.sliding = true;

  if (state.flickTicks === 0 && angle < END_ANGLE) endDrift(state);
}

/** No corner under the car and none within EXIT_REACH ahead. */
function onStraight(state: SimState, route: RouteData): boolean {
  return (
    Math.abs(route.samples.curvature[state.sampleIndex]) < CORNER_CURVATURE &&
    upcomingCornerSign(state, route, EXIT_REACH) === 0
  );
}

/** A spin: the car rotates on, scrubbing speed, then is straightened along its path. */
function stepSpin(state: SimState, route: RouteData, config: SimConfig, surfaceGrip: number, dt: number): void {
  const dir = state.driftDir === 0 ? 1 : state.driftDir;
  let travel = travelHeading(state);
  const want = autoSteerYaw(state, route, 0);
  const v = Math.max(0, state.speed - SPIN_DECEL * dt);
  const maxTurn = (config.drift.driftGrip * GRAVITY * surfaceGrip) / Math.max(v, 1);
  travel = wrapAngle(travel + clamp(want, -maxTurn, maxTurn) * dt);

  const nose = wrapAngle(state.heading + dir * SPIN_YAW * dt - travel);
  state.spinTicks--;
  if (state.spinTicks > 0) {
    placeCar(state, null, travel, nose, v, dt);
    state.sliding = true;
  } else {
    placeCar(state, null, travel, 0, v, dt);
    state.yawRate = 0;
    state.sliding = false;
    endDrift(state);
  }
  state.throttle = 0;
}

/** Put the car on its path with the nose at `noseOffset` from the direction of travel. */
function placeCar(state: SimState, car: CarParams | null, travel: number, noseOffset: number, v: number, dt: number): void {
  const previous = state.heading;
  state.heading = wrapAngle(travel + noseOffset);
  state.yawRate = wrapAngle(state.heading - previous) / dt;
  const rel = wrapAngle(travel - state.heading);
  state.vx = v * cos(rel);
  state.vy = v * sin(rel);
  state.x += v * cos(travel) * dt;
  state.y += v * sin(travel) * dt;
  state.speed = v;
  state.slipAngle = v < 2 ? 0 : rel;
  if (car) {
    // Opposite lock, drawn.
    state.steerAngle = clamp(clamp(rel, -HALF_PI, HALF_PI), -car.maxWheelAngle, car.maxWheelAngle);
  }
}

function travelHeading(state: SimState): number {
  return state.speed < 2 ? state.heading : wrapAngle(state.heading + atan2(state.vy, state.vx));
}

/**
 * Until the player taps, the car corners on grip: Time Attack's grip and slide
 * limits, whatever the mode's own numbers say, so a drift only ever starts
 * because the player asked for one. Filled in place rather than allocated,
 * because this runs every tick.
 */
const GRIP_ASSIST: AssistParams = {
  gripScale: 1.35,
  slideHoldScale: 1.6,
  maxSlideAngle: 0.35,
  cornerSpeed: 1,
  cornerBraking: 9,
  steerDrag: 0,
  slideDrag: 0,
  roadKeeping: 0.5,
  throttlePulse: 0,
};

function gripAssist(config: SimConfig): AssistParams {
  GRIP_ASSIST.cornerSpeed = config.assist.cornerSpeed > 0 ? 1 : 0;
  GRIP_ASSIST.cornerBraking = Math.max(config.assist.cornerBraking, 9);
  GRIP_ASSIST.roadKeeping = config.assist.roadKeeping;
  return GRIP_ASSIST;
}

export function endDrift(state: SimState): void {
  state.driftDir = 0;
  state.driftAngle = 0;
  state.flickTicks = 0;
  state.spinTicks = 0;
}

/**
 * How fast the game wants the direction of travel to turn, rad/s, to follow the
 * road `targetOffset` metres left of the centreline.
 */
export function autoSteerYaw(state: SimState, route: RouteData, targetOffset: number): number {
  const s = route.samples;
  const last = s.x.length - 1;
  const ahead = Math.min(last, state.sampleIndex + Math.round((3 + state.speed * 0.22) / route.sampleSpacing));
  const travel = travelHeading(state);
  const line = atan2(-LINE_GAIN * (state.lateralOffset - targetOffset), state.speed + 4);
  const error = wrapAngle(s.heading[ahead] - travel) + line;
  return s.curvature[ahead] * state.speed + HEADING_GAIN * error;
}

/**
 * Which way the next corner goes: +1 left, -1 right, 0 if there is none close
 * enough to flick into. The nearest one wins, so in an S-bend a tap goes into
 * the bend that is coming, not the bigger one after it.
 */
export function upcomingCornerSign(state: SimState, route: RouteData, metres?: number): number {
  const s = route.samples;
  const last = s.x.length - 1;
  const reach = Math.round((metres ?? clamp(state.speed * 2, 25, 120)) / route.sampleSpacing);
  for (let j = 0; j <= reach; j++) {
    const i = state.sampleIndex + j;
    if (i > last) break;
    const k = s.curvature[i];
    if (Math.abs(k) >= CORNER_CURVATURE) return k > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * How well timed a drift entry is, 0.5..1. Best is a flick up to 30m before the
 * corner starts; earlier than that the slide is wasted on the straight, and
 * later the corner is already half gone.
 */
function entryTiming(state: SimState, route: RouteData): number {
  const corners = route.corners;
  for (let c = 0; c < corners.length; c++) {
    const corner = corners[c];
    if (corner.endIndex < state.sampleIndex) continue;
    const before = (corner.startIndex - state.sampleIndex) * route.sampleSpacing;
    if (before < 0) return clamp(1 + before / 40, 0.5, 1);
    if (before > 30) return clamp(1 - (before - 30) / 60, 0.5, 1);
    return 1;
  }
  return 0.5;
}

/** The back of the car against the wall: a big angle on a narrow road. */
export function isTailAgainstWall(state: SimState, car: CarParams, route: RouteData): boolean {
  const s = route.samples;
  const i = state.sampleIndex;
  const back = car.bodyLength / 2;
  const tailX = state.x - cos(state.heading) * back;
  const tailY = state.y - sin(state.heading) * back;
  const hr = s.heading[i];
  const offset = -(tailX - s.x[i]) * sin(hr) + (tailY - s.y[i]) * cos(hr);
  return Math.abs(offset) > s.halfWidth[i] + WALL_MARGIN;
}
