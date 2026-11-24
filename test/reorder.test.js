import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMove } from '../server/todo-input.js';
import { appendTodo, moveTodo, sortByPosition } from '../src/todos.js';

const fixture = (n) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, createdAt: n, tags: [],
});
const ids = (todos) => todos.map(({ id }) => id);

test('moves a task to the top and bottom by changing only its position', () => {
  const [a, b, c] = [1, 2, 3].map((n) => Object.freeze(fixture(n)));
  const todos = Object.freeze([a, b, c]);
  const top = moveTodo(todos, c.id, a.id, 'before');
  assert.deepEqual(ids(top), ids([c, a, b]));
  assert.equal(top[1], a);
  assert.equal(top[2], b);
  assert.deepEqual(sortByPosition([...top].reverse()), top);
  const bottom = moveTodo(top, c.id, b.id, 'after');
  assert.deepEqual(ids(bottom), ids(todos));
  assert.deepEqual(sortByPosition([...bottom].reverse()), bottom);
  assert.equal(moveTodo(bottom, c.id, b.id, 'after'), bottom);
});

test('repeated moves can narrow the same gap without rounding or relabeling other tasks', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => fixture(n));
  let todos = [a, b, c, d];
  for (let i = 0; i < 600; i++) {
    const moving = todos.at(-1);
    const previous = todos;
    todos = moveTodo(todos, moving.id, a.id, 'after');
    assert.equal(todos[0], a);
    assert.equal(todos[1].id, moving.id);
    assert.deepEqual(todos.slice(2), previous.slice(1, -1));
    assert.deepEqual(sortByPosition([...todos].reverse()), todos);
  }
});

test('a move next to where the task already is, onto itself, or to a bad side changes nothing', () => {
  const [a, b, c] = [1, 2, 3].map((n) => fixture(n));
  const todos = [a, b, c];
  assert.equal(moveTodo(todos, b.id, a.id, 'after'), todos);
  assert.equal(moveTodo(todos, b.id, c.id, 'before'), todos);
  assert.equal(moveTodo(todos, b.id, b.id, 'before'), todos);
  assert.equal(moveTodo(todos, b.id, c.id, 'around'), todos);
});

test('new tasks append after reordered tasks even when the local clock is behind', () => {
  const [a, b, c] = [1, 2, 3].map((n) => fixture(n));
  const reordered = moveTodo([a, b], a.id, b.id, 'after');
  const afterCreate = appendTodo(reordered, { ...c, createdAt: 0 });
  assert.deepEqual(ids(afterCreate), ids([b, a, c]));
  assert.deepEqual(sortByPosition([...afterCreate].reverse()), afterCreate);
  assert.deepEqual(ids(moveTodo(afterCreate, c.id, b.id, 'before')), ids([c, b, a]));
});

test('two devices moving different tasks into the same gap get distinct, sortable positions', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => fixture(n));
  const todos = [a, b, c, d];
  const first = moveTodo(todos, c.id, a.id, 'after')[1];
  const second = moveTodo(todos, d.id, a.id, 'after')[1];
  assert.notEqual(first.position, second.position);
  assert.deepEqual(ids(sortByPosition([b, second, a, first])), ids([a, c, d, b]));
});

test('equal imported positions use stable fallbacks and can still be moved relative to', () => {
  const position = '000000000000000000018';
  const [a, b] = [1, 2].map((n) => ({ ...fixture(n), createdAt: 1, position }));
  const c = fixture(3);
  const ordered = sortByPosition([c, b, a]);
  assert.deepEqual(ordered, [a, b, c]);
  const moved = moveTodo(ordered, c.id, b.id, 'before');
  assert.deepEqual(ids(moved), ids([c, a, b]));
  assert.deepEqual(sortByPosition([...moved].reverse()), moved);
});

test('the PATCH move validator accepts a UUID anchor and exact placement and rejects invalid fields', () => {
  const [a, b] = [1, 2].map((n) => fixture(n));
  const payload = { action: 'move', revision: 1, anchorId: b.id, side: 'before' };
  assert.deepEqual(readMove(payload, a.id), { anchorId: b.id, side: 'before' });
  for (const invalid of [
    { anchorId: a.id }, { anchorId: null }, { anchorId: 'bad' }, { side: null },
    { side: 'above' }, { position: '1' }, { userId: 'other' },
  ]) {
    assert.throws(() => readMove({ ...payload, ...invalid }, a.id), { status: 400 });
  }
});
