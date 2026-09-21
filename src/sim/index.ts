import { createRng, nextUint32 } from './math/prng.ts';
import { HASH_SEED, hashFloat, hashInt } from './math/hash.ts';
import { stepVehicle, resetToRoad } from './model/vehicle.ts';
import { stepThrottleControls, endDrift, isTailAgainstWall } from './model/throttleDrift.ts';
import {
  updateProgress,
  isAtFinish,
  isAgainstWall,
  surfaceGripAt,
  safeResetPose,
} from './model/progress.ts';
import { stepDriftScore, WALL_PENALTY_TICKS } from './model/score.ts';
import { DT, TICK_RATE } from './version.ts';
import type { CarParams, RouteData, SimConfig, SimInput, SimState } from './types.ts';

export * from './types.ts';
export * from './version.ts';
export * from './replay.ts';
export { gradeRun } from './model/score.ts';
export type { RunResult, StyleGrade } from './model/score.ts';
export { HASH_INTERVAL } from './math/hash.ts';
export { WALL_MARGIN } from './model/progress.ts';

/** Build the starting state for a run. Pure: same route + car => same state. */
export function createSimState(route: RouteData, _car: CarParams): SimState {
  const s = route.samples;
  const rng = createRng(route.seed);
  return {
    tick: 0,
    x: s.x[0],
    y: s.y[0],
    heading: s.heading[0],
    vx: 0,
    vy: 0,
    yawRate: 0,
    sliding: false,
    steer: 0,
    steerChange: 0,
    driftDir: 0,
    driftAngle: 0,
    flickTicks: 0,
    spinTicks: 0,
    initiateHeld: false,
    throttle: 0,
    roadKept: false,
    steerAngle: 0,
    slipAngle: 0,
    speed: 0,
    sampleIndex: 0,
    distance: 0,
    lateralOffset: 0,
    offTrack: false,
    finished: false,
    raceTicks: 0,
    penaltyTicks: 0,
    wallHits: 0,
    hitThisTick: false,
    drift: {
      banked: 0,
      pending: 0,
      multiplier: 1,
      driftTicks: 0,
      inZone: false,
      activeZone: -1,
      brokeThisTick: false,
      reversals: 0,
      spins: 0,
      spinning: false,
      correctionSum: 0,
      ticksToInitiation: 0,
      zonesEntered: 0,
      zonesCleared: 0,
      zoneScored: false,
      entryFactor: 1,
      lastDriftSign: 0,
    },
    rngS0: rng.s0,
    rngS1: rng.s1,
    rngS2: rng.s2,
    rngS3: rng.s3,
  };
}

/** Deep copy. Used to keep the previous state for render interpolation. */
export function cloneSimState(s: SimState): SimState {
  return { ...s, drift: { ...s.drift } };
}

/**
 * Advance the simulation by exactly one fixed timestep.
 *
 * This function is the determinism boundary. It reads only its arguments, calls
 * only deterministic helpers, and touches nothing outside `state`. If it ever
 * needs a clock, a random number, or the DOM, something has gone wrong in the
 * design rather than in this function.
 */
export function stepSim(
  state: SimState,
  input: SimInput,
  car: CarParams,
  route: RouteData,
  config: SimConfig,
): void {
  if (state.finished) return;

  state.hitThisTick = false;

  const grip = surfaceGripAt(state, route);
  if (config.controls === 'throttle') stepThrottleControls(state, car, input, config, route, grip, DT);
  else stepVehicle(state, car, input, config.assist, route, grip, DT);
  updateProgress(state, route);

  // --- Wall contact: penalty and a reset, never a restart ---
  // With throttle controls the tail counts too: at a big angle on a narrow road
  // the back of the car swings into the wall, which is the natural limit on
  // how much angle a corner will take.
  const tailHit = config.controls === 'throttle' && isTailAgainstWall(state, car, route);
  if (isAgainstWall(state, route) || tailHit) {
    state.wallHits++;
    state.hitThisTick = true;
    state.penaltyTicks += WALL_PENALTY_TICKS;

    // Put the car back a short distance before where it left the road, so the
    // player gets a run-up at the corner rather than being dropped mid-apex.
    const backOff = Math.max(0, state.sampleIndex - 4);
    const pose = safeResetPose(route, backOff);
    // Keep a fraction of the speed: a full stop after every brush would be a
    // harsher punishment than the time penalty already is.
    resetToRoad(state, pose.x, pose.y, pose.heading, state.speed * 0.45);
    endDrift(state);
    state.sampleIndex = backOff;
    updateProgress(state, route);
  }

  if (config.mode === 'driftRun') {
    stepDriftScore(state, route, config, DT);
  }

  state.tick++;
  state.raceTicks++;

  if (isAtFinish(state, route)) {
    state.finished = true;
    // Bank anything still pending in a zone that runs to the finish line.
    state.drift.banked += state.drift.pending;
    state.drift.pending = 0;
  }
}

/**
 * Draw from the sim's PRNG, keeping the state in the four SimState fields.
 *
 * Nothing in v1 needs this yet -- it exists so that when something does (surface
 * noise, a cosmetic-but-sim-visible detail), it uses a seeded stream that
 * replays identically instead of reaching for Math.random.
 */
export function simRandom(state: SimState): number {
  const rng = { s0: state.rngS0, s1: state.rngS1, s2: state.rngS2, s3: state.rngS3 };
  const value = nextUint32(rng) / 4294967296;
  state.rngS0 = rng.s0;
  state.rngS1 = rng.s1;
  state.rngS2 = rng.s2;
  state.rngS3 = rng.s3;
  return value;
}

/**
 * Hash the integration state -- the fields that feed the next step, not the
 * derived ones. Two sims that agree on these will agree forever; two that
 * disagree have already diverged even if their scores still match.
 */
export function hashSimState(state: SimState): number {
  let h = HASH_SEED;
  h = hashFloat(h, state.x);
  h = hashFloat(h, state.y);
  h = hashFloat(h, state.heading);
  h = hashFloat(h, state.vx);
  h = hashFloat(h, state.vy);
  h = hashFloat(h, state.yawRate);
  h = hashInt(h, state.sliding ? 1 : 0);
  h = hashFloat(h, state.steer);
  h = hashInt(h, state.driftDir);
  h = hashFloat(h, state.driftAngle);
  h = hashInt(h, state.flickTicks);
  h = hashInt(h, state.spinTicks);
  h = hashFloat(h, state.drift.banked);
  h = hashFloat(h, state.drift.pending);
  h = hashInt(h, state.raceTicks);
  h = hashInt(h, state.penaltyTicks);
  h = hashInt(h, state.rngS0);
  return h >>> 0;
}

/** Seconds elapsed in a run, including penalties. For display only. */
export function runTimeSeconds(state: SimState): number {
  return (state.raceTicks + state.penaltyTicks) / TICK_RATE;
}
