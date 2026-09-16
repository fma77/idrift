import type { Action } from './input.ts';
import {
  TOUCH_ACTIONS,
  actionAt,
  buttonSize,
  clampCentre,
  mirror,
  orientationOf,
  resolvePressed,
  type ButtonPosition,
  type Rect,
  type TouchLayout,
} from './touchLayout.ts';

/**
 * The on-screen buttons, in two modes.
 *
 * PLAY: fingers press buttons. Every finger is tracked independently and the
 * button under it is re-resolved as it moves, so a thumb can roll from one
 * steering arrow to the other without lifting -- which is how people actually
 * steer on glass.
 *
 * EDIT: fingers drag buttons. Positions are stored as fractions of the screen,
 * per orientation, and mirrored for left-handed play at display time only, so
 * toggling left-handed mode never loses anyone's arrangement.
 */

/** Pixels outside a button's edge that still count as pressing it. */
const TOUCH_SLOP = 14;
/** Minimum clearance kept between a dragged button and the screen edge. */
const EDGE_MARGIN = 8;

const LABELS: Record<Action, string> = {
  left: '',
  right: '',
  brake: 'BRAKE',
  accelerate: 'GAS',
  handbrake: 'HAND<br>BRAKE',
};

const NAMES: Record<Action, string> = {
  left: 'Steer left',
  right: 'Steer right',
  brake: 'Brake',
  accelerate: 'Accelerate',
  handbrake: 'Handbrake',
};

/** Filled triangle, drawn rather than typed: arrow characters render as emoji on some phones. */
function arrow(direction: 'left' | 'right'): string {
  const points = direction === 'left' ? '16,4 16,28 4,16' : '4,4 4,28 16,16';
  return `<svg viewBox="0 0 20 32" aria-hidden="true"><polygon points="${points}"/></svg>`;
}

export interface TouchControlsOptions {
  /** Play mode: an action was pressed or released. */
  onPress?: (action: Action, down: boolean) => void;
  /** Edit mode: a button was dropped in a new place. */
  onMove?: (layout: TouchLayout) => void;
  editable?: boolean;
}

export class TouchControls {
  private readonly container: HTMLElement;
  private readonly options: TouchControlsOptions;
  private readonly buttons = {} as Record<Action, HTMLButtonElement>;

  private layout: TouchLayout | null = null;
  private lefty = false;

  /** Play mode: every finger currently down, by pointer id. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pressed = new Set<Action>();
  private rects: Partial<Record<Action, Rect>> = {};

  /** Edit mode: the button being dragged and where on it the finger grabbed. */
  private drag: { action: Action; pointerId: number; dx: number; dy: number } | null = null;

  constructor(container: HTMLElement, options: TouchControlsOptions = {}) {
    this.container = container;
    this.options = options;
    container.classList.toggle('touch-controls--edit', !!options.editable);

    for (const action of TOUCH_ACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `touch-btn touch-btn--${action}`;
      button.dataset.action = action;
      button.setAttribute('aria-label', NAMES[action]);
      button.innerHTML =
        action === 'left' || action === 'right'
          ? arrow(action)
          : `<span class="touch-btn__label">${LABELS[action]}</span>`;
      if (options.editable) {
        const name = document.createElement('span');
        name.className = 'touch-btn__name';
        name.textContent = NAMES[action];
        button.appendChild(name);
      }

      button.addEventListener('pointerdown', (e) => this.onDown(e, action));
      button.addEventListener('pointermove', (e) => this.onMoveEvent(e));
      button.addEventListener('pointerup', (e) => this.onUp(e));
      button.addEventListener('pointercancel', (e) => this.onUp(e));
      button.addEventListener('lostpointercapture', (e) => this.onUp(e));

      this.buttons[action] = button;
      container.appendChild(button);
    }

    // A long press on a phone otherwise opens a context menu or starts a text
    // selection, which in the middle of a corner is a crash.
    container.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setLayout(layout: TouchLayout, lefty: boolean): void {
    this.layout = layout;
    this.lefty = lefty;
    this.relayout();
  }

  /** Re-place every button for the current viewport. Call on resize and rotation. */
  relayout(): void {
    if (!this.layout) return;
    const { width, height } = this.viewport();
    if (width <= 0 || height <= 0) return;

    const orientation = orientationOf(width, height);
    for (const action of TOUCH_ACTIONS) {
      const size = buttonSize(action, width, height, this.layout.scale);
      const stored = this.layout[orientation][action];
      const shown = clampCentre(this.lefty ? mirror(stored) : stored, size, width, height, EDGE_MARGIN);
      this.place(action, shown, size, width, height);
    }
    this.measure();
  }

  /** Let go of everything, e.g. when a run is paused or ends. */
  releaseAll(): void {
    this.pointers.clear();
    this.drag = null;
    this.apply(new Set());
    for (const action of TOUCH_ACTIONS) this.buttons[action].dataset.dragging = 'false';
  }

  // --- Pointer handling -----------------------------------------------------

  private onDown(e: PointerEvent, action: Action): void {
    e.preventDefault();
    // Capture, so this finger's moves keep arriving even after it slides off
    // the button it started on.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; harmless.
    }

    if (this.options.editable) {
      if (this.drag) return;
      const rect = this.buttons[action].getBoundingClientRect();
      this.drag = {
        action,
        pointerId: e.pointerId,
        dx: e.clientX - (rect.left + rect.width / 2),
        dy: e.clientY - (rect.top + rect.height / 2),
      };
      this.buttons[action].dataset.dragging = 'true';
      return;
    }

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.resolve();
  }

