import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

async function migrate() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!connectionString) {
    throw new Error('Set DATABASE_URL_UNPOOLED to the target database’s direct PostgreSQL URL.');
  }

  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      !(target.hostname || target.searchParams.get('host')) ||
      !(target.pathname.length > 1 || target.searchParams.get('database'))) {
    throw new Error('DATABASE_URL_UNPOOLED must specify a PostgreSQL host and database.');
  }
  if (target.hostname.endsWith('.neon.tech') && target.hostname.split('.')[0].endsWith('-pooler')) {
    throw new Error('DATABASE_URL_UNPOOLED must use a direct Neon endpoint.');
  }

  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name))
    .sort();
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    // The lock spans all file transactions. Closing this connection releases it.
    await client.query("SELECT pg_advisory_lock(hashtext('task-manager.schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(({ filename }) => filename));
    const pending = files.filter((filename) => !applied.has(filename));

    for (const filename of pending) {
      const sql = await readFile(new URL(filename, directory), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${filename}: ${error.message}`);
      }
      console.log(`Applied ${filename}`);
    }
    if (pending.length === 0) console.log('No pending migrations.');
  } finally {
    await client.end();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
