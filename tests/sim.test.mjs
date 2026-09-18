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
import { configFor, DRIFT_CONTROL } from '../src/data/assist.ts';
import { cornerSpeedLimit, roadKeepingTurn } from '../src/sim/model/assist.ts';

const here = dirname(fileURLToPath(import.meta.url));
const route = JSON.parse(readFileSync(resolve(here, '../public/routes/akari-downhill.json'), 'utf8'));

/** Drive a full run with the bot, returning the finished state and hash stream. */
function runBot(car, mode, { maxSeconds = 300, botConfig = DEFAULT_BOT } = {}) {
  const state = createSimState(route, car);
  const config = configFor(mode);
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
  const config = configFor('driftRun');
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
  const config = configFor('driftRun');
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
  const config = configFor('timeAttack');
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
  const config = configFor('driftRun');
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

/**
 * No help at all: the bare handling model, so these tests pin down how the car
 * itself behaves. The assists are tested separately below.
 */
const CFG = {
  mode: 'timeAttack',
  assist: {
    gripScale: 1,
    slideHoldScale: 1,
    maxSlideAngle: 10,
    cornerSpeed: 0,
    cornerBraking: 0,
    steerDrag: 0,
    slideDrag: 0,
    roadKeeping: 0,
    throttlePulse: 0,
  },
};

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

// ---------------------------------------------------------------------------
// Assists
// ---------------------------------------------------------------------------

/**
 * A stand-in for a real player: aims along the road, reacts a quarter of a
 * second late, and misjudges how much to steer by up to 40% either way. Not a
 * good driver -- a plausible one.
 */
function humanDriver() {
  const history = [];
  return (state, track) => {
    const last = track.samples.x.length - 1;
    const i = Math.min(last, state.sampleIndex + Math.round((4 + state.speed * 0.3) / track.sampleSpacing));
    const travel = state.heading + state.slipAngle;
    let err = track.samples.heading[i] - travel;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    err -= state.lateralOffset * 0.04;
    const misjudge = 1 + 0.4 * Math.sin(state.tick / 170);
    history.push(Math.max(-1, Math.min(1, -err * 1.6 * misjudge)));
    return history.length > 15 ? history[history.length - 16] : 0;
  };
}

function drive(track, car, mode, driver, maxSeconds = 240) {
  const state = createSimState(track, car);
  const config = configFor(mode);
  let steer = 0;
  let slidingTicks = 0;
  while (!state.finished && state.tick < TICK_RATE * maxSeconds) {
    if (state.tick % TICKS_PER_INPUT === 0) steer = driver(state, track);
    stepSim(state, { steer }, car, track, config);
    if (state.sliding) slidingTicks++;
  }
  return { state, slideFraction: slidingTicks / Math.max(state.tick, 1) };
}

const ROUTES = readdirSync(resolve(here, '../public/routes'))
  .filter((name) => name.endsWith('.json') && !name.endsWith('.deco.json'))
  .map((name) => JSON.parse(readFileSync(resolve(here, '../public/routes', name), 'utf8')));

test('a plausible player gets round every route in both modes without hitting a wall', () => {
  // The promise made to the player: steer roughly the right way and the car
  // stays on the road.
  for (const track of ROUTES) {
    for (const mode of ['timeAttack', 'driftRun']) {
      for (const car of CARS) {
        const { state } = drive(track, car, mode, humanDriver());
        assert.ok(state.finished, `${car.name} did not finish ${track.name} in ${mode}`);
        assert.equal(state.wallHits, 0, `${car.name} hit ${state.wallHits} walls on ${track.name} in ${mode}`);
      }
    }
  }
});

test('not steering still crashes, in both modes', () => {
  // The other half of the promise: the help only comes while the player is
  // steering. Otherwise the game would be driving itself.
  const car = carById('kaido-zen-r');
  for (const mode of ['timeAttack', 'driftRun']) {
    const { state } = drive(route, car, mode, () => 0, 60);
    assert.ok(state.wallHits >= 5, `in ${mode}, a player who never steered hit only ${state.wallHits} walls`);
  }
});

test('Time Attack is quicker and Drift Run is more sideways', () => {
  const car = carById('onibi-silhouette');
  const ta = drive(route, car, 'timeAttack', humanDriver());
  const dr = drive(route, car, 'driftRun', humanDriver());
  assert.ok(ta.state.raceTicks < dr.state.raceTicks, 'the same driver should be faster in Time Attack');
  assert.ok(dr.slideFraction > ta.slideFraction + 0.1, `slide time: drift ${dr.slideFraction.toFixed(2)}, time attack ${ta.slideFraction.toFixed(2)}`);
});

test('the car brakes by itself for a corner it can see coming', () => {
  // Place the car on the straight before the tightest corner on the route.
  const k = route.samples.curvature.map(Math.abs);
  const apex = k.indexOf(Math.max(...k));
  const assist = configFor('timeAttack').assist;
  const car = carById('kaido-zen-r');
  const grip = car.handling.grip * assist.gripScale;

  const near = createSimState(route, car);
  near.sampleIndex = apex - 8;
  near.distance = near.sampleIndex * route.sampleSpacing;
  near.speed = 30;
  const limitNear = cornerSpeedLimit(near, route, assist, grip);
  assert.ok(limitNear < 30, `16m before the tightest corner at 108 km/h the limit was ${limitNear.toFixed(1)} m/s`);

  const atApex = { ...near, sampleIndex: apex, distance: apex * route.sampleSpacing };
  const cornerSpeed = Math.sqrt((grip * 9.80665) / k[apex]);
  assert.ok(Math.abs(cornerSpeedLimit(atApex, route, assist, grip) - cornerSpeed) < 0.5, 'at the apex the limit is the grip speed');

  assert.equal(cornerSpeedLimit(near, route, { ...assist, cornerSpeed: 0 }, grip), Infinity, 'switched off, it never brakes');
});

test('road keeping only helps a player steering the right way', () => {
  const car = carById('kaido-zen-r');
  const assist = configFor('driftRun').assist;
  // On a straight, near the left edge and drifting further left.
  const straight = route.samples.curvature.findIndex((c, i) => i > 10 && Math.abs(c) < 1e-6);
  const state = createSimState(route, car);
  state.sampleIndex = straight;
  state.heading = route.samples.heading[straight] + 0.15;
  state.vx = 20;
  state.speed = 20;
  state.lateralOffset = route.samples.halfWidth[straight] * 0.7;

  const right = roadKeepingTurn(state, route, assist, 0.5, 1 / 120);
  const none = roadKeepingTurn(state, route, assist, 0, 1 / 120);
  const wrong = roadKeepingTurn(state, route, assist, -0.5, 1 / 120);
  assert.ok(right < 0, 'steering right, back towards the road, bends the path right');
  assert.equal(none, 0, 'no steering, no help');
  assert.equal(wrong, 0, 'steering further off the road, no help');
});

test('the throttle pulses in a Drift Run slide and stays pinned otherwise', () => {
  const track = openRoute();
  const car = carById('kaido-zen-r');
  const config = configFor('driftRun');
  const state = createSimState(track, car);
  const input = { steer: 0 };
  // Straight-line running: throttle pinned (the open route has no corners to brake for).
  for (let t = 0; t < TICK_RATE * 3; t++) stepSim(state, input, car, track, { ...config, assist: { ...config.assist, cornerSpeed: 0 } });
  assert.equal(state.throttle, 1);

  input.steer = 0.6;
  const seen = [];
  for (let t = 0; t < TICK_RATE * 2; t++) {
    stepSim(state, input, car, track, { ...config, assist: { ...config.assist, cornerSpeed: 0 } });
    if (state.sliding) seen.push(state.throttle);
  }
  assert.ok(seen.length > 0, 'expected a slide');
  assert.ok(Math.max(...seen) - Math.min(...seen) > 0.2, 'the throttle should visibly pulse while sliding');
});

// ---------------------------------------------------------------------------
// Drift Run with throttle controls
// ---------------------------------------------------------------------------

/**
 * Stand-in players for the throttle controls. They see what a player sees --
 * the road ahead and the angle gauge -- and press what a player presses: a
 * throttle that builds and falls at the phone's rate, and a drift tap.
 *
 *   grip:     never taps; holds the throttle all the way.
 *   balancer: taps into each corner, taps again to switch sides in S-bends,
 *             and feathers the throttle to sit just under the limit angle.
 *   flatout:  taps into each corner, then holds the throttle flat.
 */
function throttleDriver(kind) {
  let throttle = 0;
  const cornerSign = (state, track, metres) => {
    const last = track.samples.x.length - 1;
    for (let j = 0; j <= Math.round(metres / track.sampleSpacing); j++) {
      const k = track.samples.curvature[Math.min(last, state.sampleIndex + j)];
      if (Math.abs(k) > 1 / 60) return Math.sign(k);
    }
    return 0;
  };
  return (state, track) => {
    let hold = true;
    let tap = false;
    if (kind !== 'grip') {
      const next = cornerSign(state, track, 24);
      if (state.driftDir === 0 && state.spinTicks === 0 && next !== 0) tap = true;
      if (kind === 'balancer' && state.driftDir !== 0 && next === -state.driftDir) tap = true;
      if (kind === 'balancer' && state.driftDir !== 0) {
        const cornering = cornerSign(state, track, 40) !== 0;
        hold = cornering && state.driftAngle < DRIFT_CONTROL.limitAngle - 0.12;
      }
    }
    throttle = Math.min(1, Math.max(0, throttle + (hold ? 1 / 0.45 : -1 / 0.3) / 60));
    return { throttle, tap };
  };
}

function driveThrottle(track, car, kind, maxSeconds = 200) {
  const state = createSimState(track, car);
  const config = configFor('driftRun', 'throttle');
  const driver = throttleDriver(kind);
  const input = { steer: 0, throttle: 0, initiate: false };
  const recorder = new InputRecorder();
  const hashes = [];
  let held = quantiseInput(0, 0, false);
  let spins = 0;
  let driftTicks = 0;
  while (!state.finished && state.tick < TICK_RATE * maxSeconds) {
    if (state.tick % TICKS_PER_INPUT === 0) {
      const out = driver(state, track);
      held = quantiseInput(0, out.throttle, out.tap);
      recorder.push(held);
    }
    dequantiseInput(held, input);
    if (state.tick % HASH_INTERVAL === 0) hashes.push(hashSimState(state));
    const wasSpinning = state.spinTicks > 0;
    stepSim(state, input, car, track, config);
    if (!wasSpinning && state.spinTicks > 0) spins++;
    if (state.driftDir !== 0) driftTicks++;
  }
  return { state, spins, driftTicks, recorder, hashes, config };
}

test('throttle controls: never tapping gets round on grip, with no drift points', () => {
  for (const track of ROUTES) {
    for (const car of CARS) {
      const { state, driftTicks } = driveThrottle(track, car, 'grip');
      assert.ok(state.finished, `${car.name} did not finish ${track.name}`);
      assert.equal(state.wallHits, 0, `${car.name} hit ${state.wallHits} walls on ${track.name}`);
      assert.equal(driftTicks, 0, 'the game must never start a drift by itself');
      assert.equal(Math.round(state.drift.banked), 0, 'cornering on grip scores nothing');
    }
  }
});

test('throttle controls: balancing on the limit scores, cleanly, on every route', () => {
  for (const track of ROUTES) {
    for (const car of CARS) {
      const { state, spins } = driveThrottle(track, car, 'balancer');
      const result = gradeRun(state, track, TICK_RATE);
      assert.ok(state.finished, `${car.name} did not finish ${track.name}`);
      assert.equal(state.wallHits, 0, `${car.name} hit ${state.wallHits} walls on ${track.name}`);
      assert.equal(spins, 0, `${car.name} spun ${spins} times on ${track.name}`);
      assert.ok(result.points > 0 && result.zonesCleared > 0, `${car.name} scored nothing on ${track.name}`);
      assert.ok(result.points < track.theoreticalMaxPoints, 'a real run must stay under the server bound');
    }
  }
});

test('throttle controls: holding it flat spins the car and scores next to nothing', () => {
  const car = carById('kaido-zen-r');
  const balanced = driveThrottle(route, car, 'balancer');
  const flat = driveThrottle(route, car, 'flatout');
  assert.ok(flat.spins >= 3, `flat out only spun ${flat.spins} times`);
  assert.ok(
    gradeRun(flat.state, route, TICK_RATE).points < gradeRun(balanced.state, route, TICK_RATE).points / 10,
    'spinning must cost the combo',
  );
});

test('throttle controls: the flick goes into the coming corner, nose first', () => {
  const car = carById('kaido-zen-r');
  const config = configFor('driftRun', 'throttle');
  // Find the first left-hander and start just before it, at speed.
  const start = route.samples.curvature.findIndex((k) => k > 1 / 60) - 10;
  const state = createSimState(route, car);
  state.sampleIndex = start;
  state.x = route.samples.x[start];
  state.y = route.samples.y[start];
  state.heading = route.samples.heading[start];
  state.vx = 20;
  state.speed = 20;
  stepSim(state, { steer: 0, throttle: 0.7, initiate: true }, car, route, config);
  assert.equal(state.driftDir, 1, 'a tap before a left-hander drifts left');
  for (let t = 0; t < TICK_RATE * 0.5; t++) stepSim(state, { steer: 0, throttle: 0.7, initiate: false }, car, route, config);
  // Nose pointing left of the direction of travel: velocity to the right of
  // the nose, which is a negative slip angle.
  assert.ok(state.slipAngle < -0.2, `expected the nose into the corner, slip was ${state.slipAngle.toFixed(2)}`);
});

test('throttle controls: a steady throttle holds a steady angle below the limit', () => {
  const track = openRoute();
  const car = carById('onibi-silhouette');
  const config = configFor('driftRun', 'throttle');
  const d = DRIFT_CONTROL;
  const state = createSimState(track, car);
  state.speed = 18;
  state.vx = 18;
  state.driftDir = 1;
  state.driftAngle = 0.4;
  const throttle = 0.6;
  for (let t = 0; t < TICK_RATE * 4; t++) stepSim(state, { steer: 0, throttle, initiate: false }, car, track, config);
  const expected = throttle * d.holdAngle;
  assert.ok(Math.abs(state.driftAngle - expected) < 0.02, `held ${state.driftAngle.toFixed(3)} rad, expected ${expected.toFixed(3)}`);
});

test('throttle controls: a recorded run replays exactly', () => {
  const car = carById('tengu-gt-x');
  const live = driveThrottle(route, car, 'balancer');
  const decoded = InputRecorder.decode(live.recorder.encode());
  const state = createSimState(route, car);
  const input = { steer: 0, throttle: 0, initiate: false };
  const q = { steer: 0, throttle: 0, flags: 0 };
  const hashes = [];
  while (!state.finished && state.tick < live.state.tick + 10) {
    decoded.at(Math.floor(state.tick / TICKS_PER_INPUT), q);
    dequantiseInput(q, input);
    if (state.tick % HASH_INTERVAL === 0) hashes.push(hashSimState(state));
    stepSim(state, input, car, route, live.config);
  }
  assert.deepEqual(hashes, live.hashes, 'replay diverged from the live run');
  assert.equal(state.drift.banked, live.state.drift.banked);
});
