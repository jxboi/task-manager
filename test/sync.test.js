import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/storage.js';
import { createSync } from '../src/sync.js';
import { addTodo } from '../src/todos.js';
import { createFakeApi, settle } from './fake-api.js';

const HOUR = 3_600_000;

function setup(options) {
  const server = createFakeApi(options);
  globalThis.fetch = server.fetch;
  api.setToken(server.session.csrfToken);
  let changes = 0;
  const sync = createSync(api, { onChange: () => changes++ });
  return { server, sync, changes: () => changes };
}

const newTodo = (text, tags = []) => addTodo([], text, tags)[0];
const strip = ({ revision, createdAt, ...todo }) => todo;

test('load replaces the view with the server list', async () => {
  const { server, sync } = setup();
  const todo = { ...newTodo('Saved'), revision: 1 };
  server.rows = [todo];
  assert.equal(sync.loaded, false);
  assert.deepEqual(await sync.load(), { ok: true });
  assert.deepEqual(sync.todos, [todo]);
  assert.equal(sync.loaded, true);
});

test('a create shows at once, then is replaced by the server row', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Pay rent', ['home']);
  const result = sync.create(todo);
  assert.deepEqual(sync.todos.map(strip), [strip(todo)]);
  assert.equal(sync.busy, true);
  const outcome = await result;
  assert.equal(outcome.ok, true);
  assert.equal(sync.busy, false);
  assert.deepEqual(sync.todos, server.rows);
  assert.equal(sync.todos[0].revision, 1);
});

test('writes are serialized and each uses the revision the previous one returned', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Plan trip');
  sync.create(todo);
  sync.addTag(todo.id, 'travel');
  sync.addTag(todo.id, 'family');
  const due = Date.now() + HOUR;
  sync.setReminder(todo.id, due, 'weekly');
  // All optimistic, before any answer.
  assert.deepEqual(sync.todos[0].tags, ['travel', 'family']);
  assert.equal(sync.todos[0].due, due);
  const last = await sync.removeTag(todo.id, 'travel');
  assert.equal(last.ok, true);
  assert.deepEqual(server.rows[0].tags, ['family']);
  assert.equal(server.rows[0].due, due);
  assert.equal(server.rows[0].repeat, 'weekly');
  assert.equal(server.rows[0].revision, 5);
  assert.deepEqual(sync.todos, server.rows);
  const revisions = server.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body).revision);
  assert.deepEqual(revisions, [1, 2, 3, 4]);
});

test('toggle sends the browser-computed rollover for a repeating todo', async () => {
  const { server, sync } = setup();
  const due = Date.now() - HOUR;
  server.rows = [{ ...newTodo('Water plants'), due, repeat: 'daily', notified: null, revision: 1 }];
  await sync.load();
  const now = Date.now();
  const result = await sync.toggle(server.rows[0].id, now);
  assert.equal(result.ok, true);
  const [row] = server.rows;
  assert.equal(row.completed, false);
  assert.ok(row.due > now);
  assert.equal(row.repeat, 'daily');
  const body = JSON.parse(server.requests.at(-1).body);
  assert.deepEqual(body, { completed: false, due: row.due, revision: 1, action: 'complete' });
  // A plain toggle completes and keeps the due time.
  await sync.clearReminder(row.id);
  await sync.toggle(row.id, Date.now());
  assert.equal(server.rows[0].completed, true);
  await sync.toggle(row.id, Date.now());
  assert.equal(server.rows[0].completed, false);
});

test('remove deletes at the current revision', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Gone soon');
  sync.create(todo);
  sync.addTag(todo.id, 'x');
  const result = sync.remove(todo.id);
  assert.deepEqual(sync.todos, []);
  assert.equal((await result).ok, true);
  assert.deepEqual(server.rows, []);
  assert.match(server.requests.at(-1).path, /revision=2$/);
});

test('a failed write drops out of the view and keeps the confirmed row', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Keep me');
  await sync.create(todo);
  server.failNext = () => new Response('{}', { status: 500 });
  const result = sync.addTag(todo.id, 'oops');
  assert.deepEqual(sync.todos[0].tags, ['oops']);
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 500);
  assert.deepEqual(sync.todos[0].tags, []);
  server.failNext = () => new TypeError('Failed to fetch');
  const offline = await sync.toggle(todo.id, Date.now());
  assert.equal(offline.error.code, 'NETWORK');
  assert.equal(sync.todos[0].completed, false);
  assert.equal(server.rows[0].revision, 1);
});

test('a revision conflict reloads the list before resolving', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  await sync.create(todo);
  // Another tab adds a tag: this tab's revision is now stale.
  server.rows = [{ ...server.rows[0], tags: ['other-tab'], revision: 2 }];
  const outcome = await sync.toggle(todo.id, Date.now());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 409);
  assert.equal(outcome.reloaded, true);
  assert.deepEqual(sync.todos, server.rows);
  assert.equal(sync.todos[0].completed, false);
});

test('a write for a todo deleted elsewhere gets 404, reloads, and later writes skip it', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Deleted elsewhere');
  await sync.create(todo);
  server.rows = [];
  const first = sync.addTag(todo.id, 'a');
  const second = sync.addTag(todo.id, 'b');
  assert.equal((await first).error.status, 404);
  assert.deepEqual(await second, { ok: false, skipped: true });
  assert.deepEqual(sync.todos, []);
});

