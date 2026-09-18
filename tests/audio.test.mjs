import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineModel } from '../src/audio/engineModel.ts';
import { EngineSynth } from '../src/audio/engineSynth.ts';
import { PROFILES, ENGINE_KINDS } from '../src/audio/profiles.ts';
import { CARS } from '../src/data/cars.ts';

/**
 * The sound cannot be judged by a test, but its plumbing can: that the revs
 * behave like an engine's, that each engine's signature noise happens when it
 * should (and only on the engines that have it), and that the synth never
 * produces anything but finite samples in range.
 */

const SR = 48000;

function run(model, seconds, input, dt = 1 / 60) {
  const readings = [];
  for (let t = 0; t < seconds; t += dt) readings.push(model.update(dt, input));
  return readings;
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function render(kind, controls, seconds = 0.5, before) {
  const synth = new EngineSynth({ ...PROFILES[kind].voice }, SR, 1234);
  before?.(synth);
  const out = new Float32Array(Math.round(SR * seconds));
  // Render in worklet-sized blocks, as the real thing does.
  for (let i = 0; i < out.length; i += 128) {
    synth.render(out.subarray(i, Math.min(out.length, i + 128)), {
      idleRpm: PROFILES[kind].spec.idleRpm,
      ...controls,
    });
  }
  return out;
}

test('every engine has a car, and every car a different engine', () => {
  const used = CARS.map((c) => c.engine);
  assert.deepEqual([...used].sort(), [...ENGINE_KINDS].sort());
});

test('at rest the engine idles', () => {
  for (const kind of ENGINE_KINDS) {
    const spec = PROFILES[kind].spec;
    const r = run(new EngineModel(spec), 1, { speed: 0, topSpeed: 40, throttle: 0, sliding: false, slip: 0 }).at(-1);
    assert.ok(Math.abs(r.rpm - spec.idleRpm) < 50, `${kind} idles at ${Math.round(r.rpm)}`);
  }
});

test('revving in neutral hits the limiter and bounces off it, never past it', () => {
  for (const kind of ENGINE_KINDS) {
    const spec = PROFILES[kind].spec;
    const readings = run(new EngineModel(spec), 2, { speed: 0, topSpeed: 40, throttle: 1, sliding: false, slip: 0, neutral: true });
    assert.ok(readings.some((r) => r.cut), `${kind} never hit the limiter`);
    assert.ok(readings.every((r) => r.rpm <= spec.limiterRpm), `${kind} went past its limiter`);
  }
});

test('driving, the gearbox shifts up as the car gathers speed', () => {
  const spec = PROFILES.turbo6.spec;
  const model = new EngineModel(spec);
  const gears = [];
  for (let speed = 0; speed <= 40; speed += 0.1) {
    gears.push(model.update(1 / 60, { speed, topSpeed: 40, throttle: 1, sliding: false, slip: 0 }).gear);
  }
  assert.equal(gears[0], 0);
  assert.ok(gears.at(-1) >= spec.gears - 2, `only reached gear ${gears.at(-1) + 1}`);
  for (let i = 1; i < gears.length; i++) assert.ok(gears[i] >= gears[i - 1], 'no downshifts while accelerating');
});

test('wheelspin in a slide lifts the revs above road speed', () => {
  const spec = PROFILES.na4.spec;
  const grip = run(new EngineModel(spec), 1, { speed: 15, topSpeed: 35, throttle: 1, sliding: false, slip: 0 }).at(-1);
  const slide = run(new EngineModel(spec), 1, { speed: 15, topSpeed: 35, throttle: 1, sliding: true, slip: 0.7 }).at(-1);
  assert.ok(slide.rpm > grip.rpm + 500, `grip ${Math.round(grip.rpm)}, sliding ${Math.round(slide.rpm)}`);
});

test('lifting off a turbo engine on boost flutters; the others never do', () => {
  for (const kind of ENGINE_KINDS) {
    const model = new EngineModel(PROFILES[kind].spec);
    run(model, 2.5, { speed: 0, topSpeed: 40, throttle: 1, sliding: false, slip: 0, neutral: true });
    const lift = model.update(1 / 60, { speed: 0, topSpeed: 40, throttle: 0, sliding: false, slip: 0, neutral: true });
    const turbo = PROFILES[kind].spec.spool > 0;
    if (turbo) assert.ok(lift.flutter > 0.3, `${kind} should flutter on lift-off, got ${lift.flutter}`);
    else assert.equal(lift.flutter, 0, `${kind} has no turbo to flutter`);
    assert.ok(lift.overrun > 0.3, `${kind} should pop on the overrun`);
  }
});

test('the synth only ever produces finite samples in range', () => {
  for (const kind of ENGINE_KINDS) {
    for (const [rpm, load] of [[800, 0], [4000, 1], [9000, 1], [9000, 0]]) {
      const out = render(kind, { rpm, rpmFraction: rpm / PROFILES[kind].spec.redlineRpm, load, boost: load, overrun: 1 - load, cut: rpm > 8500 });
      for (let i = 0; i < out.length; i++) {
        assert.ok(Number.isFinite(out[i]) && Math.abs(out[i]) <= 1, `${kind} at ${rpm}rpm produced ${out[i]}`);
      }
    }
  }
});

test('the engine is louder under load than off it', () => {
  for (const kind of ENGINE_KINDS) {
    const spec = PROFILES[kind].spec;
    const controls = { rpm: 5000, rpmFraction: 5000 / spec.redlineRpm, boost: 0, overrun: 0, cut: false };
    const off = rms(render(kind, { ...controls, load: 0 }));
    const on = rms(render(kind, { ...controls, load: 1 }));
    assert.ok(on > off * 1.5, `${kind}: off ${off.toFixed(3)}, on ${on.toFixed(3)}`);
  }
});

test('the rotary lopes at idle and the NA four does not', () => {
  // Loudness in 80ms windows -- a few firings each -- so a smooth idle reads
  // as steady, while a lumpy one swings between loud and quiet groups.
  const swing = (kind) => {
    const spec = PROFILES[kind].spec;
    const out = render(kind, { rpm: spec.idleRpm, rpmFraction: spec.idleRpm / spec.redlineRpm, load: 0.1, boost: 0, overrun: 0, cut: false }, 2);
    const w = Math.round(SR * 0.08);
    const levels = [];
    for (let i = 0; i + w <= out.length; i += w) levels.push(rms(out.subarray(i, i + w)));
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length);
    return sd / mean;
  };
  const rotary = swing('rotary');
  const na4 = swing('na4');
  assert.ok(rotary > na4 * 2, `idle unevenness: rotary ${rotary.toFixed(2)}, NA four ${na4.toFixed(2)}`);
});

test('a flutter is heard after lift-off', () => {
  const controls = { rpm: 3000, rpmFraction: 0.4, load: 0, boost: 0, overrun: 0, cut: false };
  const plain = rms(render('turbo6', controls, 0.4));
  const flutter = rms(render('turbo6', controls, 0.4, (s) => s.triggerFlutter(1)));
  assert.ok(flutter > plain * 1.5, `without ${plain.toFixed(3)}, with flutter ${flutter.toFixed(3)}`);
});
