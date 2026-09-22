import {
  createSimState,
  stepSim,
  dequantiseInput,
  InputRecorder,
  TICKS_PER_INPUT,
  type QuantisedInput,
} from './sim/index.ts';
import type { CarParams, RouteData, SimConfig, SimInput } from './sim/types.ts';

/**
 * A ghost: someone else's run, driven again beside the player.
 *
 * The sim is deterministic, so a stored input stream replays to exactly the
 * run that was posted. Rather than stepping a second car in lockstep with the
 * player, the whole run is driven once when the race loads and kept as a
 * track of poses, one per tick. Drawing it is then a lookup, and so is the gap:
 * we know where the ghost will be, not just where it has been, so the player
 * can be told how far ahead they are as well as how far behind.
 */
export interface GhostTrack {
  name: string;
  car: CarParams;
  /** Ticks the ghost took to finish. */
  ticks: number;
  /** Pose after each tick; index 0 is the start line. */
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  steerAngle: Float32Array;
  /** Furthest distance along the route reached by each tick. Never decreases. */
  reach: Float32Array;
  /** Penalty ticks served by each tick (Time Attack wall hits). */
  penalty: Int32Array;
  /** Drift points on the board by each tick, banked and pending. */
  points: Float32Array;
}

export interface GhostPose {
  x: number;
  y: number;
  heading: number;
  steerAngle: number;
  car: CarParams;
}

/** Longest run a ghost is driven for: ten minutes. Anything longer is not a real run. */
const MAX_TICKS = 120 * 600;

/**
 * Drive a stored run from start to finish. Returns null when it does not
 * finish, which means the replay does not belong to this route or this
 * version of the game.
 */
export function buildGhost(
  name: string,
  car: CarParams,
  route: RouteData,
  config: SimConfig,
  inputBytes: Uint8Array,
): GhostTrack | null {
  const recorder = InputRecorder.decode(inputBytes);
  if (recorder.length === 0) return null;
  const limit = Math.min(MAX_TICKS, recorder.length * TICKS_PER_INPUT + TICKS_PER_INPUT);

  const x = new Float32Array(limit + 1);
  const y = new Float32Array(limit + 1);
  const heading = new Float32Array(limit + 1);
  const steerAngle = new Float32Array(limit + 1);
  const reach = new Float32Array(limit + 1);
  const penalty = new Int32Array(limit + 1);
  const points = new Float32Array(limit + 1);

  const state = createSimState(route, car);
  const input: SimInput = { steer: 0, throttle: 1, initiate: false };
  const sample: QuantisedInput = { steer: 0, throttle: 0, flags: 0 };
  let furthest = 0;

  const record = (i: number) => {
    x[i] = state.x;
    y[i] = state.y;
    heading[i] = state.heading;
    steerAngle[i] = state.steerAngle;
    furthest = Math.max(furthest, state.distance);
    reach[i] = furthest;
    penalty[i] = state.penaltyTicks;
    points[i] = state.drift.banked + state.drift.pending;
  };

  record(0);
  // Exactly the loop the live game runs: a new input sample every
  // TICKS_PER_INPUT ticks, held in between.
  while (!state.finished && state.tick < limit) {
    if (state.tick % TICKS_PER_INPUT === 0) {
      recorder.at(state.tick / TICKS_PER_INPUT, sample);
      dequantiseInput(sample, input);
    }
    stepSim(state, input, car, route, config);
    record(state.tick);
  }
  if (!state.finished) return null;

  const ticks = state.tick;
  return {
    name,
    car,
    ticks,
    x: x.subarray(0, ticks + 1),
    y: y.subarray(0, ticks + 1),
    heading: heading.subarray(0, ticks + 1),
    steerAngle: steerAngle.subarray(0, ticks + 1),
    reach: reach.subarray(0, ticks + 1),
    penalty: penalty.subarray(0, ticks + 1),
    points: points.subarray(0, ticks + 1),
  };
}

/** Seconds the ghost stays parked past the line before it fades out. */
const LINGER_TICKS = 120;

/**
 * Where to draw the ghost at a tick, interpolated like the player's car.
 * Null once it has finished and had a moment at the line.
 */
export function ghostPose(ghost: GhostTrack, tick: number, alpha: number): GhostPose | null {
  if (tick > ghost.ticks + LINGER_TICKS) return null;
  const b = Math.min(tick, ghost.ticks);
  const a = Math.max(0, Math.min(tick - 1, ghost.ticks));
  const t = b === a ? 0 : Math.min(1, Math.max(0, alpha));
  let dh = ghost.heading[b] - ghost.heading[a];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return {
    x: ghost.x[a] + (ghost.x[b] - ghost.x[a]) * t,
    y: ghost.y[a] + (ghost.y[b] - ghost.y[a]) * t,
    heading: ghost.heading[a] + dh * t,
    steerAngle: ghost.steerAngle[a] + (ghost.steerAngle[b] - ghost.steerAngle[a]) * t,
    car: ghost.car,
  };
}

/** The first tick at which the ghost had got as far as `distance`, or -1 if it never did. */
export function ghostTickAt(ghost: GhostTrack, distance: number): number {
  const reach = ghost.reach;
  if (reach[reach.length - 1] < distance) return -1;
  let lo = 0;
  let hi = reach.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reach[mid] >= distance) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Time between the player and the ghost at the same point on the road, in
 * ticks, penalties included. Positive: the player is behind.
 */
export function ghostTimeGap(ghost: GhostTrack, distance: number, tick: number, penaltyTicks: number): number | null {
  const g = ghostTickAt(ghost, distance);
  if (g < 0) return null;
  return tick + penaltyTicks - (g + ghost.penalty[g]);
}

/**
 * Drift points between the player and the ghost at the same point on the
 * road. Positive: the player has more.
 */
export function ghostPointsGap(ghost: GhostTrack, distance: number, points: number): number | null {
  const g = ghostTickAt(ghost, distance);
  if (g < 0) return null;
  return points - ghost.points[g];
}
