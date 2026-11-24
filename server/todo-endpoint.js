import { checkMutation, endpoint, invalid, json, readObject, RequestError, requireSession } from './http.js';
import { createInput, patchTodo, readEdit, readId, readMove, readRevision } from './todo-input.js';
import { transaction } from './transaction.js';
import { foldLegacyTags, foldTags, moveTodo } from '../src/todos.js';

const position = 'COALESCE(position, todo_initial_position(created_at, id)) COLLATE "C"';
export const columns = `id, text, completed, completed_until AS "completedUntil", created_at AS "createdAt",
  tags, due, repeat, notified, revision, ${position} AS position, category_id AS "categoryId"`;

// Migration 0006 converted stored tags, and none are stored since. Tags an older client sends,
// or an older app wrote during rollout, show as part of the title, and the next write stores
// that title with no tags. They never become categories. `tags` stays in the shape, always
// empty, because older clients read it.
export function toTodo(row) {
  return foldLegacyTags({
    ...row,
    completedUntil: row.completedUntil === null ? null : Number(row.completedUntil),
    createdAt: Number(row.createdAt),
    due: row.due === null ? null : Number(row.due),
    notified: row.notified === null ? null : Number(row.notified),
  });
}

function notFound() {
  return new RequestError(404, 'NOT_FOUND', 'Todo not found.');
}

// Missing and foreign categories look the same.
function categoryNotFound() {
  return new RequestError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
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

// Todos and categories from one snapshot, so every link points into the returned catalog.
function readSnapshot(pool, userId) {
  return transaction(pool, async (client) => {
    const todos = await listTodos(client, userId);
    const { rows: categories } = await client.query(
      'SELECT id, name, revision FROM categories WHERE user_id = $1 ORDER BY lower(name), id', [userId],
    );
    return { todos, categories };
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

async function createTodo(pool, userId, { id, text, tags }) {
  // Append in a new whole slot. Concurrent creates may choose the same slot, with UUID
  // suffixes giving them distinct keys and a deterministic order.
  const { rows: [row] } = await pool.query(
    `INSERT INTO todos (user_id, id, text, created_at, position)
     VALUES ($1, $2, $3, $4,
       lpad(GREATEST(
         $4::bigint::numeric + 9223372036854775808,
         (SELECT max(left(${position}, 20))::numeric + 1 FROM todos WHERE user_id = $1)
       )::text, 20, '0') || '8' || replace($2::uuid::text, '-', '') || '8'
     )
     ON CONFLICT (user_id, id) DO NOTHING
     RETURNING ${columns}`,
    [userId, id, foldTags(text, tags), Date.now()],
  );
  if (!row) throw new RequestError(409, 'DUPLICATE_ID', 'A todo with this ID already exists.');
  return json({ todo: toTodo(row) }, 201);
}

async function updateTodo(pool, userId, id, body) {
  const revision = readRevision(body.revision);
  // Reject a malformed edit before touching the category, so it never reads as a 404.
  const categoryId = body.action === 'edit' ? readEdit(body).categoryId : undefined;
  if (!categoryId) return writeTodo(pool, userId, id, revision, body);
  // Key-share the category before the todo's write lock: a concurrent category delete either
  // waits for this edit (and then unlinks it) or finishes first and this edit sees no category.
  return transaction(pool, async (client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM categories WHERE user_id = $1 AND id = $2 FOR KEY SHARE', [userId, categoryId],
    );
    if (!rowCount) throw categoryNotFound();
    return writeTodo(client, userId, id, revision, body);
  }).catch((error) => {
    throw error.code === '23503' && error.constraint === 'todos_category_fk' ? categoryNotFound() : error;
  });
}

async function writeTodo(pool, userId, id, revision, body) {
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
  if (changed.tags.length) {
    // A legacy edit or addTag. If folding its tags gives back the current title, it is a no-op.
    const folded = foldLegacyTags(changed);
    changed = Object.keys(folded).every((key) => folded[key] === todo[key] || key === 'tags') ? todo : folded;
  }
  if (changed === todo) return json({ todo });

  // The link is written only when it changed, so edits that omit it never touch it.
  const values = [userId, id, revision, changed.completed, changed.due, changed.repeat,
    changed.notified, changed.text, changed.completedUntil, changed.position];
  const relink = changed.categoryId !== todo.categoryId;
  if (relink) values.push(changed.categoryId);
  const { rows: [row] } = await pool.query(
    `UPDATE todos SET completed = $4, tags = '{}', due = $5, repeat = $6, notified = $7,
       text = $8, completed_until = $9, position = $10, ${relink ? 'category_id = $11,' : ''}
       revision = revision + 1
     WHERE user_id = $1 AND id = $2 AND revision = $3
     RETURNING ${columns}`,
    values,
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
    return json(await readSnapshot(pool, userId));
  }

  const id = readId(query.get('id'));
  if (method === 'GET') return json({ todo: await findTodo(pool, userId, id) });
  if (method === 'PATCH') return updateTodo(pool, userId, id, await readObject(request));
  return deleteTodo(pool, userId, id, query.get('revision'));
});
