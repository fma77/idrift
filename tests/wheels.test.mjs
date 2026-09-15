import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawWheels } from '../src/render/renderer.ts';
import { carById } from '../src/data/cars.ts';

/**
 * Where the wheels are drawn is geometry, so it can be checked exactly rather
 * than squinted at in a browser.
 *
 * The bug this exists for: the front wheels were drawn by translating to the
 * middle of the front axle and rotating the pair together. That puts the pivot
 * on the car's centreline, so steering swept one wheel forwards and the other
 * backwards, and the axle appeared to swing about the middle of the car. A real
 * steering axis runs down through each wheel -- each turns where it stands.
 */

/**
 * A stand-in for CanvasRenderingContext2D that tracks the transform stack and
 * records the world-space centre and orientation of every rect drawn.
 */
function recordingCtx() {
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const rects = [];

  /** this ∘ other, with `other` applied first, matching canvas semantics. */
  const mul = (M, N) => ({
    a: M.a * N.a + M.c * N.b,
    b: M.b * N.a + M.d * N.b,
    c: M.a * N.c + M.c * N.d,
    d: M.b * N.c + M.d * N.d,
    e: M.a * N.e + M.c * N.f + M.e,
    f: M.b * N.e + M.d * N.f + M.f,
  });
  const apply = (M, x, y) => ({ x: M.a * x + M.c * y + M.e, y: M.b * x + M.d * y + M.f });

  return {
    fillStyle: '',
    rects,
    save() {
      stack.push({ ...m });
    },
    restore() {
      const popped = stack.pop();
      if (popped) m = popped;
    },
    translate(tx, ty) {
      m = mul(m, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
    },
    rotate(angle) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      m = mul(m, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    fillRect(x, y, w, h) {
      const centre = apply(m, x + w / 2, y + h / 2);
      // Direction of the rect's own +x axis, which for a wheel is the way it points.
      const nose = apply(m, x + w, y + h / 2);
      rects.push({
        centre,
        angle: Math.atan2(nose.y - centre.y, nose.x - centre.x),
      });
    },
  };
}

function wheelsAt(car, steerAngle) {
  const ctx = recordingCtx();
  drawWheels(ctx, car, steerAngle);
  assert.equal(ctx.rects.length, 4, 'expected four wheels');
  // drawWheels emits front then rear, for each side.
  return {
    front: [ctx.rects[0], ctx.rects[2]],
    rear: [ctx.rects[1], ctx.rects[3]],
  };
}

const car = carById('kaido-zen-r');

test('steering does not move the wheels, only turns them', () => {
  const straight = wheelsAt(car, 0);

  for (const angle of [-car.maxSteerAngle, -0.2, 0.2, car.maxSteerAngle]) {
    const steered = wheelsAt(car, angle);

    for (let i = 0; i < 2; i++) {
      const a = straight.front[i].centre;
      const b = steered.front[i].centre;
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      assert.ok(
        moved < 1e-9,
        `front wheel ${i} moved ${moved.toFixed(4)}m when steering to ${angle.toFixed(2)} rad — ` +
          'it should pivot about its own centre, not swing about the car',
      );
    }
  }
});

test('the front wheels turn with the steering, the rears do not', () => {
  for (const angle of [-0.4, 0.4, car.maxSteerAngle]) {
    const wheels = wheelsAt(car, angle);
    for (let i = 0; i < 2; i++) {
      assert.ok(
        Math.abs(wheels.front[i].angle - angle) < 1e-9,
        `front wheel ${i} pointed ${wheels.front[i].angle} instead of ${angle}`,
      );
      assert.ok(
        Math.abs(wheels.rear[i].angle) < 1e-9,
        `rear wheel ${i} steered to ${wheels.rear[i].angle}; the rears are fixed`,
      );
    }
  }
});

test('the wheels sit at the axles, one per corner', () => {
  const wheels = wheelsAt(car, 0);
  const halfTrack = car.bodyWidth / 2;

  const sides = wheels.front.map((w) => w.centre.y).sort((a, b) => a - b);
  assert.ok(Math.abs(sides[0] + halfTrack) < 1e-9, 'front wheels straddle the body width');
  assert.ok(Math.abs(sides[1] - halfTrack) < 1e-9, 'front wheels straddle the body width');

  for (const w of wheels.front) {
    assert.ok(Math.abs(w.centre.x - car.cgToFront) < 1e-9, 'front wheels sit on the front axle');
  }
  for (const w of wheels.rear) {
    assert.ok(Math.abs(w.centre.x + car.cgToRear) < 1e-9, 'rear wheels sit on the rear axle');
  }

  // All four in distinct corners.
  const corners = new Set(
    [...wheels.front, ...wheels.rear].map((w) => `${w.centre.x.toFixed(3)},${w.centre.y.toFixed(3)}`),
  );
  assert.equal(corners.size, 4, 'each wheel should be in its own corner');
});
