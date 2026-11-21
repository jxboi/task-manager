// The task sheet following the visual viewport (src/viewport.js): the CSS variables mirrored from
// a fake visualViewport, the fallback without one, listener cleanup, and a focused field scrolled
// into view inside the sheet body (not the page) at once, on the keyboard's resize and after it
// settles. Then the same wiring in src/app.js: opening the sheet starts it, closing stops it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REVEAL_MARGIN, REVEAL_WINDOW_MS, SETTLE_MS, createSheetViewport, nearestDelta, revealIn, viewportBox,
} from '../src/viewport.js';
import { createFakeApi, settle } from './fake-api.js';
import { installDom } from './dom.js';

// A visualViewport whose listeners can be counted.
function fakeViewport({ height = 844, offsetTop = 0 } = {}) {
  const vv = new EventTarget();
  vv.height = height;
  vv.offsetTop = offsetTop;
  vv.listeners = new Map();
  const add = vv.addEventListener.bind(vv);
  const remove = vv.removeEventListener.bind(vv);
  vv.addEventListener = (type, fn) => {
    vv.listeners.set(type, (vv.listeners.get(type) ?? 0) + 1);
    add(type, fn);
  };
  vv.removeEventListener = (type, fn) => {
    vv.listeners.set(type, (vv.listeners.get(type) ?? 0) - 1);
    remove(type, fn);
  };
  // The keyboard: a smaller visual viewport, maybe scrolled within the layout viewport.
  vv.set = (next) => {
    Object.assign(vv, next);
    vv.dispatchEvent(new Event('resize'));
  };
  return vv;
}

function fakeStyle() {
  const props = new Map();
  return {
    props,
    setProperty: (name, value) => props.set(name, value),
    removeProperty: (name) => props.delete(name),
  };
}

// A sheet: the layer (fixed, following the viewport), the body (the scroller, at `bodyTop` with
// `bodyHeight`) and fields at fixed offsets inside the body's content.
function fakeSheet({ bodyTop = 400, bodyHeight = 444, fields = { text: 40 } } = {}) {
  const layer = Object.assign(new EventTarget(), { style: fakeStyle() });
  const body = { scrollTop: 0, top: bodyTop, height: bodyHeight };
  body.getBoundingClientRect = () => ({ top: body.top, height: body.height });
  const elements = Object.fromEntries(Object.entries(fields).map(([name, offset]) => [name, {
    tagName: name === 'button' ? 'BUTTON' : 'INPUT',
    getBoundingClientRect: () => ({ top: body.top + offset - body.scrollTop, height: 44 }),
  }]));
  body.contains = (element) => Object.values(elements).includes(element);
  return { layer, body, elements };
}

function fakeTimers() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      timers.set(nextId, { fn, at: time + ms });
      return nextId++;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function focusIn(layer, doc, element) {
  doc.activeElement = element;
  const event = new Event('focusin');
  Object.defineProperty(event, 'target', { value: element });
  layer.dispatchEvent(event);
}

function setup({ vv = fakeViewport(), sheet = {} } = {}) {
  const win = { visualViewport: vv };
  const doc = { activeElement: null };
  const timers = fakeTimers();
  const parts = fakeSheet(sheet);
  const sync = createSheetViewport({ win, doc, layer: parts.layer, body: parts.body, ...timers });
  return { win, doc, timers, vv, sync, ...parts };
}

// The field's box relative to the visible part of the viewport.
const inside = (box, top, height) => box.top >= top && box.top + box.height <= top + height;

test('viewportBox reads the visual viewport, or null without one', () => {
  assert.equal(viewportBox({}), null);
  assert.equal(viewportBox(undefined), null);
  assert.equal(viewportBox({ visualViewport: { height: 0, offsetTop: 0 } }), null);
  assert.deepEqual(viewportBox({ visualViewport: { height: 500, offsetTop: 120 } }), { top: 120, height: 500 });
  // iOS overscroll can report a negative offset for a moment: the layer never goes above the top.
  assert.deepEqual(viewportBox({ visualViewport: { height: 500, offsetTop: -8 } }), { top: 0, height: 500 });
});

