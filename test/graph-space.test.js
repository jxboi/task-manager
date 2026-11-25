// The graph view's geometry (src/graph-space.js): deterministic layout, the orbit camera,
// projection, depth order and picking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toGraph } from '../src/graph-data.js';
import {
  createCamera, depthOrder, DISTANCE, extent, fitCamera, focalLength, layout, LAYOUT_ITERATIONS, lookAt, orbit, pick, pickNearest,
  PITCH_LIMIT, project, relax, zoom,
} from '../src/graph-space.js';

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
