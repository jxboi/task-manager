import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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

const testUrl = process.env.TEST_DATABASE_URL;
const appOrigin = 'https://task-manager.test';
const branchOrigin = 'https://task-manager-git-feature.test';
const otherOrigin = 'https://other.test';
const password = 'A disposable test password';
const handlers = {
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
} = {}) {
  const headers = new Headers({ 'x-vercel-forwarded-for': ip });
  if (origin) headers.set('Origin', origin);
  if (account) headers.set('Cookie', account.cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (method !== 'GET' && contentType) headers.set('Content-Type', contentType);
  const response = await handlers[pathname].fetch(new Request(new URL(path, site), {
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
  return { cookie, csrfToken: active.data.csrfToken, token: response.data.token, userId: response.data.user.id };
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
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./migrate.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL_UNPOOLED: database.href },
  });
  delete process.env.BETTER_AUTH_URL;
  process.env.VERCEL_URL = new URL(appOrigin).host;
  process.env.VERCEL_BRANCH_URL = new URL(branchOrigin).host;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.VERCEL_ENV = 'preview';
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = database.href;
  services = getServices();

  const signupPath = '/api/auth/sign-up/email';
  const signinPath = '/api/auth/sign-in/email';
  const signoutPath = '/api/auth/sign-out';
  const alice = { name: 'Alice', email: 'alice@example.test', password };
  const bob = { name: 'Bob', email: 'bob@example.test', password };
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

  await t.test('denies signed-out requests and enforces Origin, JSON and CSRF', async () => {
    assert.deepEqual((await request('/api/session')).data, { user: null, csrfToken: null });
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
    const user = { name: 'Branch User', email: 'branch@example.test', password };
    const account = await authenticated(await post(signupPath, user, site), user.name, user.email, branchOrigin);
    const todo = { id: randomUUID(), text: 'Branch todo', tags: [] };
    assert.equal((await post('/api/todos', todo, { ...site, account })).status, 201);
    assert.equal((await post('/api/todos', todo, { ...site, account, origin: appOrigin })).status, 403);
    assert.equal((await post('/api/todos', todo, { ...site, account, site: otherOrigin, origin: branchOrigin })).status, 403);
    assert.equal((await post(signoutPath, {}, { ...site, account })).status, 200);
    await authenticated(await post(signinPath, { email: user.email, password }, site), user.name, user.email, branchOrigin);
  });

  await t.test('isolates reads, writes, tags and reminders between two users', async () => {
    const left = await create(a, aId, '  Alice todo  ', ['#Work Task', 'work-task', 'home']);
    assert.equal(left.status, 201);
    assert.equal(left.data.todo.text, 'Alice todo');
    assert.deepEqual(left.data.todo.tags, ['work-task', 'home']);
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
    assert.equal((await request(`/api/todos?id=${aId}`, { account: b })).data.todo.text, 'Same ID for Bob');
    const ownerList = await request('/api/todos', { account: a });
    assert.deepEqual(ownerList.data.todos, [reminder.data.todo]);
    assert.equal((await remove(b, aId, 1)).status, 204);
    assert.deepEqual((await request('/api/todos', { account: a })).data.todos, [reminder.data.todo]);
  });

  await t.test('guards concurrent edits and reminder claims with revisions', async () => {
    const race = await Promise.all(['one', 'two'].map((tag) => patch(a, aId, { action: 'addTag', revision: 2, tag })));
    assert.deepEqual(race.map(({ status }) => status).sort(), [200, 409]);
    const current = race.find(({ status }) => status === 200).data.todo;
    const tag = current.tags.at(-1);
    assert.equal((await patch(a, aId, { action: 'addTag', revision: 3, tag })).data.todo.revision, 3);
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
    assert.equal((await patch(a, aId, { action: 'removeTag', revision: 6, tag })).data.todo.tags.includes(tag), false);
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
    assert.equal((await patch(a, aId, { action: 'addTag', revision: 1, tag: 'overflow' })).status, 400);
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
      { text: 'After', tags: ['two', 'three'], when: due, repeat: 'weekly', revision: 2, completed: false },
    );
    assert.equal((await patch(a, id, edit)).status, 409, 'a stale revision conflicts');
    // Same state again: no write, the revision stays.
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
    assert.deepEqual((await request('/api/session', { account: b })).data, { user: null, csrfToken: null });
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
});
