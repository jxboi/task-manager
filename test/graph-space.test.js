// The graph view's geometry (src/graph-space.js): deterministic layout, the orbit camera,
// projection, depth order and picking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toGraph } from '../src/graph-data.js';
import {
  COLLISION_PAD, createCamera, depthOrder, DISTANCE, drawnRadius, EDGE_MARGIN, extent, FIT_PADDING, fitCamera, focalLength,
  frameCamera, groupOnScreen, layout, LAYOUT_ITERATIONS, MAX_FIT_SCALE, nudgeLabels, spreadOnScreen, lookAt, MIN_SCREEN_RADIUS, orbit, pick, pickNearest, PITCH_LIMIT, project, relax, zoom,
} from '../src/graph-space.js';
import { labelWidth, planLabels, sideExtents } from '../src/graph-draw.js';
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

test('zoom about an anchor keeps every node under it in place, at any depth, flat or not; limits unchanged', () => {
  const graph = toGraph(todos(40), categories, NOW);
  const positions = layout(graph);
  const vp = { width: 390, height: 700 };
  for (const flat of [false, true]) {
    const proj = flat ? projectFlat : project;
    const base = fitCamera({ ...createCamera(), yaw: 1.1, pitch: -0.5 }, positions, graph.nodes, vp, FIT_PADDING, { flat });
    const before = proj(positions, graph.nodes, base, vp);
    // The outermost node: the one furthest from the canvas centre.
    let far = 0;
    let best = -1;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const d = Math.hypot(before[i * 4] - vp.width / 2, before[i * 4 + 1] - vp.height / 2);
      if (before[i * 4 + 2] > 0 && d > best) { best = d; far = i; }
    }
    const x = before[far * 4];
    const y = before[far * 4 + 1];
    for (const factor of [0.25, 0.8, 1.5, 4]) {
      const zoomed = zoom(base, factor, { x, y, viewport: vp, flat });
      assert.equal(zoomed.distance, zoom(base, factor).distance, 'the same distance as an unanchored zoom');
      assert.deepEqual([zoomed.yaw, zoomed.pitch], [base.yaw, base.pitch]);
      const after = proj(positions, graph.nodes, zoomed, vp);
      assert.ok(Math.hypot(after[far * 4] - x, after[far * 4 + 1] - y) < 0.01,
        `${flat ? 'flat' : 'perspective'} ×${factor}: the node under the anchor stays (${after[far * 4]}, ${after[far * 4 + 1]}) vs (${x}, ${y})`);
      // Any point along the anchor's line of sight stays too: another depth projects to the same pixel.
      const ray = (d) => {
        const out = proj(new Map([['p', d]]), [{ id: 'p', radius: 1 }], zoomed, vp);
        return [out[0], out[1]];
      };
      if (!flat) {
        // A world point that sat on the anchor's line of sight, further back than the node.
        const cam = base;
        const back = proj(positions, graph.nodes, cam, vp)[far * 4 + 3];
        const k = (back + 80) / back;
        const eye = (() => {
          const cy = Math.cos(cam.yaw); const sy = Math.sin(cam.yaw); const cp = Math.cos(cam.pitch); const sp = Math.sin(cam.pitch);
          // The camera sits `distance` behind the target along the view direction (camera z).
          const fwd = { x: cp * sy, y: sp, z: cp * cy };
          return { x: cam.target.x - fwd.x * cam.distance, y: cam.target.y - fwd.y * cam.distance, z: cam.target.z - fwd.z * cam.distance };
        })();
        const p = positions.get(graph.nodes[far].id);
        const deeper = { x: eye.x + (p.x - eye.x) * k, y: eye.y + (p.y - eye.y) * k, z: eye.z + (p.z - eye.z) * k };
        const was = proj(new Map([['p', deeper]]), [{ id: 'p', radius: 1 }], cam, vp);
        assert.ok(Math.hypot(was[0] - x, was[1] - y) < 0.05, 'the deeper point starts under the anchor');
        const [dx, dy] = ray(deeper);
        assert.ok(Math.hypot(dx - x, dy - y) < 0.05, `×${factor}: a deeper point on the same line stays (${dx}, ${dy})`);
      }
    }
    // At a limit the distance cannot change, so neither does the target.
    const atMax = { ...base, distance: DISTANCE.max };
    assert.deepEqual(zoom(atMax, 2, { x, y, viewport: vp, flat }).target, atMax.target);
    assert.equal(zoom(base, 1e-6, { x, y, viewport: vp, flat }).distance, DISTANCE.min);
    assert.equal(zoom(base, 1e6, { x, y, viewport: vp, flat }).distance, DISTANCE.max);
    // The centre anchor is the plain zoom.
    assert.deepEqual(zoom(base, 2, { x: vp.width / 2, y: vp.height / 2, viewport: vp, flat }).target, base.target);
  }
});

