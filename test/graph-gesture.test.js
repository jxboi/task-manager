// The graph view's gestures (src/graph-gesture.js): tap versus drag, one-finger orbit, pinch
// and wheel zoom, release speed and cancel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGesture, PINCH_WHEEL_BOOST, TAP_MS, TAP_SLOP, WHEEL_SPEED, WHEEL_STEP } from '../src/graph-gesture.js';

const at = (pointerId, clientX, clientY, timeStamp = 0, pointerType = 'touch') => (
  { pointerId, pointerType, clientX, clientY, timeStamp }
);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≉ ${expected}`);

test('a press that stays within the slop and comes up quickly is a tap', () => {
  for (const [type, slop] of Object.entries(TAP_SLOP)) {
    const g = createGesture();
    assert.equal(g.down(at(1, 100, 100, 0, type)), null);
    assert.equal(g.move(at(1, 100 + slop, 100, 50, type)), null, `${type}: within the slop is not a drag yet`);
    assert.deepEqual(g.up(at(1, 100 + slop, 100, 120, type)), { type: 'tap', x: 100 + slop, y: 100, pointerType: type });
    assert.equal(g.active, false);
  }
});

test('moving past the slop is an orbit from the press point, and never a tap', () => {
  const g = createGesture();
  g.down(at(1, 100, 100));
  assert.equal(g.move(at(1, 106, 104, 10)), null); // 7.2 px: under the 10 px touch slop
  assert.deepEqual(g.move(at(1, 111, 100, 20)), { type: 'orbit', dx: 11, dy: 0 });
  assert.deepEqual(g.move(at(1, 115, 97, 30)), { type: 'orbit', dx: 4, dy: -3 });
  // Back where it started: still a drag, not a tap.
  g.move(at(1, 100, 100, 40));
  assert.equal(g.up(at(1, 100, 100, 50)).type, 'release');
});

test('the slop depends on the pointer: 6 px is a tap for touch and a drag for a mouse', () => {
  const touch = createGesture();
  touch.down(at(1, 0, 0, 0, 'touch'));
  assert.equal(touch.move(at(1, 6, 0, 10, 'touch')), null);
  assert.equal(touch.up(at(1, 6, 0, 20, 'touch')).type, 'tap');
  const mouse = createGesture();
  mouse.down(at(1, 0, 0, 0, 'mouse'));
  assert.deepEqual(mouse.move(at(1, 6, 0, 10, 'mouse')), { type: 'orbit', dx: 6, dy: 0 });
  assert.equal(mouse.up(at(1, 6, 0, 20, 'mouse')).type, 'release');
});

test('a long press is not a tap', () => {
  const g = createGesture();
  g.down(at(1, 50, 50, 1000));
  assert.equal(g.up(at(1, 50, 50, 1000 + TAP_MS + 1)), null);
  g.down(at(1, 50, 50, 2000));
  assert.equal(g.up(at(1, 50, 50, 2000 + TAP_MS)).type, 'tap');
});

test('a release reports the recent speed; a pause before lifting is no flick', () => {
  const g = createGesture();
  g.down(at(1, 0, 0, 0));
  for (let t = 10; t <= 100; t += 10) g.move(at(1, t * 2, -t, t)); // 2 px/ms right, 1 px/ms up
  const flick = g.up(at(1, 200, -100, 105));
  assert.equal(flick.type, 'release');
  close(flick.vx, 2);
  close(flick.vy, -1);

  g.down(at(1, 0, 0, 0));
  for (let t = 10; t <= 100; t += 10) g.move(at(1, t * 2, 0, t));
  assert.deepEqual(g.up(at(1, 200, 0, 400)), { type: 'release', vx: 0, vy: 0 });
});

test('two fingers pinch: spreading zooms in, closing zooms out, about their midpoint', () => {
  const g = createGesture();
  g.down(at(1, 100, 100));
  g.down(at(2, 200, 100));
  assert.equal(g.mode, 'pinch');
  const apart = g.move(at(2, 300, 100, 10)); // 100 -> 200 px
  assert.equal(apart.type, 'zoom');
  close(apart.factor, 0.5);
  assert.deepEqual([apart.cx, apart.cy], [200, 100]);
  const together = g.move(at(1, 200, 100, 20)); // 200 -> 100 px
  close(together.factor, 2);
});

test('a pinch move reports the midpoint before and after it, so the zoom can follow the fingers', () => {
  const g = createGesture();
  g.down(at(1, 100, 100));
  g.down(at(2, 200, 100));
  const first = g.move(at(2, 300, 140, 10));
  assert.deepEqual([first.fromX, first.fromY, first.cx, first.cy], [150, 100, 200, 120]);
  const second = g.move(at(1, 60, 140, 20));
  assert.deepEqual([second.fromX, second.fromY, second.cx, second.cy], [200, 120, 180, 140]);
  // The wheel has a cursor only.
  const wheel = g.wheel({ deltaY: 10, deltaMode: 0, clientX: 7, clientY: 8 });
  assert.deepEqual([wheel.cx, wheel.cy, wheel.fromX, wheel.fromY], [7, 8, undefined, undefined]);
});

test('a pinch never ends as a tap, and the finger left behind orbits without a jump', () => {
  const g = createGesture();
  g.down(at(1, 100, 100, 0));
  g.down(at(2, 104, 100, 5));
  g.move(at(2, 105, 100, 10));
  assert.equal(g.up(at(2, 105, 100, 50)), null);
  assert.equal(g.mode, 'orbit');
  assert.deepEqual(g.move(at(1, 103, 101, 60)), { type: 'orbit', dx: 3, dy: 1 });
  assert.notEqual(g.up(at(1, 103, 101, 70))?.type, 'tap');

  // Both fingers up within the slop and quickly: still no tap.
  g.down(at(1, 100, 100, 0));
  g.down(at(2, 101, 100, 1));
  assert.equal(g.up(at(1, 100, 100, 20)), null);
  assert.notEqual(g.up(at(2, 101, 100, 30))?.type, 'tap');
});

test('a third pointer and unknown pointers are ignored', () => {
  const g = createGesture();
  g.down(at(1, 0, 0));
  g.down(at(2, 100, 0));
  assert.equal(g.down(at(3, 50, 50)), null);
  assert.equal(g.move(at(3, 500, 500, 10)), null);
  assert.equal(g.up(at(9, 0, 0, 10)), null);
  assert.equal(g.mode, 'pinch');
});

test('cancel forgets every pointer', () => {
  const g = createGesture();
  g.down(at(1, 0, 0));
  g.move(at(1, 50, 0, 10));
  assert.equal(g.cancel(), null);
  assert.equal(g.active, false);
  assert.equal(g.mode, 'idle');
  assert.equal(g.move(at(1, 60, 0, 20)), null);
  assert.equal(g.up(at(1, 60, 0, 30)), null);
});

test('non-primary mouse buttons are ignored; primary mouse button works', () => {
  for (const button of [1, 2]) {
    const g = createGesture();
    assert.equal(g.down({ pointerId: 1, pointerType: 'mouse', button, clientX: 50, clientY: 50, timeStamp: 0 }), null);
    assert.equal(g.active, false);
    assert.equal(g.move({ pointerId: 1, pointerType: 'mouse', clientX: 80, clientY: 50, timeStamp: 20 }), null);
    assert.equal(g.up({ pointerId: 1, pointerType: 'mouse', button, clientX: 50, clientY: 50, timeStamp: 40 }), null);
  }
  const g = createGesture();
  assert.equal(g.down({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 50, timeStamp: 0 }), null);
  assert.equal(g.active, true);
  assert.deepEqual(g.up({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 50, timeStamp: 40 }), {
    type: 'tap', x: 50, y: 50, pointerType: 'mouse',
  });
});

test('the wheel zooms by exp(px × speed), normalizing lines and pages and capping big jumps', () => {
  const g = createGesture();
  const wheel = (deltaY, deltaMode = 0, ctrlKey = false) => g.wheel({ deltaY, deltaMode, ctrlKey, clientX: 5, clientY: 6 });
  const down = wheel(100);
  assert.deepEqual([down.type, down.cx, down.cy], ['zoom', 5, 6]);
  close(down.factor, Math.exp(100 * WHEEL_SPEED));
  assert.ok(down.factor > 1, 'wheel down moves away');
  assert.ok(wheel(-100).factor < 1, 'wheel up moves closer');
  close(wheel(3, 1).factor, Math.exp(3 * WHEEL_STEP.line * WHEEL_SPEED));
  close(wheel(1, 2).factor, Math.exp(WHEEL_STEP.max * WHEEL_SPEED), 'a page is capped');
  close(wheel(5000).factor, Math.exp(WHEEL_STEP.max * WHEEL_SPEED));
  close(wheel(10, 0, true).factor, Math.exp(10 * WHEEL_SPEED * PINCH_WHEEL_BOOST));
  assert.equal(wheel(0), null);
  assert.equal(wheel(Number.NaN), null);
});
