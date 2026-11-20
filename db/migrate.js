import { runMigrations } from './runner.js';

try {
  await runMigrations();
} catch (error) {
  // Migration errors carry controlled messages only; never print anything else (it may echo the URL).
  console.error(error.name === 'MigrationError' ? error.message : 'Migration failed.');
  process.exitCode = 1;
}
