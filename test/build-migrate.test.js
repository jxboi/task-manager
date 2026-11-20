import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMigrate, modeFor } from '../db/build-migrate.js';

const harness = (result) => {
  const calls = [], logs = [], warns = [];
  const run = async (options) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result ?? [];
  };
  return { calls, logs, warns, opts: (env) => ({ env, run, log: (m) => logs.push(m), warn: (m) => warns.push(m) }) };
};

test('modeFor branches on VERCEL_ENV', () => {
  assert.equal(modeFor({ VERCEL_ENV: 'production' }), 'apply');
  assert.equal(modeFor({ VERCEL_ENV: 'preview' }), 'check');
  assert.equal(modeFor({ VERCEL_ENV: 'development' }), 'skip');
  assert.equal(modeFor({}), 'skip');
});

test('local or unset VERCEL_ENV never touches the database', async () => {
  const h = harness();
  assert.equal(await buildMigrate(h.opts({ DATABASE_URL_UNPOOLED: 'x' })), 'skip');
  assert.equal(h.calls.length, 0);
});

test('production applies with the unpooled URL', async () => {
  const h = harness();
  await buildMigrate(h.opts({ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: 'u' }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].apply, true);
  assert.equal(h.calls[0].connectionString, 'u');
});

test('production failure propagates so the build fails', async () => {
  const h = harness(new Error('0004_x.sql: boom'));
  await assert.rejects(buildMigrate(h.opts({ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: 'u' })), /boom/);
});

test('preview only checks, warns on pending, and never throws', async () => {
  const h = harness(['0004_x.sql']);
  await buildMigrate(h.opts({ VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: 'u' }));
  assert.equal(h.calls[0].apply, false);
  assert.match(h.warns[0], /0004_x\.sql/);
  const failing = harness(new Error('connect refused'));
  await buildMigrate(failing.opts({ VERCEL_ENV: 'preview' }));
  assert.match(failing.warns[0], /connect refused/);
});
