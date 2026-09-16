import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOUCH_ACTIONS,
  defaultLayout,
  buttonSize,
  clampCentre,
  mirror,
  normaliseLayout,
  orientationOf,
  actionAt,
  resolvePressed,
  MIN_SCALE,
  MAX_SCALE,
} from '../src/input/touchLayout.ts';
import { InputController } from '../src/input/input.ts';

/**
 * Real viewport sizes in CSS pixels, both orientations: small Android, iPhone,
 * large Android, iPad. The default layout has to work on all of them without
 * the player touching the editor, because most players never will.
 */
const VIEWPORTS = [
  [360, 740],
  [390, 844],
  [412, 915],
  [768, 1024],
  [740, 360],
  [844, 390],
  [915, 412],
  [1024, 768],
];

/** Minimum clear space between the screen edge and any button. */
const GUTTER = 12;

function rectsFor(layout, width, height, scale = 1) {
  const orientation = orientationOf(width, height);
  const rects = {};
  for (const action of TOUCH_ACTIONS) {
    const size = buttonSize(action, width, height, scale);
    const p = layout[orientation][action];
    const cx = p.x * width;
    const cy = p.y * height;
    rects[action] = {
      left: cx - size / 2,
      right: cx + size / 2,
      top: cy - size / 2,
      bottom: cy + size / 2,
    };
  }
  return rects;
}

// --- Default layout ----------------------------------------------------------

test('default buttons never overlap, on any common screen', () => {
  const layout = defaultLayout();
  for (const [w, h] of VIEWPORTS) {
    const rects = rectsFor(layout, w, h);
    for (let i = 0; i < TOUCH_ACTIONS.length; i++) {
      for (let j = i + 1; j < TOUCH_ACTIONS.length; j++) {
        const a = rects[TOUCH_ACTIONS[i]];
        const b = rects[TOUCH_ACTIONS[j]];
        const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        assert.ok(
          !overlaps,
          `${TOUCH_ACTIONS[i]} and ${TOUCH_ACTIONS[j]} overlap on a ${w}x${h} screen`,
        );
      }
    }
  }
});

test('default buttons stay clear of the screen edges', () => {
  const layout = defaultLayout();
  for (const [w, h] of VIEWPORTS) {
    const rects = rectsFor(layout, w, h);
    for (const action of TOUCH_ACTIONS) {
      const r = rects[action];
      assert.ok(
        r.left >= GUTTER && r.top >= GUTTER && r.right <= w - GUTTER && r.bottom <= h - GUTTER,
        `${action} is within ${GUTTER}px of the edge on a ${w}x${h} screen ` +
          `(${r.left.toFixed(0)},${r.top.toFixed(0)} to ${r.right.toFixed(0)},${r.bottom.toFixed(0)})`,
      );
    }
  }
});

test('default buttons sit in the lower part of the screen, clear of the HUD', () => {
  const layout = defaultLayout();
  for (const orientation of ['portrait', 'landscape']) {
    for (const action of TOUCH_ACTIONS) {
      assert.ok(
        layout[orientation][action].y >= 0.45,
        `${action} in ${orientation} sits too high, under the score and pace notes`,
      );
    }
  }
});

test('steering is under the left thumb and the pedals under the right', () => {
  for (const orientation of ['portrait', 'landscape']) {
    const l = defaultLayout()[orientation];
    assert.ok(l.left.x < l.right.x, `${orientation}: left arrow should be left of right arrow`);
    assert.ok(l.right.x < 0.5, `${orientation}: steering belongs on the left half`);
    assert.ok(l.accelerate.x > 0.5, `${orientation}: throttle belongs on the right half`);
    assert.ok(l.handbrake.x > 0.5, `${orientation}: handbrake belongs on the right half`);
  }
});

test('button size follows the screen, within sensible limits', () => {
  const small = buttonSize('left', 360, 740, 1);
  const large = buttonSize('left', 412, 915, 1);
  assert.ok(large > small, 'a bigger phone should get a bigger button');
  // A tablet must not produce enormous buttons.
  assert.ok(buttonSize('left', 1024, 1366, 1) <= 96);
  // The throttle is the biggest target.
  assert.ok(buttonSize('accelerate', 390, 844, 1) > buttonSize('left', 390, 844, 1));
  // The size slider scales, within its bounds.
  assert.ok(buttonSize('left', 390, 844, 1.5) > buttonSize('left', 390, 844, 1));
  assert.equal(buttonSize('left', 390, 844, 99), buttonSize('left', 390, 844, MAX_SCALE));
  assert.equal(buttonSize('left', 390, 844, 0), buttonSize('left', 390, 844, MIN_SCALE));
});

// --- Editing -----------------------------------------------------------------

