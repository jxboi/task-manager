// An in-memory stand-in for /api/session, /api/todos and /api/categories, for browser-module
// tests. It reuses the server's own input rules and transforms (server/todo-input.js,
// server/category-input.js), keeps a revision per row and checks the CSRF token, so client code
// meets the same answers it gets from the real handlers.
import { createInput, patchTodo, readId, readMove } from '../server/todo-input.js';
import {
  createCategoryInput, MAX_CATEGORIES, readCategoryId, readQueryRevision, renameCategoryInput,
} from '../server/category-input.js';
import { RequestError } from '../server/http.js';
import { foldTags, moveTodo, sortByPosition } from '../src/todos.js';

export function createFakeApi({ csrfToken = 'token-a', user = { name: 'Ana', email: 'ana@example.test' } } = {}) {
  const server = {
    rows: [],
    // The catalog; null makes GET answer without one, like a server from before categories.
    categories: [],
    session: { user, csrfToken },
    requests: [],
    // Set to make the next matching request fail: (method, url) => Response | Error | undefined.
    failNext: null,
    now: () => Date.now(),
  };

  const reply = (value, status = 200) => new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  const failure = (status, code, message = code) => reply({ error: { code, message } }, status);

  async function handle(method, url, headers, body) {
    if (url.pathname === '/api/session') {
      return reply(server.session.user ? server.session : { user: null, csrfToken: null });
    }
    if (url.pathname !== '/api/todos' && url.pathname !== '/api/categories') return failure(404, 'NOT_FOUND');
    if (!server.session.user) return failure(401, 'UNAUTHENTICATED');
    const token = headers['X-CSRF-Token'];
    if ((method !== 'GET' || token !== undefined) && token !== server.session.csrfToken) {
      return failure(403, 'INVALID_CSRF');
    }
    try {
      if (url.pathname === '/api/categories') return categories(method, url, body);
      if (method === 'GET' && !url.searchParams.has('id')) {
        const snapshot = { todos: server.rows };
        if (server.categories) snapshot.categories = sortedCategories();
        return reply(snapshot);
      }
      if (method === 'POST') {
        // Like the real server: tags from older clients are folded into the title, none stored.
        const { id, text, tags } = createInput(JSON.parse(body));
        if (server.rows.some((row) => row.id === id)) return failure(409, 'DUPLICATE_ID');
        const row = {
          id, text: foldTags(text, tags), tags: [], categoryId: null,
          completed: false, createdAt: server.now(), due: null, repeat: 'none', notified: null, revision: 1,
        };
        server.rows = [...server.rows, row];
        return reply({ todo: row }, 201);
      }
      const id = readId(url.searchParams.get('id'));
      const row = server.rows.find((item) => item.id === id);
      if (!row) return failure(404, 'NOT_FOUND');
      if (method === 'DELETE') {
        if (Number(url.searchParams.get('revision')) !== row.revision) return failure(409, 'REVISION_CONFLICT');
        server.rows = server.rows.filter((item) => item !== row);
        return reply(null, 204);
      }
      const patch = JSON.parse(body);
      if (patch.revision !== row.revision) return failure(409, 'REVISION_CONFLICT');
      if (patch.action === 'edit' && patch.categoryId != null &&
          !(server.categories ?? []).some((category) => category.id === patch.categoryId)) {
        return failure(404, 'CATEGORY_NOT_FOUND');
      }
      let changed;
      if (patch.action === 'move') {
        const { anchorId, side } = readMove(patch, id);
        if (!server.rows.some((item) => item.id === anchorId)) return failure(404, 'NOT_FOUND');
        changed = moveTodo(server.rows, id, anchorId, side).find((item) => item.id === id);
      } else {
        changed = patchTodo(row, patch);
      }
      if (changed === row) return reply({ todo: row });
      const next = { ...changed, revision: row.revision + 1 };
      server.rows = server.rows.map((item) => (item === row ? next : item));
      if (patch.action === 'move') server.rows = sortByPosition(server.rows);
      return reply({ todo: next });
    } catch (error) {
      if (error instanceof RequestError) return failure(error.status, error.code, error.message);
      throw error;
    }
  }

  const sortedCategories = () => [...server.categories].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

  // server/category-endpoint.js's answers: create, rename and delete (which unlinks its todos).
  function categories(method, url, body) {
    if (method === 'POST') {
      const { id, name } = createCategoryInput(JSON.parse(body));
      if (server.categories.some((category) => category.id === id)) return failure(409, 'DUPLICATE_ID');
      if (server.categories.length >= MAX_CATEGORIES) return failure(409, 'CATEGORY_LIMIT');
      if (server.categories.some((category) => sameName(category.name, name))) return failure(409, 'DUPLICATE_NAME');
      const category = { id, name, revision: 1 };
      server.categories = [...server.categories, category];
      return reply({ category }, 201);
    }
    const id = readCategoryId(url.searchParams.get('id'));
    const category = server.categories.find((item) => item.id === id);
    if (method === 'PATCH') {
      const { name, revision } = renameCategoryInput(JSON.parse(body));
      if (!category) return failure(404, 'NOT_FOUND');
      if (category.revision !== revision) return failure(409, 'REVISION_CONFLICT');
      if (category.name === name) return reply({ category });
      if (server.categories.some((item) => item !== category && sameName(item.name, name))) {
        return failure(409, 'DUPLICATE_NAME');
      }
      const renamed = { ...category, name, revision: revision + 1 };
      server.categories = server.categories.map((item) => (item === category ? renamed : item));
      return reply({ category: renamed });
    }
    if (method !== 'DELETE') return failure(405, 'METHOD_NOT_ALLOWED');
    const revision = readQueryRevision(url.searchParams.get('revision'));
    if (!category) return failure(404, 'NOT_FOUND');
    if (category.revision !== revision) return failure(409, 'REVISION_CONFLICT');
    const todos = [];
    server.rows = server.rows.map((row) => {
      if (row.categoryId !== id) return row;
      const unlinked = { ...row, categoryId: null, revision: row.revision + 1 };
      todos.push(unlinked);
      return unlinked;
    });
    server.categories = server.categories.filter((item) => item !== category);
    return reply({ todos });
  }

  server.fetch = async (path, init = {}) => {
    const url = new URL(path, 'http://localhost');
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    server.requests.push({ method, path: `${url.pathname}${url.search}`, headers, body: init.body });
    // failNext stays armed until it returns something, so it can wait for a particular request.
    const injected = server.failNext?.(method, url);
    if (injected !== undefined) {
      server.failNext = null;
      if (injected instanceof Error) throw injected;
      if (injected.afterWrite) {
        await handle(method, url, headers, init.body);
        throw new TypeError('Failed to fetch');
      }
      return injected;
    }
    return handle(method, url, headers, init.body);
  };

  return server;
}

// Lets queued fetches and the renders they schedule settle.
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve));
}
