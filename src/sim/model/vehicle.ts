import { atan2, sin, cos, clamp, wrapAngle, lerp, HALF_PI } from '../math/trig.ts';
import type { CarParams, SimInput, SimState } from '../types.ts';

const GRAVITY = 9.80665;

/**
 * Below this speed a slip angle is meaningless: a small sideways velocity
 * divided by a near-zero forward one reads as 90 degrees of drift on a car that
 * is barely moving.
 */
const MIN_SLIP_SPEED = 2.0;

/**
 * One step of the arcade drift model.
 *
 * This replaced a bicycle model with Pacejka tyres, an engine, a gearbox,
 * brakes and a handbrake. That model was faithful, and that was the problem:
 * with a real car's controls, a smooth drift line was beyond what a thumb on
 * glass can do. The approach here is the one Drifto uses, and it is openly
 * unrealistic in two ways:
 *
 * 1. Steering rotates the body directly. The slider sets a yaw rate and the
 *    body follows it within a fraction of a second. There is no steering
 *    geometry and no tyre force building up, so there is no lag between thumb
 *    and nose -- you point the car and the physics decides where it goes.
 *
 * 2. Sideways friction rises with the slide angle. While gripping it is a
 *    constant; once the tyres let go it is interpolated from a low value at a
 *    shallow angle to a high one at 90 degrees. A wider slide scrubs harder,
 *    turns the velocity faster and bleeds speed, so the slide settles instead
 *    of running away. That self-correction is what makes a long drift feel
 *    fluid rather than like balancing on a knife edge.
 *
 * The car always drives itself forward. Mutates `state` in place and is pure
 * with respect to everything else.
 */
export function stepVehicle(
  state: SimState,
  car: CarParams,
  input: SimInput,
  surfaceGrip: number,
  dt: number,
): void {
  const h = car.handling;
  const steer = clamp(input.steer, -1, 1);
  state.steerChange = Math.abs(steer - state.steer);
  state.steer = steer;

  let speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  let slip = speed < MIN_SLIP_SPEED ? 0 : atan2(state.vy, state.vx);

  // --- Rotation ---
  //
  // Sign convention: steer +1 is RIGHT, but angles are counter-clockwise
  // positive, so steering right asks for a negative yaw rate.
  //
  // Self-alignment swings the nose back towards the direction of travel, and
  // fades out as the player steers. Letting go therefore straightens the car
  // out of a slide on its own, while a held slider is never fought.
  const turnScale = clamp(speed / h.turnInSpeed, 0, 1);
  const steerYaw = -steer * h.turnRate;
  const alignYaw = h.selfAlign * clamp(slip, -HALF_PI, HALF_PI) * (1 - Math.abs(steer));
  const targetYaw = (steerYaw + alignYaw) * turnScale;
  state.yawRate += (targetYaw - state.yawRate) * clamp(h.turnResponse * dt, 0, 1);

  // Rotating the body leaves the world-frame velocity where it was, so in the
  // body frame the velocity turns the other way by the same angle.
  const turn = state.yawRate * dt;
  state.heading = wrapAngle(state.heading + turn);
  const sinT = sin(turn);
  const cosT = cos(turn);
  const vx = state.vx * cosT + state.vy * sinT;
  const vy = -state.vx * sinT + state.vy * cosT;
  state.vx = vx;
  state.vy = vy;

  // --- Drive ---
  // Tapers linearly to zero at top speed, and pushes back gently above it (after
  // a downhill wall reset, say) rather than holding a hard cap.
  const drive = h.acceleration * (1 - speed / h.topSpeed);
  state.vx += Math.max(drive, -h.acceleration) * dt;

  // --- Sideways friction ---
  speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  slip = speed < MIN_SLIP_SPEED ? 0 : atan2(state.vy, state.vx);
  const absSlip = Math.abs(slip);

  // Hysteresis between letting go and gripping again, so a slide near the
  // threshold does not flicker between the two every tick.
  if (state.sliding) {
    if (absSlip < h.regripAngle) state.sliding = false;
  } else if (absSlip > h.breakAngle) {
    state.sliding = true;
  }

  const friction = state.sliding
    ? lerp(h.slideFrictionLow, h.slideFrictionHigh, clamp(absSlip / HALF_PI, 0, 1))
    : h.grip;
  const removable = friction * GRAVITY * surfaceGrip * dt;
  if (state.vy > removable) state.vy -= removable;
  else if (state.vy < -removable) state.vy += removable;
  else state.vy = 0;

  // --- Integrate pose, world frame ---
  const sinH = sin(state.heading);
  const cosH = cos(state.heading);
  state.x += (state.vx * cosH - state.vy * sinH) * dt;
  state.y += (state.vx * sinH + state.vy * cosH) * dt;

  // --- Derived values for renderer, audio and scoring ---
  state.speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  state.slipAngle = state.speed < MIN_SLIP_SPEED ? 0 : atan2(state.vy, state.vx);
  // Drawn front wheels point along the direction of travel, plus a little of
  // the player's steering. In a slide that reads as opposite lock, which is
  // what a drifting car looks like from above even though nothing here
  // simulates it.
  state.steerAngle = clamp(
    clamp(state.slipAngle, -HALF_PI, HALF_PI) - steer * car.maxWheelAngle * 0.5,
    -car.maxWheelAngle,
    car.maxWheelAngle,
  );
}

/**
 * Put the car back on the road after a wall hit, pointing along the route.
 * Used by the crash handler: the brief calls for a penalty and a reset, never
 * a hard restart.
 */
export function resetToRoad(
  state: SimState,
  x: number,
  y: number,
  heading: number,
  keepSpeed: number,
): void {
  state.x = x;
  state.y = y;
  state.heading = wrapAngle(heading);
  state.vx = clamp(keepSpeed, 0, 100);
  state.vy = 0;
  state.yawRate = 0;
  state.sliding = false;
  state.slipAngle = 0;
  state.speed = state.vx;
  state.steerAngle = 0;
}
