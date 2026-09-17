/**
 * The sim's data schema. Everything here is plain data: no methods, no classes
 * with behaviour, nothing that holds a reference to anything outside the sim.
 */

/**
 * The player's whole say in the matter: one steering value, already
 * dequantised to sim units. The car drives itself forward; there is no
 * throttle, brake or handbrake.
 */
export interface SimInput {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
}

/** Quantised input as stored in a replay: steer as int16, 2 bytes per sampled tick. */
export const STEER_QUANT = 32767;

export type CarClass = 'C' | 'B' | 'A' | 'S';

/**
 * Arcade drift handling.
 *
 * Deliberately not a tyre model. The steering sets how fast the body rotates,
 * and sideways friction decides how the velocity follows it. Every number here
 * is something a player can feel directly, which is what makes it tunable by
 * hand on a phone rather than by telemetry.
 */
export interface HandlingParams {
  /** m/s. The car accelerates towards this on its own. */
  topSpeed: number;
  /** m/s^2 from a standstill, tapering to zero at top speed. */
  acceleration: number;
  /** rad/s of body rotation at full steering. */
  turnRate: number;
  /** 1/s. How quickly the body's rotation reaches what the steering asks for. */
  turnResponse: number;
  /** m/s. Below this the car turns proportionally less, so it cannot spin on the spot. */
  turnInSpeed: number;
  /** g. Sideways friction while the tyres are gripping. */
  grip: number;
  /** g. Sideways friction in a slide at a shallow angle. */
  slideFrictionLow: number;
  /**
   * g. Sideways friction in a slide at 90 degrees. Higher than the shallow
   * value on purpose: a wider slide scrubs harder and pulls itself back into
   * line, which is what makes a long drift hold instead of spinning.
   */
  slideFrictionHigh: number;
  /** Radians of slip at which the tyres let go. */
  breakAngle: number;
  /** Radians of slip below which they grip again. Smaller than breakAngle. */
  regripAngle: number;
  /** 1/s. How strongly the nose swings back to the direction of travel when not steering. */
  selfAlign: number;
}

export interface AudioParams {
  cylinders: number;
  /** Hz at idle for the fundamental. */
  basePitch: number;
  /** 0..1 waveshaper drive. */
  distortion: number;
  /** Lowpass cutoff in Hz at zero load; opens up with throttle. */
  filterBase: number;
  filterRange: number;
  /** Relative level of the induction/whine layer, 0..1. */
  whine: number;
}

export interface CarParams {
  id: string;
  name: string;
  carClass: CarClass;
  handling: HandlingParams;
  /** Metres, centre to front axle. Rendering only: where the front wheels are drawn. */
  cgToFront: number;
  /** Metres, centre to rear axle. Rendering and skid marks. */
  cgToRear: number;
  /** Metres, for rendering. */
  bodyLength: number;
  bodyWidth: number;
  /** Radians. How far the drawn front wheels turn. Cosmetic. */
  maxWheelAngle: number;
  audio: AudioParams;
  /** Rendering only; never read by the sim step. */
  sprite?: { path: string; pixelsPerMetre: number };
  tint?: string;
}

/** One centreline sample. Stored as parallel arrays on the route for locality. */
export interface RouteSamples {
  x: number[];
  y: number[];
  /** Tangent direction, radians. */
  heading: number[];
  /** Signed 1/radius. Positive = left turn. */
  curvature: number[];
  /** Metres from centreline to each edge. */
  halfWidth: number[];
  /** Surface grip multiplier, 1.0 = nominal dry tarmac. */
  grip: number[];
}

export interface RouteCorner {
  startIndex: number;
  apexIndex: number;
  endIndex: number;
  /** +1 left, -1 right. */
  sign: number;
  /** 1 (fast kink) .. 6 (hairpin). Drives the pace-note icon. */
  severity: number;
  /** Peak absolute curvature through the corner. */
  peakCurvature: number;
}

export interface ClipPoint {
  /** Centreline sample index. */
  index: number;
  /** Lateral offset from centreline in metres; positive = left. */
  offset: number;
  /** Metres. Full proximity bonus inside this radius. */
  radius: number;
}

export interface DriftZone {
  entryIndex: number;
  exitIndex: number;
  cornerIndex: number;
  /** Base score multiplier for this zone; tighter corners are worth more. */
  baseMultiplier: number;
}

export interface RouteData {
  id: string;
  version: number;
  name: string;
  /** Fictional location label shown on the route poster. */
  location: string;
  /** Seeds the sim's PRNG. Part of the route's identity, never regenerated. */
  seed: number;
  /** Metres between consecutive centreline samples. */
  sampleSpacing: number;
  /** Total centreline length, metres. */
  length: number;
  samples: RouteSamples;
  corners: RouteCorner[];
  clipPoints: ClipPoint[];
  driftZones: DriftZone[];
  /** Sanity bounds for server-side score rejection. */
  theoreticalMinTime: number;
  theoreticalMaxPoints: number;
  /** Rendering only. Never read by the sim. */
  decoration?: string;
  poster?: string;
}

