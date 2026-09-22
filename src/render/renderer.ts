import { sin, cos, wrapAngle, clamp, lerp } from '../sim/math/trig.ts';
import type { CarParams, RouteData, SimState } from '../sim/types.ts';
import { Camera, type CameraSettings } from './camera.ts';
import { getSprite } from './sprites.ts';
import { drawDecoration, type DecorationData } from './decoration.ts';
import { TyreSmoke } from './smoke.ts';
import { DirtSpray } from './dirt.ts';
import { WorldArt } from './world.ts';
import { themeFor, type WorldTheme } from './themes.ts';
import type { GhostPose } from '../ghost.ts';

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
/** How solid a ghost car is drawn. */
const GHOST_ALPHA = 0.42;
/** Dirt on the ink world: dun earth and a darker clod. */
const INK_DIRT: [string, string] = ['#8a7a60', '#5b5347'];

/** Metres of route drawn ahead of the car before the fog closes in. */
const REVEAL_AHEAD = 150;
/** Metres drawn behind, so the road does not vanish from under the car. */
const REVEAL_BEHIND = 40;

/** Max skid trail segments retained. ~6 seconds of continuous drifting. */
const MAX_SKID = 420;
/**
 * Road drawn past each end of the route, in metres: tarmac behind the start
 * line and on past the finish, carried straight on from the route's ends. The
 * sim never sees it -- a run starts on the line and ends at the other -- but a
 * road that stops dead at both lines looks like a set, not a place.
 */
