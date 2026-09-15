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
 */
import { readFileSync } from 'node:fs';
import { createSimState, stepSim, gradeRun, TICK_RATE, TICKS_PER_INPUT } from '../src/sim/index.ts';
import { carById, CARS } from '../src/data/cars.ts';
import { driveBot, DEFAULT_BOT } from '../src/bot/autopilot.ts';

const route = JSON.parse(readFileSync(new URL('../public/routes/akari-downhill.json', import.meta.url), 'utf8'));

const mode = process.argv[2] ?? 'accel';
const carId = process.argv[3] ?? CARS[0].id;
const car = carById(carId);

const fmt = (v, w = 7, d = 2) => v.toFixed(d).padStart(w);

if (mode === 'accel') {
  const st = createSimState(route, car);
  const cfg = { mode: 'timeAttack', assist: 0 };
  const input = { steer: 0, throttle: 1, handbrake: false };
  console.log(`${car.name} -- full throttle from rest\n`);
  console.log('   t     km/h      vx      vy   yaw/s  gear    rpm   thr    dist');
  let to100 = null;
  for (let t = 0; t < TICK_RATE * 20; t++) {
    stepSim(st, input, car, route, cfg);
    if (to100 === null && st.vx * 3.6 >= 100) to100 = t / TICK_RATE;
    if (t % 60 === 0) {
      console.log(
        `${fmt(t / TICK_RATE, 4, 1)} ${fmt(st.vx * 3.6, 8)} ${fmt(st.vx)} ${fmt(st.vy)} ` +
          `${fmt(st.yawRate)} ${String(st.gear + 1).padStart(5)} ${fmt(st.rpm, 6, 0)} ` +
          `${fmt(st.throttleApplied, 5)} ${fmt(st.distance, 7, 1)}`,
      );
    }
  }
  console.log(`\n0-100 km/h: ${to100 === null ? 'never' : to100.toFixed(2) + 's'}`);
  console.log(`top speed after 20s: ${(st.vx * 3.6).toFixed(1)} km/h`);
}

if (mode === 'lap' || mode === 'drift') {
  const drifting = mode === 'drift';
  const botConfig = drifting ? { aggression: 1.05, useHandbrake: true } : DEFAULT_BOT;
  const st = createSimState(route, car);
  const cfg = { mode: drifting ? 'driftRun' : 'timeAttack', assist: 0 };
  const out = { steer: 0, throttle: 0, handbrake: false };
  const input = { steer: 0, throttle: 0, handbrake: false };

  console.log(`${car.name} -- ${route.name} (${mode})\n`);
  console.log('   t    dist     km/h   slip°   off   gear  mult    pending  zone');

  let peakSpeed = 0;
  let peakSlip = 0;
  while (!st.finished && st.tick < TICK_RATE * 300) {
    if (st.tick % TICKS_PER_INPUT === 0) driveBot(st, route, car, botConfig, out);
    input.steer = out.steer;
    input.throttle = out.throttle;
    input.handbrake = out.handbrake;
    stepSim(st, input, car, route, cfg);
    peakSpeed = Math.max(peakSpeed, st.speed);
    peakSlip = Math.max(peakSlip, Math.abs(st.slipAngle));
    if (st.tick % 240 === 0) {
      console.log(
        `${fmt(st.tick / TICK_RATE, 4, 1)} ${fmt(st.distance, 7, 0)} ${fmt(st.speed * 3.6, 8, 1)} ` +
          `${fmt((st.slipAngle * 180) / Math.PI, 7, 1)} ${fmt(st.lateralOffset, 5, 1)} ` +
          `${String(st.gear + 1).padStart(5)} ${fmt(st.drift.multiplier, 5, 1)} ` +
          `${fmt(st.drift.pending, 10, 0)} ${String(st.drift.activeZone).padStart(5)}`,
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
