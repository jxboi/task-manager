// Swipe left to delete in src/app.js, against the fake API: the row leaves the view at once and
// the delete waits behind the Undo toast (sent on its timeout, the next delete, pagehide or a
// hidden page), Undo puts it back in place, vertical gestures and the handle are left alone, the
// mouse and keyboard fallbacks, reduced motion, a failed delete, and a session reset.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApi, settle } from './fake-api.js';
import { Element, installDom } from './dom.js';
import { REVEAL_PX, UNDO_MS } from '../src/swipe.js';

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
    // UNDO_MS, or what is left of it after a pause.
    if (!(ms > UNDO_MS - 1000 && ms <= UNDO_MS)) return realSetTimeout(fn, ms, ...rest);
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
    // The press starts on the list. Later events bubble from a row up to the document; one
    // outside the list (extra.outside) reaches only the document.
    if (type !== 'pointerdown') {
      const bubbled = Object.assign(new Event(type, { cancelable: true }), event);
      Object.defineProperty(bubbled, 'target', { value: target });
      Object.defineProperty(bubbled, 'timeStamp', { value: clock });
      document.dispatchEvent(bubbled);
      if (extra.outside) return bubbled;
    }
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

  // Changed with the iOS-style reveal: this was an 80px slow swipe, which now opens and holds the
  // Delete button (see the reveal tests below). Under half the button (38px) still springs back.
  await t.test('a short slow swipe springs back; the row still opens on a later tap', async () => {
    const charlie = row('Charlie');
    gesture(charlie.querySelector('.todo-open'), [[-12, 0, 16], [-24, 0, 400], [-36, 0, 400]]);
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

  // --- Review fixes ------------------------------------------------------------------------
  const more = ['Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
  const fresh = async () => {
    servers.a.rows = more.map((text, i) => ({ ...base, id: ID(i + 21), text, createdAt: 100 + i }));
    signIn({ ...servers.a.session });
    await settle();
  };
  const idFor = (text) => ID(more.indexOf(text) + 21);
  const deleted = () => servers.a.requests.filter((request) => request.method === 'DELETE')
    .map((request) => more.find((text) => request.path.includes(idFor(text)))).filter(Boolean);
  const keydown = (target, key, extra = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });
    Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
    return event;
  };

  await t.test('a held Delete key deletes one task, not the next ones too', async () => {
    await fresh();
    assert.deepEqual(shown(), more);
    press(row('Golf').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    // Auto-repeat follows focus to the next row.
    for (let i = 0; i < 3; i++) {
      const event = press(document.activeElement, 'Delete', { repeat: true });
      assert.equal(event.defaultPrevented, true);
      await settle();
    }
    assert.deepEqual(shown(), more.slice(1));
    assert.deepEqual(deleted(), []);
    runUndoTimer();
    await settle();
    assert.deepEqual(deleted(), ['Golf']);
  });

  await t.test('a mouse press released outside the list never arms a later delete', async () => {
    layout();
    const hotel = row('Hotel').querySelector('.todo-open');
    const x = WIDTH - 6; // near the right edge
    const y = row('Hotel').rect.top + 30;
    const mouse = { pointerType: 'mouse', pointerId: 1, buttons: 1 };
    pointer(hotel, 'pointerdown', x, y, mouse);
    clock += 16;
    pointer(hotel, 'pointermove', x + 4, y + 2, mouse); // not locked yet
    clock += 16;
    pointer(document, 'pointerup', x + 30, y, { ...mouse, buttons: 0, outside: true });
    // Back over the list with no button held, moving left; then an ordinary click.
    for (const dx of [40, 120, 240]) {
      clock += 30;
      pointer(hotel, 'pointermove', x - dx, y, { ...mouse, buttons: 0 });
    }
    assert.equal(row('Hotel').style.transform ?? '', '');
    pointer(hotel, 'pointerup', x - 240, y, { ...mouse, buttons: 0 });
    hotel.click();
    await settle();
    assert.equal(toast.hidden, true);
    assert.deepEqual(shown(), more.slice(1));
    assert.equal(layer.hidden, false); // the click opened the sheet, as a click does
    byId('reminder-cancel').click();
    await settle();
    // A release whose pointerup was missed, then moves with no button: springs back, no delete.
    pointer(hotel, 'pointerdown', 300, y, mouse);
    for (const dx of [-20, -200]) {
      clock += 16;
      pointer(hotel, 'pointermove', 300 + dx, y, dx === -20 ? mouse : { ...mouse, buttons: 0 });
    }
    await slid();
    await settle();
    assert.deepEqual(shown(), more.slice(1));
    assert.equal(toast.hidden, true);
  });

  await t.test('a touch whose implicit capture moves to the row still swipes', async () => {
    layout();
    const kilo = row('Kilo');
    const body = kilo.querySelector('.todo-open');
    const y = kilo.rect.top + 30;
    pointer(body, 'pointerdown', 300, y);
    clock += 16;
    pointer(body, 'pointermove', 280, y); // locks: the row takes the capture from the body
    pointer(body, 'lostpointercapture', 280, y, { outside: true });
    for (const dx of [-120, -220]) {
      clock += 40;
      pointer(body, 'pointermove', 300 + dx, y);
    }
    assert.equal(kilo.style.transform, 'translateX(-220px)');
    // The row itself losing it (no release seen) springs back.
    pointer(kilo, 'lostpointercapture', 80, y, { outside: true });
    assert.equal(kilo.style.transform, '');
    await slid();
    await settle();
    assert.equal(shown().includes('Kilo'), true);
    assert.equal(toast.hidden, true);
  });

  await t.test('the delete starts at release: an edit arriving mid-slide is not deleted', async () => {
    const india = idFor('India');
    swipeLeft('India');
    // Undo is there at once; the row is still sliding.
    assert.equal(toast.hidden, false);
    assert.match(row('India').className, /is-leaving/);
    // Another device edits it; a refresh lands during the slide.
    servers.a.rows = servers.a.rows.map((item) => (item.id === india ? { ...item, text: 'India (edited)', revision: item.revision + 1 } : item));
    window.dispatchEvent(new Event('focus'));
    await settle();
    await slid();
    await settle();
    assert.equal(shown().includes('India'), false);
    runUndoTimer();
    await settle(10);
    // The delete was made against the revision swiped, so the edited task survives.
    assert.equal(servers.a.rows.some((item) => item.id === india), true);
    assert.equal(shown().includes('India (edited)'), true);
    if (!byId('sync-note').hidden) byId('sync-dismiss').click();
  });

  await t.test('a session re-read (CSRF revalidation) during the slide: nothing is deleted, no toast', async () => {
    const before = deleted().length;
    swipeLeft('Juliet');
    // A new token for the same account: the view is cleared and reloaded before the slide ends.
    servers.a.session = { ...servers.a.session, csrfToken: 'token-a4' };
    signIn(servers.a.session);
    await settle();
    assert.equal(shown().includes('Juliet'), true);
    await slid();
    await settle();
    assert.equal(toast.hidden, true);
    assert.equal(shown().includes('Juliet'), true);
    runUndoTimer();
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.equal(deleted().length, before);
    assert.equal(servers.a.rows.some((item) => item.text === 'Juliet'), true);
  });

  await t.test('a reminder claim returning while its task waits behind Undo is not alerted', async () => {
    const announcer = byId('announcer');
    let open;
    let gate = new Promise((resolve) => { open = resolve; });
    const original = servers.a.fetch;
    servers.a.fetch = async (url, init = {}) => {
      const response = await original(url, init);
      if (init.method === 'PATCH' && JSON.parse(init.body).action === 'markNotified') await gate;
      return response;
    };
    t.after(() => { servers.a.fetch = original; });
    const due = (texts) => {
      servers.a.rows = servers.a.rows.map((item) => (texts.includes(item.text)
        ? { ...item, due: Date.now() - 1000, notified: null, revision: item.revision + 1 } : item));
    };
    due(['Kilo']);
    announcer.textContent = '';
    signIn({ ...servers.a.session });
    await settle();
    // The claim is out; the task is swiped meanwhile.
    press(row('Kilo').querySelector('.todo-checkbox'), 'Delete');
    open();
    await settle(10);
    assert.doesNotMatch(announcer.textContent, /Kilo/);
    // Undo: alerted now, as an unalerted due reminder is.
    undo.click();
    await settle();
    assert.equal(announcer.textContent, 'Reminder due: Kilo');

    // Claimed while waiting, then committed: never alerted, and the delete goes through.
    gate = new Promise((resolve) => { open = resolve; });
    due(['Lima']);
    announcer.textContent = '';
    signIn({ ...servers.a.session });
    await settle();
    press(row('Lima').querySelector('.todo-checkbox'), 'Delete');
    open();
    await settle(10);
    runUndoTimer();
    await settle(10);
    assert.doesNotMatch(announcer.textContent, /Lima/);
    assert.equal(servers.a.rows.some((item) => item.text === 'Lima'), false);
    servers.a.fetch = original;
  });

  await t.test('with the keyboard up, the toast follows the visual viewport, never under the composer', async (t) => {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    window.visualViewport = vv;
    document.documentElement.clientHeight = 844;
    const form = byId('add-form');
    t.after(() => {
      form.hidden = true;
      form.rect = { top: 0, height: 0 };
      delete window.visualViewport;
    });
    press(row('Hotel').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.equal(toast.style.top ?? '', '');
    // The keyboard comes up: the visual viewport ends at 450px.
    vv.height = 450;
    vv.dispatchEvent(new Event('resize'));
    assert.equal(toast.style.top, `${450 - 12 - 56}px`);
    assert.equal(toast.hidden, false);
    // Safari pans the visual viewport.
    vv.offsetTop = 40;
    vv.dispatchEvent(new Event('scroll'));
    assert.equal(toast.style.top, `${490 - 12 - 56}px`);
    // Keyboard gone: back to its usual place.
    vv.offsetTop = 0;
    vv.height = 844;
    vv.dispatchEvent(new Event('resize'));
    assert.equal(toast.style.top, '');
    const deletedBefore = deleted().length;
    // The composer is open and the toast would cover it (landscape with the keyboard up): the
    // toast stacks above the field, and Undo stays available.
    form.hidden = false;
    form.rect = { top: 100, height: 60 };
    vv.height = 150;
    vv.dispatchEvent(new Event('resize'));
    await settle();
    assert.equal(toast.hidden, false);
    assert.equal(toast.style.top, `${100 - 12 - 56}px`);
    assert.equal(deleted().length, deletedBefore);
    // No room above but room below: it goes below the field, Undo stays.
    form.rect = { top: 24, height: 56 };
    vv.height = 160;
    vv.dispatchEvent(new Event('resize'));
    await settle();
    assert.equal(toast.hidden, false);
    assert.equal(toast.style.top, `${80 + 12}px`);
    assert.equal(deleted().length, deletedBefore);
    // A tight fit: 65px below the field holds the 56px toast with a 9px gap (less than 12).
    form.rect = { top: 24, height: 56 };
    vv.height = 145;
    vv.dispatchEvent(new Event('resize'));
    await settle();
    assert.equal(toast.hidden, false);
    assert.equal(toast.style.top, `${80 + 9}px`);
    assert.equal(deleted().length, deletedBefore);
    vv.height = 136;
    vv.dispatchEvent(new Event('resize'));
    assert.equal(toast.hidden, false);
    assert.equal(toast.style.top, '80px');
    // No room anywhere: only then does the delete commit.
    form.rect = { top: 10, height: 60 };
    vv.height = 100;
    vv.dispatchEvent(new Event('resize'));
    await settle();
    assert.equal(toast.hidden, true);
    assert.deepEqual(deleted().slice(-1), ['Hotel']);
  });

  await t.test('Ctrl+Z undoes from the list; the clock stops while the toast is hovered or focused', async () => {
    press(row('India (edited)').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.equal(byId('toast-hint').hidden, false);
    assert.equal(byId('toast-hint').textContent, 'Ctrl+Z to undo');
    // In a text field, Ctrl+Z is the field's own.
    assert.equal(keydown(byId('new-todo'), 'z', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(shown().includes('India (edited)'), false);
    // Focus is on the next row: Ctrl+Z (or Cmd+Z) brings it back.
    const event = keydown(document.activeElement, 'z', { ctrlKey: true });
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.equal(shown().includes('India (edited)'), true);
    assert.equal(toast.hidden, true);
    assert.equal(focusKey(), JSON.stringify(['open', idFor('India')]));

    // Hovered, the toast doesn't run out; it runs again once the pointer leaves.
    swipeLeft('India (edited)');
    await slid();
    assert.equal(byId('toast-hint').hidden, true);
    toast.dispatchEvent(new Event('pointerenter'));
    assert.equal(undoTimers.size, 0);
    runUndoTimer();
    await settle();
    assert.equal(toast.hidden, false);
    toast.dispatchEvent(new Event('pointerleave'));
    assert.equal(undoTimers.size, 1);
    // Focused (Tab to Undo): the same.
    toast.dispatchEvent(new Event('focusin'));
    assert.equal(undoTimers.size, 0);
    toast.dispatchEvent(Object.assign(new Event('focusout'), { relatedTarget: null }));
    runUndoTimer();
    await settle();
    assert.equal(toast.hidden, true);
    assert.equal(servers.a.rows.some((item) => item.id === idFor('India')), false);
  });

  // --- Review fixes 2 ----------------------------------------------------------------------
  await t.test('the slide ending does not steal focus from the composer or rebuild a pressed row', async () => {
    await fresh();
    const form = byId('add-form');
    // Swipe, then tap New task before the slide ends: the field keeps focus.
    swipeLeft('Golf');
    byId('add-toggle').click();
    assert.equal(document.activeElement, byId('new-todo'));
    await slid();
    await settle();
    assert.equal(shown().includes('Golf'), false);
    assert.equal(document.activeElement, byId('new-todo'));
    undo.click();
    await settle();
    form.hidden = true;
    byId('add-toggle').setAttribute('aria-expanded', 'false');
    document.activeElement = document.body;

    // Swipe, then press the next row before the slide ends: that row is still the one pressed.
    swipeLeft('Golf');
    const hotel = row('Hotel');
    const down = Object.assign(new Event('pointerdown'), { pointerId: 9, button: 0, isPrimary: true, clientX: 200, clientY: 300 });
    document.dispatchEvent(down);
    await slid();
    assert.equal(row('Hotel'), hotel);
    // The swiped row stays in place (no layout shift) until the press ends.
    assert.ok(row('Golf'), 'swiped row still in the list while pressed');
    document.dispatchEvent(Object.assign(new Event('pointercancel'), { pointerId: 9 }));
    await settle();
    assert.equal(shown().includes('Golf'), false);
    runUndoTimer();
    await settle(10);
    await fresh();
  });

  await t.test('a held reminder is dropped when the task was deleted elsewhere before Undo', async () => {
    await fresh();
    const announcer = byId('announcer');
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const original = servers.a.fetch;
    servers.a.fetch = async (url, init = {}) => {
      const response = await original(url, init);
      if (init.method === 'PATCH' && JSON.parse(init.body).action === 'markNotified') await gate;
      return response;
    };
    t.after(() => { servers.a.fetch = original; });
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Kilo'
      ? { ...item, due: Date.now() - 1000, notified: null, revision: item.revision + 1 } : item));
    announcer.textContent = '';
    signIn({ ...servers.a.session });
    await settle();
    press(row('Kilo').querySelector('.todo-checkbox'), 'Delete');
    open();
    await settle(10);
    // Another device deletes it; the list refreshes.
    servers.a.rows = servers.a.rows.filter((item) => item.text !== 'Kilo');
    signIn({ ...servers.a.session });
    await settle();
    undo.click();
    await settle();
    assert.doesNotMatch(announcer.textContent, /Kilo/);
    servers.a.fetch = original;
    await fresh();
  });

  await t.test('a held reminder is dropped when the task was rescheduled before Undo', async () => {
    await fresh();
    const announcer = byId('announcer');
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const original = servers.a.fetch;
    servers.a.fetch = async (url, init = {}) => {
      const response = await original(url, init);
      if (init.method === 'PATCH' && JSON.parse(init.body).action === 'markNotified') await gate;
      return response;
    };
    t.after(() => { servers.a.fetch = original; });
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Kilo'
      ? { ...item, due: Date.now() - 1000, notified: null, revision: item.revision + 1 } : item));
    announcer.textContent = '';
    signIn({ ...servers.a.session });
    await settle();
    press(row('Kilo').querySelector('.todo-checkbox'), 'Delete');
    open();
    await settle(10);
    // Another device deletes it; the list refreshes.
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Kilo'
      ? { ...item, due: Date.now() + 86400000, notified: null, revision: item.revision + 1 } : item));
    signIn({ ...servers.a.session });
    await settle();
    undo.click();
    await settle();
    assert.doesNotMatch(announcer.textContent, /Kilo/);
    servers.a.fetch = original;
    await fresh();
  });

  await t.test('slide end after a mouse swipe from a focused checkbox still moves focus on', async () => {
    await fresh();
    const box = row('Golf').querySelector('.todo-checkbox');
    box.focus();
    swipeLeft('Golf');
    await slid();
    await settle();
    assert.equal(shown().includes('Golf'), false);
    assert.ok(document.activeElement?.closest?.('.todo'), 'focus is on a remaining row');
    undo.click();
    await settle();
    runUndoTimer();
    await settle(10);
    await fresh();
  });

  await t.test('a swiped focused checkbox with no click: the press fallback does not drop focus', async () => {
    await fresh();
    const box = row('Golf').querySelector('.todo-checkbox');
    box.focus();
    // A real press: the document sees the pointerdown, so the render waits for the press to end.
    document.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 3, button: 0, isPrimary: true }));
    gesture(box, [[-12, 2, 16], [-220, 6, 120]], { pointerType: 'mouse' });
    await new Promise((resolve) => realSetTimeout(resolve, 450));
    await settle();
    assert.equal(shown().includes('Golf'), false);
    assert.equal(document.activeElement, row('Hotel').querySelector('.todo-checkbox'));
    undo.click();
    await settle();
    runUndoTimer();
    await settle(10);
    await fresh();
  });

  await t.test('a held reminder is dropped when the task was completed elsewhere before Undo', async (t) => {
    await fresh();
    const announcer = byId('announcer');
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const original = servers.a.fetch;
    servers.a.fetch = async (url, init = {}) => {
      const response = await original(url, init);
      if (init.method === 'PATCH' && JSON.parse(init.body).action === 'markNotified') await gate;
      return response;
    };
    t.after(() => { servers.a.fetch = original; });
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Kilo'
      ? { ...item, due: Date.now() - 1000, notified: null, revision: item.revision + 1 } : item));
    announcer.textContent = '';
    signIn({ ...servers.a.session });
    await settle();
    press(row('Kilo').querySelector('.todo-checkbox'), 'Delete');
    open();
    await settle(10);
    // Completed on another device; the due time is unchanged.
    servers.a.rows = servers.a.rows.map((item) => (item.text === 'Kilo'
      ? { ...item, completed: true, revision: item.revision + 1 } : item));
    signIn({ ...servers.a.session });
    await settle();
    undo.click();
    await settle();
    assert.equal(row('Kilo').querySelector('.todo-checkbox').checked, true);
    assert.doesNotMatch(announcer.textContent, /Kilo/);
    servers.a.fetch = original;
    await fresh();
  });

  await t.test('the Ctrl+Z hint is only shown when the shortcut works from the focused element', async () => {
    await fresh();
    const form = byId('add-form');
    const hint = byId('toast-hint');
    // Composer open, a single row left: focus falls back to the text field.
    servers.a.rows = servers.a.rows.slice(0, 1);
    signIn({ ...servers.a.session });
    await settle();
    byId('add-toggle').click();
    press(rows()[0].querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.equal(document.activeElement, byId('new-todo'));
    assert.equal(hint.hidden, true);
    undo.click();
    await settle();
    form.hidden = true;
    byId('add-toggle').setAttribute('aria-expanded', 'false');
    document.activeElement = document.body;
    press(rows()[0].querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.equal(hint.hidden, false);
    undo.click();
    await settle();
  });

  await t.test('page scroll moves the toast away from the composer once per frame until Undo', async () => {
    await fresh();
    const form = byId('add-form');
    form.hidden = false;
    form.rect = { top: 860, height: 60 };
    toast.rect = { top: 696, height: 56 };
    press(row('Hotel').querySelector('.todo-checkbox'), 'Delete');
    assert.equal(toast.style.top, '');

    form.rect = { top: 680, height: 60 };
    frames.length = 0;
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(toast.style.top, '612px');

    undo.click();
    window.dispatchEvent(new Event('scroll'));
    assert.equal(frames.length, 0);
    form.hidden = true;
    form.rect = { top: 0, height: 0 };
    toast.rect = { top: 0, height: 0 };
    await settle();
  });
  // --- iOS-style reveal: a partial swipe holds the Delete button open -----------------------
  const OPEN = `translateX(${-REVEAL_PX}px)`;
  const isOpen = (text) => /\bis-open\b/.test(row(text).className);
  const openRows = () => rows().filter((item) => /\bis-open\b/.test(item.className)).map((item) => item.querySelector('.todo-text').textContent);
  const deleteButton = (text) => row(text).querySelector('.todo-delete');
  const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  // A real press is heard by the document (capture) before the list: what closes an open row.
  const docDown = (target, extra = {}) => {
    const event = Object.assign(new Event('pointerdown', { cancelable: true }), {
      clientX: 0, clientY: 0, pointerId: 3, button: 0, isPrimary: true, pointerType: 'touch', ...extra,
    });
    Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
  };
  const drag = (target, steps, extra = {}) => {
    docDown(target, extra);
    gesture(target, steps, extra);
  };
  // A slow partial swipe: 100px, past half the button, well under 65% of the row.
  const reveal = (text, extra) => drag(row(text).querySelector('.todo-open'), [[-12, 0, 16], [-60, 0, 300], [-100, 0, 300]], extra);
  const tap = (target, extra) => {
    drag(target, [[0, 0, 40]], extra);
    target.click();
  };
  // Releases the press (no click reaches the fake document) and lets held renders run.
  const released = async () => { await wait(450); await settle(); };
  // Deletes sent since `fresh()`: earlier subtests' deletes are not this one's.
  let sentBefore = 0;
  const sent = () => deleted().slice(sentBefore);
  const freshReveal = async () => { await fresh(); sentBefore = deleted().length; };

  await t.test('a partial swipe reveals Delete and holds it; under half the button springs closed', async () => {
    await freshReveal();
    const golf = row('Golf');
    reveal('Golf');
    golf.querySelector('.todo-open').click(); // the swipe's own click
    assert.equal(layer.hidden, true);
    assert.match(golf.className, /is-open/);
    assert.equal(golf.style.transform, OPEN);
    assert.equal(toast.hidden, true);
    await released();
    assert.equal(row('Golf'), golf, 'held open, not re-rendered away');
    assert.equal(golf.style.transform, OPEN);
    assert.deepEqual(sent(), []);
    // The button: a real button named for its task, its visible "Delete" part of that name.
    const button = deleteButton('Golf');
    assert.equal(button.tagName, 'button');
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), 'Delete Golf');
    assert.equal(button.querySelector('.todo-delete-label').textContent, 'Delete');
    assert.match(button.getAttribute('aria-label'), /^Delete\b/);
    assert.equal(button.dataset.focusKey, JSON.stringify(['delete', idFor('Golf')]));
    // Under half the button: springs back closed (and pressing Hotel closed Golf).
    drag(row('Hotel').querySelector('.todo-open'), [[-12, 0, 16], [-30, 0, 400]]);
    assert.equal(row('Hotel').style.transform, '');
    assert.equal(isOpen('Hotel'), false);
    assert.deepEqual(openRows(), []);
    await released();
  });

  await t.test('the Delete button deletes through the waiting delete, with the toast; Undo restores', async () => {
    await freshReveal();
    reveal('Golf');
    await released();
    const golf = row('Golf');
    const button = deleteButton('Golf');
    docDown(button);
    pointer(button, 'pointerdown', 380, 230);
    pointer(button, 'pointerup', 380, 230);
    button.click();
    assert.match(golf.className, /is-leaving/);
    assert.doesNotMatch(golf.className, /is-open/);
    assert.equal(golf.style.transform, 'translateX(-100%)');
    assert.equal(toast.hidden, false);
    assert.equal(toastText.textContent, 'Task deleted');
    assert.equal(byId('toast-hint').hidden, true); // a pointer delete: no Ctrl+Z hint
    await slid();
    await released();
    assert.deepEqual(shown(), more.slice(1));
    assert.deepEqual(sent(), []);
    assert.equal(focusKey(), JSON.stringify(['checkbox', idFor('Hotel')]));
    undo.click();
    await settle();
    assert.deepEqual(shown(), more);
    assert.deepEqual(openRows(), [], 'it comes back closed');
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), []);
    // And when the toast runs out instead, the delete is sent.
    reveal('Golf');
    await released();
    deleteButton('Golf').click();
    await slid();
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), ['Golf']);
    await freshReveal();
  });

  await t.test('a tap elsewhere, a scroll, Escape or a swipe back right closes it', async () => {
    await freshReveal();
    // A tap outside the list.
    reveal('Golf');
    await released();
    docDown(byId('add-toggle'));
    assert.equal(isOpen('Golf'), false);
    assert.equal(row('Golf').style.transform, '');
    await released();
    // A tap on another row only closes: its click doesn't open the sheet.
    reveal('Golf');
    await released();
    tap(row('India').querySelector('.todo-open'));
    assert.equal(isOpen('Golf'), false);
    assert.equal(layer.hidden, true);
    await released();
    // ...nor tick its checkbox.
    reveal('Golf');
    await released();
    const box = row('India').querySelector('.todo-checkbox');
    drag(box, [[0, 0, 40]]);
    const click = new Event('click', { cancelable: true });
    Object.defineProperty(click, 'target', { value: box });
    list.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(isOpen('Golf'), false);
    await released();
    // The page scrolls.
    reveal('Golf');
    await released();
    window.scrollY = 2; // jitter: stays open
    window.dispatchEvent(new Event('scroll'));
    assert.equal(isOpen('Golf'), true);
    window.scrollY = 60;
    window.dispatchEvent(new Event('scroll'));
    assert.equal(isOpen('Golf'), false);
    window.scrollY = 0;
    // Escape, with focus on the open row's button: closed, focus back on the row.
    reveal('Golf');
    await released();
    deleteButton('Golf').focus();
    const escape = keydown(deleteButton('Golf'), 'Escape');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(isOpen('Golf'), false);
    assert.equal(document.activeElement, row('Golf').querySelector('.todo-open'));
    // Escape with focus elsewhere closes it too, and leaves focus alone.
    reveal('Golf');
    await released();
    byId('add-toggle').focus();
    assert.equal(keydown(byId('add-toggle'), 'Escape').defaultPrevented, false);
    assert.equal(isOpen('Golf'), false);
    assert.equal(document.activeElement, byId('add-toggle'));
    // Swiping the card back right.
    reveal('Golf');
    await released();
    drag(row('Golf').querySelector('.todo-open'), [[12, 0, 16], [50, 0, 300], [70, 0, 300]]);
    assert.equal(isOpen('Golf'), false);
    assert.equal(row('Golf').style.transform, '');
    // A small move right (still past half the button) stays open.
    reveal('Golf');
    await released();
    drag(row('Golf').querySelector('.todo-open'), [[12, 0, 300], [20, 0, 300]]);
    assert.equal(isOpen('Golf'), true);
    assert.equal(row('Golf').style.transform, OPEN);
    await released();
    // Focus moving out of the open row (Tab past its button) closes it.
    const focusIn = new Event('focusin');
    Object.defineProperty(focusIn, 'target', { value: row('Hotel').querySelector('.todo-checkbox') });
    document.dispatchEvent(focusIn);
    assert.equal(isOpen('Golf'), false);
    assert.deepEqual(sent(), []);
    assert.equal(toast.hidden, true);
  });

  await t.test('one row open at a time: opening another closes the first', async () => {
    await freshReveal();
    reveal('Golf');
    await released();
    reveal('India');
    assert.deepEqual(openRows(), ['India']);
    assert.equal(row('Golf').style.transform, '');
    assert.equal(row('India').style.transform, OPEN);
    await released();
    // ArrowLeft on another row opens that one instead.
    press(row('Kilo').querySelector('.todo-checkbox'), 'ArrowLeft');
    assert.deepEqual(openRows(), ['Kilo']);
    assert.equal(row('India').style.transform, '');
  });

  await t.test('a tap on the open card closes it and does not open the edit sheet', async () => {
    await freshReveal();
    reveal('Golf');
    await released();
    const body = row('Golf').querySelector('.todo-open');
    tap(body);
    assert.equal(isOpen('Golf'), false);
    assert.equal(row('Golf').style.transform, '');
    assert.equal(layer.hidden, true);
    await released();
    // The next tap opens the sheet as usual. Opening the sheet closes an open row.
    reveal('Hotel');
    await released();
    row('Golf').querySelector('.todo-open').click(); // e.g. Enter on a focused row: no press
    assert.equal(layer.hidden, false);
    assert.deepEqual(openRows(), []);
    byId('reminder-cancel').click();
    await settle();
  });

  await t.test('a full slow swipe still deletes at once; so does a long one from open', async () => {
    await freshReveal();
    const golf = row('Golf');
    drag(golf.querySelector('.todo-open'), [[-12, 0, 16], [-120, 0, 400], [-260, 0, 600]]); // 260 > 65% of 390
    assert.match(golf.className, /is-leaving/);
    assert.equal(toast.hidden, false);
    // Past the open position, the button stayed at the list's edge while the card went on.
    await slid();
    await released();
    assert.deepEqual(shown(), more.slice(1));
    undo.click();
    await settle();
    // From open, a further 190px left (76 + 190 = 266): deletes.
    reveal('Hotel');
    await released();
    const hotel = row('Hotel');
    drag(hotel.querySelector('.todo-open'), [[-12, 0, 16], [-100, 0, 400], [-190, 0, 600]]);
    assert.match(hotel.className, /is-leaving/);
    assert.equal(toast.hidden, false);
    await slid();
    await released();
    assert.equal(shown().includes('Hotel'), false);
    undo.click();
    await settle();
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), []);
  });

  await t.test('past the open position the Delete button stays at the edge as the card goes on', async () => {
    await freshReveal();
    const golf = row('Golf');
    const body = golf.querySelector('.todo-open');
    layout();
    docDown(body);
    pointer(body, 'pointerdown', 300, golf.rect.top + 30);
    clock += 300;
    pointer(body, 'pointermove', 250, golf.rect.top + 30);
    assert.equal(deleteButton('Golf').style.transform, 'translateX(0px)');
    clock += 300;
    pointer(body, 'pointermove', 150, golf.rect.top + 30);
    assert.equal(golf.style.transform, 'translateX(-150px)');
    assert.equal(deleteButton('Golf').style.transform, `translateX(${150 - REVEAL_PX}px)`);
    clock += 300;
    pointer(body, 'pointermove', 220, golf.rect.top + 30); // back to 80px: open
    clock += 300;
    pointer(body, 'pointerup', 220, golf.rect.top + 30);
    assert.equal(golf.style.transform, OPEN);
    assert.equal(deleteButton('Golf').style.transform, '');
    await released();
  });

  await t.test('the reorder handle still works with a row open, and closes it', async () => {
    await freshReveal();
    reveal('Golf');
    await released();
    layout();
    const handle = row('Hotel').querySelector('.todo-handle');
    const handleEvent = (type, clientX, clientY) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { clientX, clientY, pointerId: 9, button: 0, isPrimary: true });
      Object.defineProperty(event, 'target', { value: handle });
      if (type === 'pointerdown') document.dispatchEvent(event);
      (type === 'pointerdown' ? list : handle).dispatchEvent(event);
    };
    const y = row('Hotel').rect.top + 30;
    handleEvent('pointerdown', 360, y);
    assert.equal(isOpen('Golf'), false, 'the drag closes the open row');
    handleEvent('pointermove', 360, y + ROW * 1.6);
    handleEvent('pointerup', 360, y + ROW * 1.6);
    pointer(handle, 'pointerup', 360, y + ROW * 1.6, { pointerId: 9 });
    await released();
    assert.deepEqual(shown().slice(0, 3), ['Golf', 'India', 'Hotel']);
    assert.deepEqual(sent(), []);
    assert.equal(toast.hidden, true);
    // The open row's own handle closes it too, and never starts a swipe.
    reveal('Golf');
    await released();
    const own = row('Golf').querySelector('.todo-handle');
    docDown(own);
    assert.equal(isOpen('Golf'), false);
    gesture(own, [[-20, 0, 16], [-200, 0, 100]]);
    // The handle's press is the reorder drag's (translateY), never a sideways swipe.
    assert.doesNotMatch(row('Golf').style.transform ?? '', /translateX/);
    assert.doesNotMatch(row('Golf').className, /is-swiping|is-leaving/);
    const up = Object.assign(new Event('pointerup', { cancelable: true }), { pointerId: 3, clientX: 100, clientY: 0 });
    Object.defineProperty(up, 'target', { value: own });
    own.dispatchEvent(up);
    assert.equal(toast.hidden, true);
    await released();
    // Keyboard reorder closes it as well.
    reveal('India');
    await released();
    press(row('Golf').querySelector('.todo-handle'), 'ArrowDown');
    await settle();
    assert.deepEqual(openRows(), []);
    await freshReveal();
  });

  await t.test('a vertical gesture still scrolls: nothing opens or deletes, an open row closes', async () => {
    await freshReveal();
    reveal('Golf');
    await released();
    drag(row('Hotel').querySelector('.todo-open'), [[-4, 14, 16], [-30, 120, 60]], { end: 'pointercancel' });
    assert.deepEqual(openRows(), []);
    assert.equal(row('Hotel').style.transform ?? '', '');
    // A vertical gesture that starts on the open card closes it.
    reveal('Golf');
    await released();
    drag(row('Golf').querySelector('.todo-open'), [[2, 14, 16], [4, 120, 60]], { end: 'pointercancel' });
    assert.deepEqual(openRows(), []);
    await released();
    assert.deepEqual(shown(), more);
    assert.equal(toast.hidden, true);
  });

  await t.test('mouse drag: the same reveal, hold and full-drag delete', async () => {
    await freshReveal();
    const mouse = { pointerType: 'mouse', pointerId: 1, buttons: 1 };
    reveal('Golf', mouse);
    assert.equal(isOpen('Golf'), true);
    row('Golf').querySelector('.todo-open').click();
    assert.equal(layer.hidden, true);
    await released();
    deleteButton('Golf').click();
    assert.equal(toast.hidden, false);
    await slid();
    await released();
    assert.deepEqual(shown(), more.slice(1));
    undo.click();
    await settle();
    drag(row('Hotel').querySelector('.todo-open'), [[-12, 0, 16], [-150, 0, 500], [-280, 0, 500]], mouse);
    assert.equal(toast.hidden, false);
    await slid();
    await released();
    assert.equal(shown().includes('Hotel'), false);
    undo.click();
    await settle();
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), []);
  });

  await t.test('keyboard: ArrowLeft opens on the Delete button; Escape returns to the row; Enter deletes', async () => {
    await freshReveal();
    const golf = row('Golf');
    const body = golf.querySelector('.todo-open');
    body.focus();
    const left = press(body, 'ArrowLeft');
    assert.equal(left.defaultPrevented, true);
    assert.equal(isOpen('Golf'), true);
    assert.equal(golf.style.transform, OPEN);
    assert.equal(document.activeElement, deleteButton('Golf'));
    // A re-render while open keeps it open, with focus on the rebuilt button.
    const before = deleteButton('Golf');
    signIn({ ...servers.a.session }); // same session re-read: reloads and re-renders the list
    await settle();
    assert.notEqual(deleteButton('Golf'), before, 'the row was rebuilt');
    assert.equal(isOpen('Golf'), true);
    assert.equal(row('Golf').style.transform, OPEN);
    assert.equal(document.activeElement, deleteButton('Golf'));
    // Escape closes it and focus goes back to the row.
    keydown(document.activeElement, 'Escape');
    assert.equal(isOpen('Golf'), false);
    assert.equal(document.activeElement, row('Golf').querySelector('.todo-open'));
    // ArrowRight on the button closes it too.
    press(row('Golf').querySelector('.todo-checkbox'), 'ArrowLeft');
    assert.equal(document.activeElement, deleteButton('Golf'));
    press(deleteButton('Golf'), 'ArrowRight');
    assert.equal(isOpen('Golf'), false);
    assert.equal(document.activeElement, row('Golf').querySelector('.todo-open'));
    // With a modifier, ArrowLeft does nothing; on the handle it does nothing.
    press(row('Golf').querySelector('.todo-open'), 'ArrowLeft', { altKey: true });
    press(row('Golf').querySelector('.todo-handle'), 'ArrowLeft');
    assert.deepEqual(openRows(), []);
    // Enter (a click with no pointer: detail 0) deletes, with the keyboard hint.
    press(row('Golf').querySelector('.todo-open'), 'ArrowLeft');
    const enter = new Event('click');
    Object.assign(enter, { detail: 0 });
    Object.defineProperty(enter, 'target', { value: deleteButton('Golf') });
    for (let element = deleteButton('Golf'); element; element = element.parent) element.dispatchEvent(enter);
    assert.equal(toast.hidden, false);
    assert.equal(byId('toast-hint').hidden, false);
    await slid();
    await settle();
    assert.equal(shown().includes('Golf'), false);
    assert.equal(focusKey(), JSON.stringify(['checkbox', idFor('Hotel')]));
    undo.click();
    await settle();
    // Delete on the focused Delete button deletes too; the row's Delete key still does.
    press(row('Golf').querySelector('.todo-open'), 'ArrowLeft');
    press(deleteButton('Golf'), 'Delete');
    await settle();
    assert.equal(shown().includes('Golf'), false);
    undo.click();
    await settle();
    press(row('Hotel').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.equal(shown().includes('Hotel'), false);
    undo.click();
    await settle();
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), []);
  });

  await t.test('a new delete, a re-render without the row, or a session reset closes it', async () => {
    await freshReveal();
    // Another row deleted from the keyboard.
    reveal('Golf');
    await released();
    press(row('India').querySelector('.todo-checkbox'), 'Delete');
    await settle();
    assert.deepEqual(openRows(), []);
    undo.click();
    await settle();
    // The open task deleted on another device: the refresh drops it; it is not open when back.
    reveal('Golf');
    await released();
    const golf = servers.a.rows.find((item) => item.text === 'Golf');
    servers.a.rows = servers.a.rows.filter((item) => item !== golf);
    signIn({ ...servers.a.session }); // same session re-read: reloads and re-renders the list
    await released();
    assert.equal(shown().includes('Golf'), false);
    servers.a.rows = [golf, ...servers.a.rows];
    signIn({ ...servers.a.session }); // same session re-read: reloads and re-renders the list
    await released();
    assert.equal(shown().includes('Golf'), true);
    assert.deepEqual(openRows(), []);
    // A session reset (same account re-read): nothing stays open.
    reveal('Hotel');
    await released();
    servers.a.session = { ...servers.a.session, csrfToken: 'token-a5' };
    signIn(servers.a.session);
    await settle();
    assert.deepEqual(openRows(), []);
    assert.equal(row('Hotel').style.transform ?? '', '');
    // Account switch while open: B's list has nothing open, and nothing was deleted.
    reveal('Hotel');
    await released();
    cookie = 'b';
    signIn(servers.b.session);
    await settle();
    assert.deepEqual(openRows(), []);
    cookie = 'a';
    signIn(servers.a.session);
    await settle();
    assert.deepEqual(openRows(), []);
    assert.deepEqual(sent(), []);
  });

  await t.test('reduced motion: the reveal and the Delete button act at once, with no slide', async () => {
    await freshReveal();
    matchMedia('(prefers-reduced-motion: reduce)').matches = true;
    reveal('Golf');
    assert.equal(row('Golf').style.transform, OPEN);
    await released();
    const golf = row('Golf');
    deleteButton('Golf').click();
    assert.doesNotMatch(golf.className, /is-leaving/);
    await settle();
    assert.equal(shown().includes('Golf'), false);
    assert.equal(toast.hidden, false);
    undo.click();
    await settle();
    matchMedia('(prefers-reduced-motion: reduce)').matches = false;
    runUndoTimer();
    await settle(10);
    assert.deepEqual(sent(), []);
  });
});
