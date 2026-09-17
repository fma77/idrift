import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createSimState,
  stepSim,
  hashSimState,
  gradeRun,
  quantiseInput,
  dequantiseInput,
  InputRecorder,
  TICK_RATE,
  TICKS_PER_INPUT,
  HASH_INTERVAL,
} from '../src/sim/index.ts';
import { sin, cos, atan2, atan, PI } from '../src/sim/math/trig.ts';
import { createRng, nextUint32 } from '../src/sim/math/prng.ts';
import { CARS, carById } from '../src/data/cars.ts';
import { driveBot, DEFAULT_BOT } from '../src/bot/autopilot.ts';

const here = dirname(fileURLToPath(import.meta.url));
const route = JSON.parse(readFileSync(resolve(here, '../public/routes/akari-downhill.json'), 'utf8'));

/** Drive a full run with the bot, returning the finished state and hash stream. */
function runBot(car, mode, { maxSeconds = 300, botConfig = DEFAULT_BOT } = {}) {
  const state = createSimState(route, car);
  const config = { mode };
  const out = { steer: 0 };
  const input = { steer: 0 };
  const hashes = [];
  const recorder = new InputRecorder();

  const maxTicks = maxSeconds * TICK_RATE;
  let held = null;

  while (!state.finished && state.tick < maxTicks) {
    // Input is sampled at 60Hz and held across both 120Hz sim steps, exactly as
    // the real game loop does it -- otherwise the test would not exercise the
    // same code path as a player run.
    if (state.tick % TICKS_PER_INPUT === 0) {
      driveBot(state, route, car, botConfig, out);
      held = quantiseInput(out.steer);
      recorder.push(held);
    }
    dequantiseInput(held, input);

    if (state.tick % HASH_INTERVAL === 0) hashes.push(hashSimState(state));
    stepSim(state, input, car, route, config);
  }

  return { state, hashes, recorder };
}

// ---------------------------------------------------------------------------
// Deterministic math
// ---------------------------------------------------------------------------

test('sin/cos match the reference implementation to table precision', () => {
  let worst = 0;
  for (let i = -2000; i <= 2000; i++) {
    const a = i * 0.0157;
    worst = Math.max(worst, Math.abs(sin(a) - Math.sin(a)), Math.abs(cos(a) - Math.cos(a)));
  }
  // 8192-entry table with linear interpolation: theoretical bound ~7.3e-8.
  assert.ok(worst < 1e-6, `worst sin/cos error ${worst}`);
});

test('the sine table is not built from Math.sin', () => {
  // A table built from Math.sin would be exact at the sample points. Ours is
  // built from a Taylor kernel, so it is exact-ish but not bit-identical --
  // and, crucially, identical across engines. This test documents the intent:
  // if someone "optimises" buildSinTable to call Math.sin, sin() at a sample
  // point would become bit-equal to Math.sin and this would start failing.
  const source = readFileSync(resolve(here, '../src/sim/math/trig.ts'), 'utf8')
    // Strip comments: the file talks about Math.sin at length precisely because
    // it must never call it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/Math\.(sin|cos|tan|atan|pow|exp|log|hypot|random)\b/.test(source),
    'trig.ts must not reference implementation-defined Math functions');
});

test('atan2 matches the reference across all quadrants', () => {
  let worst = 0;
  for (let i = 0; i < 360; i++) {
    const a = (i / 360) * 2 * PI - PI;
    const y = Math.sin(a) * 3.7;
    const x = Math.cos(a) * 3.7;
    let diff = Math.abs(atan2(y, x) - Math.atan2(y, x));
    if (diff > PI) diff = Math.abs(diff - 2 * PI);
    worst = Math.max(worst, diff);
  }
  assert.ok(worst < 1e-5, `worst atan2 error ${worst}`);
  assert.equal(atan2(0, 0), 0);
});

test('atan handles the range-reduction boundary', () => {
  for (const z of [-50, -1.0001, -1, -0.5, 0, 0.5, 1, 1.0001, 50]) {
    assert.ok(Math.abs(atan(z) - Math.atan(z)) < 1e-5, `atan(${z})`);
  }
});

test('seeded PRNG is reproducible and seed-sensitive', () => {
  const a = createRng(20260915);
  const b = createRng(20260915);
  const c = createRng(20260916);
  const seqA = [];
  const seqB = [];
  const seqC = [];
  for (let i = 0; i < 500; i++) {
    seqA.push(nextUint32(a));
    seqB.push(nextUint32(b));
    seqC.push(nextUint32(c));
  }
  assert.deepEqual(seqA, seqB, 'same seed must give the same stream');
  assert.notDeepEqual(seqA, seqC, 'adjacent seeds must not give the same stream');
  // Never gets stuck at zero.
  assert.ok(seqA.some((v) => v !== 0));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same input stream produces a bit-identical run', () => {
  const car = carById('kaido-zen-r');
  const first = runBot(car, 'driftRun');
  const second = runBot(car, 'driftRun');

  assert.deepEqual(first.hashes, second.hashes, 'state hash streams must match');
  assert.equal(first.state.tick, second.state.tick);
  assert.equal(first.state.x, second.state.x);
  assert.equal(first.state.y, second.state.y);
  assert.equal(first.state.drift.banked, second.state.drift.banked);
});

