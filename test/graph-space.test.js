// The graph view's geometry (src/graph-space.js): deterministic layout, the orbit camera,
// projection, depth order and picking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toGraph } from '../src/graph-data.js';
import {
  COLLISION_PAD, createCamera, depthOrder, DISTANCE, drawnRadius, EDGE_MARGIN, extent, FIT_PADDING, fitCamera, focalLength,
  frameCamera, layout, LAYOUT_ITERATIONS, spreadOnScreen, lookAt, MIN_SCREEN_RADIUS, orbit, pick, pickNearest, PITCH_LIMIT, project, relax, zoom,
} from '../src/graph-space.js';
import { projectFlat } from '../src/graph-view.js';

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 24 * 60 * 60 * 1000;
const categories = ['Work', 'Home', 'Errands', 'Side', 'Reading'].map((name, i) => ({ id: `c${i}`, name }));
const todos = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
  id: `t${String(i + offset).padStart(3, '0')}`,
  text: `Task ${i + offset}`,
  completed: i % 3 === 0,
  createdAt: NOW - (i % 50) * DAY,
  categoryId: i % 6 === 5 ? null : `c${i % 5}`,
}));
const viewport = { width: 390, height: 700 };
const plain = (positions) => JSON.stringify([...positions].sort(([a], [b]) => (a < b ? -1 : 1)));
const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

test('the layout is deterministic: same tasks, same places, whatever the input order', () => {
  const list = todos(60);
  const a = layout(toGraph(list, categories, NOW));
  const b = layout(toGraph([...list].reverse(), categories, NOW));
  assert.equal(plain(a), plain(b));
  assert.equal(a.size, 6 + 60); // 5 categories, the uncategorized hub and the tasks
});

test('every node has a finite place and tasks sit near their own hub', () => {
  const graph = toGraph(todos(200), categories, NOW);
  const positions = layout(graph);
  for (const node of graph.nodes) {
    const p = positions.get(node.id);
    assert.ok(p && finite(p), node.id);
    if (node.kind !== 'task') continue;
    const hub = positions.get(node.hubId);
    const own = Math.hypot(p.x - hub.x, p.y - hub.y, p.z - hub.z);
    assert.ok(own < 200, `${node.id} is ${own} from its hub`);
  }
});

test('hubs are spread apart; a single hub sits at the origin', () => {
  const graph = toGraph([], categories, NOW);
  const positions = layout(graph);
  const hubs = graph.nodes.map((node) => positions.get(node.id));
  for (let i = 0; i < hubs.length; i += 1) {
    for (let j = i + 1; j < hubs.length; j += 1) {
      assert.ok(Math.hypot(hubs[i].x - hubs[j].x, hubs[i].y - hubs[j].y, hubs[i].z - hubs[j].z) > 50);
    }
  }
  const lone = layout(toGraph([], [{ id: 'c0', name: 'Only' }], NOW));
  assert.deepEqual(lone.get('hub:c0'), { x: 0, y: 0, z: 0, hubId: null });
});

test('collision spacing: every pair of nodes keeps radius + COLLISION_PAD each, across clusters too', () => {
  assert.equal(COLLISION_PAD, 6);
  for (const [n, aspect] of [[14, 1], [14, 844 / 390], [60, 1], [200, 1.9]]) {
    const graph = toGraph(todos(n), categories, NOW);
    const positions = layout(graph, null, { aspect });
    const close = [];
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        if (a.kind === 'hub' && b.kind === 'hub') continue; // hubs are placed, not relaxed
        const p = positions.get(a.id);
        const q = positions.get(b.id);
        const want = a.radius + b.radius + 2 * COLLISION_PAD;
        if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < want - 0.5) close.push(`${a.id}/${b.id}`);
      }
    }
    assert.deepEqual(close, [], `${n} tasks, aspect ${aspect}`);
  }
});

