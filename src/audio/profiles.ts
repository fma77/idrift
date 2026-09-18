import type { EngineKind } from '../sim/types.ts';

/**
 * The four engines, as numbers.
 *
 * Each engine is two sets of numbers. The mechanical side (EngineSpec) says how
 * the revs behave: idle, redline, gears, how fast it revs, whether it has a
 * turbo. The voice (VoiceParams) says what a firing sounds like and what the
 * engine's signature noises are. The synth itself (engineSynth.ts) has no idea
 * which engine it is playing -- every difference between a rotary and a flat
 * four lives here.
 */

export interface EngineSpec {
  idleRpm: number;
  redlineRpm: number;
  /** Where the fuel cut bounces the revs. */
  limiterRpm: number;
  gears: number;
  /** rpm per second the engine can gain revving freely, and lose off the throttle. */
  revRise: number;
  revFall: number;
  /** 1/s. How fast the turbo spools. 0 = no turbo. */
  spool: number;
  /** Fraction of redline below which the turbo makes no boost. */
  boostThreshold: number;
}

export interface VoiceParams {
  /** Firing pulses per crank revolution: 2 for a four or a two-rotor, 3 for a six. */
  firesPerRev: number;
  /**
   * Spacing of the firings through one cycle, as multiples of the even
   * interval. Even engines are all 1s. The flat four's unequal-length headers
   * bunch its exhaust pulses, which is where the burble comes from.
   */
  pattern: number[];
  /** Relative loudness of each firing in the cycle. */
  levels: number[];
  /** Hz. The body of each exhaust pulse -- low is deep, high is rasp. */
  resonance: number;
  /** How much the pulse body rises with revs, 0..1. */
  resonanceTrack: number;
  /** Seconds. How long each pulse rings. Short is crisp, long is boomy. */
  pulseDecay: number;
  /** 0..1. Noise mixed into each pulse: raspiness. */
  rasp: number;
  /** 0..1. Random variation between firings. */
  jitter: number;
  /** 0..1. The rotary's lumpy idle: firings bunch into groups at low revs. */
  lope: number;
  /** Hz. How often the groups come round at idle. */
  lopeHz: number;
  /** 0..1. Induction noise under load: the intake howl of a high-revving NA. */
  intake: number;
  /** 0..1. Turbo whistle while on boost. */
  whistle: number;
  /** Hz. Whistle pitch at full boost. */
  whistleHz: number;
  /** 0..1. The "stu-tu-tu" of air fluttering back through the turbo on lift-off. */
  flutter: number;
  /** Hz. Flutter rate as it starts; it slows as it dies away. */
  flutterHz: number;
  /** 0..1. Pops and crackles on the overrun. */
  pops: number;
  /** 1..6. Saturation: how hard the exhaust note is driven. */
  drive: number;
  /** Overall level. */
  gain: number;
}

export interface EngineProfile {
  kind: EngineKind;
  /** Shown in the sound lab. Descriptive, not a make or model. */
  label: string;
  spec: EngineSpec;
  voice: VoiceParams;
}

export const PROFILES: Record<EngineKind, EngineProfile> = {
  na4: {
    kind: 'na4',
    label: 'High-revving NA four',
    spec: {
      idleRpm: 900,
      redlineRpm: 7800,
      limiterRpm: 8100,
      gears: 5,
      revRise: 14000,
      revFall: 9000,
      spool: 0,
      boostThreshold: 1,
    },
    // Thin and rasping low down, opening into a howl: the pulse body rises
    // steeply with revs, and the intake noise is loud.
    voice: {
      firesPerRev: 2,
      pattern: [1, 1, 1, 1],
      levels: [1, 0.94, 0.98, 0.92],
      resonance: 420,
      resonanceTrack: 0.9,
      pulseDecay: 0.0045,
      rasp: 0.45,
      jitter: 0.12,
      lope: 0,
      lopeHz: 3,
      intake: 0.55,
      whistle: 0,
      whistleHz: 5000,
      flutter: 0,
      flutterHz: 15,
      pops: 0.2,
      drive: 2.6,
      gain: 0.9,
    },
  },
  rotary: {
    kind: 'rotary',
    label: 'Two-rotor rotary',
    spec: {
      idleRpm: 950,
      redlineRpm: 8500,
      limiterRpm: 9000,
      gears: 5,
      revRise: 16000,
      revFall: 11000,
      spool: 0,
      boostThreshold: 1,
    },
    // Buzzy and high, with the brap-brap idle: firings bunch into groups a few
    // times a second at low revs, and it pops hard on the overrun.
    voice: {
      firesPerRev: 2,
      pattern: [1, 1],
      levels: [1, 0.9],
      resonance: 560,
      resonanceTrack: 0.6,
      pulseDecay: 0.0035,
      rasp: 0.7,
      jitter: 0.3,
      lope: 0.9,
      lopeHz: 3.4,
      intake: 0.2,
      whistle: 0,
      whistleHz: 5000,
      flutter: 0,
      flutterHz: 15,
      pops: 0.9,
      drive: 3.4,
      gain: 1.2,
    },
  },
  turbo6: {
    kind: 'turbo6',
    label: 'Turbo straight six',
    spec: {
      idleRpm: 850,
      redlineRpm: 7600,
      limiterRpm: 8000,
      gears: 6,
      revRise: 11000,
      revFall: 8000,
      spool: 2.2,
      boostThreshold: 0.35,
    },
    // Smooth and deeper: three even firings a revolution, little variation. The
    // character is the turbo -- whistle on boost, flutter on lift-off.
    voice: {
      firesPerRev: 3,
      pattern: [1, 1, 1, 1, 1, 1],
      levels: [1, 0.97, 0.99, 0.96, 1, 0.97],
      resonance: 300,
      resonanceTrack: 0.65,
      pulseDecay: 0.006,
      rasp: 0.25,
      jitter: 0.06,
      lope: 0,
      lopeHz: 3,
      intake: 0.25,
      whistle: 0.8,
      whistleHz: 5400,
      flutter: 1,
      flutterHz: 17,
      pops: 0.3,
      drive: 2.2,
      gain: 0.95,
    },
  },
  boxer4: {
    kind: 'boxer4',
    label: 'Turbo flat four',
    spec: {
      idleRpm: 800,
      redlineRpm: 7200,
      limiterRpm: 7600,
      gears: 5,
      revRise: 11000,
      revFall: 7500,
      spool: 1.8,
      boostThreshold: 0.4,
    },
    // Deep and uneven: unequal-length headers bunch the exhaust pulses in
    // pairs, which gives the off-beat burble. A milder turbo than the six.
    voice: {
      firesPerRev: 2,
      pattern: [1.22, 0.78, 1.16, 0.84],
      levels: [1, 0.6, 0.92, 0.66],
      resonance: 230,
      resonanceTrack: 0.5,
      pulseDecay: 0.008,
      rasp: 0.3,
      jitter: 0.1,
      lope: 0.15,
      lopeHz: 2.2,
      intake: 0.2,
      whistle: 0.4,
      whistleHz: 4600,
      flutter: 0.45,
      flutterHz: 13,
      pops: 0.45,
      drive: 2.8,
      gain: 1,
    },
  },
};

