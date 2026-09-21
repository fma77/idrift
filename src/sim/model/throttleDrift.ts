import { atan2, sin, cos, clamp, wrapAngle, moveToward, HALF_PI } from '../math/trig.ts';
import { stepVehicle } from './vehicle.ts';
import { cornerSpeedLimit } from './assist.ts';
import { WALL_MARGIN } from './progress.ts';
import type { AssistParams, CarParams, RouteData, SimConfig, SimInput, SimState } from '../types.ts';

/**
 * Drift Run with throttle controls: the game steers, the player drives.
 *
 * The player holds a throttle and presses a drift button. Until they do, the
 * car goes round corners on grip, steered by the game along the road. A press
 * flicks the car sideways into the corner ahead -- a small swing the other way
 * first, then into it, the way a driver sets up a Scandinavian flick.
 *
 * The button is a handbrake, and how long it is held is the size of the kick:
 * a quick tap gives a soft entry that the throttle has to build on, about a
 * quarter of a second gives the full flick, and holding on past that keeps the
 * tail swinging and scrubs speed until the car spins.
 *
 * From then on the throttle sets the angle:
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

/** m/s^2 of acceleration the drift scrub was tuned for; weaker cars scrub less. */
const REFERENCE_ACCEL = 8;
/** m/s. Below this a drift cannot be held and ends. */
const MIN_DRIFT_SPEED = 5;

/** Seconds of holding the drift button for a full flick. */
export const HOLD_FULL = 0.25;
/** Seconds held past which the handbrake is swinging the tail towards a spin. */
export const HOLD_OVER = 0.4;
/** The share of a full flick a quick tap gives. */
const SOFT_FLICK = 0.45;
/** rad/s the handbrake adds to the angle while held past a full flick. */
const HANDBRAKE_RATE = 2.6;
/** m/s^2 the handbrake scrubs while held past a full flick. */
const HANDBRAKE_DECEL = 5;

