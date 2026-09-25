import {
  createSimState,
  cloneSimState,
  stepSim,
  hashSimState,
  gradeRun,
  quantiseInput,
  dequantiseInput,
  InputRecorder,
  DT,
  TICK_RATE,
  TICKS_PER_INPUT,
  HASH_INTERVAL,
  type QuantisedInput,
  type RunResult,
} from './sim/index.ts';
import type { CarParams, RouteData, SimConfig, SimInput, SimState } from './sim/types.ts';
import type { InputController } from './input/input.ts';
import type { Renderer, RenderSettings } from './render/renderer.ts';
import type { Hud } from './render/hud.ts';
import type { EngineAudio } from './audio/engine.ts';
import { ghostPose, type GhostTrack } from './ghost.ts';
import { stepTandem, placeAhead, type TandemState } from './sim/tandem.ts';

/**
 * The game loop.
 *
 * Fixed 120Hz simulation, decoupled from an unbounded render rate. The
 * accumulator pattern is not an optimisation: it is what makes the sim
 * deterministic at all. A variable timestep would make the physics depend on
 * the frame rate, and a run recorded on a 120Hz phone would not replay on a
 * 60Hz laptop.
 */

export type RunPhase = 'countdown' | 'running' | 'finished' | 'aborted';

export interface RunOutcome {
  result: RunResult;
  /** The tandem run's judging, when this was one. */
  tandem: TandemState | null;
  state: SimState;
  recorder: InputRecorder;
  hashes: number[];
}

/** Seconds of 3-2-1-GO before the clock starts. */
const COUNTDOWN_SECONDS = 3;

export class GameSession {
  phase: RunPhase = 'countdown';
  countdown = COUNTDOWN_SECONDS;

  private state: SimState;
  private prevState: SimState;
  /** The other car's state a tick ago, for drawing it smoothly. Tandem only. */
  private prevPartner: SimState | null = null;
  /** The hardest hit between the cars since the last frame, m/s. Tandem only. */
  private pendingImpact = 0;
  private recorder = new InputRecorder();
  private hashes: number[] = [];

  private accumulator = 0;
  private lastFrameMs = 0;
  private rafId = 0;

  /** The mutable "current input" the sim samples. Never an event queue. */
  private simInput: SimInput = { steer: 0, throttle: 1, initiate: false };
  private heldSample: QuantisedInput = { steer: 0, throttle: 0, flags: 0 };

  onCountdown: ((value: number) => void) | null = null;
  onFinish: ((outcome: RunOutcome) => void) | null = null;

  private boundFrame = (now: number) => this.frame(now);
  private boundVisibility = () => this.onVisibilityChange();

  constructor(
    private route: RouteData,
    private car: CarParams,
    private config: SimConfig,
    private input: InputController,
    private renderer: Renderer,
    private hud: Hud,
    private audio: EngineAudio | null,
    private renderSettings: RenderSettings,
    /** A leaderboard run to race against, driven in full before the start. */
    readonly ghost: GhostTrack | null = null,
    /** A tandem run: the other car, its driver, and the judging. */
    readonly tandem: TandemState | null = null,
    /** The other car's engine, quieter and muffled. Tandem only. */
    private partnerAudio: EngineAudio | null = null,
  ) {
    this.state = createSimState(route, car);
    // Leading a tandem, the player starts a car length ahead of the chaser.
    if (tandem?.playerRole === 'lead') placeAhead(this.state, route);
    this.prevState = cloneSimState(this.state);
    if (tandem) this.prevPartner = cloneSimState(tandem.partner);
  }

  start(): void {
    this.renderer.clearTrails();
    this.renderer.resetCamera(this.state);
    this.input.enable();
    this.audio?.resume();
    this.partnerAudio?.resume();
    this.lastFrameMs = performance.now();
    document.addEventListener('visibilitychange', this.boundVisibility);
    this.rafId = requestAnimationFrame(this.boundFrame);
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.input.disable();
    // Paused, not over: silence the engine without tearing it down, so it is
    // there again on resume. (Stopping it here once meant a paused run came
    // back silent.)
    this.audio?.suspend();
    document.removeEventListener('visibilitychange', this.boundVisibility);
  }

  abort(): void {
    this.phase = 'aborted';
    this.stop();
    this.audio?.stop();
    this.partnerAudio?.stop();
  }

  /**
   * End this run to start it again, leaving the engine sound running for the
   * next one. A phone only lets sound start from a tap, and a restart from
   * holding the pause button fires on a timer, not a tap: a new sound there
   * would be silent.
   */
  abandon(): void {
    this.phase = 'aborted';
    this.stop();
    this.partnerAudio?.stop();
  }

