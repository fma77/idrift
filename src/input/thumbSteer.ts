/**
 * The thumb slider: touch anywhere, slide sideways to steer, lift to straighten.
 *
 * There is no fixed control on screen. Wherever the thumb lands becomes the
 * centre, so a player never has to look for a control or reach for one, and can
 * shift their grip mid-run without losing the car. This is the Drifto control,
 * and the reason the game went back to a single thumb: with the old five
 * buttons, a smooth drift line was beyond what a player could do on glass.
 */

/** Full steering at this fraction of the screen's short edge, before sensitivity. */
const RANGE_FRACTION = 0.2;
const MIN_RANGE_PX = 60;
const MAX_RANGE_PX = 140;

export const MIN_SENSITIVITY = 0.5;
export const MAX_SENSITIVITY = 2;

/**
 * Pixels of thumb travel from centre to full steering. Higher sensitivity means
 * less travel.
 */
export function sliderRange(width: number, height: number, sensitivity: number): number {
  const base = Math.min(MAX_RANGE_PX, Math.max(MIN_RANGE_PX, Math.min(width, height) * RANGE_FRACTION));
  const s = Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, sensitivity || 1));
  return base / s;
}

export interface SliderReading {
  /** Where centre now is, in pixels. */
  anchor: number;
  /** -1 (full left) .. +1 (full right). */
  steer: number;
}

/**
 * Steering for a thumb at `x`, given where centre is.
 *
 * Past full steering, centre is dragged along behind the thumb. Without that, a
 * thumb that overshoots has to travel all the way back through the dead
 * distance before the car responds to the other direction -- which on a phone
 * feels exactly like the controls freezing.
 */
export function readSlider(anchor: number, x: number, range: number): SliderReading {
  let a = anchor;
  if (x - a > range) a = x - range;
  else if (a - x > range) a = x + range;
  const steer = range <= 0 ? 0 : (x - a) / range;
  return { anchor: a, steer: Math.max(-1, Math.min(1, steer)) };
}

export class ThumbSteer {
  private readonly surface: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly onSteer: (value: number | null) => void;

  private sensitivity = 1;
  /** Every finger down on the surface, oldest first. The newest one steers. */
  private fingers: { id: number; x: number; y: number }[] = [];
  private anchor = 0;
  private steer = 0;

  constructor(surface: HTMLElement, onSteer: (value: number | null) => void) {
    this.surface = surface;
    this.onSteer = onSteer;

    this.indicator = document.createElement('div');
    this.indicator.className = 'steer-track';
    this.indicator.hidden = true;
    this.knob = document.createElement('div');
    this.knob.className = 'steer-track__knob';
    this.indicator.appendChild(this.knob);
    surface.appendChild(this.indicator);

    surface.addEventListener('pointerdown', (e) => this.onDown(e));
    surface.addEventListener('pointermove', (e) => this.onMove(e));
    surface.addEventListener('pointerup', (e) => this.onUp(e));
    surface.addEventListener('pointercancel', (e) => this.onUp(e));
    surface.addEventListener('lostpointercapture', (e) => this.onUp(e));
    // A long press on a phone otherwise opens a context menu mid-corner.
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setSensitivity(value: number): void {
    this.sensitivity = value;
  }

  /** Let go, e.g. when a run is paused or ends. */
  releaseAll(): void {
    this.fingers = [];
    this.steer = 0;
    this.indicator.hidden = true;
    this.onSteer(null);
  }

  private range(): number {
    return sliderRange(this.surface.clientWidth, this.surface.clientHeight, this.sensitivity);
  }

  private onDown(e: PointerEvent): void {
    // A mouse only steers while its button is held, like a finger on glass.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; harmless.
    }
    const p = this.local(e);
    this.fingers.push({ id: e.pointerId, x: p.x, y: p.y });
    // A new finger takes over from wherever the steering already is, so putting
    // a second thumb down never jerks the car back to straight.
    this.anchor = p.x - this.steer * this.range();
    this.apply();
  }

  private onMove(e: PointerEvent): void {
    const finger = this.fingers.find((f) => f.id === e.pointerId);
    if (!finger) return;
    e.preventDefault();
    const p = this.local(e);
    finger.x = p.x;
    finger.y = p.y;
    if (finger === this.fingers[this.fingers.length - 1]) this.apply();
  }

  private onUp(e: PointerEvent): void {
    const index = this.fingers.findIndex((f) => f.id === e.pointerId);
    if (index < 0) return;
    const wasSteering = index === this.fingers.length - 1;
    this.fingers.splice(index, 1);

    if (this.fingers.length === 0) {
      this.releaseAll();
      return;
    }
    if (wasSteering) {
      // Hand over to the finger still down, keeping the current steering.
      const next = this.fingers[this.fingers.length - 1];
      this.anchor = next.x - this.steer * this.range();
      this.apply();
    }
  }

  private apply(): void {
    const finger = this.fingers[this.fingers.length - 1];
    const range = this.range();
    const reading = readSlider(this.anchor, finger.x, range);
    this.anchor = reading.anchor;
    this.steer = reading.steer;
    this.onSteer(reading.steer);

    // The track is the one piece of feedback: where centre is, and how far off
    // it the thumb has gone. It sits just above the thumb so the thumb does not
    // cover it.
    this.indicator.hidden = false;
    this.indicator.style.width = `${range * 2}px`;
    this.indicator.style.transform = `translate(${reading.anchor - range}px, ${finger.y - 56}px)`;
    this.knob.style.left = `${(reading.steer + 1) * 50}%`;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.surface.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
}
