import { invalid } from './http.js';
import { readCategoryId, readRevision } from './todo-input.js';

export { readCategoryId };

export const MAX_CATEGORIES = 50;
export const MAX_NAME_LENGTH = 48;

function checkFields(body, fields) {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw invalid('Unexpected field.');
}

// Trimmed, no control characters, 1 to 48 code points. Display case is kept.
export function readName(value) {
  const name = typeof value === 'string' && value.isWellFormed() ? value.trim() : '';
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw invalid(`Enter a category name of 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

export function readQueryRevision(value) {
  if (!/^[1-9]\d*$/.test(value ?? '')) throw invalid('Provide a valid revision.');
  return readRevision(Number(value));
}

export function createCategoryInput(body) {
  checkFields(body, ['id', 'name']);
  return { id: readCategoryId(body.id), name: readName(body.name) };
}

export function renameCategoryInput(body) {
  checkFields(body, ['name', 'revision']);
  return { name: readName(body.name), revision: readRevision(body.revision) };
}
