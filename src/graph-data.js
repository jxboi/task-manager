// The graph view's data, without the DOM: todos and the category catalog become hub and task
// nodes, one link per task to its hub. Pure; src/graph-space.js places the nodes.
import { isCompleted } from './reminders.js';

/** @typedef {{ id: string, kind: 'task'|'hub', label: string, hubId: string|null,
 *   state: 'open'|'done'|'hub', radius: number, todoId?: string, count?: number }} GraphNode
 *  @typedef {{ source: string, target: string }} GraphLink
 *  @typedef {{ nodes: GraphNode[], links: GraphLink[], signature: string }} Graph */

export const UNCATEGORIZED_HUB = 'hub:none';
export const UNCATEGORIZED_LABEL = 'UNCATEGORIZED';
// Node radii in world units. Tasks grow with age up to `days`; hubs with their task count up to
// `hubCount`, always a little bigger than the biggest task so the hub ring reads as the parent.
export const RADIUS = { taskMin: 3, taskMax: 9, hubMin: 10.5, hubMax: 12.5, days: 365, hubCount: 100 };
export const MAX_LABEL_LENGTH = 22; // characters, the ellipsis included

const DAY = 24 * 60 * 60 * 1000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Bigger is older, on a log scale so the first weeks still show. A missing or future `createdAt`
// (clock skew) is age 0.
export function ageRadius(createdAt, now, r = RADIUS) {
  const days = Number.isFinite(createdAt) && Number.isFinite(now) ? Math.max(0, (now - createdAt) / DAY) : 0;
  return clamp(r.taskMin + ((r.taskMax - r.taskMin) * Math.log1p(days)) / Math.log1p(r.days), r.taskMin, r.taskMax);
}

// A repeating task whose completion ran out (`completedUntil`) reads as open again.
export function nodeState(todo, now) {
  return isCompleted(todo, now) ? 'done' : 'open';
}

export function hubRadius(count, r = RADIUS) {
  const share = Math.sqrt(Math.max(0, count) / r.hubCount);
  return clamp(r.hubMin + (r.hubMax - r.hubMin) * share, r.hubMin, r.hubMax);
}

// Uppercase in data, so the look doesn't depend on the font; whitespace runs become one space.
export function nodeLabel(text) {
  const points = [...String(text ?? '').replace(/\s+/g, ' ').trim().toUpperCase()];
  return points.length > MAX_LABEL_LENGTH ? `${points.slice(0, MAX_LABEL_LENGTH - 1).join('')}…` : points.join('');
}

// `categories`: the catalog, or null from a server without categories (every task is then
// uncategorized). The list's category filter doesn't apply: the graph shows every task.
export function toGraph(todos, categories, now) {
  const hubs = new Map();
  for (const category of categories ?? []) {
    hubs.set(category.id, {
      id: `hub:${category.id}`, kind: 'hub', label: nodeLabel(category.name), hubId: null, state: 'hub', count: 0,
    });
  }
  const tasks = [];
  for (const todo of todos) {
    // No category, or one that isn't in the catalog (deleted elsewhere): the uncategorized hub.
    let hub = categories ? hubs.get(todo.categoryId ?? null) : undefined;
    if (!hub) {
      hub = hubs.get(null);
      if (!hub) {
        hub = { id: UNCATEGORIZED_HUB, kind: 'hub', label: UNCATEGORIZED_LABEL, hubId: null, state: 'hub', count: 0 };
        hubs.set(null, hub);
      }
    }
    hub.count += 1;
    tasks.push({
      id: `task:${todo.id}`,
      kind: 'task',
      label: nodeLabel(todo.text),
      hubId: hub.id,
      state: nodeState(todo, now),
      radius: ageRadius(todo.createdAt, now),
      todoId: todo.id,
    });
  }
  // Fixed orders, so the same tasks give the same graph however the list is sorted.
  const hubNodes = [...hubs.values()]
    .map((hub) => ({ ...hub, radius: hubRadius(hub.count) }))
    .sort((a, b) => compare(a.label, b.label) || compare(a.id, b.id));
  tasks.sort((a, b) => compare(a.id, b.id));
  const nodes = [...hubNodes, ...tasks];
  const links = tasks.map((task) => ({ source: task.id, target: task.hubId }));
  // What is visible: a revision bump or a reorder leaves it the same, so no relayout is needed.
  const signature = JSON.stringify(nodes.map((n) => [n.id, n.hubId, n.state, Math.round(n.radius * 2), n.label]));
  return { nodes, links, signature };
}
