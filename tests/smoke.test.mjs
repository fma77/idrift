import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TyreSmoke } from '../src/render/smoke.ts';
import { carById } from '../src/data/cars.ts';

const car = carById('kaido-zen-r');

function slide(seconds, angle, sliding = true) {
  const smoke = new TyreSmoke();
  const state = { x: 0, y: 0, heading: 0, vx: 18, vy: -18 * Math.tan(angle), speed: 18, slipAngle: -angle, sliding };
  for (let t = 0; t < seconds; t += 1 / 60) smoke.update(state, car, 1 / 60);
  return smoke.live();
}

test('gripping makes no smoke', () => {
  assert.equal(slide(2, 0.05, false), 0);
});

test('a bigger angle makes more smoke', () => {
  assert.ok(slide(1, 0.8) > slide(1, 0.3) * 1.5);
});

test('a longer slide builds more smoke than a short one', () => {
  // Per second of sliding: the smoke thickens as the slide goes on.
  const short = slide(0.4, 0.7) / 0.4;
  const long = slide(1.6, 0.7) / 1.6;
  assert.ok(long > short * 1.5, `short ${short.toFixed(1)}/s, long ${long.toFixed(1)}/s`);
});
