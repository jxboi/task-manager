import { MAX_TAGS, normalizeTag, normalizeTags } from './tags.js';

export function addTodo(todos, text, tags = []) {
  const trimmed = text.trim();
  if (trimmed === '') return todos;
  return [
    ...todos,
    {
      id: crypto.randomUUID(),
      text: trimmed,
      completed: false,
      createdAt: Date.now(),
      tags: normalizeTags(tags),
    },
  ];
}

export function toggleTodo(todos, id) {
  return todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo));
}

export function removeTodo(todos, id) {
  return todos.filter((todo) => todo.id !== id);
}

// Returns `todos` itself when nothing changes (invalid, duplicate, over the cap, unknown id).
export function addTag(todos, id, raw) {
  const tag = normalizeTag(raw);
  const todo = todos.find((item) => item.id === id);
  if (tag === null || !todo || todo.tags.includes(tag) || todo.tags.length >= MAX_TAGS) return todos;
  return todos.map((item) => (item === todo ? { ...item, tags: [...item.tags, tag] } : item));
}

// Returns `todos` itself when the todo doesn't have the tag.
export function removeTag(todos, id, tag) {
  const todo = todos.find((item) => item.id === id);
  if (!todo || !todo.tags.includes(tag)) return todos;
  return todos.map((item) =>
    item === todo ? { ...item, tags: item.tags.filter((existing) => existing !== tag) } : item,
  );
}

// Every tag in use with the number of todos carrying it, A to Z.
export function allTags(todos) {
  const counts = new Map();
  for (const todo of todos) {
    for (const tag of todo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) }));
}

// OR: todos with at least one of the active tags. No active tags means every todo.
export function filterByTags(todos, activeTags) {
  const active = new Set(activeTags);
  if (active.size === 0) return todos;
  return todos.filter((todo) => todo.tags.some((tag) => active.has(tag)));
}