  private onMoveEvent(e: PointerEvent): void {
    if (this.options.editable) {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      e.preventDefault();
      this.dragTo(e.clientX - this.drag.dx, e.clientY - this.drag.dy);
      return;
    }
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.resolve();
  }

  private onUp(e: PointerEvent): void {
    if (this.options.editable) {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.dragTo(e.clientX - this.drag.dx, e.clientY - this.drag.dy, true);
      this.buttons[this.drag.action].dataset.dragging = 'false';
      this.drag = null;
      return;
    }
    if (!this.pointers.delete(e.pointerId)) return;
    this.resolve();
  }

  /** Work out what every finger is holding and report only what changed. */
  private resolve(): void {
    const origin = this.container.getBoundingClientRect();
    const local = [...this.pointers.values()].map((p) => ({
      x: p.x - origin.left,
      y: p.y - origin.top,
    }));
    this.apply(resolvePressed(local, this.rects, TOUCH_SLOP));
  }

  private apply(next: Set<Action>): void {
    for (const action of TOUCH_ACTIONS) {
      const was = this.pressed.has(action);
      const now = next.has(action);
      if (was === now) continue;
      this.buttons[action].dataset.active = String(now);
      this.options.onPress?.(action, now);
    }
    this.pressed = next;
  }

  // --- Editing --------------------------------------------------------------

  private dragTo(clientX: number, clientY: number, commit = false): void {
    if (!this.drag || !this.layout) return;
    const { width, height } = this.viewport();
    const origin = this.container.getBoundingClientRect();
    const action = this.drag.action;
    const size = buttonSize(action, width, height, this.layout.scale);

    const shown = clampCentre(
      { x: (clientX - origin.left) / width, y: (clientY - origin.top) / height },
      size,
      width,
      height,
      EDGE_MARGIN,
    );
    this.place(action, shown, size, width, height);

    if (commit) {
      // Store un-mirrored, so the arrangement survives toggling left-handed mode.
      const orientation = orientationOf(width, height);
      this.layout[orientation][action] = this.lefty ? mirror(shown) : shown;
      this.measure();
      this.options.onMove?.(this.layout);
    }
  }

  // --- Geometry -------------------------------------------------------------

  private viewport(): { width: number; height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  private place(
    action: Action,
    position: ButtonPosition,
    size: number,
    width: number,
    height: number,
  ): void {
    const button = this.buttons[action];
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
    button.style.left = `${position.x * width}px`;
    button.style.top = `${position.y * height}px`;
  }

  /** Cache button rectangles for hit-testing, relative to the container. */
  private measure(): void {
    const { width } = this.viewport();
    if (!this.layout || width <= 0) return;
    const rects: Partial<Record<Action, Rect>> = {};
    for (const action of TOUCH_ACTIONS) {
      const b = this.buttons[action];
      const size = parseFloat(b.style.width) || 0;
      const cx = parseFloat(b.style.left) || 0;
      const cy = parseFloat(b.style.top) || 0;
      rects[action] = {
        left: cx - size / 2,
        right: cx + size / 2,
        top: cy - size / 2,
        bottom: cy + size / 2,
      };
    }
    this.rects = rects;
  }

  /** Exposed for hit-testing checks from the console during play-testing. */
  actionAtPoint(x: number, y: number): Action | null {
    return actionAt(x, y, this.rects, TOUCH_SLOP);
  }
}
