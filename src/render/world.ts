import type { RouteData } from '../sim/types.ts';
import type { WorldTheme } from './themes.ts';

/**
 * The painted world: grass, meadows, forest and the road's shoulders, in the
 * flat-colour, ink-outlined style of the route posters.
 *
 * Built so the per-frame cost stays small on a phone:
 *
 * - The ground is two repeating textures painted once when the route loads,
 *   filled across the screen in world space. Two pattern fills a frame, however
 *   much grass there is.
 * - Trees are a handful of pre-painted stamps, placed once and bucketed on a
 *   grid; a frame draws only the buckets in view, each tree one drawImage.
 *
 * Nothing here is random at draw time, and nothing reaches the sim.
 */

/** Grass texture: 512px covering 32m, so 16px a metre. */
const GRASS_PX = 512;
const GRASS_M = 32;
/** Meadow/shade texture: 1024px covering 384m. */
const PATCH_PX = 1024;
const PATCH_M = 384;
/** Tree stamps are painted at this many pixels a metre. */
const TREE_PPM = 22;
/** Tree bucket size, metres. */
const CELL = 32;

interface Stamp {
  canvas: HTMLCanvasElement;
  /** Drawn size, metres. */
  size: number;
}

export class WorldArt {
  readonly routeId: string;
  private readonly theme: WorldTheme;
  private readonly grass: CanvasPattern | null;
  private readonly patches: CanvasPattern | null;
  private readonly stamps: Stamp[] = [];
  /** Trees by grid cell: flat [x, y, stamp, x, y, stamp, ...]. */
  private readonly cells = new Map<number, number[]>();

  constructor(route: RouteData, theme: WorldTheme, ctx: CanvasRenderingContext2D) {
    this.routeId = route.id;
    this.theme = theme;
    const rand = mulberry32(route.seed ^ 0x5eed);

    this.grass = ctx.createPattern(paintGrass(theme, rand), 'repeat');
    this.grass?.setTransform(new DOMMatrix().scale(GRASS_M / GRASS_PX));
    this.patches = ctx.createPattern(paintPatches(theme, rand), 'repeat');
    this.patches?.setTransform(new DOMMatrix().scale(PATCH_M / PATCH_PX));

    for (let i = 0; i < 4; i++) this.stamps.push(paintLeafTree(theme, rand, 2.2 + i * 0.45));
    for (let i = 0; i < 4; i++) this.stamps.push(paintConifer(theme, rand, 1.7 + i * 0.35));

    this.plantTrees(route, rand);
  }

  /** Grass and meadows over the whole view. `radius` is metres from (x, y) to a screen corner. */
  drawGround(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
    const r = Math.ceil(radius);
    ctx.fillStyle = this.theme.ground;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    if (this.grass) {
      ctx.fillStyle = this.grass;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    if (this.patches) {
      ctx.fillStyle = this.patches;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  drawTrees(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
    const c0x = Math.floor((x - radius) / CELL);
    const c1x = Math.floor((x + radius) / CELL);
    const c0y = Math.floor((y - radius) / CELL);
    const c1y = Math.floor((y + radius) / CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const stamp = this.stamps[list[i + 2]];
          const s = stamp.size;
          ctx.drawImage(stamp.canvas, list[i] - s / 2, list[i + 1] - s / 2, s, s);
        }
      }
    }
  }

  /**
   * Forest along the road: dense in some stretches, open meadow in others,
   * never on the tarmac or its shoulder -- including the other leg of a
   * hairpin, which is why placement checks every nearby road sample and not
   * just the one it grew from.
   */
  private plantTrees(route: RouteData, rand: () => number): void {
    const s = route.samples;
    const n = s.x.length;
    const road = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const key = cellKey(Math.floor(s.x[i] / CELL), Math.floor(s.y[i] / CELL));
      let list = road.get(key);
      if (!list) road.set(key, (list = []));
      list.push(i);
    }
    const clear = (x: number, y: number, r: number): boolean => {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const i of road.get(cellKey(cx + dx, cy + dy)) ?? []) {
            const min = s.halfWidth[i] + this.theme.vergeWidth + r;
            const ex = x - s.x[i];
            const ey = y - s.y[i];
            if (ex * ex + ey * ey < min * min) return false;
          }
        }
      }
      return true;
    };
    const density = valueNoise(rand, 90);
    const forest = this.theme.forest;
    const coniferShare = this.theme.coniferShare;

    for (let i = 0; i < n; i += 2) {
      const h = s.heading[i];
      const nx = -Math.sin(h);
      const ny = Math.cos(h);
      for (const side of [1, -1]) {
        for (let k = 0; k < 4; k++) {
          const lateral = s.halfWidth[i] + this.theme.vergeWidth + 1.5 + Math.pow(rand(), 1.4) * 55;
          const along = (rand() - 0.5) * 4;
          const x = s.x[i] + nx * lateral * side + Math.cos(h) * along;
          const y = s.y[i] + ny * lateral * side + Math.sin(h) * along;
          const d = density(x, y);
          // Forest where the noise is high, thinning to scattered trees.
          const chance = d < 1 - forest ? 0.06 : 0.85;
          if (rand() > chance) continue;
          const conifer = rand() < coniferShare;
          const variant = (conifer ? 4 : 0) + Math.floor(rand() * 4);
          if (!clear(x, y, this.stamps[variant].size * 0.3)) continue;
          const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(x, y, variant);
        }
      }
    }
  }
}

