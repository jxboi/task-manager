import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { load, save } from '../src/storage.js';

const KEY = 'task-manager.todos.v1';

function createStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

beforeEach(() => {
  globalThis.localStorage = createStorage();
});

after(() => {
  delete globalThis.localStorage;
});

test('load returns [] when the key is missing', () => {
  assert.deepEqual(load(), []);
});

test('load returns [] when the stored value is invalid JSON', () => {
  localStorage.setItem(KEY, '{not json');
  assert.deepEqual(load(), []);
});

test('load returns [] when the stored value is not an array', () => {
  for (const value of ['{"id":"a"}', '"text"', '42', 'null', 'true']) {
    localStorage.setItem(KEY, value);
    assert.deepEqual(load(), [], `value: ${value}`);
  }
});

test('load drops entries that are not valid todos', () => {
  const valid = { id: 'a', text: 'Keep', completed: false, createdAt: 1 };
  localStorage.setItem(KEY, JSON.stringify([null, 1, 'x', { id: 'b' }, valid]));
  assert.deepEqual(load(), [valid]);
});

test('load returns [] when localStorage is unavailable', () => {
  delete globalThis.localStorage;
  assert.deepEqual(load(), []);
});

test('load returns [] when localStorage throws', () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
  };
  assert.deepEqual(load(), []);
});

test('save then load round-trips the todos', () => {
  const todos = [
    { id: 'a', text: 'First', completed: false, createdAt: 1 },
    { id: 'b', text: '<img src=x onerror=alert(1)>', completed: true, createdAt: 2 },
  ];
  save(todos);
  assert.equal(localStorage.getItem(KEY), JSON.stringify(todos));
  assert.deepEqual(load(), todos);
});
