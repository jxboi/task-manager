import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element, installDom } from './dom.js';
import { settle } from './fake-api.js';

const ana = { user: { name: 'Ana', email: 'ana@example.test' }, csrfToken: 'token-a' };
const ben = { user: { name: 'Ben', email: 'ben@example.test' }, csrfToken: 'token-b' };
const signedOut = { user: null, csrfToken: null };

test('auth module follows session changes from other tabs', async (t) => {
  // Each /api/session read waits until the test answers it, in any order.
  const reads = [];
  const fetch = async (path) => {
    assert.equal(new URL(path, 'http://localhost').pathname, '/api/session');
    const body = await new Promise((resolve) => reads.push(resolve));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const answer = async (index, body) => {
    for (let i = 0; i < 20 && !reads[index]; i++) await settle(1);
    assert.ok(reads[index], `session read #${index} was made`);
    reads[index](body);
    await settle();
  };
  const { byId, matchMedia } = installDom(t, { fetch });
  globalThis.matchMedia = matchMedia; // auth.js calls it unqualified
  t.after(() => delete globalThis.matchMedia);

  // What auth.js finds inside elements that the flat DOM stub doesn't nest.
  const radios = ['signin', 'signup'].map((value) => Object.assign(new Element(), { tagName: 'input', value, checked: false }));
  byId('auth-view').querySelectorAll = () => radios;
  byId('auth-submit').querySelector = () => new Element();
  byId('auth-loading').firstElementChild = new Element();
  document.visibilityState = 'visible';
  const channels = [];
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      channels.push(this);
    }
    postMessage() {}
  };
  t.after(() => delete globalThis.BroadcastChannel);

  const sessions = [];
  const invalidations = [];
  window.addEventListener('tasks:session', ({ detail }) => sessions.push(detail.active?.user?.email ?? null));
  window.addEventListener('tasks:invalidate', () => invalidations.push(true));

  await import('../src/auth.js');
  const [channel] = channels;
  const broadcast = () => channel.dispatchEvent(new Event('message'));
  const signedInAs = (name) => {
    assert.equal(byId('auth-view').hidden, true);
    assert.equal(byId('task-view').hidden, false);
    assert.equal(byId('account-name').textContent, name);
  };

  await answer(0, ana);
  assert.deepEqual(sessions, ['ana@example.test']);
  signedInAs('Ana');

  await t.test('item 1: a delayed signed-out read superseded by a newer sign-in does not strand the tab', async () => {
    broadcast(); // another tab signed out...
    assert.equal(invalidations.length, 1); // the list is hidden at once
    broadcast(); // ...and then signed in as Ben, while the first read is still on its way
    await answer(1, signedOut); // the late answer from before Ben signed in
    // That result was superseded: the tab doesn't settle on it, it reads again.
    assert.equal(byId('auth-view').hidden, true);
    await answer(2, ben);
    assert.equal(sessions.at(-1), 'ben@example.test');
    assert.ok(!sessions.slice(1).includes(null), 'never shown as signed out on the stale read');
    signedInAs('Ben');
  });

  await t.test('item 1: the follow-up read runs even when the earlier read came back signed out', async () => {
    broadcast(); // another tab signed out
    await answer(3, signedOut);
    assert.equal(byId('auth-view').hidden, false);
    assert.equal(sessions.at(-1), null);
    // This tab is now on the sign-in form: a later sign-in elsewhere leaves the form alone.
    broadcast();
    await settle();
    assert.equal(reads.length, 4);
  });

  await t.test('item 1: a focus check whose read predates a change is discarded', async () => {
    // Sign back in here (the form's own path).
    byId('auth-retry-button').click();
    await answer(4, ana);
    signedInAs('Ana');
    window.dispatchEvent(new Event('focus')); // read #5 starts
    broadcast(); // another tab switched to Ben: read #6 starts
    await answer(5, ana); // the old answer: ignored
    assert.equal(sessions.at(-1), 'ana@example.test');
    await answer(6, ben);
    assert.equal(sessions.at(-1), 'ben@example.test');
    signedInAs('Ben');
  });
});
