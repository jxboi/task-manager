// Swipe left to delete in src/app.js, against the fake API: the row leaves the view at once and
// the delete waits behind the Undo toast (sent on its timeout, the next delete, pagehide or a
// hidden page), Undo puts it back in place, vertical gestures and the handle are left alone, the
// mouse and keyboard fallbacks, reduced motion, a failed delete, and a session reset.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { Element, installDom } from './dom.js';
import { UNDO_MS } from '../src/swipe.js';

const ROW = 72;
const WIDTH = 390;
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sessionB = { user: { name: 'Ben', email: 'ben@example.test' }, csrfToken: 'token-b' };

test('swipe left to delete, with Undo', async (t) => {
  const servers = { a: createFakeApi(), b: createFakeApi(sessionB) };
  let cookie = 'a';
  const { byId, list, matchMedia } = installDom(t, { fetch: (...args) => servers[cookie].fetch(...args) });
  const frames = [];
  Object.assign(globalThis, { requestAnimationFrame: (callback) => frames.push(callback), cancelAnimationFrame: () => {} });
  // The Undo timer on a fake clock; every other timeout runs for real.
  const realSetTimeout = globalThis.setTimeout;
  const undoTimers = new Map();
  let nextTimer = 1;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== UNDO_MS) return realSetTimeout(fn, ms, ...rest);
    undoTimers.set(nextTimer, fn);
    return nextTimer++;
  };
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => (undoTimers.delete(id) ? undefined : realClearTimeout(id));
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });
  const runUndoTimer = () => {
    const timers = [...undoTimers.values()];
    undoTimers.clear();
    for (const fn of timers) fn();
  };
  Object.assign(window, { scrollY: 0, innerHeight: 844, scrollBy() {} });
  document.documentElement = new Element();
  document.visibilityState = 'visible';

  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const base = { completed: false, due: null, repeat: 'none', notified: null, revision: 1, tags: [], categoryId: null };
  servers.a.rows = names.map((text, i) => ({ ...base, id: ID(i + 1), text, createdAt: i + 1 }));
  servers.b.rows = [{ ...base, id: ID(99), text: 'Ben task', createdAt: 1 }];
  const idOf = Object.fromEntries(names.map((text, i) => [text, ID(i + 1)]));

  await import('../src/app.js');
  const signIn = (active) => window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active } }));
  signIn(servers.a.session);
  await settle();

  const toast = byId('toast');
  const toastText = byId('toast-text');
  const undo = byId('toast-undo');
  const layer = byId('reminder-layer');
  const rows = () => list.children.filter((item) => item.dataset.id);
  const shown = () => rows().map((item) => item.querySelector('.todo-text').textContent);
  const row = (text) => rows().find((item) => item.querySelector('.todo-text').textContent === text);
  const focusKey = () => document.activeElement?.dataset?.focusKey;
  const deletes = () => servers.a.requests.filter((request) => request.method === 'DELETE')
    .map((request) => names.find((text) => request.path.includes(idOf[text])));
  const layout = () => rows().forEach((item, i) => { item.rect = { top: 200 + i * ROW, height: ROW, width: WIDTH }; });
  list.rect = { top: 200, height: 0 };

  let clock = 1000;
  const pointer = (target, type, clientX, clientY, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX, clientY, pointerId: 3, button: 0, isPrimary: true, pointerType: 'touch', ...extra,
    });
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'timeStamp', { value: clock });
    list.dispatchEvent(event);
    return event;
  };
  // A gesture from (x, y) through each [dx, dy, ms] step, then released (or cancelled).
  const gesture = (target, steps, { end = 'pointerup', ...extra } = {}) => {
    layout();
    const [x, y] = [300, target.closest('.todo').rect.top + 30];
    pointer(target, 'pointerdown', x, y, extra);
    for (const [dx, dy, ms] of steps) {
      clock += ms;
      pointer(target, 'pointermove', x + dx, y + dy, extra);
    }
    clock += 16;
    pointer(target, end, x + steps.at(-1)[0], y + steps.at(-1)[1], extra);
  };
  const swipeLeft = (text, extra) => gesture(row(text).querySelector('.todo-open'), [[-12, 2, 16], [-80, 4, 60], [-220, 6, 120]], extra);
  const slid = () => new Promise((resolve) => realSetTimeout(resolve, 220));
  const press = (target, key, extra = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });
    Object.defineProperty(event, 'target', { value: target });
    list.dispatchEvent(event);
    return event;
  };

  assert.deepEqual(shown(), names);

  await t.test('a swipe past the threshold removes the row from view; the delete waits', async () => {
    const alpha = row('Alpha');
    swipeLeft('Alpha');
    // The click of the swipe's press neither opens the sheet nor counts as a tap.
    alpha.querySelector('.todo-open').click();
    assert.equal(layer.hidden, true);
    assert.match(alpha.className, /is-leaving/);
    assert.equal(alpha.style.transform, 'translateX(-100%)');
    await slid();
    await settle();
    assert.deepEqual(shown(), names.slice(1));
    assert.equal(toast.hidden, false);
    assert.equal(toastText.textContent, 'Task deleted');
    assert.deepEqual(deletes(), []);
    assert.equal(servers.a.rows.length, names.length);
    // Focus goes to the next row, like the sheet's Delete.
    assert.equal(focusKey(), JSON.stringify(['checkbox', idOf.Bravo]));
    // A later render (any sync change) does not bring it back.
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.deepEqual(shown(), names.slice(1));
  });

  await t.test('Undo restores the row in its place and focuses it', async () => {
    undo.click();
    await settle();
    assert.deepEqual(shown(), names);
    assert.equal(toast.hidden, true);
    assert.equal(focusKey(), JSON.stringify(['open', idOf.Alpha]));
    assert.equal(undoTimers.size, 0);
    runUndoTimer();
    await settle();
    assert.deepEqual(deletes(), []);
  });

  await t.test('a vertical gesture (scroll) does not delete and does not move the row', async () => {
    const bravo = row('Bravo');
    gesture(bravo.querySelector('.todo-open'), [[-4, 14, 16], [-30, 120, 60]], { end: 'pointercancel' });
    await settle();
    assert.deepEqual(shown(), names);
    assert.equal(bravo.style.transform ?? '', '');
    assert.equal(toast.hidden, true);
    // Its tap still opens the sheet.
    bravo.querySelector('.todo-open').click();
    assert.equal(layer.hidden, false);
    byId('reminder-cancel').click();
    await settle();
    assert.equal(layer.hidden, true);
  });

  await t.test('a short slow swipe springs back; the row still opens on a later tap', async () => {
    const charlie = row('Charlie');
    gesture(charlie.querySelector('.todo-open'), [[-12, 0, 16], [-60, 0, 400], [-80, 0, 400]]);
    assert.equal(charlie.style.transform, '');
    assert.match(charlie.className, /is-settling/);
    await slid();
    await settle();
    assert.deepEqual(shown(), names);
    assert.equal(toast.hidden, true);
    // The swallowed click was the swipe's only: after it, a click opens the sheet as usual.
    await new Promise((resolve) => realSetTimeout(resolve, 450));
    row('Charlie').querySelector('.todo-open').click();
    assert.equal(layer.hidden, false);
    byId('reminder-cancel').click();
    await settle();
  });

  await t.test('a swipe that starts on the checkbox does not tick it', async () => {
    const delta = row('Delta');
    gesture(delta.querySelector('.todo-checkbox'), [[-12, 0, 16], [-30, 0, 200]]);
    const click = new Event('click', { cancelable: true });
    Object.defineProperty(click, 'target', { value: delta.querySelector('.todo-checkbox') });
    list.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    await settle();
    assert.equal(servers.a.requests.filter((request) => request.method === 'PATCH').length, 0);
  });

  await t.test('a swipe from the drag handle does not delete, and the handle still reorders', async () => {
    layout();
    const handle = row('Alpha').querySelector('.todo-handle');
    const handleEvent = (type, clientX, clientY) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { clientX, clientY, pointerId: 9, button: 0, isPrimary: true });
      Object.defineProperty(event, 'target', { value: handle });
      (type === 'pointerdown' ? list : handle).dispatchEvent(event);
    };
    handleEvent('pointerdown', 360, 230);
    // Sideways on the handle: no swipe.
    pointer(handle, 'pointermove', 100, 232, { pointerId: 9 });
    assert.equal(row('Alpha').style.transform, 'translateY(0px)');
    handleEvent('pointermove', 360, 230 + ROW * 1.6);
    handleEvent('pointerup', 360, 230 + ROW * 1.6);
    pointer(handle, 'pointerup', 360, 230 + ROW * 1.6, { pointerId: 9 });
    await settle();
    assert.deepEqual(shown().slice(0, 3), ['Bravo', 'Alpha', 'Charlie']);
    assert.equal(toast.hidden, true);
    assert.deepEqual(deletes(), []);
    const moves = servers.a.requests.filter((request) => request.method === 'PATCH' && JSON.parse(request.body).action === 'move');
    assert.equal(moves.length, 1);
  });

  await t.test('a second delete commits the first; the timeout commits the second', async () => {
    swipeLeft('Alpha', { pointerType: 'mouse' });
    await slid();
    await settle();
    assert.deepEqual(deletes(), []);
    // Keyboard: Delete on the focused row's checkbox.
    const event = press(row('Bravo').querySelector('.todo-checkbox'), 'Delete');
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.deepEqual(deletes(), ['Alpha']);
    assert.equal(servers.a.rows.some((item) => item.text === 'Alpha'), false);
    assert.deepEqual(shown(), ['Charlie', 'Delta', 'Echo', 'Foxtrot']);
    assert.equal(toast.hidden, false);
    assert.equal(focusKey(), JSON.stringify(['checkbox', idOf.Charlie]));
    // The toast runs out.
    runUndoTimer();
    await settle();
    assert.deepEqual(deletes(), ['Alpha', 'Bravo']);
    assert.equal(toast.hidden, true);
    assert.deepEqual(shown(), ['Charlie', 'Delta', 'Echo', 'Foxtrot']);
  });

  await t.test('Backspace on a row body; leaving the page (pagehide, hidden) sends the delete', async () => {
    press(row('Charlie').querySelector('.todo-open'), 'Backspace');
    // With a modifier, or typed elsewhere, nothing happens.
    press(row('Delta').querySelector('.todo-open'), 'Delete', { metaKey: true });
    await settle();
    assert.deepEqual(shown(), ['Delta', 'Echo', 'Foxtrot']);
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.deepEqual(deletes(), ['Alpha', 'Bravo', 'Charlie']);
    assert.equal(toast.hidden, true);

    press(row('Delta').querySelector('.todo-checkbox'), 'Delete');
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    document.visibilityState = 'visible';
    assert.deepEqual(deletes(), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
    assert.deepEqual(servers.a.rows.map((item) => item.text), ['Echo', 'Foxtrot']);
  });

  await t.test('reduced motion: the row goes at once, with no slide', async () => {
    matchMedia('(prefers-reduced-motion: reduce)').matches = true;
    swipeLeft('Echo');
    await settle();
    assert.deepEqual(shown(), ['Foxtrot']);
    assert.equal(toast.hidden, false);
    undo.click();
    await settle();
    assert.deepEqual(shown(), ['Echo', 'Foxtrot']);
    matchMedia('(prefers-reduced-motion: reduce)').matches = false;
  });

  await t.test('a refused delete (409) brings the row back and says so', async () => {
    servers.a.failNext = (method) => (method === 'DELETE'
      ? new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT' } }), { status: 409 }) : undefined);
    press(row('Echo').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.deepEqual(shown(), ['Foxtrot']);
    runUndoTimer();
    await settle(10);
    assert.deepEqual(shown(), ['Echo', 'Foxtrot']);
    assert.equal(byId('sync-note').hidden, false);
    assert.equal(servers.a.rows.length, 2);
    byId('sync-dismiss').click();
  });

  await t.test('a reminder of a task waiting to be deleted does not fire', async () => {
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Foxtrot'
      ? { ...item, due: Date.now() + 150, revision: item.revision + 1 } : item));
    signIn({ ...servers.a.session }); // the same session re-read: reloads the list
    await settle();
    press(row('Foxtrot').querySelector('.todo-checkbox'), 'Delete');
    await new Promise((resolve) => realSetTimeout(resolve, 300));
    await settle();
    const claims = () => servers.a.requests.filter((request) => request.method === 'PATCH' && request.path.includes(idOf.Foxtrot));
    assert.equal(claims().length, 0);
    // Undo: it is due now, so it is claimed (alerted) as usual.
    undo.click();
    await settle();
    assert.equal(claims().length, 1);
  });

  await t.test('a session reset drops the waiting delete without sending it', async () => {
    press(row('Echo').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    const before = servers.a.requests.length;
    cookie = 'b';
    signIn(servers.b.session);
    await settle();
    assert.equal(toast.hidden, true);
    assert.deepEqual(shown(), ['Ben task']);
    runUndoTimer();
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.equal(servers.a.requests.length, before);
    assert.equal(servers.b.requests.some((request) => request.method === 'DELETE'), false);
    assert.equal(servers.a.rows.some((item) => item.text === 'Echo'), true);
  });

  await t.test('A -> B -> A before the toast runs out: the first delete is never sent', async () => {
    const switchTo = async (name, csrfToken) => {
      cookie = name;
      servers[name].session = { ...servers[name].session, csrfToken };
      signIn(servers[name].session);
      await settle();
    };
    await switchTo('a', 'token-a2');
    press(row('Echo').querySelector('.todo-checkbox'), 'Delete');
    const sent = deletes().length;
    await switchTo('b', 'token-b2');
    await switchTo('a', 'token-a3');
    assert.deepEqual(shown().sort(), ['Echo', 'Foxtrot']);
    runUndoTimer();
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.deepEqual(shown().sort(), ['Echo', 'Foxtrot']);
    assert.equal(deletes().length, sent);
    assert.equal(servers.a.rows.some((item) => item.text === 'Echo'), true);
  });
});
