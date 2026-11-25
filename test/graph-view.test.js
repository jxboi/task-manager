// The graph view's controller (src/graph-view.js) with a fake canvas and frame clock: the list
// fallback, tier stepping, render on demand, taps versus drags, hub re-centring, reduced motion
// and teardown. Then the view in src/app.js: the List | Graph switch, the edit sheet, Esc and
// Back, and the session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element, installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';
import { markupAttributes } from './markup.js';
import { context2d, createTierMeter, DPR_CAP, INERTIA, mountGraph, projectFlat, TIER_BUDGET } from '../src/graph-view.js';
import { MIN_SCREEN_RADIUS } from '../src/graph-space.js';

const NOW = Date.UTC(2026, 10, 25, 12);
const categories = [{ id: 'c0', name: 'Work' }, { id: 'c1', name: 'Home' }, { id: 'c2', name: 'Empty' }];
const todos = Array.from({ length: 12 }, (_, i) => ({
  id: `t${i}`, text: `Task ${i}`, completed: i % 3 === 0, createdAt: NOW - i * 86400000, categoryId: i % 2 ? 'c1' : 'c0',
}));
const RECT = { left: 10, top: 20, width: 390, height: 700 };

// Records calls; counts what drawFrame drew.
const fakeContext = () => {
  const ctx = { calls: 0, arcs: [] };
  return new Proxy(ctx, {
    get: (target, name) => (name in target ? target[name] : (...args) => {
      target.calls += 1;
      if (name === 'arc') target.arcs.push(args);
    }),
    set: (target, name, value) => { target[name] = value; return true; },
  });
};

