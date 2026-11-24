// A category save on a fired reminder re-arms it in the queue slot right behind the edit, so a
// newer save that clears the reminder can't be undone by the late re-arm (no setReminder after the
// clear, no second alert).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';

const BILLS = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('a delayed category save does not restore a reminder a newer save cleared', async (t) => {
  let release;
  let hold = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const { byId, list } = installDom(t, {
    fetch: async (...args) => {
      const isEdit = hold && /"edit"/.test(String(args[1]?.body));
      if (isEdit) {
        hold = false;
        const answer = await server.fetch(...args);
        await gate;
        return answer;
      }
      return server.fetch(...args);
    },
  });
  const id = '00000000-0000-4000-8000-0000000000b2';
  const due = Date.parse('2001-01-01T09:00:00');
  const server = createFakeApi();
  server.categories = [{ id: BILLS, name: 'Bills', revision: 1 }];
  server.rows = [{ id, text: 'Late task', completed: false, tags: [], categoryId: null, due, repeat: 'none', notified: due, revision: 1, createdAt: 1 }];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();
  const open = () => list.children.find((item) => item.dataset.id === id).querySelector('.todo-open').click();

  open();
  const category = byId('edit-category');
  category.value = BILLS;
  category.dispatchEvent(new Event('change'));
  const before = server.requests.length;
  hold = true;
  byId('reminder-save').click();
  await settle();

  open(); // save 2, while the first answer is still out: clear the reminder
  const on = byId('reminder-on');
  on.checked = false;
  on.dispatchEvent(new Event('change'));
  byId('reminder-save').click();
  await settle();
  release();
  await settle();
  await settle();

  const sent = server.requests.slice(before).filter((request) => request.method !== 'GET').map((request) => String(request.body));
  const clear = sent.findIndex((body) => /clearReminder|"due":null/.test(body));
  assert.ok(clear >= 0, 'the clear was sent');
  assert.equal(sent.slice(clear + 1).some((body) => /setReminder/.test(body)), false, 'no setReminder after the clear');
  assert.equal(server.rows[0].due, null, 'no reminder left');
  const row = list.children.find((item) => item.dataset.id === id);
  assert.equal(row.className.split(' ').includes('is-fired'), false, 'no alert');
});