function cellKey(cx: number, cy: number): number {
  return (cx + 4096) * 8192 + (cy + 4096);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 0..1 noise over the world, one random value per `cell` metres. */
function valueNoise(rand: () => number, cell: number): (x: number, y: number) => number {
  const size = 64;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (ix: number, iy: number) => grid[(((iy % size) + size) % size) * size + (((ix % size) + size) % size)];
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = smooth(fx - ix);
    const ty = smooth(fy - iy);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
    return a + (b - a) * ty;
  };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [c, ctx];
}

/** Draw at (x, y) and at its wrapped copies, so the texture tiles without seams. */
function wrapped(size: number, x: number, y: number, reach: number, draw: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    if (x + ox < -reach || x + ox > size + reach) continue;
    for (const oy of [-size, 0, size]) {
      if (y + oy < -reach || y + oy > size + reach) continue;
      draw(x + ox, y + oy);
    }
  }
}

/** Short brush strokes and tufts over flat grass. */
function paintGrass(theme: WorldTheme, rand: () => number): HTMLCanvasElement {
  const [c, ctx] = canvas(GRASS_PX, GRASS_PX);
  ctx.fillStyle = theme.ground;
  ctx.fillRect(0, 0, GRASS_PX, GRASS_PX);
  ctx.lineCap = 'round';
  for (let i = 0; i < 1700; i++) {
    const x = rand() * GRASS_PX;
    const y = rand() * GRASS_PX;
    const len = 5 + rand() * 9;
    const angle = -1.1 + (rand() - 0.5) * 0.9;
    const bend = (rand() - 0.5) * 6;
    ctx.strokeStyle = theme.grassStrokes[Math.floor(rand() * theme.grassStrokes.length)];
    ctx.globalAlpha = 0.45 + rand() * 0.45;
    ctx.lineWidth = 1.5 + rand() * 1.8;
    wrapped(GRASS_PX, x, y, 16, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(angle) * len * 0.5 + bend, py + Math.sin(angle) * len * 0.5, px + Math.cos(angle) * len, py + Math.sin(angle) * len);
      ctx.stroke();
    });
  }
  // Small shrubs: a dark dot with a lit top.
  for (let i = 0; i < 26; i++) {
    const x = rand() * GRASS_PX;
    const y = rand() * GRASS_PX;
    const r = 5 + rand() * 7;
    wrapped(GRASS_PX, x, y, 16, (px, py) => {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = theme.leaf[0];
      disc(ctx, px, py, r);
      ctx.fillStyle = theme.leaf[1];
      disc(ctx, px - r * 0.2, py - r * 0.25, r * 0.7);
    });
  }
  ctx.globalAlpha = 1;
  return c;
}