// A document whose canvases come from `canvas()`, a manual frame queue, timers run by hand.
function setup(t, { canvas = () => { const ctx = fakeContext(); return { getContext: () => ctx }; }, reduced = false, dpr = 3 } = {}) {
  const frames = new Map();
  let nextFrame = 1;
  let time = 0;
  const timers = new Map();
  let nextTimer = 1;
  const canvases = [];
  const globals = {
    document: {
      activeElement: null,
      createElement: (tagName) => {
        const element = Object.assign(new Element(), { tagName });
        if (tagName === 'canvas') {
          Object.assign(element, canvas());
          element.getBoundingClientRect = () => RECT;
          canvases.push(element);
        }
        return element;
      },
    },
    requestAnimationFrame: (callback) => { frames.set(nextFrame, callback); return nextFrame++; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => { timers.set(nextTimer, callback); return nextTimer++; },
    clearTimeout: (id) => timers.delete(id),
    devicePixelRatio: dpr,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const root = new Element();
  root.getBoundingClientRect = () => RECT;
  const opened = [];
  let drawMs = 1;
  // The clock advances `drawMs` between the two reads around each draw.
  let reads = 0;
  const clock = () => (reads++ % 2 ? time + drawMs : time);
  const graph = mountGraph(root, { onOpenTask: (id) => opened.push(id), reducedMotion: motion, clock });
  return {
    graph, root, opened, motion, canvases, frames,
    get pending() { return frames.size; },
    get timers() { return timers.size; },
    setDrawMs(ms) { drawMs = ms; },
    // Runs queued frames, one per 16 ms, until none are queued or `limit` ran. Returns the count.
    flush(limit = 1000) {
      let ran = 0;
      while (frames.size && ran < limit) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        time += 16;
        callback(time);
        ran += 1;
      }
      return ran;
    },
    idle() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    buttons: () => root.querySelectorAll('button'),
  };
}

const pointer = (target, type, pointerId, clientX, clientY, timeStamp, pointerType = 'touch', button) => {
  const event = new Event(type, { cancelable: true });
  const props = {
    pointerId: { value: pointerId }, pointerType: { value: pointerType }, clientX: { value: clientX },
    clientY: { value: clientY }, timeStamp: { value: timeStamp },
  };
  if (button !== undefined) props.button = { value: button };
  Object.defineProperties(event, props);
  target.dispatchEvent(event);
};
const drag = (canvas, { from = [100, 100], by = [40, 0], steps = 8, ms = 8, id = 1, type = 'touch', t0 = 1000 } = {}) => {
  pointer(canvas, 'pointerdown', id, from[0], from[1], t0, type);
  for (let s = 1; s <= steps; s += 1) {
    pointer(canvas, 'pointermove', id, from[0] + (by[0] * s) / steps, from[1] + (by[1] * s) / steps, t0 + s * ms, type);
  }
  pointer(canvas, 'pointerup', id, from[0] + by[0], from[1] + by[1], t0 + steps * ms + 2, type);
};
// The page position of a task's node, from the button's data-x/y (canvas px) and the canvas rect.
const nodeAt = (env, todoId) => {
  const button = env.buttons().find((b) => JSON.parse(b.dataset.focusKey)[1] === todoId);
  return [Number(button.dataset.x) + RECT.left, Number(button.dataset.y) + RECT.top];
};

test('context2d: no getContext, a throwing one or a null context mean no canvas', () => {
  assert.equal(context2d(new Element()), null);
  assert.equal(context2d({ getContext: () => { throw new Error('blocked'); } }), null);
  assert.equal(context2d({ getContext: () => null }), null);
  const ctx = {};
  assert.equal(context2d({ getContext: (kind) => (kind === '2d' ? ctx : null) }), ctx);
});

test('without a 2D canvas the graph is the list: buttons grouped by hub that open the task', (t) => {
  const env = setup(t, { canvas: () => ({ getContext: () => null }) });
  env.graph.update({ todos, categories, now: NOW });
  assert.equal(env.root.dataset.mode, 'list');
  assert.equal(env.root.children.length, 1, 'no canvas is mounted');
  assert.equal(env.pending, 0, 'and no frames run');
  const [list] = env.root.children;
  assert.deepEqual(list.children.map((group) => group.children[0].textContent), ['EMPTY', 'HOME', 'WORK']);
  assert.equal(env.buttons().length, todos.length);
  const button = env.buttons().find((b) => b.textContent === 'Task 3');
  assert.equal(button.dataset.focusKey, '["graph-node","t3"]');
  assert.equal(button.getAttribute('aria-label'), 'Task 3, done');
  button.click();
  assert.deepEqual(env.opened, ['t3']);
});

for (const mode of ['list', 'full']) {
  test(`${mode} task buttons update full titles and accessible names without a canvas label change`, (t) => {
    const env = mode === 'list' ? setup(t, { canvas: () => ({}) }) : setup(t);
    const update = (text) => env.graph.update({ todos: [{ ...todos[0], text }], categories, now: NOW });
    update('Review the quarterly report before Monday');
    env.flush();
    const [button] = env.buttons();
    button.focus();
    for (const title of ['review the quarterly report before Monday', 'review the quarterly report before Friday']) {
      update(title);
      assert.equal(env.buttons()[0], button);
      assert.equal(button.textContent, title);
      assert.equal(button.getAttribute('aria-label'), `${title}, done`);
      assert.equal(document.activeElement, button);
      assert.equal(env.pending, 0, 'the canvas label did not change');
    }
  });
}

test('draws only on demand: one frame per change, none at rest, none for an unchanged update', (t) => {
  const env = setup(t);
  assert.equal(env.root.dataset.mode, 'full');
  env.graph.update({ todos, categories, now: NOW });
  assert.equal(env.flush(), 1);
  assert.equal(env.pending, 0);
  env.graph.update({ todos: [...todos].reverse(), categories, now: NOW });
  assert.equal(env.pending, 0, 'same visible graph, no redraw');
  env.graph.update({ todos: todos.slice(1), categories, now: NOW });
  assert.equal(env.flush(), 1);
  const [canvas] = env.canvases;
  assert.equal(canvas.width, 390 * DPR_CAP.full, 'the device pixel ratio is capped');
  assert.equal(canvas.height, 700 * DPR_CAP.full);
  env.idle();
  assert.match(env.root.dataset.frameMs, /^\d+\.\d\d$/);
});

test('a tap on a task opens it; a drag from the same spot orbits instead', (t) => {
  const env = setup(t);
  env.graph.update({ todos, categories, now: NOW });
  env.flush();
  env.idle();
  const [canvas] = env.canvases;
  const [x, y] = nodeAt(env, 't4');
  pointer(canvas, 'pointerdown', 1, x, y, 100);
  pointer(canvas, 'pointerup', 1, x + 2, y + 1, 180);
  assert.deepEqual(env.opened, ['t4']);

  const before = env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' ');
  drag(canvas, { from: [x, y], by: [40, 0] });
  assert.deepEqual(env.opened, ['t4'], 'the drag opened nothing');
  env.flush();
  env.idle();
  assert.notEqual(env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' '), before, 'the scene turned');

  // A tap on empty canvas does nothing.
  pointer(canvas, 'pointerdown', 1, RECT.left + 1, RECT.top + 1, 5000);
  pointer(canvas, 'pointerup', 1, RECT.left + 1, RECT.top + 1, 5050);
  assert.deepEqual(env.opened, ['t4']);

  // Non-primary mouse clicks (right/middle) on a node do not open or drag; primary (0) does.
  const [nx, ny] = nodeAt(env, 't4');
  for (const button of [1, 2]) {
    pointer(canvas, 'pointerdown', 2, nx, ny, 6000, 'mouse', button);
    pointer(canvas, 'pointerup', 2, nx, ny, 6050, 'mouse', button);
  }
  assert.deepEqual(env.opened, ['t4']);
  const beforeRightDrag = env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' ');
  pointer(canvas, 'pointerdown', 3, nx, ny, 6100, 'mouse', 2);
  pointer(canvas, 'pointermove', 3, nx + 50, ny, 6120, 'mouse', -1);
  pointer(canvas, 'pointerup', 3, nx + 50, ny, 6140, 'mouse', 2);
  env.flush();
  env.idle();
  assert.equal(env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' '), beforeRightDrag);
  pointer(canvas, 'pointerdown', 4, nx, ny, 6200, 'mouse', 0);
  pointer(canvas, 'pointerup', 4, nx, ny, 6240, 'mouse', 0);
  assert.deepEqual(env.opened, ['t4', 't4']);
});

