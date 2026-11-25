// The graph view's drawing (src/graph-draw.js), against a recording fake context: colours by
// state, back-to-front order, one stroke for every link, the label cap and culling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawFrame, LABELS, PALETTE, pickLabels } from '../src/graph-draw.js';

// Records each call and each property set, in order.
function recorder() {
  const calls = [];
  const target = {};
  const ctx = new Proxy(target, {
    get: (_, name) => (name in target ? target[name] : (...args) => calls.push([name, ...args])),
    set: (_, name, value) => {
      calls.push([`=${String(name)}`, value]);
      target[name] = value;
      return true;
    },
    has: (_, name) => name === 'letterSpacing' || name in target,
  });
  return { ctx, calls, named: (name) => calls.filter(([call]) => call === name) };
}

// Nodes laid out by hand: [kind, state, x, y, scale, depth, radius, label].
function scene(rows) {
  const nodes = rows.map(([kind, state, , , , , radius = 5, label = `N${kind}`], i) => (
    { id: `n${i}`, kind, state, radius, label, hubId: kind === 'hub' ? null : 'n0' }
  ));
  const projected = new Float32Array(rows.length * 4);
  rows.forEach(([, , x, y, scale, depth], i) => projected.set([x, y, scale, depth], i * 4));
  const order = Uint16Array.from(rows.map((_, i) => i)).sort((a, b) => projected[b * 4 + 3] - projected[a * 4 + 3]);
  return { nodes, projected, order };
}

test('paints the page, then links, then circles back to front in their state colours', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50],
    ['task', 'open', 150, 100, 1, 10], // front
    ['task', 'done', 120, 140, 1, 90], // back
  ]);
  const { ctx, calls, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [1, 0, 2, 0], dpr: 2, width: 390, height: 700 });
  assert.deepEqual(calls[0], ['setTransform', 2, 0, 0, 2, 0, 0]);
  assert.deepEqual(calls.slice(1, 3), [['=fillStyle', PALETTE.bg], ['fillRect', 0, 0, 390, 700]]);
  const arcs = named('arc').map(([, x, y]) => `${x},${y}`);
  assert.deepEqual(arcs, ['120,140', '100,100', '150,100'], 'back to front');
  const fills = calls.filter(([call]) => call === '=fillStyle').map(([, v]) => v);
  assert.deepEqual(fills.slice(1, 4), [PALETTE.done, PALETTE.hub, PALETTE.open]);
  assert.equal(drawn.circles, 3);
});

test('every link goes into one path with a single hairline stroke', () => {
  const rows = [['hub', 'hub', 200, 200, 1, 50]];
  for (let i = 0; i < 50; i += 1) rows.push(['task', 'open', 100 + i * 4, 300, 1, 40]);
  const { nodes, projected, order } = scene(rows);
  const links = rows.slice(1).flatMap((_, i) => [i + 1, 0]);
  const { ctx, calls, named } = recorder();
  drawFrame(ctx, { nodes, projected, order, links, width: 390, height: 700 });
  assert.equal(named('moveTo').length, 50);
  assert.equal(named('lineTo').length, 50);
  const strokes = calls.map(([call], i) => [call, i]).filter(([call]) => call === 'stroke');
  assert.equal(strokes.length, 1, 'no focus ring, so the only stroke is the links');
  assert.ok(calls.some(([call, value]) => call === '=strokeStyle' && value === PALETTE.link));
  assert.ok(calls.some(([call, value]) => call === '=lineWidth' && value === 1));
});

test('nodes behind the camera, off the canvas or too small are not drawn, nor their links', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50],
    ['task', 'open', 0, 0, 0, -5], // behind the camera
    ['task', 'open', -50, 100, 1, 10], // off the left edge
    ['task', 'open', 100, 100, 0.01, 10], // 0.05 px
  ]);
  const { ctx, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [1, 0, 2, 0, 3, 0], width: 390, height: 700 });
  assert.equal(drawn.circles, 1);
  assert.equal(named('moveTo').length, 2, 'only the link to the node behind the camera is dropped');
});

