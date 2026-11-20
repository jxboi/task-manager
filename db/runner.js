import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('task-manager.schema_migrations'))";
const defaultDirectory = new URL('./migrations/', import.meta.url);

export function validateConnectionString(raw) {
  const connectionString = raw?.trim();
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
  return connectionString;
}

async function listFiles(directory) {
  return (await readdir(directory))
    .filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name))
    .sort();
}

/**
 * Applies pending migrations (default) or, with { apply: false }, only reports them.
 * Check mode is read-only: it takes no lock and creates nothing.
 * Returns the list of pending (check) or newly applied (apply) filenames.
 */
export async function runMigrations({
  connectionString: raw = process.env.DATABASE_URL_UNPOOLED,
  directory = defaultDirectory,
  apply = true,
  log = console.log,
} = {}) {
  const connectionString = validateConnectionString(raw);
  const files = await listFiles(directory);
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    if (!apply) {
      const exists = (await client.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t;
      const applied = new Set(exists
        ? (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
        : []);
      return files.filter((filename) => !applied.has(filename));
    }

    // The lock spans all file transactions. Closing this connection releases it.
    await client.query(LOCK_SQL);
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
      log(`Applied ${filename}`);
    }
    if (pending.length === 0) log('No pending migrations.');
    return pending;
  } finally {
    await client.end();
  }
}