test('the layout is deterministic for an aspect, and a tall aspect stretches the hubs upright', () => {
  const graph = toGraph(todos(30), categories, NOW);
  assert.equal(plain(layout(graph, null, { aspect: 2 })), plain(layout(graph, null, { aspect: 2 })));
  assert.equal(plain(layout(graph, null, { aspect: Number.NaN })), plain(layout(graph)));
  const spread = (positions, axis) => {
    const values = graph.nodes.filter((n) => n.kind === 'hub').map((n) => positions.get(n.id)[axis]);
    return Math.max(...values) - Math.min(...values);
  };
  const square = layout(graph);
  const tall = layout(graph, null, { aspect: 2 });
  assert.ok(spread(tall, 'y') > spread(square, 'y') * 1.4);
  assert.ok(spread(tall, 'x') < spread(square, 'x'));
  // With the last layout, kept hubs stay put whatever the aspect.
  const kept = layout(graph, square, { aspect: 2 });
  assert.equal(plain(kept), plain(square));
});

test('siblings are pushed apart so they do not overlap', () => {
  const graph = toGraph(todos(40).map((t) => ({ ...t, categoryId: 'c0' })), categories, NOW);
  const positions = layout(graph);
  const tasks = graph.nodes.filter((node) => node.kind === 'task');
  let overlaps = 0;
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = positions.get(tasks[i].id);
      const b = positions.get(tasks[j].id);
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < tasks[i].radius + tasks[j].radius) overlaps += 1;
    }
  }
  assert.equal(overlaps, 0);
});

test('with the last layout, adding a task moves no existing node', () => {
  const before = layout(toGraph(todos(30), categories, NOW));
  const graph = toGraph([...todos(30), ...todos(1, 500)], categories, NOW);
  const after = layout(graph, before);
  for (const [id, p] of before) assert.deepEqual(after.get(id), p, id);
  assert.ok(finite(after.get('task:t500')));
});

test('with the last layout, a task moved to another category is placed by its new hub', () => {
  const list = todos(10);
  const before = layout(toGraph(list, categories, NOW));
  const moved = list.map((t) => (t.id === 't000' ? { ...t, categoryId: 'c4' } : t));
  const after = layout(toGraph(moved, categories, NOW), before);
  assert.equal(after.get('task:t000').hubId, 'hub:c4');
  assert.notDeepEqual(after.get('task:t000'), before.get('task:t000'));
  assert.deepEqual(after.get('task:t001'), before.get('task:t001'));
});

test('relax never passes the iteration cap and never makes NaN, even from one spot', () => {
  const points = Array.from({ length: 50 }, () => ({ x: 0, y: 0, z: 0, r: 9 }));
  const passes = relax(points);
  assert.ok(passes <= LAYOUT_ITERATIONS && passes > 0);
  assert.ok(points.every(finite));
  assert.equal(relax([{ x: 0, y: 0, z: 0, r: 1 }, { x: 100, y: 0, z: 0, r: 1 }]), 1); // nothing to do
  const pinned = [{ x: 0, y: 0, z: 0, r: 5 }, { x: 1, y: 0, z: 0, r: 5 }];
  relax(pinned, 1);
  assert.deepEqual(pinned[0], { x: 0, y: 0, z: 0, r: 5 }); // the fixed point stays
  assert.ok(pinned[1].x > 1);
});

test('orbit turns and clamps pitch; zoom clamps the distance', () => {
  const camera = createCamera();
  const turned = orbit(camera, 100, 0);
  assert.ok(turned.yaw > camera.yaw);
  assert.equal(turned.pitch, camera.pitch);
  assert.equal(orbit(camera, 0, 1e6).pitch, PITCH_LIMIT);
  assert.equal(orbit(camera, 0, -1e6).pitch, -PITCH_LIMIT);
  assert.equal(camera.yaw, 0.6); // pure: the input is untouched
  assert.equal(zoom(camera, 1e-6).distance, DISTANCE.min);
  assert.equal(zoom(camera, 1e6).distance, DISTANCE.max);
  assert.equal(zoom(camera, 2).distance, camera.distance * 2);
  assert.equal(zoom(camera, 0), camera);
  assert.equal(zoom(camera, Number.NaN), camera);
});

