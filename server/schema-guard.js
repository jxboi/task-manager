import { listMigrationFiles } from '../db/runner.js';
import { RequestError } from './http.js';

let verified; // cached promise; only successes stay cached

/**
 * Read-only check, once per function instance: every file in db/migrations must be in
 * schema_migrations. Covers buildless releases (rollback, --prebuilt) that skip the build step.
 */
export function assertSchemaCurrent(pool, directory) {
  verified ??= check(pool, directory).catch((error) => {
    verified = undefined; // retry on the next request
    throw error;
  });
  return verified;
}

async function check(pool, directory) {
  const files = await listMigrationFiles(directory);
  const { rows: [{ t }] } = await pool.query("SELECT to_regclass('schema_migrations') AS t");
  const applied = new Set(t
    ? (await pool.query('SELECT filename FROM schema_migrations')).rows.map((row) => row.filename)
    : []);
  const missing = files.filter((name) => !applied.has(name));
  if (missing.length) {
    throw new RequestError(503, 'SCHEMA_OUT_OF_DATE', `Database migrations are missing: ${missing.join(', ')}. Run the migrations and retry.`);
  }
}

export function resetSchemaGuard() {
  verified = undefined;
}
