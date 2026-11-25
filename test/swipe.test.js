// src/swipe.js: the axis lock, the release thresholds and the deferred delete behind Undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPendingDelete, createSwipe, UNDO_MS } from '../src/swipe.js';

test('a gesture locks horizontal only past 10px and more sideways than down', () => {
  const swipe = createSwipe(400, 300, 100, 0);
  assert.equal(swipe.move(292, 104, 10), 'tracking');
  assert.equal(swipe.offset, 0);
  assert.equal(swipe.move(288, 104, 20), 'horizontal');
  assert.equal(swipe.offset, -12);
  // Once locked it stays locked, even if the finger drifts down.
  assert.equal(swipe.move(250, 160, 30), 'horizontal');
  // Right is clamped: the row only moves left.
  swipe.move(340, 100, 40);
  assert.equal(swipe.offset, 0);
});

test('a vertical gesture locks vertical and never deletes', () => {
  const swipe = createSwipe(400, 300, 100, 0);
  assert.equal(swipe.move(295, 115, 10), 'vertical');
  assert.equal(swipe.move(100, 120, 20), 'vertical');
  assert.equal(swipe.offset, 0);
  assert.equal(swipe.end(30), 'none');
  // A diagonal exactly 45 degrees is a scroll.
  const diagonal = createSwipe(400, 300, 100, 0);
  assert.equal(diagonal.move(285, 115, 10), 'vertical');
});

test('a release past 35% of the width deletes, a shorter slow one springs back', () => {
  const far = createSwipe(400, 300, 100, 0);
  far.move(280, 100, 100);
  far.move(160, 100, 1000);
  assert.equal(far.end(1000), 'delete');

  const short = createSwipe(400, 300, 100, 0);
  short.move(280, 100, 100);
  short.move(170, 100, 1000); // 130px < 140px, slow
  assert.equal(short.end(1000), 'back');
  // A tap that never moved does nothing.
  assert.equal(createSwipe(400, 0, 0, 0).end(5), 'none');
});

test('a fast flick left deletes even when short, a tiny one does not', () => {
  const flick = createSwipe(400, 300, 100, 0);
  flick.move(285, 100, 10);
  flick.move(250, 100, 30); // 35px in 20ms, 50px in all
  assert.equal(flick.end(30), 'delete');

  const tiny = createSwipe(400, 300, 100, 0);
  tiny.move(288, 100, 5);
  tiny.move(270, 100, 10); // fast but only 30px
  assert.equal(tiny.end(10), 'back');

  // Fast back to the right at the end: springs back.
  const back = createSwipe(400, 300, 100, 0);
  back.move(240, 100, 100);
  back.move(250, 100, 110);
  assert.equal(back.end(110), 'back');
});

function fakeClock() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    setTimer: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    clearTimer: (id) => timers.delete(id),
    fire() { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); } },
  };
}

test('a pending delete commits when its time runs out, not before', () => {
  const clock = fakeClock();
  const committed = [];
  const pending = createPendingDelete({ commit: (entry) => committed.push(entry.id), ...clock });
  pending.start({ id: 'a' });
  assert.equal(pending.id, 'a');
  assert.deepEqual(committed, []);
  assert.deepEqual([...clock.timers.values()].map(({ ms }) => ms), [UNDO_MS]);
  clock.fire();
  assert.deepEqual(committed, ['a']);
  assert.equal(pending.id, null);
  // Nothing left to flush.
  assert.equal(pending.flush(), null);
  assert.deepEqual(committed, ['a']);
});

test('a second delete commits the first, undo and drop send nothing', () => {
  const clock = fakeClock();
  const committed = [];
  const pending = createPendingDelete({ commit: (entry) => committed.push(entry.id), ...clock });
  pending.start({ id: 'a' });
  pending.start({ id: 'b' });
  assert.deepEqual(committed, ['a']);
  assert.equal(clock.timers.size, 1);
  assert.deepEqual(pending.undo(), { id: 'b' });
  assert.equal(clock.timers.size, 0);
  pending.start({ id: 'c' });
  assert.deepEqual(pending.drop(), { id: 'c' });
  clock.fire();
  assert.deepEqual(committed, ['a']);
  pending.start({ id: 'd' });
  pending.flush();
  assert.deepEqual(committed, ['a', 'd']);
});

test('pause stops the Undo clock; resume runs it for the time that was left', () => {
  const clock = fakeClock();
  let time = 0;
  const committed = [];
  const pending = createPendingDelete({ commit: (entry) => committed.push(entry.id), ...clock, now: () => time });
  pending.start({ id: 'a' });
  time = 3000;
  pending.pause();
  assert.equal(pending.paused, true);
  assert.equal(clock.timers.size, 0);
  time = 60000; // hovered or focused for a minute: still waiting
  assert.deepEqual(committed, []);
  pending.resume();
  assert.deepEqual([...clock.timers.values()].map(({ ms }) => ms), [UNDO_MS - 3000]);
  clock.fire();
  assert.deepEqual(committed, ['a']);
  // Paused, then undone: nothing is armed again by a late resume.
  pending.start({ id: 'b' });
  pending.pause();
  pending.undo();
  pending.resume();
  assert.equal(clock.timers.size, 0);
  assert.equal(pending.paused, false);
  // A paused delete still commits when flushed (the next delete, leaving the page).
  pending.start({ id: 'c' });
  pending.pause();
  pending.flush();
  assert.deepEqual(committed, ['a', 'c']);
});