test('a recorded input stream replays to the same final state', () => {
  const car = carById('kaido-zen-r');
  const live = runBot(car, 'driftRun');

  // Replay from the recorded stream rather than by re-running the bot.
  const state = createSimState(route, car);
  const config = { mode: 'driftRun' };
  const input = { steer: 0 };
  const q = { steer: 0 };
  const hashes = [];

  while (!state.finished && state.tick < live.state.tick + 10) {
    live.recorder.at(Math.floor(state.tick / TICKS_PER_INPUT), q);
    dequantiseInput(q, input);
    if (state.tick % HASH_INTERVAL === 0) hashes.push(hashSimState(state));
    stepSim(state, input, car, route, config);
  }

  assert.deepEqual(hashes, live.hashes, 'replay diverged from the live run');
  assert.equal(state.raceTicks, live.state.raceTicks);
  assert.equal(state.drift.banked, live.state.drift.banked);
});

// ---------------------------------------------------------------------------
// Replay encoding
// ---------------------------------------------------------------------------

test('quantise/dequantise round-trips within one quantum', () => {
  for (let i = -100; i <= 100; i++) {
    const steer = i / 100;
    const out = { steer: 0 };
    dequantiseInput(quantiseInput(steer), out);
    assert.ok(Math.abs(out.steer - steer) < 1 / 32767);
  }
});

test('full-left to full-right in one sample survives encoding', () => {
  // The delta between the two extremes does not fit in an int16. Stored modulo
  // the field width it round-trips exactly; clamped, it would corrupt the rest
  // of the replay.
  const rec = new InputRecorder(4);
  for (const steer of [-1, 1, -1, 0, 1]) rec.push(quantiseInput(steer));
  const decoded = InputRecorder.decode(rec.encode());
  const a = { steer: 0 };
  const b = { steer: 0 };
  for (let i = 0; i < rec.length; i++) {
    assert.deepEqual(decoded.at(i, b), rec.at(i, a), `sample ${i}`);
  }
});

test('delta-encoded input stream round-trips exactly', () => {
  const car = carById('kaido-zen-r');
  const { recorder } = runBot(car, 'driftRun');
  const bytes = recorder.encode();
  const decoded = InputRecorder.decode(bytes);

  assert.equal(decoded.length, recorder.length);
  const a = { steer: 0 };
  const b = { steer: 0 };
  for (let i = 0; i < recorder.length; i++) {
    recorder.at(i, a);
    decoded.at(i, b);
    assert.deepEqual(b, a, `sample ${i}`);
  }
});

test('a full run compresses to a few KB', async () => {
  const car = carById('kaido-zen-r');
  const { recorder, state } = runBot(car, 'driftRun');
  const raw = recorder.encode();

  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());

  const seconds = state.raceTicks / TICK_RATE;
  console.log(
    `    run ${seconds.toFixed(1)}s -> ${recorder.length} samples, ${raw.length}B raw, ${gz.length}B gzipped`,
  );
  assert.ok(gz.length < 8192, `gzipped replay was ${gz.length} bytes`);
});

// ---------------------------------------------------------------------------
// Gameplay plausibility
// ---------------------------------------------------------------------------

test('every car completes the route in a plausible time', () => {
  for (const car of CARS) {
    const { state } = runBot(car, 'timeAttack');
    const seconds = state.raceTicks / TICK_RATE;
    console.log(
      `    ${car.name.padEnd(18)} ${seconds.toFixed(2)}s  ` +
        `walls ${state.wallHits}  top ${(Math.max(state.speed, 0) * 3.6).toFixed(0)}km/h`,
    );
    assert.ok(state.finished, `${car.name} did not finish`);
    assert.ok(
      seconds > route.theoreticalMinTime,
      `${car.name} beat the theoretical minimum (${seconds}s < ${route.theoreticalMinTime}s) -- the bound or the physics is wrong`,
    );
    assert.ok(seconds < 240, `${car.name} took ${seconds}s`);
  }
});

