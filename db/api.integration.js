import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import demo from '../api/auth/demo.js';
import signUp from '../api/auth/sign-up/email.js';
import signIn from '../api/auth/sign-in/email.js';
import signOut from '../api/auth/sign-out.js';
import session from '../api/session.js';
import todos from '../api/todos.js';
import { getServices } from '../server/auth.js';
import { listMigrationFiles, runMigrations } from './runner.js';
import { assertSchemaCurrent, resetSchemaGuard } from '../server/schema-guard.js';

const testUrl = process.env.TEST_DATABASE_URL;
const appOrigin = 'https://task-manager.test';
const branchOrigin = 'https://task-manager-git-feature.test';
const otherOrigin = 'https://other.test';
const password = 'A disposable test password';
const demoPath = '/api/auth/demo';
const demoEmail = 'demo@example.test';
const signedOut = { user: null, csrfToken: null };
const previewSignedOut = { ...signedOut, demoLoginEnabled: true };
const handlers = {
  [demoPath]: demo,
  '/api/auth/sign-up/email': signUp,
  '/api/auth/sign-in/email': signIn,
  '/api/auth/sign-out': signOut,
  '/api/session': session,
  '/api/todos': todos,
};

async function request(path, {
  method = 'GET', account, site = appOrigin, origin = site, csrf = account?.csrfToken,
  ip = '192.0.2.1',
  body, contentType = 'application/json', pathname = new URL(path, appOrigin).pathname,
  handler = handlers[pathname],
} = {}) {
  const headers = new Headers({ 'x-vercel-forwarded-for': ip });
  if (origin) headers.set('Origin', origin);
  if (account) headers.set('Cookie', account.cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (method !== 'GET' && contentType) headers.set('Content-Type', contentType);
  const response = await handler.fetch(new Request(new URL(path, site), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, headers: response.headers, data };
}

const post = (path, body, options) => request(path, { method: 'POST', body, ...options });
const patch = (account, id, body) => request(`/api/todos?id=${id}`, { method: 'PATCH', account, body });
const remove = (account, id, revision) => request(`/api/todos?id=${id}&revision=${revision}`, {
  method: 'DELETE', account,
});

async function authenticated(response, name, email, site = appOrigin) {
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const value = response.headers.getSetCookie().find((item) => item.startsWith('__Secure-better-auth.session_token='));
  assert.ok(value);
  for (const flag of [/; Path=\//i, /; HttpOnly/i, /; Secure/i, /; SameSite=Lax/i]) assert.match(value, flag);
  assert.doesNotMatch(value, /; Domain=/i);
  const cookie = value.split(';')[0];
  const active = await request('/api/session', { site, account: { cookie } });
  assert.equal(active.status, 200);
  assert.deepEqual(active.data.user, { name, email });
  assert.match(active.data.csrfToken, /^[\w-]{43}$/);
  return { cookie, csrfToken: active.data.csrfToken, token: response.data.token, userId: response.data.user?.id };
}

const pr2Commit = 'ae37a58';
const repo = fileURLToPath(new URL('../', import.meta.url));
const pr2Files = [
  'api/todos.js',
  'server/auth-origins.js', 'server/auth.js', 'server/demo-login.js', 'server/http.js',
  'server/schema-guard.js', 'server/todo-endpoint.js', 'server/todo-input.js', 'server/transaction.js',
  'src/reminders.js', 'src/tags.js', 'src/todos.js',
  'db/runner.js', 'db/migrations/0001_auth.sql', 'db/migrations/0002_todos.sql',
  'db/migrations/0003_recurring_completion.sql', 'db/migrations/0004_todo_position.sql',
  'db/migrations/0005_categories.sql',
];

async function loadPr2Todos(t) {
  const check = spawnSync('git', ['cat-file', '-e', `${pr2Commit}^{commit}`], { cwd: repo });
  if (check.error?.code === 'ENOENT') {
    t.skip('Git is unavailable for the PR 2 handler test');
    return;
  }
  if (check.error) throw check.error;
  if (check.status !== 0) {
    t.skip(`PR 2 commit ${pr2Commit} is unavailable (for example, in a shallow clone)`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'task-manager-pr2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await symlink(join(repo, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const file of pr2Files) {
    const target = join(directory, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, execFileSync('git', ['show', `${pr2Commit}:${file}`], { cwd: repo }));
  }
  const load = (file) => import(pathToFileURL(join(directory, file)));
  const { getServices: getPr2Services } = await load('server/auth.js');
  const { pool } = getPr2Services();
  t.after(() => pool.end());
  return (await load('api/todos.js')).default;
}

test('auth and todo API against PostgreSQL', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  const schema = `task_manager_api_${randomBytes(8).toString('hex')}`;
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
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  delete process.env.BETTER_AUTH_URL;
  process.env.VERCEL_URL = new URL(appOrigin).host;
  process.env.VERCEL_BRANCH_URL = new URL(branchOrigin).host;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.VERCEL_ENV = 'preview';
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = database.href;
  services = getServices();

  await t.test('new guard requires 0005 and the previous guard accepts the upgraded schema', async () => {
    const migrations = new URL('./migrations/', import.meta.url);
    const directory = await mkdtemp(join(tmpdir(), 'previous-migrations-'));
    const previous = pathToFileURL(`${directory}/`);
    const migrate = (directory) => runMigrations({ connectionString: database.href, directory, log: () => {} });
    try {
      for (const name of (await listMigrationFiles(migrations)).filter((name) => name < '0005_categories.sql')) {
        await copyFile(new URL(name, migrations), new URL(name, previous));
      }
      await migrate(previous);
      resetSchemaGuard();
      const before = await request('/api/session');
      assert.equal(before.status, 503);
      assert.equal(before.data.error.code, 'SCHEMA_OUT_OF_DATE');
      assert.match(before.data.error.message, /0005_categories\.sql/);

      assert.ok((await migrate(migrations)).includes('0005_categories.sql'));
      resetSchemaGuard();
      const after = await request('/api/session');
      assert.equal(after.status, 200);
      assert.deepEqual(after.data, previewSignedOut);

      resetSchemaGuard();
      await assertSchemaCurrent(services.pool, previous);
    } finally {
      resetSchemaGuard();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const signupPath = '/api/auth/sign-up/email';
  const signinPath = '/api/auth/sign-in/email';
  const signoutPath = '/api/auth/sign-out';
  await t.test('disabled demo returns 404 without touching auth tables', async () => {
    const authCounts = async () => (await admin.query(
      `SELECT (SELECT count(*) FROM "user") AS users,
              (SELECT count(*) FROM "session") AS sessions,
              (SELECT count(*) FROM account) AS accounts,
              (SELECT count(*) FROM "rateLimit") AS limits`,
    )).rows;
    const before = await authCounts();
    process.env.VERCEL_ENV = 'production';
    try {
      const response = await demo.fetch(new Request(new URL(demoPath, appOrigin), {
        method: 'POST',
        headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
        body: '{}',
      }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.has('Set-Cookie'), false);
      assert.equal(await response.text(), '');
      assert.deepEqual((await request('/api/session')).data, signedOut);
      assert.deepEqual(await authCounts(), before);
    } finally {
      process.env.VERCEL_ENV = 'preview';
    }
  });

  const alice = { name: 'Alice', email: 'cli-alice@example.test', password };
  const bob = { name: 'Bob', email: 'cli-bob@example.test', password };
  const short = await post(signupPath, { ...alice, password: '11 chars!!!' });
  assert.equal(short.status, 400, JSON.stringify(short.data));
  const a = await authenticated(await post(signupPath, alice), alice.name, alice.email);
  const b = await authenticated(await post(signupPath, bob), bob.name, bob.email);
  const clock = await admin.query(
    'SELECT EXTRACT(EPOCH FROM ("expiresAt" - "createdAt")) AS seconds FROM "session" WHERE token = $1', [a.token],
  );
  assert.ok(Math.abs(Number(clock.rows[0].seconds) - 7 * 86400) <= 1);
  assert.notEqual(a.csrfToken, b.csrfToken);

  const aId = randomUUID();
  const bId = randomUUID();
  const create = (account, id, text, tags = []) => post('/api/todos', { id, text, tags }, { account });

  await t.test('the current handler folds legacy tags and preserves assigned categories', async () => {
    const user = { name: 'Compatibility', email: 'cli-compat@example.test', password };
    const account = await authenticated(await post(signupPath, user, { ip: '192.0.2.70' }), user.name, user.email);
    const { userId } = account;
    const category = randomUUID();
    const assigned = randomUUID();
    const anchor = randomUUID();
    const created = randomUUID();
    await admin.query("INSERT INTO categories (user_id, id, name) VALUES ($1, $2, 'work')", [userId, category]);
    await admin.query(
      `INSERT INTO todos (user_id, id, text, tags, created_at, category_id) VALUES
         ($1, $2, 'Assigned', '{work}', 1, $4), ($1, $3, 'Anchor', '{}', 2, NULL)`,
      [userId, assigned, anchor, category],
    );
    const links = async (id) => (await admin.query(
      'SELECT category_id FROM todos WHERE user_id = $1 AND id = $2', [userId, id],
    )).rows;
    const stored = async (id) => (await admin.query(
      'SELECT text, tags, category_id FROM todos WHERE user_id = $1 AND id = $2', [userId, id],
    )).rows[0];
    // A row the previous artifact wrote with tags reads with them folded into the title.
    assert.equal((await request(`/api/todos?id=${assigned}`, { account })).data.todo.text, 'Assigned #work');
    assert.equal((await create(account, created, 'Old create', ['work'])).status, 201);
    assert.deepEqual(await stored(created), { text: 'Old create #work', tags: [], category_id: null });

    const due = Date.now() - 10_000;
    const update = async (revision, changes) => {
      const response = await patch(account, assigned, { revision, ...changes });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.todo.revision, revision + 1);
      assert.deepEqual(await links(assigned), [{ category_id: category }]);
      return response.data.todo;
    };
    const edited = await update(1, { action: 'edit', text: 'Edited', tags: ['home'], due, repeat: 'daily' });
    assert.deepEqual([edited.text, edited.tags], ['Edited #home', []]);
    assert.deepEqual(await stored(assigned), { text: 'Edited #home', tags: [], category_id: category });
    const moved = await update(2, { action: 'move', anchorId: anchor, side: 'after' });
    assert.notEqual(moved.position, edited.position);
    assert.equal((await update(3, { action: 'markNotified', due })).notified, due);
    const completed = await update(4, { action: 'complete', completed: true, due });
    assert.equal(completed.completed, true);

    const list = await request('/api/todos', { account });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.todos.map(({ id }) => id), [anchor, assigned, created]);
    assert.deepEqual(list.data.todos[1], completed);
    assert.deepEqual(Object.keys(completed).sort(), [
      'categoryId', 'completed', 'completedUntil', 'createdAt', 'due', 'id', 'notified', 'position', 'repeat', 'revision', 'tags',
      'text',
    ]);
    assert.equal(completed.categoryId, category);
    assert.deepEqual(list.data.categories, [{ id: category, name: 'work', revision: 1 }]);
    assert.equal((await remove(account, assigned, completed.revision)).status, 204);
    assert.deepEqual(await links(assigned), []);
    assert.equal((await admin.query('SELECT 1 FROM categories WHERE user_id = $1 AND id = $2', [userId, category])).rowCount, 1);
  });

  await t.test('the PR 2 todo handler works on 0006 and preserves category links', async (t) => {
    const handler = await loadPr2Todos(t);
    if (!handler) return;
    assert.equal((await admin.query(
      "SELECT 1 FROM schema_migrations WHERE filename = '0006_tags_to_categories.sql'",
    )).rowCount, 1);
    const user = { name: 'Rollback', email: 'cli-rollback@example.test', password };
    const account = await authenticated(await post(signupPath, user, { ip: '192.0.2.71' }), user.name, user.email);
    const [id, anchor, category] = Array.from({ length: 3 }, () => randomUUID());
    const oldRequest = (path, options) => request(path, { account, handler, ...options });
    for (const [todoId, title] of [[id, 'Old create'], [anchor, 'Anchor']]) {
      const created = await oldRequest('/api/todos', { method: 'POST', body: { id: todoId, text: title, tags: ['work'] } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.deepEqual(created.data.todo.tags, ['work']);
      assert.equal(created.data.todo.categoryId, null);
    }
    await admin.query("INSERT INTO categories (user_id, id, name) VALUES ($1, $2, 'work')", [account.userId, category]);
    await admin.query('UPDATE todos SET category_id = $2 WHERE user_id = $1', [account.userId, category]);
    const links = async () => (await admin.query(
      'SELECT id, category_id FROM todos WHERE user_id = $1', [account.userId],
    )).rows;
    const due = Date.now() - 10_000;
    const path = `/api/todos?id=${id}`;
    const update = async (revision, changes) => {
      const response = await oldRequest(path, { method: 'PATCH', body: { revision, ...changes } });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.todo.revision, revision + 1);
      assert.equal(response.data.todo.categoryId, category);
      assert.deepEqual(new Map((await links()).map((row) => [row.id, row.category_id])),
        new Map([[id, category], [anchor, category]]));
      return response.data.todo;
    };
    const edited = await update(1, { action: 'edit', text: 'Old edit', tags: ['home'], due, repeat: 'none' });
    assert.deepEqual([edited.text, edited.tags, edited.due], ['Old edit', ['home'], due]);
    const moved = await update(2, { action: 'move', anchorId: anchor, side: 'after' });
    assert.notEqual(moved.position, edited.position);
    assert.equal((await update(3, { action: 'markNotified', due })).notified, due);
    const toggled = await update(4, { action: 'complete', completed: true, due });
    assert.equal(toggled.completed, true);

    const list = await oldRequest('/api/todos');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.todos.map((todo) => todo.id), [anchor, id]);
    assert.equal((await oldRequest(`${path}&revision=${toggled.revision}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await links(), [{ id: anchor, category_id: category }]);
  });

  await t.test('demo cannot claim an existing account with the reserved email', async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "user" (id, email, name, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Existing account', now(), now())`, [id, demoEmail],
    );
    try {
      const result = await post(demoPath, {}, { ip: '192.0.2.50' });
      assert.equal(result.status, 409);
      assert.equal(result.headers.has('Set-Cookie'), false);
      assert.equal((await admin.query('SELECT 1 FROM "session" WHERE "userId" = $1', [id])).rowCount, 0);
    } finally {
      await admin.query('DELETE FROM "user" WHERE id = $1', [id]);
    }
  });

  await t.test('preview demo issues real sessions, reserves its email and limits attempts', async () => {
    const demoIp = '192.0.2.51';
    const attempt = (body = {}) => post(demoPath, body, { ip: demoIp });
    assert.deepEqual((await request('/api/session')).data, previewSignedOut);
    assert.equal((await post(demoPath, {}, { origin: null })).status, 403);
    assert.equal((await post(demoPath, {}, { origin: branchOrigin })).status, 403);
    assert.equal((await post(demoPath, {}, { contentType: 'text/plain' })).status, 400);
    assert.equal((await post(demoPath, [], { ip: demoIp })).status, 400);

    const reserved = await post(signupPath, { name: 'Other', email: demoEmail.toUpperCase(), password }, { ip: demoIp });
    assert.equal(reserved.status, 422);
    assert.equal(reserved.headers.has('Set-Cookie'), false);
    assert.equal((await admin.query('SELECT 1 FROM "user" WHERE email = $1', [demoEmail])).rowCount, 0);

    const firstLogins = await Promise.all([attempt(), attempt({ id: a.userId, email: alice.email })]);
    const branchLogin = await post(demoPath, {}, { ip: demoIp, site: branchOrigin });
    const [first, second, third] = await Promise.all(
      [...firstLogins.map((response) => authenticated(response, 'Demo', demoEmail)),
        authenticated(branchLogin, 'Demo', demoEmail, branchOrigin)],
    );
    assert.equal(new Set([first.cookie, second.cookie, third.cookie]).size, 3);
    const { rows: users } = await admin.query('SELECT id FROM "user" WHERE email = $1', [demoEmail]);
    assert.equal(users.length, 1);
    const [user] = users;
    assert.equal((await admin.query('SELECT 1 FROM "session" WHERE "userId" = $1', [user.id])).rowCount, 3);
    assert.equal((await admin.query('SELECT 1 FROM account WHERE "userId" = $1', [user.id])).rowCount, 0);

    const throttled = await attempt();
    assert.equal(throttled.status, 429);
    assert.ok(throttled.headers.get('x-retry-after'));
    const emailSignIn = await post(signinPath, { email: demoEmail, password }, { ip: demoIp });
    assert.equal(emailSignIn.status, 401);
    assert.equal(emailSignIn.headers.has('Set-Cookie'), false);

    const demoTodoId = randomUUID();
    const aliceTodoId = randomUUID();
    assert.equal((await create(first, demoTodoId, 'Demo task')).status, 201);
    assert.equal((await create(a, aliceTodoId, 'Alice task')).status, 201);
    for (const [account, ownId, foreignId] of [[second, demoTodoId, aliceTodoId], [a, aliceTodoId, demoTodoId]]) {
      const list = await request('/api/todos', { account });
      assert.equal(list.status, 200);
      assert.deepEqual(list.data.todos.map(({ id }) => id), [ownId]);
      assert.equal((await request(`/api/todos?id=${foreignId}`, { account })).status, 404);
      assert.equal((await patch(account, foreignId, { action: 'clearReminder', revision: 1 })).status, 404);
      assert.equal((await remove(account, foreignId, 1)).status, 404);
    }
    assert.equal((await remove(a, aliceTodoId, 1)).status, 204);
    process.env.VERCEL_ENV = 'production';
    try {
      assert.deepEqual((await request('/api/session', { account: first })).data, signedOut);
      assert.equal((await request('/api/todos', { account: first })).status, 401);
    } finally {
      process.env.VERCEL_ENV = 'preview';
    }
  });

  await t.test('denies signed-out requests and enforces Origin, JSON and CSRF', async () => {
    assert.deepEqual((await request('/api/session')).data, previewSignedOut);
    assert.equal((await request('/api/todos')).status, 401);
    assert.equal((await create(undefined, aId, 'Signed out')).status, 401);
    assert.equal((await patch(undefined, aId, { action: 'clearReminder', revision: 1 })).status, 401);
    assert.equal((await remove(undefined, aId, 1)).status, 401);
    assert.equal((await post(signoutPath, {})).status, 401);
    for (const origin of [null, otherOrigin, `${appOrigin}.other.test`]) {
      assert.equal((await post(signupPath, alice, { origin })).status, 403);
      assert.equal((await post(signinPath, alice, { origin })).status, 403);
      assert.equal((await post(signoutPath, {}, { account: a, origin })).status, 403);
      assert.equal((await post('/api/todos', { id: aId, text: 'Rejected', tags: [] }, { account: a, origin })).status, 403);
    }
    assert.equal((await post(signinPath, alice, { contentType: 'text/plain' })).status, 400);
    assert.equal((await post('/api/todos', {}, { account: a, contentType: 'text/plain' })).status, 400);
    assert.equal((await post(signoutPath, {}, { account: a, csrf: null })).data.code, 'INVALID_CSRF');
    assert.equal((await post('/api/todos', {}, { account: a, csrf: null })).data.error.code, 'INVALID_CSRF');
    assert.equal((await post('/api/todos', {}, { account: b, csrf: a.csrfToken })).data.error.code, 'INVALID_CSRF');
    const badMethod = await request('/api/todos', { method: 'PUT' });
    assert.equal(badMethod.status, 405);
    assert.equal(badMethod.headers.get('allow'), 'GET, POST, PATCH, DELETE');
  });

  await t.test('serves auth and todo mutations on the exact Preview branch origin', async () => {
    const site = { site: branchOrigin, ip: '192.0.2.2' };
    const user = { name: 'Branch User', email: 'cli-branch@example.test', password };
    const account = await authenticated(await post(signupPath, user, site), user.name, user.email, branchOrigin);
    const todo = { id: randomUUID(), text: 'Branch todo', tags: [] };
    assert.equal((await post('/api/todos', todo, { ...site, account })).status, 201);
    assert.equal((await post('/api/todos', todo, { ...site, account, origin: appOrigin })).status, 403);
    assert.equal((await post('/api/todos', todo, { ...site, account, site: otherOrigin, origin: branchOrigin })).status, 403);
    assert.equal((await post(signoutPath, {}, { ...site, account })).status, 200);
    await authenticated(await post(signinPath, { email: user.email, password }, site), user.name, user.email, branchOrigin);
  });

  await t.test('legacy tag mutations act on stored tags; untouched titles stay verbatim', async () => {
    const user = { name: 'Fold order', email: 'cli-fold@example.test', password };
    const account = await authenticated(await post(signupPath, user, { ip: '192.0.2.71' }), user.name, user.email);
    const { userId } = account;
    const [rm, add, keep] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query(
      `INSERT INTO todos (user_id, id, text, tags, created_at) VALUES
         ($1, $2, 'Remove', '{work}', 1), ($1, $3, 'Add', '{work}', 2), ($1, $4, 'Original task #   ', '{}', 3)`,
      [userId, rm, add, keep],
    );
    const stored = async (id) => (await admin.query(
      'SELECT text, tags FROM todos WHERE user_id = $1 AND id = $2', [userId, id],
    )).rows[0];
    const removed = await patch(account, rm, { action: 'removeTag', revision: 1, tag: 'work' });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.todo.text, 'Remove');
    assert.deepEqual(await stored(rm), { text: 'Remove', tags: [] });
    const added = await patch(account, add, { action: 'addTag', revision: 1, tag: 'home' });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.todo.text, 'Add #work #home');
    assert.deepEqual(await stored(add), { text: 'Add #work #home', tags: [] });

    // A category-only save sends the title as it was; the server stores it unchanged.
    const category = randomUUID();
    await admin.query("INSERT INTO categories (user_id, id, name) VALUES ($1, $2, 'home')", [userId, category]);
    const saved = await patch(account, keep, {
      action: 'edit', revision: 1, text: 'Original task #   ', tags: [], due: null, repeat: 'none', categoryId: category,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.todo.text, 'Original task #   ');
    assert.deepEqual(await stored(keep), { text: 'Original task #   ', tags: [] });
  });

  await t.test('isolates reads, writes, tags and reminders between two users', async () => {
    const left = await create(a, aId, '  Alice todo  ', ['#Work Task', 'work-task', 'home']);
    assert.equal(left.status, 201);
    assert.equal(left.data.todo.text, 'Alice todo #work-task #home');
    assert.deepEqual(left.data.todo.tags, []);
    assert.equal(typeof left.data.todo.createdAt, 'number');
    assert.equal((await create(a, aId, 'Duplicate')).status, 409);
    const due = Date.now() - 10_000;
    const reminder = await patch(a, aId, { action: 'setReminder', revision: 1, due, repeat: 'daily' });
    assert.equal(reminder.status, 200);
    assert.equal(reminder.data.todo.due, due);
    for (const response of [
      await request(`/api/todos?id=${aId}`, { account: b }),
      await patch(b, aId, { action: 'addTag', revision: 2, tag: 'private' }),
      await patch(b, aId, { action: 'markNotified', revision: 2, due }),
      await remove(b, aId, 2),
    ]) {
      assert.equal(response.status, 404);
      assert.equal(response.data.error.code, 'NOT_FOUND');
    }
    assert.deepEqual((await request('/api/todos', { account: b })).data.todos, []);
    assert.equal((await create(b, aId, 'Same ID for Bob', ['shared-id'])).status, 201);
    assert.equal((await create(b, bId, 'Bob only')).status, 201);
    assert.equal((await request(`/api/todos?id=${aId}`, { account: b })).data.todo.text, 'Same ID for Bob #shared-id');
    const ownerList = await request('/api/todos', { account: a });
    assert.deepEqual(ownerList.data.todos, [reminder.data.todo]);
    assert.equal((await remove(b, aId, 1)).status, 204);
    assert.deepEqual((await request('/api/todos', { account: a })).data.todos, [reminder.data.todo]);
  });

  await t.test('guards concurrent edits and reminder claims with revisions', async () => {
    const race = await Promise.all(['one', 'two'].map((tag) => patch(a, aId, { action: 'addTag', revision: 2, tag })));
    assert.deepEqual(race.map(({ status }) => status).sort(), [200, 409]);
    const current = race.find(({ status }) => status === 200).data.todo;
    // A legacy addTag appends to the title; nothing stores tags, so removeTag changes nothing.
    const tag = current.text.split('#').at(-1);
    assert.equal(current.text, `Alice todo #work-task #home #${tag}`);
    assert.equal((await patch(a, aId, { action: 'removeTag', revision: 3, tag })).data.todo.revision, 3);
    const claims = await Promise.all([1, 2].map(() => patch(a, aId, {
      action: 'markNotified', revision: 3, due: current.due,
    })));
    assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(claims.find(({ status }) => status === 200).data.todo.notified, current.due);
    assert.equal((await patch(a, aId, { action: 'markNotified', revision: 4, due: current.due })).status, 409);
    const due = current.due + 86400000;
    assert.equal((await patch(a, aId, {
      action: 'complete', revision: 4, completed: true, due, completedUntil: due + 1,
    })).status, 400);
    const completedUntil = new Date(due).setHours(0, 0, 0, 0);
    const rolled = await patch(a, aId, { action: 'complete', revision: 4, completed: true, due, completedUntil });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.data.todo.completed, true);
    assert.equal(rolled.data.todo.completedUntil, completedUntil);
    assert.equal(rolled.data.todo.due, due);
    assert.equal(rolled.data.todo.notified, null);
    assert.equal(rolled.data.todo.repeat, 'daily');
    assert.equal((await remove(a, aId, 4)).status, 409);
    assert.equal((await patch(a, aId, { action: 'clearReminder', revision: 5 })).data.todo.due, null);
    assert.equal((await patch(a, aId, { action: 'addTag', revision: 6, tag: 'last' })).data.todo.text,
      `Alice todo #work-task #home #${tag} #last`);
    assert.equal((await remove(a, aId, 7)).status, 204);
    assert.equal((await request(`/api/todos?id=${aId}`, { account: a })).status, 404);
  });

  await t.test('validates ownership fields, title length, tag limits and reminder transitions', async () => {
    assert.equal((await post('/api/todos', { id: aId, text: 'Bad owner', tags: [], userId: b.userId }, { account: a })).status, 400);
    assert.equal((await create(a, 'bad-id', 'Invalid ID')).status, 400);
    assert.equal((await create(a, aId, '😀'.repeat(2001))).status, 400);
    assert.equal((await create(a, aId, 'x', [...Array(11)].map((_, i) => `tag${i}`))).status, 400);
    const tenTags = [...Array(10)].map((_, i) => `tag${i}`);
    const valid = await create(a, aId, '😀'.repeat(2000), tenTags);
    assert.equal(valid.status, 201);
    // Legacy tags that would push the title past 2,000 characters are dropped.
    assert.deepEqual([valid.data.todo.text, valid.data.todo.tags], ['😀'.repeat(2000), []]);
    const full = await patch(a, aId, { action: 'addTag', revision: 1, tag: 'overflow' });
    assert.deepEqual([full.status, full.data.todo.text, full.data.todo.revision], [200, '😀'.repeat(2000), 1]);
    assert.equal((await patch(a, aId, { action: 'setReminder', revision: 1, due: 1.2, repeat: 'daily' })).status, 400);
    assert.equal((await patch(a, aId, { action: 'complete', revision: 1, completed: true, due: Date.now() })).status, 400);
    const completed = await patch(a, aId, { action: 'complete', revision: 1, completed: true, due: null });
    assert.equal(completed.data.todo.completed, true);
  });

  await t.test('edits text, tags and reminder in one revisioned PATCH, owner only', async () => {
    const id = randomUUID();
    assert.equal((await create(a, id, 'Before', ['one'])).status, 201);
    const due = Date.now() + 3_600_000;
    const edit = { action: 'edit', revision: 1, text: '  After  ', tags: ['#Two', 'three'], due, repeat: 'weekly' };
    assert.equal((await patch(b, id, edit)).status, 404);
    const edited = await patch(a, id, edit);
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.deepEqual(
      (({ text, tags, due: when, repeat, revision, completed }) => ({ text, tags, when, repeat, revision, completed }))(edited.data.todo),
      { text: 'After #two #three', tags: [], when: due, repeat: 'weekly', revision: 2, completed: false },
    );
    assert.equal((await patch(a, id, edit)).status, 409, 'a stale revision conflicts');
    // Same state again, legacy tags folding back to the same title: no write, the revision stays.
    const same = { ...edit, revision: 2, text: 'After', tags: ['two', 'three'] };
    assert.equal((await patch(a, id, same)).data.todo.revision, 2);
    for (const bad of [{ text: ' ' }, { text: 'x'.repeat(2001) }, { tags: ['##x'] }, { due: null }, { repeat: 'hourly' }, { completed: true }]) {
      assert.equal((await patch(a, id, { ...same, ...bad })).status, 400, JSON.stringify(bad));
    }
    const cleared = await patch(a, id, { ...same, due: null, repeat: 'none' });
    assert.deepEqual([cleared.data.todo.due, cleared.data.todo.repeat, cleared.data.todo.revision], [null, 'none', 3]);
    const stored = await request(`/api/todos?id=${id}`, { account: a });
    assert.deepEqual(stored.data.todo, cleared.data.todo);
    assert.equal((await remove(a, id, 3)).status, 204);
  });

  await t.test('preserves the tick cutoff while repeating and clears it when repetition stops', async () => {
    const id = randomUUID();
    const now = new Date();
    const today = now.setHours(0, 0, 0, 0);
    const completedUntil = now.setHours(24, 0, 0, 0);
    const tomorrowDue = completedUntil + 3_600_000;
    const edit = { action: 'edit', revision: 1, text: 'Edited routine', tags: ['weekly'], due: null, repeat: 'none' };
    assert.equal((await create(a, id, 'Routine')).status, 201);
    assert.equal((await patch(a, id, { ...edit, completedUntil })).status, 400);
    assert.equal((await patch(a, id, { action: 'setReminder', revision: 1, due: today, repeat: 'daily' })).status, 200);
    const ticked = await patch(a, id, { action: 'complete', revision: 2, completed: true, due: tomorrowDue, completedUntil });
    assert.equal(ticked.status, 200);
    assert.equal(ticked.data.todo.completedUntil, completedUntil);

    const due = today + 3_600_000;
    const edited = await patch(a, id, { ...edit, revision: 3, due, repeat: 'weekly' });
    assert.equal(edited.status, 200);
    const expected = { ...ticked.data.todo, text: 'Edited routine #weekly', due, repeat: 'weekly', revision: 4 };
    assert.deepEqual(edited.data.todo, expected);
    assert.deepEqual((await request(`/api/todos?id=${id}`, { account: a })).data.todo, expected);

    const stopped = await patch(a, id, { ...edit, revision: 4, due });
    assert.equal(stopped.status, 200);
    const permanent = { ...expected, repeat: 'none', completed: true, completedUntil: null, revision: 5 };
    assert.deepEqual(stopped.data.todo, permanent);
    assert.deepEqual((await request(`/api/todos?id=${id}`, { account: a })).data.todo, permanent);
  });

  await t.test('persists per-user position, appends new tasks, and rejects stale or invalid moves', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const [first, second, third, appended, foreign] = ids;
    for (const id of [first, second, third]) assert.equal((await create(a, id, `Task ${id}`)).status, 201);
    assert.equal((await create(b, foreign, 'Foreign anchor')).status, 201);
    const list = async () => (await request('/api/todos', { account: a })).data.todos
      .filter(({ id }) => ids.includes(id));
    assert.deepEqual((await list()).map(({ id }) => id), [first, second, third]);
    const move = { action: 'move', revision: 1, anchorId: first, side: 'before' };
    assert.equal((await patch(a, third, { ...move, side: 'around' })).status, 400);
    assert.equal((await patch(a, third, { ...move, revision: 0 })).status, 400);
    assert.equal((await patch(a, third, { ...move, anchorId: foreign })).status, 404);
    assert.equal((await patch(b, third, { ...move, anchorId: foreign })).status, 404);
    const result = await patch(a, third, move);
    assert.equal(result.status, 200);
    assert.equal(result.data.todo.revision, 2);
    assert.equal((await patch(a, third, { ...move, side: 'after' })).status, 409);
    assert.equal((await patch(a, third, { ...move, revision: 2 })).data.todo.revision, 2);
    assert.equal((await create(a, appended, 'Appended after the move')).status, 201);
    const rows = await list();
    assert.deepEqual(rows.map(({ id, revision }) => [id, revision]), [
      [third, 2], [first, 1], [second, 1], [appended, 1],
    ]);
    assert.ok(rows.every(({ position }, i) => typeof position === 'string' &&
      (!i || rows[i - 1].position < position)));

    // A legacy writer can omit position, and imported data can repeat a position.
    const legacy = randomUUID();
    ids.push(legacy);
    await admin.query(
      'INSERT INTO todos (user_id, id, text, created_at) VALUES ($1, $2, $3, $4)',
      [a.userId, legacy, 'Legacy task', rows.at(-1).createdAt + 60_000],
    );
    await admin.query('UPDATE todos SET position = $3, created_at = $4 WHERE user_id = $1 AND id = $2', [
      a.userId, second, rows[1].position, rows[1].createdAt,
    ]);
    const withFallbacks = await list();
    assert.deepEqual(withFallbacks.map(({ id }) => id), [third, ...[first, second].sort(), appended, legacy]);
    assert.equal(typeof withFallbacks.at(-1).position, 'string');
    assert.equal((await remove(b, foreign, 1)).status, 204);
    for (const { id, revision } of withFallbacks) assert.equal((await remove(a, id, revision)).status, 204);
  });

  await t.test('revokes sign-out sessions and rejects stale and expired sessions', async () => {
    const signedOut = await post(signoutPath, {}, { account: a });
    assert.equal(signedOut.status, 200);
    assert.ok(signedOut.headers.getSetCookie().some((item) => /session_token=;.*Max-Age=0/i.test(item)));
    assert.equal((await admin.query('SELECT 1 FROM "session" WHERE token = $1', [a.token])).rowCount, 0);
    assert.equal((await request('/api/todos', { account: a })).status, 401);
    const renewed = await authenticated(await post(signinPath, { email: alice.email, password }), alice.name, alice.email);
    assert.notEqual(a.csrfToken, renewed.csrfToken);
    assert.equal((await post('/api/todos', {}, { account: renewed, csrf: a.csrfToken })).data.error.code, 'INVALID_CSRF');
    // A read that carries a token is bound to it: a tab left on the old session can't load the
    // list of whoever is signed in now. Reads without the header still work.
    const staleRead = await request('/api/todos', { account: renewed, csrf: a.csrfToken });
    assert.equal(staleRead.status, 403);
    assert.equal(staleRead.data.error.code, 'INVALID_CSRF');
    assert.equal((await request(`/api/todos?id=${aId}`, { account: renewed, csrf: b.csrfToken })).status, 403);
    assert.equal((await request('/api/todos', { account: renewed, csrf: 'x'.repeat(43) })).status, 403);
    assert.equal((await request('/api/todos', { account: renewed })).status, 200);
    assert.equal((await request('/api/todos', { account: renewed, csrf: null })).status, 200);
    await admin.query('UPDATE "session" SET "expiresAt" = now() - interval \'1 second\' WHERE token = $1', [b.token]);
    assert.deepEqual((await request('/api/session', { account: b })).data, previewSignedOut);
    assert.equal((await request('/api/todos', { account: b })).status, 401);
  });

  await t.test('persists Better Auth rate limits and returns its 429 response', async () => {
    const attempt = () => post(signinPath, { email: alice.email, password: 'incorrect password' });
    assert.equal((await attempt()).status, 401);
    let throttled;
    for (let i = 0; i < 4; i++) {
      const result = await attempt();
      if (result.status === 429) {
        throttled = result;
        break;
      }
      assert.equal(result.status, 401);
    }
    assert.ok(throttled);
    assert.ok(throttled.headers.get('x-retry-after'));
    assert.match(throttled.data.message, /Too many requests/i);
    const limited = await admin.query('SELECT 1 FROM "rateLimit" WHERE count >= 3');
    assert.ok(limited.rowCount > 0);
  });

  await t.test('returns 503 naming missing migrations, and recovers once applied', async () => {
    // Earlier subtests may have signed `a` out, so use a fresh sign-in.
    const fresh = await authenticated(await post(signinPath, alice, { ip: '192.0.2.99' }), alice.name, alice.email);
    const [{ filename }] = (await admin.query(
      'DELETE FROM schema_migrations WHERE filename = (SELECT max(filename) FROM schema_migrations) RETURNING filename',
    )).rows;
    resetSchemaGuard();
    for (const path of ['/api/todos', '/api/session']) {
      const response = await request(path, { account: fresh });
      assert.equal(response.status, 503);
      assert.equal(response.data.error.code, 'SCHEMA_OUT_OF_DATE');
      assert.ok(response.data.error.message.includes(filename));
    }
    await admin.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    assert.equal((await request('/api/todos', { account: fresh })).status, 200);
    // Verified once: later requests do not query the ledger again.
    await admin.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
    assert.equal((await request('/api/todos', { account: fresh })).status, 200);
    await admin.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
  });
});