const ROAD_BEFORE = 60;
const ROAD_AFTER = 160;

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
  private readonly dirt = new DirtSpray();

  /**
   * Route scenery. Held on the renderer, not on the route, so there is no field
   * anywhere in sim-visible data that could carry it into the simulation.
   */
  private decoration: DecorationData | null = null;

  /** Painted world for routes that have a theme; null draws the ink look. */
  private theme: WorldTheme | null = null;
  private world: WorldArt | null = null;
  private worldRoute = '';
  private road: DisplayRoad | null = null;

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

  /**
   * Paint the route's world ahead of time. Takes a few tens of milliseconds,
   * so it is called when the route screen opens rather than on the first frame.
   */
  prepareWorld(route: RouteData): void {
    if (this.worldRoute === route.id) return;
    this.worldRoute = route.id;
    this.theme = themeFor(route.id);
    this.road = extendRoad(route);
    this.world = this.theme ? new WorldArt(this.road.route, this.theme, this.ctx) : null;
  }

  clearTrails(): void {
    this.skidLeft.length = 0;
    this.skidRight.length = 0;
    this.smoke.clear();
    this.dirt.clear();
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
    ghost: GhostPose | null = null,
  ): void {
    const view = interpolate(prev, state, alpha);
    this.prepareWorld(route);
    const theme = this.theme;

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
    // Metres from the camera's focus to the farthest screen corner.
    const reach = Math.hypot(this.width / 2, this.height * 0.62) * px + 2;

    if (this.world) this.world.drawGround(ctx, this.camera.x, this.camera.y, reach);

    // Scenery first: it sits under the road surface and the racing line. A
    // painted world grows its own trees, so the route's ink discs are skipped.
    if (this.decoration) {
      const spacing = route.sampleSpacing;
      drawDecoration(
        ctx,
        this.decoration,
        state.sampleIndex - Math.round(REVEAL_BEHIND / spacing),
        state.sampleIndex + Math.round(REVEAL_AHEAD / spacing),
        px,
        theme ? { skipTrees: true, palette: { guardrail: theme.guardrail, post: theme.post } } : undefined,
      );
    }

    const road = this.road ?? extendRoad(route);
    if (theme) this.drawPaintedRoad(ctx, road, state.sampleIndex, theme);
    else this.drawRoad(ctx, road, state.sampleIndex, px);
    if (this.world) this.world.drawTrees(ctx, this.camera.x, this.camera.y, reach);
    this.drawScoringMarks(ctx, route, state, px);
    if (settings.showSkidMarks) this.drawSkids(ctx, px);
    // Dirt off the verge, under the car and its smoke.
    this.dirt.update(view, car, dtSeconds);
    this.dirt.draw(ctx, theme ? theme.dirt : INK_DIRT);

    // Smoke under the car, so the car is never lost in its own cloud.
    if (settings.showSmoke) {
      this.smoke.update(view, car, dtSeconds);
      this.smoke.draw(ctx, PAPER);
    }
    // The ghost under the player's car: when the two overlap, the one being
    // driven is the one that shows.
    if (ghost) this.drawGhost(ctx, ghost, px);
    this.drawCar(ctx, view, car, px, theme);

    ctx.restore();

    this.drawFog(ctx, theme);

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
    road: DisplayRoad,
    sampleIndex: number,
    px: number,
  ): void {
    const s = road.route.samples;
    const last = s.x.length - 1;
    const spacing = road.route.sampleSpacing;
    const here = sampleIndex + road.before;
    const from = Math.max(0, here - Math.round(REVEAL_BEHIND / spacing));
    const to = Math.min(last, here + Math.round(REVEAL_AHEAD / spacing));
    if (to <= from) return;
    const start = road.before;
    const finish = road.finish;

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

    // Start and finish lines.
    ctx.lineWidth = px * 5;
    ctx.strokeStyle = PAPER;
    for (const line of [start, finish]) {
      if (line < from || line > to) continue;
      const h = s.heading[line];
      const w = s.halfWidth[line];
      ctx.beginPath();
      ctx.moveTo(s.x[line] - sin(h) * w, s.y[line] + cos(h) * w);
      ctx.lineTo(s.x[line] + sin(h) * w, s.y[line] - cos(h) * w);
      ctx.stroke();
    }
  }

  /**
   * The road in a painted world: a pale shoulder, an ink rim, grey tarmac and
   * painted lines, sized in metres so it reads like the posters at any zoom.
   */
  private drawPaintedRoad(
    ctx: CanvasRenderingContext2D,
    road: DisplayRoad,
    sampleIndex: number,
    theme: WorldTheme,
  ): void {
    const s = road.route.samples;
    const last = s.x.length - 1;
    const spacing = road.route.sampleSpacing;
    const here = sampleIndex + road.before;
    const from = Math.max(0, here - Math.round(REVEAL_BEHIND / spacing));
    const to = Math.min(last, here + Math.round(REVEAL_AHEAD / spacing));
    if (to <= from) return;
    const start = road.before;
    const finish = road.finish;

    const band = (extra: number, colour: string) => {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const h = s.heading[i];
        const w = s.halfWidth[i] + extra;
        const x = s.x[i] - sin(h) * w;
        const y = s.y[i] + cos(h) * w;
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = to; i >= from; i--) {
        const h = s.heading[i];
        const w = s.halfWidth[i] + extra;
        ctx.lineTo(s.x[i] + sin(h) * w, s.y[i] - cos(h) * w);
      }
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
    };
    band(theme.vergeWidth, theme.verge);
    band(0.3, theme.outline);
    band(0, theme.tarmac);
    if (theme.kerbs) this.drawKerbs(ctx, road.route, from, to);

    // Edge lines, just inside the tarmac.
    ctx.lineWidth = 0.16;
    ctx.strokeStyle = theme.edgeLine;
    for (const side of [1, -1]) {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const h = s.heading[i];
        const w = (s.halfWidth[i] - 0.45) * side;
        const x = s.x[i] - sin(h) * w;
        const y = s.y[i] + cos(h) * w;
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Centre dashes, 3m on and 5m off.
    ctx.lineWidth = 0.14;
    ctx.strokeStyle = theme.centreLine;
    ctx.beginPath();
    for (let i = from - (from % 4); i <= to - 2; i += 4) {
      if (i < from) continue;
      ctx.moveTo(s.x[i], s.y[i]);
      ctx.lineTo(s.x[i + 1], s.y[i + 1]);
    }
    ctx.stroke();

    // Start: a painted white line across the road.
    if (start >= from && start <= to) {
      const h = s.heading[start];
      const w = s.halfWidth[start];
      ctx.save();
      ctx.translate(s.x[start], s.y[start]);
      ctx.rotate(h);
      ctx.fillStyle = PAPER;
      ctx.fillRect(-0.25, -w, 0.5, w * 2);
      ctx.restore();
    }

    // Finish: a chequered band across the road.
    if (finish >= from && finish <= to) {
      const h = s.heading[finish];
      const w = s.halfWidth[finish];
      const cells = Math.max(4, Math.round(w));
      const cell = (w * 2) / cells;
      ctx.save();
      ctx.translate(s.x[finish], s.y[finish]);
      ctx.rotate(h);
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < cells; i++) {
          ctx.fillStyle = (row + i) % 2 === 0 ? INK : PAPER;
          ctx.fillRect(row * cell - cell, -w + i * cell, cell, cell);
        }
      }
      ctx.restore();
    }
  }

  /**
   * Red and white kerbs along both edges wherever the road bends harder than a
   * 70m radius, in 2m blocks -- two paths a frame, one per colour.
   */
  private drawKerbs(ctx: CanvasRenderingContext2D, route: RouteData, from: number, to: number): void {
    const s = route.samples;
    const bend = 1 / 70;
    ctx.lineWidth = 0.9;
    for (const [colour, parity] of [[RED, 0], [PAPER, 1]] as const) {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      for (let i = Math.max(from, 1); i < to; i++) {
        if (i % 2 !== parity || Math.abs(s.curvature[i]) < bend) continue;
        for (const side of [1, -1]) {
          // On the inside of a corner tighter than the kerb's own offset, the
          // strip would fold over itself; leave that side bare.
          const inside = side * s.curvature[i] > 0;
          if (inside && 1 / Math.abs(s.curvature[i]) < s.halfWidth[i] + 1.5) continue;
          const w0 = (s.halfWidth[i] + 0.3 + 0.45) * side;
          const w1 = (s.halfWidth[i + 1] + 0.3 + 0.45) * side;
          ctx.moveTo(s.x[i] - sin(s.heading[i]) * w0, s.y[i] + cos(s.heading[i]) * w0);
          ctx.lineTo(s.x[i + 1] - sin(s.heading[i + 1]) * w1, s.y[i + 1] + cos(s.heading[i + 1]) * w1);
        }
      }
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

    // Zone start and end: a thin dashed red-and-white line across the road,
    // like a timing line, and the zone's number just past the start. Kept
    // light -- it marks a threshold, not a wall. The first version was a short
    // red post at each edge, which on the painted worlds nobody could see.
    for (let z = 0; z < route.driftZones.length; z++) {
      const zone = route.driftZones[z];
      for (const index of [zone.entryIndex, zone.exitIndex]) {
        if (index < from || index > to || index < 0 || index >= s.x.length) continue;
        const h = s.heading[index];
        const w = s.halfWidth[index];
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.translate(s.x[index], s.y[index]);
        ctx.rotate(h);
        const dash = 0.9;
        const count = Math.max(4, Math.round((w * 2) / dash));
        const step = (w * 2) / count;
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = i % 2 === 0 ? RED : PAPER;
          ctx.fillRect(-0.15, -w + i * step, 0.3, step);
        }
        if (index === zone.entryIndex) {
          // The number reads upright to a car driving through: the same turn
          // and flip as a sprite, since the world transform is mirrored.
          ctx.translate(1.6, w * 0.55);
          ctx.rotate(-Math.PI / 2);
          // Set at 26px and scaled to 1.3m: some browsers round tiny font sizes.
          ctx.scale(0.05, -0.05);
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = PAPER;
          ctx.font = "26px Bungee, 'Arial Black', sans-serif";
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(z + 1), 0, 0);
        }
        ctx.restore();
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
    view: Pick<SimState, 'x' | 'y' | 'heading' | 'steerAngle'>,
    car: CarParams,
    px: number,
    theme: WorldTheme | null,
  ): void {
    const len = car.bodyLength;
    const wid = car.bodyWidth;

    const sprite = getSprite(car.sprite?.path);

    // A soft shadow on the painted ground, so the car sits on the road rather
    // than floating over it. The sun is fixed in the world, like the trees'.
    // Cast by the drawing itself where there is one -- its own outline, blurred
    // -- and by a rounded, blurred box where there is not.
    if (theme) {
      ctx.save();
      ctx.translate(view.x + 0.35, view.y - 0.45);
      ctx.rotate(view.heading);
      if (sprite) {
        const shadow = softShadow(sprite, theme.treeShadow);
        const drawnWidth = (len * sprite.naturalWidth) / sprite.naturalHeight;
        // The pad around the silhouette, in metres at this car's scale.
        const pad = (SHADOW_PAD * len) / sprite.naturalHeight;
        ctx.rotate(-Math.PI / 2);
        ctx.scale(1, -1);
        ctx.drawImage(shadow, -drawnWidth / 2 - pad, -len / 2 - pad, drawnWidth + pad * 2, len + pad * 2);
      } else {
        const shadow = boxShadow(theme.treeShadow);
        // The box canvas is drawn at a fixed 20px per metre.
        const pad = SHADOW_PAD / 20;
        ctx.drawImage(shadow, -len / 2 - pad, -wid / 2 - pad, len + pad * 2, wid + pad * 2);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.rotate(view.heading);

    if (sprite) {
      // Wheels first, under the body: the drawing's tyres are fixed, so these
      // are what turn -- their corners show past the body when the car steers.
      drawWheels(ctx, car, view.steerAngle);

      // Supplied art faces "up"; the car's local +x is forward, so rotate the
      // image a quarter turn to line the two conventions up.
      ctx.rotate(-Math.PI / 2);
      ctx.scale(1, -1);
      // Sized by length and drawn at the art's own proportions: a drawing that
      // includes the mirrors is wider than the body, and stretching it to
      // bodyWidth would squash the car.
      const drawnWidth = (len * sprite.naturalWidth) / sprite.naturalHeight;
      ctx.drawImage(sprite, -drawnWidth / 2, -len / 2, drawnWidth, len);
    } else {
      // Placeholder: an oriented body with a windshield marker so the front is
      // unambiguous at a glance.
      ctx.fillStyle = car.tint ?? PAPER;
      ctx.fillRect(-len / 2, -wid / 2, len, wid);

      ctx.fillStyle = INK;
      ctx.fillRect(len * 0.06, -wid / 2 + 0.1, len * 0.2, wid - 0.2);

      // Paper rim on the ink world; ink rim on a painted one, like the trees.
      ctx.strokeStyle = theme ? theme.outline : PAPER;
      ctx.lineWidth = px * 2;
      ctx.strokeRect(-len / 2, -wid / 2, len, wid);

      drawWheels(ctx, car, view.steerAngle);
    }

    ctx.restore();
  }

  /**
   * Someone else's run: the same car drawing, see-through and without a
   * shadow, so it reads as a memory of a car rather than one to avoid. It is
   * not solid; the player drives straight through it.
   */
  private drawGhost(ctx: CanvasRenderingContext2D, ghost: GhostPose, px: number): void {
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    this.drawCar(ctx, ghost, ghost.car, px, null);
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
  private drawFog(ctx: CanvasRenderingContext2D, theme: WorldTheme | null): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cx = this.width / 2;
    const cy = this.height * 0.62;
    const outer = Math.max(this.width, this.height) * 0.78;
    const gradient = ctx.createRadialGradient(cx, cy, outer * 0.34, cx, cy, outer);
    // A painted world gets summer haze instead of the ink void.
    const [r, g, b] = theme ? theme.haze : [20, 20, 20];
    const edge = theme ? 0.92 : 1;
    gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
    gradient.addColorStop(0.62, `rgba(${r},${g},${b},${edge * 0.5})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},${edge})`);
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

/** The route as drawn: the real one, with straight road added before the start and after the finish. */
interface DisplayRoad {
  route: RouteData;
  /** Samples added before the start: the start line's index in the drawn road. */
  before: number;
  /** The finish line's index in the drawn road. */
  finish: number;
}

/**
 * Carry the road straight on from both ends, at the width it has there. Only
 * the drawing reads the result; the sim keeps the real route.
 */
function extendRoad(route: RouteData): DisplayRoad {
  const s = route.samples;
  const n = s.x.length;
  const step = route.sampleSpacing;
  const before = Math.round(ROAD_BEFORE / step);
  const after = Math.round(ROAD_AFTER / step);
  const out = { x: [] as number[], y: [] as number[], heading: [] as number[], curvature: [] as number[], halfWidth: [] as number[], grip: [] as number[] };
  const push = (i: number, x: number, y: number) => {
    out.x.push(x);
    out.y.push(y);
    out.heading.push(s.heading[i]);
    out.curvature.push(0);
    out.halfWidth.push(s.halfWidth[i]);
    out.grip.push(s.grip[i]);
  };
  for (let k = before; k > 0; k--) {
    push(0, s.x[0] - cos(s.heading[0]) * step * k, s.y[0] - sin(s.heading[0]) * step * k);
  }
  for (let i = 0; i < n; i++) {
    out.x.push(s.x[i]);
    out.y.push(s.y[i]);
    out.heading.push(s.heading[i]);
    out.curvature.push(s.curvature[i]);
    out.halfWidth.push(s.halfWidth[i]);
    out.grip.push(s.grip[i]);
  }
  const l = n - 1;
  for (let k = 1; k <= after; k++) {
    push(l, s.x[l] + cos(s.heading[l]) * step * k, s.y[l] + sin(s.heading[l]) * step * k);
  }
  return { route: { ...route, samples: out }, before, finish: before + l };
}

// --- Soft shadows -------------------------------------------------------------

/** Pixels of blur round a shadow silhouette, and the margin left for it. */
const SHADOW_BLUR = 14;
const SHADOW_PAD = 24;
const shadows = new Map<string, HTMLCanvasElement>();

/**
 * A car drawing's shadow: its own outline, filled with the shadow colour and
 * blurred, made once per drawing and colour and reused every frame.
 *
 * Drawn with the canvas shadow rather than a blur filter, which Safari does not
 * support on a canvas: the drawing is placed off the edge, so only its blurred
 * shadow lands on the canvas.
 */
function softShadow(sprite: HTMLImageElement, colour: string): HTMLCanvasElement {
  const key = `${sprite.src}|${colour}`;
  const cached = shadows.get(key);
  if (cached) return cached;
  const w = sprite.naturalWidth;
  const h = sprite.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w + SHADOW_PAD * 2;
  canvas.height = h + SHADOW_PAD * 2;
  const c = canvas.getContext('2d');
  if (c) {
    const away = canvas.width + 10;
    c.shadowColor = colour;
    c.shadowBlur = SHADOW_BLUR;
    c.shadowOffsetX = away;
    c.drawImage(sprite, SHADOW_PAD - away, SHADOW_PAD, w, h);
  }
  shadows.set(key, canvas);
  return canvas;
}

/** A rounded, blurred box for a car with no drawing: 20px per metre, 4.6m by 1.9m. */
function boxShadow(colour: string): HTMLCanvasElement {
  const key = `box|${colour}`;
  const cached = shadows.get(key);
  if (cached) return cached;
  const w = 92;
  const h = 38;
  const canvas = document.createElement('canvas');
  canvas.width = w + SHADOW_PAD * 2;
  canvas.height = h + SHADOW_PAD * 2;
  const c = canvas.getContext('2d');
  if (c) {
    const away = canvas.width + 10;
    c.shadowColor = colour;
    c.shadowBlur = SHADOW_BLUR;
    c.shadowOffsetX = away;
    c.fillStyle = '#000';
    c.beginPath();
    c.roundRect(SHADOW_PAD - away, SHADOW_PAD, w, h, 8);
    c.fill();
  }
  shadows.set(key, canvas);
  return canvas;
}
