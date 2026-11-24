import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('0006 sets transaction-local lock and statement timeouts first', async () => {
  const sql = await readFile(new URL('../db/migrations/0006_tags_to_categories.sql', import.meta.url), 'utf8');
  assert.deepEqual(sql.split(/\r?\n/, 2), [
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '30s';",
  ]);
});
