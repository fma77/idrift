import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Camera, carScreenY, isLandscape } from '../src/render/camera.ts';
import { sin, cos, HALF_PI } from '../src/sim/math/trig.ts';

/**
 * The camera transform is pure matrix maths with no DOM dependency beyond the
 * shape of setTransform, so it is worth testing here rather than by eye in a
 * browser. Getting it wrong is the kind of bug that looks like "the car is in a
 * slightly odd place" and survives a long time.
 */

/** Minimal stand-in for CanvasRenderingContext2D that records the matrix. */
function fakeCtx() {
  return {
    m: null,
    setTransform(a, b, c, d, e, f) {
      this.m = { a, b, c, d, e, f };
    },
  };
}

/** Apply a recorded matrix to a world point, giving device pixels. */
function project(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function makeCamera({ x = 0, y = 0, angle = HALF_PI, scale = 12 } = {}) {
  const cam = new Camera();
  cam.x = x;
  cam.y = y;
  cam.angle = angle;
  cam.scale = scale;
  return cam;
}

const W = 800;
const H = 600;
const ANCHOR_X = W / 2;
// Where the car sits up the screen: lower when the phone is held sideways,
// which the camera itself decides.
const ANCHOR_Y = carScreenY(W, H);

test('the camera position maps to the on-screen anchor', () => {
  for (const dpr of [1, 2, 1.5]) {
    for (const angle of [0, 0.7, HALF_PI, 3.0, -2.2]) {
      const cam = makeCamera({ x: 137.4, y: -82.9, angle, scale: 14 });
      const ctx = fakeCtx();
      cam.applyTo(ctx, W, H, dpr);
      const p = project(ctx.m, cam.x, cam.y);
      assert.ok(Math.abs(p.x - ANCHOR_X * dpr) < 1e-6, `x at dpr ${dpr}, angle ${angle}`);
      assert.ok(Math.abs(p.y - ANCHOR_Y * dpr) < 1e-6, `y at dpr ${dpr}, angle ${angle}`);
    }
  }
});

test('device pixel ratio scales the whole transform, not just the origin', () => {
  // Regression: applyTo calls setTransform, which REPLACES rather than
  // multiplies. A caller that set a dpr scale beforehand had it silently
  // discarded, which put the world in the wrong place on every retina device.
  const cam = makeCamera({ x: 40, y: 15, angle: 1.1, scale: 10 });
  const one = fakeCtx();
  const two = fakeCtx();
  cam.applyTo(one, W, H, 1);
  cam.applyTo(two, W, H, 2);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(
      Math.abs(two.m[key] - one.m[key] * 2) < 1e-9,
      `matrix component ${key} did not scale with dpr`,
    );
  }
});

test('the camera forward direction points up the screen', () => {
  for (const angle of [0, 0.9, HALF_PI, 2.5, -1.3]) {
    const cam = makeCamera({ x: -12, y: 60, angle, scale: 9 });
    const ctx = fakeCtx();
    cam.applyTo(ctx, W, H, 1);

    // 10 metres ahead along the camera's own heading.
    const ahead = project(ctx.m, cam.x + cos(angle) * 10, cam.y + sin(angle) * 10);
    assert.ok(Math.abs(ahead.x - ANCHOR_X) < 1e-4, `ahead drifted sideways at angle ${angle}`);
    // Canvas y grows downward, so "up the screen" is a smaller y.
    assert.ok(ahead.y < ANCHOR_Y - 1, `ahead was not up-screen at angle ${angle}`);
    assert.ok(
      Math.abs(ANCHOR_Y - ahead.y - 10 * cam.scale) < 1e-4,
      'distance ahead did not scale by pixels-per-metre',
    );
  }
});

test('world left appears on the left of the screen', () => {
  for (const angle of [0, 0.9, HALF_PI, 2.5, -1.3]) {
    const cam = makeCamera({ x: 5, y: -5, angle, scale: 9 });
    const ctx = fakeCtx();
    cam.applyTo(ctx, W, H, 1);

    // The camera's left is a quarter turn counter-clockwise from its heading.
    const left = project(ctx.m, cam.x + cos(angle + HALF_PI) * 10, cam.y + sin(angle + HALF_PI) * 10);
    assert.ok(left.x < ANCHOR_X - 1, `camera-left was not screen-left at angle ${angle}`);
    assert.ok(Math.abs(left.y - ANCHOR_Y) < 1e-4, `camera-left drifted vertically at angle ${angle}`);
  }
});

