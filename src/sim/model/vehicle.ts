import { atan2, sin, cos, clamp, moveToward, wrapAngle } from '../math/trig.ts';
import { lateralForce, longitudinalCapacity, combinedSlipScale } from './tyre.ts';
import { driveForce, autoThrottle, blendThrottle } from './engine.ts';
import type { CarParams, SimConfig, SimInput, SimState } from '../types.ts';

const GRAVITY = 9.80665;

/**
 * Below this speed the slip-angle atan2 becomes meaningless (dividing a small
 * lateral velocity by a near-zero longitudinal one gives 90 degrees of slip for
 * a car that is basically stationary). Clamping the denominator keeps the tyre
 * model well behaved at walking pace without a separate low-speed code path.
 */
const MIN_SLIP_SPEED = 2.0;

/**
 * One bicycle-model step, semi-implicit Euler.
 *
 * Front and rear axles are each collapsed to a single tyre on the centreline.
 * That loses roll and per-wheel load, but keeps longitudinal weight transfer,
 * slip angles, the friction circle and the yaw moment -- which between them
 * produce everything a drift game needs: corner entry rotation from trail
 * braking, power oversteer, catchable slides, and spins when you run out of
 * counter-lock.
 *
 * Mutates `state` in place. Pure with respect to everything else: given the
 * same state, input, car and dt, it always produces the same result.
 */