test('drift run banks points and grades the run', () => {
  const car = carById('kaido-zen-r');
  const { state } = runBot(car, 'driftRun');
  const result = gradeRun(state, route, TICK_RATE);
  console.log(
    `    banked ${Math.round(state.drift.banked)} -> ${result.points} pts, grade ${result.grade}, ` +
      `zones ${result.zonesCleared}/${result.zonesTotal}, reversals ${result.reversals}`,
  );
  assert.ok(state.drift.banked > 0, 'a drifting run should bank points');
  assert.ok(
    result.points < route.theoreticalMaxPoints,
    'a real run must stay under the theoretical maximum used for server sanity checks',
  );
  assert.ok(['D', 'C', 'B', 'A', 'S'].includes(result.grade));
});

test('the sim never produces NaN, even when driven badly', () => {
  const car = carById('tengu-gt-x');
  const state = createSimState(route, car);
  const config = { mode: 'driftRun' };
  const input = { steer: 0 };
  const rng = createRng(7);

  // Deliberately awful driving: random full-lock stabs, spins included.
  for (let t = 0; t < TICK_RATE * 90; t++) {
    if (t % 30 === 0) {
      input.steer = (nextUint32(rng) / 4294967296) * 2 - 1;
    }
    stepSim(state, input, car, route, config);

    assert.ok(Number.isFinite(state.x) && Number.isFinite(state.y), `position NaN at tick ${t}`);
    assert.ok(Number.isFinite(state.vx) && Number.isFinite(state.vy), `velocity NaN at tick ${t}`);
    assert.ok(Number.isFinite(state.yawRate), `yawRate NaN at tick ${t}`);
    assert.ok(Number.isFinite(state.drift.banked), `score NaN at tick ${t}`);
    assert.ok(state.speed < 200, `implausible speed ${state.speed} at tick ${t}`);
  }
});

test('wall contact costs time and puts the car back on the road', () => {
  const car = carById('kaido-zen-r');
  const state = createSimState(route, car);
  const config = { mode: 'timeAttack' };
  const input = { steer: 0 };

  // Accelerate, then hold full lock until it runs out of road.
  for (let t = 0; t < TICK_RATE * 20 && state.wallHits === 0; t++) {
    input.steer = t > TICK_RATE * 3 ? 1 : 0;
    stepSim(state, input, car, route, config);
  }

  assert.ok(state.wallHits > 0, 'expected to hit a wall');
  assert.ok(state.penaltyTicks > 0, 'a wall hit must cost time');
  assert.ok(!state.finished, 'a wall hit must not end the run');
  const halfWidth = route.samples.halfWidth[state.sampleIndex];
  assert.ok(
    Math.abs(state.lateralOffset) <= halfWidth + 0.01,
    'the car must be back on the road after a reset',
  );
});

test('decoration cannot reach the simulation', () => {
  // The brief requires that visual changes never invalidate a leaderboard.
  // That holds only if decoration is genuinely unreachable from the sim, so
  // assert it behaviourally rather than trusting the file layout: run the same
  // inputs against routes whose decoration fields differ in every way, and
  // require bit-identical results.
  const car = carById('kaido-zen-r');
  const baseline = runBot(car, 'driftRun');

  const mutated = JSON.parse(JSON.stringify(route));
  mutated.decoration = 'something-completely-different.deco.json';
  mutated.poster = 'art/nope.png';
  delete mutated.decoration;

  const state = createSimState(mutated, car);
  const config = { mode: 'driftRun' };
  const input = { steer: 0 };
  const q = { steer: 0 };
  const hashes = [];
  while (!state.finished && state.tick < baseline.state.tick + 10) {
    baseline.recorder.at(Math.floor(state.tick / TICKS_PER_INPUT), q);
    dequantiseInput(q, input);
    if (state.tick % HASH_INTERVAL === 0) hashes.push(hashSimState(state));
    stepSim(state, input, car, mutated, config);
  }

  assert.deepEqual(hashes, baseline.hashes, 'changing decoration changed the simulation');
  assert.equal(state.drift.banked, baseline.state.drift.banked);
});

test('the sim never imports the rendering layer', () => {
  // A structural backstop for the test above: if someone reaches into the
  // renderer from inside src/sim, determinism and the decoration guarantee both
  // quietly stop holding, and only this would notice.
  const simDir = resolve(here, '../src/sim');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8');
        if (/from '\.\.\/(render|ui|input|audio|net|storage)\//.test(src)) offenders.push(entry.name);
      }
    }
  };
  walk(simDir);
  assert.deepEqual(offenders, [], 'src/sim must not import from the presentation layers');
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A wide-open version of the route, so steering tests never hit a wall. */
function openRoute() {
  const wide = JSON.parse(JSON.stringify(route));
  wide.samples.halfWidth = wide.samples.halfWidth.map(() => 500);
  return wide;
}

const CFG = { mode: 'timeAttack' };

/** Let a car drive itself up to `speed` m/s in a straight line, then return its state. */
function rollingStart(car, track, speed) {
  const state = createSimState(track, car);
  const input = { steer: 0 };
  while (state.speed < speed) stepSim(state, input, car, track, CFG);
  return state;
}

