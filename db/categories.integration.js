import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import categories from '../api/categories.js';
import session from '../api/session.js';
import signUp from '../api/auth/sign-up/email.js';
import todos from '../api/todos.js';
import { getServices } from '../server/auth.js';
import { runMigrations } from './runner.js';
import { resetSchemaGuard } from '../server/schema-guard.js';

const testUrl = process.env.TEST_DATABASE_URL;
const appOrigin = 'https://task-manager.test';
const otherOrigin = 'https://other.test';
const password = 'A disposable test password';
const handlers = {
  '/api/auth/sign-up/email': signUp,
  '/api/categories': categories,
  '/api/session': session,
  '/api/todos': todos,
};

async function request(path, {
  method = 'GET', account, origin = appOrigin, csrf = account?.csrfToken, ip = '192.0.2.1',
  body, contentType = 'application/json',
} = {}) {
  const headers = new Headers({ 'x-vercel-forwarded-for': ip });
  if (origin) headers.set('Origin', origin);
  if (account) headers.set('Cookie', account.cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (method !== 'GET' && contentType) headers.set('Content-Type', contentType);
  const url = new URL(path, appOrigin);
  const response = await handlers[url.pathname].fetch(new Request(url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, headers: response.headers, data: await response.json() };
}

const create = (account, id, name, options) => request('/api/categories', {
  method: 'POST', account, body: { id, name }, ...options,
});
const rename = (account, id, body, options) => request(`/api/categories?id=${id}`, {
  method: 'PATCH', account, body, ...options,
});
const remove = (account, id, revision, options) => request(`/api/categories?id=${id}&revision=${revision}`, {
  method: 'DELETE', account, ...options,
});

function expectError(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(response.data.error.code, code);
  assert.equal(typeof response.data.error.message, 'string');
}

let signups = 0;
async function signUpAccount(label) {
  const email = `cli-categories-${label}@example.test`;
  const response = await request('/api/auth/sign-up/email', {
    method: 'POST', body: { name: label, email, password }, ip: `192.0.2.${100 + signups++}`,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const cookie = response.headers.getSetCookie()
    .find((item) => item.startsWith('__Secure-better-auth.session_token=')).split(';')[0];
  const active = await request('/api/session', { account: { cookie } });
  assert.equal(active.status, 200);
  return { cookie, csrfToken: active.data.csrfToken, userId: response.data.user.id };
}

test('categories API against PostgreSQL', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  const schema = `task_manager_categories_${randomBytes(8).toString('hex')}`;
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
  delete process.env.VERCEL_BRANCH_URL;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.VERCEL_ENV = 'preview';
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = database.href;
  services = getServices();

  await t.test('returns 503 before migration 0005 is applied', async () => {
    await runMigrations({ connectionString: database.href, log: () => {} });
    await admin.query("DELETE FROM schema_migrations WHERE filename = '0005_categories.sql'");
    resetSchemaGuard();
    expectError(await create(undefined, randomUUID(), 'Work'), 503, 'SCHEMA_OUT_OF_DATE');
    await admin.query("INSERT INTO schema_migrations (filename) VALUES ('0005_categories.sql')");
    resetSchemaGuard();
  });

  const a = await signUpAccount('alice');
  const b = await signUpAccount('bob');
  const stored = async (userId) => (await admin.query(
    'SELECT id, name, revision FROM categories WHERE user_id = $1 ORDER BY lower(name), id', [userId],
  )).rows;

  await t.test('creates, renames and deletes a category', async () => {
    const id = randomUUID();
    const created = await create(a, id.toUpperCase(), '  Work Stuff ');
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data, { category: { id, name: 'Work Stuff', revision: 1 } });

    const renamed = await rename(a, id, { name: 'Office', revision: 1 });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data, { category: { id, name: 'Office', revision: 2 } });

    const caseOnly = await rename(a, id, { name: 'OFFICE', revision: 2 });
    assert.deepEqual(caseOnly.data, { category: { id, name: 'OFFICE', revision: 3 } });

    // Same trimmed name: no-op, but only after the revision check.
    const same = await rename(a, id, { name: ' OFFICE ', revision: 3 });
    assert.deepEqual(same.data, { category: { id, name: 'OFFICE', revision: 3 } });
    expectError(await rename(a, id, { name: 'OFFICE', revision: 2 }), 409, 'REVISION_CONFLICT');

    const deleted = await remove(a, id, 3);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { todos: [] });
    assert.deepEqual(await stored(a.userId), []);
    expectError(await remove(a, id, 3), 404, 'NOT_FOUND');
    expectError(await rename(a, id, { name: 'Again', revision: 3 }), 404, 'NOT_FOUND');
  });

  await t.test('denies signed-out requests and enforces Origin, JSON and CSRF', async () => {
    const id = randomUUID();
    expectError(await create(undefined, id, 'Work'), 401, 'UNAUTHENTICATED');
    expectError(await rename(undefined, id, { name: 'Work', revision: 1 }), 401, 'UNAUTHENTICATED');
    expectError(await remove(undefined, id, 1), 401, 'UNAUTHENTICATED');
    for (const origin of [null, otherOrigin, `${appOrigin}.other.test`]) {
      expectError(await create(a, id, 'Work', { origin }), 403, 'INVALID_ORIGIN');
      expectError(await rename(a, id, { name: 'Work', revision: 1 }, { origin }), 403, 'INVALID_ORIGIN');
      expectError(await remove(a, id, 1, { origin }), 403, 'INVALID_ORIGIN');
    }
    expectError(await create(a, id, 'Work', { csrf: null }), 403, 'INVALID_CSRF');
    expectError(await create(a, id, 'Work', { csrf: b.csrfToken }), 403, 'INVALID_CSRF');
    expectError(await remove(a, id, 1, { csrf: 'forged' }), 403, 'INVALID_CSRF');
    expectError(await create(a, id, 'Work', { contentType: 'text/plain' }), 400, 'INVALID_INPUT');
    const badMethod = await request('/api/categories', { method: 'GET', account: a });
    assert.equal(badMethod.status, 405);
    assert.equal(badMethod.headers.get('allow'), 'POST, PATCH, DELETE');
    assert.deepEqual(await stored(a.userId), []);
  });

  await t.test('rejects unknown fields, malformed IDs, revisions and names', async () => {
    const id = randomUUID();
    const bad = [
      await request('/api/categories', { method: 'POST', account: a, body: { id, name: 'X', userId: b.userId } }),
      await request('/api/categories', { method: 'POST', account: a, body: { id, name: 'X', user_id: b.userId } }),
      await request('/api/categories', { method: 'POST', account: a, body: [] }),
      await create(a, 'not-a-uuid', 'Work'),
      await create(a, id, ''),
      await create(a, id, '   '),
      await create(a, id, 'x'.repeat(49)),
      await create(a, id, 'bad\0name'),
      await create(a, id, 'bad\u0007name'),
      await create(a, id, 7),
    ];
    for (const response of bad) expectError(response, 400, 'INVALID_INPUT');
    assert.equal((await create(a, id, 'é'.repeat(48))).status, 201);
    for (const body of [
      { name: 'Y', revision: 1, userId: b.userId }, { name: 'Y', revision: 0 }, { name: 'Y', revision: 1.5 },
      { name: 'Y', revision: '1' }, { name: 'Y', revision: 2147483648 }, { name: '', revision: 1 }, { revision: 1 },
    ]) expectError(await rename(a, id, body), 400, 'INVALID_INPUT');
    expectError(await rename(a, 'nope', { name: 'Y', revision: 1 }), 400, 'INVALID_INPUT');
    for (const revision of ['', '0', '-1', '1.5', 'abc', '2147483648']) {
      expectError(await remove(a, id, revision), 400, 'INVALID_INPUT');
    }
    expectError(await request('/api/categories?revision=1', { method: 'DELETE', account: a }), 400, 'INVALID_INPUT');
    assert.deepEqual(await stored(a.userId), [{ id, name: 'é'.repeat(48), revision: 1 }]);
    assert.equal((await remove(a, id, 1)).status, 200);
  });

  await t.test('isolates categories between two accounts', async () => {
    const aId = randomUUID();
    const bId = randomUUID();
    assert.equal((await create(a, aId, 'Shared')).status, 201);
    assert.equal((await create(b, bId, 'shared')).status, 201, 'the same name across users is allowed');
    expectError(await rename(b, aId, { name: 'Stolen', revision: 1 }), 404, 'NOT_FOUND');
    expectError(await remove(b, aId, 1), 404, 'NOT_FOUND');
    const missing = await remove(b, randomUUID(), 1);
    expectError(missing, 404, 'NOT_FOUND');
    assert.deepEqual((await remove(b, aId, 1)).data, missing.data, 'foreign and missing look the same');
    // B reusing A's UUID is B's own new row, not a reveal of A's.
    expectError(await create(b, bId, 'Other'), 409, 'DUPLICATE_ID');
    assert.equal((await create(b, aId, 'Mine')).status, 201);
    assert.deepEqual(await stored(a.userId), [{ id: aId, name: 'Shared', revision: 1 }]);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
  });

  await t.test('rejects case-insensitive duplicate names, races included', async () => {
    const id = randomUUID();
    const other = randomUUID();
    assert.equal((await create(a, id, 'Home')).status, 201);
    expectError(await create(a, randomUUID(), ' hOME '), 409, 'DUPLICATE_NAME');
    assert.equal((await create(a, other, 'Garden')).status, 201);
    expectError(await rename(a, other, { name: 'HOME', revision: 1 }), 409, 'DUPLICATE_NAME');
    expectError(await create(a, id, 'Fresh'), 409, 'DUPLICATE_ID');

    const racing = await Promise.all(Array.from({ length: 5 }, () => create(a, randomUUID(), 'Errands')));
    assert.equal(racing.filter((response) => response.status === 201).length, 1);
    for (const response of racing.filter((item) => item.status !== 201)) expectError(response, 409, 'DUPLICATE_NAME');
    assert.deepEqual((await stored(a.userId)).map((row) => row.name), ['Errands', 'Garden', 'Home']);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  await t.test('caps an account at 50 categories, checking reused UUIDs first', async () => {
    const ids = Array.from({ length: 50 }, () => randomUUID());
    for (const [index, id] of ids.slice(0, 49).entries()) {
      assert.equal((await create(a, id, `C${index}`)).status, 201);
    }
    assert.equal((await create(a, ids[49], 'Fiftieth')).status, 201);
    expectError(await create(a, randomUUID(), 'Fifty-first'), 409, 'CATEGORY_LIMIT');
    expectError(await create(a, ids[0], 'Reused'), 409, 'DUPLICATE_ID');
    assert.equal((await stored(a.userId)).length, 50);

    // Deleting one frees a slot.
    assert.equal((await remove(a, ids[0], 1)).status, 200);
    assert.equal((await create(a, randomUUID(), 'Replacement')).status, 201);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  await t.test('rejects creates once an account already holds more than 50', async () => {
    await admin.query(
      `INSERT INTO categories (user_id, id, name)
       SELECT $1, gen_random_uuid(), 'Seeded ' || n FROM generate_series(1, 55) AS n`, [b.userId],
    );
    expectError(await create(b, randomUUID(), 'One more'), 409, 'CATEGORY_LIMIT');
    assert.equal((await stored(b.userId)).length, 55);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [b.userId]);
  });

  await t.test('concurrent creates near the cap never exceed it', async () => {
    await admin.query(
      `INSERT INTO categories (user_id, id, name)
       SELECT $1, gen_random_uuid(), 'Seeded ' || n FROM generate_series(1, 47) AS n`, [a.userId],
    );
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => create(a, randomUUID(), `Racer ${n}`)));
    assert.equal(results.filter((response) => response.status === 201).length, 3);
    for (const response of results.filter((item) => item.status !== 201)) expectError(response, 409, 'CATEGORY_LIMIT');
    assert.equal((await stored(a.userId)).length, 50);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  await t.test('rejects stale renames and deletes', async () => {
    const id = randomUUID();
    assert.equal((await create(a, id, 'Draft')).status, 201);
    assert.equal((await rename(a, id, { name: 'Draft 2', revision: 1 })).status, 200);
    expectError(await rename(a, id, { name: 'Draft 3', revision: 1 }), 409, 'REVISION_CONFLICT');
    expectError(await remove(a, id, 1), 409, 'REVISION_CONFLICT');
    expectError(await rename(a, id, { name: 'Draft 2', revision: 3 }), 409, 'REVISION_CONFLICT');
    assert.deepEqual(await stored(a.userId), [{ id, name: 'Draft 2', revision: 2 }]);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  await t.test('delete unlinks exactly its own todos and bumps their revisions', async () => {
    const work = randomUUID();
    const home = randomUUID();
    const bWork = randomUUID();
    const [linked1, linked2, onHome, loose, bLinked] = Array.from({ length: 5 }, () => randomUUID());
    assert.equal((await create(a, work, 'Work')).status, 201);
    assert.equal((await create(a, home, 'Home')).status, 201);
    assert.equal((await create(b, bWork, 'Work')).status, 201);
    for (const [account, id, text] of [[a, linked1, 'One'], [a, linked2, 'Two'], [a, onHome, 'Home task'],
      [a, loose, 'Loose'], [b, bLinked, 'Bob task']]) {
      const response = await request('/api/todos', { method: 'POST', account, body: { id, text, tags: ['t'] } });
      assert.equal(response.status, 201);
    }
    await admin.query(
      `UPDATE todos SET category_id = CASE id WHEN $2 THEN $4::uuid WHEN $3 THEN $4::uuid ELSE $6::uuid END
       WHERE user_id = $1 AND id IN ($2, $3, $5)`,
      [a.userId, linked1, linked2, work, onHome, home],
    );
    await admin.query('UPDATE todos SET category_id = $3 WHERE user_id = $1 AND id = $2', [b.userId, bLinked, bWork]);
    // Give one linked todo a higher revision so the bump is visible as +1, not a reset.
    await admin.query('UPDATE todos SET revision = 4 WHERE user_id = $1 AND id = $2', [a.userId, linked2]);
    const snapshot = async (account) => (await request('/api/todos', { account })).data.todos;
    const before = await snapshot(a);
    const bBefore = await snapshot(b);
    const links = async () => (await admin.query(
      'SELECT user_id, id, category_id FROM todos ORDER BY user_id, id',
    )).rows;
    const linksBefore = await links();

    const deleted = await remove(a, work, 1);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const byId = (list) => Object.fromEntries(list.map((todo) => [todo.id, todo]));
    const returned = byId(deleted.data.todos);
    assert.deepEqual(Object.keys(returned).sort(), [linked1, linked2].sort());
    const after = byId(await snapshot(a));
    for (const id of [linked1, linked2]) {
      const old = before.find((todo) => todo.id === id);
      assert.deepEqual(returned[id], { ...old, revision: old.revision + 1 });
      assert.deepEqual(returned[id], after[id], 'returned todos match the todo API shape');
    }
    assert.deepEqual(after[onHome], before.find((todo) => todo.id === onHome));
    assert.deepEqual(after[loose], before.find((todo) => todo.id === loose));
    assert.deepEqual(await snapshot(b), bBefore);
    assert.deepEqual(await links(), linksBefore.map((row) => (
      row.user_id === a.userId && [linked1, linked2].includes(row.id) ? { ...row, category_id: null } : row
    )));
    assert.deepEqual((await stored(a.userId)).map((row) => row.id), [home]);
    assert.deepEqual((await stored(b.userId)).map((row) => row.id), [bWork]);
  });
});
