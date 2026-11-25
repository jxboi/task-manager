// The graph view's drawing (src/graph-draw.js), against a recording fake context: colours by
// state, back-to-front order, one stroke for every link, the label cap and culling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toGraph } from '../src/graph-data.js';
import { drawFrame, HUB_RING, LABELS, labelCandidates, PALETTE, pickLabels, placeLabel, planLabels } from '../src/graph-draw.js';
import { depthOrder, drawnRadius, frameCamera, layout, MIN_SCREEN_RADIUS, project } from '../src/graph-space.js';

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

test('a huge near-camera circle only occupies label grid cells on the canvas', (t) => {
  const { nodes, projected, order } = scene([['hub', 'hub', -20000, 350, 1000, 1.01, 21]]);
  const width = 390;
  const height = 700;
  const canvasCells = (Math.floor(width / 40) + 1) * (Math.floor(height / 40) + 1);
  const set = Map.prototype.set;
  let inserted = 0;
  t.mock.method(Map.prototype, 'set', function (key, value) {
    if (typeof key === 'number') {
      inserted += 1;
      assert.ok(inserted <= canvasCells, 'grid exceeds the canvas cell count');
    }
    return set.call(this, key, value);
  });

  assert.deepEqual(planLabels(projected, nodes, order, { width, height }), []);
  assert.equal(inserted, canvasCells, 'the visible bounds cover the canvas');
});

test('paints the page, then links, then circles back to front: tasks filled by state, hubs an unfilled ink ring', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50, 11],
    ['task', 'open', 150, 100, 1, 10], // front
    ['task', 'done', 120, 140, 1, 90], // back
  ]);
  const { ctx, calls, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [1, 0, 2, 0], dpr: 2, width: 390, height: 700 });
  assert.deepEqual(calls[0], ['setTransform', 2, 0, 0, 2, 0, 0]);
  assert.deepEqual(calls.slice(1, 3), [['=fillStyle', PALETTE.bg], ['fillRect', 0, 0, 390, 700]]);
  const arcs = named('arc').map(([, x, y]) => `${x},${y}`);
  assert.deepEqual(arcs, ['120,140', '100,100', '150,100'], 'back to front');
  const firstLabel = calls.findIndex(([call]) => call === '=font');
  const fills = calls.slice(0, firstLabel).filter(([call]) => call === '=fillStyle').map(([, v]) => v);
  assert.deepEqual(fills, [PALETTE.bg, PALETTE.done, PALETTE.open], 'the hub is never filled');
  const hubArc = calls.findIndex(([call, x, y]) => call === 'arc' && x === 100 && y === 100);
  assert.deepEqual(calls[hubArc].slice(1, 4), [100, 100, 11], 'the ring sits on the hub radius');
  assert.deepEqual(calls.slice(hubArc + 1, hubArc + 4), [['=strokeStyle', PALETTE.hub], ['=lineWidth', HUB_RING], ['stroke']]);
  assert.equal(HUB_RING, 1.5);
  assert.equal(PALETTE.hub, '#111111', 'ink');
  assert.ok(!calls.slice(hubArc + 1, hubArc + 4).some(([call]) => call === 'fill'));
  assert.equal(drawn.circles, 3);
});

