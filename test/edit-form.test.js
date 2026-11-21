// The task sheet in src/app.js (title, category, reminder picker, delete), run against the fake API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';

const changedElsewhere = 'This task changed in another tab or device. The list is up to date now, so try again.';
const couldNotSave = "Couldn't save your change.";

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
    { ...base, id: ids.rent, text: 'Pay rent', category: 'home', createdAt: 1 },
    { ...base, id: ids.plants, text: 'Water plants', category: null, createdAt: 2, due: later, repeat: 'weekly' },
  ];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const layer = byId('reminder-layer');
  const editor = byId('reminder-editor');
  const text = byId('edit-text');
  const on = byId('reminder-on');
  const date = byId('reminder-date');
  const time = byId('reminder-time');
  const repeat = byId('reminder-repeat');
  const save = byId('reminder-save');
  const message = byId('reminder-message');
  const messageText = byId('reminder-message-text');
  const syncNote = byId('sync-note');
  const syncText = byId('sync-text');
  const row = (id) => list.children.find((item) => item.dataset.id === ids[id]);
  const editButton = (id) => row(id).querySelector('.todo-open');
  const open = (id) => editButton(id).click();
  const type = (field, value) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  // The picker: "YYYY-MM-DDTHH:MM" turns the Reminder switch on with that date and time; '' turns it off.
  const setWhen = (value) => {
    const [day = '', clock = ''] = value.split('T');
    if (on.checked !== (value !== '')) {
      on.checked = value !== '';
      on.dispatchEvent(new Event('change'));
    }
    date.value = day;
    type(time, clock);
  };
  const format = (ms, options) => new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
  const key = (target, name) => {
    const event = Object.assign(new Event('keydown'), { key: name, preventDefault() {} });
    Object.defineProperty(event, 'target', { value: target });
    editor.dispatchEvent(event);
  };
  const shownMessage = () => (message.hidden ? null : messageText.textContent);
  const focusKey = () => document.activeElement?.dataset?.focusKey;
  const patches = () => server.requests.filter((request) => request.method === 'PATCH');
  const serverRow = (id) => server.rows.find((item) => item.id === ids[id]);
  const choices = () => byId('edit-categories').children;
  const picked = () => choices().filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.dataset.category);
  // '' is None.
  const choose = (category) => choices().find((button) => button.dataset.category === category).click();
  Notification.permission = 'granted';

  await t.test('each row body is one labelled button that opens the sheet prefilled', () => {
    const button = editButton('plants');
    // Another year: "{short date with year}, {time}", as the app formats it.
    const when = `${format(later, { month: 'short', day: 'numeric', year: 'numeric' })}, ${format(later, { hour: 'numeric', minute: '2-digit' })}`;
    assert.equal(button.getAttribute('aria-label'), `Water plants. Reminder ${when}, repeats weekly. Edit task`);
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(editButton('rent').getAttribute('aria-label'), 'Pay rent. Category: home. Edit task');
    // The row has no other controls: no pencil, trash, "+ reminder" or category picker.
    for (const control of ['.todo-edit', '.todo-delete', '.category-add', '.reminder-add', '.category-choice']) {
      assert.equal(row('rent').querySelector(control), null, control);
    }
    open('plants');
    assert.equal(layer.hidden, false);
    assert.equal(editor.getAttribute('aria-label'), 'Edit “Water plants”');
    assert.equal(text.value, 'Water plants');
    assert.equal(on.checked, true);
    assert.equal(byId('picker-detail').hidden, false);
    assert.equal(date.value, '2099-03-04');
    assert.equal(time.value, '09:30');
    assert.equal(byId('reminder-date-value').textContent, format(later, { month: 'short', day: 'numeric', year: 'numeric' }));
    assert.equal(byId('calendar').hidden, true, 'the calendar opens from the Date row');
    assert.equal(repeat.value, 'weekly');
    assert.equal(document.activeElement, text);
    assert.equal(editButton('plants').getAttribute('aria-expanded'), 'true');
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    assert.equal(shownMessage(), null);
    byId('reminder-cancel').click();
  });

  await t.test('the title field holds the title; the category is picked', () => {
    open('rent');
    assert.equal(text.value, 'Pay rent');
    assert.deepEqual(picked(), ['home']);
    assert.deepEqual(choices().map((button) => button.textContent), ['None', 'home']);
    assert.equal(on.checked, false);
    assert.equal(byId('picker-detail').hidden, true);
    assert.equal(date.value, '');
    assert.equal(time.value, '');
    assert.equal(repeat.value, 'none');
    byId('reminder-cancel').click();
  });

  await t.test('Cancel discards the changes and returns focus to the task', () => {
    open('rent');
    type(text, 'Something else #other');
    setWhen('2099-01-01T12:00');
    byId('reminder-cancel').click();
    assert.equal(layer.hidden, true);
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent');
    assert.equal(patches().length, 0);
    assert.equal(focusKey(), JSON.stringify(['open', ids.rent]));
    open('rent');
    assert.equal(text.value, 'Pay rent', 'reopening starts from the saved task');
    byId('reminder-cancel').click();
  });

  await t.test('Esc discards the changes and returns focus to the task', () => {
    open('plants');
    type(text, 'Renamed');
    key(text, 'Escape');
    assert.equal(layer.hidden, true);
    assert.equal(row('plants').querySelector('.todo-text').textContent, 'Water plants');
    assert.equal(patches().length, 0);
    assert.equal(focusKey(), JSON.stringify(['open', ids.plants]));
  });

  await t.test('an empty title, or only a #category, is refused with the rule that disables Add', () => {
    for (const value of ['', '   ', '#home']) {
      open('rent');
      type(text, value);
      assert.equal(save.getAttribute('aria-disabled'), 'true', JSON.stringify(value));
      assert.equal(shownMessage(), 'Enter a task title.');
      assert.equal(message.getAttribute('role'), 'alert');
      assert.equal(text.getAttribute('aria-invalid'), 'true');
      assert.equal(text.getAttribute('aria-describedby'), 'reminder-message');
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

  await t.test('an over-long title and an unreadable time are refused too', () => {
    open('rent');
    type(text, 'x'.repeat(2001));
    assert.equal(shownMessage(), 'Keep the title to 2,000 characters or fewer.');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    type(text, 'Pay rent');
    assert.equal(shownMessage(), null);
    assert.equal(text.getAttribute('aria-invalid'), null);
    // A half-typed time reads as '' with badInput set.
    setWhen('2099-01-01T12:00');
    time.validity = { badInput: true };
    type(time, '');
    assert.equal(shownMessage(), 'Enter a valid date and time.');
    assert.equal(time.getAttribute('aria-invalid'), 'true');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    save.click();
    assert.equal(document.activeElement, time);
    time.validity = { badInput: false };
    setWhen('');
    assert.equal(save.getAttribute('aria-disabled'), 'false', 'the switch off means no reminder');
    byId('reminder-cancel').click();
    assert.equal(patches().length, 0);
  });

  await t.test('Save updates text, category, date and repeat at once with one PATCH, then confirms', async () => {
    open('rent');
    type(text, 'Pay rent early #bills'); // a #category typed in the title replaces the picked one
    setWhen('2099-01-01T12:00');
    repeat.value = 'daily';
    repeat.dispatchEvent(new Event('change'));
    save.click();
    // Optimistic: shown before the server answers.
    assert.equal(layer.hidden, true);
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent early');
    assert.deepEqual(row('rent').querySelectorAll('.category-label').map((chip) => chip.dataset.category), ['bills']);
    assert.ok(row('rent').querySelector('.stamp'));
    assert.equal(focusKey(), JSON.stringify(['open', ids.rent]));
    await settle();
    const due = Date.parse('2099-01-01T12:00:00');
    assert.deepEqual(JSON.parse(patches().at(-1).body), {
      text: 'Pay rent early', category: 'bills', due, repeat: 'daily', revision: 1, action: 'edit',
    });
    assert.equal(patches().length, 1);
    const saved = serverRow('rent');
    assert.deepEqual([saved.text, saved.category, saved.due, saved.repeat, saved.revision], ['Pay rent early', 'bills', due, 'daily', 2]);
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
    // Only categories in use are offered (home went with the edit above), and None.
    assert.deepEqual(choices().map((button) => button.textContent), ['None', 'bills']);
    choose('');
    key(text, 'Enter');
    await settle();
    assert.equal(serverRow('rent').category, null);
  });

  await t.test('turning the Reminder switch off removes the reminder', async () => {
    open('plants');
    setWhen('');
    save.click();
    assert.equal(row('plants').querySelector('.stamp'), null);
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

  await t.test('a draft opened before another tab changed the task is not saved over it', async () => {
    const original = { ...serverRow('rent') };
    open('rent');
    // Another tab changes the category and adds a reminder; this tab's list refreshes meanwhile.
    const reminder = Date.parse('2099-05-06T08:00:00');
    server.rows = server.rows.map((item) => (item.id === ids.rent
      ? { ...item, category: 'bills', due: reminder, repeat: 'daily', revision: item.revision + 1 } : item));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    const before = patches().length;
    type(text, 'Pay rent today'); // a title-only edit of the stale prefilled values
    save.click();
    await settle();
    assert.equal(patches().length, before, 'nothing is sent');
    assert.equal(layer.hidden, true);
    assert.equal(syncNote.hidden, false);
    assert.equal(syncText.textContent, changedElsewhere);
    assert.deepEqual([serverRow('rent').category, serverRow('rent').due, serverRow('rent').repeat], ['bills', reminder, 'daily']);
    byId('sync-dismiss').click();
    // Opened again, the form has the refreshed values and saves.
    open('rent');
    assert.equal(text.value, 'Pay rent early');
    type(text, 'Pay rent today');
    save.click();
    await settle();
    assert.deepEqual([serverRow('rent').text, serverRow('rent').due, serverRow('rent').category], ['Pay rent today', reminder, 'bills']);
    // Put the row back for the tests after this one.
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
  });

  await t.test('a category with # in it survives an untouched edit, and None clears it', async () => {
    const original = { ...serverRow('rent') };
    server.rows = server.rows.map((item) => (item.id === ids.rent
      ? { ...item, text: 'Review #42', category: 'ref#42', revision: item.revision + 1 } : item));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    const before = patches().length;
    open('rent');
    assert.equal(text.value, 'Review #42');
    save.click();
    await settle();
    assert.equal(patches().length, before, 'untouched: nothing to send');
    open('rent');
    type(text, 'Review today');
    save.click();
    await settle();
    assert.deepEqual([serverRow('rent').text, serverRow('rent').category], ['Review today', 'ref#42']);
    open('rent');
    choose('');
    assert.deepEqual(picked(), ['']);
    save.click();
    await settle();
    assert.equal(serverRow('rent').category, null);
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
  });

  await t.test('a reminder claim while the form is open keeps the draft; an edit of a field does not', async () => {
    const original = { ...serverRow('rent') };
    const refresh = async () => {
      window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
      await settle();
    };
    open('rent');
    type(text, 'Pay rent (mine)');
    // This tab (or another) claims a reminder: only `notified` and the revision change.
    server.rows = server.rows.map((item) => (item.id === ids.rent
      ? { ...item, notified: Date.now(), revision: item.revision + 1 } : item));
    await refresh();
    const before = patches().length;
    save.click();
    await settle();
    assert.equal(syncNote.hidden, true, 'no conflict note');
    assert.equal(patches().length, before + 1);
    assert.equal(serverRow('rent').text, 'Pay rent (mine)');
    // Now a real change to an editable field (due) from another tab.
    open('rent');
    type(text, 'Pay rent (stale)');
    server.rows = server.rows.map((item) => (item.id === ids.rent
      ? { ...item, due: Date.parse('2099-07-08T10:00:00'), revision: item.revision + 1 } : item));
    await refresh();
    const sent = patches().length;
    save.click();
    await settle();
    assert.equal(patches().length, sent);
    assert.equal(syncNote.hidden, false);
    assert.equal(syncText.textContent, changedElsewhere);
    byId('sync-dismiss').click();
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    await refresh();
  });

  await t.test('Esc during IME composition keeps the draft', () => {
    open('rent');
    type(text, 'Half typed');
    const composing = Object.assign(new Event('keydown'), { key: 'Escape', isComposing: true, preventDefault() {} });
    Object.defineProperty(composing, 'target', { value: text });
    editor.dispatchEvent(composing);
    assert.equal(layer.hidden, false);
    assert.equal(text.value, 'Half typed');
    key(text, 'Escape');
    assert.equal(layer.hidden, true);
  });

  await t.test('Add says why it is disabled when the title is too long', () => {
    const add = byId('new-todo');
    byId('add-toggle').click(); // the + button reveals the field
    assert.equal(byId('add-form').hidden, false);
    add.value = 'x'.repeat(2001);
    add.dispatchEvent(new Event('input'));
    assert.equal(byId('add-button').disabled, true);
    assert.equal(byId('hint-limit').hidden, false);
    assert.equal(byId('hint-limit').textContent, 'Keep the title to 2,000 characters or fewer.');
    add.value = 'ok';
    add.dispatchEvent(new Event('input'));
    assert.equal(byId('hint-limit').hidden, true);
    add.value = '';
    add.dispatchEvent(new Event('input'));
    byId('add-toggle').click();
    assert.equal(byId('add-form').hidden, true);
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

  await t.test('"New category" picks a new category with the #category rules, and Save sends it', async () => {
    const add = byId('edit-category-add');
    const field = byId('edit-category-field');
    const enter = (value) => {
      field.value = value;
      const event = Object.assign(new Event('keydown'), { key: 'Enter' });
      field.dispatchEvent(event);
    };
    open('rent');
    const before = serverRow('rent').category;
    assert.equal(field.hidden, true);
    add.click();
    assert.equal(field.hidden, false);
    assert.equal(add.hidden, true);
    assert.equal(document.activeElement, field);
    enter('##bad'); // refused and flashed; the field stays open
    assert.equal(field.getAttribute('aria-invalid'), 'true');
    assert.equal(field.hidden, false);
    enter('#Errands');
    assert.deepEqual(picked(), ['errands']);
    assert.equal(field.hidden, true, 'Enter picks it and closes the field');
    assert.equal(document.activeElement.dataset.category, 'errands');
    add.click();
    const escape = Object.assign(new Event('keydown'), { key: 'Escape' });
    field.dispatchEvent(escape);
    assert.equal(field.hidden, true, 'Esc closes the field');
    assert.equal(layer.hidden, false, 'and not the sheet');
    assert.equal(document.activeElement, add);
    const sent = patches().length;
    save.click();
    await settle();
    assert.equal(patches().length, sent + 1);
    assert.equal(serverRow('rent').category, 'errands');
    // Back as it was.
    open('rent');
    choose(before ?? '');
    save.click();
    await settle();
    assert.equal(serverRow('rent').category, before);
  });

  await t.test('Save keeps a category still typed in the focused New category field', async () => {
    open('rent');
    const before = serverRow('rent').category;
    byId('edit-category-add').click();
    const field = byId('edit-category-field');
    field.value = 'Pending';
    assert.equal(document.activeElement, field);
    save.click(); // no blur first
    await settle();
    assert.equal(serverRow('rent').category, 'pending');
    open('rent');
    choose(before ?? '');
    save.click();
    await settle();
    assert.equal(serverRow('rent').category, before);
  });

  await t.test('focus stays in the sheet when Previous month disables itself', async () => {
    open('plants');
    byId('reminder-date-button').click();
    const prev = byId('cal-prev');
    // Page to February 1970 by choosing a day there (the native input holds the date), then close and reopen.
    date.value = '1970-02-10';
    date.dispatchEvent(new Event('input'));
    byId('reminder-date-button').click();
    byId('reminder-date-button').click();
    assert.equal(byId('cal-month').textContent,
      new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(1970, 1, 1)));
    assert.equal(prev.disabled, false);
    prev.focus();
    assert.equal(document.activeElement, prev);
    prev.click(); // January 1970: the first month, so Previous month disables itself
    assert.equal(prev.disabled, true);
    assert.notEqual(document.activeElement, prev);
    assert.ok(byId('cal-days').children.includes(document.activeElement), 'focus moved to a day in the calendar');
    assert.equal(document.activeElement.dataset.date, '1970-01-01', 'the first available day');
    byId('reminder-cancel').click();
  });

  await t.test('the calendar picks a day; the time starts at 9:00 AM; any day can be picked, past ones too', async () => {
    const today = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const iso = (day) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    open('plants');
    assert.equal(on.checked, false, 'its reminder was removed above');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    const days = () => byId('cal-days').children.filter((cell) => cell.dataset.date);
    assert.equal(byId('calendar').hidden, false);
    assert.ok(days().length >= 28);
    assert.equal(byId('cal-month').textContent,
      new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(`${date.value}T12:00`)));
    const selected = days().filter((cell) => cell.getAttribute('aria-pressed') === 'true');
    assert.deepEqual(selected.map((cell) => cell.dataset.date), [date.value]);
    assert.equal(selected[0].tabIndex, 0, 'the chosen day holds the one tab stop');
    // Today is marked; earlier days in the month can be picked too.
    const todayCell = days().find((cell) => cell.dataset.date === iso(today));
    if (todayCell) assert.equal(todayCell.getAttribute('aria-current'), 'date');
    for (const cell of days()) {
      assert.ok(!cell.disabled, cell.dataset.date);
    }
    assert.equal(byId('cal-prev').disabled, false, 'paging back is open');
    // Next month, the 15th, at the default time, then repeat daily.
    byId('cal-next').click();
    const fifteenth = days().find((cell) => cell.dataset.date.endsWith('-15'));
    assert.equal(byId('cal-prev').disabled, false);
    fifteenth.click();
    assert.equal(date.value, fifteenth.dataset.date);
    assert.equal(time.value, '09:00');
    assert.equal(fifteenth.getAttribute('aria-label'),
      new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        .format(new Date(`${fifteenth.dataset.date}T12:00`)));
    repeat.value = 'daily';
    repeat.dispatchEvent(new Event('change'));
    save.click();
    await settle();
    assert.deepEqual([serverRow('plants').due, serverRow('plants').repeat], [Date.parse(`${fifteenth.dataset.date}T09:00:00`), 'daily']);
    // Arrow keys move by a day and a week.
    open('plants');
    byId('reminder-date-button').click();
    assert.equal(byId('calendar').hidden, false);
    const arrow = (cell, keyName) => {
      const event = Object.assign(new Event('keydown'), { key: keyName, preventDefault() {} });
      Object.defineProperty(event, 'target', { value: cell });
      byId('cal-days').dispatchEvent(event);
    };
    const current = () => days().find((cell) => cell.tabIndex === 0).dataset.date;
    const start = current();
    arrow(days().find((cell) => cell.dataset.date === start), 'ArrowDown');
    assert.equal(current(), iso(new Date(new Date(`${start}T12:00`).setDate(new Date(`${start}T12:00`).getDate() + 7))));
    byId('reminder-cancel').click();
    // Off again for the tests after this one.
    open('plants');
    setWhen('');
    save.click();
    await settle();
    assert.deepEqual([serverRow('plants').due, serverRow('plants').repeat], [null, 'none']);
  });

  await t.test('Delete task deletes at once and focuses the next row, or the composer', async () => {
    server.rows.push({ ...base, id: '00000000-0000-4000-8000-0000000000a3', text: 'Temporary', category: null, createdAt: 3 });
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    const temporary = list.children.find((item) => item.querySelector('.todo-text').textContent === 'Temporary');
    const index = list.children.indexOf(temporary);
    const neighbour = list.children[index + 1] ?? list.children[index - 1];
    temporary.querySelector('.todo-open').click();
    byId('task-delete').click();
    assert.equal(layer.hidden, true);
    assert.equal(list.children.some((item) => item.querySelector('.todo-text').textContent === 'Temporary'), false);
    assert.equal(focusKey(), JSON.stringify(['checkbox', neighbour.dataset.id]));
    await settle();
    assert.equal(server.rows.some((item) => item.text === 'Temporary'), false);
  });

  // Signing out clears the view and its reminder timer, so nothing keeps node:test alive.
  await t.test('signing out leaves nothing of the edit form behind', () => {
    open('rent');
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    assert.equal(layer.hidden, true);
    assert.equal(text.value, '');
  });
});