export type SimMode = 'timeAttack' | 'driftRun';

/**
 * The help the game gives, per mode.
 *
 * With one thumb and no pedals, the player cannot manage speed, so the car does:
 * it slows for corners it can see coming, loses speed to steering and sliding,
 * and bends its path back onto the road -- but only while the player is
 * steering roughly the right way. The two modes use the same model with
 * different numbers: Time Attack keeps slides short and favours grip, Drift Run
 * lets the car hang out and bleeds speed through the slide instead.
 *
 * Global rather than per car, so every car in a mode plays by the same rules.
 */
export interface AssistParams {
  /** Multiplies the car's grip. */
  gripScale: number;
  /** Multiplies both slide frictions. Higher snaps slides shut sooner. */
  slideHoldScale: number;
  /** Radians. Past this slide angle the nose is pulled back towards the direction of travel. */
  maxSlideAngle: number;
  /** Corner speed as a multiple of what grip allows. 0 turns corner braking off. */
  cornerSpeed: number;
  /** m/s^2. How hard the car may brake by itself for a corner ahead. */
  cornerBraking: number;
  /** m/s^2 of speed lost at full steering and top speed. */
  steerDrag: number;
  /** m/s^2 of speed lost in a slide at 90 degrees. */
  slideDrag: number;
  /** 0..1. How firmly the path is bent back onto the road while the player steers the right way. */
  roadKeeping: number;
  /** 0..1. How much the throttle pulses in a slide, like a driver working the pedal. */
  throttlePulse: number;
}

/** Per-run constants. Fixed at run start, recorded with the replay. */
export interface SimConfig {
  mode: SimMode;
  assist: AssistParams;
}

/** Live drift-run scoring state. Lives in the sim so replays reproduce it exactly. */
export interface DriftScoreState {
  /** Points banked from completed drift zones. */
  banked: number;
  /** Points accumulating in the current combo, not yet banked. */
  pending: number;
  /** Current combo multiplier, x1 upward. */
  multiplier: number;
  /** Ticks the current drift has been held. */
  driftTicks: number;
  /** True while the car is inside a marked drift zone. */
  inZone: boolean;
  activeZone: number;
  /** Set for one tick when a combo breaks, so the renderer can flash. */
  brokeThisTick: boolean;
  /** Post-run style inputs, accumulated live but only graded at the end. */
  reversals: number;
  correctionSum: number;
  ticksToInitiation: number;
  zonesEntered: number;
  zonesCleared: number;
  /** True once anything has been banked in the current zone. */
  zoneScored: boolean;
  /** Sign of the drift angle last tick, for reversal counting. */
  lastDriftSign: number;
}

export interface SimState {
  tick: number;

  // --- Rigid body, world frame ---
  x: number;
  y: number;
  /** Radians. Direction the car is pointing. */
  heading: number;

  // --- Velocities, body frame ---
  /** Longitudinal, m/s. */
  vx: number;
  /** Lateral, m/s. Non-zero lateral velocity is what drifting is. */
  vy: number;
  /** Yaw rate, rad/s. */
  yawRate: number;

  /** True once the tyres have let go, until the slip falls back under the regrip angle. */
  sliding: boolean;
  /** The steering applied last tick, -1..1. */
  steer: number;

  // --- Derived, cached for renderer/audio/scoring; never an integration input ---
  /** 0..1. How much drive the car is using: 0 while it brakes for a corner, pulsing in a slide. */
  throttle: number;
  /** True on ticks where road keeping bent the car's path. */
  roadKept: boolean;
  /** How much the steering moved this tick. Sawing at it is a save, not a clean drift. */
  steerChange: number;
  /** Radians. Drawn front-wheel angle, positive = left. Cosmetic. */
  steerAngle: number;
  /** Angle between velocity vector and heading, radians. The drift angle. */
  slipAngle: number;
  speed: number;

  // --- Route progress ---
  /** Nearest centreline sample index. Searched incrementally from the last one. */
  sampleIndex: number;
  /** Distance along the centreline, metres. */
  distance: number;
  /** Signed lateral offset from the centreline, metres. Positive = left. */
  lateralOffset: number;
  offTrack: boolean;
  finished: boolean;

  // --- Scoring ---
  /** Ticks elapsed since the run started. */
  raceTicks: number;
  /** Accumulated penalty in ticks (time attack) applied at the finish. */
  penaltyTicks: number;
  wallHits: number;
  /** Set for one tick on wall contact, for renderer/audio feedback. */
  hitThisTick: boolean;
  drift: DriftScoreState;

  // --- Determinism bookkeeping ---
  rngS0: number;
  rngS1: number;
  rngS2: number;
  rngS3: number;
}
