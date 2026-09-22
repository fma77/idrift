import { DEFAULT_KEYMAP, type Keymap } from '../input/input.ts';
import { MAX_SENSITIVITY, MIN_SENSITIVITY } from '../input/thumbSteer.ts';
import type { Controls } from '../sim/types.ts';

/**
 * Local persistence.
 *
 * Settings and progress are small and read synchronously at boot, so
 * localStorage is the right tool. Replays are not: those go to IndexedDB in
 * bests.ts, because a handful of them would blow through localStorage's quota
 * and the writes would block the main thread mid-run.
 *
 * Everything here is defensive. Storage can be unavailable (private browsing,
 * embedded webviews, a user who cleared site data) and the game must still be
 * fully playable -- the only thing lost is memory between sessions.
 */

const KEY = 'idrift.settings.v1';

export interface Settings {
  /**
   * Thumb slider sensitivity, 0.5..2. Higher means less thumb travel for full
   * steering. Presentation only: the sim sees the resulting steer value, so
   * this never needs to be in a run's header.
   */
  steerSensitivity: number;
  /** Disable camera rotation for players who find it nauseating. */
  fixedNorth: boolean;
  showSkidMarks: boolean;
  showSmoke: boolean;
  keymap: Keymap;
  playerName: string;
  carId: string;
  soundOn: boolean;
  /** Shows the TUNE button in runs. Runs driven with it on are not saved or posted. */
  tuneMode: boolean;
  /**
   * Drift Run controls: 'throttle' (the game steers; hold to drive, tap to
   * drift) or 'steer' (the one-thumb steering of Time Attack).
   */
  driftControls: Controls;
  /** Time Attack difficulty: easy (the car handles speed) or pro (pedals). */
  timeAttackLevel: 'easy' | 'pro';
}

export const DEFAULT_SETTINGS: Settings = {
  steerSensitivity: 1,
  fixedNorth: false,
  showSkidMarks: true,
  showSmoke: true,
  keymap: DEFAULT_KEYMAP,
  playerName: '',
  carId: 'kaido-zen-r',
  soundOn: true,
  tuneMode: false,
  driftControls: 'throttle',
  timeAttackLevel: 'easy',
};

export function loadSettings(): Settings {
  const defaults = (): Settings => ({ ...DEFAULT_SETTINGS, keymap: structuredClone(DEFAULT_KEYMAP) });
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
    const base = defaults();
    // Pick known fields over defaults rather than trusting the stored shape: a
    // settings object written by an older build is missing whatever was added
    // since, and still carries what was removed (the throttle assist, the
    // on-screen button layout, left-handed mode).
    const pick = <K extends keyof Settings>(key: K, valid: (v: unknown) => boolean): Settings[K] =>
      valid(parsed[key]) ? (parsed[key] as Settings[K]) : base[key];
    const keymap: Partial<Keymap> = parsed.keymap ?? {};
    return {
      steerSensitivity: Math.min(
        MAX_SENSITIVITY,
        Math.max(MIN_SENSITIVITY, pick('steerSensitivity', (v) => typeof v === 'number' && Number.isFinite(v))),
      ),
      fixedNorth: pick('fixedNorth', (v) => typeof v === 'boolean'),
      showSkidMarks: pick('showSkidMarks', (v) => typeof v === 'boolean'),
      showSmoke: pick('showSmoke', (v) => typeof v === 'boolean'),
      soundOn: pick('soundOn', (v) => typeof v === 'boolean'),
      tuneMode: pick('tuneMode', (v) => typeof v === 'boolean'),
      playerName: pick('playerName', (v) => typeof v === 'string'),
      carId: pick('carId', (v) => typeof v === 'string'),
      keymap: {
        left: Array.isArray(keymap.left) ? keymap.left : base.keymap.left,
        right: Array.isArray(keymap.right) ? keymap.right : base.keymap.right,
        throttle: Array.isArray(keymap.throttle) ? keymap.throttle : base.keymap.throttle,
        brake: Array.isArray(keymap.brake) ? keymap.brake : base.keymap.brake,
        drift: Array.isArray(keymap.drift) ? keymap.drift : base.keymap.drift,
      },
      driftControls: pick('driftControls', (v) => v === 'throttle' || v === 'steer'),
      timeAttackLevel: pick('timeAttackLevel', (v) => v === 'easy' || v === 'pro'),
    };
  } catch {
    return defaults();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Quota or a disabled store. Play continues; nothing is remembered.
  }
}
