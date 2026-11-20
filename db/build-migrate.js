import { fileURLToPath } from 'node:url';
import { MigrationError, runMigrations } from './runner.js';

// Production applies (and a failure fails the build, so the new code never deploys).
// Preview shares the production database, so it only reports and never fails or writes.
// A plain local run (none of VERCEL, CI or VERCEL_ENV set) does nothing; use `npm run db:migrate`.
// Fail closed: on any hosted build, a missing or unknown VERCEL_ENV is an error, never a skip.
export function modeFor(env) {
  if (env.VERCEL_ENV === 'production') return 'apply';
  if (env.VERCEL_ENV === 'preview') return 'check';
  if (!env.VERCEL && !env.CI && !env.VERCEL_ENV) return 'skip';
  throw new MigrationError('environment check', { detail: 'Hosted build with a missing or unsupported VERCEL_ENV (expected production or preview); refusing to skip migrations.' });
}

const safe = (error) => (error?.name === 'MigrationError' ? error.message : 'Migration step failed.');

export async function buildMigrate({ env = process.env, run = runMigrations, log = console.log, warn = console.warn } = {}) {
  const mode = modeFor(env);
  if (mode === 'skip') {
    log('Skipping migrations (local build).');
    return mode;
  }
  const connectionString = env.DATABASE_URL_UNPOOLED;
  if (mode === 'apply') {
    await run({ connectionString, apply: true, log }); // throws on any failure
    return mode;
  }
  try {
    const pending = await run({ connectionString, apply: false, log });
    if (pending.length) {
      warn(`WARNING: ${pending.length} pending migration(s) not applied (Preview never applies; they run when this merges to production): ${pending.join(', ')}`);
    } else {
      log('No pending migrations.');
    }
  } catch (error) {
    warn(`WARNING: could not check migrations on Preview: ${safe(error)}`);
  }
  return mode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await buildMigrate();
  } catch (error) {
    // Controlled messages only: pg connection errors can echo connection options.
    console.error(`Migration failed, aborting build: ${safe(error)}`);
    process.exitCode = 1;
  }
}