test('the default camera fits the layout', () => {
  const graph = toGraph(todos(200), categories, NOW);
  const positions = layout(graph);
  const camera = createCamera(extent(positions, graph.nodes));
  const projected = project(positions, graph.nodes, camera, viewport);
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const [x, y, scale] = projected.subarray(i * 4, i * 4 + 3);
    assert.ok(scale > 0 && x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height, graph.nodes[i].id);
  }
  assert.equal(createCamera().distance, DISTANCE.initial);
});

test('fitCamera: projected bounds fit inside the viewport with padding on both iPhone and desktop', () => {
  const graph = toGraph(todos(14), categories, NOW);
  const positions = layout(graph);
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const camera = fitCamera(createCamera(extent(positions, graph.nodes)), positions, graph.nodes, vp);
    const projected = project(positions, graph.nodes, camera, vp);
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const k = i * 4;
      const scale = projected[k + 2];
      if (!(scale > 0)) continue;
      const r = graph.nodes[i].radius * scale;
      const x = projected[k];
      const y = projected[k + 1];
      assert.ok(x - r >= -1 && x + r <= vp.width + 1, `${graph.nodes[i].id} x=${x} r=${r} in ${vp.width}x${vp.height}`);
      assert.ok(y - r >= -1 && y + r <= vp.height + 1, `${graph.nodes[i].id} y=${y} r=${r} in ${vp.width}x${vp.height}`);
    }
    // Nodes shouldn't be jammed into a tiny area: they should use at least 25% of the viewport width.
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      if (projected[i * 4 + 2] > 0) {
        minX = Math.min(minX, projected[i * 4]);
        maxX = Math.max(maxX, projected[i * 4]);
      }
    }
    assert.ok(maxX - minX > vp.width * 0.25, `spread ${maxX - minX} in ${vp.width}`);
  }
});

// Screen bounds of the drawn circles (with MIN_SCREEN_RADIUS), and each node's room to the edges.
function screenFit(positions, nodes, camera, vp, project_ = project) {
  const projected = project_(positions, nodes, camera, vp);
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  const tight = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    assert.ok(scale > 0, `${nodes[i].id} in front of the camera`);
    const r = drawnRadius(nodes[i].radius, scale);
    const [x, y] = [projected[k], projected[k + 1]];
    bounds.left = Math.min(bounds.left, x - r);
    bounds.right = Math.max(bounds.right, x + r);
    bounds.top = Math.min(bounds.top, y - r);
    bounds.bottom = Math.max(bounds.bottom, y + r);
    const room = Math.min(x, vp.width - x, y, vp.height - y) - r; // from the circle's edge
    tight.push(room);
  }
  return { bounds, minRoom: Math.min(...tight) };
}

test('fit padding: on load the circles fill the viewport to about FIT_PADDING px, centred, on phone and desktop', () => {
  assert.equal(FIT_PADDING, 24);
  for (const vp of [{ width: 390, height: 740 }, { width: 564, height: 616 }, { width: 1280, height: 632 }]) {
    for (const n of [5, 14, 60]) {
      const graph = toGraph(todos(n), categories, NOW);
      const positions = layout(graph, null, { aspect: vp.height / vp.width });
      const camera = frameCamera(positions, graph.nodes, vp);
      const { bounds, minRoom } = screenFit(positions, graph.nodes, camera, vp);
      const where = `${n} tasks in ${vp.width}x${vp.height}`;
      assert.ok(minRoom >= FIT_PADDING - 0.5, `${where}: every circle at least ${FIT_PADDING} px inside (${minRoom})`);
      // Tight on at least one axis: the fit touches the padding on both sides of it.
      const gapX = [bounds.left, vp.width - bounds.right];
      const gapY = [bounds.top, vp.height - bounds.bottom];
      const fills = (gaps) => gaps.every((g) => g < FIT_PADDING + 3);
      assert.ok(fills(gapX) || fills(gapY), `${where}: fills an axis (x gaps ${gapX}, y gaps ${gapY})`);
      // Centred: the two gaps of each axis match.
      assert.ok(Math.abs(gapX[0] - gapX[1]) < 3 && Math.abs(gapY[0] - gapY[1]) < 3, `${where}: centred (${gapX} / ${gapY})`);
    }
  }
});

