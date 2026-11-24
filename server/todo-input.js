import { isCompleted, isOverdue, normalizeReminder, REPEATS } from '../src/reminders.js';
import { normalizeCategory } from '../src/categories.js';
import { clearReminder, editTodo, markNotified, setReminder, validText } from '../src/todos.js';
import { invalid, RequestError } from './http.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid('Provide a valid todo ID.');
  return value.toLowerCase();
}

export function readRevision(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw invalid('Provide a valid revision.');
  }
  return value;
}

function checkFields(body, fields) {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw invalid('Unexpected field.');
}

export function readMove(body, id) {
  checkFields(body, ['action', 'revision', 'anchorId', 'side']);
  const anchorId = readId(body.anchorId);
  if (anchorId === id) throw invalid('Choose a different todo to move relative to.');
  if (body.side !== 'before' && body.side !== 'after') throw invalid('Choose before or after.');
  return { anchorId, side: body.side };
}

// A category, or null for none.
function readCategory(value) {
  if (value === null) return null;
  const category = normalizeCategory(value);
  if (category === null) throw invalid('Provide a valid category.');
  return category;
}

// Before categories a task had a list of tags. A tab still running that version sends `tags`;
// the first one becomes the category, and the rest are dropped.
function readLegacyTags(value) {
  if (!Array.isArray(value) || value.length > 10) throw invalid('Provide a list of tags.');
  const [first = null] = value.map(readCategory);
  return first;
}

// The category a create or edit body gives: `category`, or the legacy `tags`, never both.
// A create may leave both out (no category); an edit, which sends the whole state, may not.
function readBodyCategory(body, required = false) {
  if ('category' in body && 'tags' in body) throw invalid('Send a category or tags, not both.');
  if ('category' in body) return readCategory(body.category);
  if ('tags' in body) return readLegacyTags(body.tags);
  if (required) throw invalid('Provide a category.');
  return null;
}

export function createInput(body) {
  checkFields(body, ['id', 'text', 'category', 'tags']);
  const id = readId(body.id);
  return { id, text: readText(body.text), category: readBodyCategory(body) };
}

// Create and edit share this, so a title one accepts the other does too.
function readText(value) {
  if (!validText(value)) throw invalid('Enter a title of 1 to 2,000 characters.');
  return value.trim();
}

function readDue(value) {
  const { due } = normalizeReminder({ due: value });
  if (due === null) throw invalid('Provide a valid reminder time.');
  return due;
}

function complete(todo, { completed, due, completedUntil = null }) {
  if (typeof completed !== 'boolean') throw invalid('Provide a completion state.');
  if (due !== null) readDue(due);
  if (completed !== isCompleted(todo, Date.now())) {
    if (completedUntil === null && due === todo.due) return { ...todo, completed, completedUntil };
    if (completed && todo.repeat !== 'none' && todo.due !== null &&
        due !== null && due >= todo.due && completedUntil !== null && readDue(completedUntil) <= due) {
      return { ...todo, completed, completedUntil, due, notified: due === todo.due ? todo.notified : null };
    }
  }
  throw invalid('Invalid completion or reminder change.');
}

export function patchTodo(todo, body) {
  const items = [todo];
  const id = todo.id;
  const base = ['action', 'revision'];

  switch (body.action) {
    // Legacy tag actions from a tab still running the tags version: adding a tag sets the
    // category; removing the category's tag clears it.
    case 'addTag': {
      checkFields(body, [...base, 'tag']);
      const category = readCategory(body.tag);
      return category === todo.category ? todo : { ...todo, category };
    }
    case 'removeTag': {
      checkFields(body, [...base, 'tag']);
      return readCategory(body.tag) === todo.category ? { ...todo, category: null } : todo;
    }
    case 'setReminder': {
      checkFields(body, [...base, 'due', 'repeat']);
      const due = readDue(body.due);
      if (!REPEATS.includes(body.repeat)) throw invalid('Provide a valid repeat setting.');
      if (todo.due === due && todo.repeat === body.repeat && todo.notified === null) return todo;
      return setReminder(items, id, due, body.repeat)[0];
    }
    case 'edit': {
      // The whole editable state at once: title, category and reminder (`due` null for none).
      checkFields(body, [...base, 'text', 'category', 'tags', 'due', 'repeat']);
      const text = readText(body.text);
      const category = readBodyCategory(body, true);
      const due = body.due === null ? null : readDue(body.due);
      if (!REPEATS.includes(body.repeat) || (due === null && body.repeat !== 'none')) {
        throw invalid('Provide a valid repeat setting.');
      }
      return editTodo(items, id, { text, category, due, repeat: body.repeat })[0];
    }
    case 'clearReminder':
      checkFields(body, base);
      return todo.due === null ? todo : clearReminder(items, id)[0];
    case 'complete':
      checkFields(body, [...base, 'completed', 'due', 'completedUntil']);
      return complete(todo, body);
    case 'markNotified':
      checkFields(body, [...base, 'due']);
      if (readDue(body.due) !== todo.due || !isOverdue(todo, Date.now()) || todo.notified === todo.due) {
        throw new RequestError(409, 'REMINDER_CONFLICT', 'This reminder can no longer be claimed.');
      }
      return markNotified(items, [id])[0];
    default:
      throw invalid('Provide a valid todo action.');
  }
}
