import { sin, cos, clamp } from '../math/trig.ts';
import { SWEET_SPOT } from '../types.ts';
import type { RouteData, SimConfig, SimState } from '../types.ts';

/**
 * Scoring lives inside the sim, on sim ticks, from sim state.
 *
 * This is not a stylistic choice. If the score were a rendering-layer overlay
 * computed from interpolated display state, then re-simulating a stored replay
 * would produce a different number from the one the player saw live -- which
 * makes ghosts lie and makes any future server-side verification reject honest
 * runs. The number on screen must be a value the sim produced.
 */

// --- Thresholds -------------------------------------------------------------

/** Radians (~8 degrees). Below this the car is cornering, not drifting. */
const MIN_DRIFT_ANGLE = 0.14;
/**
 * Radians (~83 degrees). Past this the car has spun and the combo dies. Wide,
 * because Drift Run lets the car hang out at 60 degrees and more, and a lurid
 * slide that briefly overshoots is the thing being rewarded, not a spin.
 */
export const SPIN_ANGLE = 1.45;
/** Radians (~52 degrees). Slide angle worth the most points. */
const BEST_ANGLE = 0.9;
/** m/s (90 km/h). Drift speed worth full points; faster is worth up to 1.4x. */
const REFERENCE_SPEED = 25;
/** m/s (~29 km/h). Slow-speed wiggling should not bank points. */
const MIN_DRIFT_SPEED = 8;
/** Ticks of straightening tolerated before the combo ends and banks. */
const STRAIGHTEN_GRACE = 36;

/** Time Attack penalty for hitting a wall, in sim ticks (2 seconds at 120Hz). */
export const WALL_PENALTY_TICKS = 240;

/** Ceiling on the combo multiplier so a single long zone cannot run away. */
const MAX_MULTIPLIER = 8;

// ---------------------------------------------------------------------------

/**
 * Advance drift scoring by one tick.
 *
 * Presented to the player as a single combo/score ticker rather than separate
 * angle/speed/line meters: the multiplier is the one number that tells you
 * whether what you are doing is working.
 */