test('fit padding: a 14-task graph on a 390×740 phone canvas uses most of the height too', () => {
  const vp = { width: 390, height: 740 };
  const graph = toGraph(todos(14), categories, NOW);
  const positions = layout(graph, null, { aspect: vp.height / vp.width });
  const { bounds } = screenFit(positions, graph.nodes, frameCamera(positions, graph.nodes, vp), vp);
  assert.ok(bounds.bottom - bounds.top > vp.height * 0.6, `height used ${bounds.bottom - bounds.top} of ${vp.height}`);
});

test('fitCamera keeps the angle, recentres and refits after a resize; the flat static view fits too', () => {
  const graph = toGraph(todos(14), categories, NOW);
  const positions = layout(graph);
  const turned = { ...createCamera(), yaw: 1.3, pitch: -0.9, target: { x: 50, y: -30, z: 20 } };
  for (const vp of [{ width: 390, height: 740 }, { width: 740, height: 390 }]) {
    const camera = fitCamera(turned, positions, graph.nodes, vp);
    assert.deepEqual([camera.yaw, camera.pitch], [1.3, -0.9]);
    assert.ok(screenFit(positions, graph.nodes, camera, vp).minRoom >= FIT_PADDING - 0.5);
    const flat = fitCamera(turned, positions, graph.nodes, vp, FIT_PADDING, { flat: true });
    const { bounds, minRoom } = screenFit(positions, graph.nodes, flat, vp, projectFlat);
    assert.ok(minRoom >= FIT_PADDING - 0.5, `flat ${minRoom}`);
    assert.ok(Math.abs(bounds.left - (vp.width - bounds.right)) < 1, 'flat view centred');
  }
});

test('edge margin: every fitted node centre is at least its radius + EDGE_MARGIN inside the canvas', () => {
  assert.equal(EDGE_MARGIN, 8);
  assert.ok(FIT_PADDING >= EDGE_MARGIN);
  for (const vp of [{ width: 390, height: 740 }, { width: 1280, height: 632 }, { width: 320, height: 320 }]) {
    for (const n of [1, 14, 200]) {
      const graph = toGraph(todos(n), categories, NOW);
      const positions = layout(graph, null, { aspect: vp.height / vp.width });
      const camera = frameCamera(positions, graph.nodes, vp);
      const projected = project(positions, graph.nodes, camera, vp);
      for (let i = 0; i < graph.nodes.length; i += 1) {
        const k = i * 4;
        const r = drawnRadius(graph.nodes[i].radius, projected[k + 2]);
        const room = Math.min(projected[k], vp.width - projected[k], projected[k + 1], vp.height - projected[k + 1]);
        assert.ok(room >= r + EDGE_MARGIN, `${graph.nodes[i].id} in ${vp.width}x${vp.height}: ${room} >= ${r} + ${EDGE_MARGIN}`);
      }
    }
  }
});

test('frameCamera is deterministic and prefers a start angle with no overlapping circles', () => {
  const vp = { width: 390, height: 740 };
  const graph = toGraph(todos(14), categories, NOW);
  const positions = layout(graph, null, { aspect: vp.height / vp.width });
  const a = frameCamera(positions, graph.nodes, vp);
  assert.deepEqual(a, frameCamera(positions, graph.nodes, vp));
  const projected = project(positions, graph.nodes, a, vp);
  let overlaps = 0;
  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const d = Math.hypot(projected[i * 4] - projected[j * 4], projected[i * 4 + 1] - projected[j * 4 + 1]);
      if (d < drawnRadius(graph.nodes[i].radius, projected[i * 4 + 2]) + drawnRadius(graph.nodes[j].radius, projected[j * 4 + 2])) overlaps += 1;
    }
  }
  assert.equal(overlaps, 0, 'no two circles overlap on screen at the start');
});

