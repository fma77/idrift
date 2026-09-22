/**
 * Input.
 *
 * Keys and the thumb slider both write into one mutable "current input" struct,
 * which the game loop samples once per sim tick. Events are never queued and
 * consumed inside the sim: a tick must see a snapshot of the controls, not a
 * replay of everything that happened since the last one, or the sim's output
 * would depend on browser event timing and stop being reproducible.
 *
 * Three control schemes feed it. Steering: the car drives itself and the player
 * steers. Throttle (Drift Run only): the game steers, the player holds a
 * throttle and taps to drift. Pedals (Time Attack Pro): the player steers and
 * works the throttle and brake.
 */

export interface RawInput {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** 0..1. Builds while the throttle is held and falls away when it is not. */
  throttle: number;
  /** The drift button, held. A press shorter than a sample is latched until recorded. */
  initiate: boolean;
  /** The brake is held. Pedals only. */
  brake: boolean;
}

export type Action = 'left' | 'right' | 'throttle' | 'brake' | 'drift';

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'left', label: 'Steer left' },
  { id: 'right', label: 'Steer right' },
  { id: 'throttle', label: 'Throttle (Drift Run, Pro)' },
  { id: 'brake', label: 'Brake (Time Attack Pro)' },
  { id: 'drift', label: 'Drift (Drift Run)' },
];

export type Keymap = Record<Action, string[]>;

export const DEFAULT_KEYMAP: Keymap = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  drift: ['Space'],
};

/**
 * Seconds for the throttle to go from closed to flat out while held, and back
 * while released. Phones cannot tell how hard a thumb presses, so partial
 * throttle comes from holding and letting go -- these set how finely that can
 * be done. Mutable: tuning mode edits it live.
 */
export const THROTTLE_FEEL = { rise: 0.45, fall: 0.3 };

/** Seconds from neutral to full steering on a key, and back to neutral. */
const STEER_ATTACK = 0.18;
const STEER_RELEASE = 0.1;

export class InputController {
  readonly raw: RawInput = { steer: 0, throttle: 0, initiate: false, brake: false };
  /** Whether the drift button is physically down right now. */
  private driftDown = false;

  private keymap: Keymap = DEFAULT_KEYMAP;
  /** Physical keys currently held, by KeyboardEvent.code. */
  private held: string[] = [];
  /**
   * The thumb slider's position, or null while no finger is down.
   *
   * Already analogue, so it is used as-is rather than ramped: the thumb is the
   * smoothing. Keys are binary and still ramp, or every tap would be a flick.
   */
  private touchSteer: number | null = null;
  /** The throttle zone is being held. */
  private touchThrottle = false;
  /** The brake pedal is being held (Time Attack Pro). */
  private touchBrake = false;

  private enabled = false;
  private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => this.releaseAll();

  setKeymap(map: Keymap): void {
    // Older saved keymaps predate the brake; fill in anything missing.
    this.keymap = { ...DEFAULT_KEYMAP, ...map };
  }

  setTouchBrake(held: boolean): void {
    this.touchBrake = held;
  }

  /** Steering from the thumb slider, -1..1, or null when the thumb lifts. */
  setTouchSteer(value: number | null): void {
    // Lifting the thumb lets go at once rather than ramping down like a key:
    // the car's own turn response already smooths the straightening.
    if (value === null && this.touchSteer !== null) this.raw.steer = 0;
    this.touchSteer = value;
  }

  setTouchThrottle(held: boolean): void {
    this.touchThrottle = held;
  }

  /** Drift button down. How long it stays down is the size of the flick. */
  pressDrift(): void {
    this.driftDown = true;
    this.raw.initiate = true;
  }

  /** Drift button up. A press so quick it fell between samples still counts once. */
  releaseDrift(): void {
    this.driftDown = false;
  }

  /** Called by the game once a sample has been recorded. */
  consumeInitiate(): void {
    this.raw.initiate = this.driftDown;
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
    this.held.length = 0;
    this.touchSteer = null;
    this.touchThrottle = false;
    this.touchBrake = false;
    this.raw.brake = false;
    this.raw.steer = 0;
    this.raw.throttle = 0;
    this.raw.initiate = false;
    this.driftDown = false;
  }

  /**
   * Fold the thumb or held keys into the analogue struct.
   *
   * Called once per rendered frame, not per sim tick: this is the only part of
   * input handling that depends on wall-clock time, and it is deliberately
   * outside the sim.
   */
  update(dtSeconds: number): void {
    const held = this.touchThrottle || this.isDown('throttle');
    const rate = held ? 1 / Math.max(THROTTLE_FEEL.rise, 0.01) : -1 / Math.max(THROTTLE_FEEL.fall, 0.01);
    this.raw.throttle = Math.min(1, Math.max(0, this.raw.throttle + rate * dtSeconds));
    this.raw.brake = this.touchBrake || this.isDown('brake');

    if (this.touchSteer !== null) {
      this.raw.steer = this.touchSteer;
      return;
    }

    const target = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    const steerRate = target === 0 ? 1 / STEER_RELEASE : 1 / STEER_ATTACK;
    const step = steerRate * dtSeconds;
    const d = target - this.raw.steer;
    this.raw.steer = Math.abs(d) <= step ? target : this.raw.steer + Math.sign(d) * step;
  }

  /** True if the action's key is held. */
  isDown(action: Action): boolean {
    const codes = this.keymap[action];
    for (let i = 0; i < codes.length; i++) {
      if (this.held.includes(codes[i])) return true;
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

  /** For tests and tooling: hold or release a key by code, as a keydown would. */
  press(code: string, down: boolean): void {
    const i = this.held.indexOf(code);
    if (down && i < 0) this.held.push(code);
    if (!down && i >= 0) this.held.splice(i, 1);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat || !this.isBound(e.code)) return;
    e.preventDefault();
    this.press(e.code, true);
    if (this.keymap.drift.includes(e.code)) this.pressDrift();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!this.isBound(e.code)) return;
    e.preventDefault();
    this.press(e.code, false);
    if (this.keymap.drift.includes(e.code)) this.releaseDrift();
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
