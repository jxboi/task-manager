// The Shelves task sheet in src/app.js: the user's other tags as one-tap chips, and Repeat as
// tiles that set the select the save path reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';

test('task sheet tag suggestions and repeat tiles', async (t) => {
  const server = createFakeApi();
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1 };
  const id = (n) => `00000000-0000-4000-8000-0000000000d${n}`;
  const later = Date.now() + 86_400_000;
  server.rows = [
    { ...base, id: id(1), text: 'Plan offsite', tags: ['work'], createdAt: 1, due: later },
    { ...base, id: id(2), text: 'Groceries', tags: ['errands', 'home'], createdAt: 2 },
    { ...base, id: id(3), text: 'Dry cleaning', tags: ['errands'], createdAt: 3 },
  ];
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const suggestions = byId('edit-tag-suggestions');
  const tiles = byId('repeat-tiles');
  const open = (n) => list.children.find((row) => row.dataset.id === id(n)).querySelector('.todo-open').click();
  const shown = () => suggestions.children.map((chip) => chip.dataset.tag);
  const draft = () => byId('edit-tags').children.map((chip) => chip.querySelector('.tag-label').dataset.tag);
  const pressed = () => tiles.children.filter((tile) => tile.getAttribute('aria-pressed') === 'true')
    .map((tile) => tile.dataset.repeat);

  open(1);

  await t.test('other tags are suggested, most used first, without the task\'s own', () => {
    assert.deepEqual(shown(), ['errands', 'home']);
    assert.equal(suggestions.hidden, false);
    assert.equal(suggestions.children[0].getAttribute('aria-label'), 'Add tag errands');
  });

  await t.test('tapping one adds it to the draft and moves focus to the next suggestion', () => {
    suggestions.children[0].click();
    assert.deepEqual(draft(), ['work', 'errands']);
    assert.deepEqual(shown(), ['home']);
    assert.equal(document.activeElement, suggestions.children[0]);
    suggestions.children[0].click();
    assert.deepEqual(draft(), ['work', 'errands', 'home']);
    assert.equal(suggestions.hidden, true, 'nothing left to suggest');
    assert.equal(document.activeElement, byId('edit-tag-add'));
  });

  await t.test('the tiles show the repeat and set it', () => {
    assert.deepEqual(pressed(), ['none']);
    tiles.children.find((tile) => tile.dataset.repeat === 'weekly').click();
    assert.equal(byId('reminder-repeat').value, 'weekly');
    assert.deepEqual(pressed(), ['weekly']);
  });

  await t.test('Save sends the suggested tags and the tile\'s repeat', async () => {
    byId('reminder-save').click();
    await settle();
    const row = server.rows.find((item) => item.id === id(1));
    assert.deepEqual(row.tags, ['work', 'errands', 'home']);
    assert.equal(row.repeat, 'weekly');
  });

  // Signing out clears the reminder timer, so nothing keeps node:test alive.
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
});
