import type { RouteData } from '../sim/types.ts';
import { CARS } from '../data/cars.ts';
import type { WorldTheme } from './themes.ts';
import { mulberry32, valueNoise, type WorldArt } from './world.ts';
import { getSprite } from './sprites.ts';

/**
 * Built scenery: a town for a street course, a paddock and its walls for a
 * drift park.
 *
 * The route's spec marks where things go -- a junction on this straight, a
 * level crossing on that one, the pits along the run-up -- and this fills in
 * the rest from the route's seed: rows of buildings along every street, houses
 * with gardens in the quieter parts, parked cars, poles and wires, walls and
 * tyres round the park. Placed once when the route loads, bucketed on a grid,
 * and drawn from the buckets in view, in the flat-colour, ink-outlined style
 * of the rest of the world.
 *
 * Presentation only. Nothing here reaches the sim -- except that a drift
 * park's bells are drawn here, at the places the route (and so the sim) says
 * they hang.
 */

/** A place the spec marks on the route. Indices are the route's own samples. */
export interface SceneryFeature {
  kind: string;
  index: number;
  from: number;
  to: number;
  /** +1 left of the road, -1 right, 0 either or both. */
  side: number;
  x?: number;
  y?: number;
  radius?: number;
}

/** The road as drawn: the route with extra road past each end. Route index i is drawn index i + before. */
export interface SceneryRoad {
  route: RouteData;
  before: number;
  /** The finish line's drawn index. */
  finish: number;
}

/** Bucket size, metres. */
const CELL = 32;
/** Where the sun is: shadows fall this far, per metre of height, in world x and y. */
const SUN_X = 0.32;
const SUN_Y = -0.42;
const TAU = Math.PI * 2;

type PropKind =
  | 'building'
  | 'house'
  | 'shop'
  | 'lot'
  | 'car'
  | 'vending'
  | 'pole'
  | 'lamp'
  | 'island'
  | 'garage'
  | 'grandstand'
  | 'trailer'
  | 'tent'
  | 'tower'
  | 'tyres'
  | 'booth'
  | 'barrier';

/** A placed thing: a rectangle (centre, half sizes along and across its own axes, rotation), and how tall. */
interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  /** Half length along its own x, half depth along its own y. */
  hw: number;
  hh: number;
  rot: number;
  /** Metres tall, for the shadow. */
  height: number;
  /** Per-prop randomness for its details, fixed at placement. */
  seed: number;
  colour: string;
  /** Cars: which sprite. Garages: how many bays. */
  variant: number;
  /** Drawn this frame already (big props sit in several buckets). */
  frame: number;
}

/** A band across the town -- a railway or a canal -- and where the road crosses it. */
interface Corridor {
  kind: 'rail' | 'canal';
  x: number;
  y: number;
  /** Unit direction along the band. */
  dx: number;
  dy: number;
  half: number;
  length: number;
}

/** A side street: from the kerb, off the road, closed off at its mouth. */
interface Stub {
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
  half: number;
  /** The drawn road's index it leaves from. */
  index: number;
  side: number;
}

const ROOFS = ['#cfccc4', '#bdb9b0', '#d9d3c4', '#aab0b5', '#c7bca8', '#c1c8cc', '#b5a99a', '#d2c6b4'];
const TILES = ['#4a5563', '#6b3b2e', '#3f4a3c', '#2f3440', '#8a4a32', '#5b6e7c', '#55463c'];
const AWNINGS = ['#d8402a', '#2f6fb0', '#e7b534', '#3a8a4a', '#8a3f8f', '#e07a2e'];
const VENDING = ['#d8402a', '#2f6fb0', '#f4f1ea', '#2f9a5a'];
const PAINT = ['#d8402a', '#2f6fb0', '#f2c230', '#3a9a4a', '#f4f1ea', '#1d1d1f', '#8a3f8f'];
const BOARDS = ['#2f6fb0', '#f2c230', '#1d1d1f', '#3a9a4a', '#e07a2e'];
const PEOPLE = ['#d8402a', '#2f6fb0', '#f2c230', '#f4f1ea', '#1d1d1f', '#3a9a4a', '#e07a2e', '#8a3f8f', '#7fb0d8', '#c9a27a'];

export class Scenery {
  readonly routeId: string;
  private readonly theme: WorldTheme;
  private readonly road: SceneryRoad;
  private readonly cells = new Map<number, Prop[]>();
  /** Every road-like surface as sample points: [x, y, half width], bucketed, for keeping things off them. */
  private readonly surface = new Map<number, number[]>();
  private readonly corridors: Corridor[] = [];
  private readonly stubs: Stub[] = [];
  /** Where the road crosses a corridor: drawn index, and which. */
  private readonly crossings: { index: number; corridor: Corridor }[] = [];
  /** Zebra crossings over the road, by drawn index. */
  private readonly zebras: number[] = [];
  /** Manholes: drawn index and offset. */
  private readonly manholes: [number, number][] = [];
  /** Overhead wires between poles: flat [x0, y0, x1, y1, ...]. */
  private readonly wires: number[] = [];
  private readonly features: SceneryFeature[];
  private frame = 0;
  /** Painted zones round a drift park's corners: drawn index ranges and the outside. */
  private readonly outerZones: { from: number; to: number; side: number; apex: number }[] = [];
  /** When each bell was last rung, seconds on the renderer's clock; -1 never. */
  private readonly bellRung: number[] = [];

  constructor(road: SceneryRoad, features: SceneryFeature[], theme: WorldTheme, world: WorldArt | null) {
    this.road = road;
    this.routeId = road.route.id;
    this.theme = theme;
    this.features = features.map((f) => ({ ...f, index: f.index + road.before, from: f.from + road.before, to: f.to + road.before }));
    const rand = mulberry32(road.route.seed ^ 0x51ce);

    this.indexRoad();
    if (theme.style === 'street') this.buildTown(rand, world);
    else this.buildPark(rand, world);
    for (let i = 0; i < (road.route.bells?.length ?? 0); i++) this.bellRung.push(-1);
  }

  // --- The layers -------------------------------------------------------------

  /** Under the road: lots, side streets, the railway's ballast, the canal. */
  drawGround(ctx: CanvasRenderingContext2D, x: number, y: number, reach: number): void {
    for (const c of this.corridors) this.drawCorridor(ctx, c);
    for (const s of this.stubs) this.drawStub(ctx, s);
    this.eachProp(x, y, reach, (p) => {
      if (p.kind === 'lot') this.drawLot(ctx, p);
      else if (p.kind === 'island') this.drawIsland(ctx, p);
    });
  }

  /** On the road surface, over the tarmac: crossings, zebras, rails, painted zones. */
  drawRoadPaint(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const s = this.road.route.samples;
    if (this.theme.style === 'street') {
      for (const st of this.stubs) this.drawStubMouth(ctx, st, from, to);
      for (const i of this.zebras) if (i >= from && i <= to) this.drawZebra(ctx, i, s.halfWidth[i] - 0.5, 4);
      for (const [i, off] of this.manholes) {
        if (i < from || i > to) continue;
        const [mx, my] = this.at(i, off);
        ctx.fillStyle = '#3f4146';
        disc(ctx, mx, my, 0.42);
        ctx.strokeStyle = '#6b6d72';
        ctx.lineWidth = 0.07;
        ring(ctx, mx, my, 0.34);
      }
      for (const cr of this.crossings) if (cr.index >= from && cr.index <= to) this.drawCrossingOnRoad(ctx, cr.index, cr.corridor);
    } else {
      for (const z of this.outerZones) {
        if (z.to < from || z.from > to) continue;
        this.drawOuterZone(ctx, z, from, to);
      }
      this.drawParkLettering(ctx, from, to);
    }
  }

  /** Standing things: buildings, walls, tyres, grandstands, cars. Shadows first, then bodies. */
  drawProps(ctx: CanvasRenderingContext2D, x: number, y: number, reach: number, from: number, to: number): void {
    if (this.theme.style === 'park') this.drawWalls(ctx, from, to);
    this.frame++;
    const frame = this.frame;
    const list: Prop[] = [];
    this.eachProp(x, y, reach, (p) => {
      if (p.kind === 'lot' || p.kind === 'island') return;
      list.push(p);
    });
    // Shadows.
    ctx.fillStyle = this.theme.treeShadow;
    for (const p of list) {
      if (p.height <= 0) continue;
      const ox = SUN_X * p.height;
      const oy = SUN_Y * p.height;
      if (p.kind === 'pole' || p.kind === 'lamp' || p.kind === 'tower') {
        // A pole's shadow is a line, not a slab.
        ctx.save();
        ctx.strokeStyle = this.theme.treeShadow;
        ctx.lineWidth = p.kind === 'tower' ? 0.5 : 0.22;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + ox, p.y + oy);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      shadowRect(ctx, p, ox, oy);
    }
    for (const p of list) {
      p.frame = frame;
      this.drawProp(ctx, p);
    }
  }

  /** Over the cars: wires, gantries, the bells. `time` in seconds, for a bell's swing. */
  drawOverhead(ctx: CanvasRenderingContext2D, from: number, to: number, time: number, x: number, y: number, reach: number): void {
    if (this.wires.length > 0) {
      ctx.strokeStyle = 'rgba(28,28,30,0.55)';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      const r2 = (reach + 40) * (reach + 40);
      for (let i = 0; i < this.wires.length; i += 4) {
        const mx = (this.wires[i] + this.wires[i + 2]) / 2 - x;
        const my = (this.wires[i + 1] + this.wires[i + 3]) / 2 - y;
        if (mx * mx + my * my > r2) continue;
        // Three wires a span, sagging a touch.
        for (let k = -1; k <= 1; k++) {
          const nx = -(this.wires[i + 3] - this.wires[i + 1]);
          const ny = this.wires[i + 2] - this.wires[i];
          const len = Math.hypot(nx, ny) || 1;
          const o = k * 0.28;
          const ax = this.wires[i] + (nx / len) * o;
          const ay = this.wires[i + 1] + (ny / len) * o;
          const bx = this.wires[i + 2] + (nx / len) * o;
          const by = this.wires[i + 3] + (ny / len) * o;
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo((ax + bx) / 2 + 0.3, (ay + by) / 2 - 0.4, bx, by);
        }
      }
      ctx.stroke();
    }
    if (this.theme.style === 'park') {
      this.drawGantries(ctx, from, to);
      this.drawBells(ctx, from, to, time);
    }
  }

