import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { load, save } from '../src/storage.js';
import { normalizeTag } from '../src/tags.js';

const KEY = 'task-manager.todos.v1';
const NO_REMINDER = { due: null, repeat: 'none', notified: null };

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
  localStorage.setItem(KEY, JSON.stringify([null, 1, 'x', { id: 'b' }, { ...valid, id: 'c', text: '  ' }, valid]));
  assert.deepEqual(load(), [{ ...valid, tags: [], ...NO_REMINDER }]);
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

test('todos saved before tags existed load unchanged, with no tags', () => {
  // The exact shape the app stored before tags.
  const legacy = [
    { id: 'a', text: 'fix #42 and C# build #work', completed: false, createdAt: 1700000000000 },
    { id: 'b', text: 'Done thing', completed: true, createdAt: 1700000000001 },
  ];
  localStorage.setItem(KEY, JSON.stringify(legacy));
  assert.deepEqual(
    load(),
    legacy.map((todo) => ({ ...todo, tags: [], ...NO_REMINDER })),
  );
});

test('load treats non-array tags as no tags', () => {
  const base = { id: 'a', text: 'Keep', completed: false, createdAt: 1 };
  for (const tags of [null, 'work', 42, { 0: 'work' }, true]) {
    localStorage.setItem(KEY, JSON.stringify([{ ...base, tags }]));
    assert.deepEqual(load(), [{ ...base, tags: [], ...NO_REMINDER }], JSON.stringify(tags));
  }
});

test('load normalizes tags: junk dropped, case folded, duplicates removed, first 10 kept', () => {
  const base = { id: 'a', text: 'Keep', completed: false, createdAt: 1 };
  const stored = [
    null, 7, {}, '', '   ', 'x'.repeat(25),
    'Work', '#work', ' WORK ', 'due today',
    ...Array.from({ length: 12 }, (_, i) => `t${i}`),
  ];
  localStorage.setItem(KEY, JSON.stringify([{ ...base, tags: stored }]));
  assert.deepEqual(load(), [
    { ...base, tags: ['work', 'due-today', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], ...NO_REMINDER },
  ]);
});

test('load is idempotent: saving what load returned and loading again changes nothing', () => {
  const base = { id: 'a', text: 'fix #42', completed: false, createdAt: 1 };
  const stored = [
    { ...base, tags: ['Work', '#work', '##work', '# #home', ' Due  Today ', 'c#', '#a#b', 'İstanbul', 'x'.repeat(25)] },
    { ...base, id: 'b', tags: Array.from({ length: 12 }, (_, i) => `#T${i}`) },
    { ...base, id: 'c' },
  ];
  localStorage.setItem(KEY, JSON.stringify(stored));
  const first = load();
  assert.deepEqual(first[0].tags, ['work', 'due-today', 'c#', 'a#b', normalizeTag('İstanbul')]);
  save(first);
  assert.deepEqual(load(), first);
});

test('save then load round-trips the todos', () => {
  const todos = [
    { id: 'a', text: 'First', completed: false, createdAt: 1, tags: ['work', 'due-today'], ...NO_REMINDER },
    { id: 'b', text: '<img src=x onerror=alert(1)>', completed: true, createdAt: 2, tags: [], ...NO_REMINDER },
  ];
  save(todos);
  assert.equal(localStorage.getItem(KEY), JSON.stringify(todos));
  assert.deepEqual(load(), todos);
});

test('save does not throw when localStorage throws', () => {
  globalThis.localStorage = {
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.doesNotThrow(() => save([{ id: 'a', text: 'First', completed: false, createdAt: 1 }]));
});

test('todos saved before reminders (with and without tags) load with no reminder, otherwise unchanged', () => {
  // The exact shapes stored today: pre-tags v1, and tags-era.
  const preTags = { id: 'a', text: 'fix #42 and C# build #work', completed: false, createdAt: 1700000000000 };
  const tagsEra = { id: 'b', text: 'Review preview', completed: true, createdAt: 1700000000001, tags: ['work', 'blocked'] };
  const raw = JSON.stringify([preTags, tagsEra]);
  localStorage.setItem(KEY, raw);
  assert.deepEqual(load(), [
    { ...preTags, tags: [], ...NO_REMINDER },
    { ...tagsEra, ...NO_REMINDER },
  ]);
  // load() never writes.
  assert.equal(localStorage.getItem(KEY), raw);
});

test('load normalizes junk reminder fields', () => {
  const base = { id: 'a', text: 'Keep', completed: false, createdAt: 1, tags: [] };
  const junk = [
    { due: 'abc', repeat: 'weekly', notified: 'abc' },
    { due: 1.5, repeat: 'daily', notified: 1.5 },
    { due: 9e15, repeat: 'daily', notified: null },
    { due: null, repeat: 'daily', notified: 5 },
    { due: {}, repeat: [], notified: {} },
  ];
  for (const fields of junk) {
    localStorage.setItem(KEY, JSON.stringify([{ ...base, ...fields }]));
    assert.deepEqual(load(), [{ ...base, ...NO_REMINDER }], JSON.stringify(fields));
  }
  localStorage.setItem(KEY, JSON.stringify([{ ...base, due: 1000, repeat: 'monthly', notified: null }]));
  assert.deepEqual(load(), [{ ...base, due: 1000, repeat: 'none', notified: null }]);
});

test('a notified that does not match due loads as null', () => {
  const todo = { id: 'a', text: 'Keep', completed: false, createdAt: 1, tags: [], due: 1000, repeat: 'daily', notified: 5 };
  localStorage.setItem(KEY, JSON.stringify([todo]));
  assert.deepEqual(load(), [{ ...todo, notified: null }]);
});

test('a valid reminder round-trips through save and load, and load is idempotent on it', () => {
  const todos = [
    { id: 'a', text: 'Water the plants', completed: false, createdAt: 1, tags: ['home'], due: 1763650800000, repeat: 'daily', notified: 1763650800000 },
    { id: 'b', text: 'Call Sam', completed: false, createdAt: 2, tags: [], due: 1763737200000, repeat: 'weekly', notified: null },
    { id: 'c', text: 'Pay rent', completed: true, createdAt: 3, tags: [], due: 1763737200000, repeat: 'none', notified: null },
  ];
  save(todos);
  assert.deepEqual(load(), todos);
  save(load());
  assert.equal(localStorage.getItem(KEY), JSON.stringify(todos));
});
