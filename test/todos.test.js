import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, toggleTodo, removeTodo, addTag, removeTag, allTags, filterByTags } from '../src/todos.js';

function deepFreeze(todos) {
  for (const todo of todos) {
    if (todo.tags) Object.freeze(todo.tags);
    Object.freeze(todo);
  }
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

function makeTagged() {
  return deepFreeze([
    { id: 'a', text: 'Set up the repo', completed: true, createdAt: 1, tags: ['work', 'dev'] },
    { id: 'b', text: 'Review preview', completed: false, createdAt: 2, tags: ['work', 'blocked'] },
    { id: 'c', text: 'Dentist', completed: false, createdAt: 3, tags: ['home'] },
    { id: 'd', text: 'Draft email', completed: false, createdAt: 4, tags: [] },
  ]);
}

const ids = (todos) => todos.map((todo) => todo.id);

test('addTodo without tags gives tags: []', () => {
  const [added] = addTodo([], 'Plain');
  assert.deepEqual(added.tags, []);
});

test('addTodo keeps tags in the given order (active filter tags first), deduped', () => {
  const [added] = addTodo([], 'call Sam', ['urgent', 'work', 'phone', 'work']);
  assert.deepEqual(added.tags, ['urgent', 'work', 'phone']);
});

test('addTodo normalizes tags and caps them at 10', () => {
  const tags = ['#Work', 'WORK', '  ', ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
  const [added] = addTodo([], 'Many', tags);
  assert.deepEqual(added.tags, ['work', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
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

  const tagged = makeTagged();
  const taggedSnapshot = structuredClone(tagged);

  const withTags = addTodo(tagged, 'New', ['x']);
  const addedTag = addTag(tagged, 'c', 'health');
  const removedTag = removeTag(tagged, 'a', 'work');
  allTags(tagged);
  const filtered = filterByTags(tagged, ['work']);

  assert.notEqual(withTags, tagged);
  assert.notEqual(addedTag, tagged);
  assert.notEqual(removedTag, tagged);
  assert.notEqual(filtered, tagged);
  assert.notEqual(addedTag[2], tagged[2]);
  assert.notEqual(removedTag[0].tags, tagged[0].tags);
  assert.deepEqual(tagged, taggedSnapshot);
});

test('ids are stable across toggle and remove', () => {
  const todos = makeTodos();
  const afterRemove = removeTodo(todos, 'a');
  assert.deepEqual(afterRemove.map((todo) => todo.id), ['b', 'c']);

  const afterToggle = toggleTodo(afterRemove, 'c');
  assert.deepEqual(afterToggle.map((todo) => todo.id), ['b', 'c']);
  assert.equal(afterToggle[1].completed, true);
});

test('addTag adds a normalized tag to the matching todo only', () => {
  const todos = makeTagged();
  const result = addTag(todos, 'c', '  #Health ');
  assert.deepEqual(result[2].tags, ['home', 'health']);
  assert.deepEqual(result.filter((todo) => todo.id !== 'c'), todos.filter((todo) => todo.id !== 'c'));
});

test('addTag treats Work, #work and " work " as the same tag', () => {
  for (const raw of ['Work', '#work', ' work ']) {
    assert.deepEqual(addTag(makeTagged(), 'd', raw)[3].tags, ['work'], raw);
  }
});

test('addTag ignores duplicates, invalid input, the 11th tag and unknown ids', () => {
  const todos = makeTagged();
  for (const raw of ['work', 'WORK', '#Work', '', '   ', '#', 'x'.repeat(25)]) {
    assert.equal(addTag(todos, 'a', raw), todos, JSON.stringify(raw));
  }
  assert.equal(addTag(todos, 'missing', 'new'), todos);

  const full = deepFreeze([
    { id: 'f', text: 'Full', completed: false, createdAt: 1, tags: Array.from({ length: 10 }, (_, i) => `t${i}`) },
  ]);
  assert.equal(addTag(full, 'f', 'eleventh'), full);
});

test('removeTag removes the tag from the matching todo only', () => {
  const todos = makeTagged();
  const result = removeTag(todos, 'a', 'work');
  assert.deepEqual(result[0].tags, ['dev']);
  assert.deepEqual(result[1].tags, ['work', 'blocked']);
});

test('removeTag with an unknown tag or id is a no-op', () => {
  const todos = makeTagged();
  assert.equal(removeTag(todos, 'a', 'home'), todos);
  assert.equal(removeTag(todos, 'missing', 'work'), todos);
});

test('allTags lists tags in use A to Z with counts', () => {
  assert.deepEqual(allTags(makeTagged()), [
    { tag: 'blocked', count: 1 },
    { tag: 'dev', count: 1 },
    { tag: 'home', count: 1 },
    { tag: 'work', count: 2 },
  ]);
});

test('allTags omits tags no todo uses any more', () => {
  const todos = removeTag(removeTag(makeTagged(), 'a', 'work'), 'b', 'work');
  assert.deepEqual(allTags(todos).map(({ tag }) => tag), ['blocked', 'dev', 'home']);
  assert.deepEqual(allTags([]), []);
});

test('filterByTags with no active tags returns every todo', () => {
  const todos = makeTagged();
  assert.deepEqual(filterByTags(todos, []), todos);
});

test('filterByTags with one tag returns the todos carrying it', () => {
  assert.deepEqual(ids(filterByTags(makeTagged(), ['work'])), ['a', 'b']);
});

test('filterByTags with two tags returns todos with either (OR), each once, in order', () => {
  assert.deepEqual(ids(filterByTags(makeTagged(), ['home', 'work'])), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterByTags(makeTagged(), ['blocked', 'work'])), ['a', 'b']);
});
