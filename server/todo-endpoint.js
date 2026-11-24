import { checkMutation, endpoint, invalid, json, readObject, RequestError, requireSession } from './http.js';
import { createInput, patchTodo, readId, readMove, readRevision } from './todo-input.js';
import { moveTodo } from '../src/todos.js';

const position = 'COALESCE(position, todo_initial_position(created_at, id)) COLLATE "C"';
export const columns = `id, text, completed, completed_until AS "completedUntil", created_at AS "createdAt",
  tags, due, repeat, notified, revision, ${position} AS position`;

export function toTodo(row) {
  return {
    ...row,
    completedUntil: row.completedUntil === null ? null : Number(row.completedUntil),
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

async function listTodos(pool, userId) {
  const { rows } = await pool.query(
    `SELECT ${columns} FROM todos WHERE user_id = $1 ORDER BY position, created_at, id`, [userId],
  );
  return rows.map(toTodo);
}

async function createTodo(pool, userId, { id, text, tags }) {
  // Append in a new whole slot. Concurrent creates may choose the same slot, with UUID
  // suffixes giving them distinct keys and a deterministic order.
  const { rows: [row] } = await pool.query(
    `INSERT INTO todos (user_id, id, text, tags, created_at, position)
     VALUES ($1, $2, $3, $4, $5,
       lpad(GREATEST(
         $5::bigint::numeric + 9223372036854775808,
         (SELECT max(left(${position}, 20))::numeric + 1 FROM todos WHERE user_id = $1)
       )::text, 20, '0') || '8' || replace($2::uuid::text, '-', '') || '8'
     )
     ON CONFLICT (user_id, id) DO NOTHING
     RETURNING ${columns}`,
    [userId, id, text, tags, Date.now()],
  );
  if (!row) throw new RequestError(409, 'DUPLICATE_ID', 'A todo with this ID already exists.');
  return json({ todo: toTodo(row) }, 201);
}

async function updateTodo(pool, userId, id, body) {
  const revision = readRevision(body.revision);
  const move = body.action === 'move' ? readMove(body, id) : null;
  const todos = move ? await listTodos(pool, userId) : null;
  const todo = todos ? todos.find((item) => item.id === id) : await findTodo(pool, userId, id);
  if (!todo) throw notFound();
  if (todo.revision !== revision) throw stale();
  let changed;
  if (move) {
    if (!todos.some((item) => item.id === move.anchorId)) throw notFound();
    changed = moveTodo(todos, id, move.anchorId, move.side).find((item) => item.id === id);
  } else {
    changed = patchTodo(todo, body);
  }
  if (changed === todo) return json({ todo });

  const { rows: [row] } = await pool.query(
    `UPDATE todos SET completed = $4, tags = $5, due = $6, repeat = $7, notified = $8,
       text = $9, completed_until = $10, position = $11,
       revision = revision + 1
     WHERE user_id = $1 AND id = $2 AND revision = $3
     RETURNING ${columns}`,
    [userId, id, revision, changed.completed, changed.tags, changed.due, changed.repeat,
      changed.notified, changed.text, changed.completedUntil, changed.position],
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
    return json({ todos: await listTodos(pool, userId) });
  }

  const id = readId(query.get('id'));
  if (method === 'GET') return json({ todo: await findTodo(pool, userId, id) });
  if (method === 'PATCH') return updateTodo(pool, userId, id, await readObject(request));
  return deleteTodo(pool, userId, id, query.get('revision'));
});
