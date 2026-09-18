import type { CarParams, SimState } from '../sim/types.ts';

/**
 * Tyre smoke. Purely cosmetic: it reads the sim and draws, and nothing it does
 * can reach a replay or a score, so it is free to use Math.random.
 *
 * How much smoke a slide makes grows with two things, as it does on a real
 * car: the angle (more sideways, more rubber scrubbed) and how long the slide
 * has lasted (tyres heat up, and a long drift ends in a cloud). A flick into a
 * corner makes a wisp; holding the angle through a hairpin fills the road.
 */

/** Most puffs alive at once. Oldest are recycled first. */
const MAX_PUFFS = 420;
/** Puffs per second, per rear wheel, at full angle and fully built up. */
const RATE = 46;
/** Seconds of continuous sliding for the smoke to build to full. */
const BUILD_TIME = 1.6;
/** Radians of slide at which a slide starts to smoke, and at which it smokes fully. */
const MIN_ANGLE = 0.14;
const FULL_ANGLE = 0.9;

export class TyreSmoke {
  private readonly x = new Float32Array(MAX_PUFFS);
  private readonly y = new Float32Array(MAX_PUFFS);
  private readonly vx = new Float32Array(MAX_PUFFS);
  private readonly vy = new Float32Array(MAX_PUFFS);
  private readonly age = new Float32Array(MAX_PUFFS);
  private readonly life = new Float32Array(MAX_PUFFS);
  private readonly size = new Float32Array(MAX_PUFFS);
  private readonly density = new Float32Array(MAX_PUFFS);
  private next = 0;
  private slideTime = 0;
  /** Fractional puffs carried between frames, so low rates still emit. */
  private owed = 0;

  /** Puffs currently in the air. */
  live(): number {
    let n = 0;
    for (let i = 0; i < MAX_PUFFS; i++) if (this.life[i] > 0) n++;
    return n;
  }

  clear(): void {
    this.life.fill(0);
    this.slideTime = 0;
    this.owed = 0;
  }

  update(state: SimState, car: CarParams, dt: number): void {
    // --- Age what is already in the air ---
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        continue;
      }
      // Smoke is dragged along a little, then hangs.
      const drag = Math.exp(-dt * 2.2);
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }

    // --- How hard the tyres are smoking ---
    const angle = Math.abs(state.slipAngle);
    const smoking = state.sliding && angle > MIN_ANGLE && state.speed > 4;
    this.slideTime = smoking ? this.slideTime + dt : Math.max(0, this.slideTime - dt * 3);
    if (!smoking) return;

    const build = Math.min(1, Math.max(0.12, this.slideTime / BUILD_TIME));
    const angleFactor = Math.min(1, (angle - MIN_ANGLE) / (FULL_ANGLE - MIN_ANGLE));
    const speedFactor = Math.min(1, state.speed / 15);
    const intensity = build * angleFactor * speedFactor;

    this.owed += RATE * intensity * dt;
    const count = Math.floor(this.owed);
    this.owed -= count;
    if (count === 0) return;

    // Rear wheels, world space.
    const cosH = Math.cos(state.heading);
    const sinH = Math.sin(state.heading);
    const rearX = state.x - cosH * car.cgToRear;
    const rearY = state.y - sinH * car.cgToRear;
    const halfTrack = car.bodyWidth / 2;
    // World velocity of the car: puffs leave with a fraction of it.
    const wx = state.vx * cosH - state.vy * sinH;
    const wy = state.vx * sinH + state.vy * cosH;

    for (let n = 0; n < count; n++) {
      for (const side of [-1, 1]) {
        const i = this.next;
        this.next = (this.next + 1) % MAX_PUFFS;
        const jitter = () => (Math.random() - 0.5) * 0.5;
        this.x[i] = rearX - sinH * halfTrack * side + jitter();
        this.y[i] = rearY + cosH * halfTrack * side + jitter();
        this.vx[i] = wx * 0.25 + (Math.random() - 0.5) * 2.4;
        this.vy[i] = wy * 0.25 + (Math.random() - 0.5) * 2.4;
        this.age[i] = 0;
        // Longer, bigger, thicker clouds from a long, deep slide.
        this.life[i] = 0.9 + 1.1 * build + Math.random() * 0.5;
        this.size[i] = 1.6 + 2.2 * build + Math.random() * 0.8;
        this.density[i] = 0.12 + 0.2 * intensity;
      }
    }
  }

  /** Draw in world space, under the car. Flat circles: the design system has no gradients. */
  draw(ctx: CanvasRenderingContext2D, colour: string): void {
    ctx.save();
    ctx.fillStyle = colour;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.life[i] <= 0) continue;
      const t = this.age[i] / this.life[i];
      // Grows fast, then keeps spreading as it thins out.
      const radius = 0.35 + this.size[i] * Math.sqrt(t);
      const alpha = this.density[i] * (1 - t) * (1 - t);
      if (alpha < 0.005) continue;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