/** Hold one steering value for `seconds`, returning the slip angle sampled every tick. */
function hold(state, car, track, steer, seconds) {
  const slips = [];
  for (let t = 0; t < TICK_RATE * seconds; t++) {
    stepSim(state, { steer }, car, track, CFG);
    slips.push(state.slipAngle);
  }
  return slips;
}

test('steering right turns the car right', () => {
  // Regression: the sim uses counter-clockwise-positive angles, while the input
  // contract says +1 is RIGHT. Without the negation between them the car
  // steers away from the thumb, which is instantly obvious to a player and
  // invisible to every test that only checked lap times.
  const track = openRoute();
  const car = carById('kaido-zen-r');

  for (const [label, steer, wantSign] of [['right', 1, -1], ['left', -1, 1]]) {
    const state = rollingStart(car, track, 15);
    const before = state.heading;
    hold(state, car, track, steer * 0.3, 1);
    const turned = state.heading - before;
    assert.ok(
      Math.sign(turned) === wantSign && Math.abs(turned) > 0.3,
      `steer ${steer} ("${label}") changed heading by ${turned.toFixed(2)} rad`,
    );
  }
});

test('the car drives itself, up to its top speed and no further', () => {
  const track = openRoute();
  for (const car of CARS) {
    const state = createSimState(track, car);
    hold(state, car, track, 0, 4);
    assert.ok(state.speed > 15, `${car.name} only reached ${state.speed.toFixed(1)} m/s unaided in 4s`);
    hold(state, car, track, 0, 40);
    assert.ok(
      state.speed <= car.handling.topSpeed + 1e-6,
      `${car.name} went ${state.speed.toFixed(2)} m/s, past its top speed of ${car.handling.topSpeed}`,
    );
  }
});

test('gentle steering corners on grip, without sliding', () => {
  const track = openRoute();
  const car = carById('kaido-zen-r');
  const state = rollingStart(car, track, 20);
  const slips = hold(state, car, track, 0.1, 3);
  assert.ok(!state.sliding, 'a light, steady input should not break traction');
  assert.ok(Math.max(...slips.map(Math.abs)) < car.handling.breakAngle, 'slip stayed under the break angle');
});

test('a held slide settles into a steady angle instead of spinning', () => {
  // The whole point of the model: slide friction rises with angle, so a slide
  // finds an equilibrium. A thumb held still should give a drift held still.
  const track = openRoute();
  for (const car of CARS) {
    const state = rollingStart(car, track, car.handling.topSpeed * 0.8);
    const slips = hold(state, car, track, 0.45, 6);
    const tail = slips.slice(-TICK_RATE * 2).map(Math.abs);
    const spread = Math.max(...tail) - Math.min(...tail);
    const angle = tail[tail.length - 1];
    assert.ok(state.sliding, `${car.name}: half steering at speed should slide`);
    assert.ok(angle > 0.2 && angle < 1.2, `${car.name}: settled at ${(angle * 57.3).toFixed(0)} degrees`);
    assert.ok(spread < 0.08, `${car.name}: slide angle still wandering by ${(spread * 57.3).toFixed(1)} degrees`);
  }
});

test('a wider slide scrubs more speed', () => {
  const track = openRoute();
  const car = carById('onibi-silhouette');
  const speeds = [0.3, 0.6].map((steer) => {
    const state = rollingStart(car, track, 30);
    hold(state, car, track, steer, 3);
    return state.speed;
  });
  assert.ok(speeds[1] < speeds[0] - 3, `speed after a small slide ${speeds[0].toFixed(1)}, after a big one ${speeds[1].toFixed(1)}`);
});

test('lifting the thumb straightens the car out of a slide', () => {
  const track = openRoute();
  for (const car of CARS) {
    const state = rollingStart(car, track, 28);
    hold(state, car, track, -0.5, 2.5);
    assert.ok(state.sliding, `${car.name}: expected a slide before letting go`);
    hold(state, car, track, 0, 1.5);
    assert.ok(!state.sliding, `${car.name}: still sliding 1.5s after letting go`);
    assert.ok(Math.abs(state.yawRate) < 0.1, `${car.name}: still rotating at ${state.yawRate.toFixed(2)} rad/s`);
  }
});

test('handling changes take effect on the next tick', () => {
  // Tuning mode edits the car object in place, mid-run. That only works if the
  // sim reads handling every step rather than caching it at run start.
  const track = openRoute();
  const shipped = carById('kaido-zen-r');
  const car = { ...shipped, handling: { ...shipped.handling } };
  const state = rollingStart(car, track, 20);
  const before = state.speed;
  car.handling.topSpeed = 5;
  hold(state, car, track, 0, 0.5);
  assert.ok(state.speed < before, 'lowering top speed mid-run should slow the car at once');
});
