// Edits patch from the confirmed row plus the fields the user edited; every retried mutation is
// cancelled at dispatch if its row moved on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';

const BILLS = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID = '00000000-0000-4000-8000-0000000000c1';

test('confirmed-row patching and base-checked retries', async (t) => {
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const server = createFakeApi();
  server.categories = [{ id: BILLS, name: 'Bills', revision: 1 }];
  server.rows = [{ id: ID, text: 'Pay rent', completed: false, tags: [], categoryId: null, due: null, repeat: 'none', notified: null, revision: 1, createdAt: 1 }];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const text = byId('edit-text');
  const category = byId('edit-category');
  const open = () => list.children.find((item) => item.dataset.id === ID).querySelector('.todo-open');
  const patches = () => server.requests.filter((request) => request.method === 'PATCH').map((request) => JSON.parse(request.body));
  const title = () => list.children.find((item) => item.dataset.id === ID)?.querySelector('.todo-text').textContent;

  await t.test('a rolled-back title edit does not leak into a category-only save', async () => {
    server.failNext = (method) => (method === 'PATCH' ? new Response('{}', { status: 400 }) : undefined);
    open().click();
    text.value = 'Pay rent late';
    text.dispatchEvent(new Event('input'));
    byId('reminder-save').click();
    // The sheet opens on the optimistic row while the first edit is still in flight.
    assert.equal(title(), 'Pay rent late');
    open().click();
    category.value = BILLS;
    category.dispatchEvent(new Event('change'));
    byId('reminder-save').click();
    await settle();
    const sent = patches();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].text, 'Pay rent', 'the confirmed title, not the rolled-back one');
    assert.equal(server.rows[0].text, 'Pay rent');
    assert.equal(server.rows[0].categoryId, BILLS);
  });

  await t.test('a delete retry cancels when an edit was queued during recovery', async () => {
    server.failNext = (method) => (method === 'DELETE' ? new Response('{}', { status: 500 }) : undefined);
    open().click();
    byId('task-delete').click();
    await settle();
    assert.equal(title(), 'Pay rent', 'rolled back');
    const retry = byId('sync-retry');
    assert.equal(retry.hidden, false);
    const deletes = () => server.requests.filter((request) => request.method === 'DELETE').length;
    const before = deletes();
    retry.click(); // reloads first
    open().click(); // an edit queued while the reload is in flight
    text.value = 'Pay rent now';
    text.dispatchEvent(new Event('input'));
    byId('reminder-save').click();
    await settle();
    assert.equal(deletes(), before, 'the retried delete was not sent');
    assert.equal(server.rows.length, 1, 'the task survives');
    assert.equal(server.rows[0].text, 'Pay rent now');
  });

  await t.test('an unchanged-base delete retry still goes through', async () => {
    server.failNext = (method) => (method === 'DELETE' ? new Response('{}', { status: 500 }) : undefined);
    open().click();
    byId('task-delete').click();
    await settle();
    byId('sync-retry').click();
    await settle();
    assert.equal(server.rows.length, 0);
  });
});
