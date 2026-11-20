import { isOverdue, normalizeReminder, REPEATS } from '../src/reminders.js';
import { MAX_TAGS, normalizeTag, normalizeTags } from '../src/tags.js';
import { addTag, clearReminder, markNotified, removeTag, setReminder } from '../src/todos.js';
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

function readTag(raw) {
  const tag = normalizeTag(raw);
  if (tag === null || tag.includes('\0')) throw invalid('Provide a valid tag.');
  return tag;
}

export function createInput(body) {
  checkFields(body, ['id', 'text', 'tags']);
  const id = readId(body.id);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.includes('\0') || [...text].length > 2000) {
    throw invalid('Enter a title of 1 to 2,000 characters.');
  }
  if (!Array.isArray(body.tags)) throw invalid('Provide a list of tags.');
  if (new Set(body.tags.map(readTag)).size > MAX_TAGS) throw invalid('Use at most 10 tags.');
  return { id, text, tags: normalizeTags(body.tags) };
}

function readDue(value) {
  const { due } = normalizeReminder({ due: value });
  if (due === null) throw invalid('Provide a valid reminder time.');
  return due;
}

function complete(todo, { completed, due }) {
  if (typeof completed !== 'boolean') throw invalid('Provide a completion state.');
  if (due !== null) readDue(due);
  if (completed === !todo.completed && due === todo.due) return { ...todo, completed };
  if (!todo.completed && !completed && todo.repeat !== 'none' && todo.due !== null &&
      due !== null && due > todo.due) {
    return { ...todo, due, notified: null };
  }
  throw invalid('Invalid completion or reminder change.');
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
    case 'clearReminder':
      checkFields(body, base);
      return todo.due === null ? todo : clearReminder(items, id)[0];
    case 'complete':
      checkFields(body, [...base, 'completed', 'due']);
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
