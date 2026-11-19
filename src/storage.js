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

export function load() {
  try {
    const raw = globalThis.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTodo) : [];
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
