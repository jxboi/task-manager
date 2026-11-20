import { MAX_TAGS, normalizeTag, normalizeTags } from './tags.js';
import { isCompleted, isOverdue, nextReminderAfterToday, normalizeReminder } from './reminders.js';

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
      due: null,
      repeat: 'none',
      notified: null,
    },
  ];
}

export function toggleTodo(todos, id, now = Date.now()) {
  return todos.map((todo) => {
    if (todo.id !== id) return todo;
    const completed = !isCompleted(todo, now);
    const due = completed ? nextReminderAfterToday(todo.due, todo.repeat, now) : null;
    if (due === null) {
      const changed = { ...todo, completed };
      if (todo.completedUntil != null) changed.completedUntil = null;
      return changed;
    }
    const startOfDay = new Date(due).setHours(0, 0, 0, 0);
    const completedUntil = startOfDay > now ? startOfDay : due;
    return { ...todo, completed, completedUntil, due, notified: due === todo.due ? todo.notified : null };
  });
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

// Replaces the reminder and re-arms it. Returns `todos` itself for an unknown id, a `due` that
// isn't a whole-ms instant, or a repeat that isn't one of REPEATS.
export function setReminder(todos, id, due, repeat) {
  const todo = todos.find((item) => item.id === id);
  const reminder = normalizeReminder({ due, repeat });
  if (!todo || reminder.due === null || reminder.due !== due || reminder.repeat !== repeat) return todos;
  return todos.map((item) => (item === todo ? { ...item, due, repeat, notified: null } : item));
}

// Returns `todos` itself for an unknown id.
export function clearReminder(todos, id) {
  if (!todos.some((todo) => todo.id === id)) return todos;
  return todos.map((todo) => (todo.id === id ? { ...todo, due: null, repeat: 'none', notified: null } : todo));
}

// Records that each listed todo's current occurrence has been alerted.
export function markNotified(todos, ids) {
  const marked = new Set(ids);
  return todos.map((todo) =>
    marked.has(todo.id) && typeof todo.due === 'number' ? { ...todo, notified: todo.due } : todo,
  );
}

// Todos to alert now: overdue and this occurrence not alerted yet, most overdue first.
export function dueReminders(todos, now) {
  return sortByUrgency(
    todos.filter((todo) => isOverdue(todo, now) && todo.notified !== todo.due),
    now,
  );
}

// When to recheck the list: a timed completion expiring or an un-alerted reminder coming due.
export function nextFireTime(todos, now) {
  let next = null;
  for (const todo of todos) {
    const time = isCompleted(todo, now)
      ? todo.completedUntil
      : todo.notified === todo.due ? null : todo.due;
    if (typeof time === 'number' && time > now && (next === null || time < next)) next = time;
  }
  return next;
}

// View order: overdue todos first, most overdue on top; everything else keeps its order.
// Stable (ties keep their order) and never reorders the input.
export function sortByUrgency(todos, now) {
  const overdue = todos.filter((todo) => isOverdue(todo, now)).sort((a, b) => a.due - b.due);
  return [...overdue, ...todos.filter((todo) => !isOverdue(todo, now))];
}