test('spreadOnScreen: the first view has no overlapping circles (radius + COLLISION_PAD each), hubs unmoved', () => {
  const titles = 14;
  for (const vp of [{ width: 390, height: 768 }, { width: 560, height: 616 }]) {
    for (const offset of [0, 100, 200, 300, 400]) {
      const graph = toGraph(todos(titles, offset), categories, NOW);
      const positions = layout(graph, null, { aspect: vp.height / vp.width });
      const first = frameCamera(positions, graph.nodes, vp);
      const spread = spreadOnScreen(positions, graph.nodes, first, vp);
      assert.equal(plain(spread), plain(spreadOnScreen(positions, graph.nodes, first, vp)), 'deterministic');
      assert.notEqual(spread, positions, 'a new map; the layout is untouched');
      for (const node of graph.nodes) {
        if (node.kind === 'hub') assert.deepEqual(spread.get(node.id), positions.get(node.id), node.id);
      }
      const camera = fitCamera(first, spread, graph.nodes, vp);
      const projected = project(spread, graph.nodes, camera, vp);
      const close = [];
      for (let i = 0; i < graph.nodes.length; i += 1) {
        for (let j = i + 1; j < graph.nodes.length; j += 1) {
          const d = Math.hypot(projected[i * 4] - projected[j * 4], projected[i * 4 + 1] - projected[j * 4 + 1]);
          const ri = drawnRadius(graph.nodes[i].radius, projected[i * 4 + 2]);
          const rj = drawnRadius(graph.nodes[j].radius, projected[j * 4 + 2]);
          if (d < ri + rj) close.push(`${graph.nodes[i].id}/${graph.nodes[j].id}`);
        }
      }
      assert.deepEqual(close, [], `offset ${offset} in ${vp.width}x${vp.height}`);
      assert.ok(screenFit(spread, graph.nodes, camera, vp).minRoom >= FIT_PADDING - 0.5, 'still fitted with padding');
    }
  }
});

test('spreadOnScreen pushes two stacked tasks apart by their radii + 2 × COLLISION_PAD, within the pass cap', () => {
  const nodes = [
    { id: 'h', kind: 'hub', radius: 11 },
    { id: 'a', kind: 'task', radius: 5 },
    { id: 'b', kind: 'task', radius: 5 },
  ];
  const positions = new Map([['h', { x: -100, y: 0, z: 0 }], ['a', { x: 50, y: 0, z: 0 }], ['b', { x: 50, y: 0, z: 0.5 }]]);
  const camera = { yaw: 0, pitch: 0, distance: 400, target: { x: 0, y: 0, z: 0 } };
  const vp = { width: 400, height: 400 };
  const spread = spreadOnScreen(positions, nodes, camera, vp);
  const projected = project(spread, nodes, camera, vp);
  const d = Math.hypot(projected[4] - projected[8], projected[5] - projected[9]);
  const want = drawnRadius(5, projected[6]) + drawnRadius(5, projected[10]) + 2 * COLLISION_PAD;
  assert.ok(d >= want - 0.5, `${d} >= ${want}`);
  assert.deepEqual(spread.get('h'), positions.get('h'));
  assert.ok([...spread.values()].every(finite));
  assert.deepEqual(positions.get('a'), { x: 50, y: 0, z: 0 }, 'the input is untouched');
});

test('fitCamera: small task nodes stay tappable at the default zoom', () => {
  // A graph where most tasks are very new (small radius).
  const newTodos = Array.from({ length: 14 }, (_, i) => ({
    id: `t${String(i).padStart(3, '0')}`, text: `Task ${i}`, completed: false,
    createdAt: NOW - i * 60000, categoryId: i % 6 === 5 ? null : `c${i % 5}`,
  }));
  const graph = toGraph(newTodos, categories, NOW);
  const positions = layout(graph);
  const vp = { width: 390, height: 844 };
  const camera = fitCamera(createCamera(extent(positions, graph.nodes)), positions, graph.nodes, vp);
  const projected = project(positions, graph.nodes, camera, vp);
  // Every task should project to at least 1.5 CSS px radius (the min drawn radius).
  for (let i = 0; i < graph.nodes.length; i += 1) {
    if (graph.nodes[i].kind !== 'task') continue;
    const scale = projected[i * 4 + 2];
    assert.ok(scale > 0, `${graph.nodes[i].id} is visible`);
    const screenR = graph.nodes[i].radius * scale;
    assert.ok(screenR >= 1.5, `${graph.nodes[i].id} projected radius ${screenR.toFixed(1)} >= 1.5 CSS px`);
  }
});