export function stepVehicle(
  state: SimState,
  car: CarParams,
  input: SimInput,
  config: SimConfig,
  surfaceGrip: number,
  dt: number,
): void {
  const wheelbase = car.cgToFront + car.cgToRear;

  // --- Steering: rate limited, so a keyboard's instant full-lock still takes
  // physical time to arrive at the road wheel and cannot step the tyre force.
  const targetSteer = input.steer * car.maxSteerAngle;
  state.steerAngle = moveToward(state.steerAngle, targetSteer, car.steerRate * dt);
  const delta = state.steerAngle;

  // --- Slip angles ---
  const vxSafe = Math.max(Math.abs(state.vx), MIN_SLIP_SPEED) * (state.vx < 0 ? -1 : 1);
  const alphaFront = atan2(state.vy + car.cgToFront * state.yawRate, Math.abs(vxSafe)) - delta;
  const alphaRear = atan2(state.vy - car.cgToRear * state.yawRate, Math.abs(vxSafe));
  state.frontSlip = alphaFront;
  state.rearSlip = alphaRear;

  // --- Throttle: player and assist blended, then through one shared path ---
  const auto = autoThrottle(state, input.steer);
  const throttle = blendThrottle(input.throttle, auto, config.assist);
  state.throttleApplied = throttle;

  // --- Longitudinal forces ---
  // Computed before the tyre lateral forces so the resulting acceleration can
  // drive weight transfer within the same tick.
  let fxRear = driveForce(state, car, Math.max(throttle, 0), dt);
  let fxFront = 0;

  if (throttle < 0) {
    const brake = -throttle * car.brakeTorque / car.wheelRadius;
    const dir = state.vx >= 0 ? -1 : 1;
    fxFront += brake * car.brakeBias * dir;
    fxRear += brake * (1 - car.brakeBias) * dir;
  }

  // Handbrake locks the rear axle. The lateral collapse below is what actually
  // initiates the drift; the retarding force is almost incidental.
  if (input.handbrake) {
    const dir = state.vx >= 0 ? -1 : 1;
    fxRear += (car.handbrakeTorque / car.wheelRadius) * dir;
  }

  const drag = -car.dragCoeff * state.vx * Math.abs(state.vx);
  const rolling = -car.rollingResistance * state.vx;

  // --- Weight transfer ---
  // Estimated from the demanded longitudinal force. It is only an estimate --
  // the forces get clamped to tyre capacity below -- but load transfer is a
  // second-order effect on the result and resolving it properly would need an
  // iteration per tick for no visible gain.
  const accelEstimate = (fxFront + fxRear + drag + rolling) / car.mass;
  const transfer = (car.mass * accelEstimate * car.cgHeight) / wheelbase;
  const staticFront = (car.mass * GRAVITY * car.cgToRear) / wheelbase;
  const staticRear = (car.mass * GRAVITY * car.cgToFront) / wheelbase;
  // Braking (negative accel) moves load forwards; a floor of 10% static keeps a
  // lifted axle from producing exactly zero grip and a divide-by-zero downstream.
  const loadFront = Math.max(staticFront - transfer, staticFront * 0.1);
  const loadRear = Math.max(staticRear + transfer, staticRear * 0.1);

  // --- Traction limit ---
  // A tyre cannot transmit more than mu*Fz however much torque the engine
  // makes. Without this clamp a first-gear stab produces both impossible
  // acceleration and (via the friction circle below) a total loss of lateral
  // grip, so the car launches like a dragster and spins on the spot.
  //
  // The 0.95 ceiling leaves a sliver of the friction circle unused. A hard 1.0
  // would drive combinedSlipScale to exactly zero, and a rear axle with
  // literally no lateral force is unrecoverable -- the slide becomes a spin
  // every time, which is not how wheelspin feels in a real car.
  const frontCapacity = longitudinalCapacity(car.tyreFront, loadFront, surfaceGrip);
  const rearCapacity = longitudinalCapacity(car.tyreRear, loadRear, surfaceGrip);
  fxFront = clamp(fxFront, -frontCapacity * 0.95, frontCapacity * 0.95);
  fxRear = clamp(fxRear, -rearCapacity * 0.95, rearCapacity * 0.95);

  const fxLong = fxFront + fxRear + drag + rolling;

  // --- Lateral forces ---
  let fyFront = lateralForce(car.tyreFront, alphaFront, loadFront, surfaceGrip);
  let fyRear = lateralForce(car.tyreRear, alphaRear, loadRear, surfaceGrip);

  // Friction circle. Longitudinal demand eats into cornering capacity.
  fyFront *= combinedSlipScale(fxFront, frontCapacity);
  fyRear *= combinedSlipScale(fxRear, rearCapacity);

  if (input.handbrake) {
    // A locked wheel is sliding, and a sliding tyre makes very little lateral
    // force regardless of slip angle. Not zero -- zero makes the car feel like
    // it is on ice and removes any ability to steer the slide.
    fyRear *= 0.18;
  }

  // --- Equations of motion, body frame (x forward, y left) ---
  const sinDelta = sin(delta);
  const cosDelta = cos(delta);

  const forceX = fxLong - fyFront * sinDelta;
  const forceY = fyFront * cosDelta + fyRear;
  const momentZ = car.cgToFront * fyFront * cosDelta - car.cgToRear * fyRear;

  // The v * yawRate terms are the centripetal coupling between the rotating
  // body frame and the world frame. Leaving them out gives a car that corners
  // like it is on rails and never transfers speed between axes.
  const ax = forceX / car.mass + state.vy * state.yawRate;
  const ay = forceY / car.mass - state.vx * state.yawRate;

  state.vx += ax * dt;
  state.vy += ay * dt;
  state.yawRate += (momentZ / car.inertiaZ) * dt;

  // Stop the car cleanly instead of letting rolling resistance oscillate it
  // around zero forever.
  if (Math.abs(state.vx) < 0.05 && Math.abs(throttle) < 0.01) {
    state.vx = 0;
    state.vy *= 0.5;
  }

  // --- Integrate pose, world frame ---
  state.heading = wrapAngle(state.heading + state.yawRate * dt);
  const sinH = sin(state.heading);
  const cosH = cos(state.heading);
  state.x += (state.vx * cosH - state.vy * sinH) * dt;
  state.y += (state.vx * sinH + state.vy * cosH) * dt;

  // --- Derived values for renderer, audio and scoring ---
  state.speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  state.slipAngle = state.speed < 1 ? 0 : atan2(state.vy, Math.abs(state.vx));
  state.lateralG = ay / GRAVITY;
  state.rearWheelSpeed = input.handbrake ? 0 : state.vx / car.wheelRadius;
}

/**
 * Put the car back on the road after a wall hit or a spin, pointing along the
 * route. Used by the crash handler: the brief calls for a penalty and a reset,
 * never a hard restart.
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
  state.slipAngle = 0;
  state.speed = state.vx;
  state.steerAngle = 0;
}
