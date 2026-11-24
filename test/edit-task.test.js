// Editing a task: the pure edit, the shared add/edit input rules, the server's `edit` action and
// the sync model's optimistic edit with its rollback and conflict handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/storage.js';
import { isCompleted } from '../src/reminders.js';
import { createSync } from '../src/sync.js';
import { addTodo, editTodo, validText } from '../src/todos.js';
import { readTaskInput } from '../src/task-input.js';
import { patchTodo } from '../server/todo-input.js';
import { createFakeApi } from './fake-api.js';

const HOUR = 3_600_000;
const WORK = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const base = (overrides = {}) => ({
  ...addTodo([], 'Pay rent')[0], revision: 1, ...overrides,
});
// What the edit form sends: no tags, and `categoryId` only when the user changed it.
const fields = (overrides = {}) => ({ text: 'Pay rent', due: null, repeat: 'none', ...overrides });

function setup() {
  const server = createFakeApi();
  globalThis.fetch = server.fetch;
  api.setToken(server.session.csrfToken);
  return { server, sync: createSync(api) };
}

// --- editTodo --------------------------------------------------------------------------------

test('editTodo replaces text and reminder and leaves completion alone', () => {
  const todo = base({ completed: true });
  const due = Date.now() + HOUR;
  const [next] = editTodo([todo], todo.id, fields({ text: '  Pay rent early #bills ', due, repeat: 'daily' }));
  assert.equal(next.text, 'Pay rent early #bills');
  assert.deepEqual(next.tags, []);
  assert.equal(next.due, due);
  assert.equal(next.repeat, 'daily');
  assert.equal(next.notified, null);
  assert.equal(next.completed, true);
  assert.equal(next.id, todo.id);
  assert.equal(next.createdAt, todo.createdAt);
});

test('editTodo sets or clears the category when given and keeps it when omitted', () => {
  const todo = base({ categoryId: WORK });
  const todos = [todo];
  assert.equal(editTodo(todos, todo.id, fields()), todos, 'an omitted category is no change');
  assert.equal(editTodo(todos, todo.id, fields({ categoryId: WORK })), todos);
  assert.equal(editTodo(todos, todo.id, fields({ categoryId: null }))[0].categoryId, null);
  const other = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(editTodo(todos, todo.id, fields({ categoryId: other }))[0].categoryId, other);
  assert.equal(editTodo(todos, todo.id, fields({ text: 'Renamed' }))[0].categoryId, WORK);
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
    { tags: 'home' },
    { due: 1.5, repeat: 'none' },
    { due: null, repeat: 'daily' },
    { due: Date.now(), repeat: 'hourly' },
  ]) {
    assert.equal(editTodo(todos, todo.id, fields(bad)), todos, JSON.stringify(bad));
  }
});

// --- Shared add/edit input -------------------------------------------------------------------

test('readTaskInput keeps "#" as title text and reports why a title is invalid', () => {
  assert.deepEqual(readTaskInput(' Pay rent #Home #bills '), { text: 'Pay rent #Home #bills', error: null });
  assert.deepEqual(readTaskInput('  #home  '), { text: '#home', error: null });
  assert.deepEqual(readTaskInput('Learn C#  and  #42'), { text: 'Learn C#  and  #42', error: null });
  assert.equal(readTaskInput('').error, 'empty');
  assert.equal(readTaskInput('   ').error, 'empty');
  assert.equal(readTaskInput('😀'.repeat(2000)).error, null);
  assert.equal(readTaskInput('😀'.repeat(2001)).error, 'invalid');
  assert.equal(readTaskInput('a\0b').error, 'invalid');
  assert.equal(validText(' ok '), true);
  assert.equal(validText(5), false);
});

test('the edit action applies the whole edit and rejects invalid fields', () => {
  const todo = base();
  const due = Date.now() + HOUR;
  const body = (overrides) => ({ action: 'edit', revision: 1, ...fields(overrides) });
  const edited = patchTodo(todo, body({ text: 'New', tags: ['a', 'b'], due, repeat: 'weekly' }));
  assert.deepEqual([edited.text, edited.tags, edited.due, edited.repeat], ['New', ['a', 'b'], due, 'weekly']);
  assert.equal(patchTodo(todo, body()), todo, 'no change returns the row itself');
  const rejected = [
    [{ text: '' }, /title/],
    [{ text: 'x'.repeat(2001) }, /title/],
    [{ tags: ['ok', '##bad'] }, /tag/],
    [{ tags: [...Array(11)].map((_, i) => `t${i}`) }, /10 tags/],
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
  const edit = fields({ text: 'Pay rent early', due, repeat: 'daily' });
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

  const edit = fields({ text: 'Pay rent early', due: todo.due + HOUR, repeat: 'weekly' });
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
    const result = sync.edit(id, fields({ text: 'Doomed' }));
    assert.equal(sync.todos[0].text, 'Doomed');
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.revision, 1, 'reports the revision it was sent against, for a retry');
    assert.equal(sync.todos[0].text, 'Pay rent');
  }
  assert.equal(server.rows[0].revision, 1);
});

test('an edit the server refuses as invalid rolls back with a 400', async () => {
  const { server, sync } = setup();
  server.rows = [base()];
  await sync.load();
  const outcome = await sync.edit(server.rows[0].id, fields({ text: 'a\0b' }));
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

test('an edit sends categoryId only when given: set, then clear, while other edits keep the link', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: WORK, name: 'Work', revision: 1 }];
  server.rows = [base()];
  await sync.load();
  const id = server.rows[0].id;
  const set = sync.edit(id, fields({ categoryId: WORK }));
  assert.equal(sync.todos[0].categoryId, WORK, 'optimistic');
  assert.equal((await set).ok, true);
  assert.equal(server.rows[0].categoryId, WORK);
  assert.equal((await sync.edit(id, fields({ text: 'Pay rent today' }))).ok, true);
  assert.equal(server.rows[0].categoryId, WORK, 'an edit without categoryId keeps the link');
  assert.equal((await sync.edit(id, fields({ text: 'Pay rent today', categoryId: null }))).ok, true);
  assert.equal(server.rows[0].categoryId, null);
  const bodies = server.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body));
  assert.deepEqual(bodies.map((body) => Object.hasOwn(body, 'categoryId')), [true, false, true]);
  assert.ok(bodies.every((body) => !Object.hasOwn(body, 'tags')), 'no tags are sent');
});

test('assigning a category deleted elsewhere gets 404, rolls back and reloads the catalog', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: WORK, name: 'Work', revision: 1 }];
  server.rows = [base()];
  await sync.load();
  server.categories = [];
  const outcome = await sync.edit(server.rows[0].id, fields({ categoryId: WORK }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'CATEGORY_NOT_FOUND');
  assert.equal(outcome.reloaded, true);
  assert.equal(sync.todos[0].categoryId, null);
  assert.deepEqual(sync.categories, []);
});
