import type { AssistParams, SimConfig, SimMode } from '../sim/types.ts';

/**
 * How much the game helps, per mode. See AssistParams in src/sim/types.ts.
 *
 * Time Attack favours grip: more of it, slides snapped shut early, firm
 * braking for corners, and steering that costs speed. The quick way round is a
 * tidy line.
 *
 * Drift Run favours angle: less grip so the rear comes round easily, a wide
 * slide limit, a throttle that pulses in a slide, and speed that bleeds
 * through the slide rather than through braking. Road keeping is firmer,
 * because holding a big angle on a narrow road is otherwise a wall.
 *
 * These objects are mutated in place by tuning mode, which is how a change
 * reaches a run in progress.
 */
export const MODE_ASSIST: Record<SimMode, AssistParams> = {
  timeAttack: {
    gripScale: 1.35,
    slideHoldScale: 1.6,
    maxSlideAngle: 0.35,
    cornerSpeed: 1.0,
    cornerBraking: 9,
    steerDrag: 4,
    slideDrag: 8,
    roadKeeping: 0.5,
    throttlePulse: 0,
  },
  driftRun: {
    gripScale: 0.8,
    slideHoldScale: 1.0,
    maxSlideAngle: 1.05,
    cornerSpeed: 1.25,
    cornerBraking: 5,
    steerDrag: 2,
    slideDrag: 10,
    roadKeeping: 0.8,
    throttlePulse: 0.35,
  },
};

export function configFor(mode: SimMode): SimConfig {
  return { mode, assist: MODE_ASSIST[mode] };
}
