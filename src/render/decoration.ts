import { sin, cos } from '../sim/math/trig.ts';
import { getSprite } from './sprites.ts';

/**
 * Route decoration.
 *
 * Loaded from a file separate from the route, and never merged into it. The
 * sim has no import path to this module and no field on RouteData that could
 * carry it -- so re-scattering the trees, or dropping in real art, cannot
 * change a single physics or scoring result, and cannot invalidate a
 * leaderboard. That separation is the whole point of the layer.
 */

export type DecoKind = 'tree' | 'post' | 'guardrail' | 'marker';

export interface DecoObject {
  kind: DecoKind;
  /** Nearest centreline sample, so culling matches the road's reveal window. */
  index: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  /** Markers only. */
  severity?: number;
  sign?: number;
  /** Optional per-object art. Falls back to a drawn shape when absent. */
  sprite?: string;
}

export interface DecorationData {
  routeId: string;
  routeVersion: number;
  decorationVersion: number;
  palette: Record<string, string>;
  objects: DecoObject[];
}

const cache = new Map<string, DecorationData | null>();

/**
 * Fetch a route's decoration.
 *
 * Failure is not an error: a route with no decoration file is simply
 * undecorated, and the game plays identically. Cached including the miss so a
 * missing file is not re-requested every time the route is opened.
 */
export async function loadDecoration(file: string | undefined): Promise<DecorationData | null> {
  if (!file) return null;
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`routes/${file}`);
    if (!res.ok) {
      cache.set(file, null);
      return null;
    }
    const data = (await res.json()) as DecorationData;
    cache.set(file, data);
    return data;
  } catch {
    cache.set(file, null);
    return null;
  }
}

/**
 * Draw the decoration within the reveal window.
 *
 * Objects are sorted by sample index at bake time, so the visible slice is a
 * contiguous range. Rather than binary-searching it every frame, this walks the
 * array once and skips what is out of range -- a few hundred objects per route
 * makes the scan cheaper than the search.
 */
export function drawDecoration(
  ctx: CanvasRenderingContext2D,
  deco: DecorationData,
  fromIndex: number,
  toIndex: number,
  px: number,
): void {
  const objects = deco.objects;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o.index < fromIndex || o.index > toIndex) continue;

    const sprite = getSprite(o.sprite);
    if (sprite) {
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.rotation);
      // Supplied art faces "up"; world forward is +x, hence the quarter turn
      // and the y flip, matching how car sprites are handled.
      ctx.rotate(-Math.PI / 2);
      ctx.scale(1, -1);
      const size = 3 * o.scale;
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
      continue;
    }

    switch (o.kind) {
      case 'tree': {
        // A filled disc reads as canopy from directly above, which is the only
        // angle this camera has.
        ctx.fillStyle = deco.palette.tree ?? '#1f1f1f';
        ctx.beginPath();
        ctx.arc(o.x, o.y, 1.5 * o.scale, 0, 6.283185307179586);
        ctx.fill();
        break;
      }
      case 'post': {
        ctx.fillStyle = deco.palette.post ?? '#3a3a3a';
        ctx.fillRect(o.x - 0.22, o.y - 0.22, 0.44, 0.44);
        break;
      }
      case 'guardrail': {
        ctx.strokeStyle = deco.palette.guardrail ?? '#5a564c';
        ctx.lineWidth = px * 2.5;
        const dx = cos(o.rotation) * 3.2;
        const dy = sin(o.rotation) * 3.2;
        ctx.beginPath();
        ctx.moveTo(o.x - dx / 2, o.y - dy / 2);
        ctx.lineTo(o.x + dx / 2, o.y + dy / 2);
        ctx.stroke();
        break;
      }
      case 'marker': {
        // Corner marker board: a small red plate, taller for tighter corners.
        // The same information the pace-note strip carries, placed in the world.
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(o.rotation);
        ctx.fillStyle = deco.palette.marker ?? '#e8402a';
        const h = 0.5 + (o.severity ?? 1) * 0.16;
        ctx.fillRect(-0.18, -h / 2, 0.36, h);
        ctx.restore();
        break;
      }
    }
  }
}