test('nearestDelta: no scroll when it fits, the least scroll otherwise, top first when too tall', () => {
  const view = { top: 100, height: 300 }; // visible 100..400, with the margin 112..388
  assert.equal(nearestDelta({ top: 200, height: 44 }, view), 0);
  assert.equal(nearestDelta({ top: 380, height: 44 }, view), 380 + 44 - (400 - REVEAL_MARGIN));
  assert.equal(nearestDelta({ top: 50, height: 44 }, view), 50 - (100 + REVEAL_MARGIN));
  assert.equal(nearestDelta({ top: 300, height: 1000 }, view), 300 - (100 + REVEAL_MARGIN));
  assert.equal(nearestDelta({ top: 300, height: 44 }, { top: 0, height: 10 }), 0, 'no room: no scroll');
});

test('start mirrors the visual viewport into --vv-top / --vvh and follows resize and scroll', () => {
  const { sync, vv, layer } = setup({ vv: fakeViewport({ height: 844 }) });
  assert.equal(layer.style.props.size, 0, 'nothing set before the sheet opens');
  sync.start();
  assert.equal(sync.active, true);
  assert.deepEqual(Object.fromEntries(layer.style.props), { '--vv-top': '0px', '--vvh': '844px' });
  vv.set({ height: 451, offsetTop: 0 }); // the keyboard comes up
  assert.equal(layer.style.props.get('--vvh'), '451px');
  vv.offsetTop = 87; // Safari pans the visual viewport
  vv.dispatchEvent(new Event('scroll'));
  assert.equal(layer.style.props.get('--vv-top'), '87px');
  assert.equal(layer.style.props.get('--vvh'), '451px');
  vv.set({ height: 844, offsetTop: 0 }); // the keyboard goes
  assert.deepEqual(Object.fromEntries(layer.style.props), { '--vv-top': '0px', '--vvh': '844px' });
});

test('stop removes every listener and the variables; a second start/stop is harmless', () => {
  const { sync, vv, layer, doc, elements, body } = setup();
  sync.start();
  sync.start();
  assert.equal(vv.listeners.get('resize'), 1);
  assert.equal(vv.listeners.get('scroll'), 1);
  sync.stop();
  sync.stop();
  assert.equal(sync.active, false);
  assert.equal(vv.listeners.get('resize'), 0);
  assert.equal(vv.listeners.get('scroll'), 0);
  assert.equal(layer.style.props.size, 0, 'the CSS falls back to the full viewport');
  vv.set({ height: 400 });
  assert.equal(layer.style.props.size, 0, 'a closed sheet no longer follows the viewport');
  body.top = 800; // the field would be off screen
  focusIn(layer, doc, elements.text);
  assert.equal(body.scrollTop, 0, 'the focusin listener is gone too');
});

test('without visualViewport: no variables, no errors, and focus still reveals within the body', () => {
  const doc = { activeElement: null };
  const timers = fakeTimers();
  const { layer, body, elements } = fakeSheet({ bodyTop: 100, bodyHeight: 200, fields: { text: 400 } });
  const sync = createSheetViewport({ win: {}, doc, layer, body, ...timers });
  sync.start();
  assert.equal(layer.style.props.size, 0);
  focusIn(layer, doc, elements.text);
  assert.ok(inside(elements.text.getBoundingClientRect(), 100, 200));
  sync.stop();
  assert.equal(timers.pending(), 0);
});

test('a focused field below the keyboard is scrolled into view inside the body, never the page', () => {
  // Keyboard already up: the visual viewport is 0..451, but the sheet body runs to 844 (the
  // layer has not caught up yet); the field at 600 is behind the keyboard.
  const { sync, layer, doc, elements, body, win } = setup({
    vv: fakeViewport({ height: 451 }),
    sheet: { bodyTop: 300, bodyHeight: 544, fields: { text: 300 } },
  });
  let pageScrolled = false;
  win.scrollTo = () => { pageScrolled = true; };
  elements.text.scrollIntoView = () => { pageScrolled = true; };
  sync.start();
  focusIn(layer, doc, elements.text);
  const box = elements.text.getBoundingClientRect();
  assert.ok(inside(box, 0, 451), `field at ${box.top} is above the keyboard`);
  assert.equal(box.top + box.height, 451 - REVEAL_MARGIN, "block: 'nearest': just enough");
  assert.equal(pageScrolled, false);
});