/** How a press of the given length reads: for the HUD, which colours it. */
export type HoldPhase = 'soft' | 'full' | 'over';
export function holdPhase(seconds: number): HoldPhase {
  return seconds < HOLD_FULL * 0.6 ? 'soft' : seconds < HOLD_OVER ? 'full' : 'over';
}
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
/** In a drift the line matters more than the heading: hold it firmly. */
const DRIFT_LINE_GAIN = 3.5;
/** m/s^2 of extra braking when the line needs more grip than the car has, and its ceiling. */
const SHORTFALL_GAIN = 1.4;
const SHORTFALL_BRAKING = 14;
/** Fraction of the sideways grip a drift is allowed to use for speed; the rest is for the line. */
const DRIFT_SPEED_MARGIN = 0.78;
/** Metres ahead a corner has to be for the car to start setting up on its outside. */
const SETUP_REACH = 45;
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
    state.handbrakeOn = false;
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
      state.handbrakeTicks = 0;
      state.handbrakeOn = true;
    }
  }

  // The press that started this flick: counted until it is let go.
  if (state.handbrakeOn) {
    if (input.initiate && state.driftDir !== 0) state.handbrakeTicks++;
    else state.handbrakeOn = false;
  }

  if (state.driftDir === 0) {
    // Not drifting: the game steers along the road and the normal model does
    // the rest, braking for corners it can see.
    const h = car.handling;
    // Before a corner, drift towards its outside, so a tap has room to throw
    // the car in. Only on the approach: once in the corner, grip takes the
    // ordinary line.
    const coming = upcomingCornerSign(state, route, SETUP_REACH);
    const inCorner = Math.abs(route.samples.curvature[state.sampleIndex]) >= CORNER_CURVATURE;
    const setup = coming !== 0 && !inCorner ? -coming * route.samples.halfWidth[state.sampleIndex] * config.drift.setupLine : 0;
    const yaw = autoSteerYaw(state, route, setup);
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
  const held = state.handbrakeTicks * dt;
  // The flick's size follows the press: a tap is a soft entry, a full press is
  // the whole flick. While the button is down it keeps growing towards full.
  const flickAngle = d.flickAngle * (SOFT_FLICK + (1 - SOFT_FLICK) * clamp(held / HOLD_FULL, 0, 1));
  if (state.flickTicks > 0) {
    const total = Math.max(1, Math.round(d.flickTime / dt));
    const elapsed = total - state.flickTicks;
    // Away from the corner for the first part, then into it. Never pulls an
    // angle that is already bigger back down.
    const target = elapsed < total * 0.3 ? -FLICK_SWING : flickAngle;
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
    // Each car takes to it differently: all-wheel drive holds less angle for
    // the same throttle, a rear-engined car runs away faster past the limit.
    const feel = car.driftFeel;
    const balance = d.angleRate * (feel?.rate ?? 1) * (throttle - angle / (d.holdAngle * (feel?.hold ?? 1)));
    const runaway = d.runaway * (feel?.runaway ?? 1) * Math.max(0, angle - d.limitAngle);
    angle += (balance + runaway) * dt;
    // The road has turned the other way and the player has not tapped to
    // switch sides: the drift unwinds instead of carrying the tail into the
    // wall. Holding the old angle through an S-bend is not a thing a car does.
    if (upcomingCornerSign(state, route, OPPOSING_REACH) === -dir) {
      angle = Math.max(0, angle - OPPOSING_UNWIND * dt);
    }
  }

  // Held on past a full flick, the handbrake keeps the tail swinging.
  const overHeld = state.handbrakeOn && held > HOLD_FULL;
  if (overHeld) angle += HANDBRAKE_RATE * dt;

  if (angle > d.spinAngle) {
    state.handbrakeOn = false;
    state.driftAngle = angle;
    state.spinTicks = Math.round(SPIN_SECONDS / dt);
    stepSpin(state, route, config, surfaceGrip, dt);
    return;
  }

  // --- Path: the game steers the direction of travel along the road ---
  // The drifty line is judged by the tail: the rear of the car should draw its
  // arc round the outside of the corner. So the target is where the tail
  // should be, and the car's centre sits inside that by however far the angle
  // swings the tail out. The first version steered the centre along the
  // middle of the road and let the angle widen it a little, which in practice
  // put the car halfway to the apex with the tail in the middle: quick, and
  // nothing like a drift line.
  const i = state.sampleIndex;
  const half = route.samples.halfWidth[i];
  const tailSwing = (car.bodyLength / 2) * sin(clamp(angle, 0, HALF_PI));
  const centre = Math.max(0, half * d.tailLine - tailSwing);
  const want = autoSteerYaw(state, route, -dir * centre, DRIFT_LINE_GAIN);
  let v = state.speed;
  const maxTurn = (d.driftGrip * GRAVITY * surfaceGrip) / Math.max(v, 1);
  let travel = travelHeading(state);
  travel = wrapAngle(travel + clamp(want, -maxTurn, maxTurn) * dt);

  // The line is asking for more grip than there is: the corner is tighter than
  // this speed can hold. Scrub, which is what a driver does -- otherwise the
  // car simply washes out to the wall, and the faster cars did exactly that on
  // Haruna's tightest hairpins.
  const shortfall = Math.max(0, Math.abs(want) - maxTurn);

  // --- Speed ---
  // The throttle drives, the angle scrubs, a closed throttle engine-brakes,
  // and the game brakes if the corner ahead needs it.
  v += h.acceleration * (1 - v / h.topSpeed) * throttle * dt;
  // What a slide scrubs is in proportion to the car's power: a light car with
  // a small engine loses less, and carries its momentum. At full strength a
  // big angle outpulled the weakest engine and slowed it to a standstill
  // mid-drift.
  const power = clamp(h.acceleration / REFERENCE_ACCEL, 0.4, 1.4);
  let decel = (d.angleDrag * clamp(angle / HALF_PI, 0, 1) + (1 - throttle) * ENGINE_BRAKE) * power;
  decel += Math.min(SHORTFALL_BRAKING, shortfall * v * SHORTFALL_GAIN);
  if (overHeld) decel += HANDBRAKE_DECEL;
  // Corner speed is judged at the drift grip, with no allowance over it: a
  // drift carried in too fast runs wide, and the tail finds the wall.
  const assist = gripAssist(config);
  // Keep some grip in hand: arriving at exactly the grip limit leaves nothing
  // to hold the outside line with, and a heavy car then slides wide into the
  // wall at the one corner that is a shade tighter than it looked.
  const limit = cornerSpeedLimit(state, route, assist, d.driftGrip * surfaceGrip * DRIFT_SPEED_MARGIN);
  if (v > limit) decel += Math.min(assist.cornerBraking, (v - limit) * 6);
  v = Math.max(0, v - decel * dt);

  placeCar(state, car, travel, dir * angle, v, dt);
  state.driftAngle = angle;
  state.throttle = throttle;
  state.sliding = true;

  // A drift is over when the car straightens -- or when it has been scrubbed
  // down to a crawl, where a slide cannot be held and the grip driving takes
  // over again.
  if (state.flickTicks === 0 && (angle < END_ANGLE || v < MIN_DRIFT_SPEED)) endDrift(state);
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
  state.handbrakeOn = false;
  state.driftDir = 0;
  state.driftAngle = 0;
  state.flickTicks = 0;
  state.spinTicks = 0;
}

/**
 * How fast the game wants the direction of travel to turn, rad/s, to follow the
 * road `targetOffset` metres left of the centreline.
 */
export function autoSteerYaw(
  state: SimState,
  route: RouteData,
  targetOffset: number,
  lineGain = LINE_GAIN,
): number {
  const s = route.samples;
  const last = s.x.length - 1;
  const ahead = Math.min(last, state.sampleIndex + Math.round((3 + state.speed * 0.22) / route.sampleSpacing));
  const travel = travelHeading(state);
  const line = atan2(-lineGain * (state.lateralOffset - targetOffset), state.speed + 4);
  // Heading error against the road where the car is, not where it is going.
  // Comparing with the heading a few metres ahead builds in a turn-in the
  // curvature term below already provides, so on any bend the car settled two
  // or three metres to the inside -- which is exactly the apex-hugging line it
  // was not supposed to take. The look-ahead belongs to the curvature alone.
  const error = wrapAngle(s.heading[state.sampleIndex] - travel) + line;
  // A line offset from the centreline is a different circle: wider round the
  // outside of a bend, tighter round the inside. Feeding forward the
  // centreline's curvature on an outside line turns the car in too early, and
  // it ends up at the apex whatever the line term says.
  const k = s.curvature[ahead];
  const pathCurvature = k / Math.max(0.2, 1 - k * targetOffset);
  return pathCurvature * state.speed + HEADING_GAIN * error;
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
