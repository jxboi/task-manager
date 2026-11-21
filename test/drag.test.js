// The drag controller's math (src/drag.js): where a dragged row lands, how the other rows slide
// to open its gap, which move that is, keyboard targets and auto-scroll speed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoScrollStep, createDrag, keyboardTarget } from '../src/drag.js';
import { moveTodo } from '../src/todos.js';

// Four rows from page Y 100: a 56, b 80 (two lines), c 56, d 56.
const rows = () => [
  { id: 'a', top: 100, height: 56 },
  { id: 'b', top: 156, height: 80 },
  { id: 'c', top: 236, height: 56 },
  { id: 'd', top: 292, height: 56 },
];

test('a drag that goes nowhere (or a tap) lands where it was and moves nothing', () => {
  const drag = createDrag(rows(), 'b', 200);
  assert.equal(drag.index, 1);
  assert.equal(drag.target(), null);
  drag.move(220); // 20px: b's center (216) is still above c's (264)
  assert.equal(drag.index, 1);
  assert.equal(drag.target(), null);
  assert.deepEqual(drag.shifts(), { a: 0, c: 0, d: 0 });
  assert.equal(drag.slotTop(), 156);
});

test('dragging down past a row center opens the gap below it', () => {
  const drag = createDrag(rows(), 'a', 120);
  drag.move(120 + 110); // a's center 128 + 110 = 238: past b's center (196), not c's (264)
  assert.equal(drag.index, 1);
  assert.equal(drag.offset, 110);
  assert.deepEqual(drag.shifts(), { b: -56, c: 0, d: 0 });
  assert.equal(drag.slotTop(), 180, 'the gap is where b ended (236) less a’s height');
  assert.deepEqual(drag.target(), { anchorId: 'c', side: 'before' });
});

test('dragging to the bottom anchors after the last row; the row cannot leave the list', () => {
  const drag = createDrag(rows(), 'a', 120);
  drag.move(5000);
  assert.equal(drag.offset, 348 - 156, 'clamped: a’s bottom meets d’s bottom');
  assert.equal(drag.index, 3);
  assert.deepEqual(drag.shifts(), { b: -56, c: -56, d: -56 });
  assert.equal(drag.slotTop(), 292);
  assert.deepEqual(drag.target(), { anchorId: 'd', side: 'after' });
});

test('dragging up slides the rows it passes down by the dragged height', () => {
  const drag = createDrag(rows(), 'd', 300);
  drag.move(300 - 50); // d's center 320 - 50 = 270: still below c's (264)
  assert.equal(drag.index, 3);
  assert.equal(drag.target(), null);
  drag.move(300 - 120); // center 200: above c's center, below b's (196)
  assert.deepEqual(drag.target(), { anchorId: 'c', side: 'before' });
  assert.deepEqual(drag.shifts(), { a: 0, b: 0, c: 56 });
  drag.move(300 - 130); // center 190: above b's center
  assert.equal(drag.index, 1);
  assert.deepEqual(drag.shifts(), { a: 0, b: 56, c: 56 });
  assert.equal(drag.slotTop(), 156);
  assert.deepEqual(drag.target(), { anchorId: 'b', side: 'before' });
  drag.move(-5000);
  assert.equal(drag.offset, -192);
  assert.equal(drag.index, 0);
  assert.deepEqual(drag.target(), { anchorId: 'a', side: 'before' });
  // Back where it started: nothing to send.
  drag.move(300);
  assert.equal(drag.target(), null);
  assert.deepEqual(drag.shifts(), { a: 0, b: 0, c: 0 });
});

test('a drag target applied with moveTodo gives the order the gap showed', () => {
  const todos = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, createdAt: i + 1, tags: [] }));
  const drag = createDrag(rows(), 'a', 120);
  drag.move(120 + 140); // center 268: past c's center
  const { anchorId, side } = drag.target();
  assert.deepEqual(moveTodo(todos, 'a', anchorId, side).map((todo) => todo.id), ['b', 'c', 'a', 'd']);
});

test('createDrag refuses a row that is not in the list', () => {
  assert.throws(() => createDrag(rows(), 'z', 0));
});

test('keyboardTarget: up, down, home and end, and nothing past either end', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(keyboardTarget(ids, 'b', 'ArrowUp'), { anchorId: 'a', side: 'before', index: 0 });
  assert.deepEqual(keyboardTarget(ids, 'b', 'ArrowDown'), { anchorId: 'c', side: 'after', index: 2 });
  assert.deepEqual(keyboardTarget(ids, 'c', 'Home'), { anchorId: 'a', side: 'before', index: 0 });
  assert.deepEqual(keyboardTarget(ids, 'b', 'End'), { anchorId: 'd', side: 'after', index: 3 });
  assert.equal(keyboardTarget(ids, 'a', 'ArrowUp'), null);
  assert.equal(keyboardTarget(ids, 'a', 'Home'), null);
  assert.equal(keyboardTarget(ids, 'd', 'ArrowDown'), null);
  assert.equal(keyboardTarget(ids, 'd', 'End'), null);
  assert.equal(keyboardTarget(ids, 'b', 'Enter'), null);
  assert.equal(keyboardTarget(ids, 'z', 'ArrowUp'), null);
  assert.equal(keyboardTarget(['a'], 'a', 'ArrowDown'), null);
});

test('keyboard targets applied in turn walk a task through the list', () => {
  let todos = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, createdAt: i + 1, tags: [] }));
  const order = () => todos.map((todo) => todo.id);
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown']) {
    const { anchorId, side } = keyboardTarget(order(), 'a', key);
    todos = moveTodo(todos, 'a', anchorId, side);
  }
  assert.deepEqual(order(), ['b', 'c', 'd', 'a']);
  const { anchorId, side } = keyboardTarget(order(), 'a', 'Home');
  todos = moveTodo(todos, 'a', anchorId, side);
  assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
});

test('autoScrollStep scrolls only near the edges, faster closer in', () => {
  assert.equal(autoScrollStep(400, 844), 0);
  assert.equal(autoScrollStep(64, 844), 0);
  assert.ok(autoScrollStep(40, 844) < 0);
  assert.ok(autoScrollStep(10, 844) < autoScrollStep(40, 844));
  assert.equal(autoScrollStep(0, 844), -14);
  assert.equal(autoScrollStep(-30, 844), -14, 'capped past the edge');
  assert.ok(autoScrollStep(820, 844) > 0);
  assert.equal(autoScrollStep(844, 844), 14);
});

test('a row taller than the end row still reaches either end', () => {
  // b is 80 tall: pushed to the top its center (140) never passes a's (128).
  const up = createDrag(rows(), 'b', 200);
  up.move(-1000);
  assert.equal(up.offset, -56);
  assert.deepEqual(up.target(), { anchorId: 'a', side: 'before' });
  assert.equal(up.slotTop(), 100);
  const down = createDrag(rows(), 'b', 200);
  down.move(5000);
  assert.equal(down.offset, 348 - 236);
  assert.deepEqual(down.target(), { anchorId: 'd', side: 'after' });
  assert.equal(down.slotTop(), 348 - 80);
});
