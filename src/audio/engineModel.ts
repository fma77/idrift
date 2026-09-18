import type { EngineSpec } from './profiles.ts';

/**
 * What the engine is doing, for sound.
 *
 * The sim has no engine: the car's speed comes from the arcade model. But an
 * engine note needs revs, gears, a limiter, boost and lift-off moments, so
 * this invents them from what the sim does have -- road speed, the throttle,
 * and whether the car is sliding. It lives entirely outside the sim, so it
 * can be as theatrical as it likes without touching a replay or a score.
 */

export interface EngineInputs {
  /** m/s. */
  speed: number;
  /** m/s. The car's top speed, which sets the gearing. */
  topSpeed: number;
  /** 0..1. */
  throttle: number;
  /** True while the car is sliding; wheelspin lifts the revs. */
  sliding: boolean;
  /** Radians of slide. */
  slip: number;
  /** Clutch in: the revs follow the throttle, not the road. The sound lab's neutral. */
  neutral?: boolean;
}

export interface EngineReading {
  rpm: number;
  /** 0..1 of redline. */
  rpmFraction: number;
  gear: number;
  /** 0..1. Throttle actually reaching the engine: zero during fuel cut and shifts. */
  load: number;
  /** 0..1. */
  boost: number;
  /** 0..1. How much the exhaust is popping: rises on lift-off, fades. */
  overrun: number;
  /** True while the limiter is cutting fuel. */
  cut: boolean;
  /** Set on the frame the throttle closed with boost up: how hard the turbo flutters, 0..1. 0 otherwise. */
  flutter: number;
}

/** Seconds of fuel cut each time the limiter is hit. */
const LIMITER_CUT = 0.055;
/** rpm the limiter knocks off each time. */
const LIMITER_DROP = 280;
/** Seconds of lost drive during a gear change. */
const SHIFT_TIME = 0.12;

export class EngineModel {
  private readonly spec: EngineSpec;
  private rpm: number;
  private gear = 0;
  private load = 0;
  private boost = 0;
  private overrun = 0;
  private cutTimer = 0;
  private shiftTimer = 0;
  private lastThrottle = 0;

  constructor(spec: EngineSpec) {
    this.spec = spec;
    this.rpm = spec.idleRpm;
  }

  /** Top speed in each gear, m/s: closer together in the upper gears, as in a real box. */
  private gearTop(gear: number, topSpeed: number): number {
    const n = this.spec.gears;
    const t = n <= 1 ? 1 : gear / (n - 1);
    return topSpeed * (0.3 + 0.72 * Math.pow(t, 0.8));
  }

  update(dt: number, input: EngineInputs): EngineReading {
    const s = this.spec;
    const throttle = Math.min(1, Math.max(0, input.throttle));
    let flutter = 0;

    // --- Gearbox ---
    const roadRpm = (gear: number) => (input.speed / this.gearTop(gear, input.topSpeed)) * s.redlineRpm;
    if (!input.neutral) {
      if (roadRpm(this.gear) > s.redlineRpm * 0.95 && this.gear < s.gears - 1 && throttle > 0.3) {
        this.gear++;
        this.shiftTimer = SHIFT_TIME;
      } else if (this.gear > 0 && roadRpm(this.gear) < s.redlineRpm * 0.42) {
        this.gear--;
      }
    } else {
      this.gear = 0;
    }

    // --- Where the revs want to be ---
    let target: number;
    if (input.neutral) {
      target = s.idleRpm + throttle * (s.limiterRpm + 400 - s.idleRpm);
    } else {
      target = Math.max(s.idleRpm, roadRpm(this.gear));
      // Wheelspin in a slide: throttle lifts the revs clear of road speed.
      if (input.sliding) {
        const spin = throttle * Math.min(1, Math.abs(input.slip) / 0.6);
        target += spin * 0.35 * s.redlineRpm;
      }
    }
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      target = Math.min(target, roadRpm(this.gear));
    }

    // In gear the revs are tied to the road and follow it closely; revving
    // freely they rise and fall at the engine's own rate.
    const tied = !input.neutral && !input.sliding && this.shiftTimer <= 0;
    const rise = tied ? s.revRise * 3 : s.revRise;
    const fall = tied ? s.revRise * 3 : s.revFall;
    if (target > this.rpm) this.rpm = Math.min(target, this.rpm + rise * dt * (0.3 + 0.7 * throttle));
    else this.rpm = Math.max(target, this.rpm - fall * dt);

    // --- Limiter: cut, drop, recover, cut again ---
    if (this.cutTimer > 0) {
      this.cutTimer -= dt;
    } else if (this.rpm >= s.limiterRpm) {
      this.cutTimer = LIMITER_CUT;
      this.rpm -= LIMITER_DROP;
    }
    this.rpm = Math.max(s.idleRpm * 0.9, Math.min(this.rpm, s.limiterRpm));
    const cut = this.cutTimer > 0;

    // --- Load ---
    const loadTarget = cut || this.shiftTimer > 0 ? 0 : throttle;
    this.load += (loadTarget - this.load) * Math.min(1, dt * 14);

    // --- Turbo ---
    const rpmFraction = this.rpm / s.redlineRpm;
    if (s.spool > 0) {
      const onBoost = rpmFraction > s.boostThreshold ? Math.min(1, ((rpmFraction - s.boostThreshold) / (1 - s.boostThreshold)) * 1.6) : 0;
      // Boost follows the pedal, not the fuel: the limiter cutting fuel for a
      // few milliseconds at a time does not empty the turbo.
      const boostTarget = throttle > 0.4 ? onBoost * throttle : 0;
      const rate = boostTarget > this.boost ? s.spool : 7;
      this.boost += (boostTarget - this.boost) * Math.min(1, dt * rate);
    }

    // --- Lift-off: the moment the throttle snaps shut ---
    const lifted = this.lastThrottle > 0.55 && throttle < 0.25;
    if (lifted) {
      if (this.boost > 0.3) flutter = Math.min(1, this.boost * 1.2);
      this.overrun = Math.max(this.overrun, Math.min(1, rpmFraction * 1.3));
    }
    // Pops keep coming while the throttle stays shut at speed, and die away.
    if (throttle < 0.25) this.overrun *= Math.exp(-dt * 1.1);
    else this.overrun *= Math.exp(-dt * 12);
    this.lastThrottle = throttle;

    return {
      rpm: this.rpm,
      rpmFraction: Math.min(1.1, rpmFraction),
      gear: this.gear,
      load: this.load,
      boost: this.boost,
      overrun: this.overrun,
      cut,
      flutter,
    };
  }
}
