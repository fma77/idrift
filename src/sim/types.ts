/**
 * The sim's data schema. Everything here is plain data: no methods, no classes
 * with behaviour, nothing that holds a reference to anything outside the sim.
 */

/**
 * The player's input, already dequantised to sim units.
 *
 * Which fields matter depends on the controls (SimConfig.controls). With
 * steering controls the player steers and the car drives itself. With throttle
 * controls -- Drift Run only -- the game steers, and the player works the
 * throttle and taps to throw the car into a drift.
 */
export interface SimInput {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** 0..1. Throttle controls only. */
  throttle: number;
  /**
   * True while the drift button is held. Throttle controls only. How long it
   * is held matters: see HOLD_FULL in throttleDrift.ts.
   */
  initiate: boolean;
}

/** Quantised input as stored in a replay: steer int16, throttle uint8, flags uint8. */
export const STEER_QUANT = 32767;
export const THROTTLE_QUANT = 255;
export const FLAG_INITIATE = 1 << 0;

/** Who steers. See SimInput. */
export type Controls = 'steer' | 'throttle';

/**
 * Drift Run with throttle controls: how the game steers and how the throttle
 * sets the angle. Angles in radians.
 */
export interface DriftControlParams {
  /** rad/s of angle change per unit of throttle imbalance. How lively the angle is. */
  angleRate: number;
  /** The angle full throttle would hold, if nothing ran away first. */
  holdAngle: number;
  /** Past this angle the slide feeds itself and runs away towards a spin. */
  limitAngle: number;
  /** 1/s. How fast it runs away past the limit. */
  runaway: number;
  /** At this angle the car has spun. */
  spinAngle: number;
  /** The angle the flick throws the car to. */
  flickAngle: number;
  /** Seconds the flick takes, the opposite swing included. */
  flickTime: number;
  /** g. How hard the game can turn the car's path while it is sideways. */
  driftGrip: number;
  /**
   * Where the tail runs through a drift, as a fraction of the way from the
   * centreline to the outside edge. The drifty line: the rear of the car
   * drawing an arc round the outside of the corner, not the nose clipping the
   * apex.
   */
  tailLine: number;
  /** Before a corner, how far towards its outside the game sets the car up, same units. */
  setupLine: number;
  /** m/s^2 of speed a slide at 90 degrees costs. */
  angleDrag: number;
  /** rad/s. How fast the car straightens once the corner is behind it and the road ahead is straight. */
  exitRate: number;
}

/** Radians. Width of the scoring sweet spot, just under the limit angle. */
export const SWEET_SPOT = 0.26;

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

/**
 * Which engine a car sounds like. Presentation only -- the sim never reads it.
 *   na4:    high-revving naturally aspirated four
 *   rotary: two-rotor rotary
 *   turbo6: turbocharged straight six
 *   boxer4: turbocharged flat four
 */
export type EngineKind = 'na4' | 'rotary' | 'turbo6' | 'boxer4' | 'flat6tt' | 'turbo4';

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
  /** Sound only; never read by the sim step. */
  engine: EngineKind;
  /** Rendering only; never read by the sim step. */
  sprite?: { path: string; pixelsPerMetre: number };
  /** Garage hero image. A drawn placeholder stands in until it exists. */
  hero?: string;
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
  /** Credit for third-party source data. Never read by the sim. */
  attribution?: string;
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
  controls: Controls;
  drift: DriftControlParams;
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
  /**
   * Post-run style inputs, accumulated live but only graded at the end.
   * A reversal is a transition: the slide swapping sides while still
   * committed, as through an S-bend. It is a good thing, not a spin.
   */
  reversals: number;
  /** Spins so far, and whether the car is in one now. Counted, not graded. */
  spins: number;
  spinning: boolean;
  correctionSum: number;
  ticksToInitiation: number;
  zonesEntered: number;
  zonesCleared: number;
  /** True once anything has been banked in the current zone. */
  zoneScored: boolean;
  /** Sign of the drift angle last tick, for reversal counting. */
  lastDriftSign: number;
  /**
   * Ticks drifted on the current side. Unlike driftTicks it survives the
   * moment the car passes through straight on its way to the other side --
   * which every transition does, and which is why none were ever counted.
   */
  sideTicks: number;
  /** 0.5..1. How well timed the last drift entry was. Throttle controls only. */
  entryFactor: number;
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

  // --- Throttle controls ---
  /** +1 drifting through a left-hander (nose pointing left), -1 right, 0 not drifting. */
  driftDir: number;
  /** Radians. How far the nose points into the corner past the direction of travel. */
  driftAngle: number;
  /** Ticks left in the flick that starts a drift. */
  flickTicks: number;
  /** Ticks left in a spin. */
  spinTicks: number;
  /** Whether the drift button was down last tick, so one tap acts once. */
  initiateHeld: boolean;
  /** Ticks the drift button has been held since it started the current flick. */
  handbrakeTicks: number;
  /** True from that press until the button is let go. */
  handbrakeOn: boolean;

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
