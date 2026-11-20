import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { listMigrationFiles } from '../db/runner.js';
import { assertSchemaCurrent, resetSchemaGuard } from '../server/schema-guard.js';

async function fixture(names) {
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  for (const name of names) await writeFile(join(dir, name), 'SELECT 1;');
  return { dir, url: pathToFileURL(`${dir}/`) };
}

const poolWith = (applied, calls = []) => ({
  calls,
  async query(sql) {
    calls.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ t: applied ? 'schema_migrations' : null }] };
    return { rows: (applied ?? []).map((filename) => ({ filename })) };
  },
});

test('rejects misnamed .sql files but ignores other files', async () => {
  const { dir, url } = await fixture(['0001_a.sql', 'README.md']);
  try {
    assert.deepEqual(await listMigrationFiles(url), ['0001_a.sql']);
    await writeFile(join(dir, '2_bad.sql'), '');
    await writeFile(join(dir, '0003_Upper.SQL'), '');
    await assert.rejects(listMigrationFiles(url), /filename check failed \(0003_Upper\.SQL, 2_bad\.sql\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('guard returns 503 naming missing migrations, and caches success', async () => {
  const { dir, url } = await fixture(['0001_a.sql', '0002_b.sql']);
  try {
    resetSchemaGuard();
    await assert.rejects(assertSchemaCurrent(poolWith(['0001_a.sql']), url),
      (e) => e.status === 503 && e.code === 'SCHEMA_OUT_OF_DATE' && e.message.includes('0002_b.sql') && !e.message.includes('0001_a'));
    await assert.rejects(assertSchemaCurrent(poolWith(null), url), (e) => e.status === 503 && /0001_a\.sql, 0002_b\.sql/.test(e.message));
    const calls = [];
    const pool = poolWith(['0001_a.sql', '0002_b.sql'], calls);
    await assertSchemaCurrent(pool, url);
    const after = calls.length;
    await assertSchemaCurrent(pool, url);
    assert.equal(calls.length, after, 'no queries after the first success');
  } finally {
    resetSchemaGuard();
    await rm(dir, { recursive: true, force: true });
  }
});
