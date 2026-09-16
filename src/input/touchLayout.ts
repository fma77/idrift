import type { Action } from './input.ts';

/**
 * On-screen touch buttons: where they go and which one a finger is on.
 *
 * Pure geometry, no DOM, so it can be tested headlessly. The buttons replaced
 * the original "drag anywhere in the lower half" relative joystick after
 * play-testing on a phone: it had too steep a learning curve for someone opening
 * a shared link cold, and ordinary buttons are what people already know.
 */

export type Orientation = 'portrait' | 'landscape';

/** A button's centre, as a fraction of the viewport (0..1 on each axis). */
export interface ButtonPosition {
  x: number;
  y: number;
}

export type ButtonLayout = Record<Action, ButtonPosition>;

export interface TouchLayout {
  portrait: ButtonLayout;
  landscape: ButtonLayout;
  /** Player's size preference, multiplied onto the base size. */
  scale: number;
}

/** Draw and hit-test order. Left thumb first, then right. */
export const TOUCH_ACTIONS: Action[] = ['left', 'right', 'brake', 'accelerate', 'handbrake'];

export const MIN_SCALE = 0.75;
export const MAX_SCALE = 1.5;

/**
 * Base button size as a fraction of the viewport's SHORT edge, clamped to a
 * pixel range.
 *
 * Fixed pixel sizes do not survive the spread of real phones: at a size that
 * suits a 412px-wide screen, the default layout overlaps itself on a 360px one.
 * Tying size to the short edge keeps the arrangement proportionate, and the
 * clamp stops tablets from getting dinner-plate buttons.
 */
const SIZE: Record<Action, { fraction: number; min: number; max: number }> = {
  left: { fraction: 0.19, min: 56, max: 96 },
  right: { fraction: 0.19, min: 56, max: 96 },
  brake: { fraction: 0.19, min: 56, max: 96 },
  // The pedal you hold most of the time gets the biggest target.
  accelerate: { fraction: 0.24, min: 64, max: 120 },
  handbrake: { fraction: 0.18, min: 56, max: 90 },
};

/**
 * Defaults: steering under the left thumb, pedals under the right, handbrake
 * above the throttle where the right thumb can rock onto it mid-corner.
 *
 * Checked by tests/touch.test.mjs against a spread of real phone and tablet
 * sizes in both orientations -- no two buttons may overlap and none may sit in
 * the screen-edge gutter.
 */
export function defaultLayout(): TouchLayout {
  return {
    portrait: {
      left: { x: 0.14, y: 0.87 },
      right: { x: 0.36, y: 0.87 },
      brake: { x: 0.6, y: 0.89 },
      accelerate: { x: 0.84, y: 0.87 },
      handbrake: { x: 0.84, y: 0.74 },
    },
    landscape: {
      left: { x: 0.09, y: 0.78 },
      right: { x: 0.22, y: 0.78 },
      brake: { x: 0.78, y: 0.84 },
      accelerate: { x: 0.91, y: 0.8 },
      handbrake: { x: 0.91, y: 0.52 },
    },
    scale: 1,
  };
}

export function orientationOf(width: number, height: number): Orientation {
  return width > height ? 'landscape' : 'portrait';
}

/** Side length in CSS pixels of a (square) button at this viewport and scale. */
export function buttonSize(action: Action, width: number, height: number, scale: number): number {
  const spec = SIZE[action];
  const base = Math.min(Math.max(Math.min(width, height) * spec.fraction, spec.min), spec.max);
  return Math.round(base * clampScale(scale));
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** Left-handed play mirrors the whole arrangement across the vertical centreline. */
export function mirror(position: ButtonPosition): ButtonPosition {
  return { x: 1 - position.x, y: position.y };
}

/**
 * Pull a button centre back so the whole button stays on screen with a margin.
 * Returns fractional coordinates, ready to store.
 */
export function clampCentre(
  position: ButtonPosition,
  size: number,
  width: number,
  height: number,
  margin: number,
): ButtonPosition {
  const half = size / 2 + margin;
  const px = Math.min(Math.max(position.x * width, half), Math.max(half, width - half));
  const py = Math.min(Math.max(position.y * height, half), Math.max(half, height - half));
  return { x: width > 0 ? px / width : 0.5, y: height > 0 ? py / height : 0.5 };
}

/**
 * Accept whatever came out of storage and return a complete, valid layout.
 *
 * Settings saved by an older build will not have a touch layout at all, and a
 * hand-edited or half-written value could have any shape. Anything missing or
 * out of range falls back to the default for that one button, rather than
 * throwing the player's whole arrangement away.
 */
export function normaliseLayout(stored: unknown): TouchLayout {
  const defaults = defaultLayout();
  if (!stored || typeof stored !== 'object') return defaults;
  const s = stored as Partial<Record<keyof TouchLayout, unknown>>;

  const readOrientation = (value: unknown, fallback: ButtonLayout): ButtonLayout => {
    const result = {} as ButtonLayout;
    const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    for (const action of TOUCH_ACTIONS) {
      const p = source[action] as Partial<ButtonPosition> | undefined;
      const valid =
        p &&
        typeof p.x === 'number' &&
        typeof p.y === 'number' &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y);
      result[action] = valid
        ? { x: Math.min(Math.max(p.x as number, 0), 1), y: Math.min(Math.max(p.y as number, 0), 1) }
        : { ...fallback[action] };
    }
    return result;
  };

  return {
    portrait: readOrientation(s.portrait, defaults.portrait),
    landscape: readOrientation(s.landscape, defaults.landscape),
    scale: typeof s.scale === 'number' ? clampScale(s.scale) : 1,
  };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which button, if any, a finger at (x, y) is pressing.
 *
 * A thumb does not land where it aims, so each button accepts touches within
 * `slop` pixels of its edge. When that makes two buttons eligible -- the gap
 * between the steering arrows is smaller than a thumb -- the nearer one wins,
 * rather than whichever happens to come first in the list.
 */
export function actionAt(
  x: number,
  y: number,
  rects: Partial<Record<Action, Rect>>,
  slop: number,
): Action | null {
  let best: Action | null = null;
  let bestDistance = Infinity;
  for (const action of TOUCH_ACTIONS) {
    const r = rects[action];
    if (!r) continue;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= slop && distance < bestDistance) {
      best = action;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Every action currently held, across all fingers on the screen.
 *
 * Multi-touch is the whole point of buttons in a driving game: throttle,
 * handbrake and steering are routinely held at once.
 */
export function resolvePressed(
  points: Iterable<{ x: number; y: number }>,
  rects: Partial<Record<Action, Rect>>,
  slop: number,
): Set<Action> {
  const pressed = new Set<Action>();
  for (const p of points) {
    const action = actionAt(p.x, p.y, rects, slop);
    if (action) pressed.add(action);
  }
  return pressed;
}
