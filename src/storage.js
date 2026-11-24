// The only browser module that talks to the server: session, auth, todo and category requests.
// Tasks are never read from or written to localStorage. The old "task-manager.todos.v1" key is
// left untouched and ignored. The CSRF token lives only in memory.
import { foldLegacyTags } from './todos.js';

export class ApiError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// The current session's CSRF token. A request started under one token whose response arrives
// after the token changed (sign-out, expiry, an account switch) is discarded as STALE_SESSION.
let csrfToken = null;

export function currentToken() {
  return csrfToken;
}

export function setToken(token) {
  csrfToken = token ?? null;
}

async function send(path, { method = 'GET', body, csrf = false } = {}) {
  const token = csrfToken;
  const headers = {};
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (csrf && token) headers['X-CSRF-Token'] = token;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach the server.");
  }
  if (csrf && token !== csrfToken) throw new ApiError(0, 'STALE_SESSION', 'The session changed.');
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (csrf && token !== csrfToken) throw new ApiError(0, 'STALE_SESSION', 'The session changed.');
  if (!response.ok) {
    const error = data?.error ?? data ?? {};
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? 'Request failed.');
  }
  return data;
}

// --- Session and auth --------------------------------------------------------------------------

// {user:{name,email}|null, csrfToken, demoLoginEnabled?}
export async function readSession() {
  let response;
  try {
    response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach the server.");
  }
  if (response.status === 401) return { user: null, csrfToken: null };
  if (!response.ok) throw new ApiError(response.status, 'SESSION_CHECK_FAILED', 'Session check failed.');
  const active = await response.json();
  if (active?.user) return active;
  const demo = active?.demoLoginEnabled === true ? { demoLoginEnabled: true } : {};
  return { user: null, csrfToken: null, ...demo };
}

// Better Auth endpoints. Resolves {ok, status, code}; rejects only on a network failure.
// Response tokens are ignored: the app reads /api/session afterwards.
export async function authRequest(path, body, { csrf = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const code = response.ok ? undefined : (await response.json().catch(() => null))?.code;
  return { ok: response.ok, status: response.status, code };
}

// --- Todos -------------------------------------------------------------------------------------

const todoPath = (id, extra = '') => `/api/todos?id=${encodeURIComponent(id)}${extra}`;

// The signed-in snapshot: {todos, categories}, read in one server transaction. `categories` is
// null when the server sent no catalog (an older deployment), which turns category controls off.
// The CSRF token is sent on reads too, so a tab can't load another account's list after a switch.
export async function readSnapshot() {
  const data = await send('/api/todos', { csrf: true });
  return { todos: data.todos.map(foldLegacyTags), categories: Array.isArray(data.categories) ? data.categories : null };
}

// The rollback API requires a tag list on create and edit.
export async function createTodo({ id, text }) {
  const { todo } = await send('/api/todos', { method: 'POST', body: { id, text, tags: [] }, csrf: true });
  return foldLegacyTags(todo);
}

export async function patchTodo(id, revision, action, fields = {}) {
  const body = { ...fields, revision, action };
  if (action === 'edit') body.tags = [];
  const { todo } = await send(todoPath(id), { method: 'PATCH', body, csrf: true });
  return foldLegacyTags(todo);
}

export async function deleteTodo(id, revision) {
  await send(todoPath(id, `&revision=${revision}`), { method: 'DELETE', csrf: true });
}

// --- Categories --------------------------------------------------------------------------------

const categoryPath = (id, extra = '') => `/api/categories?id=${encodeURIComponent(id)}${extra}`;

export async function createCategory({ id, name }) {
  return (await send('/api/categories', { method: 'POST', body: { id, name }, csrf: true })).category;
}

export async function renameCategory(id, revision, name) {
  return (await send(categoryPath(id), { method: 'PATCH', body: { name, revision }, csrf: true })).category;
}

// Resolves to the todos the delete unlinked, with their new revisions.
export async function deleteCategory(id, revision) {
  const { todos } = await send(categoryPath(id, `&revision=${revision}`), { method: 'DELETE', csrf: true });
  return todos.map(foldLegacyTags);
}
