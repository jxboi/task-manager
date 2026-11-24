import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  authRequest,
  createCategory,
  createTodo,
  currentToken,
  deleteCategory,
  deleteTodo,
  patchTodo,
  readSession,
  readSnapshot,
  renameCategory,
  setToken,
} from '../src/storage.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CATEGORY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
let calls;
let responder;

function respond(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

beforeEach(() => {
  calls = [];
  responder = () => respond(200, {});
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, ...init });
    return responder(path, init);
  };
  // Any task read or write in browser storage would throw here.
  const forbidden = () => {
    throw new Error('localStorage must not be used for tasks');
  };
  globalThis.localStorage = { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden };
  setToken('token-a');
});

afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.localStorage;
  setToken(null);
});

test('readSession returns the signed-in user and token, uncached', async () => {
  const active = { user: { name: 'Ana', email: 'ana@example.test' }, csrfToken: 'token-b' };
  responder = () => respond(200, active);
  assert.deepEqual(await readSession(), active);
  assert.equal(calls[0].path, '/api/session');
  assert.equal(calls[0].cache, 'no-store');
});

test('readSession treats a 401 or an empty user as signed out, and rejects other failures', async () => {
  responder = () => respond(401, { error: { code: 'UNAUTHENTICATED' } });
  assert.deepEqual(await readSession(), { user: null, csrfToken: null });
  responder = () => respond(200, { user: null, csrfToken: null });
  assert.deepEqual(await readSession(), { user: null, csrfToken: null });
  responder = () => respond(500, {});
  await assert.rejects(readSession(), { status: 500 });
  responder = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(readSession(), { code: 'NETWORK', status: 0 });
});

test('authRequest posts JSON, sends the CSRF token only when asked and reports Better Auth codes', async () => {
  responder = () => respond(422, { code: 'USER_ALREADY_EXISTS' });
  assert.deepEqual(await authRequest('sign-up/email', { email: 'a@b.c' }), {
    ok: false, status: 422, code: 'USER_ALREADY_EXISTS',
  });
  assert.equal(calls[0].path, '/api/auth/sign-up/email');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers['X-CSRF-Token'], undefined);
  assert.equal(calls[0].body, '{"email":"a@b.c"}');

  responder = () => respond(200, { success: true });
  assert.deepEqual(await authRequest('sign-out', {}, { csrf: true }), { ok: true, status: 200, code: undefined });
  assert.equal(calls[1].headers['X-CSRF-Token'], 'token-a');
});

test('readSnapshot sends the session token on the read too, so it is bound to that session', async () => {
  const todos = [{ id: ID, text: 'One', completed: false, createdAt: 1, tags: [], categoryId: null, due: null, repeat: 'none', notified: null, revision: 1 }];
  const categories = [{ id: CATEGORY, name: 'Home', revision: 1 }];
  responder = () => respond(200, { todos, categories });
  assert.deepEqual(await readSnapshot(), { todos, categories });
  assert.equal(calls[0].path, '/api/todos');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['X-CSRF-Token'], 'token-a');
  assert.equal(calls[0].headers['Content-Type'], undefined);
  assert.equal(calls[0].body, undefined);
});

test('a snapshot without a catalog (an older server) reads as categories: null', async () => {
  responder = () => respond(200, { todos: [] });
  assert.deepEqual(await readSnapshot(), { todos: [], categories: null });
});

test('createTodo, patchTodo and deleteTodo send JSON with the CSRF token', async () => {
  responder = () => respond(201, { todo: { id: ID } });
  assert.deepEqual(await createTodo({ id: ID, text: 'Pay rent #home', tags: ['x'], createdAt: 5, extra: true }), { id: ID });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { id: ID, text: 'Pay rent #home', tags: [] });

  responder = () => respond(200, { todo: { id: ID, revision: 3 } });
  await patchTodo(ID, 2, 'setReminder', { due: 10, repeat: 'daily' });
  assert.equal(calls[1].path, `/api/todos?id=${ID}`);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body), { due: 10, repeat: 'daily', revision: 2, action: 'setReminder' });

  responder = () => respond(204);
  assert.equal(await deleteTodo(ID, 3), undefined);
  assert.equal(calls[2].path, `/api/todos?id=${ID}&revision=3`);
  assert.equal(calls[2].method, 'DELETE');
  // The server requires JSON on every mutation, bodyless deletes included.
  assert.equal(calls[2].headers['Content-Type'], 'application/json');
  for (const call of calls) {
    assert.equal(call.headers['X-CSRF-Token'], 'token-a');
    assert.equal(call.cache, 'no-store');
  }
});

