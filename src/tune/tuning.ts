import { CARS } from '../data/cars.ts';
import { MODE_ASSIST, DRIFT_CONTROL } from '../data/assist.ts';
import { THROTTLE_FEEL } from '../input/input.ts';
import type { AssistParams, CarParams, DriftControlParams, HandlingParams, SimMode } from '../sim/types.ts';

/**
 * Hand-tuning the handling on a phone.
 *
 * Feel is the whole point of the arcade model, and feel cannot be judged from
 * telemetry. Tuning mode lets a player change every handling number mid-run and
 * drive straight back into the corner that felt wrong, then copy the values out
 * so they can become the defaults.
 *
 * Switched on in Settings, or with #tune on the URL. Tuned values are kept on
 * this device only, and nothing driven in tuning mode is saved as a best or
 * posted to a leaderboard: a time set with hand-edited grip is not comparable
 * with anyone else's.
 */

const STORAGE_KEY = 'idrift.tune.v1';

/** True when the URL asks for tuning mode, as #tune or ?tune. */
export function isTuneMode(): boolean {
  return location.hash === '#tune' || new URLSearchParams(location.search).has('tune');
}

export interface TuneSpec<K extends string = keyof HandlingParams> {
  key: K;
  label: string;
  /** Plain-language description of what moving the slider does. */
  help: string;
  /** In display units. */
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Stored value to display value. Inverted by `fromDisplay`. */
  toDisplay: (v: number) => number;
  fromDisplay: (v: number) => number;
}

const same = (v: number) => v;
const KMH = 3.6;
const DEG = 57.29577951308232;

export const TUNE_SPECS: TuneSpec[] = [
  {
    key: 'topSpeed',
    label: 'Top speed',
    help: 'How fast the car goes on a straight.',
    min: 60, max: 220, step: 5, unit: 'km/h',
    toDisplay: (v) => v * KMH, fromDisplay: (v) => v / KMH,
  },
  {
    key: 'acceleration',
    label: 'Acceleration',
    help: 'How quickly it gets back up to speed.',
    min: 2, max: 20, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'turnRate',
    label: 'Turn speed',
    help: 'How fast the nose swings at full steering.',
    min: 0.8, max: 4, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'turnResponse',
    label: 'Turn snappiness',
    help: 'Low feels heavy and lazy. High follows your thumb instantly.',
    min: 1, max: 20, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'grip',
    label: 'Grip',
    help: 'How hard you can corner before the rear lets go.',
    min: 0.4, max: 2, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'breakAngle',
    label: 'Slide starts at',
    help: 'How far the car must turn sideways before it breaks into a slide.',
    min: 2, max: 30, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'regripAngle',
    label: 'Grips again below',
    help: 'How straight the car must get before the tyres grip again. Keep it below "slide starts at".',
    min: 1, max: 20, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'slideFrictionLow',
    label: 'Slide hold, shallow',
    help: 'In a small slide. Low drifts wide and slippery; high tightens the line.',
    min: 0.1, max: 2, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'slideFrictionHigh',
    label: 'Slide hold, big angle',
    help: 'In a big sideways slide. Higher scrubs more speed and pulls the slide back in.',
    min: 0.3, max: 3, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'selfAlign',
    label: 'Straightens itself',
    help: 'How strongly the car straightens up when you lift your thumb.',
    min: 0, max: 8, step: 0.1, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'turnInSpeed',
    label: 'Low-speed turning',
    help: 'Below this speed the car turns less, so it cannot spin on the spot.',
    min: 5, max: 60, step: 1, unit: 'km/h',
    toDisplay: (v) => v * KMH, fromDisplay: (v) => v / KMH,
  },
];

