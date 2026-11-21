// Editing a task: the pure edit, the shared add/edit input rules, the server's `edit` action and
// the sync model's optimistic edit with its rollback and conflict handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/storage.js';
import { isCompleted } from '../src/reminders.js';
import { createSync } from '../src/sync.js';
import { addTodo, editTodo, validText } from '../src/todos.js';
import { readTaskEdit, readTaskInput } from '../src/task-input.js';
import { patchTodo } from '../server/todo-input.js';
import { createFakeApi } from './fake-api.js';

const HOUR = 3_600_000;
const base = (overrides = {}) => ({
  ...addTodo([], 'Pay rent', 'home')[0], revision: 1, ...overrides,
});
const fields = (overrides = {}) => ({ text: 'Pay rent', category: 'home', due: null, repeat: 'none', ...overrides });

function setup() {
  const server = createFakeApi();
  globalThis.fetch = server.fetch;
  api.setToken(server.session.csrfToken);
  return { server, sync: createSync(api) };
}

// --- editTodo --------------------------------------------------------------------------------

test('editTodo replaces text, category and reminder and leaves completion alone', () => {
  const todo = base({ completed: true });
  const due = Date.now() + HOUR;
  const [next] = editTodo([todo], todo.id, fields({ text: '  Pay rent early ', category: 'bills', due, repeat: 'daily' }));
  assert.equal(next.text, 'Pay rent early');
  assert.equal(next.category, 'bills');
  assert.equal(next.due, due);
  assert.equal(next.repeat, 'daily');
  assert.equal(next.notified, null);
  assert.equal(next.completed, true);
  assert.equal(next.id, todo.id);
  assert.equal(next.createdAt, todo.createdAt);
});

test('editTodo keeps an alerted occurrence alerted unless the due time changes', () => {
  const due = Date.now() - HOUR;
  const todo = base({ due, repeat: 'daily', notified: due });
  assert.equal(editTodo([todo], todo.id, fields({ text: 'Renamed', due, repeat: 'daily' }))[0].notified, due);
  assert.equal(editTodo([todo], todo.id, fields({ due, repeat: 'weekly' }))[0].notified, due, 'a repeat change alone keeps the claim');
  assert.equal(editTodo([todo], todo.id, fields({ due: due + 1, repeat: 'daily' }))[0].notified, null);
  const cleared = editTodo([todo], todo.id, fields())[0];
  assert.deepEqual([cleared.due, cleared.repeat, cleared.notified], [null, 'none', null]);
});

test('editTodo returns the same array for no change, an unknown id or invalid fields', () => {
  const todo = base();
  const todos = [todo];
  assert.equal(editTodo(todos, todo.id, fields()), todos);
  assert.equal(editTodo(todos, 'missing', fields({ text: 'x' })), todos);
  for (const bad of [
    { text: '   ' },
    { text: 'x'.repeat(2001) },
    { text: 'a\0b' },
    { category: '#Home' },
    { category: ['home'] },
    { due: 1.5, repeat: 'none' },
    { due: null, repeat: 'daily' },
    { due: Date.now(), repeat: 'hourly' },
  ]) {
    assert.equal(editTodo(todos, todo.id, fields(bad)), todos, JSON.stringify(bad));
  }
});

// --- Shared add/edit input -------------------------------------------------------------------

test('readTaskInput parses #category like the add form and reports why a title is invalid', () => {
  assert.deepEqual(readTaskInput('Pay rent #Home #bills'), { text: 'Pay rent #bills', category: 'home', error: null });
  assert.deepEqual(readTaskInput('  #home  '), { text: '', category: 'home', error: 'empty' });
  assert.equal(readTaskInput('').error, 'empty');
  assert.equal(readTaskInput('😀'.repeat(2000)).error, null);
  assert.equal(readTaskInput('😀'.repeat(2001)).error, 'invalid');
  assert.equal(readTaskInput('a\0b').error, 'invalid');
  // The selected category is the default; a typed one replaces it, as for a new task.
  assert.equal(readTaskInput('Call mum', 'family').category, 'family');
  assert.equal(readTaskInput('Call #mum', 'family').category, 'mum');
  assert.equal(validText(' ok '), true);
  assert.equal(validText(5), false);
});

test('an untouched edit keeps the title and category as they are, whatever they contain', () => {
  const todo = { text: 'Review #42 and C#', category: 'ref#42' };
  assert.deepEqual(readTaskEdit(todo.text, todo.text, todo.category), { ...todo, error: null });
  assert.deepEqual(readTaskEdit('Review now', todo.text, 'ref#42'), { text: 'Review now', category: 'ref#42', error: null });
  assert.deepEqual(readTaskEdit('Review now #new', todo.text, 'ref#42'), { text: 'Review now', category: 'new', error: null });
  assert.equal(readTaskEdit('', 'Pay', null).error, 'empty');
});

