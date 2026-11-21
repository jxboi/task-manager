import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    for (const table of ['user', 'session', 'account', 'verification', 'rateLimit', 'todos']) {
      assert.ok(tables.rows.some(({ table_name }) => table_name === table), `Missing ${table}`);
    }
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
      ('a', 'A', 'a@example.test', now(), now()), ('b', 'B', 'b@example.test', now());
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
