import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;
const run = promisify(execFile);
const runner = fileURLToPath(new URL('./migrate.js', import.meta.url));

test('migrations replay on an empty schema and concurrent reruns apply each file once', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async () => {
  const schema = `task_manager_test_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: database.href });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    const migrate = () => run(process.execPath, [runner], {
      env: { ...process.env, DATABASE_URL_UNPOOLED: database.href },
    });
    const results = await Promise.allSettled([migrate(), migrate()]);
    const output = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value.stdout.trim();
    });

    const files = (await readdir(new URL('./migrations/', import.meta.url)))
      .filter((name) => name.endsWith('.sql')).sort();
    assert.deepEqual(output.sort(), [
      files.map((name) => `Applied ${name}`).join('\n'),
      'No pending migrations.',
    ]);
    assert.equal((await migrate()).stdout.trim(), 'No pending migrations.');
    const ledger = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
    assert.deepEqual(ledger.rows.map(({ filename }) => filename), files);
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_schema = $1
    `, [schema]);
    for (const table of ['user', 'session', 'account', 'verification', 'rateLimit', 'todos', 'categories']) {
      assert.ok(tables.rows.some(({ table_name }) => table_name === table), `Missing ${table}`);
    }
    const column = await client.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'todos' AND column_name = 'category_id'
    `, [schema]);
    assert.deepEqual(column.rows, [{ data_type: 'uuid', is_nullable: 'YES' }]);
    const indexes = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
        AND indexname IN ('categories_user_name_idx', 'todos_user_category_idx')
      ORDER BY indexname
    `, [schema]);
    assert.equal(indexes.rowCount, 2);
    assert.match(indexes.rows[0].indexdef, /UNIQUE INDEX .* ON .*categories .*\(user_id, lower\(name\)\)/);
    assert.match(indexes.rows[1].indexdef, /ON .*todos .*\(user_id, category_id\) WHERE \(category_id IS NOT NULL\)/);
    const fk = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'todos'::regclass AND conname = 'todos_category_fk'
    `);
    assert.equal(fk.rows[0].definition, 'FOREIGN KEY (user_id, category_id) REFERENCES categories(user_id, id)');
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
});

test('check mode reports pending without writing, and apply waits on the advisory lock', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async () => {
  const { runMigrations, LOCK_SQL } = await import('./runner.js');
  const schema = `task_manager_test_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: database.href });
  const quiet = () => {};
  const files = (await readdir(new URL('./migrations/', import.meta.url))).filter((n) => n.endsWith('.sql')).sort();

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    const options = { connectionString: database.href, log: quiet };
    assert.deepEqual(await runMigrations({ ...options, apply: false }), files);
    const created = await client.query("SELECT to_regclass('schema_migrations') AS t");
    assert.equal(created.rows[0].t, null, 'check mode must not create anything');

    await client.query(LOCK_SQL);
    let done = false;
    const applying = runMigrations(options).then((r) => { done = true; return r; });
    // Observe the runner actually blocked on the advisory lock instead of sleeping.
    const deadline = Date.now() + 10_000;
    let waiting = 0;
    while (!waiting && Date.now() < deadline) {
      waiting = (await client.query(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'
      `)).rows[0].n;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(waiting, 1, 'apply must be observed waiting on the advisory lock');
    assert.equal(done, false, 'apply must wait while the lock is held');
    await client.query("SELECT pg_advisory_unlock(hashtext('task-manager.schema_migrations'))");
    assert.deepEqual(await applying, files);
    assert.deepEqual(await runMigrations({ ...options, apply: false }), []);
    assert.deepEqual(await runMigrations(options), []);
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
});

test('a failing migration leaves neither its schema change nor its ledger row', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async () => {
  const { runMigrations, MigrationError } = await import('./runner.js');
  const schema = `task_manager_test_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: database.href });
  const directory = await mkdtemp(join(tmpdir(), 'migrations-'));
  await writeFile(join(directory, '0001_ok.sql'), 'CREATE TABLE fixture_ok (id int);');
  await writeFile(join(directory, '0002_bad.sql'), 'CREATE TABLE fixture_bad (id int); SELECT 1/0;');

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await assert.rejects(
      runMigrations({ connectionString: database.href, directory: pathToFileURL(`${directory}/`), log: () => {} }),
      (error) => error instanceof MigrationError && error.filename === '0002_bad.sql' &&
        error.sqlstate === '22012' && !error.message.includes('division'),
    );
    const tables = (await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema]))
      .rows.map((row) => row.table_name);
    assert.ok(tables.includes('fixture_ok'), 'earlier file stays applied');
    assert.ok(!tables.includes('fixture_bad'), 'failed file schema change rolled back');
    const ledger = await client.query('SELECT filename FROM schema_migrations');
    assert.deepEqual(ledger.rows.map((row) => row.filename), ['0001_ok.sql']);
  } finally {
    await rm(directory, { recursive: true, force: true });
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
});

