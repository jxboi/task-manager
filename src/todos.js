import { normalizeCategory } from './categories.js';
import { isCompleted, isOverdue, nextReminderAfterToday, normalizeReminder } from './reminders.js';

// The title rule the server enforces too: 1 to 2,000 characters once trimmed, and no NUL.
export const MAX_TEXT_LENGTH = 2000;

export function validText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed !== '' && !trimmed.includes('\0') && [...trimmed].length <= MAX_TEXT_LENGTH;
}

export function addTodo(todos, text, category = null) {
  const trimmed = text.trim();
  if (trimmed === '') return todos;
  return [
    ...todos,
    {
      id: crypto.randomUUID(),
      text: trimmed,
      completed: false,
      createdAt: Date.now(),
      category: category === null ? null : normalizeCategory(category),
      due: null,
      repeat: 'none',
      notified: null,
    },
  ];
}

const SLOT_WIDTH = 20;
const TIMESTAMP_OFFSET = 9223372036854775808n;
const HEX = '0123456789abcdef';
const suffixFor = (id) => `8${id.replaceAll('-', '')}8`;
const timestampSlot = (createdAt) => BigInt(createdAt) + TIMESTAMP_OFFSET;
const slotKey = (slot) => String(slot).padStart(SLOT_WIDTH, '0');
const positionOf = (todo) => todo.position ?? slotKey(timestampSlot(todo.createdAt)) + suffixFor(todo.id);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function sortByPosition(todos) {
  return [...todos].sort((a, b) =>
    compare(positionOf(a), positionOf(b)) || a.createdAt - b.createdAt || compare(a.id, b.id),
  );
}

// Optimistic creates append even when the server's tail is ahead of the browser clock.
export function appendTodo(todos, todo) {
  const last = todos.at(-1);
  if (!last || compare(positionOf(last), positionOf(todo)) < 0) return [...todos, todo];
  const nextSlot = BigInt(positionOf(last).slice(0, SLOT_WIDTH)) + 1n;
  return [...todos, { ...todo, position: slotKey(nextSlot) + suffixFor(todo.id) }];
}

// Find a prefix strictly between two hexadecimal fractions. A missing lower digit is 0.
// When the upper bound is absent, it is 1 (one past the largest fractional digit).
// Stored fractions end in a nonzero digit, so extending the prefix can always open a gap.
function between(lower, upper) {
  let prefix = '';
  for (let i = 0; ; i++) {
    const low = i < lower.length ? HEX.indexOf(lower[i]) : 0;
    const high = upper === null ? HEX.length : HEX.indexOf(upper[i]);
    if (high - low > 1) return prefix + HEX[Math.floor((low + high) / 2)];
    prefix += HEX[low];
    if (low < high) upper = null;
  }
}

// Slice 2: pass the full position-ordered list, two visible IDs, 'before' or 'after', and the
// active category filter (null for All). Only the moved row changes. Reminder urgency still determines view groups.
export function moveTodo(todos, id, anchorId, side, activeCategory = null) {
  if (id === anchorId || (side !== 'before' && side !== 'after')) return todos;
  const visible = filterByCategory(todos, activeCategory);
  const from = visible.findIndex((todo) => todo.id === id);
  const anchor = visible.findIndex((todo) => todo.id === anchorId);
  const offset = side === 'before' ? 0 : 1;
  if (from < 0 || anchor < 0 || (side === 'before' ? from + 1 === anchor : from - 1 === anchor)) return todos;

  const moved = visible[from];
  const next = todos.filter((todo) => todo !== moved);
  let index = next.indexOf(visible[anchor]) + offset;
  const anchorPosition = positionOf(visible[anchor]);
  // Imported ties have no gap between them. Place the task on the requested side
  // of the tied rows, which retain their existing order.
  if (side === 'before') {
    while (index > 0 && positionOf(next[index - 1]) === anchorPosition) index--;
  } else {
    while (index < next.length && positionOf(next[index]) === anchorPosition) index++;
  }
  const left = index > 0 ? positionOf(next[index - 1]) : null;
  const right = index < next.length ? positionOf(next[index]) : null;
  // Pick a slot already in use so an append can always take the next whole slot.
  const slot = (left ?? right).slice(0, SLOT_WIDTH);
  const lower = left?.slice(SLOT_WIDTH) ?? '';
  const upper = right?.startsWith(slot) ? right.slice(SLOT_WIDTH) : null;
  const position = slot + between(lower, upper) + suffixFor(id);
  next.splice(index, 0, { ...moved, position });
  return next;
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

// Every category in use with the number of todos in it, A to Z.
export function allCategories(todos) {
  const counts = new Map();
  for (const { category } of todos) {
    if (category != null) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((category) => ({ category, count: counts.get(category) }));
}

// The todos in `category`; null means every todo.
export function filterByCategory(todos, category) {
  return category === null ? todos : todos.filter((todo) => todo.category === category);
}

// Replaces the reminder and re-arms it. Returns `todos` itself for an unknown id, a `due` that
// isn't a whole-ms instant, or a repeat that isn't one of REPEATS.
export function setReminder(todos, id, due, repeat) {
  const todo = todos.find((item) => item.id === id);
  const reminder = normalizeReminder({ due, repeat });
  if (!todo || reminder.due === null || reminder.due !== due || reminder.repeat !== repeat) return todos;
  return todos.map((item) => (item === todo ? { ...item, due, repeat, notified: null } : item));
}

// Replaces the text, category and reminder in one change (the edit form). `due` null means no
// reminder (then `repeat` must be 'none'). The reminder re-arms only if its time changes (a repeat
// change alone keeps the claim on the same occurrence), so it doesn't alert again. Today's tick
// keeps its expiration while the task repeats and becomes permanent if repetition stops.
// Returns `todos` itself for an unknown id, invalid fields, or when nothing changes.
export function editTodo(todos, id, { text, category, due, repeat } = {}) {
  const todo = todos.find((item) => item.id === id);
  if (!todo || !validText(text)) return todos;
  if (category !== null && normalizeCategory(category) !== category) return todos;
  const reminder = normalizeReminder({ due, repeat });
  if (reminder.due !== due || reminder.repeat !== repeat) return todos;
  const next = {
    ...todo,
    text: text.trim(),
    category,
    due: reminder.due,
    repeat: reminder.repeat,
    notified: reminder.due === todo.due ? todo.notified : null,
  };
  if (reminder.repeat === 'none' && todo.completedUntil != null) next.completedUntil = null;
  const same = next.text === todo.text && next.due === todo.due && next.repeat === todo.repeat &&
    next.completedUntil === todo.completedUntil && next.notified === todo.notified &&
    next.category === (todo.category ?? null);
  return same ? todos : todos.map((item) => (item === todo ? next : item));
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
