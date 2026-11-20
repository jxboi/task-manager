// The browser storage modules (src/storage.js, src/sync.js) against the real API handlers and
// PostgreSQL: a cookie jar stands in for the browser, one jar per browser profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import signUp from '../api/auth/sign-up/email.js';
import signIn from '../api/auth/sign-in/email.js';
import signOut from '../api/auth/sign-out.js';
import session from '../api/session.js';
import todos from '../api/todos.js';
import { getServices } from '../server/auth.js';
import * as api from '../src/storage.js';
import { createSync } from '../src/sync.js';
import { addTodo } from '../src/todos.js';

const testUrl = process.env.TEST_DATABASE_URL;
const appOrigin = 'https://task-manager.test';
const password = 'A disposable test password';
const LEGACY_KEY = 'task-manager.todos.v1';
const handlers = {
  '/api/auth/sign-up/email': signUp,
  '/api/auth/sign-in/email': signIn,
  '/api/auth/sign-out': signOut,
  '/api/session': session,
  '/api/todos': todos,
};

// A browser profile: its cookie jar and client IP. `use()` points the global fetch at it.
function browser(ip) {
  const jar = new Map();
  return {
    jar,
    use() {
      globalThis.fetch = async (path, init = {}) => {
        const url = new URL(path, appOrigin);
        const headers = new Headers(init.headers);
        headers.set('x-vercel-forwarded-for', ip);
        if ((init.method ?? 'GET') !== 'GET') headers.set('Origin', appOrigin);
        if (jar.size) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
        const response = await handlers[url.pathname].fetch(new Request(url, {
          method: init.method ?? 'GET', headers, body: init.body,
        }));
        for (const item of response.headers.getSetCookie()) {
          const [pair] = item.split(';');
          const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
          if (!value || /Max-Age=0/i.test(item)) jar.delete(name);
          else jar.set(name, value);
        }
        return response;
      };
    },
  };
}

// What src/auth.js does after a successful sign-in: read the session and keep its token.
async function startSession() {
  const active = await api.readSession();
  api.setToken(active.csrfToken);
  return active;
}

const newTodo = (text, tags = []) => addTodo([], text, tags)[0];

