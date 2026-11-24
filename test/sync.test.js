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

const newTodo = (text) => addTodo([], text)[0];
// A plain edit that changes only the title (keeps the reminder shown), used as a generic write.
const retitle = (sync, id, text) => {
  const row = sync.todos.find((todo) => todo.id === id);
  return sync.edit(id, { text, due: row?.due ?? null, repeat: row?.repeat ?? 'none' });
};
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
  retitle(sync, todo.id, 'travel');
  retitle(sync, todo.id, 'family');
  const due = Date.now() + HOUR;
  sync.setReminder(todo.id, due, 'weekly');
  // All optimistic, before any answer.
  assert.equal(sync.todos[0].text, 'family');
  assert.equal(sync.todos[0].due, due);
  const last = await retitle(sync, todo.id, 'Final');
  assert.equal(last.ok, true);
  assert.equal(server.rows[0].text, 'Final');
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
  retitle(sync, todo.id, 'x');
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
  const result = retitle(sync, todo.id, 'oops');
  assert.equal(sync.todos[0].text, 'oops');
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 500);
  assert.equal(sync.todos[0].text, 'Keep me');
  server.failNext = () => new TypeError('Failed to fetch');
  const offline = await sync.toggle(todo.id, Date.now());
  assert.equal(offline.error.code, 'NETWORK');
  assert.equal(sync.todos[0].completed, false);
  assert.equal(server.rows[0].revision, 1);
});

test('optimistic moves share the revision queue and a failed move rolls back', async () => {
  const { server, sync } = setup();
  const [a, hidden, b, c] = ['A', 'Hidden', 'B', 'C'].map((text, i) => ({
    ...newTodo(text), createdAt: i, revision: 1,
  }));
  server.rows = [a, hidden, b, c];
  await sync.load();
  const texts = () => sync.todos.map(({ text }) => text);

  const moved = sync.move(c.id, a.id, 'before');
  const edit = sync.setReminder(c.id, Date.now() + HOUR, 'none');
  assert.deepEqual(texts(), ['C', 'A', 'Hidden', 'B']);
  assert.equal((await moved).ok, true);
  assert.equal((await edit).ok, true);
  const [move, tag] = server.requests.filter(({ method }) => method === 'PATCH').map(({ body }) => JSON.parse(body));
  assert.deepEqual(move, { revision: 1, action: 'move', anchorId: a.id, side: 'before' });
  assert.equal(tag.revision, 2);

  server.failNext = () => new Response('{}', { status: 500 });
  const rejected = sync.move(c.id, b.id, 'after');
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
  // Another tab renames it: this tab's revision is now stale.
  server.rows = [{ ...server.rows[0], text: 'other-tab', revision: 2 }];
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
  const first = retitle(sync, todo.id, 'a');
  const second = retitle(sync, todo.id, 'b');
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
  assert.equal((await retitle(sync, todo.id, 'later')).ok, true);
  assert.equal(server.rows[0].text, 'later');
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
  const write = retitle(sync, server.rows[0].id, 'late');
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
  const tag = retitle(sync, todo.id, 'mine');
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
  assert.equal((await retitle(sync, todo.id, 'later')).ok, true);
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
  // Another tab renames it: revision 2, which this tab hasn't seen.
  server.rows = [{ ...server.rows[0], text: 'theirs', revision: 2 }];
  const hold = holdReloads(server);
  const tag = retitle(sync, todo.id, 'mine'); // 409, then a reload that is held
  await settle();
  assert.equal(sync.todos[0].revision, 1, 'the user still sees revision 1');
  const remove = sync.remove(todo.id); // clicked on the revision-1 row
  await hold.release();
  hold.stop();
  assert.equal((await tag).error.status, 409);
  assert.deepEqual(await remove, { ok: false, cancelled: true });
  assert.equal(server.rows.length, 1, 'the other tab\'s revision was not deleted');
  assert.equal(server.rows[0].text, 'theirs');
  assert.equal(server.requests.filter((r) => r.method === 'DELETE').length, 0);
  // Once the refreshed row is what the user sees, edits go through.
  assert.equal((await sync.remove(todo.id)).ok, true);
  assert.deepEqual(server.rows, []);
});

test('a focus reload cancels a queued delete after the conflict reload failed', async () => {
  const { server, sync } = setup();
  const todo = newTodo('Shared');
  await sync.create(todo);
  server.rows = [{ ...server.rows[0], text: 'theirs', revision: 2 }];
  const hold = holdReloads(server);
  const tag = retitle(sync, todo.id, 'mine');
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
  assert.equal(server.rows[0].text, 'theirs');
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
  assert.equal((await retitle(sync, todo.id, 'mine')).error.status, 409);
  assert.equal(sync.todos[0].revision, 2); // reloaded, but not rendered yet
  assert.deepEqual(await retitle(sync, todo.id, 'early'), { ok: false, cancelled: true });
  shown.set(todo.id, 2); // rendered
  assert.equal((await retitle(sync, todo.id, 'late')).ok, true);
  assert.equal(server.rows[0].text, 'late');
  assert.equal(server.rows[0].completed, true);
});

// --- Categories ------------------------------------------------------------------------------

const HOME = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const WORK = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('a load carries the catalog alphabetically with the todo links; no catalog reads as null', async () => {
  const { server, sync } = setup();
  assert.equal(sync.categories, null, 'nothing before a load');
  server.categories = [{ id: WORK, name: 'work', revision: 1 }, { id: HOME, name: 'Home', revision: 3 }];
  server.rows = [{ ...newTodo('Linked'), categoryId: WORK, revision: 1 }];
  await sync.load();
  assert.deepEqual(sync.categories.map(({ name }) => name), ['Home', 'work']);
  assert.equal(sync.todos[0].categoryId, WORK);
  server.categories = null; // an older server
  await sync.load();
  assert.equal(sync.categories, null);
});

