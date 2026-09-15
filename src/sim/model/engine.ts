import { clamp, lerp } from '../math/trig.ts';
import type { CarParams, EngineParams, SimState } from '../types.ts';

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

/**
 * Automatic throttle for the assist slider.
 *
 * This is NOT a difficulty flag that swaps code paths -- it produces a throttle
 * value that is blended with the player's and then fed through exactly the same
 * engine and tyre equations. At assist 1.0 the player still steers; the
 * computer just works the pedal.
 *
 * The controller holds a target slip angle. It reads counter-steer (steering
 * opposite to the direction of the slide) as the player's request for a bigger
 * angle, which is the same signal a real driver uses.
 */
export function autoThrottle(state: SimState, steerInput: number): number {
  const absSlip = Math.abs(state.slipAngle);

  // Steering into the opposite lock of the slide = "hold this drift".
  const counterSteering = steerInput * state.slipAngle < 0 ? Math.abs(steerInput) : 0;

  // 7 degrees of slip when tracking straight, up to ~27 under full counter-lock.
  const targetSlip = 0.12 + 0.35 * counterSteering;

  // Below target, feed power to rotate the car. Above it, lift to catch the slide.
  const correction = (targetSlip - absSlip) * 2.5;

  // Never asks for more than a light brake: the assist should not be able to
  // stop the car, only modulate the slide.
  return clamp(0.9 + correction, -0.2, 1);
}

/** Blend player and assist throttle. `assist` is 0..1 from the settings slider. */
export function blendThrottle(playerThrottle: number, auto: number, assist: number): number {
  return lerp(playerThrottle, auto, clamp(assist, 0, 1));
}
