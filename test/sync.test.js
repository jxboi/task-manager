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

test('toggle sends the browser-computed completion cutoff and next repeating reminder', async () => {
  const { server, sync } = setup();
  const due = Date.now() - HOUR;
  server.rows = [{ ...newTodo('Water plants'), due, repeat: 'daily', notified: null, revision: 1 }];
  await sync.load();
  const now = Date.now();
  const result = await sync.toggle(server.rows[0].id, now);
  assert.equal(result.ok, true);
  const [row] = server.rows;
  assert.equal(row.completed, true);
  assert.ok(row.due > now);
  assert.equal(row.repeat, 'daily');
  const body = JSON.parse(server.requests.at(-1).body);
  assert.deepEqual(body, {
    completed: true, due: row.due, completedUntil: new Date(row.due).setHours(0, 0, 0, 0),
    revision: 1, action: 'complete',
  });
  // Clearing the reminder keeps the check until the user unticks it or the cutoff passes.
  await sync.clearReminder(row.id);
  assert.equal(server.rows[0].completed, true);
  await sync.toggle(row.id, Date.now());
  assert.equal(server.rows[0].completed, false);
  await sync.toggle(row.id, Date.now());
  assert.equal(server.rows[0].completed, true);
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

test('optimistic moves share the revision queue and a failed move rolls back', async () => {
  const { server, sync } = setup();
  const [a, hidden, b, c] = ['A', 'Hidden', 'B', 'C'].map((text, i) => ({
    ...newTodo(text, text === 'Hidden' ? [] : ['work']), createdAt: i, revision: 1,
  }));
  server.rows = [a, hidden, b, c];
  await sync.load();
  const texts = () => sync.todos.map(({ text }) => text);

  const moved = sync.move(c.id, a.id, 'before', ['work']);
  const edit = sync.addTag(c.id, 'another');
  assert.deepEqual(texts(), ['C', 'A', 'Hidden', 'B']);
  assert.equal((await moved).ok, true);
  assert.equal((await edit).ok, true);
  const [move, tag] = server.requests.filter(({ method }) => method === 'PATCH').map(({ body }) => JSON.parse(body));
  assert.deepEqual(move, { revision: 1, action: 'move', anchorId: a.id, side: 'before' });
  assert.equal(tag.revision, 2);

  server.failNext = () => new Response('{}', { status: 500 });
  const rejected = sync.move(c.id, b.id, 'after', ['work']);
  assert.deepEqual(texts(), ['A', 'Hidden', 'B', 'C']);
  assert.equal((await rejected).error.status, 500);
  assert.deepEqual(texts(), ['C', 'A', 'Hidden', 'B']);
  assert.deepEqual(sync.todos, server.rows);
});

test('a stale move reloads the remote order and cancels a queued move of the stale row', async () => {
  const { server, sync } = setup();
  const [a, b, c] = ['A', 'B', 'C'].map((text, i) => ({ ...newTodo(text), createdAt: i, revision: 1 }));
  server.rows = [a, b, c];
  await sync.load();
  const otherTab = createSync(api);
  await otherTab.load();
  assert.equal((await otherTab.move(c.id, b.id, 'before')).ok, true);

  const first = sync.move(c.id, a.id, 'before');
  const queued = sync.move(c.id, b.id, 'after');
  assert.equal((await first).error.status, 409);
  assert.deepEqual(await queued, { ok: false, cancelled: true });
  assert.deepEqual(sync.todos, otherTab.todos);
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

test('a list reload restores an editable revision for a UUID after empty reconciliation', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Recreated elsewhere');
  await sync.create(todo);
  const [original] = server.rows;
  const hold = holdReloads(server);
  const retry = sync.create(todo);
  await settle();
  server.rows = [];
  await hold.release();
  hold.stop();
  const outcome = await retry;
  assert.equal(outcome.error.code, 'DUPLICATE_ID');
  assert.equal(outcome.reloaded, true);
  assert.deepEqual(sync.todos, []);

  server.rows = [{ ...original, createdAt: original.createdAt + 1, revision: 1 }];
  assert.equal((await sync.load()).ok, true);
  assert.equal((await sync.addTag(todo.id, 'later')).ok, true);
  assert.deepEqual(server.rows[0].tags, ['later']);
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
  assert.deepEqual(await complete, { ok: false, cancelled: true });
  assert.equal(server.rows[0].completed, true);
  assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 0);
});

// Holds GET /api/todos (a reload) until released.
function holdReloads(server) {
  const held = [];
  const real = server.fetch;
  globalThis.fetch = async (path, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') await new Promise((resolve) => held.push(resolve));
    return real(path, init);
  };
  return {
    release: async () => {
      for (let i = 0; i < 20 && held.length === 0; i++) await settle(1);
      held.shift()();
      await settle();
    },
    stop: () => { globalThis.fetch = real; },
  };
}

test('item 2: a delete clicked while a conflict reload is on its way is cancelled, not applied to the new revision', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  await sync.create(todo);
  // Another tab adds a tag: revision 2, which this tab hasn't seen.
  server.rows = [{ ...server.rows[0], tags: ['theirs'], revision: 2 }];
  const hold = holdReloads(server);
  const tag = sync.addTag(todo.id, 'mine'); // 409, then a reload that is held
  await settle();
  assert.equal(sync.todos[0].revision, 1, 'the user still sees revision 1');
  const remove = sync.remove(todo.id); // clicked on the revision-1 row
  await hold.release();
  hold.stop();
  assert.equal((await tag).error.status, 409);
  assert.deepEqual(await remove, { ok: false, cancelled: true });
  assert.equal(server.rows.length, 1, 'the other tab\'s revision was not deleted');
  assert.deepEqual(server.rows[0].tags, ['theirs']);
  assert.equal(server.requests.filter((r) => r.method === 'DELETE').length, 0);
  // Once the refreshed row is what the user sees, edits go through.
  assert.equal((await sync.remove(todo.id)).ok, true);
  assert.deepEqual(server.rows, []);
});

test('a focus reload cancels a queued delete after the conflict reload failed', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  await sync.create(todo);
  server.rows = [{ ...server.rows[0], tags: ['theirs'], revision: 2 }];
  const hold = holdReloads(server);
  const tag = sync.addTag(todo.id, 'mine');
  await settle();
  const focus = sync.load();
  assert.equal(sync.todos[0].revision, 1);
  const remove = sync.remove(todo.id);
  server.failNext = (method) => (method === 'GET' ? new Response('{}', { status: 500 }) : undefined);
  await hold.release();
  await hold.release();
  hold.stop();
  assert.equal((await tag).reloaded, false);
  assert.equal((await focus).ok, true);
  assert.deepEqual(await remove, { ok: false, cancelled: true });
  assert.deepEqual(sync.todos, server.rows);
  assert.deepEqual(server.rows[0].tags, ['theirs']);
});

