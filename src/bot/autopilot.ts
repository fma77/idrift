import { atan2, clamp, wrapAngle } from '../sim/math/trig.ts';
import type { CarParams, RouteData, SimState } from '../sim/types.ts';

/**
 * A line-following driver that produces the same steering value a human does.
 *
 * It is not AI and it is not the deferred Drift Duels chase controller -- it is
 * a test fixture and an attract-mode driver. Its real job is to let the physics
 * be exercised over a full route headlessly, in CI, with no renderer and no
 * human: "does a competent line get round this route in a plausible time" is a
 * question worth being able to answer automatically every time the handling is
 * touched.
 *
 * It only uses deterministic helpers, so a bot run is reproducible and can be
 * stored as a ghost replay like any other run.
 */

export interface BotOutput {
  steer: number;
}

export interface BotConfig {
  /**
   * Multiplies how hard the bot corrects its heading. Above 1 it over-rotates,
   * which in this model is how a slide is started.
   */
  aggression: number;
}

export const DEFAULT_BOT: BotConfig = { aggression: 1 };

/** How hard the bot pulls back towards the centreline. */
const CROSS_TRACK_GAIN = 1.2;
/** rad/s of rotation per radian of heading error. */
const HEADING_GAIN = 5;
/**
 * Slide angle past which the bot stops asking for more and steers into the
 * slide. It makes no attempt to scrub speed deliberately: trying to made it
 * slower and put it into more walls, not fewer, so it simply follows the road
 * and lets corners it takes too fast turn into slides on their own.
 */
const SLIDE_LIMIT = 0.7;

export function driveBot(
  state: SimState,
  route: RouteData,
  car: CarParams,
  config: BotConfig,
  out: BotOutput,
): BotOutput {
  const s = route.samples;
  const last = s.x.length - 1;
  const h = car.handling;

  // --- Heading control on the direction of travel ---
  // A Stanley-style controller rather than pure pursuit. Pursuit with a long
  // look-ahead cuts corners, and on a seven-metre touge road a cut corner is a
  // wall. Steering the velocity onto the road's own heading, plus a term that
  // pulls back towards the centreline, holds the line far more tightly.
  //
  // It controls the direction of travel, not the nose: in a slide the two
  // differ by the drift angle, and it is the velocity that has to follow the
  // road.
  const aheadIndex = Math.min(last, state.sampleIndex + Math.round((3 + state.speed * 0.22) / route.sampleSpacing));
  const travel = state.heading + (state.speed > 2 ? state.slipAngle : 0);
  const lineCorrection = atan2(-CROSS_TRACK_GAIN * state.lateralOffset, state.speed + 4);
  const headingError = wrapAngle(s.heading[aheadIndex] - travel) + lineCorrection;
  let yaw = s.curvature[aheadIndex] * state.speed + HEADING_GAIN * headingError * config.aggression;

  // Over-rotated: steer back towards the direction of travel.
  const excess = Math.abs(state.slipAngle) - SLIDE_LIMIT;
  if (excess > 0) yaw += (state.slipAngle > 0 ? 1 : -1) * excess * 4;

  // Yaw is counter-clockwise positive; steer is +1 right. Opposite signs.
  const turnScale = clamp(state.speed / h.turnInSpeed, 0.2, 1);
  out.steer = clamp(-yaw / (h.turnRate * turnScale), -1, 1);
  return out;
}