test('project: the target lands in the centre, scale falls with depth, y is up', () => {
  const nodes = [{ id: 'o', radius: 5 }, { id: 'near', radius: 5 }, { id: 'up', radius: 5 }, { id: 'gone', radius: 5 }];
  const positions = new Map([['o', { x: 0, y: 0, z: 0 }], ['near', { x: 0, y: 0, z: -100 }], ['up', { x: 0, y: 50, z: 0 }]]);
  const camera = { yaw: 0, pitch: 0, distance: 500, target: { x: 0, y: 0, z: 0 } };
  const p = project(positions, nodes, camera, viewport);
  assert.equal(p[0], 195);
  assert.equal(p[1], 350);
  assert.ok(Math.abs(p[2] - focalLength(viewport) / 500) < 1e-6);
  assert.equal(p[3], 500);
  assert.ok(p[4 + 2] > p[2] && p[4 + 3] < p[3]); // nearer is bigger
  assert.ok(p[8 + 1] < 350); // up on screen
  assert.equal(p[12 + 2], 0); // no position: not drawn
  const reused = project(positions, nodes, lookAt(camera, { x: 0, y: 50, z: 0 }), viewport, p);
  assert.equal(reused, p);
  assert.equal(p[8], 195);
  assert.equal(p[9], 350);
});

test('project: a node behind the camera has scale 0', () => {
  const nodes = [{ id: 'behind', radius: 5 }];
  const camera = { yaw: 0, pitch: 0, distance: 200, target: { x: 0, y: 0, z: 0 } };
  const p = project(new Map([['behind', { x: 0, y: 0, z: -300 }]]), nodes, camera, viewport);
  assert.equal(p[2], 0);
});

test('depthOrder goes back to front', () => {
  const projected = Float32Array.from([0, 0, 1, 300, 0, 0, 1, 900, 0, 0, 1, 100, 0, 0, 1, 300]);
  assert.deepEqual([...depthOrder(projected)], [1, 0, 3, 2]);
});

test('pick: the front-most covering node; null on empty space or outside the slop', () => {
  const nodes = [{ id: 'back', radius: 10 }, { id: 'front', radius: 4 }, { id: 'hidden', radius: 50 }];
  // [x, y, scale, depth]: back and front overlap at (100, 100); hidden is behind the camera.
  const projected = Float32Array.from([100, 100, 1, 900, 104, 100, 1, 300, 100, 100, 0, -5]);
  assert.equal(pick(projected, nodes, 103, 100), 'front');
  assert.equal(pick(projected, nodes, 92, 100), 'back'); // inside back only
  assert.equal(pick(projected, nodes, 300, 300, 10), null);
  assert.equal(pick(projected, nodes, 100, 115), null); // 15 px off back's 10 px radius
  assert.equal(pick(projected, nodes, 100, 115, 6), 'back'); // a touch slop covers it
});

