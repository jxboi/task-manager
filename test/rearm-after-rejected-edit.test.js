// A category-only save the server refuses (404: the category was deleted in another tab) must not
// re-arm an already-fired reminder: no setReminder, no second alert, no revision bump.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';

const BILLS = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('a rejected category-only save leaves a fired reminder alone', async (t) => {
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const id = '00000000-0000-4000-8000-0000000000b1';
  const due = Date.parse('2001-01-01T09:00:00');
  const server = createFakeApi();
  server.categories = [{ id: BILLS, name: 'Bills', revision: 1 }];
  server.rows = [{ id, text: 'Late task', completed: false, tags: [], categoryId: null, due, repeat: 'none', notified: due, revision: 1, createdAt: 1 }];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const category = byId('edit-category');
  list.children.find((item) => item.dataset.id === id).querySelector('.todo-open').click();
  category.value = BILLS;
  category.dispatchEvent(new Event('change'));
  server.categories = []; // another tab deletes Bills
  const before = server.requests.length;
  byId('reminder-save').click();
  await settle();

  const sent = server.requests.slice(before).filter((request) => request.method !== 'GET');
  assert.equal(sent.length, 1, 'only the refused edit was sent');
  assert.match(String(sent[0].body), /"edit"/);
  assert.equal(sent.some((request) => /setReminder|markNotified/.test(String(request.body))), false);
  assert.equal(server.rows[0].revision, 1, 'the revision is unchanged');
  const row = list.children.find((item) => item.dataset.id === id);
  assert.equal(row.className.split(' ').includes('is-fired'), false, 'no second alert');
});