test('a flick spins on with inertia, then stops by itself', (t) => {
  const env = setup(t);
  env.graph.update({ todos, categories, now: NOW });
  env.flush();
  drag(env.canvases[0], { by: [120, 0], steps: 6, ms: 10 });
  let frames = 0;
  while (env.pending) {
    frames += env.flush(1);
    // The at-rest work (button positions, frame time) waits until the spin is over.
    if (env.pending) assert.equal(env.timers, 0, `no idle timer during frame ${frames}`);
  }
  assert.ok(frames > 5, `inertia ran ${frames} frames`);
  assert.equal(env.timers, 1, 'at rest, the idle work is queued');

  // A very fast flick is capped: it spins no longer than one at the top speed.
  const cap = Math.ceil((Math.log(INERTIA.maxSpeed / INERTIA.minSpeed) * INERTIA.decayMs) / 16) + 2;
  drag(env.canvases[0], { by: [3000, 0], steps: 3, ms: 2, t0: 50000 });
  const wild = env.flush();
  assert.ok(wild <= cap, `${wild} frames, at most ${cap}`);
});

test('reduced motion: no inertia after a flick, read live from the media query', (t) => {
  const env = setup(t, { reduced: true });
  env.graph.update({ todos, categories, now: NOW });
  env.flush();
  drag(env.canvases[0], { by: [120, 0], steps: 6, ms: 10 });
  assert.equal(env.flush(), 1, 'one frame for the drag, none after the release');

  env.motion.matches = false;
  env.motion.dispatchEvent(new Event('change'));
  drag(env.canvases[0], { by: [120, 0], steps: 6, ms: 10, t0: 9000 });
  assert.ok(env.flush() > 5, 'with motion allowed again, the flick spins');
});

test('a hub tap re-centres on it: eased over frames, or at once under reduced motion', async (t) => {
  // One subtest each: setup's globals are put back when its own test ends.
  for (const reduced of [false, true]) await t.test(reduced ? 'reduced motion' : 'eased', (t) => {
    const env = setup(t, { reduced });
    // Two lone hubs and nothing else, so every circle drawn is a hub.
    env.graph.update({ todos: [], categories: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], now: NOW });
    env.flush();
    const ctx = env.canvases[0].getContext('2d');
    const atCentre = ([x, y]) => Math.abs(x - RECT.width / 2) < 1 && Math.abs(y - RECT.height / 2) < 1;
    assert.equal(ctx.arcs.filter(atCentre).length, 0, 'neither hub starts at the centre');
    const [[hx, hy]] = ctx.arcs.map(([x, y]) => [x, y]).sort((p, q) => p[0] - q[0]); // tap the left one
    pointer(env.canvases[0], 'pointerdown', 1, hx + RECT.left, hy + RECT.top, 100, 'mouse');
    pointer(env.canvases[0], 'pointerup', 1, hx + RECT.left, hy + RECT.top, 150, 'mouse');
    ctx.arcs.length = 0;
    const frames = env.flush();
    assert.equal(env.opened.length, 0);
    if (reduced) assert.equal(frames, 1, 'instant');
    else assert.ok(frames >= 10, `eased over ${frames} frames`);
    // The tapped hub ends at the centre of the canvas: at least one of the last drawn arcs is there.
    const centred = ctx.arcs.filter(atCentre);
    assert.ok(centred.length > 0, `${reduced ? 'reduced' : 'eased'}: the tapped hub is at the centre`);
  });
});

test('pinch and wheel zoom redraw the scene smaller or larger', (t) => {
  const env = setup(t);
  env.graph.update({ todos, categories, now: NOW });
  env.flush();
  const ctx = env.canvases[0].getContext('2d');
  // The biggest circle: zooming in pushes some nodes off the canvas, so a sum would mislead.
  const largest = () => Math.max(...ctx.arcs.map(([, , r]) => r));
  const base = largest();
  const canvas = env.canvases[0];
  pointer(canvas, 'pointerdown', 1, 150, 300, 0);
  pointer(canvas, 'pointerdown', 2, 250, 300, 0);
  pointer(canvas, 'pointermove', 2, 350, 300, 10);
  pointer(canvas, 'pointerup', 2, 350, 300, 20);
  pointer(canvas, 'pointerup', 1, 150, 300, 20);
  ctx.arcs.length = 0;
  env.flush();
  const zoomed = largest();
  assert.ok(zoomed > base * 1.8, 'spreading two fingers zooms in');
  assert.deepEqual(env.opened, []);

  const wheel = Object.assign(new Event('wheel', { cancelable: true }), {});
  Object.defineProperties(wheel, { deltaY: { value: 400 }, deltaMode: { value: 0 }, clientX: { value: 0 }, clientY: { value: 0 } });
  canvas.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true, 'the page does not scroll');
  ctx.arcs.length = 0;
  env.flush();
  assert.ok(largest() < zoomed * 0.6, 'wheel down zooms out');
});