test('a dragged button cannot be pushed off screen', () => {
  for (const drop of [{ x: -1, y: 0.5 }, { x: 2, y: 0.5 }, { x: 0.5, y: -3 }, { x: 0.5, y: 9 }]) {
    const size = 80;
    const p = clampCentre(drop, size, 390, 844, 8);
    const cx = p.x * 390;
    const cy = p.y * 844;
    assert.ok(cx - size / 2 >= 8 - 1e-9 && cx + size / 2 <= 390 - 8 + 1e-9, `x escaped for ${JSON.stringify(drop)}`);
    assert.ok(cy - size / 2 >= 8 - 1e-9 && cy + size / 2 <= 844 - 8 + 1e-9, `y escaped for ${JSON.stringify(drop)}`);
  }
});

test('left-handed mode mirrors across the centre', () => {
  assert.deepEqual(mirror({ x: 0.1, y: 0.8 }), { x: 0.9, y: 0.8 });
  assert.deepEqual(mirror(mirror({ x: 0.27, y: 0.4 })), { x: 0.27, y: 0.4 });
});

test('a saved layout survives missing or damaged data', () => {
  // Settings saved before touch controls existed.
  assert.deepEqual(normaliseLayout(undefined), defaultLayout());
  assert.deepEqual(normaliseLayout('nonsense'), defaultLayout());

  // One good custom position, one broken one, one missing orientation.
  const partial = normaliseLayout({
    portrait: { left: { x: 0.3, y: 0.5 }, right: { x: 'no', y: null } },
    scale: 1.2,
  });
  assert.deepEqual(partial.portrait.left, { x: 0.3, y: 0.5 }, 'valid custom position kept');
  assert.deepEqual(partial.portrait.right, defaultLayout().portrait.right, 'broken position reset');
  assert.deepEqual(partial.landscape, defaultLayout().landscape, 'missing orientation defaulted');
  assert.equal(partial.scale, 1.2);

  // Out-of-range values are pulled back rather than discarded.
  const wild = normaliseLayout({ portrait: { left: { x: 7, y: -2 } }, scale: 40 });
  assert.deepEqual(wild.portrait.left, { x: 1, y: 0 });
  assert.equal(wild.scale, MAX_SCALE);
});

// --- Pressing ----------------------------------------------------------------

const RECTS = {
  left: { left: 20, top: 700, right: 90, bottom: 770 },
  right: { left: 100, top: 700, right: 170, bottom: 770 },
  accelerate: { left: 290, top: 690, right: 380, bottom: 780 },
};

test('a touch presses the button under it', () => {
  assert.equal(actionAt(50, 730, RECTS, 14), 'left');
  assert.equal(actionAt(330, 730, RECTS, 14), 'accelerate');
  assert.equal(actionAt(200, 300, RECTS, 14), null, 'a touch on the road presses nothing');
});

test('a near miss still counts, and goes to the closer button', () => {
  // Just outside the left arrow's right edge.
  assert.equal(actionAt(93, 730, RECTS, 14), 'left');
  // In the 10px gap between the arrows, nearer the right one.
  assert.equal(actionAt(97, 730, RECTS, 14), 'right');
  // Too far from anything.
  assert.equal(actionAt(230, 730, RECTS, 14), null);
});

test('several fingers hold several buttons at once', () => {
  const held = resolvePressed([{ x: 50, y: 730 }, { x: 330, y: 740 }], RECTS, 14);
  assert.deepEqual([...held].sort(), ['accelerate', 'left']);
});

// --- Input -------------------------------------------------------------------

test('touch buttons drive the car exactly like the keyboard does', () => {
  // The on-screen buttons feed the same input path as the keys, so steering
  // ramps identically and the sim cannot tell which one a player used.
  const touch = new InputController();
  touch.setVirtual('accelerate', true);
  touch.setVirtual('left', true);

  let elapsed = 0;
  while (elapsed < 0.1) {
    touch.update(1 / 60);
    elapsed += 1 / 60;
  }
  assert.equal(touch.raw.throttle, 1);
  assert.ok(touch.raw.steer < 0 && touch.raw.steer > -1, 'steering ramps rather than snapping');

  for (let i = 0; i < 30; i++) touch.update(1 / 60);
  assert.equal(touch.raw.steer, -1, 'held long enough, it reaches full lock');

  touch.setVirtual('handbrake', true);
  touch.update(1 / 60);
  assert.equal(touch.raw.handbrake, true);

  touch.releaseAll();
  assert.equal(touch.raw.throttle, 0);
  assert.equal(touch.raw.steer, 0);
  assert.equal(touch.raw.handbrake, false);
});

test('gas and brake together cancel, as on a keyboard', () => {
  const input = new InputController();
  input.setVirtual('accelerate', true);
  input.setVirtual('brake', true);
  input.update(1 / 60);
  assert.equal(input.raw.throttle, 0);
});