test('hub labels are ink at weight 600; task labels stay grey at 500', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50, 11, 'WORK'],
    ['task', 'open', 100, 300, 1, 10, 5, 'TASK'],
  ]);
  const { ctx, calls } = recorder();
  drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 700, font: 'Mono' });
  const state = (text) => {
    const at = calls.findIndex(([call, t]) => call === 'fillText' && t === text);
    const last = (name) => calls.slice(0, at).filter(([call]) => call === name).at(-1)[1];
    return { font: last('=font'), fill: last('=fillStyle') };
  };
  assert.deepEqual(state('WORK'), { font: '600 10px Mono', fill: PALETTE.hubLabel });
  assert.deepEqual(state('TASK'), { font: '500 10px Mono', fill: PALETTE.label });
  assert.equal(PALETTE.hubLabel, '#111111');
  assert.notEqual(PALETTE.label, PALETTE.hubLabel, 'task labels are grey, not ink');
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
  const firstArc = calls.findIndex(([call]) => call === 'arc');
  const strokes = calls.filter(([call]) => call === 'stroke');
  assert.equal(calls.slice(0, firstArc).filter(([call]) => call === 'stroke').length, 1, 'one stroke for every link');
  assert.equal(strokes.length, 2, 'no focus ring, so the only other stroke is the one hub ring');
  assert.ok(calls.some(([call, value]) => call === '=strokeStyle' && value === PALETTE.link));
  assert.ok(calls.some(([call, value]) => call === '=lineWidth' && value === 1));
  // Each link stops at the hub's ring (radius 5 here) instead of running to its centre.
  for (const [, x, y] of named('lineTo')) assert.ok(Math.abs(Math.hypot(x - 200, y - 200) - 5) < 1e-6, `${x},${y}`);
});

test('nodes behind the camera or off the canvas are not drawn; tiny on-screen nodes clamp to MIN_SCREEN_RADIUS', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50],
    ['task', 'open', 0, 0, 0, -5], // behind the camera
    ['task', 'open', -50, 100, 1, 10], // off the left edge
    ['task', 'open', 200, 200, 0.01, 10], // 0.05 px raw -> clamped to MIN_SCREEN_RADIUS
  ]);
  const { ctx, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [1, 0, 2, 0, 3, 0], width: 390, height: 700, focusIndex: 3 });
  assert.equal(drawn.circles, 2);
  const arcs = named('arc');
  assert.deepEqual(arcs[0].slice(1, 4), [100, 100, 5]);
  assert.deepEqual(arcs[1].slice(1, 4), [200, 200, MIN_SCREEN_RADIUS], 'clamped to visible radius');
  assert.deepEqual(arcs[2].slice(1, 4), [200, 200, MIN_SCREEN_RADIUS + 3], 'focus ring surrounds clamped radius');
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

// Every label box from planLabels, with the circles it must keep clear of.
function checkPlan(projected, nodes, order, width, height) {
  const plan = planLabels(projected, nodes, order, { width, height });
  const circles = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const scale = projected[i * 4 + 2];
    if (scale > 0) circles.push({ i, x: projected[i * 4], y: projected[i * 4 + 1], r: drawnRadius(nodes[i].radius, scale) });
  }
  const covers = (b, c) => {
    const nx = Math.max(b.left, Math.min(c.x, b.right));
    const ny = Math.max(b.top, Math.min(c.y, b.bottom));
    return Math.hypot(c.x - nx, c.y - ny) < c.r;
  };
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return {
    plan,
    outside: plan.filter((b) => b.left < 0 || b.right > width || b.top < 0 || b.bottom > height).map((b) => nodes[b.index].label),
    covering: plan.flatMap((b) => circles.filter((c) => covers(b, c)).map((c) => `${nodes[b.index].label} covers ${nodes[c.i].label}`)),
    clashing: plan.flatMap((a, n) => plan.slice(n + 1).filter((b) => overlaps(a, b)).map((b) => `${nodes[a.index].label} / ${nodes[b.index].label}`)),
  };
}

