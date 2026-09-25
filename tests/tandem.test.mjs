import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createSimState, quantiseInput, dequantiseInput, InputRecorder, TICK_RATE, TICKS_PER_INPUT } from '../src/sim/index.ts';
import { createTandem, stepTandem, tandemScore, placeAhead, proximity, bumperGap } from '../src/sim/tandem.ts';
import { carById } from '../src/data/cars.ts';
import { configFor, DRIFT_CONTROL } from '../src/data/assist.ts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(resolve(here, '../public/routes', `${name}.json`), 'utf8'));
const ROUTES = ['akari-downhill', 'estoril', 'nurburg', 'haruna-upper', 'haruna-middle', 'haruna-lower'].map(load);
const config = configFor('driftRun', 'throttle');

/** A stand-in player: throws it in before corners and balances the angle, like the sim tests' driver. */
function standIn() {
  let throttle = 0;
  let hold = 0;
  return (s, route) => {
    const sign = (m) => {
      const last = route.samples.x.length - 1;
      for (let j = 0; j <= Math.round(m / route.sampleSpacing); j++) {
        const k = route.samples.curvature[Math.min(last, s.sampleIndex + j)];
        if (Math.abs(k) > 1 / 60) return Math.sign(k);
      }
      return 0;
    };
    const next = sign(24);
    let tap = false;
    if (s.driftDir === 0 && s.spinTicks === 0 && next !== 0) tap = true;
    if (s.driftDir !== 0 && next === -s.driftDir) tap = true;
    if (tap && hold === 0) hold = 13;
    const keep = s.driftDir === 0 || (sign(40) !== 0 && s.driftAngle < DRIFT_CONTROL.limitAngle - 0.12);
    throttle = Math.min(1, Math.max(0, throttle + (keep ? 1 / 0.45 : -1 / 0.3) / 60));
    const out = { throttle, tap: hold > 0 };
    if (hold > 0) hold--;
    return out;
  };
}

/** A player leading the house chaser, sampled at 60Hz and recorded, as the game does. */
function leadRun(route, car) {
  const state = createSimState(route, car);
  placeAhead(state, route);
  const t = createTandem(route, 'lead', car, { kind: 'chaseBot', skill: 0.8 });
  const drive = standIn();
  const rec = new InputRecorder();
  const input = { steer: 0, throttle: 0, initiate: false };
  let held = quantiseInput(0, 0, false);
  const gaps = [];
  while (!state.finished && state.tick < TICK_RATE * 400) {
    if (state.tick % TICKS_PER_INPUT === 0) {
      const o = drive(state, route);
      held = quantiseInput(0, o.throttle, o.tap);
      rec.push(held);
    }
    dequantiseInput(held, input);
    stepTandem(t, state, input, car, route, config);
    if (state.tick % 12 === 0 && state.driftDir !== 0) gaps.push(t.gapLengths);
  }
  gaps.sort((a, b) => a - b);
  return { state, t, rec, medianGap: gaps[Math.floor(gaps.length / 2)] };
}

test('tandem: the leader starts a car length of clear road ahead of the chaser', () => {
  const route = ROUTES[0];
  const lead = createSimState(route, carById('silvia'));
  const chase = createSimState(route, carById('silvia'));
  placeAhead(lead, route);
  const gap = bumperGap(lead, chase);
  assert.ok(gap > 0.8 && gap < 1.2, `start gap ${gap.toFixed(2)} car lengths`);
});

test('tandem: closeness pays in full within a car length, and nothing for passing', () => {
  assert.equal(proximity(0.5), 1);
  assert.equal(proximity(1), 1);
  assert.ok(proximity(2) < 1 && proximity(2) > proximity(3));
  assert.equal(proximity(7), 0);
  assert.equal(proximity(-1), 0, 'alongside or ahead is not chasing');
});

