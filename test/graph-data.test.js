// The graph view's data mapping (src/graph-data.js): hubs per category, the uncategorized hub,
// open/done, age to radius, labels and the relayout signature.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ageRadius, hubRadius, MAX_LABEL_LENGTH, nodeLabel, nodeState, RADIUS, toGraph, UNCATEGORIZED_HUB,
} from '../src/graph-data.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12);
const HOME = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const WORK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EMPTY = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const categories = [
  { id: WORK, name: 'Work' },
  { id: HOME, name: 'home' },
  { id: EMPTY, name: 'Errands' },
];
const todo = (id, fields = {}) => ({
  id, text: `Task ${id}`, completed: false, createdAt: NOW - DAY, tags: [], categoryId: null, ...fields,
});
const hubs = (graph) => graph.nodes.filter((node) => node.kind === 'hub');
const byId = (graph, id) => graph.nodes.find((node) => node.id === id);

test('one hub per category, labelled in uppercase, with its task count', () => {
  const graph = toGraph([todo('a', { categoryId: HOME }), todo('b', { categoryId: HOME }), todo('c', { categoryId: WORK })],
    categories, NOW);
  assert.deepEqual(hubs(graph).map(({ id, label, count, state }) => [id, label, count, state]), [
    [`hub:${EMPTY}`, 'ERRANDS', 0, 'hub'],
    [`hub:${HOME}`, 'HOME', 2, 'hub'],
    [`hub:${WORK}`, 'WORK', 1, 'hub'],
  ]);
  assert.equal(byId(graph, 'task:a').hubId, `hub:${HOME}`);
  assert.equal(byId(graph, 'task:c').hubId, `hub:${WORK}`);
});

test('an empty category is a lone hub with no links', () => {
  const graph = toGraph([], categories, NOW);
  assert.equal(hubs(graph).length, 3);
  assert.equal(graph.links.length, 0);
  assert.equal(byId(graph, `hub:${EMPTY}`).radius, RADIUS.hubMin);
});

test('the uncategorized hub appears only when a task needs it, and catches unknown categories', () => {
  assert.equal(byId(toGraph([todo('a', { categoryId: HOME })], categories, NOW), UNCATEGORIZED_HUB), undefined);
  const gone = '00000000-0000-4000-8000-000000000000'; // deleted in another tab
  const graph = toGraph([todo('a'), todo('b', { categoryId: gone }), todo('c', { categoryId: undefined })], categories, NOW);
  const hub = byId(graph, UNCATEGORIZED_HUB);
  assert.equal(hub.label, 'UNCATEGORIZED');
  assert.equal(hub.count, 3);
  for (const id of ['task:a', 'task:b', 'task:c']) assert.equal(byId(graph, id).hubId, UNCATEGORIZED_HUB);
});

test('without a catalog (an older server) every task is uncategorized', () => {
  const graph = toGraph([todo('a', { categoryId: HOME }), todo('b')], null, NOW);
  assert.deepEqual(hubs(graph).map(({ id }) => id), [UNCATEGORIZED_HUB]);
  assert.equal(byId(graph, 'task:a').hubId, UNCATEGORIZED_HUB);
});

test('every task has exactly one link, to its own hub', () => {
  const list = [todo('a', { categoryId: HOME }), todo('b'), todo('c', { categoryId: WORK })];
  const graph = toGraph(list, categories, NOW);
  const tasks = graph.nodes.filter((node) => node.kind === 'task');
  assert.equal(tasks.length, 3);
  assert.equal(graph.links.length, 3);
  for (const task of tasks) {
    assert.deepEqual(graph.links.filter((link) => link.source === task.id), [{ source: task.id, target: task.hubId }]);
    assert.equal(task.todoId, task.id.slice('task:'.length));
  }
});

test('done and open, with a repeating task past completedUntil reading as open', () => {
  assert.equal(nodeState(todo('a'), NOW), 'open');
  assert.equal(nodeState(todo('a', { completed: true }), NOW), 'done');
  assert.equal(nodeState(todo('a', { completed: true, completedUntil: NOW + DAY }), NOW), 'done');
  assert.equal(nodeState(todo('a', { completed: true, completedUntil: NOW - 1 }), NOW), 'open');
  const graph = toGraph([todo('a', { completed: true }), todo('b')], null, NOW);
  assert.equal(byId(graph, 'task:a').state, 'done');
  assert.equal(byId(graph, 'task:b').state, 'open');
});

