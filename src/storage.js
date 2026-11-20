import { normalizeTags } from './tags.js';
import { normalizeReminder } from './reminders.js';

const KEY = 'task-manager.todos.v1';

function isTodo(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    value.text.trim() !== '' &&
    typeof value.completed === 'boolean' &&
    typeof value.createdAt === 'number'
  );
}

// Todos saved before tags existed have no `tags`; their text is left as is, never re-parsed.
function withTags(todo) {
  return { ...todo, tags: Array.isArray(todo.tags) ? normalizeTags(todo.tags) : [] };
}

// Todos saved before reminders existed get no reminder; junk reminder fields are dropped.
function withReminder(todo) {
  return { ...todo, ...normalizeReminder(todo) };
}

export function load() {
  try {
    const raw = globalThis.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTodo).map(withTags).map(withReminder) : [];
  } catch {
    return [];
  }
}

export function save(todos) {
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(todos));
  } catch {
    // Storage full or unavailable: keep working in memory for this session.
  }
}