test('tandem: the house chaser keeps close on every route, and every run finishes', () => {
  for (const route of ROUTES) {
    const car = carById('silvia');
    const run = leadRun(route, car);
    assert.ok(run.state.finished, `did not finish ${route.name}`);
    assert.ok(run.medianGap < 2, `the chaser sat ${run.medianGap.toFixed(1)} car lengths back on ${route.name}`);
    assert.ok(run.t.opponent.contacts <= 2, `${run.t.opponent.contacts} contacts on ${route.name}`);
    assert.ok(tandemScore(run.t.opponent) > 25, `the chaser scored ${tandemScore(run.t.opponent)} on ${route.name}`);
  }
});

test('tandem: a run replays exactly from the player inputs alone', () => {
  const route = ROUTES[1];
  const car = carById('drift-supra');
  const live = leadRun(route, car);

  const state = createSimState(route, car);
  placeAhead(state, route);
  const t = createTandem(route, 'lead', car, { kind: 'chaseBot', skill: 0.8 });
  const decoded = InputRecorder.decode(live.rec.encode());
  const q = { steer: 0, throttle: 0, flags: 0 };
  const input = { steer: 0, throttle: 0, initiate: false };
  while (!state.finished && state.tick < live.state.tick + 10) {
    decoded.at(Math.floor(state.tick / TICKS_PER_INPUT), q);
    dequantiseInput(q, input);
    stepTandem(t, state, input, car, route, config);
  }
  assert.equal(state.tick, live.state.tick);
  assert.equal(state.x, live.state.x);
  assert.equal(t.partner.x, live.t.partner.x, 'the computer chaser diverged');
  assert.equal(tandemScore(t.player), tandemScore(live.t.player));
  assert.equal(tandemScore(t.opponent), tandemScore(live.t.opponent));
});

test('tandem: a player chasing the house leader is steered onto its line', () => {
  const route = ROUTES[0];
  const car = carById('silvia');
  const state = createSimState(route, car);
  const t = createTandem(route, 'chase', car, { kind: 'leadBot', skill: 0.8 });
  const drive = standIn();
  const offsets = [];
  while (!state.finished && state.tick < TICK_RATE * 60) {
    const o = drive(state, route);
    stepTandem(t, state, { steer: 0, throttle: o.throttle, initiate: o.tap }, car, route, config);
    if (state.driftDir !== 0 && t.gapLengths > 0 && t.gapLengths < 2) offsets.push(Math.abs(state.lateralOffset - t.partner.lateralOffset));
  }
  offsets.sort((a, b) => a - b);
  const median = offsets[Math.floor(offsets.length / 2)];
  assert.ok(offsets.length > 50, 'never close enough to judge');
  assert.ok(median < 2.5, `the chaser ran ${median.toFixed(1)}m off the leader's line`);
});

test('tandem: cars that hit bounce apart and trade speed, and the chaser is charged', () => {
  // A chaser a little behind the leader and much faster, on a straight: it runs into it.
  const route = ROUTES[1];
  const car = carById('silvia');
  const lead = createSimState(route, car);
  placeAhead(lead, route);
  const t = createTandem(route, 'chase', car, { kind: 'leadBot', skill: 0.8 });
  // The leader is the partner; put it just in front of the player, slow.
  Object.assign(t.partner, { x: lead.x, y: lead.y, heading: lead.heading, sampleIndex: lead.sampleIndex, distance: lead.distance });
  const player = createSimState(route, car);
  const h = lead.heading;
  Object.assign(player, { x: lead.x - Math.cos(h) * 4.2, y: lead.y - Math.sin(h) * 4.2, heading: h, sampleIndex: lead.sampleIndex, distance: lead.distance - 4.2 });
  player.vx = 25; player.speed = 25;
  t.partner.vx = 10; t.partner.speed = 10;
  let hit = 0;
  for (let i = 0; i < 12; i++) {
    stepTandem(t, player, { steer: 0, throttle: 1, initiate: false }, car, route, config);
    hit = Math.max(hit, t.impact);
  }
  assert.ok(hit > 5, `the hit was only ${hit.toFixed(1)} m/s`);
  assert.ok(player.speed < 22, `the chaser kept ${player.speed.toFixed(1)} m/s through the hit`);
  assert.ok(t.partner.speed > 12, `the leader was not pushed: ${t.partner.speed.toFixed(1)} m/s`);
  const gap = Math.hypot(player.x - t.partner.x, player.y - t.partner.y);
  assert.ok(gap > 3.5, `the cars are still inside each other: ${gap.toFixed(2)} m apart`);
  assert.equal(t.player.contacts, 1, 'one hit, one contact');
  assert.equal(t.opponent.contacts, 0, 'the leader is not charged');
});

