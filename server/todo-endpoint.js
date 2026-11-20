import { checkMutation, endpoint, invalid, json, readObject, RequestError, requireSession } from './http.js';
import { createInput, patchTodo, readId, readRevision } from './todo-input.js';

const columns = 'id, text, completed, created_at AS "createdAt", tags, due, repeat, notified, revision';

function toTodo(row) {
  return {
    ...row,
    createdAt: Number(row.createdAt),
    due: row.due === null ? null : Number(row.due),
    notified: row.notified === null ? null : Number(row.notified),
  };
}

function notFound() {
  return new RequestError(404, 'NOT_FOUND', 'Todo not found.');
}

function stale() {
  return new RequestError(409, 'REVISION_CONFLICT', 'This todo changed. Refresh and try again.');
}

async function findTodo(pool, userId, id) {
  const { rows: [row] } = await pool.query(
    `SELECT ${columns} FROM todos WHERE user_id = $1 AND id = $2`, [userId, id],
  );
  if (!row) throw notFound();
  return toTodo(row);
}

async function createTodo(pool, userId, { id, text, tags }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO todos (user_id, id, text, tags, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, id) DO NOTHING
     RETURNING ${columns}`,
    [userId, id, text, tags, Date.now()],
  );
  if (!row) throw new RequestError(409, 'DUPLICATE_ID', 'A todo with this ID already exists.');
  return json({ todo: toTodo(row) }, 201);
}

async function updateTodo(pool, userId, id, body) {
  const revision = readRevision(body.revision);
  const todo = await findTodo(pool, userId, id);
  if (todo.revision !== revision) throw stale();
  const changed = patchTodo(todo, body);
  if (changed === todo) return json({ todo });

  const { rows: [row] } = await pool.query(
    `UPDATE todos SET completed = $4, tags = $5, due = $6, repeat = $7, notified = $8, text = $9,
       revision = revision + 1
     WHERE user_id = $1 AND id = $2 AND revision = $3
     RETURNING ${columns}`,
    [userId, id, revision, changed.completed, changed.tags, changed.due, changed.repeat, changed.notified, changed.text],
  );
  if (!row) {
    await findTodo(pool, userId, id);
    throw stale();
  }
  return json({ todo: toTodo(row) });
}

async function deleteTodo(pool, userId, id, rawRevision) {
  if (!/^[1-9]\d*$/.test(rawRevision ?? '')) throw invalid('Provide a valid revision.');
  const revision = readRevision(Number(rawRevision));
  const result = await pool.query(
    'DELETE FROM todos WHERE user_id = $1 AND id = $2 AND revision = $3', [userId, id, revision],
  );
  if (!result.rowCount) {
    await findTodo(pool, userId, id);
    throw stale();
  }
  return new Response(null, { status: 204 });
}

export const todosEndpoint = endpoint(['GET', 'POST', 'PATCH', 'DELETE'], async (request, services) => {
  const { method } = request;
  const mutation = method !== 'GET';
  if (mutation) checkMutation(request, services.origins);
  // Reads carrying X-CSRF-Token are bound to that session too, so a tab left open after an
  // account switch can't load the new account's list as the old one.
  const bound = mutation || request.headers.has('x-csrf-token');
  const { user: { id: userId } } = await requireSession(request, services, bound);

  const { pool } = services;
  const query = new URL(request.url).searchParams;
  if (method === 'POST') return createTodo(pool, userId, createInput(await readObject(request)));
  if (method === 'GET' && !query.has('id')) {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM todos WHERE user_id = $1 ORDER BY created_at, id`, [userId],
    );
    return json({ todos: rows.map(toTodo) });
  }

  const id = readId(query.get('id'));
  if (method === 'GET') return json({ todo: await findTodo(pool, userId, id) });
  if (method === 'PATCH') return updateTodo(pool, userId, id, await readObject(request));
  return deleteTodo(pool, userId, id, query.get('revision'));
});
