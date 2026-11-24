// The Category filter row and the Manage panel in src/app.js, run against the fake API: create,
// rename and confirmed delete, the server's refusals, focus return and the filter resetting when
// its category is deleted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';
import { markupAttributes } from './markup.js';

const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const TASK = '00000000-0000-4000-8000-0000000000d1';

test('the filter row and the panel are plain page controls with the agreed wording', () => {
  assert.match(markup, /<label class="category-key" for="category-filter">Category<\/label>/);
  assert.match(markup, /<label class="reminder-label" for="edit-category">Category<\/label>/);
  assert.equal(markupAttributes('category-filter').class, 'category-select');
  assert.equal(markupAttributes('category-manage')['aria-controls'], 'category-panel');
  // An in-page section, not a second dialog over the page or the task sheet.
  assert.equal(markupAttributes('category-panel').role, undefined);
  assert.match(markup, /id="category-empty" hidden>No categories yet</);
  assert.match(markup, /id="filter-empty" hidden>No tasks match these filters</);
  assert.doesNotMatch(markup, /#tags|edit-tags|filter-bar|Add tag/);
});

test('Manage: create, rename and delete wait for the server', async (t) => {
  const server = createFakeApi();
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const panel = byId('category-panel');
  const manage = byId('category-manage');
  const name = byId('category-name');
  const status = byId('category-status');
  const filter = byId('category-filter');
  const items = () => byId('category-list').children;
  const item = (label) => items().find((li) => (li.querySelector('.category-name')?.textContent ?? '') === label);
  const button = (li, action) => li.querySelectorAll('button').find((element) => element.dataset.action === action);
  const focusKey = () => document.activeElement?.dataset?.focusKey;
  const requests = (method) => server.requests.filter((request) => request.method === method && request.path.startsWith('/api/categories'));
  const create = async (value) => {
    name.value = value;
    name.dispatchEvent(new Event('input'));
    byId('category-form').dispatchEvent(new Event('submit'));
  };
  const keydown = (target, key, on = byId('category-list')) => {
    const event = Object.assign(new Event('keydown'), { key });
    Object.defineProperty(event, 'target', { value: target });
    on.dispatchEvent(event);
    return event;
  };
  const filterOptions = () => filter.children.map((option) => option.textContent);
  // The fake DOM doesn't bubble: the list stands in for an input event from a rename field.
  const typeInto = (field, value) => {
    field.value = value;
    const event = new Event('input');
    Object.defineProperty(event, 'target', { value: field });
    byId('category-list').dispatchEvent(event);
  };

  await t.test('with no tasks the filter row and Manage are there; the panel opens empty', () => {
    assert.equal(byId('empty-state').hidden, false);
    assert.equal(byId('category-row').hidden, false);
    assert.deepEqual(filterOptions(), ['All categories', 'Uncategorized']);
    manage.click();
    assert.equal(panel.hidden, false);
    assert.equal(manage.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, byId('category-panel-title'));
    assert.equal(byId('category-empty').hidden, false);
    assert.deepEqual(items(), []);
  });

  await t.test('a new category appears once the server has it', async () => {
    await create('  Home ');
    assert.equal(status.textContent, 'Adding…');
    assert.deepEqual(items(), [], 'not optimistic');
    await settle();
    assert.deepEqual(items().map((li) => li.querySelector('.category-name').textContent), ['Home']);
    assert.equal(status.textContent, 'Added “Home”.');
    assert.equal(name.value, '');
    assert.equal(byId('category-empty').hidden, true);
    assert.deepEqual(JSON.parse(requests('POST')[0].body).name, 'Home');
    assert.deepEqual(filterOptions(), ['All categories', 'Uncategorized', 'Home']);
    await create('Errands');
    await settle();
    assert.deepEqual(items().map((li) => li.querySelector('.category-name').textContent), ['Errands', 'Home'], 'A to Z');
  });

  await t.test('empty and duplicate names are refused here; the server\'s refusals are explained', async () => {
    const sent = requests('POST').length;
    await create('   ');
    assert.equal(status.textContent, 'Enter a category name.');
    await create('HOME');
    assert.equal(status.textContent, 'A category with that name already exists.');
    assert.equal(name.getAttribute('aria-invalid'), 'true');
    assert.equal(document.activeElement, name);
    assert.equal(requests('POST').length, sent, 'nothing sent');
    // Another tab took the name first: the server says so and the list reloads.
    server.categories = [...server.categories, { id: '00000000-0000-4000-8000-0000000000e1', name: 'Work', revision: 1 }];
    await create('work');
    await settle();
    assert.equal(status.textContent, 'A category with that name already exists.');
    assert.ok(item('Work'), 'the reload shows the other tab\'s category');
  });

  await t.test('at 50 categories the server refuses another and the panel says what to do', async () => {
    const real = server.categories;
    server.categories = [...real, ...Array.from({ length: 50 - real.length }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: `Spare ${i}`, revision: 1,
    }))];
    await create('One more');
    await settle();
    assert.equal(status.textContent, 'You can have up to 50 categories. Delete one to add another.');
    assert.equal(status.className.includes('is-error'), true);
    assert.equal(items().length, 50);
    server.categories = real;
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    assert.equal(items().length, 3);
  });

  await t.test('Rename edits in the row; Enter saves and focus returns to Rename', async () => {
    server.rows = [{
      id: TASK, text: 'Water plants', completed: false, createdAt: 1, tags: [], categoryId: item('Home').dataset.id,
      due: null, repeat: 'none', notified: null, revision: 1,
    }];
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    const id = item('Home').dataset.id;
    button(item('Home'), 'rename').click();
    const field = items().find((li) => li.dataset.id === id).querySelector('.category-field');
    assert.equal(document.activeElement, field);
    assert.equal(field.value, 'Home');
    typeInto(field, 'House');
    keydown(field, 'Enter');
    assert.equal(status.textContent, 'Saving…');
    await settle();
    assert.ok(item('House'));
    assert.equal(status.textContent, 'Renamed to “House”.');
    assert.equal(focusKey(), JSON.stringify(['category-rename', id]));
    assert.equal(list.children[0].querySelector('.todo-category').textContent, 'House', 'the card follows');
    assert.deepEqual(JSON.parse(requests('PATCH').at(-1).body), { name: 'House', revision: 1 });
  });

  await t.test('a rename keeps its opening revision through a refresh and closes on conflict', async () => {
    const id = item('House').dataset.id;
    button(item('House'), 'rename').click();
    const field = () => items().find((li) => li.dataset.id === id).querySelector('.category-field');
    typeInto(field(), 'Den');
    server.categories = server.categories.map((category) => (category.id === id ? { ...category, name: 'Flat', revision: 9 } : category));
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    assert.equal(field().value, 'Den');
    const sent = requests('PATCH').length;
    keydown(field(), 'Enter');
    await settle();
    assert.equal(requests('PATCH').length, sent + 1);
    assert.equal(JSON.parse(requests('PATCH').at(-1).body).revision, 2);
    assert.equal(status.textContent, 'This category changed in another tab or device. The list is up to date now. Try again if needed.');
    assert.equal(server.categories.find((category) => category.id === id).name, 'Flat');
    assert.equal(field(), null, 'the stale draft closes');
    assert.ok(item('Flat'));
    assert.equal(focusKey(), JSON.stringify(['category-rename', id]));
  });

  await t.test('Delete asks first; Cancel returns focus; confirmed, its tasks become uncategorized', async () => {
    const id = item('Flat').dataset.id;
    filter.value = id;
    filter.dispatchEvent(new Event('change'));
    assert.equal(list.children.length, 1);
    button(item('Flat'), 'delete').click();
    const row = () => items().find((li) => li.dataset.id === id);
    assert.equal(row().querySelector('.category-question').textContent, 'Delete category? Its tasks will become uncategorized.');
    assert.deepEqual(row().querySelectorAll('button').map((element) => element.textContent), ['Cancel', 'Delete']);
    assert.equal(focusKey(), JSON.stringify(['category-cancel', id]));
    assert.equal(document.activeElement.getAttribute('aria-describedby'), row().querySelector('.category-question').id);
    button(row(), 'cancel').click();
    assert.equal(focusKey(), JSON.stringify(['category-delete', id]));
    assert.equal(requests('DELETE').length, 0);
    // Esc also backs out of the question, and leaves the panel open.
    button(row(), 'delete').click();
    keydown(byId('category-panel'), 'Escape', panel);
    assert.equal(panel.hidden, false);
    assert.equal(focusKey(), JSON.stringify(['category-delete', id]));

    button(row(), 'delete').click();
    button(row(), 'confirm').click();
    assert.equal(status.textContent, 'Deleting…');
    assert.ok(row(), 'still listed until the server answers');
    await settle();
    assert.equal(row(), undefined);
    assert.equal(status.textContent, 'Deleted “Flat”. Its tasks are uncategorized now.');
    assert.equal(server.rows[0].categoryId, null);
    assert.equal(server.rows[0].revision, 2);
    // The filter was on that category: it goes back to All, and the task shows unlabelled.
    assert.equal(filter.value, 'all');
    assert.deepEqual(filterOptions(), ['All categories', 'Uncategorized', 'Errands', 'Work']);
    assert.equal(list.children[0].querySelector('.todo-category'), null);
    assert.equal(list.children[0].dataset.color, undefined);
    assert.equal(focusKey(), JSON.stringify(['category-rename', items().at(-1).dataset.id]), 'focus moves to a neighbour');
    // The next task write uses the revision the delete returned.
    list.children[0].querySelector('.todo-open').click();
    byId('edit-text').value = 'Water plants today';
    byId('reminder-save').click();
    await settle();
    assert.equal(server.rows[0].text, 'Water plants today');
    assert.equal(byId('sync-note').hidden, true);
  });

  await t.test('an empty filtered list says so; Esc and Done close the panel and focus Manage', () => {
    filter.value = items()[0].dataset.id;
    filter.dispatchEvent(new Event('change'));
    assert.equal(list.hidden, true);
    assert.equal(byId('filter-empty').hidden, false);
    assert.equal(byId('empty-state').hidden, true);
    filter.value = 'all';
    filter.dispatchEvent(new Event('change'));
    assert.equal(byId('filter-empty').hidden, true);
    keydown(panel, 'Escape', panel);
    assert.equal(panel.hidden, true);
    assert.equal(document.activeElement, manage);
    assert.equal(manage.getAttribute('aria-expanded'), 'false');
    manage.click();
    byId('category-done').click();
    assert.equal(panel.hidden, true);
    assert.equal(document.activeElement, manage);
  });

  await t.test('retry finds a committed create by UUID after both its response and reload failed', async () => {
    manage.click();
    const fetch = server.fetch;
    server.failNext = (method) => (method === 'POST' ? { afterWrite: true } : undefined);
    server.fetch = (path, init) => {
      if (path === '/api/todos' && init.method === 'GET') throw new TypeError('Failed to fetch');
      return fetch(path, init);
    };
    try {
      await create('Travel');
      await settle();
    } finally {
      server.fetch = fetch;
    }
    const { id } = JSON.parse(requests('POST').at(-1).body);
    assert.equal(name.value, 'Travel');
    assert.match(status.textContent, /Couldn't save/);
    // A remote rename frees the original name, so matching by name cannot prevent a duplicate.
    server.categories = server.categories.map((category) =>
      category.id === id ? { ...category, name: 'Trips', revision: 2 } : category);
    const posts = requests('POST').length;
    byId('category-form').dispatchEvent(new Event('submit'));
    await settle();
    assert.equal(requests('POST').length, posts, 'reconcile before another POST');
    assert.ok(item('Trips'));
    assert.equal(name.value, '');

    server.failNext = (method) => (method === 'POST' ? new TypeError('Failed to fetch') : undefined);
    await create('Books');
    await settle();
    const missing = JSON.parse(requests('POST').at(-1).body);
    const count = server.requests.length;
    byId('category-form').dispatchEvent(new Event('submit'));
    await settle();
    assert.deepEqual(server.requests.slice(count).map(({ method }) => method), ['GET', 'POST']);
    assert.deepEqual(JSON.parse(requests('POST').at(-1).body), missing);
    assert.ok(item('Books'));
  });

  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
});
