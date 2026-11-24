import { checkMutation, endpoint, invalid, json, readObject, RequestError, requireSession } from './http.js';
import {
  createCategoryInput, MAX_CATEGORIES, readCategoryId, readQueryRevision, renameCategoryInput,
} from './category-input.js';
import { columns as todoColumns, toTodo } from './todo-endpoint.js';
import { transaction } from './transaction.js';

const columns = 'id, name, revision';

function notFound() {
  return new RequestError(404, 'NOT_FOUND', 'Category not found.');
}

function stale() {
  return new RequestError(409, 'REVISION_CONFLICT', 'This category changed. Refresh and try again.');
}

function duplicateId() {
  return new RequestError(409, 'DUPLICATE_ID', 'A category with this ID already exists.');
}

// Races past the explicit checks surface as constraint errors; map them to the same answers.
function constraintError(error) {
  if (error.code === '23505' && error.constraint === 'categories_user_name_idx') {
    return new RequestError(409, 'DUPLICATE_NAME', 'A category with this name already exists.');
  }
  if (error.code === '23505' && error.constraint === 'categories_pkey') return duplicateId();
  if (error.code === '23514') return invalid('Enter a valid category name.');
  return error;
}

async function findCategory(db, userId, id, lock = '') {
  const { rows: [row] } = await db.query(
    `SELECT ${columns} FROM categories WHERE user_id = $1 AND id = $2 ${lock}`, [userId, id],
  );
  if (!row) throw notFound();
  return row;
}

function createCategory(pool, userId, { id, name }) {
  return transaction(pool, async (client) => {
    // Serializes this account's creates so the count below can't be raced past the cap.
    await client.query('SELECT 1 FROM "user" WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    const { rowCount } = await client.query(
      'SELECT 1 FROM categories WHERE user_id = $1 AND id = $2', [userId, id],
    );
    if (rowCount) throw duplicateId();
    const { rows: [{ count }] } = await client.query(
      'SELECT count(*)::int AS count FROM categories WHERE user_id = $1', [userId],
    );
    if (count >= MAX_CATEGORIES) {
      throw new RequestError(409, 'CATEGORY_LIMIT', `Use at most ${MAX_CATEGORIES} categories.`);
    }
    const { rows: [category] } = await client.query(
      `INSERT INTO categories (user_id, id, name) VALUES ($1, $2, $3) RETURNING ${columns}`,
      [userId, id, name],
    );
    return json({ category }, 201);
  });
}

async function renameCategory(pool, userId, id, { name, revision }) {
  const category = await findCategory(pool, userId, id);
  if (category.revision !== revision) throw stale();
  if (category.name === name) return json({ category });
  const { rows: [row] } = await pool.query(
    `UPDATE categories SET name = $4, revision = revision + 1
     WHERE user_id = $1 AND id = $2 AND revision = $3
     RETURNING ${columns}`,
    [userId, id, revision, name],
  );
  if (!row) {
    await findCategory(pool, userId, id);
    throw stale();
  }
  return json({ category: row });
}

function deleteCategory(pool, userId, id, revision) {
  return transaction(pool, async (client) => {
    const category = await findCategory(client, userId, id, 'FOR UPDATE');
    if (category.revision !== revision) throw stale();
    const { rows } = await client.query(
      `UPDATE todos SET category_id = NULL, revision = revision + 1
       WHERE user_id = $1 AND category_id = $2
       RETURNING ${todoColumns}`,
      [userId, id],
    );
    await client.query('DELETE FROM categories WHERE user_id = $1 AND id = $2', [userId, id]);
    return json({ todos: rows.map(toTodo) });
  });
}

export const categoriesEndpoint = endpoint(['POST', 'PATCH', 'DELETE'], async (request, services) => {
  checkMutation(request, services.origins);
  const { user: { id: userId } } = await requireSession(request, services, true);

  const { pool } = services;
  const { method } = request;
  const query = new URL(request.url).searchParams;
  try {
    if (method === 'POST') return await createCategory(pool, userId, createCategoryInput(await readObject(request)));
    const id = readCategoryId(query.get('id'));
    if (method === 'PATCH') return await renameCategory(pool, userId, id, renameCategoryInput(await readObject(request)));
    return await deleteCategory(pool, userId, id, readQueryRevision(query.get('revision')));
  } catch (error) {
    throw constraintError(error);
  }
});
