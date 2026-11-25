// src/swipe.js: the axis lock, the release thresholds, the one revealed row and the deferred
// delete behind Undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPendingDelete, createReveal, createSwipe, REVEAL_PX, UNDO_MS } from '../src/swipe.js';

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

// Changed with the iOS-style reveal: a slow release between half the button and 65% of the width
// now opens and holds the Delete button (it used to delete past 35%).
test('a slow release: under half the button closes, then opens and holds, past 65% deletes', () => {
  const slow = (to) => {
    const swipe = createSwipe(400, 300, 100, 0);
    swipe.move(285, 100, 100);
    swipe.move(300 - to, 100, 1000);
    return swipe.end(1000);
  };
  assert.equal(REVEAL_PX / 2, 38);
  assert.equal(slow(37), 'back');
  assert.equal(slow(38), 'open');
  assert.equal(slow(140), 'open'); // past the old 35%: now holds open
  assert.equal(slow(259), 'open');
  assert.equal(slow(260), 'delete'); // 65% of 400
  assert.equal(slow(390), 'delete');
  // A tap that never moved does nothing.
  assert.equal(createSwipe(400, 0, 0, 0).end(5), 'none');
});

// Changed with the reveal: the flick speed is the same, but a flick that only reaches the open
// position opens it; past it (REVEAL_PX) the flick deletes, as before.
test('a fast flick left past the button deletes; a shorter one opens; a tiny one closes', () => {
  const flick = createSwipe(400, 300, 100, 0);
  flick.move(285, 100, 10);
  flick.move(220, 100, 50); // 65px in 40ms, 80px in all
  assert.equal(flick.end(50), 'delete');

  const reveal = createSwipe(400, 300, 100, 0);
  reveal.move(285, 100, 10);
  reveal.move(250, 100, 30); // 35px in 20ms, 50px in all
  assert.equal(reveal.end(30), 'open');

  const tiny = createSwipe(400, 300, 100, 0);
  tiny.move(288, 100, 5);
  tiny.move(270, 100, 10); // fast but only 30px
  assert.equal(tiny.end(10), 'back');

  // Fast back to the right at the end: springs back, even past half the button.
  const back = createSwipe(400, 300, 100, 0);
  back.move(240, 100, 100);
  back.move(250, 100, 110);
  assert.equal(back.end(110), 'back');
});

test('a swipe from an open row starts at the open offset: right closes, left goes on', () => {
  const tap = createSwipe(400, 300, 100, 0, { open: true });
  assert.equal(tap.offset, -REVEAL_PX);
  assert.equal(tap.move(304, 102, 50), 'tracking');
  assert.equal(tap.offset, -REVEAL_PX); // not locked: the card stays open
  assert.equal(tap.end(80), 'none'); // a tap: app.js closes it

  const right = createSwipe(400, 300, 100, 0, { open: true });
  right.move(320, 100, 200);
  assert.equal(right.offset, -REVEAL_PX + 20);
  right.move(400, 100, 900);
  assert.equal(right.offset, 0); // never past closed
  assert.equal(right.end(900), 'back');

  const little = createSwipe(400, 300, 100, 0, { open: true });
  little.move(315, 100, 300);
  little.move(330, 100, 900); // back right 30px, slowly: still past half the button
  assert.equal(little.end(900), 'open');

  const flickBack = createSwipe(400, 300, 100, 0, { open: true });
  flickBack.move(312, 100, 10);
  flickBack.move(330, 100, 20); // 18px right in 10ms
  assert.equal(flickBack.end(20), 'back');

  const further = createSwipe(400, 300, 100, 0, { open: true });
  further.move(280, 100, 300);
  further.move(116, 100, 1200); // 76 + 184 = 260: 65%
  assert.equal(further.offset, -260);
  assert.equal(further.end(1200), 'delete');
});

test('one row open at a time, and what a press does to it', () => {
  const reveal = createReveal();
  assert.equal(reveal.openId, null);
  assert.equal(reveal.press('a', 'card'), 'none');
  assert.equal(reveal.open('a'), null);
  assert.equal(reveal.openId, 'a');
  assert.equal(reveal.open('a'), null); // opening it again closes nothing
  // Opening B closes A.
  assert.equal(reveal.open('b'), 'a');
  assert.equal(reveal.openId, 'b');
  assert.equal(reveal.press('b', 'delete'), 'keep');
  assert.equal(reveal.press('b', 'card'), 'resume');
  assert.equal(reveal.press('b', 'handle'), 'close'); // a reorder drag closes it
  assert.equal(reveal.press('a', 'card'), 'close');
  assert.equal(reveal.press('a', 'delete'), 'close');
  assert.equal(reveal.press(null, undefined), 'close'); // outside the list
  // close(id) only closes that row.
  assert.equal(reveal.close('a'), null);
  assert.equal(reveal.openId, 'b');
  assert.equal(reveal.close(), 'b');
  assert.equal(reveal.openId, null);
  assert.equal(reveal.close(), null);
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

test('a small quick left slip on an open row stays open; the flick counts only its own travel', () => {
  const slip = createSwipe(400, 300, 100, 0, { open: true });
  slip.move(288, 100, 12); // 12px in 12ms: 1px/ms, but total offset 88px
  assert.equal(slip.end(17), 'open');
  const flick = createSwipe(400, 300, 100, 0, { open: true });
  flick.move(285, 100, 10);
  flick.move(210, 100, 50); // 90px of its own, fast
  assert.equal(flick.end(50), 'delete');
});