export function stepDriftScore(state: SimState, route: RouteData, config: SimConfig, dt: number): void {
  const throttleControls = config.controls === 'throttle';
  const d = state.drift;
  d.brokeThisTick = false;

  const absSlip = Math.abs(state.slipAngle);
  const driftSign = state.slipAngle >= 0 ? 1 : -1;

  // --- Spins ---
  // With throttle controls the sim decides exactly when the car spins, and only
  // that counts. Judging by angle as well scored a spin for every slide that
  // went past SPIN_ANGLE and was caught short of the sim's own limit: the car
  // held its line, the player felt the save, and the sheet said they had spun.
  // Steered, there is no such signal, so the angle is the judge. Either way it
  // is one per spin: not over until the car is back under half the angle, so a
  // slide hovering around the threshold does not count several times.
  const overAngle = !throttleControls && absSlip > SPIN_ANGLE;
  const spinningNow = overAngle || state.spinTicks > 0;
  if (spinningNow && !d.spinning) d.spins++;
  d.spinning = spinningNow || (d.spinning && !throttleControls && absSlip > SPIN_ANGLE * 0.5);

  // --- Which drift zone, if any, are we in? ---
  const zoneIndex = findZone(route, state.sampleIndex);
  const wasInZone = d.inZone;
  const previousZone = d.activeZone;
  d.inZone = zoneIndex >= 0;
  d.activeZone = zoneIndex;

  if (d.inZone && !wasInZone) {
    d.zonesEntered++;
    d.ticksToInitiation = 0;
  }

  // --- Straight from one zone into the next ---
  // Routes are baked so zones never touch, but if two ever do, the first is
  // judged at the hand-over: what the drift earned there is banked and the
  // zone counts, without breaking the drift that carries on into the next.
  // Before this, a zone was only judged on leaving every zone, so a drift
  // through a run of touching zones cleared one of them at most.
  if (wasInZone && d.inZone && zoneIndex !== previousZone) {
    if (d.pending > 0) {
      d.banked += d.pending;
      d.pending = 0;
      d.zoneScored = true;
    }
    if (d.zoneScored) d.zonesCleared++;
    d.zoneScored = false;
    d.zonesEntered++;
  }

  // --- How a combo ends ---
  // A wall or a spin forfeits what is pending. Straightening up banks it: with
  // the assist keeping the car on the road, the slides are shorter and more
  // frequent than they were, and losing a whole corner's points for the moment
  // between two of them felt like being robbed.
  if (state.hitThisTick) {
    breakCombo(d);
  } else if (overAngle || state.spinTicks > 0) {
    breakCombo(d);
  } else if (throttleControls && state.driftDir === 0 && state.spinTicks === 0) {
    // With throttle controls the sim says exactly when a drift is over, so bank
    // at that moment rather than after a grace period: the points should land
    // when the car visibly straightens, not a beat later.
    d.driftTicks = 0;
    if (d.pending > 0) bankCombo(d);
  } else if (absSlip < MIN_DRIFT_ANGLE || state.speed < MIN_DRIFT_SPEED) {
    d.driftTicks = 0;
    if (d.pending > 0 && ++d.ticksToInitiation > STRAIGHTEN_GRACE) bankCombo(d);
  }

  // --- Leaving a zone with the combo intact banks it ---
  if (!d.inZone && wasInZone) {
    if (d.pending > 0) bankCombo(d);
    if (d.zoneScored) d.zonesCleared++;
    d.zoneScored = false;
    d.multiplier = 1;
    d.driftTicks = 0;
  }

  // --- Accrue ---
  // With throttle controls only a drift the player started counts; the game's
  // own cornering never scores.
  const drifting =
    absSlip >= MIN_DRIFT_ANGLE &&
    state.speed >= MIN_DRIFT_SPEED &&
    !state.hitThisTick &&
    state.spinTicks === 0 &&
    (!throttleControls || state.driftDir !== 0);

  if (drifting) {
    // Count a steering reversal: the slide swapped sides while still committed.
    // This is a style signal, graded after the run rather than shown live.
    // Counted against time held on the side just left, not the current combo:
    // passing through straight on the way over resets driftTicks, so the old
    // test never fired on a real transition.
    if (d.lastDriftSign !== 0 && d.lastDriftSign !== driftSign) {
      if (d.sideTicks > 12) d.reversals++;
      d.sideTicks = 0;
    }
    d.lastDriftSign = driftSign;
    d.sideTicks++;
    d.driftTicks++;
    d.ticksToInitiation = 0;

    if (d.inZone) {
      const zone = route.driftZones[zoneIndex];

      // Angle. With steering controls: builds to BEST_ANGLE, then falls away as
      // the car approaches a spin. With throttle controls the balance is the
      // game, so the reward is for living on the limit: angle builds towards
      // the limit angle, and inside the sweet spot just under it (or over it,
      // until it spins) it pays a quarter more.
      const limit = config.drift.limitAngle;
      const angleFactor = throttleControls
        ? absSlip >= limit - SWEET_SPOT
          ? 1.25
          : clamp(absSlip / limit, 0, 1)
        : absSlip <= BEST_ANGLE
          ? absSlip / BEST_ANGLE
          : clamp((SPIN_ANGLE - absSlip) / (SPIN_ANGLE - BEST_ANGLE), 0.2, 1);
      // Speed: holding angle while carrying speed is the hard part.
      const speedFactor = clamp(state.speed / REFERENCE_SPEED, 0, 1.4);
      // Line: how close to the prescribed clipping point.
      // With throttle controls the game picks the line, so what the player
      // controls instead is when the drift started.
      const lineFactor = throttleControls
        ? d.entryFactor
        : proximityFactor(state, route, zone.entryIndex, zone.exitIndex);

      // Multiplier grows with sustained commitment, then holds at the cap.
      d.multiplier = clamp(1 + d.driftTicks / 90, 1, MAX_MULTIPLIER);

      const perSecond = 900 * angleFactor * speedFactor * lineFactor * zone.baseMultiplier;
      d.pending += perSecond * d.multiplier * dt;

      // Correction magnitude: how much the player is sawing at the steering.
      // Small, steady input is a clean drift; large rapid input is a save.
      d.correctionSum += state.steerChange * 2;
    }
  }
}

function bankCombo(d: SimState['drift']): void {
  // A drift that ends in a bank is over: the next one starts a fresh side.
  if (d.pending > 0) {
    d.lastDriftSign = 0;
    d.sideTicks = 0;
  }
  d.banked += d.pending;
  d.pending = 0;
  d.multiplier = 1;
  d.driftTicks = 0;
  d.ticksToInitiation = 0;
  d.zoneScored = true;
}

function breakCombo(d: SimState['drift']): void {
  if (d.pending > 0 || d.multiplier > 1) d.brokeThisTick = true;
  d.pending = 0;
  d.multiplier = 1;
  d.driftTicks = 0;
  d.lastDriftSign = 0;
  d.sideTicks = 0;
}

