import type { CarParams, SimState } from '../sim/types.ts';

/**
 * Dirt thrown up by wheels off the tarmac. Cosmetic, like the tyre smoke: it
 * reads the sim's wheels-off mask and draws, and may use Math.random.
 *
 * Each wheel in the dirt throws clods back and out from where it touches,
 * more the faster the car is going. Clods are small flat squares -- earth and
 * torn grass on the painted worlds -- that fly, slow and fall.
 */

const MAX_CLODS = 360;
/** Clods per second per wheel off the road, at full speed. */
const RATE = 100;
/** m/s at which a wheel throws the most. */
const FULL_SPEED = 18;

export class DirtSpray {
  private readonly x = new Float32Array(MAX_CLODS);
  private readonly y = new Float32Array(MAX_CLODS);
  private readonly vx = new Float32Array(MAX_CLODS);
  private readonly vy = new Float32Array(MAX_CLODS);
  private readonly age = new Float32Array(MAX_CLODS);
  private readonly life = new Float32Array(MAX_CLODS);
  private readonly size = new Float32Array(MAX_CLODS);
  private readonly shade = new Uint8Array(MAX_CLODS);
  private next = 0;
  private owed = 0;

  clear(): void {
    this.life.fill(0);
    this.owed = 0;
  }

  update(state: SimState, car: CarParams, dt: number): void {
    for (let i = 0; i < MAX_CLODS; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        continue;
      }
      const drag = Math.exp(-dt * 4);
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }

    const mask = state.wheelsOffMask;
    if (mask === 0 || state.speed < 2) return;
    const intensity = Math.min(1, state.speed / FULL_SPEED);
    this.owed += RATE * intensity * dt;
    const count = Math.floor(this.owed);
    this.owed -= count;
    if (count === 0) return;

    const cosH = Math.cos(state.heading);
    const sinH = Math.sin(state.heading);
    // World velocity of the car.
    const wx = state.vx * cosH - state.vy * sinH;
    const wy = state.vx * sinH + state.vy * cosH;
    const track = car.bodyWidth / 2;

    let bit = 1;
    for (const along of [car.cgToFront, -car.cgToRear]) {
      for (const side of [1, -1]) {
        if (mask & bit) {
          const px = state.x + cosH * along - sinH * track * side;
          const py = state.y + sinH * along + cosH * track * side;
          for (let n = 0; n < count; n++) {
            const i = this.next;
            this.next = (this.next + 1) % MAX_CLODS;
            // Thrown backwards relative to the car and out to the side, with a
            // wide scatter: some of the car's own speed, reversed.
            const back = 0.35 + Math.random() * 0.45;
            const out = (1 + Math.random() * 3) * side;
            this.x[i] = px + (Math.random() - 0.5) * 0.4;
            this.y[i] = py + (Math.random() - 0.5) * 0.4;
            this.vx[i] = -wx * back * 0.35 + wx * 0.25 - sinH * out + (Math.random() - 0.5) * 3;
            this.vy[i] = -wy * back * 0.35 + wy * 0.25 + cosH * out + (Math.random() - 0.5) * 3;
            this.age[i] = 0;
            this.life[i] = 0.45 + Math.random() * 0.6;
            this.size[i] = 0.2 + Math.random() * 0.3;
            this.shade[i] = Math.random() < 0.7 ? 0 : 1;
          }
        }
        bit <<= 1;
      }
    }
  }

  /** Earth, and a share of torn grass, fading as each clod lands. */
  draw(ctx: CanvasRenderingContext2D, colours: readonly [string, string]): void {
    ctx.save();
    for (let i = 0; i < MAX_CLODS; i++) {
      if (this.life[i] <= 0) continue;
      const t = this.age[i] / this.life[i];
      ctx.globalAlpha = 0.9 * (1 - t * t);
      ctx.fillStyle = colours[this.shade[i]];
      const s = this.size[i];
      ctx.fillRect(this.x[i] - s / 2, this.y[i] - s / 2, s, s);
    }
    ctx.restore();
  }
}
