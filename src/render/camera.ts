import { sin, cos, wrapAngle, clamp, lerp, HALF_PI } from '../sim/math/trig.ts';
import type { SimState } from '../sim/types.ts';

/**
 * Camera.
 *
 * Lives entirely outside the sim: it reads sim state and produces a transform,
 * and nothing it does can influence the simulation. That separation is why the
 * camera can be changed freely -- including the settings toggles below -- with
 * no risk of invalidating a leaderboard.
 */

export interface CameraSettings {
  /** Disable rotation entirely. Some players find a rotating world nauseating. */
  fixedNorth: boolean;
}

/**
 * Zoom is expressed as "how many metres of road fit across the short edge of
 * the screen", never as pixels per metre.
 *
 * An absolute px/m value frames the game completely differently on a 390px
 * phone and a 1600px desktop -- the same road is a quarter of the screen on one
 * and a twentieth on the other -- and that fraction is what decides whether a
 * corner is readable. Deriving pixels from the viewport keeps both honest.
 *
 * These two constants are the whole feel of the camera. Lower METRES_AT_REST to
 * zoom in, raise SPEED_WIDENING to open the view up faster as the car builds
 * speed.
 */
const METRES_AT_REST = 24;
/** Extra metres of view per m/s of speed, for lookahead. */
const SPEED_WIDENING = 0.55;
const MAX_METRES_ACROSS = 46;
/**
 * How far ahead of the car the camera sits, as a fraction of the view width.
 *
 * The camera used to sit exactly on the car and buy its lookahead by zooming
 * out: at 140km/h it showed 62 metres across, which on a phone makes the car
 * 26 pixels long -- a miniature, sliding around a wide grey field, with no
 * sense of speed at all. Pushing the camera ahead of the car buys the same
 * view of the road at a much closer zoom.
 */
const LOOKAHEAD_FRACTION = 0.26;
/**
 * A landscape screen is short, and the zoom is set by its short edge, so the
 * road ahead ran out half way up: at rest it showed 15 metres ahead where
 * portrait showed 32. Held sideways the car therefore sits lower and the view
 * pulls back, which buys back the forward view -- and fills the width either
 * side of the road, which is what a landscape screen has to spare.
 */
const LANDSCAPE_ZOOM = 0.78;
/** Where the car sits up the screen, as a fraction of the height. */
const CAR_UP_SCREEN = 0.62;
const CAR_UP_SCREEN_LANDSCAPE = 0.76;

/** Held sideways, with room to spare: not merely wider than tall. */
export function isLandscape(viewWidth: number, viewHeight: number): boolean {
  return viewWidth > viewHeight * 1.3;
}

/** Pixels from the top of the view to the car. */
export function carScreenY(viewWidth: number, viewHeight: number): number {
  return viewHeight * (isLandscape(viewWidth, viewHeight) ? CAR_UP_SCREEN_LANDSCAPE : CAR_UP_SCREEN);
}

export class Camera {
  x = 0;
  y = 0;
  /** World angle currently pointing up-screen. */
  angle = HALF_PI;
  /** Pixels per metre. Derived every frame from metresAcross and the viewport. */
  scale = 12;

  /**
   * The damped quantity is the *view width in metres*, not the pixel scale.
   *
   * Damping the pixel scale directly conflates two different changes: the car
   * speeding up (which should ease) and the viewport resizing (which should
   * not). Keeping metres as the state means a phone rotation re-derives pixels
   * instantly and correctly, with no zoom animation and no stale scale.
   */
  private metresAcross = METRES_AT_REST;

  private settled = false;