test('the edit action applies the whole edit and rejects invalid fields', () => {
  const todo = base();
  const due = Date.now() + HOUR;
  const body = (overrides) => ({ action: 'edit', revision: 1, ...fields(overrides) });
  const edited = patchTodo(todo, body({ text: 'New', category: 'A', due, repeat: 'weekly' }));
  assert.deepEqual([edited.text, edited.category, edited.due, edited.repeat], ['New', 'a', due, 'weekly']);
  assert.equal(patchTodo(todo, body({ category: null })).category, null, 'null clears the category');
  // A tab still running the tags version sends `tags`: the first one becomes the category.
  const { category, ...legacy } = body({ tags: ['b', 'c'] });
  assert.equal(patchTodo(todo, legacy).category, 'b');
  assert.equal(patchTodo(todo, body()), todo, 'no change returns the row itself');
  const rejected = [
    [{ text: '' }, /title/],
    [{ text: 'x'.repeat(2001) }, /title/],
    [{ category: '##bad' }, /category/],
    [{ category: 'x'.repeat(25) }, /category/],
    [{ tags: ['home'] }, /not both/],
    [{ due: 'soon' }, /reminder time/],
    [{ due: null, repeat: 'daily' }, /repeat/],
    [{ due, repeat: 'hourly' }, /repeat/],
    [{ completed: true }, /Unexpected/],
    [{ completedUntil: due }, /Unexpected/],
  ];
  for (const [overrides, message] of rejected) {
    assert.throws(() => patchTodo(todo, body(overrides)), (error) => error.status === 400 && message.test(error.message));
  }
  const { text, ...missing } = body();
  assert.throws(() => patchTodo(todo, missing), { status: 400 });
});

// --- Sync: optimistic edit, rollback, conflicts ---------------------------------------------

test('an edit shows at once, sends one PATCH at the seen revision, and is replaced by the server row', async () => {
  const { server, sync } = setup();
  server.rows = [base()];
  await sync.load();
  const id = server.rows[0].id;
  const due = Date.now() + HOUR;
  const edit = fields({ text: 'Pay rent early', category: 'bills', due, repeat: 'daily' });
  const result = sync.edit(id, edit);
  assert.equal(sync.todos[0].text, 'Pay rent early'); // optimistic
  assert.equal(sync.busy, true);
  const outcome = await result;
  assert.equal(outcome.ok, true);
  assert.deepEqual(sync.todos, server.rows);
  assert.equal(server.rows[0].revision, 2);
  assert.equal(server.rows[0].text, 'Pay rent early');
  const patches = server.requests.filter((r) => r.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].body), { ...edit, revision: 1, action: 'edit' });
});

test('an edit keeps the tick timed while repeating and makes it permanent when repetition stops', async () => {
  const { server, sync } = setup();
  const now = Date.now();
  const completedUntil = new Date(now).setHours(24, 0, 0, 0);
  const todo = base({ completed: true, completedUntil, due: completedUntil + HOUR, repeat: 'daily' });
  server.rows = [todo];
  await sync.load();

  const edit = fields({ text: 'Pay rent early', category: 'bills', due: todo.due + HOUR, repeat: 'weekly' });
  const result = sync.edit(todo.id, edit);
  assert.equal(sync.todos[0].completedUntil, completedUntil);
  assert.equal(isCompleted(sync.todos[0], now), true);
  assert.equal((await result).ok, true);
  assert.deepEqual(sync.todos[0], { ...todo, ...edit, revision: 2 });
  assert.equal(isCompleted(sync.todos[0], completedUntil), false);

  const stopRepeating = { ...edit, due: null, repeat: 'none' };
  const stopped = sync.edit(todo.id, stopRepeating);
  assert.equal(sync.todos[0].completedUntil, null);
  assert.equal(isCompleted(sync.todos[0], completedUntil), true);
  assert.equal((await stopped).ok, true);
  assert.deepEqual(sync.todos[0], { ...todo, ...stopRepeating, completedUntil: null, revision: 3 });
  assert.equal(isCompleted(sync.todos[0], completedUntil), true);
});

test('a failed edit rolls back to the confirmed row (server error and network failure)', async () => {
  const { server, sync } = setup();
  server.rows = [base()];
  await sync.load();
  const id = server.rows[0].id;
  for (const failure of [() => new Response('{}', { status: 500 }), () => new TypeError('Failed to fetch')]) {
    server.failNext = (method) => (method === 'PATCH' ? failure() : undefined);
    const result = sync.edit(id, fields({ text: 'Doomed', category: null }));
    assert.equal(sync.todos[0].text, 'Doomed');
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.revision, 1, 'reports the revision it was sent against, for a retry');
    assert.equal(sync.todos[0].text, 'Pay rent');
    assert.equal(sync.todos[0].category, 'home');
  }
  assert.equal(server.rows[0].revision, 1);
});

test('an edit the server refuses as invalid rolls back with a 400', async () => {
  const { server, sync } = setup();
  server.rows = [base()];
  await sync.load();
  const outcome = await sync.edit(server.rows[0].id, fields({ category: '##bad' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 400);
  assert.deepEqual(sync.todos, server.rows);
});

test('an edit against a row another tab changed gets 409, rolls back and reloads the newer row', async () => {
  const { server, sync } = setup();
  server.rows = [base()];
  await sync.load();
  const id = server.rows[0].id;
  // Another tab renames it: this tab still has revision 1.
  server.rows = [{ ...server.rows[0], text: 'Changed elsewhere', revision: 2 }];
  const result = sync.edit(id, fields({ text: 'Mine' }));
  assert.equal(sync.todos[0].text, 'Mine');
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 409);
  assert.equal(outcome.error.code, 'REVISION_CONFLICT');
  assert.equal(outcome.reloaded, true);
  assert.equal(sync.todos[0].text, 'Changed elsewhere');
  assert.equal(server.rows[0].text, 'Changed elsewhere');
});
