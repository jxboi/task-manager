// The composer in index.html and src/app.js: a New task field and its Add button, the shelf a new
// task goes on, and no reminder. A new task is created with no due date; reminders are set in
// the task sheet (edit-form.test.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';

const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the composer offers no reminder choices', () => {
  const composer = markup.match(/<form class="add-form" id="add-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(composer, 'index.html has the composer form');
  assert.deepEqual(Array.from(composer.matchAll(/\bid="([^"]+)"/g), ([, id]) => id),
    ['add-form', 'new-todo', 'add-button', 'add-shelf']);
  assert.deepEqual(Array.from(composer.matchAll(/<button\b[^>]*>([^<]*)</g), ([, label]) => label), ['Add']);
  assert.doesNotMatch(composer, /role="group"|add-chip|remind|tonight|tomorrow|repeat/i);
  assert.doesNotMatch(markup, /id="add-quick"|id="add-repeat"/);
});

test('a new task is created with no reminder', async (t) => {
  const server = createFakeApi();
  server.rows = [{
    id: '00000000-0000-4000-8000-0000000000c1', text: 'Old', tags: ['work'], completed: false,
    createdAt: 1, due: null, repeat: 'none', notified: null, revision: 1,
  }];
  const { byId } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const form = byId('add-form');
  const input = byId('new-todo');
  const add = async (text) => {
    const before = server.requests.length;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    await settle();
    return server.requests.slice(before).filter((request) => request.method !== 'GET');
  };

  byId('add-toggle').click();

  await t.test('no shelf is named until a tag is selected', () => {
    assert.equal(byId('add-shelf').hidden, true);
    byId('filter-bar').children.find((item) => item.dataset.tag === 'work').click();
    assert.equal(byId('add-shelf').hidden, false);
    assert.equal(byId('add-shelf').textContent, 'Adds to #work');
  });

  await t.test('only the create is sent, and the row has no due date', async () => {
    const sent = await add('Plan sprint');
    assert.deepEqual(sent.map((request) => request.method), ['POST']);
    const row = server.rows.find((item) => item.text === 'Plan sprint');
    assert.deepEqual([row.due, row.repeat, row.tags], [null, 'none', ['work']]);
  });

  await t.test('the next task has no reminder either', async () => {
    const sent = await add('Plain');
    assert.deepEqual(sent.map((request) => request.method), ['POST']);
    assert.equal(server.rows.find((item) => item.text === 'Plain').due, null);
  });

  // Signing out clears the reminder timer, so nothing keeps node:test alive.
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
});