test('a field that is already visible does not move', () => {
  const { sync, layer, doc, elements, body } = setup({ sheet: { bodyTop: 300, bodyHeight: 544, fields: { text: 40 } } });
  sync.start();
  focusIn(layer, doc, elements.text);
  assert.equal(body.scrollTop, 0);
});

test('focus before the keyboard: revealed again on the next viewport resize', () => {
  // The autofocus path: openEditor focuses the Task input, then the keyboard animates in.
  const { sync, vv, layer, doc, elements, body } = setup({
    sheet: { bodyTop: 200, bodyHeight: 644, fields: { text: 450 } },
  });
  sync.start();
  focusIn(layer, doc, elements.text); // 650..694: visible with the keyboard closed
  assert.equal(body.scrollTop, 0);
  // The keyboard shrinks the visual viewport; this fake layer doesn't move (as with a sheet that
  // hasn't re-laid out yet), so the field must be scrolled up within the body.
  vv.set({ height: 420 });
  assert.equal(layer.style.props.get('--vvh'), '420px');
  assert.ok(inside(elements.text.getBoundingClientRect(), 0, 420));
});

test('focus without a resize (keyboard already up): revealed again once it settles', () => {
  const { sync, layer, doc, elements, body, timers } = setup({
    sheet: { bodyTop: 100, bodyHeight: 744, fields: { text: 100 } },
  });
  sync.start();
  focusIn(layer, doc, elements.text);
  assert.equal(body.scrollTop, 0);
  body.top = 600; // the sheet's layout changed under the field (its open animation, say)
  timers.advance(SETTLE_MS - 1);
  assert.equal(body.scrollTop, 0);
  timers.advance(1);
  assert.ok(inside(elements.text.getBoundingClientRect(), 0, 844));
  assert.equal(timers.pending(), 0);
});

test('only the field that still has focus is revealed, and only for a short while', () => {
  const { sync, vv, layer, doc, elements, body, timers } = setup({
    sheet: { bodyTop: 300, bodyHeight: 544, fields: { text: 40, other: 120 } },
  });
  sync.start();
  focusIn(layer, doc, elements.text);
  doc.activeElement = null; // blurred (the keyboard's Done)
  vv.set({ height: 300 });
  assert.equal(body.scrollTop, 0, 'a blurred field is not chased');
  focusIn(layer, doc, elements.other); // revealed above the 300px viewport
  // The user scrolls the body away from the field; Safari then pans the visual viewport (offset
  // only, or a taller viewport), within the reveal window and after it: the user is not pulled back.
  body.scrollTop = 30;
  vv.offsetTop = 40;
  vv.dispatchEvent(new Event('scroll'));
  timers.advance(REVEAL_WINDOW_MS + 1);
  vv.offsetTop = 0;
  vv.dispatchEvent(new Event('scroll'));
  vv.set({ height: 400, offsetTop: 10 });
  assert.equal(body.scrollTop, 30);
});

test('keyboard reopened for the field that kept focus: revealed on the shrink, without a focusin', () => {
  const { sync, vv, layer, doc, elements, body, timers } = setup({
    sheet: { bodyTop: 200, bodyHeight: 644, fields: { text: 450 } },
  });
  sync.start();
  focusIn(layer, doc, elements.text);
  vv.set({ height: 420 });
  assert.ok(inside(elements.text.getBoundingClientRect(), 0, 420));
  timers.advance(REVEAL_WINDOW_MS + 1);
  vv.set({ height: 844 }); // keyboard dismissed; the input keeps focus
  body.scrollTop = 0; // the user scrolls back up: the field is behind where the keyboard was
  vv.offsetTop = 30; // an offset-only change does not chase it
  vv.dispatchEvent(new Event('scroll'));
  assert.equal(body.scrollTop, 0);
  vv.set({ height: 420, offsetTop: 0 }); // tap the same field: the keyboard is back, no focusin
  const box = elements.text.getBoundingClientRect();
  assert.ok(inside(box, 0, 420), `field at ${box.top} is above the reopened keyboard`);
  // A shrink with no field focused inside the body moves nothing.
  vv.set({ height: 844 });
  body.scrollTop = 0;
  doc.activeElement = { tagName: 'INPUT' }; // a field outside the sheet
  vv.set({ height: 420 });
  assert.equal(body.scrollTop, 0);
});

