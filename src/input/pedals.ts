/**
 * Drift Run's throttle controls on a touch screen: tap the left half to drift,
 * hold the right half for throttle.
 *
 * Two halves rather than two buttons, so neither thumb ever has to find a
 * target: anywhere on the side will do. Both can be used at once -- the
 * whole point is holding the throttle while tapping to switch sides.
 */
export interface PedalCallbacks {
  onThrottle: (held: boolean) => void;
  onDrift: (held: boolean) => void;
}

export class PedalTouch {
  private readonly surface: HTMLElement;
  /** The drift half's label; the HUD fills it while the button is held. */
  readonly driftZone: HTMLElement;
  private readonly throttleZone: HTMLElement;
  private readonly callbacks: PedalCallbacks;
  /** Fingers currently holding the throttle side, and the drift side. */
  private throttleFingers: number[] = [];
  private driftFingers: number[] = [];

  constructor(surface: HTMLElement, callbacks: PedalCallbacks) {
    this.surface = surface;
    this.callbacks = callbacks;
    this.driftZone = zone('pedal-zone pedal-zone--drift', 'DRIFT', 'Tap · hold');
    const meter = document.createElement('span');
    meter.className = 'pedal-meter';
    meter.innerHTML = '<span class="pedal-meter__fill"></span>';
    this.driftZone.appendChild(meter);
    this.throttleZone = zone('pedal-zone pedal-zone--throttle', 'GAS', 'Hold');
    // An empty meter on the gas side too, so the two pads are the same height
    // and sit level.
    const spacer = document.createElement('span');
    spacer.className = 'pedal-meter pedal-meter--spacer';
    this.throttleZone.appendChild(spacer);
    surface.append(this.driftZone, this.throttleZone);

    surface.addEventListener('pointerdown', (e) => this.onDown(e));
    surface.addEventListener('pointerup', (e) => this.onUp(e));
    surface.addEventListener('pointercancel', (e) => this.onUp(e));
    surface.addEventListener('lostpointercapture', (e) => this.onUp(e));
    // A long press on a phone otherwise opens a context menu mid-drift.
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll(): void {
    this.throttleFingers = [];
    this.driftFingers = [];
    this.throttleZone.dataset.active = 'false';
    this.driftZone.dataset.active = 'false';
    this.callbacks.onThrottle(false);
    this.callbacks.onDrift(false);
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; harmless.
    }
    const rect = this.surface.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) {
      if (!this.driftFingers.includes(e.pointerId)) this.driftFingers.push(e.pointerId);
      this.driftZone.dataset.active = 'true';
      this.callbacks.onDrift(true);
      return;
    }
    if (!this.throttleFingers.includes(e.pointerId)) this.throttleFingers.push(e.pointerId);
    this.throttleZone.dataset.active = 'true';
    this.callbacks.onThrottle(true);
  }

  private onUp(e: PointerEvent): void {
    const d = this.driftFingers.indexOf(e.pointerId);
    if (d >= 0) {
      this.driftFingers.splice(d, 1);
      if (this.driftFingers.length === 0) {
        this.driftZone.dataset.active = 'false';
        this.callbacks.onDrift(false);
      }
      return;
    }
    const i = this.throttleFingers.indexOf(e.pointerId);
    if (i < 0) return;
    this.throttleFingers.splice(i, 1);
    if (this.throttleFingers.length === 0) {
      this.throttleZone.dataset.active = 'false';
      this.callbacks.onThrottle(false);
    }
  }
}

function zone(className: string, label: string, verb: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.dataset.active = 'false';
  const name = document.createElement('span');
  name.className = 'pedal-zone__label';
  name.textContent = label;
  const hint = document.createElement('span');
  hint.className = 'pedal-zone__hint';
  hint.textContent = verb;
  el.append(name, hint);
  return el;
}