test('tier meter: steps full → lite → static on slow draws, and stays once a tier passes', () => {
  const meter = createTierMeter();
  const { frames, drawMs } = TIER_BUDGET.full;
  for (let i = 0; i < frames - 1; i += 1) assert.equal(meter.draw(drawMs + 1), 'full');
  assert.equal(meter.draw(drawMs + 1), 'lite');
  for (let i = 0; i < TIER_BUDGET.lite.frames; i += 1) meter.draw(TIER_BUDGET.lite.drawMs + 1);
  assert.equal(meter.tier, 'static');
  for (let i = 0; i < 50; i += 1) meter.draw(100);
  assert.equal(meter.tier, 'static', 'static is the last canvas tier');

  const fast = createTierMeter();
  for (let i = 0; i < frames; i += 1) fast.draw(1);
  for (let i = 0; i < 100; i += 1) fast.draw(100);
  assert.equal(fast.tier, 'full', 'only the first frames are measured');

  const median = createTierMeter();
  for (let i = 0; i < frames; i += 1) median.draw(i < frames / 2 - 1 ? 50 : 1); // a few slow ones
  assert.equal(median.tier, 'full', 'the median, not the worst frame');
});

test('tier meter: slow gesture frame intervals step full down to lite', () => {
  const meter = createTierMeter();
  const { intervals, intervalMs } = TIER_BUDGET.full;
  for (let i = 0; i < intervals - 1; i += 1) meter.interval(intervalMs + 5);
  assert.equal(meter.tier, 'full');
  assert.equal(meter.interval(intervalMs + 5), 'lite');
  for (let i = 0; i < 100; i += 1) meter.interval(100);
  assert.equal(meter.tier, 'lite', 'lite is judged by draw time only');

  const smooth = createTierMeter();
  for (let i = 0; i < intervals; i += 1) smooth.interval(16.7);
  for (let i = 0; i < 100; i += 1) smooth.interval(100);
  assert.equal(smooth.tier, 'full');
});

