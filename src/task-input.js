// The add and edit fields' input rules: a "#category" is pulled out of the text the same way
// (parseTodoInput) and the title must pass the same check the server makes (validText).
import { parseTodoInput } from './categories.js';
import { validText } from './todos.js';

// `error`: null, 'empty' (no title left once the category is taken out) or 'invalid' (too long,
// or NUL).
export function readTaskInput(raw, baseCategory = null) {
  const { text, category } = parseTodoInput(raw, baseCategory);
  const error = text === '' ? 'empty' : validText(text) ? null : 'invalid';
  return { text, category, error };
}

// What the edit form saves. The category is picked in the sheet (`draftCategory`), never re-read
// from an untouched title, so a saved "Review #42" stays as it is; an edited title is read like
// the add field, so a typed "#category" replaces the picked one.
export function readTaskEdit(raw, openedText, draftCategory) {
  if (raw === openedText) {
    return { text: openedText, category: draftCategory, error: validText(openedText) ? null : 'invalid' };
  }
  return readTaskInput(raw, draftCategory);
}
