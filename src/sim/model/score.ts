import { sin, cos, clamp } from '../math/trig.ts';
import type { RouteData, SimState } from '../types.ts';

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
/** Radians (~70 degrees). Past this the car has spun and the combo dies. */
const SPIN_ANGLE = 1.22;
/** m/s (~29 km/h). Slow-speed wiggling should not bank points. */
const MIN_DRIFT_SPEED = 8;
/** Ticks of straightening tolerated before the combo breaks. */
const STRAIGHTEN_GRACE = 36;

/** Time Attack penalty for hitting a wall, in sim ticks (2 seconds at 120Hz). */
export const WALL_PENALTY_TICKS = 240;
/** Drift Run combo penalty: a wall always breaks the combo, forfeiting pending points. */

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
export function stepDriftScore(state: SimState, route: RouteData, dt: number): void {
  const d = state.drift;
  d.brokeThisTick = false;

  const absSlip = Math.abs(state.slipAngle);
  const driftSign = state.slipAngle >= 0 ? 1 : -1;

  // --- Which drift zone, if any, are we in? ---
  const zoneIndex = findZone(route, state.sampleIndex);
  const wasInZone = d.inZone;
  d.inZone = zoneIndex >= 0;
  d.activeZone = zoneIndex;

  if (d.inZone && !wasInZone) {
    d.zonesEntered++;
    d.ticksToInitiation = 0;
  }

  // --- Combo break conditions ---
  if (state.hitThisTick) {
    breakCombo(d);
  } else if (absSlip > SPIN_ANGLE) {
    breakCombo(d);
  } else if (absSlip < MIN_DRIFT_ANGLE || state.speed < MIN_DRIFT_SPEED) {
    d.driftTicks = 0;
    if (d.pending > 0) {
      d.correctionSum += 0; // straightening is not a correction, just an end
      if (++d.ticksToInitiation > STRAIGHTEN_GRACE) breakCombo(d);
    }
  }

  // --- Leaving a zone with the combo intact banks it ---
  if (!d.inZone && wasInZone) {
    if (d.pending > 0) {
      d.banked += d.pending;
      d.pending = 0;
      d.zonesCleared++;
    }
    d.multiplier = 1;
    d.driftTicks = 0;
  }

  // --- Accrue ---
  const drifting = absSlip >= MIN_DRIFT_ANGLE && state.speed >= MIN_DRIFT_SPEED && !state.hitThisTick;

  if (drifting) {
    // Count a steering reversal: the slide swapped sides while still committed.
    // This is a style signal, graded after the run rather than shown live.
    if (d.lastDriftSign !== 0 && d.lastDriftSign !== driftSign && d.driftTicks > 12) {
      d.reversals++;
    }
    d.lastDriftSign = driftSign;
    d.driftTicks++;
    d.ticksToInitiation = 0;

    if (d.inZone) {
      const zone = route.driftZones[zoneIndex];

      // Angle: peaks near 45 degrees, falls away as the car approaches a spin.
      const angleFactor = clamp(absSlip / 0.79, 0, 1) * (absSlip > 0.79 ? clamp((SPIN_ANGLE - absSlip) / 0.43, 0.2, 1) : 1);
      // Speed: normalised against 40 m/s (~144 km/h).
      const speedFactor = clamp(state.speed / 40, 0, 1.4);
      // Line: how close to the prescribed clipping point.
      const lineFactor = proximityFactor(state, route, zone.entryIndex, zone.exitIndex);

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

function breakCombo(d: SimState['drift']): void {
  if (d.pending > 0 || d.multiplier > 1) d.brokeThisTick = true;
  d.pending = 0;
  d.multiplier = 1;
  d.driftTicks = 0;
  d.lastDriftSign = 0;
}

/** Index of the drift zone containing this sample, or -1. Linear over a short array. */
function findZone(route: RouteData, sampleIndex: number): number {
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
  points: number;
  wallHits: number;
  grade: StyleGrade;
  /** Multiplier applied to banked points to produce `points`. */
  styleModifier: number;
  zonesCleared: number;
  zonesTotal: number;
  reversals: number;
}

/**
 * Grade the completed run.
 *
 * Deliberately post-run rather than live: the brief is right that showing a
 * style meter during the drive would compete for attention with the combo
 * ticker, and these signals (reversal count, time to initiation, correction
 * magnitude) only mean anything averaged over a whole run.
 */
export function gradeRun(state: SimState, route: RouteData, tickRate: number): RunResult {
  const d = state.drift;
  const totalTicks = state.raceTicks + state.penaltyTicks;
  const zonesTotal = route.driftZones.length;

  // Clean commitment: cleared most zones, few saves, low correction.
  const clearRate = zonesTotal === 0 ? 1 : d.zonesCleared / zonesTotal;
  const correctionPerZone = d.zonesCleared === 0 ? 0 : d.correctionSum / d.zonesCleared;

  let score = 0;
  score += clearRate * 50;
  score += clamp(1 - correctionPerZone / 2.5, 0, 1) * 25;
  score += clamp(1 - state.wallHits / 4, 0, 1) * 15;
  score += clamp(d.reversals / Math.max(zonesTotal, 1), 0, 1) * 10;

  const grade: StyleGrade =
    score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 38 ? 'C' : 'D';

  const styleModifier = 0.8 + (score / 100) * 0.7; // 0.8x .. 1.5x

  return {
    totalTicks,
    timeSeconds: totalTicks / tickRate,
    points: Math.round(d.banked * styleModifier),
    wallHits: state.wallHits,
    grade,
    styleModifier,
    zonesCleared: d.zonesCleared,
    zonesTotal,
    reversals: d.reversals,
  };
}
