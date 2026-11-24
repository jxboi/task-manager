// The drag handle in src/app.js, run against the fake API: its name, keyboard reorder with the
// announcement, a pointer drag (lifted row, sliding rows, the gap, drop and cancel), the category filter
// and new tasks. The drag math itself is in drag.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { Element, installDom } from './dom.js';

const HOUR = 3_600_000;
const ROW = 56;
const LIST_TOP = 200;

test('drag handle reorder', async (t) => {
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const frames = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: () => {},
  });
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  Object.assign(window, { scrollY: 0, innerHeight: 844, scrollBy() {} });
  document.documentElement = new Element();

  const ids = {
    late: '00000000-0000-4000-8000-0000000000b0',
    alpha: '00000000-0000-4000-8000-0000000000b1',
    bravo: '00000000-0000-4000-8000-0000000000b2',
    charlie: '00000000-0000-4000-8000-0000000000b3',
    delta: '00000000-0000-4000-8000-0000000000b4',
  };
  const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1 };
  const due = Date.now() - HOUR;
  const server = createFakeApi();
  server.rows = [
    // Overdue (and already alerted): on top by due time, with no handle.
    { ...base, id: ids.late, text: 'Late', category: null, createdAt: 5, due, notified: due },
    { ...base, id: ids.alpha, text: 'Alpha', category: null, createdAt: 1 },
    { ...base, id: ids.bravo, text: 'Bravo', category: 'work', createdAt: 2 },
    { ...base, id: ids.charlie, text: 'Charlie', category: null, createdAt: 3 },
    { ...base, id: ids.delta, text: 'Delta', category: 'work', createdAt: 4 },
  ];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const announcer = byId('announcer');
  const layer = byId('reminder-layer');
  const rows = () => list.children.filter((item) => item.dataset.id);
  const shown = () => rows().map((item) => names[item.dataset.id] ?? item.querySelector('.todo-text').textContent);
  const row = (name) => rows().find((item) => item.dataset.id === (ids[name] ?? name));
  const handle = (name) => row(name).querySelector('.todo-handle');
  const focusKey = () => document.activeElement?.dataset?.focusKey;
  const moves = () => server.requests.filter((request) => request.method === 'PATCH')
    .map((request) => JSON.parse(request.body))
    .filter((body) => body.action === 'move')
    .map(({ anchorId, side }) => [names[anchorId], side]);
  const serverOrder = () => server.rows.map((item) => names[item.id] ?? item.text);
  const press = (target, key, extra = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });
    Object.defineProperty(event, 'target', { value: target });
    list.dispatchEvent(event);
    return event;
  };
  // Lay the rendered rows out top to bottom, ROW px each, from LIST_TOP.
  const layout = () => rows().forEach((item, i) => { item.rect = { top: LIST_TOP + i * ROW, height: ROW }; });
  list.rect = { top: LIST_TOP, height: 0 };
  const pointer = (target, type, clientY, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { clientY, pointerId: 7, button: 0, ...extra });
    Object.defineProperty(event, 'target', { value: target });
    (type === 'pointerdown' ? list : target).dispatchEvent(event);
    return event;
  };

  await t.test('every row but the overdue one has a named handle on the right', () => {
    assert.deepEqual(shown(), ['late', 'alpha', 'bravo', 'charlie', 'delta']);
    assert.equal(row('late').querySelector('.todo-handle'), null);
    assert.ok(row('late').querySelector('.todo-handle-space'));
    const grip = handle('alpha');
    assert.equal(grip.tagName, 'button');
    assert.equal(grip.type, 'button');
    assert.equal(grip.getAttribute('aria-label'), 'Reorder Alpha');
    assert.equal(grip.getAttribute('aria-describedby'), 'reorder-hint');
    assert.equal(row('alpha').children.at(-1), grip, 'last in the row: on the right');
    assert.equal(grip.dataset.focusKey, JSON.stringify(['handle', ids.alpha]));
  });

  await t.test('the handle never opens the edit sheet; the row body still does', () => {
    handle('alpha').click();
    assert.equal(layer.hidden, true);
    row('alpha').querySelector('.todo-open').click();
    assert.equal(layer.hidden, false);
    byId('reminder-cancel').click();
    assert.equal(layer.hidden, true);
  });

  await t.test('Arrow Down moves the task one place, keeps focus on its handle and says where', async () => {
    const event = press(handle('alpha'), 'ArrowDown');
    assert.equal(event.defaultPrevented, true, 'the page does not scroll');
    assert.deepEqual(shown(), ['late', 'bravo', 'alpha', 'charlie', 'delta'], 'shown at once');
    assert.equal(focusKey(), JSON.stringify(['handle', ids.alpha]));
    assert.equal(announcer.textContent, 'Moved “Alpha” to position 2 of 4.');
    await settle();
    assert.deepEqual(moves(), [['bravo', 'after']]);
    assert.deepEqual(serverOrder().filter((name) => name !== 'late'), ['bravo', 'alpha', 'charlie', 'delta']);
  });

  await t.test('Alt+Arrow Up works too; at either end a key only says so', async () => {
    press(handle('alpha'), 'ArrowUp', { altKey: true });
    assert.deepEqual(shown(), ['late', 'alpha', 'bravo', 'charlie', 'delta']);
    assert.equal(announcer.textContent, 'Moved “Alpha” to position 1 of 4.');
    await settle();
    const sent = moves().length;
    press(handle('alpha'), 'ArrowUp');
    assert.equal(announcer.textContent, '“Alpha” is already first.', 'not above the overdue row');
    press(handle('delta'), 'End');
    assert.equal(announcer.textContent, '“Delta” is already last.');
    // Not reorder keys: left alone.
    assert.equal(press(handle('alpha'), 'Enter').defaultPrevented, false);
    assert.equal(press(handle('alpha'), 'ArrowDown', { metaKey: true }).defaultPrevented, false);
    await settle();
    assert.equal(moves().length, sent);
    assert.deepEqual(shown(), ['late', 'alpha', 'bravo', 'charlie', 'delta']);
  });

  await t.test('Home and End go to the first and last place', async () => {
    press(handle('charlie'), 'Home');
    assert.deepEqual(shown(), ['late', 'charlie', 'alpha', 'bravo', 'delta']);
    press(handle('charlie'), 'End');
    assert.deepEqual(shown(), ['late', 'alpha', 'bravo', 'delta', 'charlie']);
    assert.equal(announcer.textContent, 'Moved “Charlie” to position 4 of 4.');
    await settle();
    assert.deepEqual(moves().slice(-2), [['alpha', 'before'], ['delta', 'after']]);
    assert.deepEqual(serverOrder().filter((name) => name !== 'late'), ['alpha', 'bravo', 'delta', 'charlie']);
  });

  await t.test('a pointer drag lifts the row, slides the others, shows the gap and drops', async () => {
    layout(); // late 200, alpha 256, bravo 312, delta 368, charlie 424
    const grip = handle('charlie');
    const down = pointer(grip, 'pointerdown', 450);
    assert.equal(down.defaultPrevented, true);
    const lifted = row('charlie');
    assert.ok(lifted.classList.contains('is-lifted'));
    assert.ok(list.classList.contains('is-reordering'));
    const slot = list.children.find((item) => item.className === 'todo-slot');
    assert.ok(slot, 'a gap marker in the list');
    assert.equal(slot.getAttribute('aria-hidden'), 'true');
    assert.equal(slot.style.top, `${424 - LIST_TOP}px`, 'the gap starts where the row is');

    // Up past bravo's center (340): charlie's center 452 - 120 = 332.
    pointer(grip, 'pointermove', 330);
    assert.equal(lifted.style.transform, 'translateY(-120px)');
    assert.equal(row('bravo').style.transform, `translateY(${ROW}px)`);
    assert.equal(row('delta').style.transform, `translateY(${ROW}px)`);
    assert.equal(row('alpha').style.transform, '');
    assert.equal(slot.style.top, `${312 - LIST_TOP}px`, 'the gap is where bravo was');
    assert.equal(byId('drag-status').hidden, false);
    assert.equal(byId('drag-status').textContent, 'Moving to position 2 of 4');

    // Far up: clamped below the overdue row, the row lands first.
    pointer(grip, 'pointermove', -500);
    assert.equal(lifted.style.transform, `translateY(${256 - 424}px)`);
    pointer(grip, 'pointermove', 330);
    pointer(grip, 'pointerup', 330);
    assert.equal(lifted.classList.contains('is-lifted'), false);
    assert.equal(list.classList.contains('is-reordering'), false);
    assert.equal(slot.isConnected, false);
    assert.equal(byId('drag-status').hidden, true, 'the status bar goes away on drop');
    assert.ok(rows().every((item) => !item.style.transform));
    assert.deepEqual(shown(), ['late', 'alpha', 'charlie', 'bravo', 'delta']);
    assert.equal(announcer.textContent, 'Moved “Charlie” to position 2 of 4.');
    await settle();
    assert.deepEqual(moves().at(-1), ['bravo', 'before']);
    assert.deepEqual(serverOrder().filter((name) => name !== 'late'), ['alpha', 'charlie', 'bravo', 'delta']);
  });

  await t.test('a tap on the handle, a cancelled drag or Esc moves nothing', async () => {
    const sent = moves().length;
    layout();
    pointer(handle('alpha'), 'pointerdown', 280);
    pointer(handle('alpha'), 'pointerup', 280);
    pointer(handle('alpha'), 'pointerdown', 280);
    pointer(handle('alpha'), 'pointermove', 400);
    assert.notEqual(row('bravo').style.transform, '');
    pointer(handle('alpha'), 'pointercancel', 400);
    assert.ok(rows().every((item) => !item.style.transform));
    assert.equal(list.children.some((item) => item.className === 'todo-slot'), false);
    pointer(handle('alpha'), 'pointerdown', 280);
    pointer(handle('alpha'), 'pointermove', 400);
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(row('alpha').classList.contains('is-lifted'), false);
    pointer(handle('alpha'), 'pointerup', 400); // after Esc the release does nothing
    await settle();
    assert.equal(moves().length, sent);
    assert.deepEqual(shown(), ['late', 'alpha', 'charlie', 'bravo', 'delta']);
    assert.equal(layer.hidden, true, 'and the sheet stayed shut');
  });

  await t.test('the overdue row is not a drop target and cannot be dragged', async () => {
    layout();
    const sent = moves().length;
    assert.equal(pointer(row('late').querySelector('.todo-open'), 'pointerdown', 220).defaultPrevented, false);
    await settle();
    assert.equal(moves().length, sent);
  });

  await t.test('with a category selected, moves are among the visible tasks; hidden ones keep their order', async () => {
    const chip = byId('filter-bar').children.find((item) => item.dataset.category === 'work');
    chip.click();
    assert.deepEqual(shown(), ['bravo', 'delta']);
    assert.equal(byId('app-title').textContent, 'work', 'a category on: the title names the shelf');
    assert.ok(byId('app-header').dataset.color !== undefined, 'and the header takes its color');
    const hiddenBefore = serverOrder().filter((name) => !['bravo', 'delta'].includes(name));
    press(handle('bravo'), 'ArrowDown');
    assert.deepEqual(shown(), ['delta', 'bravo']);
    assert.equal(announcer.textContent, 'Moved “Bravo” to position 2 of 2.');
    layout();
    const grip = handle('bravo');
    pointer(grip, 'pointerdown', 230);
    pointer(grip, 'pointermove', 100);
    pointer(grip, 'pointerup', 100);
    assert.deepEqual(shown(), ['bravo', 'delta']);
    await settle();
    assert.deepEqual(moves().slice(-2), [['delta', 'after'], ['delta', 'before']]);
    assert.deepEqual(serverOrder().filter((name) => !['bravo', 'delta'].includes(name)), hiddenBefore);
    byId('clear-filters').click();
    assert.deepEqual(shown(), ['late', 'alpha', 'charlie', 'bravo', 'delta']);
    assert.equal(byId('app-title').textContent, 'Tasks');
    assert.equal(byId('app-header').dataset.color, undefined);
  });

  await t.test('a new task appears last and can be reordered', async () => {
    const input = byId('new-todo');
    input.value = 'Echo';
    byId('add-form').dispatchEvent(new Event('submit'));
    await settle();
    assert.deepEqual(shown(), ['late', 'alpha', 'charlie', 'bravo', 'delta', 'Echo']);
    const echo = rows().at(-1);
    press(echo.querySelector('.todo-handle'), 'Home');
    assert.deepEqual(shown(), ['late', 'Echo', 'alpha', 'charlie', 'bravo', 'delta']);
    await settle();
    assert.deepEqual(moves().at(-1), ['alpha', 'before']);
    assert.deepEqual(serverOrder().filter((name) => name !== 'late'), ['Echo', 'alpha', 'charlie', 'bravo', 'delta']);
  });

  await t.test('a refused move rolls back and says the list changed', async () => {
    server.rows = server.rows.map((item) => (item.id === ids.alpha ? { ...item, revision: item.revision + 1 } : item));
    press(handle('alpha'), 'ArrowDown');
    assert.deepEqual(shown(), ['late', 'Echo', 'charlie', 'alpha', 'bravo', 'delta']);
    await settle();
    assert.deepEqual(shown(), ['late', 'Echo', 'alpha', 'charlie', 'bravo', 'delta'], 'rolled back after the 409');
    assert.equal(byId('sync-note').hidden, false);
    assert.match(byId('sync-text').textContent, /changed in another tab/);
  });
});
