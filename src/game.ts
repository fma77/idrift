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
  ) {
    this.state = createSimState(route, car);
    this.prevState = cloneSimState(this.state);
  }

  start(): void {
    this.renderer.clearTrails();
    this.renderer.resetCamera(this.state);
    this.input.enable();
    this.audio?.resume();
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
      const throttle = this.config.controls === 'throttle' ? raw.throttle : 1;
      this.heldSample = quantiseInput(raw.steer, throttle, raw.initiate);
      // A tap is an event, not a held key: it goes into exactly one sample.
      this.input.consumeInitiate();
      this.recorder.push(this.heldSample);
    }
    dequantiseInput(this.heldSample, this.simInput);

    if (this.state.tick % HASH_INTERVAL === 0) {
      this.hashes.push(hashSimState(this.state));
    }

    this.prevState = cloneSimState(this.state);
    stepSim(this.state, this.simInput, this.car, this.route, this.config);

    if (this.state.finished) {
      this.phase = 'finished';
      this.stop();
      this.audio?.stop();
      this.onFinish?.({
        result: gradeRun(this.state, this.route, TICK_RATE),
        state: this.state,
        recorder: this.recorder,
        hashes: this.hashes,
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
    );
    this.hud.update(this.state, this.route, this.config);
    this.audio?.update(this.state, this.car);
  }

  resize(): void {
    this.renderer.resize();
  }
}