test('browser storage modules against PostgreSQL', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  const schema = `task_manager_client_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const admin = new pg.Client({ connectionString: database.href });
  await admin.connect();
  let services;
  t.after(async () => {
    try {
      await services?.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
      delete globalThis.fetch;
      delete globalThis.localStorage;
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./migrate.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL_UNPOOLED: database.href },
  });
  delete process.env.BETTER_AUTH_URL;
  process.env.VERCEL_URL = new URL(appOrigin).host;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.VERCEL_ENV = 'preview';
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = database.href;
  services = getServices();

  // The old browser-only list, seeded before anyone signs in. Every access is recorded.
  const legacy = JSON.stringify([{ id: 'old', text: 'Old local task', completed: false, createdAt: 1 }]);
  const storageCalls = [];
  const store = new Map([[LEGACY_KEY, legacy]]);
  globalThis.localStorage = {
    getItem: (key) => { storageCalls.push(['getItem', key]); return store.get(key) ?? null; },
    setItem: (key, value) => { storageCalls.push(['setItem', key]); store.set(key, value); },
    removeItem: (key) => { storageCalls.push(['removeItem', key]); store.delete(key); },
  };

  const shared = browser('192.0.2.10'); // one device, two accounts
  const clean = browser('192.0.2.11'); // a fresh browser context
  const ana = { name: 'Ana', email: 'ana@example.test', password };
  const ben = { name: 'Ben', email: 'ben@example.test', password };
  let tabA;
  let anaTodo;

  await t.test('signed out, the list cannot be read', async () => {
    shared.use();
    assert.deepEqual(await startSession(), { user: null, csrfToken: null });
    await assert.rejects(api.listTodos(), { status: 401 });
  });

  await t.test('a new account starts empty and saves tasks, tags, reminders and completion', async () => {
    assert.equal((await api.authRequest('sign-up/email', ana)).ok, true);
    const active = await startSession();
    assert.deepEqual(active.user, { name: 'Ana', email: 'ana@example.test' });
    tabA = createSync(api);
    assert.deepEqual(await tabA.load(), { ok: true });
    assert.deepEqual(tabA.todos, []);

    anaTodo = newTodo('Pay rent', ['home', 'bills']);
    const other = newTodo('Water plants');
    tabA.create(anaTodo);
    tabA.create(other);
    tabA.addTag(anaTodo.id, 'urgent');
    tabA.removeTag(anaTodo.id, 'bills');
    const due = Date.now() + 3_600_000;
    tabA.setReminder(anaTodo.id, due, 'weekly');
    tabA.toggle(other.id, Date.now());
    const removable = newTodo('Delete me');
    tabA.create(removable);
    const last = await tabA.remove(removable.id);
    assert.equal(last.ok, true);
    assert.equal(tabA.busy, false);

    const [rent, plants] = tabA.todos;
    assert.equal(tabA.todos.length, 2);
    assert.deepEqual(rent.tags, ['home', 'urgent']);
    assert.equal(rent.due, due);
    assert.equal(rent.repeat, 'weekly');
    assert.equal(plants.completed, true);
    const fresh = createSync(api);
    await fresh.load();
    assert.deepEqual(fresh.todos, tabA.todos);
  });

  await t.test('signing in from a clean browser shows the same saved list', async () => {
    clean.use();
    assert.equal((await api.authRequest('sign-in/email', { email: ana.email, password })).ok, true);
    await startSession();
    const sync = createSync(api);
    await sync.load();
    assert.deepEqual(sync.todos.map(({ text, completed, tags }) => ({ text, completed, tags })), [
      { text: 'Pay rent', completed: false, tags: ['home', 'urgent'] },
      { text: 'Water plants', completed: true, tags: [] },
    ]);
  });

  await t.test('a repeating todo completed in the browser rolls forward on the server', async () => {
    shared.use();
    api.setToken((await api.readSession()).csrfToken);
    const due = Date.now() - 60_000;
    await tabA.setReminder(anaTodo.id, due, 'daily');
    const now = Date.now();
    assert.equal((await tabA.toggle(anaTodo.id, now)).ok, true);
    const row = tabA.todos.find((todo) => todo.id === anaTodo.id);
    assert.equal(row.completed, false);
    assert.equal(row.repeat, 'daily');
    assert.ok(row.due > now && row.due <= now + 86_400_000);
    assert.equal(new Date(row.due).getMinutes(), new Date(due).getMinutes());
  });

  await t.test('two tabs claim an overdue reminder once', async () => {
    const due = Date.now() - 1000;
    await tabA.setReminder(anaTodo.id, due, 'none');
    const tabB = createSync(api);
    await tabB.load();
    const candidates = [{ id: anaTodo.id, due }];
    const results = await Promise.all([tabA.claim(candidates), tabB.claim(candidates)]);
    assert.deepEqual(results.map((result) => result.claimed.length).sort(), [0, 1]);
    assert.equal(results.find((result) => result.claimed.length === 0).conflicts.length, 1);
    for (const tab of [tabA, tabB]) assert.equal(tab.todos.find((todo) => todo.id === anaTodo.id).notified, due);
    const { rows } = await admin.query('SELECT notified FROM todos WHERE id = $1', [anaTodo.id]);
    assert.equal(Number(rows[0].notified), due);
  });

  await t.test('an edit from a stale tab conflicts, reloads and leaves the newer change', async () => {
    const tabB = createSync(api);
    await tabB.load();
    assert.equal((await tabB.addTag(anaTodo.id, 'from-b')).ok, true);
    const stale = await tabA.removeTag(anaTodo.id, 'home');
    assert.equal(stale.ok, false);
    assert.equal(stale.error.status, 409);
    assert.equal(stale.reloaded, true);
    assert.deepEqual(tabA.todos.find((todo) => todo.id === anaTodo.id).tags, ['home', 'urgent', 'from-b']);
  });

  await t.test('a queued completion is not replayed over another tab\'s completion after a conflict', async () => {
    const todo = newTodo('Shared chore');
    await tabA.create(todo);
    const before = tabA.todos.find((item) => item.id === todo.id);
    const tabB = createSync(api);
    await tabB.load();
    assert.equal((await tabB.toggle(todo.id, Date.now())).ok, true); // B completes it
    const tag = tabA.addTag(todo.id, 'mine'); // A's stale tag write conflicts...
    const complete = tabA.toggle(todo.id, Date.now(), before); // ...and A's queued click is cancelled
    assert.equal((await tag).error.status, 409);
    assert.deepEqual(await complete, { ok: false, cancelled: true });
    const { rows } = await admin.query('SELECT completed, revision FROM todos WHERE id = $1', [todo.id]);
    assert.deepEqual(rows, [{ completed: true, revision: 2 }]);
    assert.equal(tabA.todos.find((item) => item.id === todo.id).completed, true);
    assert.equal((await tabA.remove(todo.id)).ok, true);
  });

  await t.test('an uncertain create retried with the same UUID is saved once', async () => {
    const todo = newTodo('Once only');
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      globalThis.fetch = real;
      await real(...args);
      throw new TypeError('Failed to fetch');
    };
    assert.equal((await tabA.create(todo)).error.code, 'NETWORK');
    const retry = await tabA.create(todo);
    assert.equal(retry.ok, true);
    assert.equal(retry.reconciled, true);
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM todos WHERE id = $1', [todo.id]);
    assert.equal(rows[0].n, 1);
  });

  await t.test('another account on the same browser sees an empty list; the old tab cannot touch it', async () => {
    // Ben signs up in another tab of the same browser: the cookie now belongs to Ben.
    assert.equal((await api.authRequest('sign-up/email', ben)).ok, true);
    // Ana's tab still holds Ana's token: reads and writes are refused, not served as Ben's.
    const read = await tabA.load();
    assert.equal(read.error.code, 'INVALID_CSRF');
    const write = await tabA.create(newTodo('Wrong account'));
    assert.equal(write.error.code, 'INVALID_CSRF');
    // The tab re-reads the session and starts over for Ben.
    const active = await startSession();
    assert.equal(active.user.email, ben.email);
    tabA.reset();
    assert.deepEqual(tabA.todos, []);
    assert.deepEqual(await tabA.load(), { ok: true });
    assert.deepEqual(tabA.todos, []);
    await assert.rejects(api.patchTodo(anaTodo.id, 1, 'markNotified', { due: 1 }), { status: 404 });
    await assert.rejects(api.deleteTodo(anaTodo.id, 1), { status: 404 });
    assert.equal((await tabA.create(newTodo('Ben task'))).ok, true);
    assert.deepEqual(tabA.todos.map((todo) => todo.text), ['Ben task']);
    const { rows } = await admin.query(
      'SELECT u.email, count(t.id)::int AS n FROM "user" u LEFT JOIN todos t ON t.user_id = u.id GROUP BY u.email ORDER BY u.email',
    );
    assert.deepEqual(rows, [{ email: ana.email, n: 3 }, { email: ben.email, n: 1 }]);
  });

  await t.test('sign-out revokes the session; an expired session gets 401', async () => {
    assert.equal((await api.authRequest('sign-out', {}, { csrf: true })).ok, true);
    assert.deepEqual(await startSession(), { user: null, csrfToken: null });
    await assert.rejects(api.listTodos(), { status: 401 });

    clean.use();
    api.setToken((await api.readSession()).csrfToken);
    const sync = createSync(api);
    assert.equal((await sync.load()).ok, true);
    await admin.query(`UPDATE "session" SET "expiresAt" = now() - interval '1 second'`);
    const expired = await sync.load();
    assert.equal(expired.error.status, 401);
  });

  await t.test('the old localStorage list was never read, changed or imported', () => {
    assert.deepEqual(storageCalls, []);
    assert.equal(store.get(LEGACY_KEY), legacy);
  });
});