test('slow draws step the mounted view to lite (DPR 1, no inertia) and then static (no orbit)', (t) => {
  const env = setup(t);
  env.setDrawMs(TIER_BUDGET.full.drawMs + 2);
  env.graph.update({ todos, categories, now: NOW });
  const canvas = env.canvases[0];
  const turn = (t0) => drag(canvas, { by: [30, 0], steps: TIER_BUDGET.full.frames, ms: 16, t0 });
  // One frame per pointermove would need a real loop; each flush runs what a gesture queued.
  for (let i = 0; env.root.dataset.mode === 'full' && i < 40; i += 1) {
    pointer(canvas, 'pointerdown', 1, 100, 100, i * 1000);
    pointer(canvas, 'pointermove', 1, 130 + i, 100, i * 1000 + 16);
    env.flush(1);
    pointer(canvas, 'pointerup', 1, 130 + i, 100, i * 1000 + 500);
    env.flush();
  }
  assert.equal(env.root.dataset.mode, 'lite');
  assert.equal(canvas.width, 390, 'DPR 1 in lite');
  drag(canvas, { by: [120, 0], steps: 6, ms: 10, t0: 90000 });
  assert.equal(env.flush(), 1, 'no inertia in lite');

  env.setDrawMs(TIER_BUDGET.lite.drawMs + 2);
  for (let i = 0; env.root.dataset.mode === 'lite' && i < 40; i += 1) {
    turn(100000 + i * 1000);
    env.flush();
  }
  assert.equal(env.root.dataset.mode, 'static');
  env.flush();
  env.idle();
  const before = env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' ');
  turn(200000);
  env.flush();
  env.idle();
  assert.equal(env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`).join(' '), before, 'dragging does not rotate');
});

test('projectFlat: a top view without perspective, higher nodes in front', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'gone' }];
  const positions = new Map([['a', { x: 10, y: 5, z: 20 }], ['b', { x: 0, y: -5, z: 0 }]]);
  const camera = { distance: 600, target: { x: 0, y: 0, z: 0 } };
  const out = projectFlat(positions, nodes, camera, { width: 400, height: 400 });
  const [ax, ay, scale, adepth, bx, by, bscale, bdepth] = out;
  assert.equal(scale, bscale, 'the same scale at every depth');
  assert.ok(Math.abs(ax - (200 + 10 * scale)) < 1e-3 && Math.abs(ay - (200 + 20 * scale)) < 1e-3);
  assert.deepEqual([bx, by], [200, 200]);
  assert.ok(adepth < bdepth, 'a is higher, so nearer');
  assert.equal(out[10], 0, 'a node without a place is hidden');
});

test('keyboard focus on a task button rings its node; destroy leaves nothing behind', (t) => {
  const env = setup(t);
  env.graph.update({ todos, categories, now: NOW });
  env.flush();
  const ctx = env.canvases[0].getContext('2d');
  const [list] = env.root.children.slice(1);
  const button = env.buttons()[0];
  const focus = new Event('focusin');
  Object.defineProperty(focus, 'target', { value: button });
  ctx.arcs.length = 0;
  list.dispatchEvent(focus);
  env.flush();
  assert.equal(ctx.arcs.length, todos.length + 3 + 1, 'every node plus the ring');

  let removed = 0;
  const removeListener = env.motion.removeEventListener.bind(env.motion);
  env.motion.removeEventListener = (...args) => { removed += 1; removeListener(...args); };
  list.dispatchEvent(focus);
  assert.equal(env.pending, 1);
  env.graph.destroy();
  assert.equal(env.pending, 0, 'the queued frame is cancelled');
  assert.equal(env.root.children.length, 0);
  assert.equal(env.root.dataset.mode, undefined);
  assert.equal(removed, 1, 'the reduced-motion listener is removed');
  env.graph.update({ todos, categories, now: NOW });
  assert.equal(env.pending, 0, 'a destroyed graph ignores updates');
});

test('zooming all the way out still draws every on-screen circle at >= MIN_SCREEN_RADIUS', (t) => {
  const env = setup(t);
  const fresh = [{ id: 'new0', text: 'Brand new', completed: false, createdAt: NOW, categoryId: null }];
  env.graph.update({ todos: fresh, categories: [], now: NOW });
  env.flush();
  const canvas = env.canvases[0];
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 15; i += 1) {
    const wheel = Object.assign(new Event('wheel', { cancelable: true }), {});
    Object.defineProperties(wheel, { deltaY: { value: 800 }, deltaMode: { value: 0 }, clientX: { value: 195 }, clientY: { value: 350 } });
    canvas.dispatchEvent(wheel);
  }
  ctx.arcs.length = 0;
  env.flush();
  assert.equal(ctx.arcs.length, 2, 'both hub and task circles are drawn');
  for (const [, , r] of ctx.arcs) assert.ok(r >= MIN_SCREEN_RADIUS, `radius ${r} >= ${MIN_SCREEN_RADIUS}`);
});

test('moving a task offscreen refits the camera; edits keeping it visible leave the camera alone', (t) => {
  const env = setup(t);
  const oneCat = [{ id: 'c0', name: 'Work' }];
  const list = [
    { id: 't0', text: 'Task 0', completed: false, createdAt: NOW, categoryId: 'c0' },
    { id: 't1', text: 'Task 1', completed: false, createdAt: NOW - 86400000, categoryId: 'c0' },
  ];
  env.graph.update({ todos: list, categories: oneCat, now: NOW });
  env.flush();
  env.idle();

  // Move t0 from the only category (Work) to Uncategorized: adds UNCATEGORIZED hub and moves t0.
  const moved = list.map((item) => (item.id === 't0' ? { ...item, categoryId: null } : item));
  env.graph.update({ todos: moved, categories: oneCat, now: NOW });
  env.flush();
  env.idle();
  const [x0, y0] = nodeAt(env, 't0');
  const cx0 = x0 - RECT.left;
  const cy0 = y0 - RECT.top;
  assert.ok(cx0 > 0 && cx0 < RECT.width && cy0 > 0 && cy0 < RECT.height, `t0 (${cx0},${cy0}) fits inside viewport`);
  const beforeStay = env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`);

  // Edit t0's text and completion without changing category: node stays visible, camera does NOT move.
  const edited = moved.map((item) => (item.id === 't0' ? { ...item, text: 'Task 0 renamed', completed: true } : item));
  env.graph.update({ todos: edited, categories: oneCat, now: NOW });
  env.flush();
  env.idle();
  assert.deepEqual(env.buttons().map((b) => `${b.dataset.x},${b.dataset.y}`), beforeStay, 'camera did not move');

  // Zoom way in on a hub so the other hub is offscreen, then move a task to that offscreen hub.
  const canvas = env.canvases[0];
  for (let i = 0; i < 6; i += 1) {
    const wheel = Object.assign(new Event('wheel', { cancelable: true }), {});
    Object.defineProperties(wheel, { deltaY: { value: -500 }, deltaMode: { value: 0 }, clientX: { value: 195 }, clientY: { value: 350 } });
    canvas.dispatchEvent(wheel);
  }
  env.flush();
  env.idle();
  const zoomedOutBack = moved.map((item) => (item.id === 't0' ? { ...item, categoryId: 'c0' } : item));
  env.graph.update({ todos: zoomedOutBack, categories: oneCat, now: NOW });
  env.flush();
  env.idle();
  const [rx, ry] = nodeAt(env, 't0');
  const cx = rx - RECT.left;
  const cy = ry - RECT.top;
  assert.ok(cx > 0 && cx < RECT.width && cy > 0 && cy < RECT.height, `moved t0 (${cx},${cy}) refitted into view`);
});