test('labels: small monospace, every task labelled from the front, a safety cap', () => {
  const rows = [['hub', 'hub', 20, 20, 1, 500, 8, 'WORK']];
  // 60 tasks on separate rows and columns so none collide; depth falls with i (later is nearer).
  for (let i = 0; i < 60; i += 1) rows.push(['task', 'open', 10 + (i % 3) * 120, 40 + i * 15, 1, 400 - i, 5, `T${i}`]);
  const { nodes, projected, order } = scene(rows);
  const { ctx, calls, named } = recorder();
  const drawn = drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 2000, font: 'Mono' });
  assert.deepEqual(calls.filter(([call]) => call === '=font'), [['=font', `${LABELS.hubWeight} ${LABELS.size}px Mono`],
    ['=font', `${LABELS.weight} ${LABELS.size}px Mono`]], 'one font switch from the hub labels to the task labels');
  assert.equal(LABELS.size, 10);
  assert.ok(calls.some(([call]) => call === '=letterSpacing'));
  const texts = named('fillText').map(([, text]) => text);
  assert.equal(drawn.labels, 61, 'the hub and every task');
  assert.equal(texts[0], 'WORK');
  assert.deepEqual(texts.slice(1, 4), ['T59', 'T58', 'T57'], 'the nearest tasks first');
  const hubText = calls.findIndex(([call, text]) => call === 'fillText' && text === 'WORK');
  assert.deepEqual(calls.slice(hubText - 2, hubText + 1), [['=fillStyle', PALETTE.hubLabel], ['strokeText', 'WORK', 32, 20], ['fillText', 'WORK', 32, 20]],
    'each label sits on a page-coloured halo');
  // The cap only matters for huge graphs: the nearest win.
  const capped = pickLabels(projected, nodes, order, { width: 390, height: 2000, max: 5 }).map((i) => nodes[i].label);
  assert.deepEqual(capped, ['WORK', 'T59', 'T58', 'T57', 'T56', 'T55']);
  assert.ok(LABELS.max >= 200, 'a 200-task graph is fully labelled');
});

test('labels a row apart but overlapping in height both show, offset so they do not overlap', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 300, 300, 1, 50, 8, 'HUB'],
    ['task', 'open', 100, 104, 1, 10, 5, 'UPPER'],
    ['task', 'open', 100, 112, 1, 20, 5, 'LOWER'], // its right-hand box would overlap UPPER's by 4 px
  ]);
  const { plan, outside, covering, clashing } = checkPlan(projected, nodes, order, 390, 700);
  assert.deepEqual(plan.map((b) => nodes[b.index].label), ['HUB', 'UPPER', 'LOWER']);
  assert.deepEqual([outside, covering, clashing], [[], [], []]);
});

test('tiny tasks and tasks next to a hub label still get a label of their own', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 100, 100, 1, 50, 8, 'HOME'],
    ['task', 'open', 102, 120, 1, 10, 5, 'CROWDED'], // its right-hand spot is under HOME's label
    ['task', 'open', 100, 300, 0.2, 20, 5, 'TINY'], // 1 px raw, drawn at MIN_SCREEN_RADIUS
    ['task', 'done', 100, 400, 1, 30, 5, 'SHOWN'],
  ]);
  const { plan, outside, covering, clashing } = checkPlan(projected, nodes, order, 390, 700);
  assert.deepEqual(plan.map((b) => nodes[b.index].label).sort(), ['CROWDED', 'HOME', 'SHOWN', 'TINY']);
  assert.deepEqual([outside, covering, clashing], [[], [], []]);
  assert.deepEqual(pickLabels(projected, nodes, order, { width: 390, height: 700, hubsOnly: true }).map((i) => nodes[i].label),
    ['HOME']);
});

test('labels near the right edge flip to the left', () => {
  // UNCATEGORIZED (13 chars) at x=290 on a 390 px canvas would overflow the right edge.
  const rightSide = placeLabel(290, 10, 'UNCATEGORIZED', 390);
  assert.equal(rightSide.align, 'right');
  assert.equal(rightSide.x, 290 - 10 - LABELS.gap);

  const { nodes, projected, order } = scene([
    ['hub', 'hub', 290, 100, 1, 50, 10, 'UNCATEGORIZED'],
    ['task', 'open', 20, 300, 1, 20, 5, 'OK'],
  ]);
  const { ctx, calls, named } = recorder();
  drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 700 });
  assert.deepEqual(named('fillText').map(([, text]) => text), ['UNCATEGORIZED', 'OK']);
  const alignCalls = calls.filter(([call]) => call === '=textAlign');
  assert.deepEqual(alignCalls, [['=textAlign', 'left'], ['=textAlign', 'right'], ['=textAlign', 'left']]);
  const hubCall = named('fillText').find(([, text]) => text === 'UNCATEGORIZED');
  assert.equal(hubCall[2], 290 - 10 - LABELS.gap);
});

