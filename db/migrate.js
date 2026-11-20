import { runMigrations } from './runner.js';

try {
  await runMigrations();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
