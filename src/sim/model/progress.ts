import { sin, cos } from '../math/trig.ts';
import type { RouteData, SimState } from '../types.ts';

/**
 * How far forward and back of the last known position we look for the nearest
 * centreline sample. A full search every tick would be O(n) and would also let
 * the car "teleport" onto a different part of the route where a hairpin doubles
 * back on itself. A local window makes progress monotonic and cheap.
 */
const SEARCH_BACK = 12;
const SEARCH_FORWARD = 48;

/**
 * Locate the car on the route: nearest centreline sample, distance travelled
 * along it, and signed lateral offset from it.
 *
 * Mutates state.sampleIndex, state.distance, state.lateralOffset, state.offTrack.
 */
export function updateProgress(state: SimState, route: RouteData): void {
  const s = route.samples;
  const count = s.x.length;

  const from = Math.max(0, state.sampleIndex - SEARCH_BACK);
  const to = Math.min(count - 1, state.sampleIndex + SEARCH_FORWARD);

  let bestIndex = state.sampleIndex;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (let i = from; i <= to; i++) {
    const dx = state.x - s.x[i];
    const dy = state.y - s.y[i];
    const d = dx * dx + dy * dy;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestIndex = i;
    }
  }

  state.sampleIndex = bestIndex;

  const h = s.heading[bestIndex];
  const dx = state.x - s.x[bestIndex];
  const dy = state.y - s.y[bestIndex];

  // Tangent component refines distance between samples; normal component is the
  // lateral offset. Normal points left of the direction of travel.
  const along = dx * cos(h) + dy * sin(h);
  state.lateralOffset = -dx * sin(h) + dy * cos(h);
  state.distance = bestIndex * route.sampleSpacing + along;

  state.offTrack = Math.abs(state.lateralOffset) > s.halfWidth[bestIndex];
}

/** True once the car has driven past the last centreline sample. */
export function isAtFinish(state: SimState, route: RouteData): boolean {
  return state.distance >= route.length;
}

/**
 * Wall contact test. Walls sit a little outside the drivable width so there is
 * a strip of "off track but recoverable" surface first -- dropping two wheels
 * should cost grip, not end the run.
 */
export const WALL_MARGIN = 2.5;

export function isAgainstWall(state: SimState, route: RouteData): boolean {
  const half = route.samples.halfWidth[state.sampleIndex];
  return Math.abs(state.lateralOffset) > half + WALL_MARGIN;
}

/**
 * Grip under the car right now. Full grip on the racing surface, reduced on the
 * shoulder, so running wide is punished by the physics rather than by a rule.
 */
export function surfaceGripAt(state: SimState, route: RouteData): number {
  const base = route.samples.grip[state.sampleIndex];
  if (!state.offTrack) return base;
  const half = route.samples.halfWidth[state.sampleIndex];
  const over = Math.abs(state.lateralOffset) - half;
  // Falls from full grip to 45% over the first 2.5m off the edge.
  const falloff = Math.max(0.45, 1 - (over / WALL_MARGIN) * 0.55);
  return base * falloff;
}

/** Where to put the car after a wall hit: on the centreline, facing down-route. */
export function safeResetPose(
  route: RouteData,
  sampleIndex: number,
): { x: number; y: number; heading: number } {
  const i = Math.max(0, Math.min(route.samples.x.length - 1, sampleIndex));
  return { x: route.samples.x[i], y: route.samples.y[i], heading: route.samples.heading[i] };
}
