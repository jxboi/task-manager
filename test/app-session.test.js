import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';
import { categoryColor } from '../src/tags.js';

const sessionA = { user: { name: 'Ana', email: 'ana@example.test' }, csrfToken: 'token-a' };
const sessionB = { user: { name: 'Ben', email: 'ben@example.test' }, csrfToken: 'token-b' };
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, text, extra = {}) => ({
  id: ID(n), text, completed: false, createdAt: n, tags: [], categoryId: null, due: null, repeat: 'none', notified: null,
  revision: 1, ...extra,
});
const HOME = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
  // Desktop notifications the app opens, so teardown can be checked.
  const notifications = [];
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title) {
      this.title = title;
      this.closed = false;
      notifications.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  };
  const events = [];
  await import('../src/app.js');
  for (const type of ['tasks:expired', 'tasks:revalidate']) window.addEventListener(type, () => events.push(type));
  const signIn = (active) => window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active } }));

  const input = byId('new-todo');
  const summary = byId('summary');
  const note = byId('sync-note');
  // Task rows only: while loading the list holds skeleton rows.
  // The task sheet's picker: the Reminder switch on, then Date and Time.
  const setWhen = (value) => {
    const [day, clock] = value.split('T');
    const on = byId('reminder-on');
    if (!on.checked) {
      on.checked = true;
      on.dispatchEvent(new Event('change'));
    }
    byId('reminder-date').value = day;
    byId('reminder-time').value = clock;
    byId('reminder-time').dispatchEvent(new Event('input'));
  };
  const rows = () => list.children.filter((item) => item.className.split(' ').includes('todo'));
  const texts = () => rows().map((item) => item.querySelector('.todo-text').textContent);
  const rowOf = (text) => rows().find((item) => item.querySelector('.todo-text').textContent === text);
  const event = (target, type) => {
    const value = new Event(type);
    Object.defineProperty(value, 'target', { value: target });
    return value;
  };
  const add = async (value) => {
    const form = byId('add-form');
    if (form.hidden) byId('add-toggle').click();
    assert.equal(form.hidden, false, 'the composer is visible');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    assert.equal(byId('add-button').disabled, false, 'Add is enabled');
    form.dispatchEvent(new Event('submit'));
    await settle();
  };
  const selectFilter = (value) => {
    byId('category-filter').value = value;
    byId('category-filter').dispatchEvent(new Event('change'));
  };
  const categoryOf = (text) => rowOf(text).querySelector('.todo-category')?.textContent ?? null;
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
    servers.a.categories = [{ id: HOME, name: 'Home', revision: 1 }];
    servers.a.rows = [row(1, 'Existing', { categoryId: HOME })];
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    signIn(sessionA);
    await settle(1);
    assert.equal(summary.textContent, 'Loading your tasks');
    assert.equal(byId('empty-state').hidden, true);
    assert.equal(byId('add-button').disabled, true);
    gate = null;
    open();
    await settle();
    assert.deepEqual(texts(), ['Existing']);
    // The card names its category and takes the color hashed from the name.
    assert.equal(categoryOf('Existing'), 'Home');
    assert.equal(rowOf('Existing').dataset.color, categoryColor('Home'));
    assert.equal(byId('category-row').hidden, false);
    assert.deepEqual(byId('category-filter').children.map((option) => option.textContent),
      ['All categories', 'Uncategorized', 'Home']);
    // No count text once the list is shown.
    assert.equal(summary.textContent, '');
    assert.equal(servers.a.requests[0].headers['X-CSRF-Token'], 'token-a');
  });

  await t.test('adding keeps a "#word" as title text, sends no tags and starts uncategorized', async () => {
    await add('Pay rent #bills');
    assert.equal(input.value, '');
    assert.deepEqual(texts(), ['Existing', 'Pay rent #bills']);
    const saved = servers.a.rows.at(-1);
    assert.equal(saved.text, 'Pay rent #bills');
    assert.deepEqual(saved.tags, []);
    assert.equal(saved.categoryId, null);
    const post = servers.a.requests.findLast((request) => request.method === 'POST');
    assert.deepEqual(Object.keys(JSON.parse(post.body)), ['id', 'text']);
    // No tag chip, no category label, no shelf color.
    assert.equal(rowOf('Pay rent #bills').querySelector('.tag'), null);
    assert.equal(categoryOf('Pay rent #bills'), null);
    assert.equal(rowOf('Pay rent #bills').dataset.color, undefined);
  });

  await t.test('the Category filter shows All, Uncategorized or one category; new tasks go to Uncategorized', async () => {
    selectFilter(HOME);
    assert.deepEqual(texts(), ['Existing']);
    assert.equal(byId('app-title').textContent, 'Home');
    assert.equal(byId('add-shelf').hidden, false);
    assert.equal(byId('add-shelf').textContent, 'New tasks go to Uncategorized.');
    await add('Fix tap');
    assert.equal(servers.a.rows.at(-1).categoryId, null);
    assert.deepEqual(texts(), ['Existing'], 'the new task is not in this category');
    assert.equal(byId('announcer').textContent, 'Added “Fix tap” to Uncategorized.');
    selectFilter('none');
    assert.deepEqual(texts(), ['Pay rent #bills', 'Fix tap']);
    assert.equal(byId('add-shelf').hidden, true);
    assert.equal(byId('app-title').textContent, 'Tasks');
    selectFilter('all');
    assert.equal(texts().length, 3);
    assert.equal(byId('filter-empty').hidden, true);
  });

  await t.test('completing saves; a revision conflict reloads and asks to try again', async () => {
    await toggle('Existing');
    assert.equal(servers.a.rows[0].completed, true);
    // Another tab renames the task's category and bumps the row.
    servers.a.categories = [{ id: HOME, name: 'House', revision: 2 }];
    servers.a.rows = servers.a.rows.map((item, i) => (i === 0 ? { ...item, revision: item.revision + 5 } : item));
    await toggle('Existing');
    assert.equal(note.hidden, false);
    assert.match(byId('sync-text').textContent, /changed in another tab/);
    assert.equal(byId('sync-retry').hidden, true);
    // The list was reloaded: the other tab's name shows, and the toggle didn't apply.
    assert.equal(categoryOf('Existing'), 'House');
    assert.equal(byId('category-filter').children.at(-1).textContent, 'House');
    assert.equal(servers.a.rows[0].completed, true);
    byId('sync-dismiss').click();
    assert.equal(note.hidden, true);
  });

  await t.test('a failed save rolls back and Try again repeats it', async () => {
    servers.a.failNext = () => new TypeError('Failed to fetch');
    await toggle('Pay rent #bills');
    assert.equal(rowOf('Pay rent #bills').className.includes('is-done'), false);
    assert.equal(note.hidden, false);
    assert.equal(byId('sync-retry').hidden, false);
    byId('sync-retry').click();
    await settle();
    assert.equal(note.hidden, true);
    assert.equal(servers.a.rows.find((item) => item.text === 'Pay rent #bills').completed, true);
  });

  await t.test('a create whose answer was lost keeps the draft and re-adding does not duplicate', async () => {
    servers.a.failNext = () => ({ afterWrite: true });
    await add('Call Sam');
    assert.equal(input.value, 'Call Sam');
    assert.equal(byId('sync-text').textContent, "Couldn't add “Call Sam”.");
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
    await toggle('Pay rent #bills');
    assert.deepEqual(events, ['tasks:expired']);
    servers.a.session = { ...sessionA, csrfToken: 'token-a2' };
    await toggle('Pay rent #bills');
    assert.deepEqual(events, ['tasks:expired', 'tasks:revalidate']);
    // The list stays hidden while the session is re-read.
    assert.deepEqual(texts(), []);
    assert.equal(summary.textContent, 'Loading your tasks');
    servers.a.session = { ...sessionA };
    signIn(sessionA); // the auth module found the same session
    await settle();
    assert.ok(texts().includes('Pay rent #bills'));
    assert.match(byId('sync-text').textContent, /blocked/);
    byId('sync-dismiss').click();
  });

  await t.test('item 1: another tab changing the session hides the list at once and ignores late answers', async () => {
    const before = texts();
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    list.dispatchEvent(event(rowOf('Pay rent #bills').querySelector('.todo-checkbox'), 'change'));
    // auth.js got a BroadcastChannel message from another tab.
    window.dispatchEvent(new CustomEvent('tasks:invalidate'));
    assert.deepEqual(texts(), []);
    assert.equal(summary.textContent, 'Loading your tasks');
    assert.equal(byId('add-button').disabled, true);
    gate = null;
    open(); // the already-authorized answer arrives: ignored
    await settle();
    assert.deepEqual(texts(), []);
    assert.equal(note.hidden, true);
    signIn(sessionA); // the session re-read: still Ana
    await settle();
    assert.deepEqual(texts().sort(), before.sort());
  });

  await t.test('item 6: a failed delete brings the row back with its reminder timer re-armed', async () => {
    const due = Date.now() + 120;
    servers.a.rows = [...servers.a.rows, row(92, 'Ping', { due, createdAt: 92 })];
    signIn(sessionA);
    await settle();
    servers.a.failNext = (method) => (method === 'DELETE' ? new Response('{}', { status: 500 }) : undefined);
    rowOf('Ping').querySelector('.todo-open').click();
    byId('task-delete').click();
    await settle();
    assert.ok(texts().includes('Ping'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();
    assert.equal(byId('announcer').textContent, 'Reminder due: Ping');
    assert.equal(servers.a.rows.find((item) => item.id === ID(92)).notified, due);
    byId('sync-dismiss').click();
  });

  await t.test('item 5: Try again after a lost reminder save reconciles first and never re-arms a claimed alert', async () => {
    rowOf('Fix tap').querySelector('.todo-open').click();
    setWhen('2000-01-01T12:00');
    servers.a.failNext = (method) => (method === 'PATCH' ? { afterWrite: true } : undefined);
    byId('reminder-save').click();
    await settle();
    const saved = servers.a.rows.find((item) => item.text === 'Fix tap');
    assert.ok(saved.due !== null, 'the save reached the server');
    assert.equal(rowOf('Fix tap').querySelector('.stamp'), null, 'rolled back here');
    // Another tab claims (alerts) it before this tab retries.
    servers.a.rows = servers.a.rows.map((item) => (item === saved ? { ...item, notified: item.due, revision: item.revision + 1 } : item));
    const patches = () => servers.a.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(saved.id)).length;
    const sent = patches();
    const announced = byId('announcer').textContent;
    byId('sync-retry').click();
    await settle();
    assert.equal(patches(), sent, 'nothing re-sent');
    const after = servers.a.rows.find((item) => item.id === saved.id);
    assert.equal(after.notified, after.due);
    assert.equal(byId('announcer').textContent, announced, 'no second alert');
    assert.ok(rowOf('Fix tap').querySelector('.stamp'));
  });

  await t.test('item 4: each lost create keeps its own retry ID, also after a duplicate with a failed reload', async () => {
    const count = (text) => servers.a.rows.filter((item) => item.text === text).length;
    const lostPost = (method) => (method === 'POST' ? { afterWrite: true } : undefined);
    servers.a.failNext = lostPost;
    await add('Alpha');
    assert.equal(input.value, 'Alpha');
    servers.a.failNext = lostPost;
    await add('Beta');
    assert.equal(input.value, 'Beta');
    await add('Beta');
    await add('Alpha');
    assert.equal(count('Alpha'), 1);
    assert.equal(count('Beta'), 1);
    assert.equal(texts().filter((text) => text === 'Alpha').length, 1);

    servers.a.failNext = lostPost;
    await add('Gamma');
    // Re-adding gets 409 (it was saved) but the reload fails: the ID must survive.
    servers.a.failNext = (method) => (method === 'GET' ? new Response('{}', { status: 500 }) : undefined);
    await add('Gamma');
    assert.equal(input.value, 'Gamma');
    await add('Gamma');
    assert.equal(count('Gamma'), 1);
    assert.equal(texts().filter((text) => text === 'Gamma').length, 1);
    assert.equal(input.value, '');
  });

  await t.test('item 3: a retry ID only goes to the same title, whatever the filter', async () => {
    servers.a.failNext = (method) => (method === 'POST' ? { afterWrite: true } : undefined);
    await add('Check supplies'); // saved, answer lost
    assert.equal(input.value, 'Check supplies');
    await add('Unrelated'); // another title: its own new ID
    selectFilter('none');
    await add('Check supplies'); // the same title reuses the lost create's ID
    const rows = servers.a.rows.filter((item) => item.text === 'Check supplies');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, servers.a.rows.find((item) => item.text === 'Unrelated').id);
    selectFilter('all');
    assert.equal(texts().filter((text) => text === 'Check supplies').length, 1);
  });

  await t.test('a draft can be edited after its UUID is recreated following empty reconciliation', async () => {
    const server = servers.a;
    const text = 'Recreate draft';
    const saved = () => server.rows.find((item) => item.text === text);
    server.failNext = (method) => (method === 'POST' ? { afterWrite: true } : undefined);
    await add(text);
    const { id } = saved();
    // The retry gets a duplicate response, then another tab deletes the row before the GET.
    server.failNext = (method) => {
      if (method === 'GET') server.rows = server.rows.filter((item) => item.id !== id);
    };
    await add(text);
    server.failNext = null;
    assert.equal(saved(), undefined);
    assert.equal(input.value, text);
    await add(text);
    assert.equal(saved().id, id);
    await toggle(text);
    assert.equal(saved().completed, true);
  });

  await t.test('item 4: Try again keeps a recurring reminder that another tab claimed and advanced', async () => {
    const target = servers.a.rows.find((item) => item.text === 'Unrelated');
    rowOf('Unrelated').querySelector('.todo-open').click();
    setWhen('2000-01-01T12:00');
    byId('reminder-repeat').value = 'daily';
    byId('reminder-repeat').dispatchEvent(new Event('change'));
    servers.a.failNext = (method) => (method === 'PATCH' ? { afterWrite: true } : undefined);
    const announced = byId('announcer').textContent;
    byId('reminder-save').click();
    await settle();
    const saved = servers.a.rows.find((item) => item.id === target.id);
    assert.equal(saved.repeat, 'daily', 'the save reached the server');
    // Another tab claims the occurrence, then completes it: the reminder moves to tomorrow.
    const next = Date.now() + 86_400_000;
    servers.a.rows = servers.a.rows.map((item) => (item.id === target.id
      ? {
        ...item, completed: true, completedUntil: new Date(next).setHours(0, 0, 0, 0),
        due: next, notified: null, revision: item.revision + 2,
      } : item));
    const patches = () => servers.a.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(target.id)).length;
    const sent = patches();
    byId('sync-retry').click();
    await settle();
    assert.equal(patches(), sent, 'nothing re-sent');
    const after = servers.a.rows.find((item) => item.id === target.id);
    assert.equal(rowOf('Unrelated').querySelector('.todo-checkbox').checked, true);
    assert.equal(after.due, next, 'the advanced occurrence is kept');
    assert.equal(after.notified, null);
    assert.equal(byId('announcer').textContent, announced, 'the old occurrence is not alerted again');
    assert.doesNotMatch(rowOf('Unrelated').className, /is-overdue/);
    assert.match(byId('sync-text').textContent, /up to date/);
    byId('sync-dismiss').click();
  });

  await t.test('nit: a conflict whose reload failed does not claim the list is up to date', async () => {
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Alpha' ? { ...item, revision: item.revision + 1 } : item));
    servers.a.failNext = (method) => (method === 'GET' ? new Response('{}', { status: 500 }) : undefined);
    await toggle('Alpha');
    assert.doesNotMatch(byId('sync-text').textContent, /up to date/);
    assert.match(byId('sync-text').textContent, /couldn't be loaded/);
    assert.equal(byId('sync-retry').hidden, false);
    byId('sync-retry').click();
    await settle();
    assert.equal(note.hidden, true);
    await toggle('Alpha');
    assert.equal(servers.a.rows.find((item) => item.text === 'Alpha').completed, true);
  });

  await t.test('signing out clears rows, filters, drafts and editors; late answers are ignored', async () => {
    assert.ok(notifications.length > 0 && notifications.some((item) => !item.closed));
    assert.notEqual(byId('announcer').textContent, '');
    // item 2: an open task sheet with values in it.
    rowOf('Existing').querySelector('.todo-open').click();
    setWhen('2031-05-05T08:00');
    byId('reminder-repeat').value = 'daily';
    byId('edit-category').value = HOME;
    byId('edit-category').dispatchEvent(new Event('change'));
    selectFilter(HOME);
    byId('category-manage').click();
    byId('category-name').value = 'half-named';
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
    // No category of the old account is left: filter, options, panel, sheet select or tint.
    assert.equal(byId('category-row').hidden, true);
    assert.equal(byId('category-filter').value, 'all');
    assert.deepEqual(byId('category-filter').children.map((option) => option.textContent), ['All categories', 'Uncategorized']);
    assert.deepEqual(byId('edit-category').children.map((option) => option.textContent), ['Uncategorized']);
    assert.equal(byId('edit-category').value, '');
    assert.equal(byId('category-panel').hidden, true);
    assert.deepEqual(byId('category-list').children, []);
    assert.equal(byId('category-name').value, '');
    assert.equal(byId('reminder-editor').dataset.color, undefined);
    assert.equal(byId('reminder-layer').hidden, true);
    assert.equal(note.hidden, true);
    assert.equal(byId('reminder-editor').getAttribute('aria-label'), null);
    assert.equal(byId('edit-text').value, '');
    assert.equal(byId('reminder-on').checked, false);
    assert.equal(byId('reminder-date').value, '');
    assert.equal(byId('reminder-time').value, '');
    assert.equal(byId('reminder-repeat').value, 'none');
    assert.equal(byId('announcer').textContent, '');
    assert.equal(byId('reminder-announcer').textContent, '');
    assert.ok(notifications.every((item) => item.closed));
  });

  await t.test('the next account on the same browser sees only its own list', async () => {
    cookie = 'b';
    signIn(sessionB);
    await settle();
    assert.deepEqual(texts(), []);
    assert.equal(byId('empty-state').hidden, false);
    // The empty state has no count (no "0 to do").
    assert.equal(summary.textContent, '');
    assert.deepEqual(byId('category-filter').children.map((option) => option.textContent), ['All categories', 'Uncategorized']);
    await add('Ben only');
    assert.deepEqual(texts(), ['Ben only']);
    assert.equal(servers.a.rows.some((item) => item.text === 'Ben only'), false);
  });

  await t.test('resetting a focused composer moves focus to the + button', async () => {
    if (byId('add-form').hidden) byId('add-toggle').click();
    input.focus();
    assert.equal(document.activeElement, input);
    window.dispatchEvent(new CustomEvent('tasks:invalidate'));
    assert.equal(byId('add-form').hidden, true);
    assert.equal(document.activeElement, byId('add-toggle'));
    await settle();
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
    // The error card in the list slot says it, with Try again.
    assert.equal(summary.textContent, '');
    assert.equal(byId('sync-text').textContent, "Couldn't load your tasks");
    assert.equal(byId('sync-note').className.split(' ').includes('is-block'), true);
    assert.equal(byId('sync-retry').hidden, false);
    assert.equal(byId('empty-state').hidden, true);
    byId('sync-retry').click();
    await settle();
    assert.ok(texts().includes('Existing'));
    assert.equal(note.hidden, true);
    signIn(null); // no timers left running
  });
});
