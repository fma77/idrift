import { sin, cos, wrapAngle, clamp, lerp } from '../sim/math/trig.ts';
import type { CarParams, RouteData, SimState } from '../sim/types.ts';
import { Camera, type CameraSettings } from './camera.ts';
import { getSprite } from './sprites.ts';
import { drawDecoration, type DecorationData } from './decoration.ts';
import { TyreSmoke } from './smoke.ts';

/**
 * World renderer.
 *
 * Knows about pixels; knows nothing about rules. It reads sim state and route
 * data and draws. It never writes to sim state, and no value it computes is
 * ever fed back in -- which is what lets the whole visual layer be reworked, or
 * have art dropped into it, without invalidating a single stored run.
 *
 * Palette is the design system's gameplay surface: ink void, ink-2 tarmac,
 * paper hairlines, red reserved for scoring geometry.
 */

const INK = '#141414';
const INK_2 = '#2b2b2b';
const PAPER = '#f4f1ea';
const RULE = 'rgba(244,241,234,0.22)';
const RED = '#e8402a';

/** Metres of route drawn ahead of the car before the fog closes in. */
const REVEAL_AHEAD = 150;
/** Metres drawn behind, so the road does not vanish from under the car. */
const REVEAL_BEHIND = 40;

/** Max skid trail segments retained. ~6 seconds of continuous drifting. */
const MAX_SKID = 420;

interface SkidPoint {
  x: number;
  y: number;
  /** 0..1 intensity, from slip angle. */
  weight: number;
}

export interface RenderSettings extends CameraSettings {
  showSkidMarks: boolean;
  showSmoke: boolean;
}

export class Renderer {
  readonly camera = new Camera();

  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  /** Rear-axle trail, world space. Purely cosmetic. */
  private skidLeft: SkidPoint[] = [];
  private skidRight: SkidPoint[] = [];
  private readonly smoke = new TyreSmoke();

  /**
   * Route scenery. Held on the renderer, not on the route, so there is no field
   * anywhere in sim-visible data that could carry it into the simulation.
   */
  private decoration: DecorationData | null = null;

  // Declared as a plain field rather than a constructor parameter property:
  // Node's type-stripping loader rejects parameter properties outright, and
  // that one shortcut was enough to make this whole module unimportable from a
  // headless test.
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();

    // A zero-sized measurement is not a viewport, it is a moment when the
    // browser has not laid the canvas out yet -- mid orientation change, while
    // the element is still display:none, or when the page is in a background
    // tab. Clamping those to 1px used to look harmless and was not: the camera
    // derives its zoom from the viewport, so a 1px canvas collapsed the scale
    // to ~0.02 px/m, and because the scale is damped rather than snapped it
    // then took seconds of visibly microscopic world to crawl back. Keep the
    // last good size instead and wait for a real one.
    let width = Math.round(rect.width);
    let height = Math.round(rect.height);

    if (width <= 0 || height <= 0) {
      // The canvas is full-bleed, so the window is a good second opinion.
      width = Math.round(window.innerWidth);
      height = Math.round(window.innerHeight);
    }
    if (width <= 0 || height <= 0) {
      // Still nothing real. Keep whatever we last measured and try again on the
      // next resize; a 1px fallback would be worse than doing nothing, because
      // it looks like a valid viewport all the way down the pipeline.
      if (this.width > 0 && this.height > 0) return;
      width = 1;
      height = 1;
    }

    this.width = width;
    this.height = height;