/** The game's help, per mode. Shared by every car. */
export const ASSIST_SPECS: TuneSpec<keyof AssistParams>[] = [
  {
    key: 'cornerSpeed',
    label: 'Slowing for corners',
    help: 'How fast the car lets itself take a corner, compared with what grip allows. Lower slows down more. 0 turns it off.',
    min: 0, max: 2, step: 0.05, unit: '×',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'cornerBraking',
    label: 'Corner braking strength',
    help: 'How hard the car can brake by itself before a corner.',
    min: 0, max: 20, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'steerDrag',
    label: 'Speed lost when steering',
    help: 'How much speed steering costs, at full steering.',
    min: 0, max: 15, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'slideDrag',
    label: 'Speed lost when sliding',
    help: 'How much speed a big sideways slide costs.',
    min: 0, max: 25, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'roadKeeping',
    label: 'Road-keeping help',
    help: 'How firmly the car is kept on the road while you steer the right way. It never helps if you do not steer.',
    min: 0, max: 2, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'maxSlideAngle',
    label: 'Biggest slide allowed',
    help: 'Past this angle the car pulls itself straighter.',
    min: 5, max: 90, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'gripScale',
    label: 'Grip, this mode',
    help: "Multiplies every car's grip in this mode. Lower lets the rear come round more easily.",
    min: 0.3, max: 2.5, step: 0.05, unit: '×',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'slideHoldScale',
    label: 'Slide hold, this mode',
    help: "Multiplies every car's slide hold in this mode. Higher closes slides sooner.",
    min: 0.3, max: 3, step: 0.05, unit: '×',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'throttlePulse',
    label: 'Throttle pulsing in slides',
    help: 'How much the throttle comes and goes in a slide, like a driver working the pedal.',
    min: 0, max: 1, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
];

/** Drift Run with throttle controls. Shared by every car. */
export const DRIFT_SPECS: TuneSpec<keyof DriftControlParams>[] = [
  {
    key: 'limitAngle',
    label: 'Limit angle',
    help: 'Past this the slide runs away towards a spin. The sweet spot sits just under it.',
    min: 20, max: 80, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'holdAngle',
    label: 'Angle at full throttle',
    help: 'The angle flat-out throttle would hold. Higher means less throttle is needed for the same angle.',
    min: 20, max: 120, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'angleRate',
    label: 'Angle response',
    help: 'How quickly the angle follows the throttle. Higher is livelier and harder to balance.',
    min: 0.5, max: 6, step: 0.1, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'runaway',
    label: 'Runaway past the limit',
    help: 'How fast the slide feeds itself once past the limit. Higher punishes going over sooner.',
    min: 0, max: 10, step: 0.25, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'spinAngle',
    label: 'Spins at',
    help: 'The angle at which the car has spun.',
    min: 40, max: 110, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'flickAngle',
    label: 'Flick angle',
    help: 'How far the drift button throws the car sideways.',
    min: 5, max: 60, step: 1, unit: '°',
    toDisplay: (v) => v * DEG, fromDisplay: (v) => v / DEG,
  },
  {
    key: 'flickTime',
    label: 'Flick time',
    help: 'How long the flick takes, swing the other way included.',
    min: 0.1, max: 1, step: 0.05, unit: 's',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'driftGrip',
    label: 'Grip while sideways',
    help: 'How tightly the car can follow the road in a drift. Lower runs wider and slower.',
    min: 0.5, max: 3, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'angleWidening',
    label: 'Big angle runs wide',
    help: 'How far a big angle pushes the line to the outside, towards the wall.',
    min: 0, max: 1.2, step: 0.05, unit: '',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'angleDrag',
    label: 'Speed lost to angle',
    help: 'How much speed a big angle costs.',
    min: 0, max: 15, step: 0.5, unit: '',
    toDisplay: same, fromDisplay: same,
  },
];

/** How the throttle builds and falls on a phone. */
export const THROTTLE_SPECS: TuneSpec<keyof typeof THROTTLE_FEEL>[] = [
  {
    key: 'rise',
    label: 'Throttle build-up',
    help: 'Seconds from closed to flat out while you hold. Longer makes fine control easier.',
    min: 0.05, max: 1.5, step: 0.05, unit: 's',
    toDisplay: same, fromDisplay: same,
  },
  {
    key: 'fall',
    label: 'Throttle fall-off',
    help: 'Seconds from flat out to closed when you let go.',
    min: 0.05, max: 1.5, step: 0.05, unit: 's',
    toDisplay: same, fromDisplay: same,
  },
];

type Overrides = Record<string, Record<string, number>>;

/** The shipped handling for every car, captured before any overrides are applied. */
const DEFAULTS: Record<string, HandlingParams> = {};
for (const car of CARS) DEFAULTS[car.id] = { ...car.handling };

/** The shipped help for each mode, likewise. */
const ASSIST_DEFAULTS = {
  timeAttack: { ...MODE_ASSIST.timeAttack },
  driftRun: { ...MODE_ASSIST.driftRun },
} satisfies Record<SimMode, AssistParams>;

const DRIFT_DEFAULTS = { ...DRIFT_CONTROL };
const THROTTLE_DEFAULTS = { ...THROTTLE_FEEL };
const DRIFT_KEY = 'driftControls';
const THROTTLE_KEY = 'throttleFeel';

/** Copy numeric overrides for the listed keys onto a target object. */
function applyTo<K extends string>(target: Record<K, number>, stored: Record<string, number> | undefined, keys: K[]): void {
  if (!stored) return;
  for (const key of keys) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v)) target[key] = v;
  }
}

function store(key: string, field: string, value: number): void {
  const overrides = readOverrides();
  overrides[key] = { ...(overrides[key] ?? {}), [field]: value };
  writeOverrides(overrides);
}

export function setDriftControl(key: keyof DriftControlParams, value: number): void {
  DRIFT_CONTROL[key] = value;
  store(DRIFT_KEY, key, value);
}

export function setThrottleFeel(key: keyof typeof THROTTLE_FEEL, value: number): void {
  THROTTLE_FEEL[key] = value;
  store(THROTTLE_KEY, key, value);
}