/** Index of the drift zone containing this sample, or -1. Linear over a short array. */
export function findZone(route: RouteData, sampleIndex: number): number {
  const zones = route.driftZones;
  for (let i = 0; i < zones.length; i++) {
    if (sampleIndex >= zones[i].entryIndex && sampleIndex <= zones[i].exitIndex) return i;
  }
  return -1;
}

/**
 * Proximity to the prescribed line, 0.35..1.
 *
 * Never returns zero: a wide drift is worth fewer points, not no points. The
 * floor stops the scoring from feeling arbitrary to a player who cannot see the
 * clip points.
 */
function proximityFactor(
  state: SimState,
  route: RouteData,
  fromIndex: number,
  toIndex: number,
): number {
  let best = 0.35;
  const clips = route.clipPoints;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (clip.index < fromIndex || clip.index > toIndex) continue;
    const s = route.samples;
    const h = s.heading[clip.index];
    // Clip point sits `offset` metres to the left of the centreline sample.
    const cx = s.x[clip.index] - sin(h) * clip.offset;
    const cy = s.y[clip.index] + cos(h) * clip.offset;
    const dx = state.x - cx;
    const dy = state.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const factor = clamp(1 - (dist - clip.radius) / (clip.radius * 3), 0.35, 1);
    if (factor > best) best = factor;
  }
  return best;
}

// --- Post-run grading -------------------------------------------------------

export type StyleGrade = 'D' | 'C' | 'B' | 'A' | 'S';

export interface RunResult {
  /** Sim ticks including penalties. Divide by TICK_RATE for seconds. */
  totalTicks: number;
  timeSeconds: number;
  /** Final score: earned, plus bonuses, less deductions. */
  points: number;
  /** Points banked by drifting, before bonuses and deductions. */
  earned: number;
  zoneBonus: number;
  transitionBonus: number;
  spinPenalty: number;
  wallPenalty: number;
  wallHits: number;
  /** Not shown; it picks the celebration on the results screen. */
  grade: StyleGrade;
  /** points / earned. */
  styleModifier: number;
  zonesCleared: number;
  zonesTotal: number;
  reversals: number;
  spins: number;
}

/** Bonuses and deductions, as shares of the points earned by drifting. */
const ZONE_BONUS = 0.3; // for clearing every zone, pro rata
const TRANSITION_BONUS = 0.05; // each
const TRANSITION_CAP = 0.25;
const SPIN_PENALTY = 0.12; // each
const SPIN_CAP = 0.6;
const WALL_PENALTY = 0.08; // each
const WALL_CAP = 0.5;

/**
 * Score the completed run.
 *
 * Every adjustment is a line the player can see: drift points earned, a bonus
 * for zones cleared and for transitions, a deduction for each spin and each
 * wall hit, and the total. The first version folded all of this into a hidden
 * style multiplier, which made the final number impossible to read.
 */
export function gradeRun(state: SimState, route: RouteData, tickRate: number): RunResult {
  const d = state.drift;
  const totalTicks = state.raceTicks + state.penaltyTicks;
  const zonesTotal = route.driftZones.length;
  const earned = Math.round(d.banked);

  const clearRate = zonesTotal === 0 ? 1 : d.zonesCleared / zonesTotal;
  const zoneBonus = Math.round(earned * ZONE_BONUS * clearRate);
  const transitionBonus = Math.round(earned * Math.min(TRANSITION_CAP, TRANSITION_BONUS * d.reversals));
  const spinPenalty = Math.round(earned * Math.min(SPIN_CAP, SPIN_PENALTY * d.spins));
  const wallPenalty = Math.round(earned * Math.min(WALL_CAP, WALL_PENALTY * state.wallHits));
  const points = Math.max(0, earned + zoneBonus + transitionBonus - spinPenalty - wallPenalty);

  const ratio = earned === 0 ? 0 : points / earned;
  const grade: StyleGrade =
    ratio >= 1.35 ? 'S' : ratio >= 1.2 ? 'A' : ratio >= 1.05 ? 'B' : ratio >= 0.9 ? 'C' : 'D';

  return {
    totalTicks,
    timeSeconds: totalTicks / tickRate,
    points,
    earned,
    zoneBonus,
    transitionBonus,
    spinPenalty,
    wallPenalty,
    wallHits: state.wallHits,
    grade,
    styleModifier: earned === 0 ? 1 : ratio,
    zonesCleared: d.zonesCleared,
    zonesTotal,
    reversals: d.reversals,
    spins: d.spins,
  };
}
