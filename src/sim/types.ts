/**
 * The sim's data schema. Everything here is plain data: no methods, no classes
 * with behaviour, nothing that holds a reference to anything outside the sim.
 */

/** Steering / throttle / handbrake, already dequantised to sim units. */
export interface SimInput {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** -1 (full brake) .. +1 (full throttle). */
  throttle: number;
  handbrake: boolean;
}

/**
 * Quantised input as stored in a replay: 4 bytes per sampled tick.
 * steer int16, throttle int8, flags uint8 (bit 0 = handbrake).
 */
export const STEER_QUANT = 32767;
export const THROTTLE_QUANT = 127;
export const FLAG_HANDBRAKE = 1 << 0;

export type CarClass = 'C' | 'B' | 'A' | 'S';

/** Simplified Pacejka lateral coefficients, per axle. */
export interface TyreParams {
  /** Stiffness. Higher = force builds faster with slip angle. */
  b: number;
  /** Shape. ~1.3-1.5 for lateral. */
  c: number;
  /** Peak friction coefficient at nominal load. */
  d: number;
  /** Curvature. Controls how sharply force falls off past the peak. */
  e: number;
  /**
   * Load sensitivity, 0..1. Real tyres lose grip per newton as load rises;
   * this is what makes weight transfer actually matter rather than being a
   * cosmetic term. 0 = grip scales linearly with load (unrealistic, very
   * grippy under transfer), 0.3 is roughly road-tyre-like.
   */
  loadSensitivity: number;
}

export interface EngineParams {
  idleRpm: number;
  redlineRpm: number;
  /**
   * Torque (Nm) sampled at evenly spaced RPM fractions from 0 to redline.
   * A curve rather than a single peak number so cars can differ in character
   * (peaky turbo vs flat NA) without bespoke code.
   */
  torqueCurve: number[];
  gearRatios: number[];
  finalDrive: number;
  /** Fraction of redline at which the auto gearbox upshifts. */
  shiftUpFraction: number;
  shiftDownFraction: number;
  /** Seconds of torque interruption on a shift. */
  shiftTime: number;
  drivetrainEfficiency: number;
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
  /** kg. */
  mass: number;
  /** Yaw inertia, kg m^2. */
  inertiaZ: number;
  /** Metres, CG to front axle. */
  cgToFront: number;
  /** Metres, CG to rear axle. */
  cgToRear: number;
  /** Metres. Drives weight transfer magnitude. */
  cgHeight: number;
  /** Metres, for rendering and wall collision extents. */
  bodyLength: number;
  bodyWidth: number;
  wheelRadius: number;
  /** Radians at full lock. */
  maxSteerAngle: number;
  /** Radians per second of steering rate at the road wheel. */
  steerRate: number;
  tyreFront: TyreParams;
  tyreRear: TyreParams;
  engine: EngineParams;
  /** 0.5 * rho * Cd * A, so drag force = dragCoeff * v^2. */
  dragCoeff: number;
  rollingResistance: number;
  /** Nm at the wheels under full brake. */
  brakeTorque: number;
  /** Nm at the rear wheels when the handbrake is held. */
  handbrakeTorque: number;
  /** Fraction of brake torque at the front axle. */
  brakeBias: number;
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

/** Per-run constants. Fixed at run start, recorded with the replay. */
export interface SimConfig {
  mode: SimMode;
  /**
   * 0 = fully manual throttle, 1 = fully automatic. Blended inside the engine
   * torque calculation rather than switching code paths, so a run recorded at
   * assist 0.6 replays identically only when replayed at assist 0.6 -- which is
   * why it lives here, in the recorded run header, and not in local settings.
   */
  assist: number;
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

  // --- Drivetrain ---
  gear: number;
  rpm: number;
  shiftTimer: number;
  /** Rear wheel angular speed, rad/s. Diverges from road speed on spin/lock. */
  rearWheelSpeed: number;

  // --- Actuators (rate-limited, so input steps do not become force steps) ---
  steerAngle: number;
  throttleApplied: number;

  // --- Derived, cached for renderer/audio/scoring; never an integration input ---
  /** Angle between velocity vector and heading, radians. The drift angle. */
  slipAngle: number;
  speed: number;
  frontSlip: number;
  rearSlip: number;
  lateralG: number;

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
