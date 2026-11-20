import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';

const sessionA = { user: { name: 'Ana', email: 'ana@example.test' }, csrfToken: 'token-a' };
const sessionB = { user: { name: 'Ben', email: 'ben@example.test' }, csrfToken: 'token-b' };
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, text, extra = {}) => ({
  id: ID(n), text, completed: false, createdAt: n, tags: [], due: null, repeat: 'none', notified: null, revision: 1, ...extra,
});

test('task view against the server API', async (t) => {
  // One fake server per account; the cookie decides which one answers.
  const servers = { a: createFakeApi({ ...sessionA }), b: createFakeApi({ ...sessionB }) };
  let cookie = 'a';
  let gate = null; // when set, requests wait for it
  const fetch = async (...args) => {
    if (gate) await gate;
    return servers[cookie].fetch(...args);
  };
  const { byId, list } = installDom(t, { fetch });
  const events = [];
  await import('../src/app.js');
  for (const type of ['tasks:expired', 'tasks:revalidate']) window.addEventListener(type, () => events.push(type));
  const signIn = (active) => window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active } }));

  const input = byId('new-todo');
  const summary = byId('summary');
  const note = byId('sync-note');
  const texts = () => list.children.map((item) => item.querySelector('.todo-text').textContent);
  const rowOf = (text) => list.children.find((item) => item.querySelector('.todo-text').textContent === text);
  const event = (target, type) => {
    const value = new Event(type);
    Object.defineProperty(value, 'target', { value: target });
    return value;
  };
  const add = async (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    byId('add-form').dispatchEvent(new Event('submit'));
    await settle();
  };
  const toggle = async (text) => {
    list.dispatchEvent(event(rowOf(text).querySelector('.todo-checkbox'), 'change'));
    await settle();
  };

  await t.test('signed out: nothing is shown and nothing is requested', async () => {
    await settle();
    assert.deepEqual(texts(), []);
    assert.equal(byId('add-button').disabled, true);
    assert.equal(servers.a.requests.length, 0);
  });

  await t.test('signing in shows a loading state, then the server list', async () => {
    servers.a.rows = [row(1, 'Existing', { tags: ['home'] })];
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    signIn(sessionA);
    await settle(1);
    assert.equal(summary.textContent, 'Loading your tasks…');
    assert.equal(byId('empty-state').hidden, true);
    assert.equal(byId('add-button').disabled, true);
    gate = null;
    open();
    await settle();
    assert.deepEqual(texts(), ['Existing']);
    assert.equal(summary.textContent, '1 to do');
    assert.equal(servers.a.requests[0].headers['X-CSRF-Token'], 'token-a');
  });

  await t.test('adding parses inline tags and saves to the server', async () => {
    await add('Pay rent #bills');
    assert.equal(input.value, '');
    assert.deepEqual(texts(), ['Existing', 'Pay rent']);
    const saved = servers.a.rows.at(-1);
    assert.equal(saved.text, 'Pay rent');
    assert.deepEqual(saved.tags, ['bills']);
  });

  await t.test('an active filter tags new tasks, and filters reset is in memory only', async () => {
    const chip = byId('filter-bar').children.find((item) => item.dataset.tag === 'home');
    chip.click();
    assert.deepEqual(texts(), ['Existing']);
    await add('Fix tap');
    assert.deepEqual(servers.a.rows.at(-1).tags, ['home']);
    assert.deepEqual(texts(), ['Existing', 'Fix tap']);
    byId('clear-filters').click();
    assert.equal(texts().length, 3);
  });

  await t.test('completing saves; a revision conflict reloads and asks to try again', async () => {
    await toggle('Existing');
    assert.equal(servers.a.rows[0].completed, true);
    // Another tab renames nothing but bumps the row.
    servers.a.rows = servers.a.rows.map((item, i) => (i === 0 ? { ...item, tags: ['home', 'other'], revision: item.revision + 5 } : item));
    await toggle('Existing');
    assert.equal(note.hidden, false);
    assert.match(byId('sync-text').textContent, /changed in another tab/);
    assert.equal(byId('sync-retry').hidden, true);
    // The list was reloaded: the other tab's tag shows, and the toggle didn't apply.
    assert.deepEqual(rowOf('Existing').querySelectorAll('.tag-label').map((label) => label.dataset.tag), ['home', 'other']);
    assert.equal(servers.a.rows[0].completed, true);
    byId('sync-dismiss').click();
    assert.equal(note.hidden, true);
  });

  await t.test('a failed save rolls back and Try again repeats it', async () => {
    servers.a.failNext = () => new TypeError('Failed to fetch');
    await toggle('Pay rent');
    assert.equal(rowOf('Pay rent').className.includes('is-done'), false);
    assert.equal(note.hidden, false);
    assert.equal(byId('sync-retry').hidden, false);
    byId('sync-retry').click();
    await settle();
    assert.equal(note.hidden, true);
    assert.equal(servers.a.rows.find((item) => item.text === 'Pay rent').completed, true);
  });

  await t.test('a create whose answer was lost keeps the draft and re-adding does not duplicate', async () => {
    servers.a.failNext = () => ({ afterWrite: true });
    await add('Call Sam');
    assert.equal(input.value, 'Call Sam');
    assert.match(byId('sync-text').textContent, /press Add to try again/);
    const count = servers.a.rows.length;
    byId('add-form').dispatchEvent(new Event('submit'));
    await settle();
    assert.equal(servers.a.rows.length, count);
    assert.equal(servers.a.rows.filter((item) => item.text === 'Call Sam').length, 1);
    assert.equal(texts().filter((text) => text === 'Call Sam').length, 1);
    assert.equal(input.value, '');
  });

  await t.test('a reminder due while open is claimed once: none alerts if another tab claimed it', async () => {
    const due = Date.now() + 40;
    servers.a.rows = [...servers.a.rows, row(90, 'Standup', { due, repeat: 'daily', createdAt: 90 })];
    signIn(sessionA); // same session: reloads, as on return to the tab
    await settle();
    assert.ok(texts().includes('Standup'));
    // The other tab claims first.
    servers.a.rows = servers.a.rows.map((item) => (item.id === ID(90) ? { ...item, notified: due, revision: 2 } : item));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    assert.doesNotMatch(byId('announcer').textContent ?? '', /Standup/);
    assert.equal(rowOf('Standup').className.includes('is-fired'), false);
    assert.match(rowOf('Standup').className, /is-overdue/);
    // This tab did try: the server refused the second claim of the same occurrence.
    const claims = servers.a.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(ID(90)));
    assert.equal(claims.length, 1);
    assert.equal(JSON.parse(claims[0].body).action, 'markNotified');
  });

  await t.test('a reminder due while open alerts after this tab claims it', async () => {
    const due = Date.now() + 40;
    servers.a.rows = [...servers.a.rows, row(91, 'Stretch', { due, createdAt: 91 })];
    signIn(sessionA);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    assert.equal(byId('announcer').textContent, 'Reminder due: Stretch');
    assert.equal(servers.a.rows.find((item) => item.id === ID(91)).notified, due);
  });

  await t.test('a 401 sends the view back to sign-in; a CSRF rejection re-reads the session', async () => {
    servers.a.session = { user: null, csrfToken: null };
    await toggle('Pay rent');
    assert.deepEqual(events, ['tasks:expired']);
    servers.a.session = { ...sessionA, csrfToken: 'token-a2' };
    await toggle('Pay rent');
    assert.deepEqual(events, ['tasks:expired', 'tasks:revalidate']);
    servers.a.session = { ...sessionA };
    byId('sync-dismiss').click();
  });

  await t.test('signing out clears rows, filters, drafts and editors; late answers are ignored', async () => {
    byId('filter-bar').children.find((item) => item.dataset.tag === 'home').click();
    input.value = 'half-typed';
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    list.dispatchEvent(event(rowOf('Existing').querySelector('.todo-checkbox'), 'change'));
    signIn(null);
    gate = null;
    open();
    await settle();
    assert.deepEqual(texts(), []);
    assert.equal(input.value, '');
    assert.equal(byId('clear-filters').hidden, true);
    assert.equal(byId('filter-wrap').hidden, true);
    assert.equal(byId('reminder-layer').hidden, true);
    assert.equal(note.hidden, true);
  });

  await t.test('the next account on the same browser sees only its own list', async () => {
    cookie = 'b';
    signIn(sessionB);
    await settle();
    assert.deepEqual(texts(), []);
    assert.equal(byId('empty-state').hidden, false);
    assert.equal(summary.textContent, 'Nothing to do yet');
    await add('Ben only');
    assert.deepEqual(texts(), ['Ben only']);
    assert.equal(servers.a.rows.some((item) => item.text === 'Ben only'), false);
  });

  await t.test('a stale tab switched to another account resets and says so', async () => {
    cookie = 'a';
    signIn(sessionA);
    await settle();
    assert.equal(texts().includes('Ben only'), false);
    assert.ok(texts().includes('Existing'));
    assert.match(byId('sync-text').textContent, /signed in as Ana/);
  });

  await t.test('a list that fails to load shows an error and Try again', async () => {
    signIn(null);
    servers.a.failNext = () => new Response('{}', { status: 500 });
    signIn({ ...sessionA, csrfToken: 'token-a3' });
    servers.a.session = { ...sessionA, csrfToken: 'token-a3' };
    await settle();
    assert.equal(summary.textContent, "Couldn't load your tasks");
    assert.equal(byId('sync-retry').hidden, false);
    assert.equal(byId('empty-state').hidden, true);
    byId('sync-retry').click();
    await settle();
    assert.ok(texts().includes('Existing'));
    assert.equal(note.hidden, true);
    signIn(null); // no timers left running
  });
});
