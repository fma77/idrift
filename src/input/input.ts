/**
 * Input.
 *
 * Keys and on-screen buttons both write into one mutable "current input" struct, which
 * the game loop samples once per sim tick. Events are never queued and consumed
 * inside the sim: a tick must see a snapshot of the controls, not a replay of
 * everything that happened since the last one, or the sim's output would depend
 * on browser event timing and stop being reproducible.
 */

export interface RawInput {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** -1 (full brake) .. +1 (full throttle). */
  throttle: number;
  handbrake: boolean;
}

export type Action = 'left' | 'right' | 'accelerate' | 'brake' | 'handbrake';

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'left', label: 'Steer left' },
  { id: 'right', label: 'Steer right' },
  { id: 'accelerate', label: 'Accelerate' },
  { id: 'brake', label: 'Brake / reverse' },
  { id: 'handbrake', label: 'Handbrake' },
];

export type Keymap = Record<Action, string[]>;

export const DEFAULT_KEYMAP: Keymap = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  accelerate: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'],
};

/** Seconds from neutral to full lock, and back to neutral. */
const STEER_ATTACK = 0.22;
const STEER_RELEASE = 0.12;

export class InputController {
  readonly raw: RawInput = { steer: 0, throttle: 0, handbrake: false };

  private keymap: Keymap = DEFAULT_KEYMAP;
  /** Physical keys currently held, by KeyboardEvent.code. */
  private held = new Set<string>();
  /**
   * Actions held through the on-screen touch buttons.
   *
   * These are treated exactly like held keys. Touch and keyboard therefore
   * share one input path -- the same steering ramp, the same throttle mapping
   * -- so a run cannot behave differently depending on which a player used, and
   * the replay format needs no idea that touch exists.
   */
  private virtual = new Set<Action>();

  private enabled = false;
  private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => this.releaseAll();

  setKeymap(map: Keymap): void {
    this.keymap = map;
  }

  /** Press or release an action from an on-screen button. */
  setVirtual(action: Action, down: boolean): void {
    if (down) this.virtual.add(action);
    else this.virtual.delete(action);
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('blur', this.boundBlur);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('blur', this.boundBlur);
    this.releaseAll();
  }

  releaseAll(): void {
    this.held.clear();
    this.virtual.clear();
    this.raw.steer = 0;
    this.raw.throttle = 0;
    this.raw.handbrake = false;
  }

  /**
   * Fold held keys and buttons into the analogue struct.
   *
   * Called once per rendered frame, not per sim tick: this is the only part of
   * input handling that depends on wall-clock time, and it is deliberately
   * outside the sim. A key or a button is a binary signal and the car needs a
   * continuous one, so steering ramps rather than stepping -- without it, full
   * lock would arrive in a single frame and every tap would be a flick.
   */
  update(dtSeconds: number): void {
    const left = this.isDown('left');
    const right = this.isDown('right');
    const target = (right ? 1 : 0) - (left ? 1 : 0);

    const rate = target === 0 ? 1 / STEER_RELEASE : 1 / STEER_ATTACK;
    const step = rate * dtSeconds;
    const d = target - this.raw.steer;
    this.raw.steer = Math.abs(d) <= step ? target : this.raw.steer + Math.sign(d) * step;

    const up = this.isDown('accelerate');
    const down = this.isDown('brake');
    this.raw.throttle = (up ? 1 : 0) - (down ? 1 : 0);
    this.raw.handbrake = this.isDown('handbrake');
  }

  /** True if the action is held on the keyboard or on screen. */
  isDown(action: Action): boolean {
    if (this.virtual.has(action)) return true;
    const codes = this.keymap[action];
    for (let i = 0; i < codes.length; i++) {
      if (this.held.has(codes[i])) return true;
    }
    return false;
  }

  /** Whether a key code is bound to any action. */
  isBound(code: string): boolean {
    for (let i = 0; i < ACTIONS.length; i++) {
      if (this.keymap[ACTIONS[i].id].includes(code)) return true;
    }
    return false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (this.isBound(e.code)) {
      e.preventDefault();
      this.held.add(e.code);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.isBound(e.code)) {
      e.preventDefault();
      this.held.delete(e.code);
    }
  }
}

/** Human-readable key name for the rebinding UI. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)] ?? code;
  if (code === 'Space') return 'SPACE';
  if (code.startsWith('Shift')) return 'SHIFT';
  if (code.startsWith('Control')) return 'CTRL';
  if (code.startsWith('Alt')) return 'ALT';
  return code.toUpperCase();
}
