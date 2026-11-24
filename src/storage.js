// The only browser module that talks to the server: session, auth, todo and category requests.
// Tasks are never read from or written to localStorage. The old "task-manager.todos.v1" key is
// left untouched and ignored. The CSRF token lives only in memory.
import { foldLegacyTags } from './todos.js';
import { REPEATS } from './reminders.js';

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

const invalidWriteResponse = () => new ApiError(0, 'INVALID_WRITE_RESPONSE', 'The write response was invalid.');

async function send(path, { method = 'GET', body, csrf = false, noContent = false } = {}) {
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
  if (noContent) throw invalidWriteResponse();
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (id) => typeof id === 'string' && uuid.test(id);
const hasRevision = (row) => isId(row?.id) && Number.isInteger(row.revision) &&
  row.revision >= 1 && row.revision <= 2147483647;
const isTimestamp = (value) => value === null || Number.isSafeInteger(value);

function isTodo(row) {
  return hasRevision(row) && typeof row.text === 'string' && row.text.length > 0 &&
    typeof row.completed === 'boolean' && Number.isInteger(row.createdAt) &&
    isTimestamp(row.due) && isTimestamp(row.notified) && REPEATS.includes(row.repeat) &&
    Array.isArray(row.tags) && row.tags.every((tag) => tag === null || typeof tag === 'string') &&
    (row.completedUntil === undefined || isTimestamp(row.completedUntil)) &&
    (row.categoryId == null || isId(row.categoryId)) &&
    (row.position == null || (typeof row.position === 'string' && /^[0-9]{20}[0-9a-f]*[1-9a-f]$/.test(row.position)));
}

function readTodoWrite(data, id) {
  const todo = data?.todo;
  if (!isTodo(todo) || todo.id !== id.toLowerCase()) throw invalidWriteResponse();
  return foldLegacyTags(todo);
}

// The signed-in snapshot: {todos, categories}, read in one server transaction. `categories` is
// null when the server sent no catalog (an older deployment), which turns category controls off.
// The CSRF token is sent on reads too, so a tab can't load another account's list after a switch.
export async function readSnapshot() {
  const data = await send('/api/todos', { csrf: true });
  if (!Array.isArray(data?.todos) || !data.todos.every(isTodo) ||
      (data.categories != null && (!Array.isArray(data.categories) || !data.categories.every(isCategory)))) {
    throw new ApiError(0, 'INVALID_SNAPSHOT', 'The task list response was invalid.');
  }
  return { todos: data.todos.map(foldLegacyTags), categories: data.categories ?? null };
}

// The rollback API requires a tag list on create and edit.
export async function createTodo({ id, text }) {
  const data = await send('/api/todos', { method: 'POST', body: { id, text, tags: [] }, csrf: true });
  return readTodoWrite(data, id);
}

export async function patchTodo(id, revision, action, fields = {}) {
  const body = { ...fields, revision, action };
  if (action === 'edit') body.tags = [];
  const data = await send(todoPath(id), { method: 'PATCH', body, csrf: true });
  return readTodoWrite(data, id);
}

export async function deleteTodo(id, revision) {
  await send(todoPath(id, `&revision=${revision}`), { method: 'DELETE', csrf: true, noContent: true });
}

// --- Categories --------------------------------------------------------------------------------

const categoryPath = (id, extra = '') => `/api/categories?id=${encodeURIComponent(id)}${extra}`;
const isCategory = (row) => hasRevision(row) && typeof row.name === 'string' && row.name.length > 0;

function readCategoryWrite(data, id) {
  const category = data?.category;
  if (!isCategory(category) || category.id !== id.toLowerCase()) throw invalidWriteResponse();
  return category;
}

export async function createCategory({ id, name }) {
  const data = await send('/api/categories', { method: 'POST', body: { id, name }, csrf: true });
  return readCategoryWrite(data, id);
}

export async function renameCategory(id, revision, name) {
  const data = await send(categoryPath(id), { method: 'PATCH', body: { name, revision }, csrf: true });
  return readCategoryWrite(data, id);
}

// Resolves to the todos the delete unlinked, with their new revisions.
export async function deleteCategory(id, revision) {
  const data = await send(categoryPath(id, `&revision=${revision}`), { method: 'DELETE', csrf: true });
  const todos = data?.todos;
  if (!Array.isArray(todos) || !todos.every((todo) => isTodo(todo) && todo.categoryId === null)) {
    throw invalidWriteResponse();
  }
  return todos.map(foldLegacyTags);
}
