/**
 * Time Attack Pro on a touch screen: the right half of the screen is the
 * pedals, brake on its inner side and gas on its outer side, like the real
 * ones. The left half steers. The thumb can slide between the two pedals
 * without lifting, which is how a driver goes from brake to throttle through
 * a corner.
 */
export interface ProPedalCallbacks {
  onThrottle: (held: boolean) => void;
  onBrake: (held: boolean) => void;
}

type Pedal = 'gas' | 'brake';

export class ProPedals {
  private readonly surface: HTMLElement;
  private readonly gasZone: HTMLElement;
  private readonly brakeZone: HTMLElement;
  private readonly callbacks: ProPedalCallbacks;
  /** Which pedal each finger is on. */
  private readonly fingers = new Map<number, Pedal>();

  constructor(surface: HTMLElement, callbacks: ProPedalCallbacks) {
    this.surface = surface;
    this.callbacks = callbacks;
    this.brakeZone = zone('pro-zone pro-zone--brake', 'BRAKE');
    this.gasZone = zone('pro-zone pro-zone--gas', 'GAS');
    surface.append(this.brakeZone, this.gasZone);

    surface.addEventListener('pointerdown', (e) => this.onDown(e));
    surface.addEventListener('pointermove', (e) => this.onMove(e));
    surface.addEventListener('pointerup', (e) => this.onUp(e));
    surface.addEventListener('pointercancel', (e) => this.onUp(e));
    surface.addEventListener('lostpointercapture', (e) => this.onUp(e));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll(): void {
    this.fingers.clear();
    this.sync();
  }

  private pedalAt(e: PointerEvent): Pedal {
    const rect = this.surface.getBoundingClientRect();
    return e.clientX - rect.left < rect.width / 2 ? 'brake' : 'gas';
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; harmless.
    }
    this.fingers.set(e.pointerId, this.pedalAt(e));
    this.sync();
  }

  private onMove(e: PointerEvent): void {
    if (!this.fingers.has(e.pointerId)) return;
    const pedal = this.pedalAt(e);
    if (pedal !== this.fingers.get(e.pointerId)) {
      this.fingers.set(e.pointerId, pedal);
      this.sync();
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.fingers.delete(e.pointerId)) return;
    this.sync();
  }

  private sync(): void {
    let gas = false;
    let brake = false;
    for (const pedal of this.fingers.values()) {
      if (pedal === 'gas') gas = true;
      else brake = true;
    }
    this.gasZone.dataset.active = String(gas);
    this.brakeZone.dataset.active = String(brake);
    this.callbacks.onThrottle(gas);
    this.callbacks.onBrake(brake);
  }
}

function zone(className: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.dataset.active = 'false';
  const name = document.createElement('span');
  name.className = 'pedal-zone__label';
  name.textContent = label;
  el.append(name);
  return el;
}