test('an edit always sends empty tags for the rollback API', async () => {
  const fields = { text: 'Updated', due: null, repeat: 'none' };
  await patchTodo(ID, 2, 'edit', fields);
  await patchTodo(ID, 2, 'edit', { ...fields, tags: ['ignored'], categoryId: CATEGORY });
  const expected = { ...fields, revision: 2, action: 'edit', tags: [] };
  assert.deepEqual(calls.map(({ body }) => JSON.parse(body)), [expected, { ...expected, categoryId: CATEGORY }]);
});

test('category writes send JSON with the CSRF token and return the server\'s answer', async () => {
  const category = { id: CATEGORY, name: 'Home', revision: 1 };
  responder = () => respond(201, { category });
  assert.deepEqual(await createCategory({ id: CATEGORY, name: 'Home' }), category);
  assert.deepEqual({ method: calls[0].method, path: calls[0].path, body: JSON.parse(calls[0].body) },
    { method: 'POST', path: '/api/categories', body: { id: CATEGORY, name: 'Home' } });

  responder = () => respond(200, { category: { ...category, name: 'House', revision: 2 } });
  assert.equal((await renameCategory(CATEGORY, 1, 'House')).name, 'House');
  assert.deepEqual({ method: calls[1].method, path: calls[1].path, body: JSON.parse(calls[1].body) },
    { method: 'PATCH', path: `/api/categories?id=${CATEGORY}`, body: { name: 'House', revision: 1 } });

  const todos = [{ id: ID, categoryId: null, revision: 4 }];
  responder = () => respond(200, { todos });
  assert.deepEqual(await deleteCategory(CATEGORY, 2), todos);
  assert.equal(calls[2].method, 'DELETE');
  assert.equal(calls[2].path, `/api/categories?id=${CATEGORY}&revision=2`);
  for (const call of calls) {
    assert.equal(call.headers['X-CSRF-Token'], 'token-a');
    assert.equal(call.headers['Content-Type'], 'application/json');
  }

  responder = () => respond(409, { error: { code: 'CATEGORY_LIMIT', message: 'x' } });
  await assert.rejects(createCategory({ id: CATEGORY, name: 'One more' }), { status: 409, code: 'CATEGORY_LIMIT' });
});

test('todo errors reject with the API status and code', async () => {
  for (const [status, code] of [[400, 'INVALID_INPUT'], [401, 'UNAUTHENTICATED'], [403, 'INVALID_CSRF'],
    [404, 'NOT_FOUND'], [409, 'REVISION_CONFLICT'], [500, 'INTERNAL_ERROR']]) {
    responder = () => respond(status, { error: { code, message: 'x' } });
    await assert.rejects(patchTodo(ID, 1, 'clearReminder'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  }
  responder = () => respond(502, 'not json');
  await assert.rejects(readSnapshot(), { status: 502, code: 'HTTP_ERROR' });
  responder = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(readSnapshot(), { status: 0, code: 'NETWORK' });
});

test('an answer that arrives after the session changed is discarded', async () => {
  let release;
  responder = () => new Promise((resolve) => {
    release = () => resolve(respond(200, { todos: [{ id: ID }] }));
  });
  const pending = readSnapshot();
  await new Promise((resolve) => setTimeout(resolve));
  setToken('token-b');
  release();
  await assert.rejects(pending, { code: 'STALE_SESSION' });
  assert.equal(currentToken(), 'token-b');
});

test('no request is made without being asked, and localStorage is never touched', async () => {
  // beforeEach made every localStorage method throw; all of the above ran against it.
  responder = () => respond(200, { todos: [] });
  await readSnapshot();
  assert.equal(calls.length, 1);
});