test('a focused node gets a ring', () => {
  const { nodes, projected, order } = scene([['hub', 'hub', 100, 100, 1, 50], ['task', 'open', 150, 100, 2, 10, 4]]);
  const { ctx, calls } = recorder();
  drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 700, focusIndex: 1 });
  const ring = calls.findIndex(([call, x, y, r]) => call === 'arc' && x === 150 && r === 4 * 2 + 3);
  assert.ok(ring > 0);
  assert.deepEqual(calls.slice(ring + 1, ring + 4), [['=strokeStyle', PALETTE.focus], ['=lineWidth', 1.5], ['stroke']]);
});

test('labels: small monospace, set once, hubs always, tasks from the front up to the cap', () => {
  const rows = [['hub', 'hub', 20, 20, 1, 500, 8, 'WORK']];
  // 60 tasks on separate rows and columns so none collide; depth falls with i (later is nearer).
  for (let i = 0; i < 60; i += 1) rows.push(['task', 'open', 10 + (i % 3) * 120, 40 + i * 15, 1, 400 - i, 5, `T${i}`]);
  const { nodes, projected, order } = scene(rows);
  const { ctx, calls, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 2000, font: 'Mono' });
  assert.deepEqual(calls.filter(([call]) => call === '=font'), [['=font', `500 ${LABELS.size}px Mono`]]);
  assert.ok(calls.some(([call]) => call === '=letterSpacing'));
  const texts = named('fillText').map(([, text]) => text);
  assert.equal(drawn.labels, 1 + LABELS.max);
  assert.equal(texts[0], 'WORK');
  assert.deepEqual(texts.slice(1, 4), ['T59', 'T58', 'T57'], 'the nearest tasks first');
  assert.ok(!texts.includes('T0'), 'the farthest ones lose out');
  const hubText = calls.findIndex(([call, text]) => call === 'fillText' && text === 'WORK');
  assert.deepEqual(calls.slice(hubText - 2, hubText + 1), [['=fillStyle', PALETTE.hubLabel], ['strokeText', 'WORK', 32, 20], ['fillText', 'WORK', 32, 20]],
    'each label sits on a page-coloured halo');
});

test('labels a row apart but overlapping in height do not both show', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 300, 300, 1, 50, 8, 'HUB'],
    ['task', 'open', 100, 104, 1, 10, 5, 'UPPER'], // text 99..109, rows 7 and 8
    ['task', 'open', 100, 112, 1, 20, 5, 'LOWER'], // text 107..117: 2 px of overlap
  ]);
  assert.deepEqual(pickLabels(projected, nodes, order, { width: 390, height: 700 }).map((i) => nodes[i].label), ['HUB', 'UPPER']);
});

test('labels skip tasks too small on screen and those whose grid cell is taken', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50, 8, 'HOME'],
    ['task', 'open', 102, 102, 1, 10, 5, 'COVERED'], // same cell as the hub's label
    ['task', 'open', 100, 300, 0.5, 20, 5, 'TINY'], // 2.5 px on screen
    ['task', 'done', 100, 400, 1, 30, 5, 'SHOWN'],
  ]);
  const picked = pickLabels(projected, nodes, order, { width: 390, height: 700 }).map((i) => nodes[i].label);
  assert.deepEqual(picked, ['HOME', 'SHOWN']);
  assert.deepEqual(pickLabels(projected, nodes, order, { width: 390, height: 700, hubsOnly: true }).map((i) => nodes[i].label),
    ['HOME']);
});

test('the lite and static tiers label hubs only', () => {
  const { nodes, projected, order } = scene([['hub', 'hub', 50, 50, 1, 50, 8, 'HUB'], ['task', 'open', 50, 300, 1, 10, 5, 'TASK']]);
  for (const tier of ['lite', 'static']) {
    const { ctx, named } = recorder();
    drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 700, tier });
    assert.deepEqual(named('fillText').map(([, text]) => text), ['HUB'], tier);
  }
});
