import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAuthOrigins } from '../server/auth-origins.js';

const deployment = 'tasks-abc123.vercel.app';
const branch = 'tasks-git-feature.vercel.app';

test('Preview trusts exactly the deployment and branch HTTPS origins', () => {
  assert.deepEqual(resolveAuthOrigins({
    VERCEL_ENV: 'preview',
    VERCEL_URL: deployment,
    VERCEL_BRANCH_URL: branch,
    BETTER_AUTH_URL: 'https://production.example',
  }), [`https://${deployment}`, `https://${branch}`]);
});

test('Preview can run without a branch URL', () => {
  assert.deepEqual(resolveAuthOrigins({
    VERCEL_ENV: 'preview',
    VERCEL_URL: deployment,
  }), [`https://${deployment}`]);
});

test('Preview rejects wildcard and malformed hostnames', () => {
  for (const host of ['*.vercel.app', 'https://unrelated.vercel.app', 'tasks.vercel.app/path']) {
    assert.throws(() => resolveAuthOrigins({
      VERCEL_ENV: 'preview', VERCEL_URL: deployment, VERCEL_BRANCH_URL: host,
    }));
  }
});

test('Production requires and only trusts the configured HTTPS origin', () => {
  const env = { VERCEL_ENV: 'production', VERCEL_URL: deployment, VERCEL_BRANCH_URL: branch };
  assert.deepEqual(resolveAuthOrigins({
    ...env, BETTER_AUTH_URL: 'https://tasks.example/',
  }), ['https://tasks.example']);
  assert.throws(() => resolveAuthOrigins(env));
  assert.throws(() => resolveAuthOrigins({ ...env, BETTER_AUTH_URL: 'http://localhost:3000' }));
});

test('Local development continues to accept a configured localhost HTTP origin', () => {
  const env = { VERCEL_ENV: 'development', VERCEL_BRANCH_URL: branch };
  assert.deepEqual(resolveAuthOrigins({ ...env, BETTER_AUTH_URL: 'http://localhost:3000' }), ['http://localhost:3000']);
  assert.throws(() => resolveAuthOrigins({ ...env, BETTER_AUTH_URL: 'http://tasks.example' }));
});
