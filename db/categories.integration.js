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
const addTodo = (account, id, text = 'Task') => request('/api/todos', {
  method: 'POST', account, body: { id, text, tags: [] },
});
const patchTodo = (account, id, body) => request(`/api/todos?id=${id}`, { method: 'PATCH', account, body });
const readTodo = async (account, id) => (await request(`/api/todos?id=${id}`, { account })).data.todo;
const editOf = (todo, changes) => ({
  action: 'edit', revision: todo.revision, text: todo.text, tags: todo.tags, due: todo.due, repeat: todo.repeat,
  ...changes,
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

  await t.test('the cap counts per account: Alice at 50 does not block Bob', async () => {
    await admin.query(
      `INSERT INTO categories (user_id, id, name)
       SELECT $1, gen_random_uuid(), 'Seeded ' || n FROM generate_series(1, 50) AS n`, [a.userId],
    );
    expectError(await create(a, randomUUID(), 'Alice over'), 409, 'CATEGORY_LIMIT');
    assert.equal((await create(b, randomUUID(), 'Bob fine')).status, 201);
    assert.equal((await stored(a.userId)).length, 50);
    assert.equal((await stored(b.userId)).length, 1);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
  });

  await t.test('rename and delete only touch the caller\'s row when two accounts share a UUID and revision', async () => {
    const id = randomUUID();
    assert.equal((await create(a, id, 'Alice name')).status, 201);
    assert.equal((await create(b, id, 'Bob name')).status, 201);
    assert.equal((await rename(b, id, { name: 'Bob renamed', revision: 1 })).status, 200);
    assert.deepEqual(await stored(a.userId), [{ id, name: 'Alice name', revision: 1 }]);
    assert.deepEqual(await stored(b.userId), [{ id, name: 'Bob renamed', revision: 2 }]);

    assert.equal((await rename(a, id, { name: 'Alice renamed', revision: 1 })).status, 200);
    assert.equal((await rename(b, id, { name: 'Bob again', revision: 2 })).status, 200);
    assert.equal((await remove(b, id, 3)).status, 200);
    assert.deepEqual(await stored(a.userId), [{ id, name: 'Alice renamed', revision: 2 }]);
    assert.deepEqual(await stored(b.userId), []);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
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
    const [linked1, linked2, onHome, loose, bLinked] = Array.from({ length: 5 }, () => randomUUID());
    assert.equal((await create(a, work, 'Work')).status, 201);
    assert.equal((await create(a, home, 'Home')).status, 201);
    // Bob's category deliberately shares Alice's UUID (the primary key is per user).
    assert.equal((await create(b, work, 'Work')).status, 201);
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
    await admin.query('UPDATE todos SET category_id = $3 WHERE user_id = $1 AND id = $2', [b.userId, bLinked, work]);
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
      assert.equal(old.categoryId, work);
      assert.deepEqual(returned[id], { ...old, categoryId: null, revision: old.revision + 1 });
      assert.deepEqual(returned[id], after[id], 'returned todos match the todo API shape');
    }
    assert.equal(after[onHome].categoryId, home);
    assert.deepEqual(after[onHome], before.find((todo) => todo.id === onHome));
    assert.deepEqual(after[loose], before.find((todo) => todo.id === loose));
    assert.deepEqual(await snapshot(b), bBefore);
    assert.deepEqual((await snapshot(b)).map(({ id, categoryId, revision }) => ({ id, categoryId, revision })),
      [{ id: bLinked, categoryId: work, revision: 1 }], "Bob's link and revision are intact");
    assert.deepEqual(await links(), linksBefore.map((row) => (
      row.user_id === a.userId && [linked1, linked2].includes(row.id) ? { ...row, category_id: null } : row
    )));
    assert.deepEqual((await stored(a.userId)).map((row) => row.id), [home]);
    assert.deepEqual((await stored(b.userId)).map((row) => row.id), [work]);
    await admin.query('DELETE FROM todos WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
  });

  const link = async (userId, id) => (await admin.query(
    'SELECT category_id, revision FROM todos WHERE user_id = $1 AND id = $2', [userId, id],
  )).rows[0];

  await t.test('the snapshot lists only the caller\'s categories, sorted, with each todo\'s categoryId', async () => {
    const [beta, alpha, gamma, bobs] = Array.from({ length: 4 }, () => randomUUID());
    for (const [account, id, name] of [[a, beta, 'beta'], [a, alpha, 'Alpha'], [a, gamma, 'gamma'], [b, bobs, 'Bob only']]) {
      assert.equal((await create(account, id, name)).status, 201);
    }
    const [first, second] = [randomUUID(), randomUUID()];
    const created = await addTodo(a, first, 'First');
    assert.equal(created.status, 201);
    assert.equal(created.data.todo.categoryId, null, 'new todos start uncategorized');
    assert.equal((await addTodo(a, second, 'Second')).status, 201);
    const assigned = await patchTodo(a, second, editOf(await readTodo(a, second), { categoryId: gamma }));
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

    const list = await request('/api/todos', { account: a });
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.data).sort(), ['categories', 'todos']);
    assert.deepEqual(list.data.categories, [
      { id: alpha, name: 'Alpha', revision: 1 }, { id: beta, name: 'beta', revision: 1 },
      { id: gamma, name: 'gamma', revision: 1 },
    ]);
    assert.deepEqual(list.data.todos.map(({ id, categoryId }) => [id, categoryId]), [[first, null], [second, gamma]]);
    assert.deepEqual(list.data.todos[1], assigned.data.todo);
    const bobList = await request('/api/todos', { account: b });
    assert.deepEqual(bobList.data, { todos: [], categories: [{ id: bobs, name: 'Bob only', revision: 1 }] });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
  });

  await t.test('edit assigns, reassigns and clears a category, checking revision and ownership', async () => {
    const [work, home, bobs] = [randomUUID(), randomUUID(), randomUUID()];
    assert.equal((await create(a, work, 'Work')).status, 201);
    assert.equal((await create(a, home, 'Home')).status, 201);
    assert.equal((await create(b, bobs, 'Bob')).status, 201);
    const id = randomUUID();
    let todo = (await addTodo(a, id, 'Plan')).data.todo;
    const step = async (changes, categoryId) => {
      const response = await patchTodo(a, id, editOf(todo, changes));
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.deepEqual(response.data.todo, { ...todo, ...changes, categoryId, revision: todo.revision + 1 });
      assert.deepEqual(await readTodo(a, id), response.data.todo);
      assert.deepEqual(await link(a.userId, id), { category_id: categoryId, revision: todo.revision + 1 });
      todo = response.data.todo;
    };
    await step({ categoryId: work.toUpperCase() }, work);
    await step({ categoryId: home }, home);
    // An old client's edit (no categoryId) keeps the link; its tags join the title.
    const legacy = await patchTodo(a, id, editOf(todo, { text: 'Plan the week', tags: ['ops'] }));
    assert.deepEqual(legacy.data.todo, { ...todo, text: 'Plan the week #ops', revision: todo.revision + 1 });
    todo = legacy.data.todo;
    await step({ categoryId: null }, null);
    await step({ categoryId: work }, work);

    // Same category, same fields: a no-op that still checks the revision.
    assert.deepEqual((await patchTodo(a, id, editOf(todo, { categoryId: work }))).data.todo, todo);
    expectError(await patchTodo(a, id, editOf(todo, { categoryId: home, revision: todo.revision - 1 })), 409, 'REVISION_CONFLICT');
    expectError(await patchTodo(a, id, editOf(todo, { categoryId: work, revision: todo.revision - 1 })), 409, 'REVISION_CONFLICT');
    expectError(await patchTodo(a, id, editOf(todo, { categoryId: null, revision: todo.revision + 1 })), 409, 'REVISION_CONFLICT');

    const foreign = await patchTodo(a, id, editOf(todo, { categoryId: bobs }));
    expectError(foreign, 404, 'CATEGORY_NOT_FOUND');
    const missing = await patchTodo(a, id, editOf(todo, { categoryId: randomUUID() }));
    assert.deepEqual(missing.data, foreign.data, 'foreign and missing categories look the same');
    expectError(await patchTodo(b, id, editOf(todo, { categoryId: bobs })), 404, 'NOT_FOUND');
    assert.equal((await remove(a, home, 1)).status, 200);
    expectError(await patchTodo(a, id, editOf(todo, { categoryId: home })), 404, 'CATEGORY_NOT_FOUND');
    for (const categoryId of ['', 'work', 7, true, {}, [work], `${work}0`]) {
      expectError(await patchTodo(a, id, editOf(todo, { categoryId })), 400, 'INVALID_INPUT');
    }
    assert.deepEqual(await readTodo(a, id), todo);
    assert.deepEqual(await link(a.userId, id), { category_id: work, revision: todo.revision });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
    await admin.query('DELETE FROM categories WHERE user_id = ANY($1)', [[a.userId, b.userId]]);
  });

  await t.test('other actions keep the link and reject categoryId', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const [id, anchor] = [randomUUID(), randomUUID()];
    assert.equal((await addTodo(a, anchor, 'Anchor')).status, 201);
    let todo = (await addTodo(a, id, 'Linked')).data.todo;
    todo = (await patchTodo(a, id, editOf(todo, { categoryId: work }))).data.todo;
    const due = Date.now() - 10_000;
    // No todo stores tags, so a legacy removeTag is a no-op (bump 0).
    for (const { bump = 1, ...body } of [
      { action: 'setReminder', due, repeat: 'none' },
      { action: 'markNotified', due },
      { action: 'complete', completed: true, due },
      { action: 'move', anchorId: anchor, side: 'before' },
      { action: 'addTag', tag: 'x' },
      { action: 'removeTag', tag: 'x', bump: 0 },
      { action: 'clearReminder' },
    ]) {
      for (const categoryId of [null, work]) {
        expectError(await patchTodo(a, id, { ...body, revision: todo.revision, categoryId }), 400, 'INVALID_INPUT');
      }
      const response = await patchTodo(a, id, { ...body, revision: todo.revision });
      assert.equal(response.status, 200, `${body.action}: ${JSON.stringify(response.data)}`);
      assert.equal(response.data.todo.revision, todo.revision + bump, body.action);
      assert.equal(response.data.todo.categoryId, work, body.action);
      todo = response.data.todo;
    }
    assert.equal(todo.completed, true);
    assert.deepEqual(await link(a.userId, id), { category_id: work, revision: todo.revision });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  // Holds a todo row lock in its own transaction so the two API calls interleave in a known order.
  async function interleave(lockedTodo, firstCall, secondCall) {
    const blocker = new pg.Client({ connectionString: database.href });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM todos WHERE user_id = $1 AND id = $2 FOR UPDATE', [a.userId, lockedTodo]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      // Depth of the wait chain rooted at the blocker: 1 when the first call waits on it, 2 when
      // the second call waits on the first.
      const depth = async () => (await admin.query(
        `WITH RECURSIVE chain(pid, depth) AS (
           SELECT $1::int, 0
           UNION SELECT activity.pid, chain.depth + 1 FROM pg_stat_activity activity
             JOIN chain ON chain.pid = ANY(pg_blocking_pids(activity.pid)))
         SELECT max(depth) AS depth FROM chain`, [pid],
      )).rows[0].depth;
      const waitFor = async (target) => {
        for (let tries = 0; await depth() < target; tries++) {
          assert.ok(tries < 500, `wait chain never reached depth ${target}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const first = firstCall();
      await waitFor(1);
      const second = secondCall();
      await waitFor(2);
      await blocker.query('COMMIT');
      return await Promise.all([first, second]);
    } finally {
      await blocker.end();
    }
  }

  await t.test('assign racing a category delete, assign first, ends unlinked', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const id = randomUUID();
    const todo = (await addTodo(a, id, 'Racer')).data.todo;
    const [assigned, deleted] = await interleave(
      id,
      () => patchTodo(a, id, editOf(todo, { categoryId: work })),
      () => remove(a, work, 1),
    );
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
    assert.equal(assigned.data.todo.categoryId, work);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const unlinked = { ...assigned.data.todo, categoryId: null, revision: todo.revision + 2 };
    assert.deepEqual(deleted.data.todos, [unlinked]);
    assert.deepEqual((await request('/api/todos', { account: a })).data, { todos: [unlinked], categories: [] });
    assert.deepEqual(await link(a.userId, id), { category_id: null, revision: todo.revision + 2 });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });

  await t.test('assign racing a category delete, delete first, gets 404 and changes nothing', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const [id, other] = [randomUUID(), randomUUID()];
    const todo = (await addTodo(a, id, 'Racer')).data.todo;
    let linked = (await addTodo(a, other, 'Already linked')).data.todo;
    linked = (await patchTodo(a, other, editOf(linked, { categoryId: work }))).data.todo;
    // The delete waits on `other`'s row lock while holding the category; the assign then waits on it.
    const [deleted, assigned] = await interleave(
      other,
      () => remove(a, work, 1),
      () => patchTodo(a, id, editOf(todo, { text: 'Renamed', categoryId: work })),
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const unlinked = { ...linked, categoryId: null, revision: linked.revision + 1 };
    assert.deepEqual(deleted.data.todos, [unlinked]);
    expectError(assigned, 404, 'CATEGORY_NOT_FOUND');
    assert.deepEqual((await request('/api/todos', { account: a })).data, { todos: [todo, unlinked], categories: [] });
    assert.deepEqual(await link(a.userId, id), { category_id: null, revision: todo.revision });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });

  await t.test('a malformed edit gets 400 whether or not its category exists', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const id = randomUUID();
    const todo = (await addTodo(a, id, 'Plan')).data.todo;
    for (const categoryId of [work, randomUUID()]) {
      for (const bad of [{ userId: b.userId }, { text: '' }, { tags: 'x' }, { repeat: 'daily' }]) {
        expectError(await patchTodo(a, id, editOf(todo, { categoryId, ...bad })), 400, 'INVALID_INPUT');
      }
    }
    assert.deepEqual(await readTodo(a, id), todo);
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
    await admin.query('DELETE FROM categories WHERE user_id = $1', [a.userId]);
  });

  await t.test('the collection read is one snapshot even if a delete commits between its queries', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const id = randomUUID();
    const todo = (await addTodo(a, id, 'Linked')).data.todo;
    const linked = (await patchTodo(a, id, editOf(todo, { categoryId: work }))).data.todo;
    // After the snapshot's todos read, commit a category delete (with its unlink) on another connection.
    const { pool } = services;
    const connect = pool.connect.bind(pool);
    let hooked = false;
    let deleted;
    pool.connect = async (...args) => {
      const client = await connect(...args);
      if (hooked) return client;
      const query = client.query.bind(client);
      client.query = async (...queryArgs) => {
        const result = await query(...queryArgs);
        if (!hooked && /FROM todos/.test(String(queryArgs[0]))) {
          hooked = true;
          deleted = await remove(a, work, 1);
        }
        return result;
      };
      return client;
    };
    let list;
    try {
      list = await request('/api/todos', { account: a });
    } finally {
      pool.connect = connect;
    }
    assert.ok(hooked, 'the hook ran between the two reads');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(list.status, 200);
    const known = new Set(list.data.categories.map((category) => category.id));
    for (const item of list.data.todos) assert.ok(item.categoryId === null || known.has(item.categoryId), 'no dangling link');
    assert.deepEqual(list.data, { todos: [linked], categories: [{ id: work, name: 'Work', revision: 1 }] });
    const fresh = await request('/api/todos', { account: a });
    assert.deepEqual(fresh.data, { todos: [{ ...linked, categoryId: null, revision: linked.revision + 1 }], categories: [] });
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });

  await t.test('legacy edit (no categoryId) racing a category delete, edit first, survives the unlink', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const id = randomUUID();
    const todo = (await addTodo(a, id, 'Racer')).data.todo;
    const linked = (await patchTodo(a, id, editOf(todo, { categoryId: work }))).data.todo;
    const [edited, deleted] = await interleave(
      id,
      () => patchTodo(a, id, editOf(linked, { text: 'Renamed' })),
      () => remove(a, work, 1),
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.deepEqual(edited.data.todo, { ...linked, text: 'Renamed', revision: linked.revision + 1 });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const unlinked = { ...edited.data.todo, categoryId: null, revision: linked.revision + 2 };
    assert.deepEqual(deleted.data.todos, [unlinked]);
    assert.deepEqual(await readTodo(a, id), unlinked);
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });

  await t.test('legacy edit racing a category delete, delete first, gets 409 for the old revision', async () => {
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    const id = randomUUID();
    const todo = (await addTodo(a, id, 'Racer')).data.todo;
    const linked = (await patchTodo(a, id, editOf(todo, { categoryId: work }))).data.todo;
    const [deleted, edited] = await interleave(
      id,
      () => remove(a, work, 1),
      () => patchTodo(a, id, editOf(linked, { text: 'Renamed' })),
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const unlinked = { ...linked, categoryId: null, revision: linked.revision + 1 };
    assert.deepEqual(deleted.data.todos, [unlinked]);
    expectError(edited, 409, 'REVISION_CONFLICT');
    assert.deepEqual(await readTodo(a, id), unlinked);
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });

  await t.test('an account converted to 55 categories by 0006 cannot create another', async () => {
    const c = await signUpAccount('carol');
    const tags = Array.from({ length: 55 }, (_, i) => `tag-${i + 1}`);
    await admin.query(`
      INSERT INTO todos (user_id, id, text, tags, created_at)
      SELECT $1, gen_random_uuid(), 'Task ' || tag, ARRAY[tag], 1 FROM unnest($2::text[]) AS t(tag)
    `, [c.userId, tags]);
    // Rerun the conversion on this data through the runner.
    await admin.query("DELETE FROM schema_migrations WHERE filename = '0006_tags_to_categories.sql'");
    assert.deepEqual(await runMigrations({ connectionString: database.href, log: () => {} }), ['0006_tags_to_categories.sql']);
    const { data } = await request('/api/todos', { account: c });
    assert.deepEqual(data.categories.map(({ name }) => name).sort(), [...tags].sort());
    const byId = new Map(data.categories.map(({ id, name }) => [id, name]));
    for (const todo of data.todos) {
      assert.deepEqual([todo.text, todo.tags, todo.revision], [`Task ${byId.get(todo.categoryId)}`, [], 2]);
    }
    assert.equal(data.todos.length, 55);
    expectError(await create(c, randomUUID(), 'One more'), 409, 'CATEGORY_LIMIT');
    assert.equal((await stored(c.userId)).length, 55);
  });

  await t.test('legacy tags fold into the title on create and edit, and rows written with tags read folded', async () => {
    const tagsOf = async (id) => (await admin.query(
      'SELECT text, tags, category_id FROM todos WHERE user_id = $1 AND id = $2', [a.userId, id],
    )).rows[0];
    const [plain, empty, tagged, rollout, linked] = Array.from({ length: 5 }, () => randomUUID());
    const post = (body) => request('/api/todos', { method: 'POST', account: a, body });
    assert.equal((await post({ id: plain, text: 'No tags field' })).data.todo.tags.length, 0);
    assert.equal((await post({ id: empty, text: 'Empty tags', tags: [] })).status, 201);
    const created = await post({ id: tagged, text: ' Pay rent ', tags: ['#Home', 'bills', 'home'] });
    assert.deepEqual([created.status, created.data.todo.text, created.data.todo.tags], [201, 'Pay rent #home #bills', []]);
    assert.deepEqual(await tagsOf(tagged), { text: 'Pay rent #home #bills', tags: [], category_id: null });

    // The previous artifact can still write tags during rollout. They show in the title only.
    const work = randomUUID();
    assert.equal((await create(a, work, 'Work')).status, 201);
    await admin.query(`
      INSERT INTO todos (user_id, id, text, tags, created_at, category_id) VALUES
        ($1, $2, 'Rollout', '{late,work}', 1, NULL), ($1, $3, 'Linked', '{x}', 2, $4)
    `, [a.userId, rollout, linked, work]);
    const read = await readTodo(a, rollout);
    assert.deepEqual([read.text, read.tags, read.categoryId, read.revision], ['Rollout #late #work', [], null, 1]);
    const list = await request('/api/todos', { account: a });
    assert.deepEqual(list.data.todos.find((todo) => todo.id === rollout), read);
    assert.deepEqual(list.data.categories.map(({ name }) => name), ['Work']);

    // An old tab's edit that only restates its view is a no-op; any write stores the folded title.
    const restated = await patchTodo(a, rollout, editOf(read, { text: 'Rollout', tags: ['late', 'work'] }));
    assert.equal(restated.data.todo.revision, 1);
    assert.deepEqual((await tagsOf(rollout)).tags, ['late', 'work']);
    const toggled = await patchTodo(a, rollout, { action: 'complete', revision: 1, completed: true, due: null });
    assert.deepEqual(toggled.data.todo, { ...read, completed: true, revision: 2 });
    assert.deepEqual(await tagsOf(rollout), { text: 'Rollout #late #work', tags: [], category_id: null });

    const unlinked = await remove(a, work, 1);
    assert.deepEqual(unlinked.data.todos.map(({ text, tags, categoryId }) => ({ text, tags, categoryId })), [
      { text: 'Linked #x', tags: [], categoryId: null },
    ]);
    assert.deepEqual(await stored(a.userId), []);
    await admin.query('DELETE FROM todos WHERE user_id = $1', [a.userId]);
  });
});