test('category writes wait for the server: create, rename and the limit', async () => {
  const { server, sync } = setup();
  await sync.load();
  const pending = sync.createCategory('Home');
  assert.deepEqual(sync.categories, [], 'not optimistic');
  const created = await pending;
  assert.equal(created.ok, true);
  assert.equal(created.category.name, 'Home');
  assert.deepEqual(sync.categories, server.categories);
  const renamed = await sync.renameCategory(created.category.id, 'House');
  assert.equal(renamed.ok, true);
  assert.deepEqual(sync.categories, [{ id: created.category.id, name: 'House', revision: 2 }]);

  server.categories = Array.from({ length: 50 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `c${i}`, revision: 1,
  }));
  const limited = await sync.createCategory('One more');
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, 'CATEGORY_LIMIT');
  assert.equal(limited.reloaded, true, 'a 409 reloads, so the list shows the real catalog');
  assert.equal(sync.categories.length, 50);
});

test('deleting a category applies the unlinked todos with their new revisions in the same step', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }];
  const linked = { ...newTodo('Linked'), categoryId: HOME, revision: 4 };
  const other = { ...newTodo('Other'), revision: 1 };
  server.rows = [linked, other];
  await sync.load();
  let seen = [];
  const watched = createSync(api, {
    onChange: () => seen.push([watched.categories?.length, watched.todos[0]?.categoryId, watched.todos[0]?.revision]),
  });
  await watched.load();
  seen = [];
  const outcome = await watched.deleteCategory(HOME);
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [[0, null, 5]], 'the catalog and the todos change together, in one update');
  assert.deepEqual(watched.categories, []);
  assert.deepEqual(watched.todos, server.rows);
  // The next write uses the revision the delete returned.
  assert.equal((await retitle(watched, linked.id, 'Still here')).ok, true);
  assert.equal(JSON.parse(server.requests.at(-1).body).revision, 5);
  assert.equal(server.rows[0].revision, 6);
});

test('a stale rename is refused, reloads, and is never replayed', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }];
  await sync.load();
  server.categories = [{ id: HOME, name: 'House', revision: 2 }]; // another tab renamed it
  const outcome = await sync.renameCategory(HOME, 'Flat');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'REVISION_CONFLICT');
  assert.equal(outcome.reloaded, true);
  assert.deepEqual(sync.categories, [{ id: HOME, name: 'House', revision: 2 }]);
  assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 1);
  // A delete clicked against the old revision is refused too, never applied to the newer row.
  server.categories = [{ id: HOME, name: 'House', revision: 3 }];
  assert.equal((await sync.deleteCategory(HOME)).error.code, 'REVISION_CONFLICT');
  assert.equal(server.categories.length, 1);
});

test('category deletion cancels a queued edit when the returned todo has a newer revision', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }];
  const todo = { ...newTodo('Before'), categoryId: HOME, revision: 1 };
  server.rows = [todo];
  await sync.load();
  server.rows = [{ ...todo, text: 'Remote edit', revision: 2 }];
  const deleting = sync.deleteCategory(HOME);
  const editing = retitle(sync, todo.id, 'Stale edit');
  assert.equal((await deleting).ok, true);
  assert.deepEqual(await editing, { ok: false, cancelled: true });
  assert.equal(sync.todos[0].text, 'Remote edit');
  assert.equal(sync.todos[0].revision, 3);
  assert.equal(server.requests.some((request) => request.method === 'PATCH'), false);
});

test('category deletion reloads an omitted, remotely reassigned todo before queued writes', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }, { id: WORK, name: 'Work', revision: 1 }];
  const todo = { ...newTodo('Reassigned'), categoryId: HOME, revision: 1 };
  server.rows = [todo];
  await sync.load();
  server.rows = [{ ...todo, categoryId: WORK, revision: 2 }];
  const deleting = sync.deleteCategory(HOME);
  const editing = retitle(sync, todo.id, 'Stale edit');
  assert.equal((await deleting).ok, true);
  assert.deepEqual(sync.confirmed, server.rows);
  assert.deepEqual(await editing, { ok: false, cancelled: true });
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'DELETE', 'GET']);
});

test('an uncertain create is reconciled by its UUID after the reload', async () => {
  const { server, sync } = setup();
  await sync.load();
  server.failNext = (method) => (method === 'POST' ? { afterWrite: true } : undefined);
  const outcome = await sync.createCategory('Home');
  assert.equal(outcome.ok, true, 'the reload found the category the lost answer created');
  assert.equal(outcome.category.name, 'Home');
  assert.equal(server.categories.length, 1);

  server.failNext = (method) => (method === 'POST' ? new TypeError('Failed to fetch') : undefined);
  const lost = await sync.createCategory('Work');
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, 'NETWORK');
  assert.equal(lost.reloaded, true);
  assert.deepEqual(sync.categories.map(({ name }) => name), ['Home']);
});

test('reset drops the catalog and ignores a category answer from the previous session', async () => {
  const { server, sync } = setup();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }];
  await sync.load();
  let release;
  const real = server.fetch;
  globalThis.fetch = (...args) => new Promise((resolve) => {
    release = () => resolve(real(...args));
  });
  const write = sync.deleteCategory(HOME);
  await settle(1);
  sync.reset();
  api.setToken('token-b');
  assert.equal(sync.categories, null);
  release();
  assert.equal((await write).stale, true);
  assert.equal(sync.categories, null);
  globalThis.fetch = real;
});
