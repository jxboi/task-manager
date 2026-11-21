import assert from 'node:assert/strict';
import { test } from 'node:test';
import demo from '../api/auth/demo.js';
import { isDemoLoginEnabled } from '../server/demo-login.js';

for (const value of [undefined, '', 'production', 'development', 'Preview', ' preview', 'staging', 'preview']) {
  test(`demo gate with VERCEL_ENV=${JSON.stringify(value)}`, () => {
    assert.equal(isDemoLoginEnabled({ VERCEL_ENV: value }), value === 'preview');
  });
}

test('disabled demo route returns an empty 404 before loading services', async (t) => {
  const previous = process.env.VERCEL_ENV;
  delete process.env.VERCEL_ENV;
  t.after(() => {
    if (previous !== undefined) process.env.VERCEL_ENV = previous;
  });

  for (const method of ['GET', 'POST']) {
    const response = await demo.fetch(new Request('http://localhost/api/auth/demo', { method }));
    assert.equal(response.status, 404);
    assert.equal(response.headers.has('Set-Cookie'), false);
    assert.equal(await response.text(), '');
  }
});