  /**
   * Follow the car.
   *
   * Two decisions here matter more than they look:
   *
   * 1. The camera aligns to the VELOCITY vector, not the heading. In a drift
   *    those differ by up to 45 degrees, and aligning to heading means the
   *    whole world snaps sideways the instant the car steps out -- exactly when
   *    the player most needs a stable frame of reference.
   *
   * 2. That alignment is heavily damped. Even following velocity, a flick of
   *    opposite lock changes the target angle quickly, and an undamped camera
   *    turns that into a lurch. The damping constant is low enough that fast
   *    transitions read as the world easing round rather than rotating.
   */
  follow(
    state: SimState,
    settings: CameraSettings,
    dtSeconds: number,
    viewWidth: number,
    viewHeight: number,
  ): void {

    const targetAngle = settings.fixedNorth
      ? HALF_PI
      : state.speed > 2.5
        ? state.heading + state.slipAngle
        : state.heading;

    if (!this.settled) {
      this.angle = targetAngle;
      this.settled = true;
    } else {
      // Frame-rate independent exponential damping toward the shortest turn.
      const delta = wrapAngle(targetAngle - this.angle);
      const k = 1 - Math.exp(-3.2 * dtSeconds);
      this.angle = wrapAngle(this.angle + delta * k);
    }

    const target = clamp(
      METRES_AT_REST + state.speed * SPEED_WIDENING,
      METRES_AT_REST,
      MAX_METRES_ACROSS,
    );
    this.metresAcross = lerp(this.metresAcross, target, 1 - Math.exp(-2.5 * dtSeconds));

    // Sit ahead of the car, along the way it is travelling, so the road it is
    // about to reach is on screen rather than the road it has just left.
    const ahead = this.metresAcross * LOOKAHEAD_FRACTION * clamp(state.speed / 12, 0, 1);
    this.x = state.x + cos(this.angle) * ahead;
    this.y = state.y + sin(this.angle) * ahead;

    this.applyZoom(viewWidth, viewHeight);
  }

  reset(state: SimState, viewWidth = 0, viewHeight = 0): void {
    this.x = state.x;
    this.y = state.y;
    this.angle = state.heading;
    this.metresAcross = METRES_AT_REST;
    this.applyZoom(viewWidth, viewHeight);
    this.settled = true;
  }

  /**
   * Re-derive pixels-per-metre for a viewport size. Called on resize.
   *
   * A zero-sized viewport is not a viewport -- it is a browser that has not
   * laid out yet. Taking it literally would set the scale to zero and render
   * the world as a dot, so the previous scale is kept until a real size shows up.
   */
  applyZoom(viewWidth: number, viewHeight: number): void {
    const shortEdge = Math.min(viewWidth, viewHeight);
    if (shortEdge <= 0) return;
    this.scale = (shortEdge / this.metresAcross) * (isLandscape(viewWidth, viewHeight) ? LANDSCAPE_ZOOM : 1);
  }

  /**
   * Apply the world-to-screen transform to a canvas context.
   *
   * Maps world (x right, y up) to canvas (x right, y down) with the camera's
   * forward direction pointing up-screen. The determinant is negative because
   * of that y flip -- that is the handedness change, not a bug.
   */
  applyTo(
    ctx: CanvasRenderingContext2D,
    viewWidth: number,
    viewHeight: number,
    dpr: number,
  ): void {
    const s = this.scale;
    const sa = sin(this.angle);
    const ca = cos(this.angle);
    const cx = viewWidth / 2;
    // Sit the car below centre so more of the screen shows the road ahead.
    const cy = carScreenY(viewWidth, viewHeight);

    // setTransform REPLACES the current transform rather than multiplying into
    // it, so any device-pixel-ratio scale the caller set is discarded here. The
    // dpr therefore has to be folded into this matrix directly -- composing the
    // two by hand rather than relying on a scale() that this call would wipe
    // out. Getting this wrong is silent on a 1x display and misplaces the whole
    // world on every retina device.
    ctx.setTransform(
      dpr * s * sa,
      dpr * -s * ca,
      dpr * -s * ca,
      dpr * -s * sa,
      dpr * (cx - s * sa * this.x + s * ca * this.y),
      dpr * (cy + s * ca * this.x + s * sa * this.y),
    );
  }

  /** Largest world-space radius that can be visible. Used for culling. */
  visibleRadius(viewWidth: number, viewHeight: number): number {
    return (Math.sqrt(viewWidth * viewWidth + viewHeight * viewHeight) / 2 / this.scale) * 1.15;
  }
}
