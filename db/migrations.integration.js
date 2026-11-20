import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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
