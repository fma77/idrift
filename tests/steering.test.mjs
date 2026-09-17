import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSlider, sliderRange, MIN_SENSITIVITY, MAX_SENSITIVITY } from '../src/input/thumbSteer.ts';
import { InputController } from '../src/input/input.ts';

// --- The thumb slider -------------------------------------------------------

test('the thumb steers by how far it has slid from where it landed', () => {
  assert.equal(readSlider(200, 200, 100).steer, 0, 'landing is centre');
  assert.equal(readSlider(200, 250, 100).steer, 0.5);
  assert.equal(readSlider(200, 125, 100).steer, -0.75);
  assert.equal(readSlider(200, 300, 100).steer, 1);
});

test('sliding right steers right, and left steers left', () => {
  assert.ok(readSlider(200, 260, 100).steer > 0);
  assert.ok(readSlider(200, 140, 100).steer < 0);
});

test('overshooting drags centre along, so reversing responds at once', () => {
  // Thumb slides 80px past full right.
  const far = readSlider(200, 380, 100);
  assert.equal(far.steer, 1);
  assert.equal(far.anchor, 280, 'centre follows the thumb once past full steering');

  // Coming back 50px from there is half steering, not still full right. Without
  // the drag it would be 180px from the old centre and still clamped at 1.
  const back = readSlider(far.anchor, 330, 100);
  assert.equal(back.steer, 0.5);
});

test('within range, centre stays where the thumb landed', () => {
  let anchor = 200;
  for (const x of [220, 260, 180, 150, 240]) {
    anchor = readSlider(anchor, x, 100).anchor;
    assert.equal(anchor, 200);
  }
});

test('slider travel suits the screen and the sensitivity setting', () => {
  const phone = sliderRange(390, 844, 1);
  assert.ok(phone >= 60 && phone <= 140, `phone travel ${phone}px`);
  // A tablet does not ask for a huge thumb movement.
  assert.ok(sliderRange(1024, 1366, 1) <= 140);
  // Landscape and portrait of the same phone feel the same.
  assert.equal(sliderRange(844, 390, 1), phone);
  // More sensitive means less travel, within bounds.
  assert.ok(sliderRange(390, 844, 1.5) < phone);
  assert.equal(sliderRange(390, 844, 99), sliderRange(390, 844, MAX_SENSITIVITY));
  assert.equal(sliderRange(390, 844, 0.01), sliderRange(390, 844, MIN_SENSITIVITY));
});

// --- Input ------------------------------------------------------------------

test('the thumb reaches the car directly, with no ramp', () => {
  const input = new InputController();
  input.setTouchSteer(0.37);
  input.update(1 / 60);
  assert.equal(input.raw.steer, 0.37);

  // Lifting the thumb lets go immediately; the car does the straightening.
  input.setTouchSteer(null);
  input.update(1 / 60);
  assert.equal(input.raw.steer, 0);
});

test('keys ramp steering rather than snapping to full', () => {
  const input = new InputController();
  input.press('ArrowRight', true);
  input.update(1 / 60);
  assert.ok(input.raw.steer > 0 && input.raw.steer < 1, 'a tap is not a flick');
  for (let i = 0; i < 30; i++) input.update(1 / 60);
  assert.equal(input.raw.steer, 1, 'held long enough, it reaches full steering');

  input.press('ArrowRight', false);
  for (let i = 0; i < 30; i++) input.update(1 / 60);
  assert.equal(input.raw.steer, 0);
});

test('the thumb takes priority over a held key', () => {
  const input = new InputController();
  input.press('ArrowLeft', true);
  input.setTouchSteer(0.5);
  input.update(1 / 60);
  assert.equal(input.raw.steer, 0.5);
});

test('only steering keys are bound; the old pedals are gone', () => {
  const input = new InputController();
  assert.ok(input.isBound('ArrowLeft') && input.isBound('KeyD'));
  for (const code of ['ArrowUp', 'ArrowDown', 'Space', 'KeyW', 'KeyS']) {
    assert.ok(!input.isBound(code), `${code} should no longer do anything`);
  }
});

test('releasing everything straightens the steering', () => {
  const input = new InputController();
  input.setTouchSteer(-1);
  input.update(1 / 60);
  input.releaseAll();
  assert.equal(input.raw.steer, 0);
  input.update(1 / 60);
  assert.equal(input.raw.steer, 0, 'and it stays straight after the next frame');
});
