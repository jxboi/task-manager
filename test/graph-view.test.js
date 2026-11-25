// The graph view's controller (src/graph-view.js) with a fake canvas and frame clock: the list
// fallback, tier stepping, render on demand, taps versus drags, hub re-centring, reduced motion
// and teardown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './dom.js';
import { context2d, createTierMeter, DPR_CAP, INERTIA, mountGraph, projectFlat, TIER_BUDGET } from '../src/graph-view.js';

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

const pointer = (target, type, pointerId, clientX, clientY, timeStamp, pointerType = 'touch') => {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: pointerType }, clientX: { value: clientX },
    clientY: { value: clientY }, timeStamp: { value: timeStamp },
  });
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

test('a hub tap re-centres on it: eased over frames, or at once under reduced motion', (t) => {
  for (const reduced of [false, true]) {
    const env = setup(t, { reduced });
    // Two lone hubs and nothing else, so every circle drawn is a hub.
    env.graph.update({ todos: [], categories: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], now: NOW });
    env.flush();
    const ctx = env.canvases[0].getContext('2d');
    const atCentre = ([x, y]) => Math.abs(x - RECT.width / 2) < 0.5 && Math.abs(y - RECT.height / 2) < 0.5;
    assert.equal(ctx.arcs.filter(atCentre).length, 0, 'neither hub starts at the centre');
    const [[hx, hy]] = ctx.arcs.map(([x, y]) => [x, y]).sort((p, q) => p[0] - q[0]); // tap the left one
    pointer(env.canvases[0], 'pointerdown', 1, hx + RECT.left, hy + RECT.top, 100, 'mouse');
    pointer(env.canvases[0], 'pointerup', 1, hx + RECT.left, hy + RECT.top, 150, 'mouse');
    ctx.arcs.length = 0;
    const frames = env.flush();
    assert.equal(env.opened.length, 0);
    if (reduced) assert.equal(frames, 1, 'instant');
    else assert.ok(frames >= 10, `eased over ${frames} frames`);
    // The tapped hub ends at the centre of the canvas.
    const last = ctx.arcs.slice(-2).map(([x, y]) => [x, y]).sort((p, q) => p[0] - q[0]);
    assert.ok(atCentre(last[0]), `${reduced ? 'reduced' : 'eased'}: the tapped hub is at the centre`);
    assert.ok(!atCentre(last[1]), 'and the other is not');
  }
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
