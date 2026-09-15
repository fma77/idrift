import { atan2, sin, cos, clamp } from '../sim/math/trig.ts';
import type { CarParams, RouteData, SimState } from '../sim/types.ts';

/**
 * A pure-pursuit driver that produces the same abstract input struct a human
 * does.
 *
 * It is not AI and it is not the deferred Drift Duels chase controller -- it is
 * a test fixture and an attract-mode driver. Its real job is to let the physics
 * be exercised over a full route headlessly, in CI, with no renderer and no
 * human: "does a competent line get round this route in a plausible time" is a
 * question worth being able to answer automatically every time the tyre model
 * is touched.
 *
 * It only uses deterministic helpers, so a bot run is reproducible and can be
 * stored as a ghost replay like any other run.
 */

export interface BotOutput {
  steer: number;
  throttle: number;
  handbrake: boolean;
}

export interface BotConfig {
  /** 0..1. Scales target cornering speed. 1.0 tries to drive at the limit. */
  aggression: number;
  /** Use the handbrake to initiate on tight corners. */
  useHandbrake: boolean;
}

export const DEFAULT_BOT: BotConfig = { aggression: 0.86, useHandbrake: false };

const GRAVITY = 9.80665;

/**
 * Steering gains. Tuned against tools/telemetry.mjs, not by feel: the bot's job
 * is to be a repeatable yardstick for the physics, so these are set to whatever
 * gets a clean lap and then left alone.
 */
/** Radians of extra lock per m/s^2 of lateral acceleration demanded. */
const UNDERSTEER_GAIN = 0.013;
const COUNTERSTEER_GAIN = 0.85;
/** Radians of trim per metre of lateral error. */
const CROSS_TRACK_GAIN = 0.02;

export function driveBot(
  state: SimState,
  route: RouteData,
  car: CarParams,
  config: BotConfig,
  out: BotOutput,
): BotOutput {
  const s = route.samples;
  const last = s.x.length - 1;
  const wheelbase = car.cgToFront + car.cgToRear;

  // --- Look-ahead point: further ahead the faster we go ---
  const lookaheadMetres = clamp(9 + state.speed * 0.85, 12, 46);
  const aheadSamples = Math.round(lookaheadMetres / route.sampleSpacing);
  const targetIndex = Math.min(last, state.sampleIndex + aheadSamples);

  const dx = s.x[targetIndex] - state.x;
  const dy = s.y[targetIndex] - state.y;

  // Into the car's frame.
  const sinH = sin(state.heading);
  const cosH = cos(state.heading);
  const localX = dx * cosH + dy * sinH;
  const localY = -dx * sinH + dy * cosH;

  // Pure pursuit: the path curvature of the arc through the look-ahead point.
  const ld2 = localX * localX + localY * localY;
  const curvatureNeeded = ld2 < 1 ? 0 : (2 * localY) / ld2;

  // 1. Ackermann. The steer angle that traces that arc -- if the tyres made
  //    force without slipping, which they do not.
  let steerAngle = atan2(curvatureNeeded * wheelbase, 1);

  // 2. Understeer compensation. Ackermann alone is a low-speed solution: it is
  //    right at walking pace and hopelessly short at 90km/h, because generating
  //    lateral force *requires* slip angle, and slip angle has to be steered in
  //    on top of the geometry. Without this term the bot tracks the centreline
  //    beautifully up to about 50km/h and then understeers into the outside
  //    wall of every single corner.
  const lateralAccel = state.speed * state.speed * curvatureNeeded;
  steerAngle += lateralAccel * UNDERSTEER_GAIN;

  // 3. Counter-steer. Pure pursuit assumes the car travels in the direction it
  //    points; the moment it slides that is false by exactly the body slip
  //    angle. Adding it points the front wheels along the velocity vector --
  //    the correction a driver makes, and the reason the sign is `+`: you steer
  //    into the slide, not out of it.
  steerAngle += state.slipAngle * COUNTERSTEER_GAIN;

  // 4. Cross-track trim. Closes the loop on the residual error the feedforward
  //    terms leave behind, bounded so it cannot fight the other terms.
  steerAngle += clamp(-state.lateralOffset * CROSS_TRACK_GAIN, -0.14, 0.14);

  // steerAngle is a road-wheel angle (positive = left); out.steer is a
  // player-facing input (positive = right). Opposite signs, so negate.
  out.steer = clamp(-steerAngle / car.maxSteerAngle, -1, 1);

  // --- Speed target from the tightest curvature in the braking zone ahead ---
  const brakingMetres = clamp(state.speed * state.speed * 0.062, 25, 140);
  const scanTo = Math.min(last, state.sampleIndex + Math.round(brakingMetres / route.sampleSpacing));
  let peakCurvature = 0;
  for (let i = state.sampleIndex; i <= scanTo; i++) {
    const k = Math.abs(s.curvature[i]);
    if (k > peakCurvature) peakCurvature = k;
  }

  const mu = car.tyreRear.d * config.aggression;
  const cornerSpeed = peakCurvature < 1e-5 ? 80 : Math.sqrt((mu * GRAVITY) / peakCurvature);
  const targetSpeed = clamp(cornerSpeed, 6, 80);

  // The rear axle has one grip budget. A speed controller that ignores how much
  // of it cornering is already using will floor the throttle at the apex, and
  // in a 400Nm rear-drive car that is simply a request to spin. Powerful cars
  // were unable to complete a lap until this ceiling existed; the light one
  // managed because it never had enough torque to overrun its own tyres.
  const lateralUsed = clamp(
    Math.abs(state.speed * state.speed * curvatureNeeded) / (car.tyreRear.d * GRAVITY),
    0,
    1,
  );
  const throttleCeiling = clamp(1 - lateralUsed * 0.9, 0.12, 1);

  out.throttle = clamp((targetSpeed - state.speed) * 0.45, -1, throttleCeiling);

  // Already sliding further than intended: lift, do not add power.
  if (Math.abs(state.slipAngle) > 0.32) {
    out.throttle = Math.min(out.throttle, 0.12);
  }

  // --- Optional handbrake initiation on the tightest corners ---
  const cornerRadius = peakCurvature < 1e-5 ? 1e5 : 1 / peakCurvature;
  out.handbrake =
    config.useHandbrake &&
    cornerRadius < 26 &&
    state.speed > 14 &&
    Math.abs(state.slipAngle) < 0.2 &&
    Math.abs(s.curvature[Math.min(last, state.sampleIndex + 4)]) > 0.018;

  return out;
}