test('a very short visual viewport (landscape keyboard) still shows the whole focused input', () => {
  // The margin shrinks when the field barely fits: 52px of room for a 48px field.
  const delta = nearestDelta({ top: 300, height: 48 }, { top: 100, height: 52 });
  assert.ok(inside({ top: 300 - delta, height: 48 }, 100, 52), `delta ${delta}`);
  assert.equal(nearestDelta({ top: 102, height: 48 }, { top: 100, height: 52 }), 0, 'already whole: no scroll');
  // A 144px visual viewport with a 52px-high body visible under the header; fields are 44px.
  const { sync, vv, layer, doc, elements } = setup({
    vv: fakeViewport({ height: 844 }),
    sheet: { bodyTop: 92, bodyHeight: 752, fields: { text: 200 } },
  });
  sync.start();
  focusIn(layer, doc, elements.text);
  vv.set({ height: 144 });
  const box = elements.text.getBoundingClientRect();
  assert.ok(inside(box, 92, 52), `field ${box.top}..${box.top + box.height} inside 92..144`);
});

test('buttons are not revealed; fields outside the body are left alone', () => {
  const { sync, layer, doc, elements, body } = setup({
    vv: fakeViewport({ height: 300 }),
    sheet: { bodyTop: 300, bodyHeight: 544, fields: { button: 300 } },
  });
  sync.start();
  focusIn(layer, doc, elements.button);
  assert.equal(body.scrollTop, 0);
  assert.equal(revealIn(body, { tagName: 'INPUT', getBoundingClientRect: () => ({ top: 900, height: 44 }) }, {}), 0);
  assert.equal(body.scrollTop, 0);
});

// --- src/app.js: the sheet starts following the viewport when it opens and stops when it closes --

test('the task sheet follows the visual viewport only while open', async (t) => {
  const server = createFakeApi();
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const vv = fakeViewport({ height: 844 });
  globalThis.visualViewport = vv;
  t.after(() => delete globalThis.visualViewport);
  const layer = byId('reminder-layer');
  layer.style = fakeStyle();
  const id = '00000000-0000-4000-8000-0000000000b1';
  server.rows = [{
    id, text: 'Pay rent', tags: [], createdAt: 1, completed: false, due: null, repeat: 'none', notified: null, revision: 1,
  }];
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();
  const open = () => list.children.find((row) => row.dataset.id === id).querySelector('.todo-open').click();

  assert.equal(vv.listeners.get('resize') ?? 0, 0, 'nothing listens while the sheet is closed');
  open();
  assert.equal(layer.hidden, false);
  assert.equal(document.activeElement, byId('edit-text'), 'the Task input is focused on open');
  assert.equal(vv.listeners.get('resize'), 1);
  assert.equal(vv.listeners.get('scroll'), 1);
  assert.equal(layer.style.props.get('--vvh'), '844px');
  vv.set({ height: 451, offsetTop: 0 });
  assert.equal(layer.style.props.get('--vvh'), '451px');

  byId('reminder-cancel').click();
  assert.equal(layer.hidden, true);
  assert.equal(vv.listeners.get('resize'), 0);
  assert.equal(vv.listeners.get('scroll'), 0);
  assert.equal(layer.style.props.size, 0);

  // Escape and Save close it the same way.
  open();
  const escape = Object.assign(new Event('keydown'), { key: 'Escape', preventDefault() {} });
  byId('reminder-editor').dispatchEvent(escape);
  assert.equal(layer.hidden, true);
  assert.equal(vv.listeners.get('resize'), 0);
  open();
  byId('reminder-save').click();
  assert.equal(layer.hidden, true);
  assert.equal(vv.listeners.get('resize'), 0);
  await settle();
});