    // Cap DPR: a 3x retina phone rendering a full-screen canvas at native
    // density spends more time on fill than on anything else, and the art
    // direction is flat colour with hairlines -- 2x is indistinguishable.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    // The zoom target moved with the viewport; take it immediately rather than
    // easing to it, so a rotation does not play a one-second zoom animation.
    this.camera.applyZoom(this.width, this.height);
  }

  setDecoration(decoration: DecorationData | null): void {
    this.decoration = decoration;
  }

  clearTrails(): void {
    this.skidLeft.length = 0;
    this.skidRight.length = 0;
    this.smoke.clear();
  }

  resetCamera(state: SimState): void {
    this.camera.reset(state, this.width, this.height);
  }

  /**
   * Draw one frame.
   *
   * `alpha` is the fraction of a sim step not yet consumed by the accumulator.
   * Interpolating between the previous and current sim state with it decouples
   * display smoothness from the 120Hz sim rate -- without it, a 60Hz display
   * showing every other tick judders visibly at speed.
   */
  render(
    state: SimState,
    prev: SimState,
    alpha: number,
    route: RouteData,
    car: CarParams,
    settings: RenderSettings,
    dtSeconds: number,
  ): void {
    const view = interpolate(prev, state, alpha);

    this.camera.follow(view, settings, dtSeconds, this.width, this.height);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    this.camera.applyTo(ctx, this.width, this.height, this.dpr);
    // The camera transform scales metres to pixels, so every line width below
    // is expressed in metres and divided by scale to stay pixel-constant.
    const px = 1 / this.camera.scale;

    // Scenery first: it sits under the road surface and the racing line.
    if (this.decoration) {
      const spacing = route.sampleSpacing;
      drawDecoration(
        ctx,
        this.decoration,
        state.sampleIndex - Math.round(REVEAL_BEHIND / spacing),
        state.sampleIndex + Math.round(REVEAL_AHEAD / spacing),
        px,
      );
    }

    this.drawRoad(ctx, route, state, px);
    this.drawScoringMarks(ctx, route, state, px);
    if (settings.showSkidMarks) this.drawSkids(ctx, px);
    // Smoke under the car, so the car is never lost in its own cloud.
    if (settings.showSmoke) {
      this.smoke.update(view, car, dtSeconds);
      this.smoke.draw(ctx, PAPER);
    }
    this.drawCar(ctx, view, car, px);

    ctx.restore();

    this.drawFog(ctx);

    if (settings.showSkidMarks) this.recordSkid(state, car);
  }

  // --- Road ---------------------------------------------------------------

  /**
   * Progressive reveal: only the stretch of route near the car is drawn.
   *
   * This is a rendering concern only. The full route is loaded and the sim sees
   * all of it; we simply do not draw what the fog covers. Scoring, collision
   * and the pace notes all read the complete data, so what is hidden is
   * information, never behaviour.
   */
  private drawRoad(
    ctx: CanvasRenderingContext2D,
    route: RouteData,
    state: SimState,
    px: number,
  ): void {
    const s = route.samples;
    const last = s.x.length - 1;
    const spacing = route.sampleSpacing;
    const from = Math.max(0, state.sampleIndex - Math.round(REVEAL_BEHIND / spacing));
    const to = Math.min(last, state.sampleIndex + Math.round(REVEAL_AHEAD / spacing));
    if (to <= from) return;

    // Tarmac: one polygon down the left edge and back up the right.
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const h = s.heading[i];
      const w = s.halfWidth[i];
      const x = s.x[i] - sin(h) * w;
      const y = s.y[i] + cos(h) * w;
      if (i === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = to; i >= from; i--) {
      const h = s.heading[i];
      const w = s.halfWidth[i];
      ctx.lineTo(s.x[i] + sin(h) * w, s.y[i] - cos(h) * w);
    }
    ctx.closePath();
    ctx.fillStyle = INK_2;
    ctx.fill();

    // Edges: 1px hairlines, the design system's only separator.
    ctx.lineWidth = px * 2;
    ctx.strokeStyle = PAPER;
    for (const side of [1, -1]) {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const h = s.heading[i];
        const w = s.halfWidth[i] * side;
        const x = s.x[i] - sin(h) * w;
        const y = s.y[i] + cos(h) * w;
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Centreline dashes, every 4th sample.
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = RULE;
    ctx.beginPath();
    for (let i = from; i <= to - 2; i += 4) {
      ctx.moveTo(s.x[i], s.y[i]);
      ctx.lineTo(s.x[i + 2], s.y[i + 2]);
    }
    ctx.stroke();

    // Finish line.
    if (to >= last - 1) {
      const h = s.heading[last];
      const w = s.halfWidth[last];
      ctx.lineWidth = px * 5;
      ctx.strokeStyle = PAPER;
      ctx.beginPath();
      ctx.moveTo(s.x[last] - sin(h) * w, s.y[last] + cos(h) * w);
      ctx.lineTo(s.x[last] + sin(h) * w, s.y[last] - cos(h) * w);
      ctx.stroke();
    }
  }

  /** Drift-zone gates and clipping points. Red, because they are scoring geometry. */
  private drawScoringMarks(
    ctx: CanvasRenderingContext2D,
    route: RouteData,
    state: SimState,
    px: number,
  ): void {
    const s = route.samples;
    const spacing = route.sampleSpacing;
    const from = state.sampleIndex - Math.round(REVEAL_BEHIND / spacing);
    const to = state.sampleIndex + Math.round(REVEAL_AHEAD / spacing);

    ctx.lineWidth = px * 2;
    ctx.strokeStyle = RED;

    for (let z = 0; z < route.driftZones.length; z++) {
      const zone = route.driftZones[z];
      for (const index of [zone.entryIndex, zone.exitIndex]) {
        if (index < from || index > to || index < 0 || index >= s.x.length) continue;
        const h = s.heading[index];
        const w = s.halfWidth[index];
        // Gate posts: short marks at each edge rather than a line across the
        // road, so the zone reads as a threshold and not as a wall.
        for (const side of [1, -1]) {
          const bx = s.x[index] - sin(h) * w * side;
          const by = s.y[index] + cos(h) * w * side;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - sin(h) * 1.6 * side, by + cos(h) * 1.6 * side);
          ctx.stroke();
        }
      }
    }

    for (let c = 0; c < route.clipPoints.length; c++) {
      const clip = route.clipPoints[c];
      if (clip.index < from || clip.index > to) continue;
      const h = s.heading[clip.index];
      const cx = s.x[clip.index] - sin(h) * clip.offset;
      const cy = s.y[clip.index] + cos(h) * clip.offset;
      ctx.fillStyle = RED;
      ctx.fillRect(cx - 0.45, cy - 0.45, 0.9, 0.9);
    }
  }

  // --- Skid marks ---------------------------------------------------------

  /**
   * Cosmetic only, and worth the cost: in a top-down view with no sound cues a
   * player cannot otherwise see where the car has actually been sliding, which
   * makes the drift scoring feel arbitrary.
   */
  private recordSkid(state: SimState, car: CarParams): void {
    const slip = Math.abs(state.slipAngle);
    const slipping = state.sliding && slip > 0.14 && state.speed > 4;
    if (!slipping) return;

    const weight = clamp((slip - 0.14) / 0.5, 0.15, 1);
    const h = state.heading;
    const rearX = state.x - cos(h) * car.cgToRear;
    const rearY = state.y - sin(h) * car.cgToRear;
    const halfTrack = car.bodyWidth * 0.42;

    this.skidLeft.push({
      x: rearX - sin(h) * halfTrack,
      y: rearY + cos(h) * halfTrack,
      weight,
    });
    this.skidRight.push({
      x: rearX + sin(h) * halfTrack,
      y: rearY - cos(h) * halfTrack,
      weight,
    });
    if (this.skidLeft.length > MAX_SKID) {
      this.skidLeft.shift();
      this.skidRight.shift();
    }
  }

  private drawSkids(ctx: CanvasRenderingContext2D, px: number): void {
    for (const trail of [this.skidLeft, this.skidRight]) {
      if (trail.length < 2) continue;
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        // Break the stroke where the car left the ground trail (a reset, or a
        // gap in drifting) instead of drawing a line across the map.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx * dx + dy * dy > 9) continue;
        // Older marks fade; the freshest are the ones that matter.
        const age = i / trail.length;
        ctx.strokeStyle = `rgba(10,10,10,${(0.25 + b.weight * 0.45) * age})`;
        ctx.lineWidth = px * (2 + b.weight * 3);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  // --- Car ----------------------------------------------------------------

  private drawCar(
    ctx: CanvasRenderingContext2D,
    view: SimState,
    car: CarParams,
    px: number,
  ): void {
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.rotate(view.heading);

    const sprite = getSprite(car.sprite?.path);
    const len = car.bodyLength;
    const wid = car.bodyWidth;

    if (sprite) {
      // Supplied art faces "up"; the car's local +x is forward, so rotate the
      // image a quarter turn to line the two conventions up.
      ctx.rotate(-Math.PI / 2);
      ctx.scale(1, -1);
      ctx.drawImage(sprite, -wid / 2, -len / 2, wid, len);
    } else {
      // Placeholder: an oriented body with a windshield marker so the front is
      // unambiguous at a glance.
      ctx.fillStyle = car.tint ?? PAPER;
      ctx.fillRect(-len / 2, -wid / 2, len, wid);

      ctx.fillStyle = INK;
      ctx.fillRect(len * 0.06, -wid / 2 + 0.1, len * 0.2, wid - 0.2);

      ctx.strokeStyle = PAPER;
      ctx.lineWidth = px * 2;
      ctx.strokeRect(-len / 2, -wid / 2, len, wid);

      drawWheels(ctx, car, view.steerAngle);
    }

    ctx.restore();
  }

  // --- Fog ----------------------------------------------------------------

  /**
   * Fog of war.
   *
   * The design system bans gradients, and this is the one deliberate exception:
   * a hard-edged reveal circle reads as a rendering artefact rather than as
   * distance, and the whole point of the mechanic is that the road ahead fades
   * out of knowledge. It is confined to the gameplay surface; no menu uses one.
   */
  private drawFog(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cx = this.width / 2;
    const cy = this.height * 0.62;
    const outer = Math.max(this.width, this.height) * 0.78;
    const gradient = ctx.createRadialGradient(cx, cy, outer * 0.34, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(20,20,20,0)');
    gradient.addColorStop(0.62, 'rgba(20,20,20,0.55)');
    gradient.addColorStop(1, 'rgba(20,20,20,1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }
}

/**
 * Four wheels, each pivoting about its own centre.
 *
 * The first version translated to the middle of the front axle and rotated the
 * pair together. That is a pivot on the car's centreline, so steering swung one
 * wheel forwards and the other backwards -- the axle appeared to rotate about
 * the middle of the car, like a shopping trolley castor. A real steering axis
 * runs down through each wheel, so each one turns where it stands and neither
 * moves along the car.
 *
 * Rear wheels are drawn unsteered, which is also the point: with all four
 * present, the fronts turning alone is what reads as steering from above.
 */
export function drawWheels(
  ctx: CanvasRenderingContext2D,
  car: CarParams,
  steerAngle: number,
): void {
  // Wheel centres sit on the body edge, so half of each wheel shows against the
  // body and half against the road. That keeps them legible whichever of the
  // two the car's tint happens to resemble.
  const halfTrack = car.bodyWidth / 2;
  const length = Math.min(0.78, car.bodyLength * 0.19);
  const width = 0.26;

  ctx.fillStyle = INK;
  for (const side of [-1, 1]) {
    // Front: steered.
    ctx.save();
    ctx.translate(car.cgToFront, side * halfTrack);
    ctx.rotate(steerAngle);
    ctx.fillRect(-length / 2, -width / 2, length, width);
    ctx.restore();

    // Rear: fixed to the body.
    ctx.fillRect(-car.cgToRear - length / 2, side * halfTrack - width / 2, length, width);
  }
}

/**
 * Interpolate display state between two sim ticks.
 *
 * Only the fields that move: everything else is taken from the newer state.
 * Heading is interpolated through the shortest arc so a car crossing the
 * PI/-PI boundary does not spin a full turn on screen.
 */
function interpolate(prev: SimState, next: SimState, alpha: number): SimState {
  const a = clamp(alpha, 0, 1);
  return {
    ...next,
    x: lerp(prev.x, next.x, a),
    y: lerp(prev.y, next.y, a),
    heading: wrapAngle(prev.heading + wrapAngle(next.heading - prev.heading) * a),
    steerAngle: lerp(prev.steerAngle, next.steerAngle, a),
    speed: lerp(prev.speed, next.speed, a),
    slipAngle: lerp(prev.slipAngle, next.slipAngle, a),
  };
}
