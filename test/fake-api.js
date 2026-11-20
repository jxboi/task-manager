// An in-memory stand-in for /api/session and /api/todos, for browser-module tests. It reuses the
// server's own input rules and transforms (server/todo-input.js), keeps a revision per row and
// checks the CSRF token, so client code meets the same answers it gets from the real handlers.
import { createInput, patchTodo, readId } from '../server/todo-input.js';
import { RequestError } from '../server/http.js';

export function createFakeApi({ csrfToken = 'token-a', user = { name: 'Ana', email: 'ana@example.test' } } = {}) {
  const server = {
    rows: [],
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
    if (url.pathname !== '/api/todos') return failure(404, 'NOT_FOUND');
    if (!server.session.user) return failure(401, 'UNAUTHENTICATED');
    const token = headers['X-CSRF-Token'];
    if ((method !== 'GET' || token !== undefined) && token !== server.session.csrfToken) {
      return failure(403, 'INVALID_CSRF');
    }
    try {
      if (method === 'GET' && !url.searchParams.has('id')) return reply({ todos: server.rows });
      if (method === 'POST') {
        const input = createInput(JSON.parse(body));
        if (server.rows.some((row) => row.id === input.id)) return failure(409, 'DUPLICATE_ID');
        const row = {
          ...input, completed: false, createdAt: server.now(), due: null, repeat: 'none', notified: null, revision: 1,
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
      const changed = patchTodo(row, patch);
      if (changed === row) return reply({ todo: row });
      const next = { ...changed, revision: row.revision + 1 };
      server.rows = server.rows.map((item) => (item === row ? next : item));
      return reply({ todo: next });
    } catch (error) {
      if (error instanceof RequestError) return failure(error.status, error.code, error.message);
      throw error;
    }
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
