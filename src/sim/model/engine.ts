import { clamp, lerp } from '../math/trig.ts';
import type { CarParams, EngineParams, SimInput, SimState } from '../types.ts';

const RPM_PER_RAD_PER_SEC = 9.549296585513721; // 60 / (2 * PI)

/** Interpolate the torque curve. The curve is sampled evenly from 0 to redline. */
export function torqueAtRpm(engine: EngineParams, rpm: number): number {
  const curve = engine.torqueCurve;
  const last = curve.length - 1;
  const t = clamp(rpm / engine.redlineRpm, 0, 1) * last;
  const i = Math.floor(t);
  if (i >= last) return curve[last];
  return lerp(curve[i], curve[i + 1], t - i);
}

/**
 * Advance the gearbox and compute the tractive force at the rear contact patch.
 *
 * The gearbox is a simple automatic with hysteresis and a torque-cut shift
 * window. This is deliberately not a full clutch/driveline model: for a
 * top-down arcade drifter the thing that matters is that torque delivery has
 * character (a peak, a redline, a pause on the shift) and that it is
 * deterministic. Wheel dynamics are modelled only to the extent the handbrake
 * needs them.
 *
 * Mutates state.gear, state.rpm and state.shiftTimer.
 */
export function driveForce(
  state: SimState,
  car: CarParams,
  throttle: number,
  dt: number,
): number {
  const engine = car.engine;
  const lastGear = engine.gearRatios.length - 1;

  // RPM follows road speed through the current gear. Clamped at idle so the
  // engine does not stall to zero and leave the player with no torque at all.
  const wheelOmega = state.vx / car.wheelRadius;
  const ratio = engine.gearRatios[state.gear] * engine.finalDrive;
  const rawRpm = Math.abs(wheelOmega) * ratio * RPM_PER_RAD_PER_SEC;
  state.rpm = clamp(rawRpm, engine.idleRpm, engine.redlineRpm);

  if (state.shiftTimer > 0) {
    state.shiftTimer -= dt;
    // Torque is cut mid-shift. Engine braking still applies.
    return -engineBraking(car, state.vx);
  }

  const upAt = engine.redlineRpm * engine.shiftUpFraction;
  const downAt = engine.redlineRpm * engine.shiftDownFraction;
  if (state.gear < lastGear && rawRpm > upAt) {
    state.gear++;
    state.shiftTimer = engine.shiftTime;
    return -engineBraking(car, state.vx);
  }
  if (state.gear > 0 && rawRpm < downAt) {
    state.gear--;
    state.shiftTimer = engine.shiftTime;
    return -engineBraking(car, state.vx);
  }

  if (throttle <= 0) return -engineBraking(car, state.vx);

  const torque = torqueAtRpm(engine, state.rpm) * throttle;
  return (torque * ratio * engine.drivetrainEfficiency) / car.wheelRadius;
}

/** Closed-throttle engine braking, scaled with speed. Newtons, always positive. */
function engineBraking(car: CarParams, vx: number): number {
  return clamp(Math.abs(vx) * 12, 0, 900) * (vx >= 0 ? 1 : -1) * (car.mass / 1300);
}

/** Throttle the autopilot asks for at assist 1.0 when nothing needs correcting. */
const AUTOPILOT_CRUISE = 0.85;

/**
 * How far the assist will push the throttle to hold its target slip angle.
 * Radians of slip error map to throttle at this rate.
 */
const SLIP_GAIN = 2.5;

/**
 * The slide correction the assist wants, as a throttle delta.
 *
 * Positive means "more power, the car is not rotating enough"; negative means
 * "lift, this is turning into a spin". Reads counter-steer -- steering into the
 * slide -- as the driver asking for a bigger angle, which is the same signal a
 * real driver acts on.
 */
function slipCorrection(state: SimState, steerInput: number): number {
  const absSlip = Math.abs(state.slipAngle);

  // slipAngle > 0 means the car is travelling to the left of where it points,
  // which is caught with left lock -- and left is negative steer. So opposite
  // signs means the driver is counter-steering.
  const counterSteering = steerInput * state.slipAngle < 0 ? Math.abs(steerInput) : 0;

  // 7 degrees of slip when tracking straight, up to ~27 under full counter-lock.
  const targetSlip = 0.12 + 0.35 * counterSteering;
  return (targetSlip - absSlip) * SLIP_GAIN;
}

/**
 * Resolve the player's pedal and the assist into the single throttle value the
 * engine and tyres actually see.
 *
 * This is NOT a difficulty flag that swaps code paths: the result goes through
 * exactly the same equations at every assist level, which is why `assist` has
 * to travel with a stored replay.
 *
 * The first version of this simply blended the player's throttle with an
 * autopilot that always wanted ~90% power. At the default assist of 0.6 that
 * made a full brake application come out as +0.20 throttle -- the car
 * *accelerated* when you hit the brakes, and coasted to 25km/h with nobody
 * touching anything. The pedals felt disconnected because they very nearly
 * were.
 *
 * So braking is now never arbitrated. The assist exists to manage the slide,
 * not to argue with the driver about slowing down: when the brake is asked for
 * it is delivered, and the assist may only add lift on top, never remove it.
 */
export function resolveThrottle(state: SimState, input: SimInput, assistLevel: number): number {
  const assist = clamp(assistLevel, 0, 1);
  const player = input.throttle;
  const correction = slipCorrection(state, input.steer);

  if (player < 0) {
    // Braking. The driver's request passes through untouched; the assist can
    // only ever brake harder to catch a slide.
    return clamp(player + assist * Math.min(correction, 0), -1, 1);
  }

  // On throttle or coasting. At assist 0 the pedal is entirely the player's; at
  // 1 the assist cruises and holds the target slip angle on its own.
  const base = lerp(player, AUTOPILOT_CRUISE, assist);
  return clamp(base + assist * correction, -1, 1);
}
