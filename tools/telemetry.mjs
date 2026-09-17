#!/usr/bin/env node
/**
 * Headless telemetry. Drives a car with a scripted input and prints a trace.
 *
 * This is the tuning tool: handling changes get evaluated here first, where a
 * run takes 40ms and the numbers are exact, before anything is judged by feel
 * in the browser.
 *
 *   node tools/telemetry.mjs accel   kaido-zen-r
 *   node tools/telemetry.mjs lap     onibi-silhouette
 *   node tools/telemetry.mjs drift   tengu-gt-x
 *   node tools/telemetry.mjs hold    kaido-zen-r 0.45
 */
import { readFileSync } from 'node:fs';
import { createSimState, stepSim, gradeRun, TICK_RATE, TICKS_PER_INPUT } from '../src/sim/index.ts';
import { carById, CARS } from '../src/data/cars.ts';
import { driveBot, DEFAULT_BOT } from '../src/bot/autopilot.ts';
import { configFor } from '../src/data/assist.ts';

const route = JSON.parse(readFileSync(new URL('../public/routes/akari-downhill.json', import.meta.url), 'utf8'));

const mode = process.argv[2] ?? 'accel';
const carId = process.argv[3] ?? CARS[0].id;
const car = carById(carId);

const fmt = (v, w = 7, d = 2) => v.toFixed(d).padStart(w);

if (mode === 'accel') {
  const st = createSimState(route, car);
  const cfg = configFor('timeAttack');
  const input = { steer: 0 };
  console.log(`${car.name} -- driving itself from rest\n`);
  console.log('   t     km/h      vx      vy   yaw/s    dist');
  let to100 = null;
  for (let t = 0; t < TICK_RATE * 20; t++) {
    stepSim(st, input, car, route, cfg);
    if (to100 === null && st.vx * 3.6 >= 100) to100 = t / TICK_RATE;
    if (t % 60 === 0) {
      console.log(
        `${fmt(t / TICK_RATE, 4, 1)} ${fmt(st.vx * 3.6, 8)} ${fmt(st.vx)} ${fmt(st.vy)} ` +
          `${fmt(st.yawRate)} ${fmt(st.distance, 7, 1)}`,
      );
    }
  }
  console.log(`\n0-100 km/h: ${to100 === null ? 'never' : to100.toFixed(2) + 's'}`);
  console.log(`speed after 20s: ${(st.vx * 3.6).toFixed(1)} km/h`);
}

if (mode === 'hold') {
  // Hold a fixed slider value at speed and watch the slide settle.
  const steer = Number(process.argv[4] ?? 0.45);
  const wide = JSON.parse(JSON.stringify(route));
  wide.samples.halfWidth = wide.samples.halfWidth.map(() => 5000);
  const st = createSimState(wide, car);
  const cfg = configFor('timeAttack');
  console.log(`${car.name} -- straight for 6s, hold steer ${steer} for 5s, let go\n`);
  console.log('   t     km/h   slip°  yaw/s  sliding');
  for (let t = 0; t < TICK_RATE * 14; t++) {
    const s = t < TICK_RATE * 6 ? 0 : t < TICK_RATE * 11 ? steer : 0;
    stepSim(st, { steer: s }, car, wide, cfg);
    if (t % 30 === 0 && t >= TICK_RATE * 5) {
      console.log(
        `${fmt(t / TICK_RATE, 4, 1)} ${fmt(st.speed * 3.6, 8, 1)} ${fmt((st.slipAngle * 180) / Math.PI, 7, 1)} ` +
          `${fmt(st.yawRate, 6)}  ${st.sliding ? 'yes' : ''}`,
      );
    }
  }
}

if (mode === 'lap' || mode === 'drift') {
  const drifting = mode === 'drift';
  const st = createSimState(route, car);
  const cfg = configFor(drifting ? 'driftRun' : 'timeAttack');
  const out = { steer: 0 };
  const input = { steer: 0 };

  console.log(`${car.name} -- ${route.name} (${mode})\n`);
  console.log('   t    dist     km/h   slip°   off  mult    pending  zone');

  let peakSpeed = 0;
  let peakSlip = 0;
  while (!st.finished && st.tick < TICK_RATE * 300) {
    if (st.tick % TICKS_PER_INPUT === 0) driveBot(st, route, car, DEFAULT_BOT, out);
    input.steer = out.steer;
    stepSim(st, input, car, route, cfg);
    peakSpeed = Math.max(peakSpeed, st.speed);
    peakSlip = Math.max(peakSlip, Math.abs(st.slipAngle));
    if (st.tick % 240 === 0) {
      console.log(
        `${fmt(st.tick / TICK_RATE, 4, 1)} ${fmt(st.distance, 7, 0)} ${fmt(st.speed * 3.6, 8, 1)} ` +
          `${fmt((st.slipAngle * 180) / Math.PI, 7, 1)} ${fmt(st.lateralOffset, 5, 1)} ` +
          `${fmt(st.drift.multiplier, 5, 1)} ${fmt(st.drift.pending, 10, 0)} ${String(st.drift.activeZone).padStart(5)}`,
      );
    }
  }

  const result = gradeRun(st, route, TICK_RATE);
  console.log(`\nfinished: ${st.finished}`);
  console.log(`time:      ${result.timeSeconds.toFixed(2)}s (theoretical min ${route.theoreticalMinTime}s)`);
  console.log(`walls:     ${st.wallHits}  (penalty ${(st.penaltyTicks / TICK_RATE).toFixed(1)}s)`);
  console.log(`peak:      ${(peakSpeed * 3.6).toFixed(1)} km/h, ${((peakSlip * 180) / Math.PI).toFixed(1)}° slip`);
  if (drifting) {
    console.log(`banked:    ${Math.round(st.drift.banked)} -> ${result.points} pts`);
    console.log(`grade:     ${result.grade} (x${result.styleModifier.toFixed(2)})`);
    console.log(`zones:     ${result.zonesCleared}/${result.zonesTotal} cleared, ${result.reversals} reversals`);
  }
}