test('tandem: each difficulty level drives better than the one below, leading and chasing', () => {
  // The four characters' skills. Scores averaged over three routes, against
  // the same stand-in driver, so only the house driver changes.
  const skills = [0.6, 0.8, 0.9, 1.0];
  const sample = [ROUTES[0], ROUTES[2], ROUTES[4]];
  const car = carById('silvia');
  const leads = [];
  const chases = [];
  for (const skill of skills) {
    let lead = 0;
    let chase = 0;
    for (const route of sample) {
      const a = createSimState(route, car);
      const ta = createTandem(route, 'chase', car, { kind: 'leadBot', skill });
      const da = standIn();
      while (!a.finished && a.tick < TICK_RATE * 400) {
        const o = da(a, route);
        stepTandem(ta, a, { steer: 0, throttle: o.throttle, initiate: o.tap }, car, route, config);
      }
      lead += tandemScore(ta.opponent);
      const b = createSimState(route, car);
      placeAhead(b, route);
      const tb = createTandem(route, 'lead', car, { kind: 'chaseBot', skill });
      const db = standIn();
      while (!b.finished && b.tick < TICK_RATE * 400) {
        const o = db(b, route);
        stepTandem(tb, b, { steer: 0, throttle: o.throttle, initiate: o.tap }, car, route, config);
      }
      chase += tandemScore(tb.opponent);
    }
    leads.push(lead / sample.length);
    chases.push(chase / sample.length);
  }
  for (let i = 1; i < skills.length; i++) {
    assert.ok(leads[i] > leads[i - 1] + 3, `leading: skill ${skills[i]} scored ${leads[i].toFixed(0)}, below ${skills[i - 1]}'s ${leads[i - 1].toFixed(0)}`);
    // The Pro and the King chase about equally well; the King leads better.
    assert.ok(chases[i] > chases[i - 1] - 3, `chasing: skill ${skills[i]} scored ${chases[i].toFixed(0)}, below ${skills[i - 1]}'s ${chases[i - 1].toFixed(0)}`);
  }
  assert.ok(chases[3] > chases[0] + 20, 'the Drift King chases no better than the Rookie');
  assert.ok(leads[3] >= 85, `the Drift King only led to ${leads[3].toFixed(0)}`);
});

test("tandem: the judges' breakdown adds up to the score, and names a reason", async () => {
  const { runVerdict } = await import('../src/ui/judges.ts');
  for (const route of ROUTES.slice(0, 3)) {
    const { t } = leadRun(route, carById('silvia'));
    for (const side of [t.player, t.opponent]) {
      const lost = side.lostDrift + side.lostAngle + side.lostGap + side.lostMatch;
      assert.ok(Math.abs(side.qualitySum + lost - side.zoneTicks) < 1e-6, `${side.role} on ${route.name}: the losses do not add up`);
    }
    const line = runVerdict('Run 2', 'NORICK', t.player, t.opponent);
    assert.match(line, /^Run 2 (to (you|NORICK)|level)/);
    console.log(`    ${route.name}: ${tandemScore(t.player)}-${tandemScore(t.opponent)} ${line}`);
  }
});