test('a reminder claim conflict reload cancels a queued delete of that task', async () => {
  const { server, sync } = setup();
  const due = Date.now() - 1000;
  const todo = { ...newTodo('Due'), due, revision: 1 };
  server.rows = [todo];
  await sync.load();
  server.rows = [{ ...todo, notified: due, revision: 2 }];
  const candidate = { id: todo.id, due };
  const claim = sync.claim([candidate]);
  const remove = sync.remove(todo.id);
  assert.deepEqual((await claim).conflicts, [candidate]);
  assert.deepEqual(await remove, { ok: false, cancelled: true });
  assert.deepEqual(sync.todos, server.rows);
  assert.equal(server.rows[0].notified, due);
});

test('item 2: an edit made before the refreshed row is on screen is cancelled; after, it goes through', async () => {
  const server = createFakeApi();
  globalThis.fetch = server.fetch;
  api.setToken(server.session.csrfToken);
  const shown = new Map(); // what the page has rendered
  const sync = createSync(api, { seenRevision: (id) => shown.get(id) });
  const todo = newTodo('Shared');
  await sync.create(todo);
  shown.set(todo.id, 1);
  server.rows = [{ ...server.rows[0], completed: true, revision: 2 }];
  assert.equal((await sync.addTag(todo.id, 'mine')).error.status, 409);
  assert.equal(sync.todos[0].revision, 2); // reloaded, but not rendered yet
  assert.deepEqual(await sync.addTag(todo.id, 'early'), { ok: false, cancelled: true });
  shown.set(todo.id, 2); // rendered
  assert.equal((await sync.addTag(todo.id, 'late')).ok, true);
  assert.deepEqual(server.rows[0].tags, ['late']);
  assert.equal(server.rows[0].completed, true);
});
