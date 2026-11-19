import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, toggleTodo, removeTodo } from '../src/todos.js';

function deepFreeze(todos) {
  todos.forEach(Object.freeze);
  return Object.freeze(todos);
}

function makeTodos() {
  return deepFreeze([
    { id: 'a', text: 'First', completed: false, createdAt: 1 },
    { id: 'b', text: 'Second', completed: true, createdAt: 2 },
    { id: 'c', text: 'Third', completed: false, createdAt: 3 },
  ]);
}

test('addTodo appends a new incomplete todo at the end', () => {
  const todos = makeTodos();
  const result = addTodo(todos, 'Fourth');

  assert.equal(result.length, 4);
  assert.deepEqual(result.slice(0, 3), todos);
  const added = result[3];
  assert.equal(added.text, 'Fourth');
  assert.equal(added.completed, false);
  assert.equal(typeof added.id, 'string');
  assert.ok(added.id.length > 0);
  assert.equal(typeof added.createdAt, 'number');
});

test('addTodo trims surrounding whitespace', () => {
  const [added] = addTodo([], '   Buy milk \n');
  assert.equal(added.text, 'Buy milk');
});

test('addTodo ignores empty and whitespace-only text', () => {
  const todos = makeTodos();
  for (const text of ['', ' ', '   \t\n ']) {
    assert.equal(addTodo(todos, text), todos);
  }
});

test('addTodo gives each todo a unique id', () => {
  const todos = addTodo(addTodo(addTodo([], 'one'), 'two'), 'three');
  assert.equal(new Set(todos.map((todo) => todo.id)).size, 3);
});

test('toggleTodo flips completed for the matching id only', () => {
  const todos = makeTodos();
  const result = toggleTodo(todos, 'a');

  assert.deepEqual(result, [
    { id: 'a', text: 'First', completed: true, createdAt: 1 },
    { id: 'b', text: 'Second', completed: true, createdAt: 2 },
    { id: 'c', text: 'Third', completed: false, createdAt: 3 },
  ]);
  assert.equal(toggleTodo(result, 'a')[0].completed, false);
});

test('toggleTodo with an unknown id leaves todos unchanged', () => {
  const todos = makeTodos();
  assert.deepEqual(toggleTodo(todos, 'missing'), todos);
});

test('removeTodo removes only the matching todo', () => {
  const todos = makeTodos();
  assert.deepEqual(
    removeTodo(todos, 'b').map((todo) => todo.id),
    ['a', 'c'],
  );
  assert.deepEqual(removeTodo(todos, 'missing'), todos);
});

test('functions return new arrays and never mutate their input', () => {
  const todos = makeTodos();
  const snapshot = structuredClone(todos);

  const added = addTodo(todos, 'New');
  const toggled = toggleTodo(todos, 'a');
  const removed = removeTodo(todos, 'a');

  assert.notEqual(added, todos);
  assert.notEqual(toggled, todos);
  assert.notEqual(removed, todos);
  assert.notEqual(toggled[0], todos[0]);
  assert.deepEqual(todos, snapshot);
});

test('ids are stable across toggle and remove', () => {
  const todos = makeTodos();
  const afterRemove = removeTodo(todos, 'a');
  assert.deepEqual(afterRemove.map((todo) => todo.id), ['b', 'c']);

  const afterToggle = toggleTodo(afterRemove, 'c');
  assert.deepEqual(afterToggle.map((todo) => todo.id), ['b', 'c']);
  assert.equal(afterToggle[1].completed, true);
});
