// The edit form in src/app.js: the reminder editor in 'task' mode, run against the fake API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';
import { toLocalInput } from '../src/reminders.js';

const changedElsewhere = 'This task changed in another tab or device. The list is up to date now, so try again.';
const couldNotSave = "Couldn't save your change. Check your connection and try again.";

test('edit form', async (t) => {
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const ids = {
    rent: '00000000-0000-4000-8000-0000000000a1',
    plants: '00000000-0000-4000-8000-0000000000a2',
  };
  const later = Date.parse('2099-03-04T09:30:00');
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1 };
  const server = createFakeApi();
  server.rows = [
    { ...base, id: ids.rent, text: 'Pay rent', tags: ['home'], createdAt: 1 },
    { ...base, id: ids.plants, text: 'Water plants', tags: [], createdAt: 2, due: later, repeat: 'weekly' },
  ];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const layer = byId('reminder-layer');
  const editor = byId('reminder-editor');
  const title = byId('reminder-title');
  const text = byId('edit-text');
  const when = byId('reminder-when');
  const repeat = byId('reminder-repeat');
  const save = byId('reminder-save');
  const message = byId('reminder-message');
  const messageText = byId('reminder-message-text');
  const syncNote = byId('sync-note');
  const syncText = byId('sync-text');
  const row = (id) => list.children.find((item) => item.dataset.id === ids[id]);
  const editButton = (id) => row(id).querySelector('.todo-edit');
  const open = (id) => editButton(id).click();
  const type = (field, value) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const key = (target, name) => {
    const event = Object.assign(new Event('keydown'), { key: name, preventDefault() {} });
    Object.defineProperty(event, 'target', { value: target });
    editor.dispatchEvent(event);
  };
  const shownMessage = () => (message.hidden ? null : messageText.textContent);
  const focusKey = () => document.activeElement?.dataset?.focusKey;
  const patches = () => server.requests.filter((request) => request.method === 'PATCH');
  const serverRow = (id) => server.rows.find((item) => item.id === ids[id]);
  Notification.permission = 'granted';

  await t.test('each task has a labelled Edit button that opens the form prefilled', () => {
    const button = editButton('plants');
    assert.equal(button.getAttribute('aria-label'), 'Edit “Water plants”');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    open('plants');
    assert.equal(layer.hidden, false);
    assert.equal(title.textContent, 'Edit task');
    assert.equal(byId('edit-text-field').hidden, false);
    assert.equal(byId('reminder-for').hidden, true);
    assert.equal(byId('reminder-remove').hidden, true);
    assert.equal(editor.getAttribute('aria-label'), 'Edit “Water plants”');
    assert.equal(text.value, 'Water plants');
    assert.equal(when.value, toLocalInput(later));
    assert.equal(repeat.value, 'weekly');
    assert.equal(document.activeElement, text);
    assert.equal(editButton('plants').getAttribute('aria-expanded'), 'true');
    // Its reminder chip isn't the opener: it isn't shown as expanded.
    assert.equal(row('plants').querySelector('.reminder-chip').getAttribute('aria-expanded'), 'false');
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    assert.equal(shownMessage(), null);
    byId('reminder-cancel').click();
  });

  await t.test('tags show in the field as #words, the way the add field takes them', () => {
    open('rent');
    assert.equal(text.value, 'Pay rent #home');
    assert.equal(when.value, '');
    assert.equal(repeat.value, 'none');
    byId('reminder-cancel').click();
  });

  await t.test('Cancel discards the changes and returns focus to the task', () => {
    open('rent');
    type(text, 'Something else #other');
    type(when, '2099-01-01T12:00');
    byId('reminder-cancel').click();
    assert.equal(layer.hidden, true);
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent');
    assert.equal(patches().length, 0);
    assert.equal(focusKey(), JSON.stringify(['edit', ids.rent]));
    open('rent');
    assert.equal(text.value, 'Pay rent #home', 'reopening starts from the saved task');
    byId('reminder-cancel').click();
  });

  await t.test('Esc discards the changes and returns focus to the task', () => {
    open('plants');
    type(text, 'Renamed');
    key(text, 'Escape');
    assert.equal(layer.hidden, true);
    assert.equal(row('plants').querySelector('.todo-text').textContent, 'Water plants');
    assert.equal(patches().length, 0);
    assert.equal(focusKey(), JSON.stringify(['edit', ids.plants]));
  });

  await t.test('an empty title, or only #tags, is refused with the rule that disables Add', () => {
    for (const value of ['', '   ', '#home #bills']) {
      open('rent');
      type(text, value);
      assert.equal(save.getAttribute('aria-disabled'), 'true', JSON.stringify(value));
      assert.equal(shownMessage(), 'Enter a task title.');
      assert.equal(message.getAttribute('role'), 'alert');
      assert.equal(text.getAttribute('aria-invalid'), 'true');
      assert.equal(text.getAttribute('aria-describedby'), 'reminder-message edit-text-hint');
      save.click(); // aria-disabled: nothing is sent, focus goes to the field
      assert.equal(layer.hidden, false);
      assert.equal(document.activeElement, text);
      // The add form refuses the same input.
      const input = byId('new-todo');
      input.value = value;
      input.dispatchEvent(new Event('input'));
      assert.equal(byId('add-button').disabled, true);
      input.value = '';
      byId('reminder-cancel').click();
    }
    assert.equal(patches().length, 0);
  });

  await t.test('an over-long title and an unreadable date are refused too', () => {
    open('rent');
    type(text, 'x'.repeat(2001));
    assert.equal(shownMessage(), 'Keep the title to 2,000 characters or fewer.');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    type(text, 'Pay rent');
    assert.equal(shownMessage(), null);
    assert.equal(text.getAttribute('aria-invalid'), null);
    // A half-typed date reads as '' with badInput set.
    when.validity = { badInput: true };
    type(when, '');
    assert.equal(shownMessage(), 'Enter a valid date and time.');
    assert.equal(when.getAttribute('aria-invalid'), 'true');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    save.click();
    assert.equal(document.activeElement, when);
    when.validity = { badInput: false };
    type(when, '');
    assert.equal(save.getAttribute('aria-disabled'), 'false', 'an empty date means no reminder');
    byId('reminder-cancel').click();
    assert.equal(patches().length, 0);
  });

  await t.test('Save updates text, tags, date and repeat at once with one PATCH, then confirms', async () => {
    open('rent');
    type(text, 'Pay rent early #home #bills');
    type(when, '2099-01-01T12:00');
    repeat.value = 'daily';
    repeat.dispatchEvent(new Event('change'));
    save.click();
    // Optimistic: shown before the server answers.
    assert.equal(layer.hidden, true);
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent early');
    assert.deepEqual(row('rent').querySelectorAll('.tag-label').map((chip) => chip.dataset.tag), ['home', 'bills']);
    assert.ok(row('rent').querySelector('.reminder-chip'));
    assert.equal(focusKey(), JSON.stringify(['edit', ids.rent]));
    await settle();
    const due = Date.parse('2099-01-01T12:00:00');
    assert.deepEqual(JSON.parse(patches().at(-1).body), {
      text: 'Pay rent early', tags: ['home', 'bills'], due, repeat: 'daily', revision: 1, action: 'edit',
    });
    assert.equal(patches().length, 1);
    const saved = serverRow('rent');
    assert.deepEqual([saved.text, saved.tags, saved.due, saved.repeat, saved.revision], ['Pay rent early', ['home', 'bills'], due, 'daily', 2]);
    assert.equal(syncNote.hidden, true);
  });

  await t.test('Enter in the title saves; saving with no change sends nothing', async () => {
    const before = patches().length;
    open('rent');
    key(text, 'Enter');
    assert.equal(layer.hidden, true);
    await settle();
    assert.equal(patches().length, before);
    open('rent');
    type(text, 'Pay rent early #bills');
    key(text, 'Enter');
    await settle();
    assert.deepEqual(serverRow('rent').tags, ['bills']);
  });

  await t.test('emptying the date removes the reminder', async () => {
    open('plants');
    type(when, '');
    save.click();
    assert.equal(row('plants').querySelector('.reminder-chip'), null);
    await settle();
    assert.deepEqual([serverRow('plants').due, serverRow('plants').repeat], [null, 'none']);
  });

  await t.test('a 409 conflict rolls back, reloads the other tab\'s version and says so', async () => {
    // Another tab renames it first: this tab still shows the old revision.
    server.rows = server.rows.map((item) => (item.id === ids.plants
      ? { ...item, text: 'Water plants (other tab)', revision: item.revision + 1 } : item));
    open('plants');
    type(text, 'Water plants (mine)');
    save.click();
    assert.equal(row('plants').querySelector('.todo-text').textContent, 'Water plants (mine)');
    await settle();
    assert.equal(row('plants').querySelector('.todo-text').textContent, 'Water plants (other tab)');
    assert.equal(serverRow('plants').text, 'Water plants (other tab)');
    assert.equal(syncNote.hidden, false);
    assert.equal(syncText.textContent, changedElsewhere);
    assert.equal(byId('sync-retry').hidden, true);
    byId('sync-dismiss').click();
  });

  await t.test('a failed save rolls back and Try again re-sends it', async () => {
    server.failNext = (method) => (method === 'PATCH' ? new Response('{}', { status: 500 }) : undefined);
    open('rent');
    type(text, 'Pay rent today');
    save.click();
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent today');
    await settle();
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent early', 'rolled back');
    assert.equal(serverRow('rent').text, 'Pay rent early');
    assert.equal(syncText.textContent, couldNotSave);
    assert.equal(byId('sync-retry').hidden, false);
    byId('sync-retry').click();
    await settle(10);
    assert.equal(serverRow('rent').text, 'Pay rent today');
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent today');
    assert.equal(syncNote.hidden, true);
  });

  await t.test('the reminder editor still opens in reminder mode after the edit form', () => {
    open('plants');
    byId('reminder-cancel').click();
    row('plants').querySelector('.reminder-add').click();
    assert.equal(title.textContent, 'Reminder');
    assert.equal(byId('edit-text-field').hidden, true);
    assert.equal(byId('reminder-for').hidden, false);
    assert.equal(byId('reminder-when-label').textContent, 'Date and time');
    assert.equal(save.getAttribute('aria-disabled'), 'true', 'an empty date is still invalid here');
    byId('reminder-cancel').click();
  });

  // Signing out clears the view and its reminder timer, so nothing keeps node:test alive.
  await t.test('signing out leaves nothing of the edit form behind', () => {
    open('rent');
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    assert.equal(layer.hidden, true);
    assert.equal(text.value, '');
  });
});