export const ENGINE_KINDS: EngineKind[] = ['na4', 'rotary', 'turbo6', 'boxer4'];

/** The voice numbers the sound lab exposes as sliders. */
export interface VoiceSpec {
  key: keyof VoiceParams;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

export const VOICE_SPECS: VoiceSpec[] = [
  { key: 'resonance', label: 'Pitch of the note', help: 'Low is deep and boomy, high is thin and rasping.', min: 120, max: 900, step: 10 },
  { key: 'resonanceTrack', label: 'Pitch rise with revs', help: 'How much the note climbs as the revs go up. High gives a howl.', min: 0, max: 1.5, step: 0.05 },
  { key: 'pulseDecay', label: 'Pulse length', help: 'Short is crisp and tight, long is boomy.', min: 0.001, max: 0.02, step: 0.0005 },
  { key: 'rasp', label: 'Rasp', help: 'Grit in every firing.', min: 0, max: 1, step: 0.05 },
  { key: 'drive', label: 'Exhaust drive', help: 'How hard the note is pushed. High is angrier.', min: 1, max: 6, step: 0.1 },
  { key: 'jitter', label: 'Roughness', help: 'Variation between firings. Zero is perfectly smooth.', min: 0, max: 0.6, step: 0.02 },
  { key: 'lope', label: 'Idle lope', help: 'The rotary brap: firings bunched into groups at low revs.', min: 0, max: 1, step: 0.05 },
  { key: 'lopeHz', label: 'Lope speed', help: 'How many groups a second at idle.', min: 1, max: 8, step: 0.1 },
  { key: 'intake', label: 'Intake howl', help: 'Induction noise under load.', min: 0, max: 1, step: 0.05 },
  { key: 'whistle', label: 'Turbo whistle', help: 'Whistle on boost.', min: 0, max: 1, step: 0.05 },
  { key: 'flutter', label: 'Turbo flutter', help: 'The stu-tu-tu on lift-off.', min: 0, max: 1.5, step: 0.05 },
  { key: 'flutterHz', label: 'Flutter speed', help: 'How fast the flutter chatters.', min: 6, max: 30, step: 0.5 },
  { key: 'pops', label: 'Pops and crackles', help: 'On the overrun, off the throttle.', min: 0, max: 1.5, step: 0.05 },
  { key: 'gain', label: 'Volume', help: 'This engine only.', min: 0.2, max: 2, step: 0.05 },
];

// --- Local overrides from the sound lab ----------------------------------------

const STORAGE_KEY = 'idrift.sound.v1';
const SHIPPED: Record<EngineKind, VoiceParams> = {
  na4: { ...PROFILES.na4.voice },
  rotary: { ...PROFILES.rotary.voice },
  turbo6: { ...PROFILES.turbo6.voice },
  boxer4: { ...PROFILES.boxer4.voice },
};

type Overrides = Partial<Record<EngineKind, Partial<Record<keyof VoiceParams, number>>>>;

function read(): Overrides {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

function write(o: Overrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
  } catch {
    // Not remembered; applies for this session.
  }
}

/**
 * Apply what was changed in the sound lab. Sound never touches the sim, so
 * unlike handling tuning this applies whether or not tuning mode is on.
 */
export function applySoundOverrides(): void {
  const o = read();
  for (const kind of ENGINE_KINDS) {
    const stored = o[kind];
    if (!stored) continue;
    for (const spec of VOICE_SPECS) {
      const v = stored[spec.key];
      if (typeof v === 'number' && Number.isFinite(v)) (PROFILES[kind].voice[spec.key] as number) = v;
    }
  }
}

export function setVoice(kind: EngineKind, key: keyof VoiceParams, value: number): void {
  (PROFILES[kind].voice[key] as number) = value;
  const o = read();
  o[kind] = { ...(o[kind] ?? {}), [key]: value };
  write(o);
}

export function resetVoice(kind: EngineKind): void {
  PROFILES[kind].voice = { ...SHIPPED[kind] };
  const o = read();
  delete o[kind];
  write(o);
}

export function describeVoice(kind: EngineKind): string {
  const out: Record<string, number> = {};
  for (const spec of VOICE_SPECS) out[spec.key] = Number((PROFILES[kind].voice[spec.key] as number).toFixed(4));
  return JSON.stringify({ engine: kind, voice: out }, null, 2);
}