/** Big soft patches of sunlit meadow and shaded ground. */
function paintPatches(theme: WorldTheme, rand: () => number): HTMLCanvasElement {
  const [c, ctx] = canvas(PATCH_PX, PATCH_PX);
  for (let i = 0; i < 34; i++) {
    const x = rand() * PATCH_PX;
    const y = rand() * PATCH_PX;
    const r = 50 + rand() * 120;
    const colour = rand() < 0.55 ? theme.meadow : theme.shade;
    const alpha = colour === theme.meadow ? 0.42 : 0.3;
    wrapped(PATCH_PX, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, r * 0.25, px, py, r);
      g.addColorStop(0, withAlpha(colour, alpha));
      g.addColorStop(1, withAlpha(colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  return c;
}

/** A broadleaf clump: ink rim, shadow side, body, sunlit top, and its shadow. */
function paintLeafTree(theme: WorldTheme, rand: () => number, radius: number): Stamp {
  const size = radius * 3;
  const px = Math.ceil(size * TREE_PPM);
  const [c, ctx] = canvas(px, px);
  const m = TREE_PPM;
  const cx = px / 2 - radius * 0.2 * m;
  const cy = px / 2 - radius * 0.2 * m;
  const lobes: [number, number, number][] = [];
  const count = 6 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.5;
    const d = radius * (0.42 + rand() * 0.12) * m;
    lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, radius * (0.5 + rand() * 0.12) * m]);
  }
  lobes.push([cx, cy, radius * 0.6 * m]);

  ctx.fillStyle = theme.treeShadow;
  for (const [x, y, r] of lobes) disc(ctx, x + radius * 0.45 * m, y + radius * 0.45 * m, r);
  ctx.fillStyle = theme.outline;
  for (const [x, y, r] of lobes) disc(ctx, x, y, r + 0.16 * m);
  ctx.fillStyle = theme.leaf[0];
  for (const [x, y, r] of lobes) disc(ctx, x, y, r);
  ctx.fillStyle = theme.leaf[1];
  for (const [x, y, r] of lobes) disc(ctx, x - r * 0.18, y - r * 0.2, r * 0.78);
  ctx.fillStyle = theme.leaf[2];
  for (const [x, y, r] of lobes) if (rand() < 0.6) disc(ctx, x - r * 0.38, y - r * 0.42, r * 0.34);
  return { canvas: c, size };
}

/** A pine from above: a ragged star, darker underneath, lit on top. */
function paintConifer(theme: WorldTheme, rand: () => number, radius: number): Stamp {
  const size = radius * 3;
  const px = Math.ceil(size * TREE_PPM);
  const [c, ctx] = canvas(px, px);
  const m = TREE_PPM;
  const cx = px / 2 - radius * 0.2 * m;
  const cy = px / 2 - radius * 0.2 * m;
  const points = 9 + Math.floor(rand() * 3);
  const spin = rand() * Math.PI;
  const star = (x: number, y: number, r: number) => {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = spin + (i / (points * 2)) * Math.PI * 2;
      const d = (i % 2 === 0 ? r : r * 0.62) * (0.92 + rand() * 0.16);
      if (i === 0) ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
      else ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
    ctx.closePath();
    ctx.fill();
  };
  const r = radius * m;
  ctx.fillStyle = theme.treeShadow;
  star(cx + r * 0.5, cy + r * 0.5, r);
  ctx.fillStyle = theme.outline;
  star(cx, cy, r + 0.16 * m);
  ctx.fillStyle = theme.conifer[0];
  star(cx, cy, r);
  ctx.fillStyle = theme.conifer[1];
  star(cx - r * 0.1, cy - r * 0.12, r * 0.68);
  ctx.fillStyle = theme.conifer[2];
  star(cx - r * 0.2, cy - r * 0.24, r * 0.32);
  return { canvas: c, size };
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}