test('position migration preserves per-user creation order and accepts legacy inserts', {
  skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  const { runMigrations } = await import('./runner.js');
  const schema = `task_manager_test_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: database.href });
  const directory = await mkdtemp(join(tmpdir(), 'migrations-'));
  await client.connect();
  t.after(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await client.query(`CREATE SCHEMA ${schema}`);
  const migration = '0004_todo_position.sql';
  const source = new URL('./migrations/', import.meta.url);
  const copy = (name) => copyFile(new URL(name, source), join(directory, name));
  for (const name of (await readdir(source)).filter((name) => name.endsWith('.sql') && name < migration)) {
    await copy(name);
  }
  const options = { connectionString: database.href, directory: pathToFileURL(`${directory}/`), log: () => {} };
  await runMigrations(options);
  await client.query(`
    INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES
      ('a', 'A', 'a@example.test', now(), now()), ('b', 'B', 'b@example.test', now(), now());
    INSERT INTO todos (user_id, id, text, created_at, due, revision) VALUES
      ('a', '00000000-0000-0000-0000-000000000003', 'Later', 10, 1, 7),
      ('a', '00000000-0000-0000-0000-000000000002', 'Tie B', 2, NULL, 1),
      ('a', '00000000-0000-0000-0000-000000000001', 'Tie A', 2, NULL, 1),
      ('b', '00000000-0000-0000-0000-000000000001', 'Other user', -1, NULL, 1);
  `);
  const old = await client.query('SELECT user_id, text, due, revision FROM todos ORDER BY user_id, created_at, id');
  await copy(migration);
  assert.deepEqual(await runMigrations(options), [migration]);
  const backfilled = await client.query('SELECT user_id, text, due, revision, position FROM todos ORDER BY user_id, position');
  assert.ok(backfilled.rows.every(({ position }) => typeof position === 'string'));
  assert.deepEqual(backfilled.rows.map(({ position, ...row }) => row), old.rows);

  await client.query(`
    INSERT INTO todos (user_id, id, text, created_at)
    VALUES ('a', '00000000-0000-0000-0000-000000000004', 'Legacy insert', 11);
  `);
  const legacy = await client.query("SELECT position FROM todos WHERE text = 'Legacy insert'");
  assert.deepEqual(legacy.rows, [{ position: null }]);
});

const categoryMigration = '0005_categories.sql';
const migrations = new URL('./migrations/', import.meta.url);
const localDatabase = { skip: testUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' };
const alice = 'cli-alice@example.test';
const bob = 'cli-bob@example.test';
const bulk = 'cli-bulk@example.test';

async function withCategorySchema(check) {
  const { runMigrations } = await import('./runner.js');
  const schema = `task_manager_test_${randomBytes(8).toString('hex')}`;
  const database = new URL(testUrl);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: database.href });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await check(client, (directory) => runMigrations({ connectionString: database.href, directory, log: () => {} }));
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
}

async function insertUsers(client, users) {
  await client.query(`
    INSERT INTO "user" (id, name, email, "createdAt", "updatedAt")
    SELECT email, email, email, now(), now() FROM unnest($1::text[]) AS u(email)
  `, [users]);
}

test('0005 links valid first tags once and preserves legacy task data', localDatabase, async () => {
  await withCategorySchema(async (client, migrate) => {
    const directory = await mkdtemp(join(tmpdir(), 'migrations-'));
    const fixtureDirectory = pathToFileURL(`${directory}/`);
    try {
      for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql') && f < categoryMigration)) {
        await copyFile(new URL(file, migrations), new URL(file, fixtureDirectory));
      }
      await migrate(fixtureDirectory);
      await insertUsers(client, [alice, bob, bulk]);
      await client.query(`
        INSERT INTO todos (user_id, id, text, tags, created_at, revision, completed,
                           completed_until, due, repeat, notified, position) VALUES
          ($1, gen_random_uuid(), 'Meeting', '{work,home}', 1, 9, true, 7, 8, 'daily', 8, '000000000000000000008'),
          ($1, gen_random_uuid(), 'Report', '{Work}', 2, 3, false, NULL, NULL, 'none', NULL, NULL),
          ($1, gen_random_uuid(), 'No tags', '{}', 3, 1, true, NULL, NULL, 'none', NULL, NULL),
          ($1, gen_random_uuid(), 'Control', ARRAY['bad' || chr(1) || 'tag','home'], 4, 2, false, NULL, NULL, 'none', NULL, NULL),
          ($1, gen_random_uuid(), 'Null first', ARRAY[NULL,'home'], 5, 2, false, NULL, NULL, 'none', NULL, NULL),
          ($2, gen_random_uuid(), 'Other account', '{work}', 6, 1, false, NULL, NULL, 'none', NULL, NULL)
      `, [alice, bob]);
      const bulkNames = Array.from({ length: 55 }, (_, i) => `tag-${i + 1}`).sort();
      await client.query(`
        INSERT INTO todos (user_id, id, text, tags, created_at)
        SELECT $1, gen_random_uuid(), tag, ARRAY[tag], 10 FROM unnest($2::text[]) AS t(tag)
      `, [bulk, bulkNames]);

      const todos = async () => (await client.query('SELECT * FROM todos ORDER BY user_id, id')).rows;
      const categories = async () => (await client.query('SELECT * FROM categories ORDER BY user_id, id')).rows;
      const before = await todos();
      await copyFile(new URL(categoryMigration, migrations), new URL(categoryMigration, fixtureDirectory));
      assert.deepEqual(await migrate(fixtureDirectory), [categoryMigration]);

      const linked = await todos();
      assert.deepEqual(linked.map(({ category_id, ...row }) => row), before);
      const catalog = await categories();
      for (const [user, names] of [[alice, ['Work']], [bob, ['work']], [bulk, bulkNames]]) {
        assert.deepEqual(catalog.filter((c) => c.user_id === user).map((c) => c.name).sort(), names);
      }
      assert.equal(catalog.length, 57);
      for (const { id, revision } of catalog) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(revision, 1);
      }
      for (const todo of linked) {
        const first = todo.tags[0]?.toLowerCase();
        const expected = catalog.find((c) => c.user_id === todo.user_id && c.name.toLowerCase() === first);
        assert.equal(todo.category_id, expected?.id ?? null, todo.text);
      }

      const sql = await readFile(new URL(categoryMigration, migrations), 'utf8');
      const parts = sql.split('-- BACKFILL\n');
      assert.equal(parts.length, 2);
      const backfill = parts[1];
      await client.query(backfill);
      assert.deepEqual(await categories(), catalog);
      assert.deepEqual(await todos(), linked);

      await client.query(`
        INSERT INTO todos (user_id, id, text, tags, created_at) VALUES
          ($1, gen_random_uuid(), 'New work', '{work}', 11),
          ($1, gen_random_uuid(), 'New hobby', '{hobby}', 12)
      `, [alice]);
      await client.query(backfill);
      const updated = await categories();
      assert.deepEqual(updated.filter((c) => c.name !== 'hobby'), catalog);
      assert.equal(updated.length, catalog.length + 1);
      const tasks = await todos();
      assert.deepEqual(tasks.filter((t) => !t.text.startsWith('New ')), linked);
      for (const [title, name] of [['New work', 'Work'], ['New hobby', 'hobby']]) {
        assert.equal(tasks.find((t) => t.text === title).category_id,
          updated.find((c) => c.user_id === alice && c.name === name).id);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('category constraints enforce names, ownership and deletion semantics', localDatabase, async () => {
  await withCategorySchema(async (client, migrate) => {
    await migrate();
    await insertUsers(client, [alice, bob]);
    const createCategory = async (user, name) => (await client.query(`
      INSERT INTO categories (user_id, id, name) VALUES ($1, gen_random_uuid(), $2) RETURNING *
    `, [user, name])).rows[0];
    const a = await createCategory(alice, 'shared');
    const b = await createCategory(bob, 'shared');
    await assert.rejects(createCategory(alice, 'SHARED'), { code: '23505' });
    for (const name of ['', ' x', 'x'.repeat(49), 'bad\x01tag']) {
      await assert.rejects(createCategory(alice, name), { code: '23514' });
    }
    const insertTodo = async (user, categoryId) => (await client.query(`
      INSERT INTO todos (user_id, id, text, category_id, created_at)
      VALUES ($1, gen_random_uuid(), 'Tagged', $2, 1) RETURNING *
    `, [user, categoryId])).rows[0];
    await assert.rejects(insertTodo(alice, b.id), { code: '23503', constraint: 'todos_category_fk' });
    await insertTodo(alice, a.id);
    const survivor = await insertTodo(bob, b.id);

    const deleteCategory = () => client.query('DELETE FROM categories WHERE user_id = $1 AND id = $2', [bob, b.id]);
    await assert.rejects(deleteCategory(), { code: '23503', constraint: 'todos_category_fk' });
    await client.query('DELETE FROM "user" WHERE id = $1', [alice]);
    assert.deepEqual((await client.query('SELECT * FROM todos')).rows, [survivor]);
    assert.deepEqual((await client.query('SELECT * FROM categories')).rows, [b]);

    await client.query('UPDATE todos SET category_id = NULL WHERE user_id = $1 AND id = $2', [bob, survivor.id]);
    assert.equal((await deleteCategory()).rowCount, 1);
    assert.deepEqual((await client.query('SELECT * FROM todos')).rows, [{ ...survivor, category_id: null }]);
  });
});