  /**
   * Backgrounding a tab stops rAF but not the clock. Without this the first
   * frame after returning carries a delta of however long the player was away,
   * and the accumulator would try to catch up with tens of thousands of sim
   * steps in one frame -- freezing the page and, worse, running the car into a
   * wall while nobody was looking.
   */
  private onVisibilityChange(): void {
    if (document.hidden) {
      this.input.releaseAll();
      this.accumulator = 0;
    } else {
      this.lastFrameMs = performance.now();
      this.accumulator = 0;
    }
  }

  private frame(now: number): void {
    this.rafId = requestAnimationFrame(this.boundFrame);

    // Clamp to avoid the spiral of death after a stall.
    const deltaSeconds = Math.min((now - this.lastFrameMs) / 1000, 0.25);
    this.lastFrameMs = now;

    this.input.update(deltaSeconds);

    if (this.phase === 'countdown') {
      this.countdown -= deltaSeconds;
      this.onCountdown?.(this.countdown);
      if (this.countdown <= 0) this.phase = 'running';
      // Still render during the countdown so the player can read the first
      // corner off the pace notes before the clock starts.
      this.draw(0, deltaSeconds);
      return;
    }

    if (this.phase === 'running') {
      this.accumulator += deltaSeconds;
      while (this.accumulator >= DT) {
        this.tick();
        this.accumulator -= DT;
        if (this.phase !== 'running') break;
      }
    }

    this.draw(this.accumulator / DT, deltaSeconds);
  }

  private tick(): void {
    // Sample the current input struct once per tick. On input-sample boundaries
    // we quantise and record; between them the sim re-reads the held sample, so
    // the live run consumes exactly the bytes a replay will.
    if (this.state.tick % TICKS_PER_INPUT === 0) {
      const raw = this.input.raw;
      // Steering runs record a pinned throttle; the sim ignores it there anyway.
      const pedals = this.config.controls === 'pedals';
      const throttle = this.config.controls === 'throttle' || pedals ? raw.throttle : 1;
      this.heldSample = quantiseInput(raw.steer, throttle, raw.initiate, pedals && raw.brake);
      // The drift button is held, but a press shorter than one sample must
      // still reach the sim: it is latched down until recorded, then follows
      // the button.
      this.input.consumeInitiate();
      this.recorder.push(this.heldSample);
    }
    dequantiseInput(this.heldSample, this.simInput);

    if (this.state.tick % HASH_INTERVAL === 0) {
      this.hashes.push(hashSimState(this.state));
    }

    this.prevState = cloneSimState(this.state);
    if (this.tandem) {
      this.prevPartner = cloneSimState(this.tandem.partner);
      stepTandem(this.tandem, this.state, this.simInput, this.car, this.route, this.config);
      if (this.tandem.impact > this.pendingImpact) this.pendingImpact = this.tandem.impact;
    } else {
      stepSim(this.state, this.simInput, this.car, this.route, this.config);
    }

    if (this.state.finished) {
      this.phase = 'finished';
      this.stop();
      this.audio?.stop();
      this.partnerAudio?.stop();
      this.onFinish?.({
        result: gradeRun(this.state, this.route, TICK_RATE),
        state: this.state,
        recorder: this.recorder,
        hashes: this.hashes,
        tandem: this.tandem,
      });
    }
  }

  private draw(alpha: number, deltaSeconds: number): void {
    this.renderer.render(
      this.state,
      this.prevState,
      alpha,
      this.route,
      this.car,
      this.renderSettings,
      deltaSeconds,
      this.ghost ? ghostPose(this.ghost, this.state.tick, alpha) : null,
      this.tandem && this.prevPartner
        ? { prev: this.prevPartner, next: this.tandem.partner, car: this.tandem.partnerCar }
        : null,
    );
    if (this.tandem) {
      this.hud.updateTandem(this.tandem);
      // A crash: through the player's own audio, full volume -- it is their car too.
      if (this.pendingImpact > 0.3) this.audio?.triggerImpact(this.pendingImpact / 8);
      this.pendingImpact = 0;
      if (this.partnerAudio) {
        // Louder alongside, fading to a quarter forty metres off.
        const p = this.tandem.partner;
        const d = Math.hypot(p.x - this.state.x, p.y - this.state.y);
        this.partnerAudio.setNearness(Math.max(0.25, Math.min(1, 1 - (d - 5) / 45)));
        this.partnerAudio.update(p, this.tandem.partnerCar);
      }
    }
    this.hud.update(this.state, this.route, this.config);
    this.audio?.update(this.state, this.car);
  }

  resize(): void {
    this.renderer.resize();
  }
}
