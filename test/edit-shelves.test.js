// The Shelves task sheet in src/app.js: the category picker (None, then categories by use), and
// Repeat as tiles that set the select the save path reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';

test('task sheet category picker and repeat tiles', async (t) => {
  const server = createFakeApi();
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1 };
  const id = (n) => `00000000-0000-4000-8000-0000000000d${n}`;
  const later = Date.now() + 86_400_000;
  server.rows = [
    { ...base, id: id(1), text: 'Plan offsite', category: 'work', createdAt: 1, due: later },
    { ...base, id: id(2), text: 'Groceries', category: 'errands', createdAt: 2 },
    { ...base, id: id(3), text: 'Dry cleaning', category: 'errands', createdAt: 3 },
  ];
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const picker = byId('edit-categories');
  const tiles = byId('repeat-tiles');
  const open = (n) => list.children.find((row) => row.dataset.id === id(n)).querySelector('.todo-open').click();
  const shown = () => picker.children.map((button) => button.textContent);
  const picked = () => picker.children.filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.dataset.category);
  const pressed = () => tiles.children.filter((tile) => tile.getAttribute('aria-pressed') === 'true')
    .map((tile) => tile.dataset.repeat);

  open(1);

  await t.test('None, then every category in use, most used first; the task\'s is pressed', () => {
    assert.deepEqual(shown(), ['None', 'errands', 'work']);
    assert.deepEqual(picked(), ['work']);
    assert.equal(byId('reminder-editor').dataset.color !== undefined, true, 'the sheet takes its color');
  });

  await t.test('tapping another picks it, keeps focus on it and recolors the sheet', () => {
    const before = byId('reminder-editor').dataset.color;
    const errands = picker.children.find((button) => button.dataset.category === 'errands');
    errands.click();
    assert.deepEqual(picked(), ['errands']);
    assert.notEqual(byId('reminder-editor').dataset.color, before);
    picker.children.find((button) => button.dataset.category === '').click();
    assert.deepEqual(picked(), ['']);
    assert.equal(byId('reminder-editor').dataset.color, undefined);
    picker.children.find((button) => button.dataset.category === 'errands').click();
  });

  await t.test('the tiles show the repeat and set it', () => {
    assert.deepEqual(pressed(), ['none']);
    tiles.children.find((tile) => tile.dataset.repeat === 'weekly').click();
    assert.equal(byId('reminder-repeat').value, 'weekly');
    assert.deepEqual(pressed(), ['weekly']);
  });

  await t.test('Save sends the picked category and the tile\'s repeat', async () => {
    byId('reminder-save').click();
    await settle();
    const row = server.rows.find((item) => item.id === id(1));
    assert.equal(row.category, 'errands');
    assert.equal(row.repeat, 'weekly');
  });

  // Signing out clears the reminder timer, so nothing keeps node:test alive.
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
});