  /** A bell was rung: start it swinging. */
  ring(bell: number, time: number): void {
    if (bell >= 0 && bell < this.bellRung.length) this.bellRung[bell] = time;
  }

  /** A new run: every bell still. */
  resetBells(): void {
    this.bellRung.fill(-1);
  }

  // --- Placement: common ------------------------------------------------------

  private indexRoad(): void {
    const s = this.road.route.samples;
    for (let i = 0; i < s.x.length; i++) this.addSurface(s.x[i], s.y[i], s.halfWidth[i] + this.theme.vergeWidth);
  }

  private addSurface(x: number, y: number, half: number): void {
    const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    let list = this.surface.get(key);
    if (!list) this.surface.set(key, (list = []));
    list.push(x, y, half);
  }

  /** Clear ground at (x, y): at least `margin` metres off any road, pavement, side street or corridor. */
  private clearAt(x: number, y: number, margin: number): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.surface.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const ex = x - list[i];
          const ey = y - list[i + 1];
          const min = list[i + 2] + margin;
          if (ex * ex + ey * ey < min * min) return false;
        }
      }
    }
    for (const c of this.corridors) {
      const ex = x - c.x;
      const ey = y - c.y;
      const along = ex * c.dx + ey * c.dy;
      const across = -ex * c.dy + ey * c.dx;
      if (Math.abs(along) < c.length && Math.abs(across) < c.half + margin) return false;
    }
    return true;
  }

  /** Room for a rectangle: clear of the roads all round its edge, and of everything placed. */
  private fits(p: Pick<Prop, 'x' | 'y' | 'hw' | 'hh' | 'rot'>, margin: number, on?: Prop): boolean {
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    const stepsW = Math.max(1, Math.ceil((p.hw * 2) / 3));
    const stepsH = Math.max(1, Math.ceil((p.hh * 2) / 3));
    for (let i = 0; i <= stepsW; i++) {
      for (let j = 0; j <= stepsH; j++) {
        if (i !== 0 && i !== stepsW && j !== 0 && j !== stepsH && (i + j) % 2 === 1) continue;
        const lx = -p.hw + (2 * p.hw * i) / stepsW;
        const ly = -p.hh + (2 * p.hh * j) / stepsH;
        if (!this.clearAt(p.x + c * lx - s * ly, p.y + s * lx + c * ly, margin)) return false;
      }
    }
    // Everything already standing nearby.
    const reach = Math.hypot(p.hw, p.hh);
    const c0x = Math.floor((p.x - reach) / CELL);
    const c1x = Math.floor((p.x + reach) / CELL);
    const c0y = Math.floor((p.y - reach) / CELL);
    const c1y = Math.floor((p.y + reach) / CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const q of this.cells.get(cellKey(cx, cy)) ?? []) {
          if (q === on || (q.kind === 'car' && p.hw > 3)) continue;
          if (overlaps(p, q, on ? 0.3 : 0.6)) return false;
        }
      }
    }
    return true;
  }

  private add(p: Omit<Prop, 'frame'>): Prop {
    const prop: Prop = { ...p, frame: -1 };
    const reach = Math.hypot(p.hw, p.hh);
    const c0x = Math.floor((p.x - reach) / CELL);
    const c1x = Math.floor((p.x + reach) / CELL);
    const c0y = Math.floor((p.y - reach) / CELL);
    const c1y = Math.floor((p.y + reach) / CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = cellKey(cx, cy);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(prop);
      }
    }
    return prop;
  }

  private eachProp(x: number, y: number, reach: number, fn: (p: Prop) => void): void {
    const frame = ++this.frame;
    const c0x = Math.floor((x - reach) / CELL);
    const c1x = Math.floor((x + reach) / CELL);
    const c0y = Math.floor((y - reach) / CELL);
    const c1y = Math.floor((y + reach) / CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const p of this.cells.get(cellKey(cx, cy)) ?? []) {
          if (p.frame === frame) continue;
          p.frame = frame;
          fn(p);
        }
      }
    }
  }

  /** A point `offset` metres left of the drawn road at sample i. */
  private at(i: number, offset: number): [number, number] {
    const s = this.road.route.samples;
    const h = s.heading[i];
    return [s.x[i] - Math.sin(h) * offset, s.y[i] + Math.cos(h) * offset];
  }

  private nearFeature(i: number, kinds: string[], pad: number): boolean {
    for (const f of this.features) {
      if (!kinds.includes(f.kind)) continue;
      const centre = f.kind === 'junction' || f.kind === 'rail' || f.kind === 'canal' ? f.index : -1;
      if (centre >= 0 ? Math.abs(i - centre) < pad : i >= f.from - pad && i <= f.to + pad) return true;
    }
    return false;
  }

  // --- The town ---------------------------------------------------------------

  private buildTown(rand: () => number, world: WorldArt | null): void {
    const s = this.road.route.samples;
    const n = s.x.length;
    const verge = this.theme.vergeWidth;

    // The railway and the canal: a long band square across the road, wherever
    // it then meets the road again it gets a crossing (or a bridge) too.
    for (const f of this.features) {
      if (f.kind !== 'rail' && f.kind !== 'canal') continue;
      const h = s.heading[f.index];
      const corridor: Corridor = {
        kind: f.kind,
        x: s.x[f.index],
        y: s.y[f.index],
        dx: -Math.sin(h),
        dy: Math.cos(h),
        half: f.kind === 'rail' ? 4.2 : 8,
        length: 900,
      };
      this.corridors.push(corridor);
      let last = 0;
      for (let i = 1; i < n; i++) {
        const side = (k: number) => -(s.x[k] - corridor.x) * corridor.dy + (s.y[k] - corridor.y) * corridor.dx;
        const a = side(i - 1);
        const b = side(i);
        if ((a <= 0) === (b <= 0)) continue;
        const along = (s.x[i] - corridor.x) * corridor.dx + (s.y[i] - corridor.y) * corridor.dy;
        if (Math.abs(along) > corridor.length) continue;
        this.crossings.push({ index: i, corridor });
        last = i;
      }
      void last;
    }

    // The roundabout's island.
    for (const f of this.features) {
      if (f.kind !== 'roundabout' || f.x === undefined || f.y === undefined || f.radius === undefined) continue;
      const half = s.halfWidth[f.index];
      const r = f.radius - half - 1.3;
      this.add({ kind: 'island', x: f.x, y: f.y, hw: r, hh: r, rot: 0, height: 0, seed: rand(), colour: '#7fa653', variant: 0 });
      this.addSurface(f.x, f.y, r);
      world?.plant(f.x, f.y, 'leaf', 1);
    }

    // Side streets, closed off where they meet the course -- except where the
    // road crosses the railway or the canal, which runs off the same way.
    for (const f of this.features) {
      if (f.kind !== 'junction') continue;
      if (this.crossings.some((c) => Math.abs(c.index - f.index) < 16)) continue;
      const h = s.heading[f.index];
      const [ex, ey] = this.at(f.index, f.side * (s.halfWidth[f.index] + 0.3));
      const stub: Stub = { x: ex, y: ey, dx: -Math.sin(h) * f.side, dy: Math.cos(h) * f.side, length: 70, half: 3.2, index: f.index, side: f.side };
      this.stubs.push(stub);
      for (let d = 0; d <= stub.length; d += 2) this.addSurface(ex + stub.dx * d, ey + stub.dy * d, stub.half + 2.4);
      // A zebra over the main road just short of the junction.
      this.zebras.push(Math.max(0, f.index - 7));
    }
    for (const f of this.features) if (f.kind === 'shops') this.zebras.push(Math.round((f.from + f.to) / 2) + 6);

    // Parking lots: tarmac, bays and parked cars, with the machine and the sign.
    for (const f of this.features) {
      if (f.kind !== 'lot') continue;
      const h = s.heading[f.index];
      // As big as the ground there allows: the canal or the next street may be close.
      let lot: Omit<Prop, 'frame'> | null = null;
      let along = 0;
      let depth = 0;
      let lx = 0;
      let ly = 0;
      for (const scale of [1, 0.8, 0.62]) {
        along = Math.min(38, (f.to - f.from) * this.road.route.sampleSpacing * 0.9) * scale;
        depth = scale < 0.7 ? 12.4 : 22;
        [lx, ly] = this.at(f.index, f.side * (s.halfWidth[f.index] + verge + 0.4 + depth / 2));
        const tryLot = { kind: 'lot' as const, x: lx, y: ly, hw: along / 2, hh: depth / 2, rot: h, height: 0, seed: rand(), colour: '#5d5f64', variant: f.side };
        if (this.fits(tryLot, 0.2)) {
          lot = tryLot;
          break;
        }
      }
      if (!lot) continue;
      this.add(lot);
      // Parked cars: two rows of bays, nose in, about two in three taken.
      const c = Math.cos(h);
      const sn = Math.sin(h);
      const nx = -sn * f.side;
      const ny = c * f.side;
      for (const row of depth > 15 ? [-1, 1] : [f.side]) {
        for (let b = -along / 2 + 1.5; b < along / 2 - 1.2; b += 2.6) {
          if (rand() < 0.35) continue;
          const depthAt = row < 0 ? -depth / 2 + 3.2 : depth / 2 - 3.2;
          const px = lx + c * b + nx * depthAt;
          const py = ly + sn * b + ny * depthAt;
          const facing = h + (row < 0 ? -1 : 1) * f.side * (Math.PI / 2) + (rand() < 0.5 ? Math.PI : 0);
          this.add(parkedCar(px, py, facing, rand));
        }
      }
    }

    // Street furniture: poles and wires down one side, lamps down the other,
    // trees in the pavement on some streets, vending machines outside shops.
    const quiet = valueNoise(rand, 160);
    const leafy = valueNoise(rand, 120);
    let lastPole: [number, number] | null = null;
    for (let i = 0; i < n; i += 1) {
      const busy = this.nearFeature(i, ['junction', 'rail', 'canal', 'lot'], 8) || this.nearRoundabout(i);
      if (i % 14 === 0) {
        if (busy) {
          lastPole = null;
        } else {
          const [px, py] = this.at(i, (s.halfWidth[i] + verge - 0.35));
          if (this.clearOfOtherRoad(px, py, i, 1.2)) {
            this.add({ kind: 'pole', x: px, y: py, hw: 0.2, hh: 0.2, rot: 0, height: 9, seed: rand(), colour: '#58585a', variant: 0 });
            if (lastPole && Math.hypot(px - lastPole[0], py - lastPole[1]) < 36) this.wires.push(lastPole[0], lastPole[1], px, py);
            lastPole = [px, py];
          } else {
            lastPole = null;
          }
        }
      }
      if (i % 15 === 7 && !busy) {
        const [lx, ly] = this.at(i, -(s.halfWidth[i] + 0.55));
        if (this.clearOfOtherRoad(lx, ly, i, 1)) {
          this.add({ kind: 'lamp', x: lx, y: ly, hw: 0.15, hh: 0.15, rot: s.heading[i] - Math.PI / 2, height: 7, seed: rand(), colour: '#4a4a4c', variant: 0 });
        }
      }
      if (i % 7 === 3 && !busy && leafy(s.x[i], s.y[i]) > 0.55 && world) {
        for (const side of [1, -1]) {
          const [tx, ty] = this.at(i, side * (s.halfWidth[i] + verge * 0.55));
          if (this.clearOfOtherRoad(tx, ty, i, 0.8)) world.plant(tx, ty, 'street', rand() * 2);
        }
      }
      if (i % 40 === 20 && rand() < 0.25) this.manholes.push([i, (rand() - 0.5) * s.halfWidth[i]]);
    }

    // Blossom along the canal banks.
    for (const c of this.corridors) {
      if (c.kind !== 'canal' || !world) continue;
      for (let d = -c.length; d <= c.length; d += 7) {
        for (const side of [1, -1]) {
          const x = c.x + c.dx * d - c.dy * side * (c.half + 2.2);
          const y = c.y + c.dy * d + c.dx * side * (c.half + 2.2);
          if (this.fits({ x, y, hw: 1, hh: 1, rot: 0 }, 0.5)) {
            world.plant(x, y, 'blossom', rand() * 3);
            this.addSurface(x, y, 1.6);
          }
        }
      }
    }

    // The buildings: a row along every street, set back behind the pavement,
    // then rows behind those, then whatever fills the blocks between.
    const shops = this.features.filter((f) => f.kind === 'shops');
    const shopAt = (i: number) => shops.some((f) => i >= f.from - 4 && i <= f.to + 4);
    for (const side of [1, -1]) {
      let next = 0;
      for (let i = 0; i < n; i++) {
        if (i < next) continue;
        const h = s.heading[i];
        const residential = quiet(s.x[i], s.y[i]) > 0.52 && !shopAt(i);
        const shop = shopAt(i);
        const w = residential ? 10 + rand() * 4 : 8 + rand() * 10;
        const d = residential ? 12 + rand() * 4 : 9 + rand() * 9;
        const set = s.halfWidth[i] + verge + 0.5 + rand() * (residential ? 1.5 : 0.8);
        const [ax, ay] = this.at(i, side * (set + d / 2));
        const p = {
          x: ax + Math.cos(h) * (w / 2),
          y: ay + Math.sin(h) * (w / 2),
          hw: w / 2,
          hh: d / 2,
          rot: h,
        };
        if (!this.fits(p, 0.4)) {
          next = i + 1;
          continue;
        }
        if (residential) {
          this.add({ ...p, kind: 'house', height: 6, seed: rand(), colour: pick(TILES, rand), variant: side });
        } else if (shop) {
          this.add({ ...p, kind: 'shop', height: 5 + rand() * 6, seed: rand(), colour: pick(ROOFS, rand), variant: side });
          if (rand() < 0.6) {
            const [vx, vy] = this.at(i, side * (s.halfWidth[i] + verge - 0.5));
            const vm = { kind: 'vending' as const, x: vx + Math.cos(h) * (1 + rand() * (w - 2)), y: vy + Math.sin(h) * (1 + rand() * (w - 2)), hw: 0.5, hh: 0.4, rot: h, height: 1.8, seed: rand(), colour: pick(VENDING, rand), variant: 0 };
            this.add(vm);
          }
        } else {
          this.add({ ...p, kind: 'building', height: 8 + rand() * 18, seed: rand(), colour: pick(ROOFS, rand), variant: side });
        }
        next = i + Math.ceil((w + 0.6 + rand() * 2.5) / this.road.route.sampleSpacing);

        // A second row behind this one.
        const w2 = 10 + rand() * 12;
        const d2 = 10 + rand() * 12;
        const set2 = set + d + 1.5 + rand() * 4;
        const [bx, by] = this.at(i, side * (set2 + d2 / 2));
        const q = { x: bx + Math.cos(h) * (w2 / 2), y: by + Math.sin(h) * (w2 / 2), hw: w2 / 2, hh: d2 / 2, rot: h };
        if (this.fits(q, 0.6)) {
          const home = residential && rand() < 0.7;
          this.add({ ...q, kind: home ? 'house' : 'building', height: home ? 6 : 10 + rand() * 24, seed: rand(), colour: home ? pick(TILES, rand) : pick(ROOFS, rand), variant: side });
        }
      }
    }

    // Filling the blocks: bigger buildings further out, square to the nearest street.
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        const side = rand() < 0.5 ? 1 : -1;
        const h = s.heading[i];
        const out = s.halfWidth[i] + verge + 22 + rand() * 60;
        const [x, y] = this.at(i, side * out);
        const w = 12 + rand() * 20;
        const d = 12 + rand() * 18;
        const p = { x: x + Math.cos(h) * (rand() - 0.5) * 8, y: y + Math.sin(h) * (rand() - 0.5) * 8, hw: w / 2, hh: d / 2, rot: h };
        if (!this.fits(p, 1)) continue;
        const home = quiet(x, y) > 0.55 && rand() < 0.75;
        if (home) this.add({ ...p, hw: 5 + rand() * 2, hh: 5.5 + rand() * 2, kind: 'house', height: 6, seed: rand(), colour: pick(TILES, rand), variant: side });
        else this.add({ ...p, kind: 'building', height: 10 + rand() * 30, seed: rand(), colour: pick(ROOFS, rand), variant: side });
      }
    }
  }

  private nearRoundabout(i: number): boolean {
    return this.features.some((f) => f.kind === 'roundabout' && i >= f.from - 10 && i <= f.to + 10);
  }

  /** Clear of every other stretch of road: street furniture on one street must not stand in the next. */
  private clearOfOtherRoad(x: number, y: number, i: number, margin: number): boolean {
    const s = this.road.route.samples;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.surface.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 3) {
          // Its own stretch of road is meant to be near: only the others count.
          if (Math.hypot(list[k] - s.x[i], list[k + 1] - s.y[i]) <= 30) continue;
          const d = Math.hypot(x - list[k], y - list[k + 1]);
          if (d < list[k + 2] + margin) return false;
        }
      }
    }
    for (const c of this.corridors) {
      const ex = x - c.x;
      const ey = y - c.y;
      if (Math.abs(-ex * c.dy + ey * c.dx) < c.half + margin && Math.abs(ex * c.dx + ey * c.dy) < c.length) return false;
    }
    return true;
  }

  // --- The drift park -----------------------------------------------------------

  private buildPark(rand: () => number, world: WorldArt | null): void {
    const route = this.road.route;
    const s = route.samples;
    const before = this.road.before;
    const wall = this.theme.vergeWidth + 0.9;

    // The painted zones: every real corner's outside, and its clipping box.
    for (const c of route.corners) {
      if (c.severity < 3) continue;
      // Corners are the sim route's; this road is the drawn one.
      this.outerZones.push({ from: c.startIndex + before, to: c.endIndex + before, side: -c.sign, apex: c.apexIndex + before });
    }
    // The walls are drawn from the road itself; keep everything else behind them.
    for (let i = 0; i < s.x.length; i++) this.addSurface(s.x[i], s.y[i], s.halfWidth[i] + wall + 1.5);

    const along = (f: SceneryFeature) => Math.min(90, (f.to - f.from) * route.sampleSpacing * 0.8);
    for (const f of this.features) {
      const h = s.heading[f.index];
      const edge = s.halfWidth[f.index] + wall;
      if (f.kind === 'pits') {
        const len = along(f);
        const depth = 11;
        const [x, y] = this.at(f.index, f.side * (edge + 9 + depth / 2));
        const bays = Math.max(3, Math.floor(len / 6.5));
        const garage = { kind: 'garage' as const, x, y, hw: len / 2, hh: depth / 2, rot: h, height: 6, seed: rand(), colour: '#e9e6de', variant: bays * f.side };
        if (!this.fits(garage, 0)) continue;
        this.add(garage);
        // The pit lane in front of it.
        const [lx, ly] = this.at(f.index, f.side * (edge + 4.6));
        this.add({ kind: 'lot', x: lx, y: ly, hw: len / 2, hh: 3.6, rot: h, height: 0, seed: rand(), colour: '#55575c', variant: 0 });
        // Cars in front of the open garages.
        for (let b = 0; b < bays; b++) {
          if (rand() < 0.35) continue;
          const t = -len / 2 + (b + 0.5) * (len / bays);
          const [cx, cy] = this.at(f.index, f.side * (edge + 5));
          this.add(parkedCar(cx + Math.cos(h) * t, cy + Math.sin(h) * t, h + f.side * (Math.PI / 2) + (rand() < 0.5 ? Math.PI : 0), rand));
        }
      } else if (f.kind === 'grandstand') {
        const len = Math.min(70, along(f));
        const depth = 13;
        const [x, y] = this.at(f.index, f.side * (edge + 6 + depth / 2));
        const stand = { kind: 'grandstand' as const, x, y, hw: len / 2, hh: depth / 2, rot: h, height: 9, seed: rand(), colour: '#d4d0c6', variant: f.side };
        if (this.fits(stand, 0)) this.add(stand);
      } else if (f.kind === 'paddock') {
        // A tarmac apron as big as the ground allows, and the teams on it.
        for (const [hw, hh, out] of [[24, 14, 22], [18, 11, 18], [14, 9, 15], [24, 14, 36], [18, 11, 30]]) {
          const [x, y] = this.at(f.index, f.side * (edge + out));
          const apron = { kind: 'lot' as const, x, y, hw, hh, rot: h, height: 0, seed: rand(), colour: '#57595e', variant: 0 };
          if (!this.fits(apron, 0)) continue;
          this.populate(this.add(apron), rand);
          break;
        }
      }
    }

    // Light towers, and the timing booth at the start.
    for (let i = 20, n = 0; i < s.x.length; i += 70, n++) {
      const side = n % 2 === 0 ? 1 : -1;
      const [x, y] = this.at(i, side * (s.halfWidth[i] + wall + 6));
      if (this.clearAt(x, y, 0.5)) this.add({ kind: 'tower', x, y, hw: 0.4, hh: 0.4, rot: s.heading[i], height: 22, seed: rand(), colour: '#8a8a8c', variant: side });
    }
    {
      const i = before;
      const [x, y] = this.at(i, -(s.halfWidth[i] + wall + 5));
      this.add({ kind: 'booth', x, y, hw: 3.5, hh: 3, rot: s.heading[i], height: 7, seed: rand(), colour: '#f4f1ea', variant: 0 });
    }

    // More aprons wherever the ground between the legs of the track allows:
    // the infield of a drift park is a paddock.
    for (let i = 0; i < s.x.length; i += 12) {
      for (const side of [1, -1]) {
        const h = s.heading[i];
        for (let tries = 0; tries < 3; tries++) {
          const hw = 9 + rand() * 12;
          const hh = 6 + rand() * 6;
          const [x, y] = this.at(i, side * (s.halfWidth[i] + wall + 6 + hh + rand() * 30));
          const apron = { kind: 'lot' as const, x, y, hw, hh, rot: h, height: 0, seed: rand(), colour: '#595b60', variant: 0 };
          if (!this.fits(apron, 1)) continue;
          this.populate(this.add(apron), rand);
          break;
        }
      }
    }

    // Parked cars and tyre stacks dotted round the paddock edges, and trees beyond.
    for (let i = 0; i < s.x.length; i += 9) {
      for (const side of [1, -1]) {
        if (rand() < 0.75) continue;
        const [x, y] = this.at(i, side * (s.halfWidth[i] + wall + 8 + rand() * 20));
        if (!this.clearAt(x, y, 3)) continue;
        if (rand() < 0.5) {
          const car = parkedCar(x, y, s.heading[i] + (rand() - 0.5) * 0.6 + (rand() < 0.5 ? Math.PI : 0), rand);
          if (this.fits(car, 0.4)) this.add(car);
        } else {
          const t = { kind: 'tyres' as const, x, y, hw: 0.8, hh: 0.8, rot: 0, height: 1.2, seed: rand(), colour: '#1b1b1d', variant: 2 + Math.floor(rand() * 5) };
          if (this.fits(t, 0.3)) this.add(t);
        }
      }
    }
    void world;
  }

  /** Fill an apron: a trailer or two, awnings, cars, tyres -- whatever fits. */
  private populate(apron: Prop, rand: () => number): void {
    const c = Math.cos(apron.rot);
    const sn = Math.sin(apron.rot);
    const place = (lx: number, ly: number, make: (x: number, y: number) => Omit<Prop, 'frame'>) => {
      const p = make(apron.x + c * lx - sn * ly, apron.y + sn * lx + c * ly);
      // Wholly on the apron, and clear of what is already on it.
      const inside = Math.abs(lx) + p.hw * 0.9 < apron.hw && Math.abs(ly) + p.hh * 0.9 < apron.hh;
      if (inside && this.fits(p, 0, apron)) this.add(p);
    };
    const area = apron.hw * apron.hh;
    const trailers = area > 150 ? 2 : 1;
    for (let k = 0; k < trailers; k++) {
      place((rand() - 0.5) * (apron.hw * 2 - 14), -apron.hh + 2 + k * 3.2, (x, y) => ({ kind: 'trailer', x, y, hw: 6.5, hh: 1.3, rot: apron.rot, height: 4, seed: rand(), colour: pick(PAINT, rand), variant: 0 }));
    }
    for (let k = 0; k < 2 + Math.floor(area / 120); k++) {
      place((rand() - 0.5) * (apron.hw * 2 - 6), (rand() - 0.5) * (apron.hh * 2 - 6), (x, y) => ({ kind: 'tent', x, y, hw: 2.5 + rand(), hh: 2.5 + rand(), rot: apron.rot, height: 3, seed: rand(), colour: pick(PAINT, rand), variant: 0 }));
    }
    for (let k = 0; k < 3 + Math.floor(area / 60); k++) {
      place((rand() - 0.5) * (apron.hw * 2 - 5), (rand() - 0.5) * (apron.hh * 2 - 3), (x, y) => parkedCar(x, y, apron.rot + (rand() < 0.5 ? 0 : Math.PI) + (rand() < 0.4 ? Math.PI / 2 : 0), rand));
    }
    for (let k = 0; k < 2 + Math.floor(area / 100); k++) {
      place((rand() - 0.5) * (apron.hw * 2 - 2), (rand() - 0.5) * (apron.hh * 2 - 2), (x, y) => ({ kind: 'tyres', x, y, hw: 0.8, hh: 0.8, rot: 0, height: 1.2, seed: rand(), colour: '#1b1b1d', variant: 2 + Math.floor(rand() * 5) }));
    }
  }

  // --- Drawing: the town ------------------------------------------------------

  private drawCorridor(ctx: CanvasRenderingContext2D, c: Corridor): void {
    const ax = c.x - c.dx * c.length;
    const ay = c.y - c.dy * c.length;
    const bx = c.x + c.dx * c.length;
    const by = c.y + c.dy * c.length;
    const nx = -c.dy;
    const ny = c.dx;
    const band = (half: number, colour: string) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(ax + nx * half, ay + ny * half);
      ctx.lineTo(bx + nx * half, by + ny * half);
      ctx.lineTo(bx - nx * half, by - ny * half);
      ctx.lineTo(ax - nx * half, ay - ny * half);
      ctx.closePath();
      ctx.fill();
    };
    if (c.kind === 'canal') {
      // Stone banks, then the water, with a lighter ripple down the middle.
      band(c.half + 1.4, '#9c978c');
      band(c.half + 0.9, '#6f6b63');
      band(c.half, '#3f7fa3');
      band(c.half * 0.55, '#4b8fb3');
      ctx.strokeStyle = 'rgba(210,235,245,0.35)';
      ctx.lineWidth = 0.15;
      ctx.beginPath();
      for (let d = -c.length; d < c.length; d += 9) {
        for (const o of [-3.5, 1, 4.5]) {
          const x = c.x + c.dx * (d + o) + nx * o;
          const y = c.y + c.dy * (d + o) + ny * o;
          ctx.moveTo(x, y);
          ctx.lineTo(x + c.dx * 2.2, y + c.dy * 2.2);
        }
      }
      ctx.stroke();
      return;
    }
    // Railway: ballast, sleepers, two tracks of steel.
    band(c.half, '#8f877a');
    band(c.half - 0.6, '#a39b8d');
    for (const t of [-1.9, 1.9]) {
      ctx.strokeStyle = '#5a4634';
      ctx.lineWidth = 0.22;
      ctx.beginPath();
      for (let d = -c.length; d < c.length; d += 0.65) {
        const x = c.x + c.dx * d + nx * t;
        const y = c.y + c.dy * d + ny * t;
        ctx.moveTo(x - nx * 1.25, y - ny * 1.25);
        ctx.lineTo(x + nx * 1.25, y + ny * 1.25);
      }
      ctx.stroke();
      ctx.strokeStyle = '#c9ccd0';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      for (const r of [-0.72, 0.72]) {
        ctx.moveTo(ax + nx * (t + r), ay + ny * (t + r));
        ctx.lineTo(bx + nx * (t + r), by + ny * (t + r));
      }
      ctx.stroke();
    }
  }

  /** Where the road crosses a corridor: rails set in the tarmac, or a bridge's railings over the water. */
  private drawCrossingOnRoad(ctx: CanvasRenderingContext2D, i: number, c: Corridor): void {
    const s = this.road.route.samples;
    const half = s.halfWidth[i];
    const nx = -c.dy;
    const ny = c.dx;
    // The two points where the corridor's centreline meets the road edges.
    const h = s.heading[i];
    const rx = -Math.sin(h);
    const ry = Math.cos(h);
    const reach = half + this.theme.vergeWidth + 0.5;
    if (c.kind === 'rail') {
      ctx.strokeStyle = '#c9ccd0';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (const t of [-1.9, 1.9]) {
        for (const r of [-0.72, 0.72]) {
          const ox = c.x + nx * (t + r);
          const oy = c.y + ny * (t + r);
          // Along the corridor to where this rail meets the road.
          const along = (s.x[i] - ox) * c.dx + (s.y[i] - oy) * c.dy;
          const px = ox + c.dx * along;
          const py = oy + c.dy * along;
          ctx.moveTo(px - rx * reach, py - ry * reach);
          ctx.lineTo(px + rx * reach, py + ry * reach);
        }
      }
      ctx.stroke();
      // Stop lines each side, and the crossing's striped barrier arms, raised along the kerbs.
      for (const d of [-7, 7]) {
        const j = Math.max(0, Math.min(s.x.length - 1, i + Math.round(d / this.road.route.sampleSpacing)));
        this.drawStopLine(ctx, j, half);
      }
      for (const side of [1, -1]) {
        for (const d of [-5.5, 5.5]) {
          const j = Math.max(0, Math.min(s.x.length - 1, i + Math.round(d / this.road.route.sampleSpacing)));
          const [px, py] = this.at(j, side * (s.halfWidth[j] + 1.2));
          const hh = s.heading[j];
          const dir = d < 0 ? -1 : 1;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(hh);
          for (let k = 0; k < 6; k++) {
            ctx.fillStyle = k % 2 === 0 ? '#f2c230' : '#1d1d1f';
            ctx.fillRect(dir > 0 ? k * 0.7 : -(k + 1) * 0.7, -0.09, 0.7, 0.18);
          }
          ctx.fillStyle = '#1d1d1f';
          disc(ctx, 0, 0, 0.3);
          ctx.fillStyle = '#e8402a';
          disc(ctx, 0.12 * side, 0.12, 0.1);
          disc(ctx, -0.12 * side, 0.12, 0.1);
          ctx.restore();
        }
      }
      return;
    }
    // A bridge: railings along both edges over the water.
    const span = c.half + 1.6;
    for (const side of [1, -1]) {
      const edge = side * (half + this.theme.vergeWidth + 0.15);
      const [ex, ey] = this.at(i, edge);
      const along = (ex - c.x) * c.dx + (ey - c.y) * c.dy;
      void along;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(h);
      ctx.fillStyle = '#6f6b63';
      ctx.fillRect(-span, -0.35, span * 2, 0.7);
      ctx.fillStyle = '#e8e6df';
      ctx.fillRect(-span, -0.12, span * 2, 0.24);
      for (let k = -span; k <= span; k += 1.6) {
        ctx.fillStyle = '#6f6b63';
        ctx.fillRect(k - 0.14, -0.3, 0.28, 0.6);
      }
      ctx.restore();
    }
  }

  private drawStopLine(ctx: CanvasRenderingContext2D, j: number, half: number): void {
    const s = this.road.route.samples;
    ctx.save();
    ctx.translate(s.x[j], s.y[j]);
    ctx.rotate(s.heading[j]);
    ctx.fillStyle = 'rgba(244,241,234,0.9)';
    ctx.fillRect(-0.2, -half + 0.4, 0.4, half * 2 - 0.8);
    ctx.restore();
  }

  /** Zebra stripes across the road at i: bars along the road, a car-width each way. */
  private drawZebra(ctx: CanvasRenderingContext2D, i: number, half: number, depth: number): void {
    const s = this.road.route.samples;
    ctx.save();
    ctx.translate(s.x[i], s.y[i]);
    ctx.rotate(s.heading[i]);
    ctx.fillStyle = 'rgba(244,241,234,0.88)';
    for (let y = -half; y < half - 0.3; y += 0.9) ctx.fillRect(-depth / 2, y, depth, 0.45);
    ctx.restore();
  }

  private drawStub(ctx: CanvasRenderingContext2D, st: Stub): void {
    const nx = -st.dy;
    const ny = st.dx;
    const quad = (w0: number, w1: number, d0: number, d1: number, colour: string) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(st.x + st.dx * d0 + nx * w0, st.y + st.dy * d0 + ny * w0);
      ctx.lineTo(st.x + st.dx * d1 + nx * w0, st.y + st.dy * d1 + ny * w0);
      ctx.lineTo(st.x + st.dx * d1 + nx * w1, st.y + st.dy * d1 + ny * w1);
      ctx.lineTo(st.x + st.dx * d0 + nx * w1, st.y + st.dy * d0 + ny * w1);
      ctx.closePath();
      ctx.fill();
    };
    const pave = st.half + 2.4;
    quad(-pave, pave, 0, st.length, this.theme.verge);
    quad(-st.half - 0.25, st.half + 0.25, 0, st.length, this.theme.outline);
    quad(-st.half, st.half, 0, st.length, this.theme.tarmac);
    // Centre line, dashed.
    ctx.strokeStyle = 'rgba(244,241,234,0.7)';
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    for (let d = 9; d < st.length; d += 6) {
      ctx.moveTo(st.x + st.dx * d, st.y + st.dy * d);
      ctx.lineTo(st.x + st.dx * (d + 3), st.y + st.dy * (d + 3));
    }
    ctx.stroke();
  }

  /** Where a side street meets the course: through the pavement, a zebra across it, its stop line and とまれ, and the barriers. */
  private drawStubMouth(ctx: CanvasRenderingContext2D, st: Stub, from: number, to: number): void {
    if (st.index < from - 20 || st.index > to + 20) return;
    const nx = -st.dy;
    const ny = st.dx;
    const verge = this.theme.vergeWidth + 0.3;
    // The tarmac carried through the pavement.
    ctx.fillStyle = this.theme.tarmac;
    ctx.beginPath();
    ctx.moveTo(st.x - st.dx * 0.4 + nx * st.half, st.y - st.dy * 0.4 + ny * st.half);
    ctx.lineTo(st.x + st.dx * verge + nx * st.half, st.y + st.dy * verge + ny * st.half);
    ctx.lineTo(st.x + st.dx * verge - nx * st.half, st.y + st.dy * verge - ny * st.half);
    ctx.lineTo(st.x - st.dx * 0.4 - nx * st.half, st.y - st.dy * 0.4 - ny * st.half);
    ctx.closePath();
    ctx.fill();
    // Zebra across the side street, where the pavement would run.
    ctx.save();
    ctx.translate(st.x + st.dx * (verge / 2), st.y + st.dy * (verge / 2));
    ctx.rotate(Math.atan2(st.dy, st.dx));
    ctx.fillStyle = 'rgba(244,241,234,0.88)';
    for (let y = -st.half + 0.3; y < st.half - 0.3; y += 0.9) ctx.fillRect(-1.3, y, 2.6, 0.45);
    // Stop line and とまれ for a car coming out.
    ctx.fillRect(verge / 2 + 1.8, -st.half + 0.3, 0.4, st.half - 0.3);
    ctx.save();
    ctx.translate(verge / 2 + 4.6, -st.half / 2);
    ctx.rotate(Math.PI / 2);
    ctx.scale(0.05, -0.05);
    ctx.font = "bold 30px 'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('とまれ', 0, 0);
    ctx.restore();
    // Closed for the event: striped barriers across the street, and cones.
    const bar = verge / 2 + 7;
    for (let y = -st.half; y < st.half; y += 1.6) {
      ctx.fillStyle = '#e8402a';
      ctx.fillRect(bar, y + 0.05, 0.35, 1.5);
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(bar, y + 0.45, 0.35, 0.3);
      ctx.fillRect(bar, y + 1.05, 0.35, 0.3);
    }
    for (const y of [-st.half + 0.8, 0, st.half - 0.8]) {
      ctx.fillStyle = '#f08a24';
      disc(ctx, bar - 1.2, y, 0.32);
      ctx.fillStyle = '#f4f1ea';
      disc(ctx, bar - 1.2, y, 0.14);
    }
    ctx.restore();
  }

  private drawLot(ctx: CanvasRenderingContext2D, p: Prop): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(-p.hw - 0.25, -p.hh - 0.25, p.hw * 2 + 0.5, p.hh * 2 + 0.5);
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
    if (this.theme.style === 'street') {
      // Bays: two rows, facing each other across the aisle.
      ctx.strokeStyle = 'rgba(244,241,234,0.85)';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (const row of [-1, 1]) {
        const y0 = row < 0 ? -p.hh + 0.6 : p.hh - 0.6;
        const y1 = row < 0 ? -p.hh + 5.8 : p.hh - 5.8;
        for (let x = -p.hw + 0.2; x <= p.hw - 0.2; x += 2.6) {
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
        }
      }
      ctx.stroke();
      // The coin-parking sign: a blue plate with a P.
      ctx.fillStyle = '#2f6fb0';
      ctx.fillRect(-p.hw + 0.4, -0.7 * p.variant - 0.6, 1.4, 1.4);
      ctx.save();
      ctx.translate(-p.hw + 1.1, -0.7 * p.variant + 0.1);
      ctx.scale(0.045, -0.045);
      ctx.fillStyle = '#f4f1ea';
      ctx.font = "bold 26px Bungee, 'Arial Black', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', 0, 0);
      ctx.restore();
    } else {
      // A paddock apron: faded bay lines and oil stains.
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      const r = mulberry32(Math.floor(p.seed * 1e9));
      for (let k = 0; k < 10; k++) disc(ctx, (r() - 0.5) * p.hw * 1.8, (r() - 0.5) * p.hh * 1.8, 0.6 + r() * 1.2);
    }
    ctx.restore();
  }

  private drawIsland(ctx: CanvasRenderingContext2D, p: Prop): void {
    ctx.fillStyle = '#d9d5cb';
    disc(ctx, p.x, p.y, p.hw + 0.5);
    ctx.fillStyle = this.theme.outline;
    disc(ctx, p.x, p.y, p.hw + 0.1);
    ctx.fillStyle = p.colour;
    disc(ctx, p.x, p.y, p.hw - 0.2);
    // A ring of flowers, and a fountain in the middle.
    const r = mulberry32(Math.floor(p.seed * 1e9));
    for (let k = 0; k < 60; k++) {
      const a = r() * TAU;
      const d = p.hw * (0.62 + r() * 0.3);
      ctx.fillStyle = pick(['#e8402a', '#f2c230', '#f4f1ea', '#d98aa6', '#8a3f8f'], r);
      disc(ctx, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0.25);
    }
  }

  private drawProp(ctx: CanvasRenderingContext2D, p: Prop): void {
    switch (p.kind) {
      case 'building':
        return this.drawBuilding(ctx, p);
      case 'shop':
        return this.drawShop(ctx, p);
      case 'house':
        return this.drawHouse(ctx, p);
      case 'car':
        return drawParkedCar(ctx, p);
      case 'vending':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = '#1d1d1f';
        ctx.fillRect(-p.hw - 0.06, -p.hh - 0.06, p.hw * 2 + 0.12, p.hh * 2 + 0.12);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(-p.hw + 0.1, -p.hh + 0.08, p.hw * 2 - 0.2, 0.18);
        ctx.restore();
        return;
      case 'pole':
        ctx.fillStyle = '#3f3f41';
        disc(ctx, p.x, p.y, 0.2);
        // A transformer on the odd one.
        if (p.seed < 0.25) {
          ctx.fillStyle = '#8a8c90';
          disc(ctx, p.x + 0.35, p.y, 0.28);
        }
        return;
      case 'lamp': {
        ctx.strokeStyle = '#4a4a4c';
        ctx.lineWidth = 0.12;
        const ax = p.x + Math.cos(p.rot) * 1.6;
        const ay = p.y + Math.sin(p.rot) * 1.6;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.fillStyle = '#4a4a4c';
        disc(ctx, p.x, p.y, 0.15);
        ctx.fillStyle = '#fff4c8';
        disc(ctx, ax, ay, 0.22);
        return;
      }
      case 'garage':
        return this.drawGarage(ctx, p);
      case 'grandstand':
        return this.drawGrandstand(ctx, p);
      case 'trailer':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = this.theme.outline;
        ctx.fillRect(-p.hw - 0.1, -p.hh - 0.1, p.hw * 2 + 0.2, p.hh * 2 + 0.2);
        ctx.fillStyle = '#eceae3';
        ctx.fillRect(-p.hw, -p.hh, p.hw * 2 - 2.6, p.hh * 2);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.hw, -p.hh * 0.35, p.hw * 2 - 2.6, p.hh * 0.7);
        ctx.fillStyle = p.colour;
        ctx.fillRect(p.hw - 2.4, -p.hh + 0.1, 2.4, p.hh * 2 - 0.2);
        ctx.fillStyle = '#2b2d33';
        ctx.fillRect(p.hw - 0.9, -p.hh + 0.25, 0.6, p.hh * 2 - 0.5);
        ctx.restore();
        return;
      case 'tent': {
        // A square awning from above: four triangles, lit and shaded, to the centre.
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const w = p.hw;
        const tri = (ax: number, ay: number, bx: number, by: number, shade: number) => {
          ctx.fillStyle = p.colour;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.closePath();
          ctx.fill();
          if (shade !== 0) {
            ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
            ctx.fill();
          }
        };
        tri(-w, -w, w, -w, -0.15);
        tri(w, -w, w, w, -0.25);
        tri(w, w, -w, w, 0.1);
        tri(-w, w, -w, -w, 0.2);
        ctx.strokeStyle = this.theme.outline;
        ctx.lineWidth = 0.1;
        ctx.strokeRect(-w, -w, w * 2, w * 2);
        ctx.restore();
        return;
      }
      case 'tower':
        ctx.fillStyle = '#6a6a6c';
        disc(ctx, p.x, p.y, 0.4);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = '#2b2d33';
        ctx.fillRect(-1.6, -0.5 * p.variant - 0.4, 3.2, 0.8);
        ctx.fillStyle = '#fff4c8';
        for (let k = -1.4; k < 1.4; k += 0.7) ctx.fillRect(k + 0.08, -0.5 * p.variant - 0.3, 0.5, 0.6);
        ctx.restore();
        return;
      case 'tyres': {
        const r = mulberry32(Math.floor(p.seed * 1e9));
        for (let k = 0; k < p.variant; k++) {
          const x = p.x + (r() - 0.5) * 1.2;
          const y = p.y + (r() - 0.5) * 1.2;
          ctx.fillStyle = '#1b1b1d';
          disc(ctx, x, y, 0.34);
          ctx.fillStyle = '#3a3a3d';
          disc(ctx, x, y, 0.17);
        }
        return;
      }
      case 'booth':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = this.theme.outline;
        ctx.fillRect(-p.hw - 0.12, -p.hh - 0.12, p.hw * 2 + 0.24, p.hh * 2 + 0.24);
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
        // Chequered roof edge, and the glass facing the line.
        for (let k = 0; k < 10; k++) {
          ctx.fillStyle = k % 2 === 0 ? '#1d1d1f' : '#f4f1ea';
          ctx.fillRect(-p.hw + (k * p.hw * 2) / 10, -p.hh, (p.hw * 2) / 10, 0.5);
        }
        ctx.fillStyle = '#6fa8c8';
        ctx.fillRect(-p.hw + 0.4, p.hh - 0.7, p.hw * 2 - 0.8, 0.45);
        ctx.restore();
        return;
      default:
        return;
    }
  }

  private drawBuilding(ctx: CanvasRenderingContext2D, p: Prop): void {
    const r = mulberry32(Math.floor(p.seed * 1e9));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(-p.hw - 0.15, -p.hh - 0.15, p.hw * 2 + 0.3, p.hh * 2 + 0.3);
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
    // The parapet: a lighter rim.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.35;
    ctx.strokeRect(-p.hw + 0.35, -p.hh + 0.35, p.hw * 2 - 0.7, p.hh * 2 - 0.7);
    // On the roof: a stair housing, air-conditioning units, a water tank, sometimes solar panels.
    const sx = (r() - 0.5) * (p.hw * 2 - 4);
    const sy = (r() - 0.5) * (p.hh * 2 - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(sx - 1.3 + 0.4, sy - 1.1 - 0.5, 2.6, 2.2);
    ctx.fillStyle = shade(p.colour, -0.12);
    ctx.fillRect(sx - 1.3, sy - 1.1, 2.6, 2.2);
    const units = 1 + Math.floor(r() * 4);
    for (let k = 0; k < units; k++) {
      const ux = (r() - 0.5) * (p.hw * 2 - 2.5);
      const uy = (r() - 0.5) * (p.hh * 2 - 2.5);
      ctx.fillStyle = '#e4e4e0';
      ctx.fillRect(ux - 0.55, uy - 0.4, 1.1, 0.8);
      ctx.strokeStyle = '#8e8e8c';
      ctx.lineWidth = 0.06;
      ring(ctx, ux, uy, 0.25);
    }
    if (r() < 0.45) {
      const tx = (r() - 0.5) * (p.hw * 2 - 3);
      const ty = (r() - 0.5) * (p.hh * 2 - 3);
      ctx.fillStyle = '#7e8c96';
      disc(ctx, tx, ty, 0.9);
      ctx.fillStyle = '#9fadb6';
      disc(ctx, tx - 0.2, ty + 0.2, 0.55);
    }
    if (p.hw > 6 && r() < 0.35) {
      ctx.fillStyle = '#2f4f7a';
      const px = -p.hw + 1.2;
      for (let k = 0; k < 4; k++) ctx.fillRect(px + k * 1.9, p.hh - 3.2, 1.6, 2.2);
    }
    ctx.restore();
  }

  private drawShop(ctx: CanvasRenderingContext2D, p: Prop): void {
    this.drawBuilding(ctx, p);
    // The awning over the pavement, striped with white.
    const r = mulberry32(Math.floor(p.seed * 1e9) + 7);
    const colour = pick(AWNINGS, r);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    // The street side of a shop is towards the road: -y for a shop on the left, +y on the right.
    const y = p.variant > 0 ? -p.hh - 1.2 : p.hh;
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(-p.hw + 0.4, y - 0.05, p.hw * 2 - 0.8, 1.3);
    for (let x = -p.hw + 0.5, k = 0; x < p.hw - 0.5; x += 0.6, k++) {
      ctx.fillStyle = k % 2 === 0 ? colour : '#f4f1ea';
      ctx.fillRect(x, y, Math.min(0.6, p.hw - 0.5 - x), 1.2);
    }
    ctx.restore();
  }

  private drawHouse(ctx: CanvasRenderingContext2D, p: Prop): void {
    const r = mulberry32(Math.floor(p.seed * 1e9));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    // The garden: lawn to the plot's edge, a hedge round it.
    ctx.fillStyle = '#5f8a3c';
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
    ctx.fillStyle = '#86ad5a';
    ctx.fillRect(-p.hw + 0.5, -p.hh + 0.5, p.hw * 2 - 1, p.hh * 2 - 1);
    // The house on it, a gabled roof: the ridge along its longer side, one slope lit.
    const hw = p.hw * (0.62 + r() * 0.12);
    const hh = p.hh * (0.55 + r() * 0.12);
    const ox = (r() - 0.5) * (p.hw - hw);
    const oy = (r() - 0.5) * (p.hh - hh) * 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(ox - hw + 0.8, oy - hh - 1, hw * 2, hh * 2);
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(ox - hw - 0.15, oy - hh - 0.15, hw * 2 + 0.3, hh * 2 + 0.3);
    const alongX = hw >= hh;
    ctx.fillStyle = shade(p.colour, 0.18);
    if (alongX) ctx.fillRect(ox - hw, oy, hw * 2, hh);
    else ctx.fillRect(ox - hw, oy - hh, hw, hh * 2);
    ctx.fillStyle = p.colour;
    if (alongX) ctx.fillRect(ox - hw, oy - hh, hw * 2, hh);
    else ctx.fillRect(ox, oy - hh, hw, hh * 2);
    ctx.strokeStyle = shade(p.colour, 0.35);
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    if (alongX) {
      ctx.moveTo(ox - hw, oy);
      ctx.lineTo(ox + hw, oy);
    } else {
      ctx.moveTo(ox, oy - hh);
      ctx.lineTo(ox, oy + hh);
    }
    ctx.stroke();
    // Tile courses.
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    if (alongX) {
      for (let y = oy - hh + 0.5; y < oy + hh; y += 0.5) {
        ctx.moveTo(ox - hw, y);
        ctx.lineTo(ox + hw, y);
      }
    } else {
      for (let x = ox - hw + 0.5; x < ox + hw; x += 0.5) {
        ctx.moveTo(x, oy - hh);
        ctx.lineTo(x, oy + hh);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // --- Drawing: the park ------------------------------------------------------

  /** Concrete walls down both sides, tyre walls and catch fencing on the outside of the corners. */
  private drawWalls(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const s = this.road.route.samples;
    const off = this.theme.vergeWidth + 0.55;
    const line = (side: number, extra: number) => {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const w = (s.halfWidth[i] + off + extra) * side;
        const x = s.x[i] - Math.sin(s.heading[i]) * w;
        const y = s.y[i] + Math.cos(s.heading[i]) * w;
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };
    for (const side of [1, -1]) {
      // Shadow, ink, concrete, and the painted blocks.
      ctx.lineCap = 'butt';
      ctx.strokeStyle = this.theme.treeShadow;
      ctx.lineWidth = 0.9;
      ctx.save();
      ctx.translate(SUN_X * 1.1, SUN_Y * 1.1);
      line(side, 0);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = this.theme.outline;
      ctx.lineWidth = 0.9;
      line(side, 0);
      ctx.stroke();
      ctx.strokeStyle = '#dcd9d0';
      ctx.lineWidth = 0.65;
      line(side, 0);
      ctx.stroke();
      ctx.strokeStyle = '#e8402a';
      ctx.lineWidth = 0.65;
      ctx.setLineDash([2, 4]);
      line(side, 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Tyres in front of the wall on the outside of every corner, and the fence behind.
    for (let i = Math.max(from, 1); i < to; i++) {
      const k = s.curvature[i];
      if (Math.abs(k) < 1 / 60) continue;
      const side = k > 0 ? -1 : 1;
      const h = s.heading[i];
      for (let row = 0; row < 2; row++) {
        for (let t = 0; t < 3; t++) {
          const f = t / 3;
          const x0 = s.x[i] + (s.x[i + 1] - s.x[i]) * f;
          const y0 = s.y[i] + (s.y[i + 1] - s.y[i]) * f;
          // Clear of the kerb (to 1.2m out), in front of the wall.
          const w = (s.halfWidth[i] + 1.6 + row * 0.62) * side;
          const x = x0 - Math.sin(h) * w;
          const y = y0 + Math.cos(h) * w;
          ctx.fillStyle = '#1b1b1d';
          disc(ctx, x, y, 0.32);
          ctx.fillStyle = (i + t) % 6 < 3 ? '#2f6fb0' : '#3a3a3d';
          disc(ctx, x, y, 0.15);
        }
      }
      if (i % 2 === 0) {
        const w = (s.halfWidth[i] + off + 1.4) * side;
        ctx.fillStyle = '#5a5a5c';
        disc(ctx, s.x[i] - Math.sin(h) * w, s.y[i] + Math.cos(h) * w, 0.1);
      }
    }
    // The crowd along the fence on the outside of the corners: a few deep,
    // thinning out behind. Placed by the sample's own number, so it holds still.
    for (let i = Math.max(from, 1); i < to; i++) {
      const k = s.curvature[i];
      if (Math.abs(k) < 1 / 60) continue;
      const side = k > 0 ? -1 : 1;
      const h = s.heading[i];
      const r = mulberry32(i * 7919 + 17);
      for (let n = 0; n < 5; n++) {
        const deep = r();
        if (r() > 0.85 - deep * 0.6) continue;
        const w = (s.halfWidth[i] + off + 2.2 + deep * 4) * side;
        const along = (r() - 0.5) * 2;
        const x = s.x[i] - Math.sin(h) * w + Math.cos(h) * along;
        const y = s.y[i] + Math.cos(h) * w + Math.sin(h) * along;
        ctx.fillStyle = 'rgba(40,36,20,0.25)';
        disc(ctx, x + SUN_X * 0.9, y + SUN_Y * 0.9, 0.26);
        ctx.fillStyle = PEOPLE[Math.floor(r() * PEOPLE.length)];
        disc(ctx, x, y, 0.27);
        ctx.fillStyle = '#3a2a1c';
        disc(ctx, x, y, 0.13);
      }
    }
    // Sponsor boards on the walls, every so often.
    for (let i = from - (from % 18); i <= to - 3; i += 18) {
      if (i < from) continue;
      for (const side of [1, -1]) {
        ctx.strokeStyle = BOARDS[(Math.floor(i / 18) + (side > 0 ? 0 : 2)) % BOARDS.length];
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        for (let j = i; j <= i + 3; j++) {
          const w = (s.halfWidth[j] + off) * side;
          const x = s.x[j] - Math.sin(s.heading[j]) * w;
          const y = s.y[j] + Math.cos(s.heading[j]) * w;
          if (j === i) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(90,90,92,0.55)';
    ctx.lineWidth = 0.06;
    for (const side of [1, -1]) {
      ctx.beginPath();
      let on = false;
      for (let i = from; i <= to; i++) {
        const k = s.curvature[i];
        const outside = Math.abs(k) >= 1 / 60 && (k > 0 ? -1 : 1) === side;
        if (!outside) {
          on = false;
          continue;
        }
        const w = (s.halfWidth[i] + off + 1.4) * side;
        const x = s.x[i] - Math.sin(s.heading[i]) * w;
        const y = s.y[i] + Math.cos(s.heading[i]) * w;
        if (!on) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        on = true;
      }
      ctx.stroke();
    }
  }

  /** A corner's outer zone, painted on the tarmac: a white line, hatching up to the edge; and the clipping box on the inside. */
  private drawOuterZone(ctx: CanvasRenderingContext2D, z: { from: number; to: number; side: number; apex: number }, from: number, to: number): void {
    const s = this.road.route.samples;
    const a = Math.max(z.from, from);
    const b = Math.min(z.to, to);
    if (b <= a) return;
    const band = 2.6;
    // The hatching: diagonal red strokes between the line and the edge.
    ctx.strokeStyle = 'rgba(232,64,42,0.55)';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    for (let i = a; i < b; i++) {
      if (i % 2 !== 0) continue;
      const [x0, y0] = this.at(i, z.side * (s.halfWidth[i] - band + 0.2));
      const [x1, y1] = this.at(Math.min(b, i + 1), z.side * (s.halfWidth[i] - 0.3));
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(244,241,234,0.9)';
    ctx.lineWidth = 0.22;
    ctx.beginPath();
    for (let i = a; i <= b; i++) {
      const [x, y] = this.at(i, z.side * (s.halfWidth[i] - band));
      if (i === a) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Clipping box against the inside edge at the apex.
    if (z.apex >= from && z.apex <= to) {
      const i = z.apex;
      const inside = -z.side;
      ctx.save();
      const [cx, cy] = this.at(i, inside * (s.halfWidth[i] - 1));
      ctx.translate(cx, cy);
      ctx.rotate(s.heading[i]);
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = k % 2 === 0 ? 'rgba(232,64,42,0.8)' : 'rgba(244,241,234,0.85)';
        ctx.fillRect(-3 + k, -0.8, 1, 1.6);
      }
      ctx.restore();
    }
  }

  /** The park's name on the run-up, and a start box. */
  private drawParkLettering(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const s = this.road.route.samples;
    const words: [number, string][] = [
      [this.road.before + 22, 'AKARI'],
      [this.road.before + 38, 'DRIFT PARK'],
    ];
    for (const [i, word] of words) {
      if (i < from || i > to) continue;
      ctx.save();
      ctx.translate(s.x[i], s.y[i]);
      ctx.rotate(s.heading[i] - Math.PI / 2);
      ctx.scale(0.075, -0.075);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#f4f1ea';
      ctx.font = "44px Bungee, 'Arial Black', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(word, 0, 0);
      ctx.restore();
    }
    // Grid boxes behind the start line.
    const start = this.road.before;
    for (const d of [-3, -9]) {
      const i = start + d;
      if (i < from || i > to || i < 0) continue;
      ctx.save();
      ctx.translate(s.x[i], s.y[i]);
      ctx.rotate(s.heading[i]);
      ctx.strokeStyle = 'rgba(244,241,234,0.8)';
      ctx.lineWidth = 0.15;
      ctx.strokeRect(-2.4, -1.4, 4.8, 2.8);
      ctx.restore();
    }
  }

  private drawGarage(ctx: CanvasRenderingContext2D, p: Prop): void {
    const bays = Math.abs(p.variant);
    const side = Math.sign(p.variant) || 1;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(-p.hw - 0.15, -p.hh - 0.15, p.hw * 2 + 0.3, p.hh * 2 + 0.3);
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
    // A stripe down the roof, and the ridges between bays.
    ctx.fillStyle = '#2f6fb0';
    ctx.fillRect(-p.hw, -0.5, p.hw * 2, 1);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    for (let b = 1; b < bays; b++) {
      const x = -p.hw + (b * p.hw * 2) / bays;
      ctx.moveTo(x, -p.hh);
      ctx.lineTo(x, p.hh);
    }
    ctx.stroke();
    // Open doors on the track side: dark, with a lit floor showing.
    const front = side > 0 ? -p.hh : p.hh - 0.7;
    for (let b = 0; b < bays; b++) {
      const x = -p.hw + (b * p.hw * 2) / bays + 0.5;
      ctx.fillStyle = '#26282d';
      ctx.fillRect(x, front, (p.hw * 2) / bays - 1, 0.7);
    }
    ctx.restore();
  }

  private drawGrandstand(ctx: CanvasRenderingContext2D, p: Prop): void {
    const r = mulberry32(Math.floor(p.seed * 1e9));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = this.theme.outline;
    ctx.fillRect(-p.hw - 0.15, -p.hh - 0.15, p.hw * 2 + 0.3, p.hh * 2 + 0.3);
    // Rows of seats stepping up away from the track, a crowd in them.
    const rows = 10;
    // The track side: -y for a stand on the left of the road, +y on the right.
    const trackSide = p.variant > 0 ? -1 : 1;
    for (let k = 0; k < rows; k++) {
      const y0 = trackSide * (p.hh - (k * p.hh * 2) / rows) - (trackSide > 0 ? (p.hh * 2) / rows : 0);
      ctx.fillStyle = k % 2 === 0 ? '#cfcbc0' : '#bcb8ad';
      ctx.fillRect(-p.hw, y0, p.hw * 2, (p.hh * 2) / rows);
      if (k >= rows - 3) continue;
      for (let x = -p.hw + 0.5; x < p.hw - 0.4; x += 0.75) {
        if (r() < 0.25) continue;
        ctx.fillStyle = pick(PEOPLE, r);
        disc(ctx, x + (r() - 0.5) * 0.2, y0 + (p.hh * 2) / rows / 2, 0.26);
      }
    }
    // A roof over the back rows.
    const back = trackSide > 0 ? -p.hh : p.hh - 3.8;
    ctx.fillStyle = 'rgba(236,234,226,0.92)';
    ctx.fillRect(-p.hw, back, p.hw * 2, 3.8);
    ctx.fillStyle = '#e8402a';
    ctx.fillRect(-p.hw, back + (trackSide > 0 ? 3.4 : 0), p.hw * 2, 0.4);
    ctx.restore();
  }

  /** Start and finish gantries over the road. */
  private drawGantries(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const s = this.road.route.samples;
    const route = this.road.route;
    void route;
    for (const i of [this.road.before, this.road.finish]) {
      if (i < from || i > to) continue;
      const w = s.halfWidth[i] + this.theme.vergeWidth + 0.8;
      ctx.save();
      ctx.translate(s.x[i], s.y[i]);
      ctx.rotate(s.heading[i]);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-0.6 + SUN_X * 6, -w + SUN_Y * 6, 1.2, w * 2);
      ctx.fillStyle = this.theme.outline;
      ctx.fillRect(-0.7, -w - 0.1, 1.4, w * 2 + 0.2);
      ctx.fillStyle = '#e8e6df';
      ctx.fillRect(-0.6, -w, 1.2, w * 2);
      // Start lights along it.
      for (let k = -2; k <= 2; k++) {
        ctx.fillStyle = '#1d1d1f';
        disc(ctx, 0, k * 1.1, 0.4);
        ctx.fillStyle = i === this.road.before ? '#3fd14f' : '#f4f1ea';
        disc(ctx, 0, k * 1.1, 0.24);
      }
      ctx.fillStyle = '#6a6a6c';
      disc(ctx, 0, -w, 0.45);
      disc(ctx, 0, w, 0.45);
      ctx.restore();
    }
  }

  /**
   * The bells: each hangs from an arm off a post behind the wall, over the
   * outside of its corner. Rung, it swings along the road and sends rings out.
   */
  private drawBells(ctx: CanvasRenderingContext2D, from: number, to: number, time: number): void {
    const bells = this.road.route.bells;
    if (!bells) return;
    const s = this.road.route.samples;
    bells.forEach((bell, k) => {
      const i = bell.index + this.road.before;
      if (i < from - 10 || i > to + 10) return;
      const h = s.heading[i];
      const [bx, by] = this.at(i, bell.offset);
      const side = Math.sign(bell.offset) || 1;
      const [px, py] = this.at(i, side * (s.halfWidth[i] + this.theme.vergeWidth + 1.8));
      // How far it swings: a damped swing along the road, for a few seconds.
      const since = this.bellRung[k] >= 0 ? time - this.bellRung[k] : Infinity;
      const swing = since < 6 ? Math.exp(-since * 0.9) * Math.sin(since * 11) * 0.7 : 0;
      const sx = bx + Math.cos(h) * swing;
      const sy = by + Math.sin(h) * swing;
      // A painted target on the tarmac under it.
      ctx.strokeStyle = 'rgba(242,194,48,0.75)';
      ctx.lineWidth = 0.18;
      ring(ctx, bx, by, bell.radius + 0.4);
      ring(ctx, bx, by, bell.radius + 1.2);
      // Post, arm, and the bell's shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      disc(ctx, sx + SUN_X * 3.5, sy + SUN_Y * 3.5, 0.7);
      ctx.strokeStyle = this.theme.outline;
      ctx.lineWidth = 0.34;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = '#d6d3ca';
      ctx.lineWidth = 0.2;
      ctx.stroke();
      ctx.fillStyle = '#6a6a6c';
      disc(ctx, px, py, 0.4);
      ctx.strokeStyle = '#3a3a3c';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      // The bell: brass, dark rim, a highlight.
      ctx.fillStyle = '#5a3d10';
      disc(ctx, sx, sy, 0.78);
      ctx.fillStyle = '#d9a32c';
      disc(ctx, sx, sy, 0.66);
      ctx.fillStyle = '#f2cf6a';
      disc(ctx, sx - 0.18, sy + 0.18, 0.32);
      ctx.fillStyle = '#5a3d10';
      disc(ctx, sx, sy, 0.13);
      // Rings going out, for a second after it is struck.
      if (since < 1.2) {
        for (let n = 0; n < 3; n++) {
          const t = since - n * 0.18;
          if (t < 0) continue;
          ctx.strokeStyle = `rgba(242,194,48,${Math.max(0, 0.8 - t * 0.8)})`;
          ctx.lineWidth = 0.14;
          ring(ctx, sx, sy, 1 + t * 7);
        }
      }
    });
  }
}

// --- Helpers --------------------------------------------------------------------

const CAR_SPRITES = CARS.filter((c) => c.sprite).map((c) => ({ path: c.sprite?.path ?? '', length: c.bodyLength, width: c.bodyWidth, tint: c.tint ?? '#d0d0d0' }));

function parkedCar(x: number, y: number, rot: number, rand: () => number): Omit<Prop, 'frame'> {
  const variant = Math.floor(rand() * CAR_SPRITES.length);
  const car = CAR_SPRITES[variant];
  return { kind: 'car', x, y, hw: car.length / 2, hh: car.width / 2, rot, height: 1.4, seed: rand(), colour: car.tint, variant };
}

function drawParkedCar(ctx: CanvasRenderingContext2D, p: Prop): void {
  const car = CAR_SPRITES[p.variant];
  const sprite = getSprite(car?.path);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  if (sprite) {
    ctx.rotate(-Math.PI / 2);
    ctx.scale(1, -1);
    const len = p.hw * 2;
    const w = (len * sprite.naturalWidth) / sprite.naturalHeight;
    ctx.drawImage(sprite, -w / 2, -len / 2, w, len);
  } else {
    ctx.fillStyle = '#1d1d1f';
    ctx.fillRect(-p.hw - 0.08, -p.hh - 0.08, p.hw * 2 + 0.16, p.hh * 2 + 0.16);
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
  }
  ctx.restore();
}

function shadowRect(ctx: CanvasRenderingContext2D, p: Prop, ox: number, oy: number): void {
  // The footprint swept towards the shadow's end: the shape a box casts.
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const corners: [number, number][] = [
    [-p.hw, -p.hh],
    [p.hw, -p.hh],
    [p.hw, p.hh],
    [-p.hw, p.hh],
  ].map(([lx, ly]) => [p.x + c * lx - s * ly, p.y + s * lx + c * ly]);
  // The footprint and its offset copy, and the hull round both.
  const pts = [...corners, ...corners.map(([x, y]) => [x + ox, y + oy] as [number, number])];
  const hull = convexHull(pts);
  ctx.beginPath();
  hull.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Two rotated rectangles overlapping, with `pad` metres to spare: the separating axis test. */
function overlaps(a: Pick<Prop, 'x' | 'y' | 'hw' | 'hh' | 'rot'>, b: Pick<Prop, 'x' | 'y' | 'hw' | 'hh' | 'rot'>, pad: number): boolean {
  const axes = [a.rot, a.rot + Math.PI / 2, b.rot, b.rot + Math.PI / 2];
  for (const ang of axes) {
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const project = (r: typeof a) => {
      const c = Math.cos(r.rot);
      const s = Math.sin(r.rot);
      const centre = r.x * ux + r.y * uy;
      const extent = Math.abs((c * ux + s * uy) * r.hw) + Math.abs((-s * ux + c * uy) * r.hh);
      return [centre - extent, centre + extent];
    };
    const [a0, a1] = project(a);
    const [b0, b1] = project(b);
    if (a1 + pad < b0 || b1 + pad < a0) return false;
  }
  return true;
}

function cellKey(cx: number, cy: number): number {
  return (cx + 4096) * 8192 + (cy + 4096);
}

function pick<T>(list: T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}

/** Lighten (amount > 0) or darken (< 0) a #rrggbb colour. */
function shade(hex: string, amount: number): string {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${f((v >> 16) & 255)},${f((v >> 8) & 255)},${f(v & 255)})`;
}
