import { clamp } from '../sim/math/trig.ts';

/**
 * Input.
 *
 * Touch and keyboard both write into one mutable "current input" struct, which
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

/** Seconds from neutral to full lock on a keyboard, and back to neutral. */
const KEY_STEER_ATTACK = 0.22;
const KEY_STEER_RELEASE = 0.12;

export class InputController {
  readonly raw: RawInput = { steer: 0, throttle: 0, handbrake: false };

  /** 'touch' once a touch is seen, 'keyboard' otherwise. Drives the HUD hints. */
  mode: 'keyboard' | 'touch' = 'keyboard';
  lefty = false;

  private keymap: Keymap = DEFAULT_KEYMAP;
  private held = new Set<string>();

  /** Active steering pointer, if any. */
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private touchSteer = 0;
  private touchThrottle = 0;
  private handbrakeHeld = false;

  /** Callback so the UI can show the relative stick where the thumb landed. */
  onStick: ((active: boolean, x: number, y: number, dx: number, dy: number) => void) | null = null;

  private enabled = false;
  private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => this.releaseAll();

  constructor(
    private steerZone: HTMLElement,
    private handbrakeButton: HTMLElement,
  ) {
    this.attachPointer();
  }

  setKeymap(map: Keymap): void {
    this.keymap = map;
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
    this.pointerId = null;
    this.touchSteer = 0;
    this.touchThrottle = 0;
    this.handbrakeHeld = false;
    this.raw.steer = 0;
    this.raw.throttle = 0;
    this.raw.handbrake = false;
    this.handbrakeButton.dataset.active = 'false';
    this.onStick?.(false, 0, 0, 0, 0);
  }

  /**
   * Fold held keys into the analogue struct.
   *
   * Called once per rendered frame, not per sim tick: this is the only part of
   * input handling that depends on wall-clock time, and it is deliberately
   * outside the sim. A key is a binary signal and the car needs a continuous
   * one, so steering ramps rather than stepping -- without this the keyboard
   * would be a much blunter instrument than a thumb and the two platforms would
   * not be playing the same game.
   */
  update(dtSeconds: number): void {
    if (this.mode === 'touch') {
      this.raw.steer = this.touchSteer;
      this.raw.throttle = this.touchThrottle;
      this.raw.handbrake = this.handbrakeHeld;
      return;
    }

    const left = this.isDown('left');
    const right = this.isDown('right');
    const target = (right ? 1 : 0) - (left ? 1 : 0);

    const rate = target === 0 ? 1 / KEY_STEER_RELEASE : 1 / KEY_STEER_ATTACK;
    const step = rate * dtSeconds;
    const d = target - this.raw.steer;
    this.raw.steer = Math.abs(d) <= step ? target : this.raw.steer + Math.sign(d) * step;

    const up = this.isDown('accelerate');
    const down = this.isDown('brake');
    this.raw.throttle = (up ? 1 : 0) - (down ? 1 : 0);
    this.raw.handbrake = this.isDown('handbrake') || this.handbrakeHeld;
  }

  private isDown(action: Action): boolean {
    const codes = this.keymap[action];
    for (let i = 0; i < codes.length; i++) {
      if (this.held.has(codes[i])) return true;
    }
    return false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (this.isBound(e.code)) {
      e.preventDefault();
      this.mode = 'keyboard';
      this.held.add(e.code);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.isBound(e.code)) {
      e.preventDefault();
      this.held.delete(e.code);
    }
  }

  private isBound(code: string): boolean {
    for (let i = 0; i < ACTIONS.length; i++) {
      if (this.keymap[ACTIONS[i].id].includes(code)) return true;
    }
    return false;
  }

  // --- Touch --------------------------------------------------------------

  /**
   * Relative joystick.
   *
   * The origin is wherever the thumb lands, not a painted circle: on a phone
   * the player is looking at the road, and asking them to find a fixed control
   * by feel costs a corner every time they re-grip. Travel is deliberately
   * short so full lock is reachable without moving the hand.
   */
  private attachPointer(): void {
    const FULL_LOCK_PX = 68;
    const FULL_THROTTLE_PX = 58;

    this.steerZone.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      this.mode = 'touch';
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.steerZone.setPointerCapture(e.pointerId);
      this.onStick?.(true, e.clientX, e.clientY, 0, 0);
      e.preventDefault();
    });

    this.steerZone.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      const dx = e.clientX - this.originX;
      const dy = e.clientY - this.originY;

      // Progressive lock: displacement maps to angle up to a maximum, so small
      // corrections stay small.
      const sign = this.lefty ? -1 : 1;
      this.touchSteer = clamp((dx / FULL_LOCK_PX) * sign, -1, 1);
      // Screen y grows downward; dragging up is throttle.
      this.touchThrottle = clamp(-dy / FULL_THROTTLE_PX, -1, 1);

      this.onStick?.(
        true,
        this.originX,
        this.originY,
        clamp(dx, -FULL_LOCK_PX, FULL_LOCK_PX),
        clamp(dy, -FULL_THROTTLE_PX, FULL_THROTTLE_PX),
      );
      e.preventDefault();
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.touchSteer = 0;
      this.touchThrottle = 0;
      this.onStick?.(false, 0, 0, 0, 0);
    };
    this.steerZone.addEventListener('pointerup', end);
    this.steerZone.addEventListener('pointercancel', end);

    const press = (down: boolean) => (e: PointerEvent) => {
      this.mode = 'touch';
      this.handbrakeHeld = down;
      this.handbrakeButton.dataset.active = String(down);
      e.preventDefault();
    };
    this.handbrakeButton.addEventListener('pointerdown', press(true));
    this.handbrakeButton.addEventListener('pointerup', press(false));
    this.handbrakeButton.addEventListener('pointercancel', press(false));
    this.handbrakeButton.addEventListener('pointerleave', press(false));
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