test('pickNearest: returns the nearest visible node by screen distance, not depth', () => {
  const nodes = [{ id: 'back', radius: 10 }, { id: 'front', radius: 4 }, { id: 'small', radius: 2 }];
  // back at (100,100) depth 900, front at (104,100) depth 300, small at (118,100) depth 500
  const projected = Float32Array.from([100, 100, 1, 900, 104, 100, 1, 300, 118, 100, 1, 500]);
  // A point at (112, 100): 2 px from front's edge, 6 px from small's edge, 2 px from back's edge
  // back edge: 100+10=110 → dist 2; front edge: 104+4=108 → dist 4; small edge: 118-2=116 → dist -4(inside)
  // Actually: pickNearest uses dist = hypot - r. At (112,100):
  //   back: hypot(100-112,100-100)=12, 12-10=2
  //   front: hypot(104-112,100-100)=8, 8-4=4
  //   small: hypot(118-112,100-100)=6, 6-2=4
  // back is nearest at dist 2.
  assert.equal(pickNearest(projected, nodes, 112, 100, 5), 'back');
  // But at (115,100): back dist=15-10=5, front dist=11-4=7, small dist=3-2=1 → small wins.
  assert.equal(pickNearest(projected, nodes, 115, 100, 5), 'small');
  // No match outside slop.
  assert.equal(pickNearest(projected, nodes, 300, 300, 10), null);
  // Inside a circle: dist is negative → always wins if it's the closest.
  assert.equal(pickNearest(projected, nodes, 100, 100, 0), 'back'); // dist = 0-10 = -10
});

test('drawnRadius, pick, and pickNearest clamp small on-screen nodes to MIN_SCREEN_RADIUS consistently', () => {
  assert.equal(drawnRadius(3, 0), 0);
  assert.equal(drawnRadius(3, 0.16), MIN_SCREEN_RADIUS);
  assert.equal(drawnRadius(5, 2), 10);

  // A brand-new task (radius 3) zoomed all the way out to DISTANCE.max on a 390x844 phone.
  const graph = toGraph([{ id: 't0', text: 'New', completed: false, createdAt: NOW, categoryId: null }], [], NOW);
  const positions = layout(graph);
  const zoomedOut = { yaw: 0.6, pitch: -0.35, distance: DISTANCE.max, target: { x: 0, y: 0, z: 0 } };
  const vp = { width: 390, height: 844 };
  const projected = project(positions, graph.nodes, zoomedOut, vp);
  const taskIdx = graph.nodes.findIndex((n) => n.id === 'task:t0');
  const scale = projected[taskIdx * 4 + 2];
  assert.ok(graph.nodes[taskIdx].radius * scale < 1, 'raw radius would be sub-pixel');
  assert.equal(drawnRadius(graph.nodes[taskIdx].radius, scale), MIN_SCREEN_RADIUS);

  // Hit-testing uses the same clamped radius MIN_SCREEN_RADIUS (not the sub-pixel raw radius).
  const nodes = [{ id: 'tiny', radius: 3 }];
  const p = Float32Array.from([100, 100, 0.16, 2400]); // raw radius 0.48 -> clamped to MIN_SCREEN_RADIUS
  assert.equal(pick(p, nodes, 100 + MIN_SCREEN_RADIUS - 0.1, 100, 0), 'tiny');
  assert.equal(pick(p, nodes, 100 + MIN_SCREEN_RADIUS + 0.5, 100, 0), null);
  assert.equal(pickNearest(p, nodes, 100 + MIN_SCREEN_RADIUS + 2, 100, 2), 'tiny');
  assert.equal(pickNearest(p, nodes, 100 + MIN_SCREEN_RADIUS + 2.5, 100, 2), null);
});

test('a pick at a projected node finds that node in a real layout', () => {
  const graph = toGraph(todos(80), categories, NOW);
  const positions = layout(graph);
  const camera = createCamera(extent(positions, graph.nodes));
  const projected = project(positions, graph.nodes, camera, viewport);
  const order = depthOrder(projected);
  const front = order[order.length - 1];
  assert.equal(pick(projected, graph.nodes, projected[front * 4], projected[front * 4 + 1]), graph.nodes[front].id);
});

test('layout of 200 tasks and 50 hubs stays fast', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `k${i}`, name: `Cat ${i}` }));
  const list = todos(200).map((t, i) => ({ ...t, categoryId: `k${i % 50}` }));
  const graph = toGraph(list, many, NOW);
  const start = performance.now();
  const positions = layout(graph);
  const ms = performance.now() - start;
  assert.equal(positions.size, 250);
  assert.ok(ms < 100, `${ms} ms`); // budget is 5 ms on a phone; this only guards against blow-ups
});