test('older tasks are bigger: monotonic, clamped to the min and max', () => {
  let last = 0;
  for (const days of [0, 0.5, 1, 7, 30, 90, 200, 365]) {
    const r = ageRadius(NOW - days * DAY, NOW);
    assert.ok(r > last || (days === 0 && r === RADIUS.taskMin), `${days} days: ${r}`);
    last = r;
  }
  assert.equal(ageRadius(NOW, NOW), RADIUS.taskMin);
  assert.equal(ageRadius(NOW - 365 * DAY, NOW), RADIUS.taskMax);
  assert.equal(ageRadius(NOW - 5000 * DAY, NOW), RADIUS.taskMax);
});

test('a future, missing or invalid createdAt is age 0 (the minimum radius)', () => {
  assert.equal(ageRadius(NOW + 10 * DAY, NOW), RADIUS.taskMin);
  assert.equal(ageRadius(undefined, NOW), RADIUS.taskMin);
  assert.equal(ageRadius(Number.NaN, NOW), RADIUS.taskMin);
  assert.equal(byId(toGraph([todo('a', { createdAt: NOW + DAY })], null, NOW), 'task:a').radius, RADIUS.taskMin);
});

test('hubs grow with their task count, clamped', () => {
  assert.equal(hubRadius(0), RADIUS.hubMin);
  assert.ok(hubRadius(1) > hubRadius(0));
  assert.ok(hubRadius(20) > hubRadius(5));
  assert.equal(hubRadius(RADIUS.hubCount), RADIUS.hubMax);
  assert.equal(hubRadius(10_000), RADIUS.hubMax);
});

test('a hub is always a little bigger than the biggest task, never much bigger', () => {
  for (const count of [0, 1, 5, 20, RADIUS.hubCount, 10_000]) {
    assert.ok(hubRadius(count) > RADIUS.taskMax, `${count} tasks: ${hubRadius(count)} > ${RADIUS.taskMax}`);
    assert.ok(hubRadius(count) <= RADIUS.taskMax * 1.4, `${count} tasks: ${hubRadius(count)} is only slightly larger`);
  }
});

test('labels are uppercase, one line and at most 22 code points with the ellipsis', () => {
  assert.equal(MAX_LABEL_LENGTH, 22);
  assert.equal(nodeLabel('buy milk'), 'BUY MILK');
  assert.equal(nodeLabel('  two\n  lines\t'), 'TWO LINES');
  assert.equal(nodeLabel('x'.repeat(22)), 'X'.repeat(22));
  assert.equal(nodeLabel('x'.repeat(23)), `${'X'.repeat(21)}…`);
  assert.equal(nodeLabel('Pick up the dry cleaning before Friday'), 'PICK UP THE DRY CLEAN…');
  const emoji = '🙂'.repeat(30); // surrogate pairs count once
  assert.equal(nodeLabel(emoji), `${'🙂'.repeat(21)}…`);
  assert.equal([...nodeLabel(emoji)].length, 22);
  assert.equal(nodeLabel(undefined), '');
});

test('the signature ignores revisions and list order, and changes with what is visible', () => {
  const list = [todo('a', { categoryId: HOME, revision: 1 }), todo('b', { revision: 4 })];
  const base = toGraph(list, categories, NOW).signature;
  const bumped = list.map((t) => ({ ...t, revision: t.revision + 1, position: 'zz' }));
  assert.equal(toGraph(bumped, categories, NOW).signature, base);
  assert.equal(toGraph([...list].reverse(), categories, NOW).signature, base);
  assert.notEqual(toGraph([{ ...list[0], completed: true }, list[1]], categories, NOW).signature, base);
  assert.notEqual(toGraph([{ ...list[0], text: 'renamed' }, list[1]], categories, NOW).signature, base);
  assert.notEqual(toGraph([{ ...list[0], categoryId: WORK }, list[1]], categories, NOW).signature, base);
  assert.notEqual(toGraph(list, categories, NOW + 300 * DAY).signature, base);
});
