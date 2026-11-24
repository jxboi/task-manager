import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchTodo, readEdit, readMove } from '../server/todo-input.js';

const id = '0b7f2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
const work = '1c8e3b4f-2d5e-4f60-9bac-1d2e3f4a5b6c';
const home = '2d9f4c50-3e6f-4071-8cbd-2e3f4a5b6c7d';
const todo = {
  id, text: 'Task', completed: false, completedUntil: null, createdAt: 1, tags: ['a'],
  due: null, repeat: 'none', notified: null, revision: 3, position: 'p', categoryId: work,
};
const edit = { action: 'edit', revision: 3, text: 'Task', tags: ['a'], due: null, repeat: 'none' };
const rejects = (fn) => assert.throws(fn, { status: 400, code: 'INVALID_INPUT' });

test('an edit without categoryId keeps the link, and an unchanged edit is a no-op', () => {
  assert.equal(patchTodo(todo, edit), todo);
  assert.deepEqual(patchTodo(todo, { ...edit, text: 'Renamed' }), { ...todo, text: 'Renamed' });
});

test('an edit assigns, reassigns or clears the category, and a category-only change counts', () => {
  assert.deepEqual(patchTodo(todo, { ...edit, categoryId: home.toUpperCase() }), { ...todo, categoryId: home });
  assert.deepEqual(patchTodo(todo, { ...edit, categoryId: null }), { ...todo, categoryId: null });
  assert.deepEqual(patchTodo({ ...todo, categoryId: null }, { ...edit, categoryId: work }), todo);
  assert.deepEqual(patchTodo(todo, { ...edit, text: 'New', categoryId: null }), { ...todo, text: 'New', categoryId: null });
  assert.equal(patchTodo(todo, { ...edit, categoryId: work }), todo, 'the same category is a no-op');
  const loose = { ...todo, categoryId: null };
  assert.equal(patchTodo(loose, { ...edit, categoryId: null }), loose);
});

test('an edit rejects a malformed or wrongly typed categoryId', () => {
  for (const categoryId of ['', 'work', `${work}x`, 42, true, {}, [work], undefined]) {
    rejects(() => patchTodo(todo, { ...edit, categoryId }));
  }
});

test('other actions reject categoryId as an unknown field', () => {
  const others = [
    { action: 'addTag', revision: 3, tag: 'b' },
    { action: 'removeTag', revision: 3, tag: 'a' },
    { action: 'setReminder', revision: 3, due: Date.now() + 60_000, repeat: 'none' },
    { action: 'clearReminder', revision: 3 },
    { action: 'complete', revision: 3, completed: true, due: null },
    { action: 'markNotified', revision: 3, due: Date.now() },
  ];
  for (const body of others) {
    rejects(() => patchTodo(todo, { ...body, categoryId: work }));
    rejects(() => patchTodo(todo, { ...body, categoryId: null }));
  }
  rejects(() => readMove({ action: 'move', revision: 3, anchorId: work, side: 'after', categoryId: null }, id));
});

test('readEdit validates the whole edit payload, not only categoryId', () => {
  assert.deepEqual(readEdit({ ...edit, categoryId: work }), { text: 'Task', tags: ['a'], due: null, repeat: 'none', categoryId: work });
  assert.equal(readEdit(edit).categoryId, undefined);
  for (const bad of [{ userId: 'x' }, { text: '' }, { tags: 'a' }, { repeat: 'daily' }, { due: 'soon' }]) {
    rejects(() => readEdit({ ...edit, categoryId: work, ...bad }));
  }
});