test('a label hitting a circle moves to the opposite side, or above or below when both sides are blocked', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 300, 300, 1, 100, 8, 'HUB'],
    // CALL GRANDMA at (120, 100): right label spans ~129..219; blocker at (165, 100) sits right in it.
    ['task', 'open', 120, 100, 1, 10, 5, 'CALL GRANDMA'],
    ['task', 'open', 165, 100, 1, 20, 5, 'BLOCK'],
    // Tiny blocker whose raw radius (0.5) misses y=200 (at y=207), but drawnRadius (3) reaches it.
    ['task', 'open', 150, 200, 1, 30, 5, 'CLAMPED'],
    ['task', 'open', 180, 207, 0.1, 40, 5, 'TINY'],
    // Circles on both sides: the label goes above (first) instead of being dropped.
    ['task', 'open', 200, 400, 1, 50, 5, 'TRAPPED'],
    ['task', 'open', 230, 400, 1, 60, 5, 'RIGHT'],
    ['task', 'open', 170, 400, 1, 70, 5, 'LEFT'],
  ]);
  const { plan, outside, covering, clashing } = checkPlan(projected, nodes, order, 390, 700);
  const at = Object.fromEntries(plan.map((b) => [nodes[b.index].label, b]));
  assert.equal(plan.length, nodes.length, 'every node is labelled');
  assert.deepEqual([at['CALL GRANDMA'].align, at['CALL GRANDMA'].x], ['right', 120 - 5 - LABELS.gap]);
  assert.deepEqual([at.BLOCK.align, at.BLOCK.x], ['left', 165 + 5 + LABELS.gap]);
  assert.deepEqual([at.CLAMPED.align, at.CLAMPED.x], ['right', 150 - 5 - LABELS.gap]);
  assert.ok(at.TRAPPED.bottom <= 400 - 5 || at.TRAPPED.top >= 400 + 5, 'TRAPPED went above or below its circle');
  assert.deepEqual([outside, covering, clashing], [[], [], []]);
});

test('labels stay inside the canvas at every edge and corner', () => {
  const { nodes, projected, order } = scene([
    ['hub', 'hub', 195, 350, 1, 100, 8, 'MIDDLE'],
    ['task', 'open', 6, 6, 1, 10, 5, 'TOP LEFT CORNER TASK'],
    ['task', 'open', 384, 6, 1, 20, 5, 'TOP RIGHT CORNER TASK'],
    ['task', 'open', 6, 694, 1, 30, 5, 'BOTTOM LEFT TASK'],
    ['task', 'open', 384, 694, 1, 40, 5, 'BOTTOM RIGHT TASK'],
    ['task', 'open', 20, 300, 1, 50, 5, 'CLIPPED'], // its right side is blocked, the left is off the canvas
    ['task', 'open', 50, 300, 1, 60, 5, 'EDGEBLOCK'],
  ]);
  const { plan, outside, covering, clashing } = checkPlan(projected, nodes, order, 390, 700);
  assert.equal(plan.length, nodes.length);
  assert.deepEqual([outside, covering, clashing], [[], [], []]);
});