const MODES: SimMode[] = ['timeAttack', 'driftRun'];
const assistKey = (mode: SimMode) => `mode:${mode}`;

function readOverrides(): Overrides {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Overrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Not remembered; the values still apply for this session.
  }
}

/** Apply stored tuning to every car and mode. */
export function applyStoredTuning(): void {
  const overrides = readOverrides();
  for (const car of CARS) {
    const o = overrides[car.id] as Partial<HandlingParams> | undefined;
    if (!o) continue;
    for (const spec of TUNE_SPECS) {
      const v = o[spec.key];
      if (typeof v === 'number' && Number.isFinite(v)) car.handling[spec.key] = v;
    }
  }
  for (const mode of MODES) {
    const o = overrides[assistKey(mode)] as Partial<AssistParams> | undefined;
    if (!o) continue;
    for (const spec of ASSIST_SPECS) {
      const v = o[spec.key];
      if (typeof v === 'number' && Number.isFinite(v)) MODE_ASSIST[mode][spec.key] = v;
    }
  }
  applyTo(DRIFT_CONTROL, overrides[DRIFT_KEY], DRIFT_SPECS.map((s) => s.key));
  applyTo(THROTTLE_FEEL, overrides[THROTTLE_KEY], THROTTLE_SPECS.map((s) => s.key));
}

/** Change one help value for a mode, live, for every car. */
export function setAssist(mode: SimMode, key: keyof AssistParams, value: number): void {
  MODE_ASSIST[mode][key] = value;
  const overrides = readOverrides();
  overrides[assistKey(mode)] = { ...(overrides[assistKey(mode)] ?? {}), [key]: value };
  writeOverrides(overrides);
}

/**
 * Change one handling value on a car, live.
 *
 * The car object is mutated in place, and the sim reads it every tick, so the
 * change takes effect on the very next step of a run already in progress.
 */
export function setHandling(car: CarParams, key: keyof HandlingParams, value: number): void {
  car.handling[key] = value;
  const overrides = readOverrides();
  overrides[car.id] = { ...(overrides[car.id] ?? {}), [key]: value };
  writeOverrides(overrides);
}

/** Put every car and mode back on shipped values, keeping the stored tuning for next time. */
export function restoreShippedHandling(): void {
  for (const car of CARS) {
    const shipped = DEFAULTS[car.id];
    if (shipped) Object.assign(car.handling, shipped);
  }
  for (const mode of MODES) Object.assign(MODE_ASSIST[mode], ASSIST_DEFAULTS[mode]);
  Object.assign(DRIFT_CONTROL, DRIFT_DEFAULTS);
  Object.assign(THROTTLE_FEEL, THROTTLE_DEFAULTS);
}

/** Forget the tuning for this car and this mode's help. */
export function resetTuning(car: CarParams, mode: SimMode): void {
  const shipped = DEFAULTS[car.id];
  if (shipped) Object.assign(car.handling, shipped);
  Object.assign(MODE_ASSIST[mode], ASSIST_DEFAULTS[mode]);
  const overrides = readOverrides();
  delete overrides[car.id];
  delete overrides[assistKey(mode)];
  if (mode === 'driftRun') {
    Object.assign(DRIFT_CONTROL, DRIFT_DEFAULTS);
    Object.assign(THROTTLE_FEEL, THROTTLE_DEFAULTS);
    delete overrides[DRIFT_KEY];
    delete overrides[THROTTLE_KEY];
  }
  writeOverrides(overrides);
}

export function isTuned(car: CarParams): boolean {
  const shipped = DEFAULTS[car.id];
  if (!shipped) return false;
  return TUNE_SPECS.some((spec) => Math.abs(car.handling[spec.key] - shipped[spec.key]) > 1e-9);
}

/** A block of text a player can paste back into a chat to make these the defaults. */
export function describeTuning(
  car: CarParams,
  mode: SimMode,
  controls: string,
  steerSensitivity: number,
): string {
  const round = (v: number) => Number(v.toFixed(3));
  const handling: Record<string, number> = {};
  for (const spec of TUNE_SPECS) handling[spec.key] = round(car.handling[spec.key]);
  const assist: Record<string, number> = {};
  for (const spec of ASSIST_SPECS) assist[spec.key] = round(MODE_ASSIST[mode][spec.key]);
  const out: Record<string, unknown> = { car: car.id, mode, controls, steerSensitivity: round(steerSensitivity), handling, assist };
  if (controls === 'throttle') {
    const drift: Record<string, number> = {};
    for (const spec of DRIFT_SPECS) drift[spec.key] = round(DRIFT_CONTROL[spec.key]);
    out.driftControls = drift;
    out.throttleFeel = { rise: round(THROTTLE_FEEL.rise), fall: round(THROTTLE_FEEL.fall) };
  }
  return JSON.stringify(out, null, 2);
}
