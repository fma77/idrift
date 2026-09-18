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
  onDrift: () => void;
}

export class PedalTouch {
  private readonly surface: HTMLElement;
  private readonly driftZone: HTMLElement;
  private readonly throttleZone: HTMLElement;
  private readonly callbacks: PedalCallbacks;
  /** Fingers currently holding the throttle side. */
  private throttleFingers: number[] = [];
  private flashTimer = 0;

  constructor(surface: HTMLElement, callbacks: PedalCallbacks) {
    this.surface = surface;
    this.callbacks = callbacks;
    this.driftZone = zone('pedal-zone pedal-zone--drift', 'DRIFT', 'Tap');
    this.throttleZone = zone('pedal-zone pedal-zone--throttle', 'GAS', 'Hold');
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
    this.throttleZone.dataset.active = 'false';
    this.callbacks.onThrottle(false);
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
      this.callbacks.onDrift();
      this.driftZone.dataset.active = 'true';
      clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => (this.driftZone.dataset.active = 'false'), 140);
      return;
    }
    this.throttleFingers.push(e.pointerId);
    this.throttleZone.dataset.active = 'true';
    this.callbacks.onThrottle(true);
  }

  private onUp(e: PointerEvent): void {
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
