// The task sheet in src/app.js (title, category, reminder picker, delete), run against the fake API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';
import { categoryColor } from '../src/tags.js';

const HOME = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BILLS = '0f8fad5b-d9cb-469f-a165-70867728950e';
const categoryGone = 'The category you chose was deleted. The list is up to date now, so try again.';

const changedElsewhere = 'This task changed in another tab or device. The list is up to date now, so try again.';
const couldNotSave = "Couldn't save your change.";

test('edit form', async (t) => {
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const ids = {
    rent: '00000000-0000-4000-8000-0000000000a1',
    plants: '00000000-0000-4000-8000-0000000000a2',
    multi: '00000000-0000-4000-8000-0000000000a3',
  };
  const later = Date.parse('2099-03-04T09:30:00');
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1 };
  const server = createFakeApi();
  server.categories = [{ id: HOME, name: 'Home', revision: 1 }, { id: BILLS, name: 'Bills', revision: 1 }];
  server.rows = [
    { ...base, id: ids.rent, text: 'Pay rent', tags: [], categoryId: HOME, createdAt: 1 },
    { ...base, id: ids.plants, text: 'Water plants', tags: [], categoryId: null, createdAt: 2, due: later, repeat: 'weekly' },
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
  const category = byId('edit-category');
  const choose = (value) => {
    category.value = value;
    category.dispatchEvent(new Event('change'));
  };
  const refresh = async () => {
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
  };
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
  Notification.permission = 'granted';

  await t.test('each row body is one labelled button that opens the sheet prefilled', () => {
    const button = editButton('plants');
    // Another year: "{short date with year}, {time}", as the app formats it.
    const when = `${format(later, { month: 'short', day: 'numeric', year: 'numeric' })}, ${format(later, { hour: 'numeric', minute: '2-digit' })}`;
    assert.equal(button.getAttribute('aria-label'), `Water plants. Reminder ${when}, repeats weekly. Edit task`);
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(editButton('rent').getAttribute('aria-label'), 'Pay rent. Category: Home. Edit task');
    // The row has no other controls: no pencil, "+ tag", "+ reminder" or tag ×. Its one trash
    // is the Delete button a swipe left reveals; closed, it is not shown (styles.css).
    for (const control of ['.todo-edit', '.tag-add', '.reminder-add', '.tag-remove']) {
      assert.equal(row('rent').querySelector(control), null, control);
    }
    assert.equal(row('rent').querySelectorAll('.todo-delete').length, 1);
    assert.doesNotMatch(row('rent').className, /is-open/);
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

  await t.test('the title field holds the title; the Category select holds the task\'s category', () => {
    open('rent');
    assert.equal(text.value, 'Pay rent');
    assert.deepEqual(category.querySelectorAll('option').map((option) => [option.value, option.textContent]),
      [['', 'Uncategorized'], [BILLS, 'Bills'], [HOME, 'Home']]);
    assert.equal(category.value, HOME);
    assert.equal(editor.dataset.color, categoryColor('Home'), 'the sheet takes the category color');
    choose(BILLS);
    assert.equal(editor.dataset.color, categoryColor('Bills'), 'and follows the select');
    choose('');
    assert.equal(editor.dataset.color, undefined, 'uncategorized: the plain sheet');
    assert.equal(byId('edit-tags'), undefined, 'no tag chips or Add tag');
    assert.equal(on.checked, false);
    assert.equal(byId('picker-detail').hidden, true);
    assert.equal(date.value, '');
    assert.equal(time.value, '');
    assert.equal(repeat.value, 'none');
    byId('reminder-cancel').click();
    open('plants');
    assert.equal(category.value, '', 'an uncategorized task shows Uncategorized');
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

  await t.test('an empty title is refused with the rule that disables Add; "#home" is a title', () => {
    for (const value of ['', '   ']) {
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
    open('rent');
    type(text, '#home #bills');
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    assert.equal(shownMessage(), null);
    byId('reminder-cancel').click();
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

  await t.test('Save updates title, category, date and repeat at once with one PATCH, then confirms', async () => {
    open('rent');
    type(text, 'Pay rent early');
    choose(BILLS);
    setWhen('2099-01-01T12:00');
    repeat.value = 'daily';
    repeat.dispatchEvent(new Event('change'));
    save.click();
    // Optimistic: shown before the server answers.
    assert.equal(layer.hidden, true);
    assert.equal(row('rent').querySelector('.todo-text').textContent, 'Pay rent early');
    assert.equal(row('rent').querySelector('.todo-category').textContent, 'Bills');
    assert.equal(row('rent').dataset.color, categoryColor('Bills'));
    assert.ok(row('rent').querySelector('.stamp'));
    assert.equal(focusKey(), JSON.stringify(['open', ids.rent]));
    await settle();
    const due = Date.parse('2099-01-01T12:00:00');
    assert.deepEqual(JSON.parse(patches().at(-1).body), {
      text: 'Pay rent early', due, repeat: 'daily', categoryId: BILLS, revision: 1, action: 'edit', tags: [],
    });
    assert.equal(patches().length, 1);
    const saved = serverRow('rent');
    assert.deepEqual([saved.text, saved.categoryId, saved.due, saved.repeat, saved.revision], ['Pay rent early', BILLS, due, 'daily', 2]);
    assert.equal(syncNote.hidden, true);
  });

  await t.test('Enter in the title saves; saving with no change sends nothing; Uncategorized clears', async () => {
    const before = patches().length;
    open('rent');
    key(text, 'Enter');
    assert.equal(layer.hidden, true);
    await settle();
    assert.equal(patches().length, before);
    // Changed and changed back is no change either.
    open('rent');
    choose(HOME);
    choose(BILLS);
    key(text, 'Enter');
    await settle();
    assert.equal(patches().length, before);
    open('rent');
    choose('');
    key(text, 'Enter');
    assert.equal(row('rent').querySelector('.todo-category'), null);
    await settle();
    assert.equal(JSON.parse(patches().at(-1).body).categoryId, null);
    assert.equal(serverRow('rent').categoryId, null);
  });

  await t.test('a category-only save keeps the line breaks of a multi-line title', async () => {
    const title = 'First line\r\nSecond line';
    server.rows.push({ ...base, id: ids.multi, text: title, tags: [], categoryId: null, createdAt: 3 });
    await refresh();
    // A native single-line input drops line breaks from what it shows.
    let shown = '';
    Object.defineProperty(text, 'value', {
      configurable: true, get: () => shown, set: (value) => { shown = String(value).replace(/[\r\n]/g, ''); },
    });
    open('multi');
    assert.equal(text.value, 'First lineSecond line');
    choose(BILLS);
    save.click();
    await settle();
    assert.equal(JSON.parse(patches().at(-1).body).text, title);
    assert.equal(serverRow('multi').text, title);
    delete text.value;
    server.rows = server.rows.filter((item) => item.id !== ids.multi);
    await refresh();
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
    // Another tab sets a category and a reminder; this tab's list refreshes while the form is open.
    const reminder = Date.parse('2099-05-06T08:00:00');
    server.rows = server.rows.map((item) => (item.id === ids.rent
      ? { ...item, categoryId: HOME, due: reminder, repeat: 'daily', revision: item.revision + 1 } : item));
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
    assert.deepEqual([serverRow('rent').categoryId, serverRow('rent').due, serverRow('rent').repeat], [HOME, reminder, 'daily']);
    byId('sync-dismiss').click();
    // Opened again, the form has the refreshed values and saves. The category wasn't changed, so
    // no categoryId is sent and the server keeps the link.
    open('rent');
    assert.equal(text.value, 'Pay rent early');
    assert.equal(category.value, HOME);
    type(text, 'Pay rent today');
    save.click();
    await settle();
    assert.equal(Object.hasOwn(JSON.parse(patches().at(-1).body), 'categoryId'), false);
    assert.deepEqual([serverRow('rent').text, serverRow('rent').due, serverRow('rent').categoryId], ['Pay rent today', reminder, HOME]);
    // Put the row back for the tests after this one.
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
  });

  await t.test('a title-only edit keeps its category when the catalog disappears and returns', async () => {
    const original = { ...serverRow('rent'), categoryId: HOME };
    server.rows = server.rows.map((item) => (item.id === ids.rent ? original : item));
    await refresh();
    const catalog = server.categories;
    open('rent');
    server.categories = null;
    await refresh();
    assert.equal(category.disabled, true);
    server.categories = catalog;
    await refresh();
    assert.equal(category.disabled, false);
    assert.equal(category.value, HOME);
    type(text, 'Pay rent tomorrow');
    save.click();
    await settle();
    const body = JSON.parse(patches().at(-1).body);
    const saved = serverRow('rent');
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    await refresh();
    assert.equal(body.text, 'Pay rent tomorrow');
    assert.equal(Object.hasOwn(body, 'categoryId'), false);
    assert.equal(saved.categoryId, HOME);
  });

  await t.test('a sheet whose chosen or original category is deleted elsewhere closes and says so', async () => {
    const original = { ...serverRow('rent') };
    open('rent');
    choose(BILLS);
    const before = patches().length;
    server.categories = server.categories.filter((item) => item.id !== BILLS); // another tab deletes Bills
    await refresh();
    assert.equal(layer.hidden, true);
    assert.equal(syncText.textContent, categoryGone);
    assert.equal(focusKey(), JSON.stringify(['open', ids.rent]));
    assert.deepEqual(category.querySelectorAll('option').map((option) => option.textContent), ['Uncategorized', 'Home']);
    byId('sync-dismiss').click();
    // The task's own category: the delete unlinks it (a new revision) while the sheet is open.
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...item, categoryId: HOME } : item));
    await refresh();
    open('rent');
    assert.equal(category.value, HOME);
    server.categories = [];
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...item, categoryId: null, revision: item.revision + 1 } : item));
    await refresh();
    assert.equal(layer.hidden, true);
    assert.equal(syncText.textContent, categoryGone);
    assert.equal(patches().length, before, 'nothing was sent');
    byId('sync-dismiss').click();
    server.categories = [{ id: HOME, name: 'Home', revision: 1 }, { id: BILLS, name: 'Bills', revision: 1 }];
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    await refresh();
  });

  await t.test('a save that moves the task out of the filtered view sends focus to a neighbour or the filter', async () => {
    const original = { ...serverRow('rent') };
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...item, categoryId: HOME, revision: item.revision + 1 } : item));
    await refresh();
    byId('category-filter').value = HOME;
    byId('category-filter').dispatchEvent(new Event('change'));
    assert.deepEqual(list.children.map((item) => item.dataset.id), [ids.rent]);
    open('rent');
    choose('');
    save.click();
    assert.equal(byId('filter-empty').hidden, false);
    assert.equal(byId('empty-state').hidden, true, 'the global empty state stays for no tasks at all');
    assert.equal(focusKey(), JSON.stringify(['category-filter']));
    await settle();
    assert.equal(serverRow('rent').categoryId, null);
    byId('category-filter').value = 'all';
    byId('category-filter').dispatchEvent(new Event('change'));
    server.rows = server.rows.map((item) => (item.id === ids.rent ? { ...original, revision: item.revision + 1 } : item));
    await refresh();
  });

  await t.test('a reminder claim while the form is open keeps the draft; an edit of a field does not', async () => {
    const original = { ...serverRow('rent') };
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

  await t.test('retry omits an assignment when the refreshed catalog is missing', async () => {
    const catalog = server.categories;
    const original = serverRow('rent').categoryId;
    const target = catalog.find(({ id }) => id !== original).id;
    server.failNext = (method) => (method === 'PATCH' ? new Response('{}', { status: 500 }) : undefined);
    open('rent');
    type(text, 'Rent paid');
    choose(target);
    save.click();
    await settle();
    assert.equal(JSON.parse(patches().at(-1).body).categoryId, target);
    server.categories = null;
    const sent = patches().length;
    try {
      byId('sync-retry').click();
      await settle();
      assert.equal(patches().length, sent + 1);
      assert.equal(Object.hasOwn(JSON.parse(patches().at(-1).body), 'categoryId'), false);
      assert.equal(serverRow('rent').text, 'Rent paid');
      assert.equal(serverRow('rent').categoryId, original);
    } finally {
      server.categories = catalog;
      await refresh();
    }
  });

  await t.test('a reminder-only edit saves legacy tags as words in the title', async () => {
    const original = serverRow('rent');
    server.rows = server.rows.map((item) => (item === original ? { ...item, tags: ['home', 'urgent'] } : item));
    try {
      await refresh();
      open('rent');
      setWhen('2099-06-07T09:30');
      save.click();
      await settle();
      const expected = `${original.text} #home #urgent`;
      const body = JSON.parse(patches().at(-1).body);
      assert.deepEqual([body.text, body.tags], [expected, []]);
      assert.deepEqual([serverRow('rent').text, serverRow('rent').tags], [expected, []]);
    } finally {
      server.rows = server.rows.map((item) => (item.id === original.id ? { ...original, revision: item.revision + 1 } : item));
      await refresh();
    }
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
    server.rows.push({ ...base, id: '00000000-0000-4000-8000-0000000000a3', text: 'Temporary', tags: [], createdAt: 3 });
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

test('category options with built-in names are grouped and the built-in clears the task category', async (t) => {
  const server = createFakeApi({ user: { name: 'Ana', email: 'cli-ana@example.test' } });
  const id = '00000000-0000-4000-8000-0000000000a1';
  server.categories = [
    { id: HOME, name: 'Uncategorized', revision: 1 },
    { id: BILLS, name: 'All categories', revision: 1 },
  ];
  server.rows = [{ id, text: 'Pay rent', completed: false, createdAt: 1, tags: [], categoryId: HOME,
    due: null, repeat: 'none', notified: null, revision: 1 }];
  const { byId, list } = installDom(t, { fetch: server.fetch });
  await import('../src/app.js?grouped-categories');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();
  list.children[0].querySelector('.todo-open').click();

  const edit = byId('edit-category');
  const options = (elements) => elements.map(({ tagName, value, textContent }) => [tagName, value, textContent]);
  for (const [select, builtIns] of [
    [byId('category-filter'), [['option', 'all', 'All categories'], ['option', 'none', 'Uncategorized']]],
    [edit, [['option', '', 'Uncategorized']]],
  ]) {
    const group = select.children.at(-1);
    assert.equal(group.tagName, 'optgroup');
    assert.equal(group.getAttribute('label'), 'Categories');
    assert.deepEqual(options(select.children.slice(0, -1)), builtIns);
    assert.deepEqual(options(group.children), [
      ['option', BILLS, 'All categories'], ['option', HOME, 'Uncategorized'],
    ]);
  }
  assert.equal(edit.value, HOME);
  edit.value = edit.children[0].value;
  edit.dispatchEvent(new Event('change'));
  byId('reminder-save').click();
  await settle();
  assert.equal(server.rows[0].categoryId, null);
  const body = JSON.parse(server.requests.find(({ method }) => method === 'PATCH').body);
  assert.equal(body.categoryId, null);
  assert.deepEqual(body.tags, []);
});