test('a pinch whose midpoint moves carries the node under it along exactly, at that node\'s depth', () => {
  const graph = toGraph(todos(40), categories, NOW);
  const positions = layout(graph);
  const vp = { width: 390, height: 700 };
  const base = fitCamera({ ...createCamera(), yaw: 2.2, pitch: -0.8 }, positions, graph.nodes, vp);
  const before = project(positions, graph.nodes, base, vp);
  // The nearest and the furthest node: the depths furthest from the target's plane.
  const byDepth = graph.nodes.map((_, i) => i).filter((i) => before[i * 4 + 2] > 0).sort((a, b) => before[a * 4 + 3] - before[b * 4 + 3]);
  for (const i of [byDepth[0], byDepth.at(-1)]) {
    let camera = base;
    let [x, y] = [before[i * 4], before[i * 4 + 1]];
    // Alternating wobble of the midpoint while zooming in, like two fingers reported one at a time.
    for (let step = 0; step < 12; step += 1) {
      const toX = x + (step % 2 ? -3 : 4);
      const toY = y + (step % 2 ? 2 : -1);
      const depth = project(positions, graph.nodes, camera, vp)[i * 4 + 3];
      camera = zoom(camera, 0.93, { x, y, toX, toY, depth, viewport: vp });
      [x, y] = [toX, toY];
      const now = project(positions, graph.nodes, camera, vp);
      assert.ok(Math.hypot(now[i * 4] - x, now[i * 4 + 1] - y) < 0.01, `node ${i} step ${step}: follows the midpoint`);
    }
    // Without its depth, a node off the target's plane drifts: the depth matters.
    const depth = project(positions, graph.nodes, base, vp)[i * 4 + 3];
    if (Math.abs(depth - base.distance) > 20) {
      const plain = project(positions, graph.nodes, zoom(base, 0.5, { x: before[i * 4], y: before[i * 4 + 1], toX: before[i * 4] + 40, toY: before[i * 4 + 1], viewport: vp }), vp);
      assert.ok(Math.abs(plain[i * 4] - (before[i * 4] + 40)) > 0.5, 'the target-plane fallback is not exact off the plane');
    }
  }
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
      const capped = Math.abs(camera.distance - focalLength(vp) / MAX_FIT_SCALE) < 1e-6;
      assert.ok(fills(gapX) || fills(gapY) || capped, `${where}: fills an axis (x gaps ${gapX}, y gaps ${gapY})`);
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

test('a fit never comes closer than MAX_FIT_SCALE px per world unit, so a tiny graph does not balloon', () => {
  const graph = toGraph(todos(2), [categories[0]], NOW);
  const positions = layout(graph);
  for (const flat of [false, true]) {
    const vp = { width: 1280, height: 632 };
    const camera = fitCamera(createCamera(), positions, graph.nodes, vp, FIT_PADDING, { flat });
    assert.ok(focalLength(vp) / camera.distance <= MAX_FIT_SCALE + 1e-9, `flat ${flat}`);
  }
});

test('spreadOnScreen in the flat (static) view leaves no overlapping circles either', () => {
  const vp = { width: 390, height: 768 };
  const graph = toGraph(todos(14), categories, NOW);
  const positions = layout(graph, null, { aspect: vp.height / vp.width }); // tall: the top view stacks it
  const first = fitCamera(createCamera(), positions, graph.nodes, vp, FIT_PADDING, { flat: true });
  const spread = spreadOnScreen(positions, graph.nodes, first, vp, { flat: true });
  const camera = fitCamera(first, spread, graph.nodes, vp, FIT_PADDING, { flat: true });
  const projected = projectFlat(spread, graph.nodes, camera, vp);
  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const d = Math.hypot(projected[i * 4] - projected[j * 4], projected[i * 4 + 1] - projected[j * 4 + 1]);
      const want = drawnRadius(graph.nodes[i].radius, projected[i * 4 + 2]) + drawnRadius(graph.nodes[j].radius, projected[j * 4 + 2]);
      if (graph.nodes[i].kind === 'hub' && graph.nodes[j].kind === 'hub') continue;
      assert.ok(d >= want, `${graph.nodes[i].id}/${graph.nodes[j].id}: ${d} < ${want}`);
    }
  }
  assert.ok(screenFit(spread, graph.nodes, camera, vp, projectFlat).minRoom >= FIT_PADDING - 0.5);
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

test('tapping a task inside a foreground hub ring picks the task', () => {
  const nodes = [{ id: 'hub', kind: 'hub', radius: 20 }, { id: 'task', kind: 'task', radius: 5 }];
  const projected = Float32Array.from([100, 100, 2, 100, 135, 100, 1, 200]);
  assert.equal(pick(projected, nodes, 135, 100), 'task', 'exact task inside the ring');
  assert.equal(pick(projected, nodes, 135, 100, 8), 'task', 'task beats hub touch tolerance');
  assert.equal(pick(projected, nodes, 140, 100), 'task', 'task takes priority at the stroke');
  assert.equal(pick(projected, nodes, 100, 100), null, 'hollow centre');
  assert.equal(pickNearest(projected, nodes, 100, 100, 8), null, 'hollow centre with touch tolerance');
});

test('tapping a hub ring hits its stroke and the slop on either side', () => {
  const nodes = [{ id: 'hub', kind: 'hub', radius: 20 }, { id: 'task', kind: 'task', radius: 3 }];
  const projected = Float32Array.from([100, 100, 2, 100, 100, 132, 1, 200]);
  assert.equal(pick(projected, nodes, 140.7, 100), 'hub', 'on the outer half of the stroke');
  assert.equal(pick(projected, nodes, 139.3, 100), 'hub', 'on the inner half of the stroke');
  assert.equal(pick(projected, nodes, 139, 100), null, 'past the inner edge of the stroke');
  assert.equal(pick(projected, nodes, 141, 100), null, 'past the outer edge of the stroke');
  assert.equal(pickNearest(projected, nodes, 132, 100, 8), 'hub');
  assert.equal(pickNearest(projected, nodes, 148, 100, 8), 'hub');
  assert.equal(pickNearest(projected, nodes, 100, 136, 8), 'task', 'nearest edge wins over the foreground hub');
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

test('groupOnScreen forms distinct non-interleaving category groups and spreads hubs evenly across phone and desktop', () => {
  const cats = [{ id: 'w', name: 'Work' }, { id: 'h', name: 'Home' }, { id: 'e', name: 'Errands' }];
  const tasks = [
    ['Write quarterly report', 'w'], ['Review pull requests', 'w'], ['Plan team offsite', 'w'], ['Update roadmap', 'w'],
    ['Water the plants', 'h'], ['Fix leaking tap', 'h'], ['Clean the gutters', 'h'],
    ['Buy groceries', 'e'], ['Post the parcel', 'e'], ['Pick up dry cleaning', 'e'], ['Renew passport', 'e'],
    ['Call grandma', null], ['Read a novel', null], ['Learn the ukulele', null],
  ].map(([text, categoryId], i) => ({ id: `t${i}`, text, completed: i % 3 === 0, createdAt: NOW - i * DAY, categoryId }));
  const graph = toGraph(tasks, cats, NOW);
  for (const vp of [{ width: 390, height: 768 }, { width: 1280, height: 644 }]) {
    let pos = layout(graph, null, { aspect: vp.height / vp.width });
    let cam = frameCamera(pos, graph.nodes, vp);
    pos = spreadOnScreen(pos, graph.nodes, cam, vp);
    const grouped = groupOnScreen(pos, graph.nodes, cam, vp, { labelWidth: (n) => labelWidth(n.label), labelGap: 4 });
    assert.equal(plain(grouped), plain(groupOnScreen(pos, graph.nodes, cam, vp, { labelWidth: (n) => labelWidth(n.label), labelGap: 4 })), 'deterministic');
    cam = fitCamera(cam, grouped, graph.nodes, vp);
    const proj = project(grouped, graph.nodes, cam, vp);
    const hubs = graph.nodes.map((n, i) => (n.kind === 'hub' ? { id: n.id, i, x: proj[i * 4], y: proj[i * 4 + 1] } : null)).filter(Boolean);
    // Every task sits closer on screen to its own hub than to any other category's hub (no interleaving).
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = graph.nodes[i];
      if (node.kind !== 'task') continue;
      const own = hubs.find((h) => h.id === node.hubId);
      const dOwn = Math.hypot(proj[i * 4] - own.x, proj[i * 4 + 1] - own.y);
      for (const other of hubs) {
        if (other.id === own.id) continue;
        const dOther = Math.hypot(proj[i * 4] - other.x, proj[i * 4 + 1] - other.y);
        assert.ok(dOwn < dOther, `${vp.width}x${vp.height}: ${node.label} closer to own hub (${dOwn.toFixed(1)}) than ${other.id} (${dOther.toFixed(1)})`);
      }
    }
    // Hubs span most of the viewport's primary area instead of leaving empty bands.
    const hx = hubs.map((h) => h.x);
    const hy = hubs.map((h) => h.y);
    assert.ok(Math.max(...hy) - Math.min(...hy) > vp.height * 0.5, `${vp.width}x${vp.height}: hubs fill height`);
    if (vp.width > vp.height) {
      assert.ok(Math.max(...hx) - Math.min(...hx) > vp.width * 0.45, `${vp.width}x${vp.height}: hubs fill width`);
    }
  }
});

test('fitCamera with labels keeps every label bounding box inside FIT_PADDING on phone and desktop', () => {
  const cats = [{ id: 'w', name: 'Work' }, { id: 'h', name: 'Home' }, { id: 'e', name: 'Errands' }];
  const tasks = [
    ['Write quarterly report', 'w'], ['Review pull requests', 'w'], ['Plan team offsite', 'w'], ['Update roadmap', 'w'],
    ['Water the plants', 'h'], ['Fix leaking tap', 'h'], ['Clean the gutters', 'h'],
    ['Buy groceries', 'e'], ['Post the parcel', 'e'], ['Pick up dry cleaning', 'e'], ['Renew passport', 'e'],
    ['Call grandma', null], ['Read a novel', null], ['Learn the ukulele', null],
  ].map(([text, categoryId], i) => ({ id: `t${i}`, text, completed: i % 3 === 0, createdAt: NOW - i * DAY, categoryId }));
  const graph = toGraph(tasks, cats, NOW);
  for (const vp of [{ width: 390, height: 768 }, { width: 1280, height: 644 }]) {
    let pos = layout(graph, null, { aspect: vp.height / vp.width });
    let cam = frameCamera(pos, graph.nodes, vp);
    pos = spreadOnScreen(pos, graph.nodes, cam, vp);
    pos = groupOnScreen(pos, graph.nodes, cam, vp, { labelWidth: (n) => labelWidth(n.label), labelGap: 4 });
    cam = fitCamera(cam, pos, graph.nodes, vp);
    for (let pass = 0; pass < 2; pass += 1) {
      const pr = project(pos, graph.nodes, cam, vp);
      const pl = planLabels(pr, graph.nodes, depthOrder(pr), { width: vp.width, height: vp.height, padding: FIT_PADDING });
      const labels = new Map(pl.map((e) => [graph.nodes[e.index].id, sideExtents(e.side, labelWidth(graph.nodes[e.index].label))]));
      cam = fitCamera(cam, pos, graph.nodes, vp, FIT_PADDING, { labels });
    }
    const pr = project(pos, graph.nodes, cam, vp);
    const plan = planLabels(pr, graph.nodes, depthOrder(pr), { width: vp.width, height: vp.height, padding: FIT_PADDING });
    for (const entry of plan) {
      assert.ok(entry.left >= FIT_PADDING - 0.5 && entry.right <= vp.width - FIT_PADDING + 0.5
        && entry.top >= FIT_PADDING - 0.5 && entry.bottom <= vp.height - FIT_PADDING + 0.5,
        `${vp.width}x${vp.height}: ${graph.nodes[entry.index].label} [${entry.left.toFixed(1)}, ${entry.right.toFixed(1)}, ${entry.top.toFixed(1)}, ${entry.bottom.toFixed(1)}] inside ${FIT_PADDING}px`);
    }
  }
});

test('nudgeLabels separates overlapping labels without detaching them from their nodes', () => {
  const nodes = [
    { id: 'hub:w', kind: 'hub', radius: 11, label: 'WORK', hubId: null },
    { id: 'task:a', kind: 'task', radius: 5, label: 'WRITE QUARTERLY REPORT', hubId: 'hub:w' },
    { id: 'task:b', kind: 'task', radius: 5, label: 'PLAN TEAM OFFSITE', hubId: 'hub:w' },
  ];
  const positions = new Map([
    ['hub:w', { x: -60, y: 0, z: 0 }],
    ['task:a', { x: 0, y: 0, z: 0 }],
    ['task:b', { x: 0, y: 0, z: 0.5 }],
  ]);
  const camera = { yaw: 0, pitch: 0, distance: 400, target: { x: 0, y: 0, z: 0 } };
  const vp = { width: 400, height: 400 };
  const nudged = nudgeLabels(positions, nodes, camera, vp, (pr, ord) => planLabels(pr, nodes, ord, { width: vp.width, height: vp.height, padding: FIT_PADDING }));
  const pr = project(nudged, nodes, camera, vp);
  const plan = planLabels(pr, nodes, depthOrder(pr), { width: vp.width, height: vp.height, padding: FIT_PADDING });
  assert.equal(plan.length, 3);
  for (const e of plan) assert.deepEqual(e.covers, []);
  for (let a = 0; a < plan.length; a += 1) {
    for (let b = a + 1; b < plan.length; b += 1) {
      const ba = plan[a];
      const bb = plan[b];
      assert.ok(!(ba.left < bb.right && bb.left < ba.right && ba.top < bb.bottom && bb.top < ba.bottom), 'no label overlap after nudge');
    }
  }
});