test('retrying an uncertain create with the same UUID reconciles instead of duplicating', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Maybe saved');
  // The row is written but the answer is lost.
  server.failNext = () => ({ afterWrite: true });
  const lost = await sync.create(todo);
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, 'NETWORK');
  assert.deepEqual(sync.todos, []);
  const retry = await sync.create(todo);
  assert.equal(retry.ok, true);
  assert.equal(retry.reconciled, true);
  assert.equal(server.rows.length, 1);
  assert.deepEqual(sync.todos, server.rows);
});

test('reset discards rows, pending writes and late answers from the previous session', async () => {
  const { server, sync } = setup();
  server.rows = [{ ...newTodo('Account A'), revision: 1 }];
  await sync.load();
  let release;
  server.failNext = () => undefined;
  const slow = server.fetch;
  globalThis.fetch = (...args) => new Promise((resolve) => {
    release = () => resolve(slow(...args));
  });
  const write = sync.addTag(server.rows[0].id, 'late');
  await settle(1);
  sync.reset();
  api.setToken('token-b');
  assert.deepEqual(sync.todos, []);
  assert.equal(sync.loaded, false);
  release();
  assert.equal((await write).stale, true);
  assert.deepEqual(sync.todos, []);
  globalThis.fetch = slow;
});

test('claim marks an overdue occurrence once and skips ones no longer due', async () => {
  const { server, sync } = setup();
  const due = Date.now() - 1000;
  const a = { ...newTodo('Due'), due, repeat: 'none', notified: null, revision: 1 };
  const b = { ...newTodo('Done'), completed: true, due, repeat: 'none', notified: null, revision: 1 };
  const c = { ...newTodo('Later'), due: Date.now() + HOUR, repeat: 'none', notified: null, revision: 1 };
  server.rows = [a, b, c];
  await sync.load();
  const result = await sync.claim([a, b, c].map(({ id, due: at }) => ({ id, due: at })));
  assert.deepEqual(result.claimed.map((todo) => todo.id), [a.id]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(server.rows[0].notified, due);
  assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 1);
  // Already claimed: nothing is sent.
  const again = await sync.claim([{ id: a.id, due }]);
  assert.deepEqual(again.claimed, []);
  assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 1);
});

test('two tabs claiming the same occurrence: one wins, the other reloads and sees it claimed', async () => {
  const server = createFakeApi();
  globalThis.fetch = server.fetch;
  api.setToken(server.session.csrfToken);
  const due = Date.now() - 1000;
  server.rows = [{ ...newTodo('Stand-up'), due, repeat: 'daily', notified: null, revision: 1 }];
  const tabs = [createSync(api), createSync(api)];
  await Promise.all(tabs.map((tab) => tab.load()));
  const candidate = [{ id: server.rows[0].id, due }];
  const results = await Promise.all(tabs.map((tab) => tab.claim(candidate)));
  assert.deepEqual(results.map((r) => r.claimed.length).sort(), [0, 1]);
  const loser = results.find((r) => r.claimed.length === 0);
  assert.deepEqual(loser.conflicts, candidate);
  for (const tab of tabs) assert.equal(tab.todos[0].notified, due);
});

test('a failed claim reports the error and claims nothing', async () => {
  const { server, sync } = setup();
  const due = Date.now() - 1000;
  server.rows = [{ ...newTodo('Due'), due, repeat: 'none', notified: null, revision: 1 }];
  await sync.load();
  server.failNext = () => new TypeError('Failed to fetch');
  const result = await sync.claim([{ id: server.rows[0].id, due }]);
  assert.deepEqual(result.claimed, []);
  assert.equal(result.error.code, 'NETWORK');
  assert.equal(server.rows[0].notified, null);
});

test('session errors come back to the caller: 401 and a CSRF mismatch', async () => {
  const { server, sync } = setup();
  await sync.load();
  api.setToken('stale-token');
  const blocked = await sync.load();
  assert.equal(blocked.error.code, 'INVALID_CSRF');
  server.session = { user: null, csrfToken: null };
  const expired = await sync.create(newTodo('Too late'));
  assert.equal(expired.error.status, 401);
  assert.deepEqual(sync.todos, []);
});

test('item 3: a conflict cancels the queued changes for that todo instead of rebasing them', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  const other = newTodo('Unrelated');
  await sync.create(todo);
  const before = sync.todos[0];
  // Another tab completes it: this tab's revision is stale.
  server.rows = [{ ...server.rows[0], completed: true, revision: 2 }];
  const tag = sync.addTag(todo.id, 'mine');
  const complete = sync.toggle(todo.id, Date.now(), before); // queued behind the tag write
  const create = sync.create(other); // another todo: not affected
  assert.equal((await tag).error.status, 409);
  assert.deepEqual(await complete, { ok: false, cancelled: true });
  assert.equal((await create).ok, true);
  // The other tab's completion stands; nothing turned it back.
  assert.equal(server.rows[0].completed, true);
  assert.equal(server.rows[0].revision, 2);
  assert.equal(sync.todos.find((item) => item.id === todo.id).completed, true);
  assert.ok(server.rows.some((item) => item.id === other.id));
  // Changes made after the conflict go through.
  assert.equal((await sync.addTag(todo.id, 'later')).ok, true);
});

test('item 3: a queued completion whose row changed under it (after a reload) is refused', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  await sync.create(todo);
  const before = sync.todos[0];
  server.rows = [{ ...server.rows[0], completed: true, revision: 2 }];
  // A reload (returning to the tab) lands before the queued click is sent.
  const reload = sync.load();
  const complete = sync.toggle(todo.id, Date.now(), before);
  await reload;
  const outcome = await complete;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'STALE_CHANGE');
  assert.equal(outcome.reloaded, true);
  assert.equal(server.rows[0].completed, true);
  assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 0);
});
