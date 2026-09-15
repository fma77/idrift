import { atan, sin, clamp } from '../math/trig.ts';
import type { TyreParams } from '../types.ts';

/** Nominal per-axle load the tyre coefficients were tuned at, newtons. */
const NOMINAL_LOAD = 4000;

/**
 * Simplified Pacejka "magic formula" lateral force.
 *
 *   Fy = D * sin(C * atan(B*a - E*(B*a - atan(B*a))))
 *
 * Returns force in newtons, opposing the slip angle. The shape is what gives a
 * drift game its feel: force rises steeply with slip up to a peak around 8-12
 * degrees, then falls away. That falling region past the peak is the drift --
 * it is why a slide is controllable but unstable, and why a linear tyre model
 * produces a car that either grips or spins with nothing in between.
 *
 * @param slipAngle Radians. Positive = tyre travelling to the left of where it points.
 * @param load      Vertical load on the axle, newtons.
 * @param grip      Surface multiplier from the route (1.0 = nominal dry tarmac).
 */
export function lateralForce(
  tyre: TyreParams,
  slipAngle: number,
  load: number,
  grip: number,
): number {
  if (load <= 0) return 0;

  // Load sensitivity: a tyre carrying twice the load does not make twice the
  // grip. Without this, weight transfer is cosmetic and the car behaves the
  // same whether you brake into a corner or not.
  const loadRatio = load / NOMINAL_LOAD;
  const peak = tyre.d * grip * (1 - tyre.loadSensitivity * (loadRatio - 1));

  const ba = tyre.b * slipAngle;
  const inner = ba - tyre.e * (ba - atan(ba));
  // Negative: the force opposes the slip.
  return -load * peak * sin(tyre.c * atan(inner));
}

/** Peak longitudinal force an axle can produce before it slides, newtons. */
export function longitudinalCapacity(tyre: TyreParams, load: number, grip: number): number {
  if (load <= 0) return 0;
  const loadRatio = load / NOMINAL_LOAD;
  const peak = tyre.d * grip * (1 - tyre.loadSensitivity * (loadRatio - 1));
  return load * peak;
}

/**
 * Friction-circle coupling. A tyre has one budget of grip to spend on driving,
 * braking and cornering combined; spend it all going forwards and there is
 * nothing left to turn with.
 *
 * This is the other half of what makes the car drift: power-oversteer falls out
 * of it for free, because throttle eats the rear axle's lateral budget.
 *
 * @param used Longitudinal force currently demanded of the axle, newtons.
 * @returns Multiplier 0..1 to apply to that axle's lateral force.
 */
export function combinedSlipScale(used: number, capacity: number): number {
  if (capacity <= 1) return 0;
  const utilisation = clamp(Math.abs(used) / capacity, 0, 1);
  const remaining = 1 - utilisation * utilisation;
  return remaining <= 0 ? 0 : Math.sqrt(remaining);
}
