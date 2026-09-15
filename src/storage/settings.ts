import { DEFAULT_KEYMAP, type Keymap } from '../input/input.ts';

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
   * 0..1. Feeds the physics directly, not a difficulty flag. Defaults to 0.6,
   * which the brief pitches at new players: enough automatic throttle to hold a
   * slide, still enough manual authority to matter.
   */
  assist: number;
  /** Mirror the whole control layout for left-handed play. */
  lefty: boolean;
  /** Disable camera rotation for players who find it nauseating. */
  fixedNorth: boolean;
  showSkidMarks: boolean;
  keymap: Keymap;
  playerName: string;
  carId: string;
  soundOn: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  assist: 0.6,
  lefty: false,
  fixedNorth: false,
  showSkidMarks: true,
  keymap: DEFAULT_KEYMAP,
  playerName: '',
  carId: 'kaido-zen-r',
  soundOn: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge over defaults rather than trusting the stored shape: a settings
    // object written by an older build is missing whatever was added since.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keymap: { ...DEFAULT_KEYMAP, ...(parsed.keymap ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Quota or a disabled store. Play continues; nothing is remembered.
  }
}
