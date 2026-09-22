import type { AssistParams, Controls, DriftControlParams, SimConfig, SimMode } from '../sim/types.ts';

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
    lineAware: 1,
    steerDrag: 2,
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
    lineAware: 0,
    steerDrag: 2,
    slideDrag: 10,
    roadKeeping: 0.8,
    throttlePulse: 0.35,
  },
};

const DEG = Math.PI / 180;

/**
 * Drift Run with throttle controls. With these numbers, holding the throttle at
 * about three quarters sits in the sweet spot; holding it flat runs past the
 * limit and spins within a second or so.
 */
export const DRIFT_CONTROL: DriftControlParams = {
  angleRate: 2.2,
  holdAngle: 75 * DEG,
  limitAngle: 55 * DEG,
  runaway: 3,
  spinAngle: 85 * DEG,
  flickAngle: 25 * DEG,
  flickTime: 0.35,
  driftGrip: 1.5,
  tailLine: 0.75,
  setupLine: 0.5,
  angleDrag: 3.5,
  exitRate: 1.8,
};

/** Throttle controls exist for Drift Run only; Time Attack always steers. */
/**
 * Time Attack on pedals: the same help with the steering, none with speed.
 * No corner braking -- the player brakes -- so the line is judged by the
 * player's own speed through it, not by the assist.
 */
export const PRO_ASSIST: AssistParams = {
  ...MODE_ASSIST.timeAttack,
  cornerSpeed: 0,
  lineAware: 0,
};

export function configFor(mode: SimMode, controls: Controls = 'steer'): SimConfig {
  const pedals = mode === 'timeAttack' && controls === 'pedals';
  return {
    mode,
    assist: pedals ? PRO_ASSIST : MODE_ASSIST[mode],
    controls: mode === 'driftRun' ? controls : pedals ? 'pedals' : 'steer',
    drift: DRIFT_CONTROL,
  };
}