test('labelCandidates: beside first (mirrored near the right edge), then above, below and around', () => {
  const right = labelCandidates(100, 100, 5, 'ABC');
  assert.ok(right.length >= 12, 'several places to try');
  assert.deepEqual([right[0].align, right[0].x, right[0].y], ['left', 100 + 5 + LABELS.gap, 100]);
  assert.deepEqual([right[1].align, right[1].x, right[1].y], ['right', 100 - 5 - LABELS.gap, 100]);
  assert.ok(right[2].bottom <= 100 - 5 && right[3].top >= 100 + 5, 'then above, then below');
  const left = labelCandidates(100, 100, 5, 'ABC', true);
  assert.deepEqual([left[0].align, left[1].align], ['right', 'left']);
  for (const b of right) assert.ok(b.right - b.left === 3 * LABELS.charWidth);
});

test('a seeded-size graph at 390×740 and 1280×632: every task labelled, inside the canvas, clear of circles and of each other', () => {
  const NOW = Date.UTC(2026, 10, 25, 12);
  const DAY = 86400000;
  const titles = ['Plan team offsite', 'Review pull requests', 'Update roadmap', 'Write the quarterly report for the board',
    'Water the plants', 'Fix the leaky tap', 'Clean the gutters', 'Renew passport', 'Buy groceries', 'Pick up dry cleaning',
    'Post the parcel', 'Call grandma', 'Read a novel', 'Learn the ukulele'];
  const cats = [{ id: 'w', name: 'Work' }, { id: 'h', name: 'Home' }, { id: 'e', name: 'Errands' }];
  const hubOf = (i) => (i < 4 ? 'w' : i < 7 ? 'h' : i < 11 ? 'e' : null);
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const list = titles.map((text, i) => ({
      id: `${seed}${(i * 2654435761 >>> 0).toString(16)}`, text, completed: i % 4 === 1, createdAt: NOW - ((i * 37) % 300) * DAY,
      categoryId: hubOf(i),
    }));
    const graph = toGraph(list, cats, NOW);
    for (const vp of [{ width: 390, height: 740 }, { width: 1280, height: 632 }]) {
      const positions = layout(graph, null, { aspect: vp.height / vp.width });
      const camera = frameCamera(positions, graph.nodes, vp);
      const projected = project(positions, graph.nodes, camera, vp);
      const order = depthOrder(projected);
      const { plan, outside, covering, clashing } = checkPlan(projected, graph.nodes, order, vp.width, vp.height);
      const where = `seed ${seed} at ${vp.width}x${vp.height}`;
      assert.equal(plan.length, graph.nodes.length, `${where}: every node labelled`);
      assert.deepEqual(outside, [], `${where}: inside the canvas`);
      assert.deepEqual(covering, [], `${where}: no label covers a circle`);
      assert.deepEqual(clashing, [], `${where}: no labels overlap`);
      for (const b of plan) assert.ok([...graph.nodes[b.index].label].length <= 22, `${where}: ${graph.nodes[b.index].label} capped`);
    }
  }
});

test('long titles are drawn capped at 22 characters with an ellipsis', () => {
  const graph = toGraph([{ id: 'x', text: 'Write the quarterly report for the board', completed: false, createdAt: 0 }], [], 0);
  const nodes = graph.nodes;
  const projected = new Float32Array([100, 100, 1, 50, 200, 300, 1, 10]);
  const { ctx, named } = recorder();
  drawFrame(ctx, { nodes, projected, order: Uint16Array.from([0, 1]), links: [], width: 390, height: 700 });
  const texts = named('fillText').map(([, text]) => text);
  assert.ok(texts.includes('WRITE THE QUARTERLY R…'), JSON.stringify(texts));
  assert.equal([...'WRITE THE QUARTERLY R…'].length, 22);
});

test('the lite and static tiers label hubs only', () => {
  const { nodes, projected, order } = scene([['hub', 'hub', 50, 50, 1, 50, 8, 'HUB'], ['task', 'open', 50, 300, 1, 10, 5, 'TASK']]);
  for (const tier of ['lite', 'static']) {
    const { ctx, named } = recorder();
    drawFrame(ctx, { nodes, projected, order, links: [], width: 390, height: 700, tier });
    assert.deepEqual(named('fillText').map(([, text]) => text), ['HUB'], tier);
  }
});