test('a touch tap cancels its touchend, so no synthesized click lands on what the tap opened', (t) => {
  const env = setup(t);
  env.graph.update({ todos, categories, now: NOW });
  const [canvas] = env.canvases;
  const touchEnd = () => {
    const event = new Event('touchend', { cancelable: true });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(touchEnd(), true);
  env.graph.destroy();
  assert.equal(touchEnd(), false, 'the listener goes with the graph');
});

// --- In the app: the List | Graph switch, the edit sheet, Esc/Back and the session ------------

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const appCategories = [{ id: id(901), name: 'Work', revision: 1 }, { id: id(902), name: 'Home', revision: 1 }];
const row = (n, text, categoryId = null, completed = false) => ({
  id: id(n), text, tags: [], categoryId, completed, createdAt: NOW - n * 86400000, due: null, repeat: 'none',
  notified: null, revision: 1,
});
const keydown = (target, key, init = {}) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key, ...init });
  target.dispatchEvent(event);
  return event;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('in the app: the graph replaces the list, opens tasks in the edit sheet, and leaves by List, Esc or Back', async (t) => {
  const server = createFakeApi();
  server.categories = appCategories;
  server.rows = [
    row(1, 'Write report', id(901)), row(2, 'Book flights', id(901), true), row(3, 'Water plants', id(902)),
    row(4, 'Loose end'),
  ];
  const { byId, app, list, matchMedia } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const root = byId('graph-view');
  const layer = byId('reminder-layer');
  const viewList = byId('view-list');
  const viewGraph = byId('view-graph');
  const switcher = byId('view-switch');
  app.append(root, viewList, viewGraph); // these controls sit inside .app in the page
  // History and scrolling, as the browser has them.
  const pushed = [];
  const entries = [null];
  let entryIndex = 0;
  Object.assign(window, {
    scrollY: 0,
    scrollTo: (x, y) => { window.scrollY = y; },
    history: {
      get state() { return entries[entryIndex]; },
      pushState(state) {
        entries.splice(entryIndex + 1, entries.length, state);
        entryIndex += 1;
        pushed.push(state);
      },
      go(delta) {
        setTimeout(() => {
          const next = entryIndex + delta;
          if (next < 0 || next >= entries.length) return;
          entryIndex = next;
          window.dispatchEvent(new Event('popstate'));
        });
      },
      back() { this.go(-1); },
    },
  });
  // Canvases are off (dom.js elements have no getContext) until a test turns them on.
  let canvasContext = null;
  const canvases = [];
  const createElement = document.createElement;
  document.createElement = (tagName) => {
    const element = createElement(tagName);
    if (tagName === 'canvas' && canvasContext) {
      element.getContext = () => canvasContext;
      element.getBoundingClientRect = () => RECT;
      canvases.push(element);
    }
    return element;
  };
  const frames = new Map();
  let nextFrame = 1;
  let time = 0;
  for (const [name, value] of Object.entries({
    requestAnimationFrame: (callback) => { frames.set(nextFrame, callback); return nextFrame++; },
    cancelAnimationFrame: (frame) => frames.delete(frame),
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; });
  const flush = () => {
    let ran = 0;
    for (; frames.size && ran < 1000; ran += 1) {
      const [frame, callback] = frames.entries().next().value;
      frames.delete(frame);
      time += 16;
      callback(time);
    }
    return ran;
  };
  // Frames, then the at-rest work that writes each button's data-x/y.
  const settleGraph = async () => {
    flush();
    await wait(150);
  };
  const buttons = () => root.querySelectorAll('button');
  const buttonFor = (n) => buttons().find((button) => button.dataset.focusKey === JSON.stringify(['graph-node', id(n)]));
  const open = async () => {
    viewGraph.click();
    await settle();
  };

  await import('../src/app.js');
  assert.equal(switcher.hidden, true, 'no switch while signed out');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  assert.equal(switcher.hidden, true, 'nor while loading');
  await settle();

  await t.test('the switch shows once the list is loaded; Graph replaces the list, List brings it back', async () => {
    assert.equal(switcher.hidden, false);
    assert.equal(markupAttributes('view-switch').role, 'group');
    assert.equal(viewList.getAttribute('aria-pressed'), 'true');
    assert.equal(viewGraph.getAttribute('aria-pressed'), 'false');
    assert.equal(root.hidden, true);
    // A filter, a scroll position and the rows the list shows under it.
    byId('category-filter').value = id(902);
    byId('category-filter').dispatchEvent(new Event('change'));
    const rows = list.children.map((item) => item.dataset.id);
    assert.deepEqual(rows, [id(3)]);
    assert.equal(byId('app-title').textContent, 'Home');
    window.scrollY = 240;

    await open();
    assert.equal(viewGraph.getAttribute('aria-pressed'), 'true');
    assert.equal(viewList.getAttribute('aria-pressed'), 'false');
    assert.equal(app.classList.contains('is-graph'), true);
    assert.equal(root.hidden, false);
    assert.deepEqual(pushed, [{ graph: true }], 'one history entry');
    // Every task, whatever the filter; the header is the plain one.
    assert.equal(buttons().length, 4);
    assert.equal(byId('app-title').textContent, 'Tasks');
    assert.equal(byId('category-filter').value, id(902), 'the filter is kept');
    assert.deepEqual(list.children.map((item) => item.dataset.id), rows, 'the list is left as it was');

    viewList.click();
    await settle();
    assert.equal(app.classList.contains('is-graph'), false);
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0, 'the graph is gone');
    assert.equal(window.history.state, null, 'its history entry was left');
    assert.equal(document.activeElement, viewList);
    assert.equal(window.scrollY, 240, 'the list scrolls back to where it was');
    assert.equal(byId('app-title').textContent, 'Home');
    assert.deepEqual(list.children.map((item) => item.dataset.id), rows);
    byId('category-filter').value = 'all';
    byId('category-filter').dispatchEvent(new Event('change'));
  });

  await t.test('without a 2D canvas the graph is the list fallback, and a task opens the edit sheet', async () => {
    await open();
    assert.equal(root.dataset.mode, 'list');
    assert.deepEqual(root.children[0].children.map((group) => group.children[0].textContent), ['HOME', 'UNCATEGORIZED', 'WORK']);
    buttonFor(3).click();
    assert.equal(layer.hidden, false, 'the existing task sheet');
    assert.equal(byId('edit-text').value, 'Water plants');
    assert.equal(byId('reminder-editor').getAttribute('aria-label'), 'Edit “Water plants”');
    // Esc in the sheet closes the sheet only; focus goes back to the task in the graph.
    assert.equal(keydown(byId('reminder-editor'), 'Escape').defaultPrevented, true);
    assert.equal(layer.hidden, true);
    assert.equal(root.hidden, false, 'still in the graph');
    assert.equal(document.activeElement, buttonFor(3));
  });

  await t.test('a change saved from the sheet shows in the graph', async () => {
    buttonFor(4).click();
    byId('edit-text').value = 'Tied up';
    byId('edit-text').dispatchEvent(new Event('input'));
    byId('reminder-save').click();
    await settle();
    assert.equal(layer.hidden, true);
    assert.equal(buttonFor(4).textContent, 'Tied up');
    assert.equal(root.hidden, false);
  });

  await t.test('Esc leaves the graph (not during IME composition, nor while the sheet is open)', async () => {
    keydown(document, 'Escape', { isComposing: true });
    assert.equal(root.hidden, false);
    // An Esc something else already used (the account menu) leaves the graph alone.
    const used = new Event('keydown', { cancelable: true });
    used.key = 'Escape';
    used.preventDefault();
    document.dispatchEvent(used);
    assert.equal(root.hidden, false);
    buttonFor(1).click();
    keydown(document, 'Escape'); // the sheet's own Esc handler isn't reached in this DOM; the sheet is open
    assert.equal(root.hidden, false);
    byId('reminder-cancel').click();
    assert.equal(keydown(document, 'Escape').defaultPrevented, true);
    assert.equal(root.hidden, true);
    assert.equal(document.activeElement, viewGraph);
    await settle(); // the popstate from leaving the history entry changes nothing
    assert.equal(root.hidden, true);
  });

  await t.test('Back (popstate) leaves the graph', async () => {
    await open();
    window.history.back();
    await settle();
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0);
    assert.equal(viewGraph.getAttribute('aria-pressed'), 'false');
  });

  await t.test('Back closes the sheet first, with one Graph entry across repeated closes and reopens', async () => {
    await open();
    for (let i = 0; i < 2; i += 1) {
      buttonFor(1).click();
      assert.equal(layer.hidden, false);
      byId('reminder-cancel').click();
      assert.equal(layer.hidden, true);
      await settle();
      assert.equal(entryIndex, 1);
    }
    buttonFor(1).click();
    byId('reminder-cancel').click();
    buttonFor(3).click(); // reopen before the asynchronous Back from Cancel arrives
    await settle();
    assert.equal(layer.hidden, false);
    assert.equal(byId('edit-text').value, 'Water plants');
    assert.equal(entryIndex, 2);
    assert.equal(entries.length, 3);
    window.history.back();
    await settle();
    assert.equal(layer.hidden, true);
    assert.equal(app.inert, false);
    assert.equal(root.hidden, false);
    assert.equal(document.activeElement, buttonFor(3));
    assert.equal(entryIndex, 1);

    window.history.back();
    await settle();
    assert.equal(root.hidden, true);
    assert.equal(document.activeElement, viewGraph);
    assert.equal(entryIndex, 0);
  });

  await t.test('with a canvas: a tap on a node opens that task, a drag turns the scene instead', async () => {
    canvasContext = fakeContext();
    await open();
    assert.equal(root.dataset.mode, 'full');
    await settleGraph();
    const [canvas] = canvases;
    const at = (n) => [Number(buttonFor(n).dataset.x) + RECT.left, Number(buttonFor(n).dataset.y) + RECT.top];
    const [x, y] = at(1);
    const before = buttons().map((button) => `${button.dataset.x},${button.dataset.y}`).join(' ');
    drag(canvas, { from: [x, y], by: [60, 0] });
    await settleGraph();
    assert.equal(layer.hidden, true, 'the drag opened nothing');
    assert.notEqual(buttons().map((button) => `${button.dataset.x},${button.dataset.y}`).join(' '), before, 'the scene turned');

    const [tx, ty] = at(3);
    pointer(canvas, 'pointerdown', 2, tx, ty, 20000);
    pointer(canvas, 'pointerup', 2, tx + 1, ty, 20080);
    assert.equal(layer.hidden, false);
    assert.equal(byId('edit-text').value, 'Water plants');
    byId('reminder-cancel').click();
    assert.equal(layer.hidden, true);
    assert.equal(root.hidden, false, 'closing the sheet returns to the graph');
    assert.equal(document.activeElement, buttonFor(3));
  });

  await t.test('reduced motion (the app\'s media query, read live): a flick stops when released', async () => {
    const [canvas] = canvases;
    drag(canvas, { by: [120, 0], steps: 6, ms: 10, t0: 30000 });
    assert.ok(flush() > 5, 'with motion, the flick spins on');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    drag(canvas, { by: [120, 0], steps: 6, ms: 10, t0: 40000 });
    assert.equal(flush(), 1, 'one frame for the drag, none after the release');
    motion.matches = false;
    motion.dispatchEvent(new Event('change'));
    await wait(150);
  });

  await t.test('weak device: slow draws step the graph down to the flat 2D view, which still opens tasks', async () => {
    viewList.click();
    await settle();
    // Every arc takes 3 ms: each frame is well over both tiers' budgets.
    const slow = fakeContext();
    canvasContext = new Proxy(slow, {
      get: (target, name) => (name === 'arc' ? () => { const end = performance.now() + 3; while (performance.now() < end); } : target[name]),
      set: (target, name, value) => { target[name] = value; return true; },
    });
    canvases.length = 0;
    await open();
    // Each wheel step draws a frame.
    for (let i = 0; i < 40 && root.dataset.mode !== 'static'; i += 1) {
      const wheel = new Event('wheel', { cancelable: true });
      Object.assign(wheel, { deltaY: i % 2 ? 40 : -40, deltaMode: 0, clientX: 100, clientY: 100 });
      canvases[0].dispatchEvent(wheel);
      flush();
    }
    assert.equal(root.dataset.mode, 'static');
    await settleGraph();
    const [x, y] = [Number(buttonFor(2).dataset.x) + RECT.left, Number(buttonFor(2).dataset.y) + RECT.top];
    pointer(canvases[0], 'pointerdown', 3, x, y, 50000);
    pointer(canvases[0], 'pointerup', 3, x, y, 50050);
    assert.equal(byId('edit-text').value, 'Book flights');
    byId('reminder-cancel').click();
  });

  await t.test('sign-out and an account switch leave no graph of the previous account', async () => {
    assert.equal(root.hidden, false);
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0, 'nothing of the account is left in the graph');
    assert.equal(root.dataset.mode, undefined);
    assert.equal(switcher.hidden, true);
    assert.equal(app.classList.contains('is-graph'), false);
    const queued = flush();
    assert.equal(queued, 0, 'and no frames run');

    // Signed back in, then another account in another tab: the graph closes at once.
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    await open();
    assert.equal(root.hidden, false);
    server.session = { user: { name: 'Bo', email: 'bo@example.test' }, csrfToken: 'token-b' };
    server.rows = [];
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0);
    await settle();
    assert.equal(root.hidden, true, 'the new account starts in the list');
    assert.equal(viewList.getAttribute('aria-pressed'), 'true');
  });

  await t.test('signed out while the graph code loads: it is never mounted', async () => {
    viewGraph.click(); // the import is on its way
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    await settle();
    assert.equal(root.children.length, 0);
    assert.equal(root.hidden, true);
  });

  await t.test('moving a task from the only category to Uncategorized refits the camera before restoring focus', async () => {
    server.categories = [{ id: id(901), name: 'Work', revision: 1 }];
    server.rows = [row(1, 'Solo task', id(901)), row(2, 'Second task', id(901))];
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    canvasContext = fakeContext();
    await open();
    await settleGraph();

    buttonFor(1).click();
    assert.equal(layer.hidden, false);
    byId('edit-category').value = '';
    byId('edit-category').dispatchEvent(new Event('change'));
    byId('reminder-save').click();
    await settle();
    await settleGraph();
    assert.equal(layer.hidden, true);
    assert.equal(document.activeElement, buttonFor(1), 'focus restored to the moved node');
    const nx = Number(buttonFor(1).dataset.x);
    const ny = Number(buttonFor(1).dataset.y);
    assert.ok(nx > 0 && nx < RECT.width && ny > 0 && ny < RECT.height, `moved node (${nx},${ny}) is inside viewport`);

    viewList.click();
    await settle();
    server.categories = appCategories;
  });

  await t.test('deleting from a graph sheet focuses a surviving task or the Graph toggle', async () => {
    server.rows = [row(1, 'Canvas task'), row(2, 'Fallback task'), row(3, 'Last task')];
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
    await settle();
    canvasContext = fakeContext();
    await open();
    assert.equal(root.dataset.mode, 'full');
    const remove = async (n) => {
      buttonFor(n).click();
      assert.equal(layer.hidden, false);
      byId('task-delete').click();
      await settle();
      assert.equal(layer.hidden, true);
      assert.equal(root.hidden, false);
      assert.equal(buttonFor(n), undefined);
    };
    await remove(1);
    assert.ok(buttons().includes(document.activeElement));

    viewList.click();
    await settle();
    canvasContext = null;
    await open();
    assert.equal(root.dataset.mode, 'list');
    await remove(2);
    assert.equal(document.activeElement, buttonFor(3));
    await remove(3);
    assert.equal(buttons().length, 0);
    assert.equal(document.activeElement, viewGraph);
  });
});
