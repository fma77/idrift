import { sin, cos } from '../math/trig.ts';
import type { CarParams, RouteData, SimState } from '../types.ts';

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
 * Off the tarmac, by how many wheels: one in the dirt is nothing, two and the
 * car slides and slows, three or four and it is ploughing. Index = wheels off.
 */
const OFF_ROAD_GRIP = [1, 1, 0.7, 0.55, 0.42];
/**
 * Drag off the tarmac, per second, as a share of speed: it bites at speed and
 * fades towards a standstill. A fixed drag outpulled the weakest engines, and
 * a car that stopped in the dirt could never drive out again.
 */
const OFF_ROAD_DRAG_RATE = [0, 0, 0.12, 0.3, 0.5];

/** m/s^2 of drag at this speed with this many wheels off. */
export function offRoadDrag(wheelsOff: number, speed: number): number {
  return OFF_ROAD_DRAG_RATE[Math.max(0, Math.min(4, wheelsOff))] * speed;
}

/**
 * Grip under the car right now: full on the tarmac, less the more wheels are
 * off it -- so running wide is punished by the physics rather than by a rule.
 */
export function surfaceGripAt(state: SimState, route: RouteData, offRoad = true): number {
  const base = route.samples.grip[state.sampleIndex];
  return offRoad ? base * OFF_ROAD_GRIP[Math.max(0, Math.min(4, state.wheelsOff))] : base;
}

/** Which of the four wheels are past the road's edge, from the car's pose. */
export function updateWheelsOff(state: SimState, car: CarParams, route: RouteData): void {
  const s = route.samples;
  const i = state.sampleIndex;
  const h = s.heading[i];
  const half = s.halfWidth[i];
  const sinR = sin(h);
  const cosR = cos(h);
  const sinC = sin(state.heading);
  const cosC = cos(state.heading);
  const track = car.bodyWidth / 2;
  let mask = 0;
  let count = 0;
  let bit = 1;
  for (const along of [car.cgToFront, -car.cgToRear]) {
    for (const side of [1, -1]) {
      // Left of the car is +side.
      const wx = state.x + cosC * along - sinC * track * side;
      const wy = state.y + sinC * along + cosC * track * side;
      const lateral = -(wx - s.x[i]) * sinR + (wy - s.y[i]) * cosR;
      if (Math.abs(lateral) > half) {
        mask |= bit;
        count++;
      }
      bit <<= 1;
    }
  }
  state.wheelsOffMask = mask;
  state.wheelsOff = count;
}

/** Where to put the car after a wall hit: on the centreline, facing down-route. */
export function safeResetPose(
  route: RouteData,
  sampleIndex: number,
): { x: number; y: number; heading: number } {
  const i = Math.max(0, Math.min(route.samples.x.length - 1, sampleIndex));
  return { x: route.samples.x[i], y: route.samples.y[i], heading: route.samples.heading[i] };
}
