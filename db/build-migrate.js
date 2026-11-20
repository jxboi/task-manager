import { fileURLToPath } from 'node:url';
import { runMigrations } from './runner.js';

// Production applies (and a failure fails the build, so the new code never deploys).
// Preview shares the production database, so it only reports and never fails or writes.
// Anything else (local, CI, no VERCEL_ENV) does nothing; use `npm run db:migrate` there.
export function modeFor(env) {
  if (env.VERCEL_ENV === 'production') return 'apply';
  if (env.VERCEL_ENV === 'preview') return 'check';
  return 'skip';
}

export async function buildMigrate({ env = process.env, run = runMigrations, log = console.log, warn = console.warn } = {}) {
  const mode = modeFor(env);
  if (mode === 'skip') {
    log('Skipping migrations (VERCEL_ENV is not production or preview).');
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
    warn(`WARNING: could not check migrations on Preview: ${error.message}`);
  }
  return mode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await buildMigrate();
  } catch (error) {
    console.error(`Migration failed, aborting build: ${error.message}`);
    process.exitCode = 1;
  }
}
