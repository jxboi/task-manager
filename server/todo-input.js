import { isCompleted, isOverdue, normalizeReminder, REPEATS } from '../src/reminders.js';
import { MAX_TAGS, normalizeTag, normalizeTags } from '../src/tags.js';
import { addTag, clearReminder, editTodo, markNotified, removeTag, setReminder, validText } from '../src/todos.js';
import { invalid, RequestError } from './http.js';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid('Provide a valid todo ID.');
  return value.toLowerCase();
}

export function readCategoryId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid('Provide a valid category ID.');
  return value.toLowerCase();
}

// An edit's optional category: undefined when omitted (keep the link), null to clear, else the ID.
function readEditCategory(body) {
  if (body.action !== 'edit' || !Object.hasOwn(body, 'categoryId')) return undefined;
  return body.categoryId === null ? null : readCategoryId(body.categoryId);
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

function readTag(raw) {
  const tag = normalizeTag(raw);
  if (tag === null || tag.includes('\0')) throw invalid('Provide a valid tag.');
  return tag;
}

export function createInput(body) {
  checkFields(body, ['id', 'text', 'tags']);
  const id = readId(body.id);
  return { id, text: readText(body.text), tags: readTags(body.tags) };
}

// Create and edit share these, so a title or tag list one accepts the other does too.
function readText(value) {
  if (!validText(value)) throw invalid('Enter a title of 1 to 2,000 characters.');
  return value.trim();
}

// Tags are optional: only older clients still send them.
function readTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('Provide a list of tags.');
  if (new Set(value.map(readTag)).size > MAX_TAGS) throw invalid('Use at most 10 tags.');
  return normalizeTags(value);
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

// The whole editable state at once: title, tags, reminder (`due` null for none) and,
// optionally, the category. Omitting `categoryId` keeps the current link. Validates everything
// without touching the database, so callers can reject a bad edit before taking any lock.
export function readEdit(body) {
  checkFields(body, ['action', 'revision', 'text', 'tags', 'due', 'repeat', 'categoryId']);
  const text = readText(body.text);
  const tags = readTags(body.tags);
  const due = body.due === null ? null : readDue(body.due);
  if (!REPEATS.includes(body.repeat) || (due === null && body.repeat !== 'none')) {
    throw invalid('Provide a valid repeat setting.');
  }
  return { text, tags, due, repeat: body.repeat, categoryId: readEditCategory(body) };
}

export function patchTodo(todo, body) {
  const items = [todo];
  const id = todo.id;
  const base = ['action', 'revision'];

  switch (body.action) {
    case 'addTag': {
      checkFields(body, [...base, 'tag']);
      const tag = readTag(body.tag);
      if (!todo.tags.includes(tag) && todo.tags.length >= MAX_TAGS) {
        throw invalid('Use at most 10 tags.');
      }
      return addTag(items, id, tag)[0];
    }
    case 'removeTag':
      checkFields(body, [...base, 'tag']);
      return removeTag(items, id, readTag(body.tag))[0];
    case 'setReminder': {
      checkFields(body, [...base, 'due', 'repeat']);
      const due = readDue(body.due);
      if (!REPEATS.includes(body.repeat)) throw invalid('Provide a valid repeat setting.');
      if (todo.due === due && todo.repeat === body.repeat && todo.notified === null) return todo;
      return setReminder(items, id, due, body.repeat)[0];
    }
    case 'edit': {
      const { categoryId, ...fields } = readEdit(body);
      const edited = editTodo(items, id, fields)[0];
      return categoryId === undefined || categoryId === todo.categoryId ? edited : { ...edited, categoryId };
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
