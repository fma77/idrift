import { CARS } from '../data/cars.ts';
import type { CarParams, HandlingParams } from '../sim/types.ts';

/**
 * Hand-tuning the handling on a phone.
 *
 * Feel is the whole point of the arcade model, and feel cannot be judged from
 * telemetry. Tuning mode lets a player change every handling number mid-run and
 * drive straight back into the corner that felt wrong, then copy the values out
 * so they can become the defaults.
 *
 * Opened with #tune on the URL. Tuned values are kept on this device only, and
 * nothing driven in tuning mode is saved as a best or posted to a leaderboard:
 * a time set with hand-edited grip is not comparable with anyone else's.
 */

const STORAGE_KEY = 'idrift.tune.v1';

export function isTuneMode(): boolean {
  return location.hash === '#tune';
}

export interface TuneSpec {
  key: keyof HandlingParams;
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

type Overrides = Record<string, Partial<HandlingParams>>;

/** The shipped handling for every car, captured before any overrides are applied. */
const DEFAULTS: Record<string, HandlingParams> = {};
for (const car of CARS) DEFAULTS[car.id] = { ...car.handling };

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

/** Apply stored tuning to every car. Call once at boot, in tuning mode only. */
export function applyStoredTuning(): void {
  const overrides = readOverrides();
  for (const car of CARS) {
    const o = overrides[car.id];
    if (!o) continue;
    for (const spec of TUNE_SPECS) {
      const v = o[spec.key];
      if (typeof v === 'number' && Number.isFinite(v)) car.handling[spec.key] = v;
    }
  }
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

export function resetHandling(car: CarParams): void {
  const shipped = DEFAULTS[car.id];
  if (shipped) Object.assign(car.handling, shipped);
  const overrides = readOverrides();
  delete overrides[car.id];
  writeOverrides(overrides);
}

export function isTuned(car: CarParams): boolean {
  const shipped = DEFAULTS[car.id];
  if (!shipped) return false;
  return TUNE_SPECS.some((spec) => Math.abs(car.handling[spec.key] - shipped[spec.key]) > 1e-9);
}

/** A block of text a player can paste back into a chat to make these the defaults. */
export function describeTuning(car: CarParams, steerSensitivity: number): string {
  const round = (v: number) => Number(v.toFixed(3));
  const handling: Record<string, number> = {};
  for (const spec of TUNE_SPECS) handling[spec.key] = round(car.handling[spec.key]);
  return JSON.stringify({ car: car.id, steerSensitivity: round(steerSensitivity), handling }, null, 2);
}