test('zoom is viewport-relative, so a phone and a tablet see the same road', () => {
  const state = { x: 0, y: 0, heading: 0, speed: 0, slipAngle: 0 };
  const settings = { fixedNorth: false };

  const phone = new Camera();
  const tablet = new Camera();
  // One long step so the exponential damping has effectively converged.
  for (let i = 0; i < 400; i++) {
    phone.follow(state, settings, 1 / 60, 390, 844);
    tablet.follow(state, settings, 1 / 60, 768, 1024);
  }

  const roadWidth = 7;
  const phoneFraction = (roadWidth * phone.scale) / 390;
  const tabletFraction = (roadWidth * tablet.scale) / 768;
  assert.ok(
    Math.abs(phoneFraction - tabletFraction) < 1e-6,
    `road occupied ${phoneFraction} of the phone's short edge but ${tabletFraction} of the tablet's`,
  );
  // And it should be a sane fraction, not a hairline or a wall.
  assert.ok(phoneFraction > 0.12 && phoneFraction < 0.4, `road fraction was ${phoneFraction}`);
});

test('held sideways, the car sits lower and the view pulls back', () => {
  // A landscape phone is short: at the portrait zoom and anchor it showed half
  // the road ahead that portrait did, which is the one thing a driver needs.
  assert.ok(isLandscape(844, 390) && !isLandscape(390, 844));
  // A tablet held upright is not landscape, whatever its width.
  assert.ok(!isLandscape(768, 1024));

  const state = { x: 0, y: 0, heading: 0, speed: 0, slipAngle: 0 };
  const settings = { fixedNorth: false };
  const portrait = new Camera();
  const landscape = new Camera();
  for (let i = 0; i < 400; i++) {
    portrait.follow(state, settings, 1 / 60, 390, 844);
    landscape.follow(state, settings, 1 / 60, 844, 390);
  }

  // Metres of road between the car and the top of the screen.
  const aheadPortrait = carScreenY(390, 844) / portrait.scale;
  const aheadLandscape = carScreenY(844, 390) / landscape.scale;
  assert.ok(
    aheadLandscape > aheadPortrait * 0.65,
    `sideways showed ${aheadLandscape.toFixed(1)}m ahead against ${aheadPortrait.toFixed(1)}m upright`,
  );
  // The car still has to be big enough to read: this is not a zoom to the moon.
  assert.ok(landscape.scale > portrait.scale * 0.7, 'sideways zoomed out too far');
});

test('camera rotation damps rather than snapping', () => {
  const settings = { fixedNorth: false };
  const cam = new Camera();
  const state = { x: 0, y: 0, heading: 0, speed: 30, slipAngle: 0 };
  cam.follow(state, settings, 1 / 60, 800, 600); // settles on the first call

  // A sudden 40-degree change of course, as at the moment a drift breaks loose.
  state.slipAngle = 0.7;
  cam.follow(state, settings, 1 / 60, 800, 600);
  assert.ok(cam.angle > 0, 'camera should move toward the new course');
  assert.ok(cam.angle < 0.7 * 0.2, `camera snapped ${cam.angle} of 0.7 rad in a single frame`);
});

test('fixed north disables rotation entirely', () => {
  const cam = new Camera();
  const state = { x: 0, y: 0, heading: 2.2, speed: 25, slipAngle: -0.4 };
  for (let i = 0; i < 600; i++) cam.follow(state, { fixedNorth: true }, 1 / 60, 800, 600);
  assert.ok(Math.abs(cam.angle - HALF_PI) < 1e-6, `fixed north drifted to ${cam.angle}`);
});

test('a zero-sized viewport never collapses the zoom', () => {
  // Regression: a canvas measured mid-layout (orientation change, still
  // display:none, backgrounded tab) reports 0x0. Taking that literally set
  // pixels-per-metre to ~0, rendering the entire world as a dot -- and because
  // zoom was damped, it then crawled back over several visible seconds.
  const cam = new Camera();
  const state = { x: 0, y: 0, heading: 0, speed: 20, slipAngle: 0 };
  const settings = { fixedNorth: false };
  for (let i = 0; i < 200; i++) cam.follow(state, settings, 1 / 60, 1280, 720);
  const good = cam.scale;
  assert.ok(good > 1, `expected a sane scale, got ${good}`);

  cam.applyZoom(0, 0);
  assert.equal(cam.scale, good, 'a 0x0 viewport must be ignored, not obeyed');
  cam.follow(state, settings, 1 / 60, 0, 0);
  assert.equal(cam.scale, good, 'a 0x0 follow must not change the scale either');
});

test('resizing re-derives zoom immediately, without a zoom animation', () => {
  const cam = new Camera();
  const state = { x: 0, y: 0, heading: 0, speed: 28, slipAngle: 0 };
  const settings = { fixedNorth: false };
  for (let i = 0; i < 300; i++) cam.follow(state, settings, 1 / 60, 1280, 720);

  const metresBefore = 720 / cam.scale;
  // Phone rotation: short edge changes from 720 to 390.
  cam.applyZoom(844, 390);
  const metresAfter = 390 / cam.scale;

  assert.ok(
    Math.abs(metresAfter - metresBefore) < 1e-9,
    `view width in metres changed from ${metresBefore} to ${metresAfter} across a resize`,
  );
});
