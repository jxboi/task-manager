// The title rule shared by the add field and the edit form: the same check the server makes
// (validText). A "#" is ordinary title text.
import { validText } from './todos.js';

// `error`: null, 'empty' or 'invalid' (too long, or NUL).
export function readTaskInput(raw) {
  const text = raw.trim();
  const error = text === '' ? 'empty' : validText(text) ? null : 'invalid';
  return { text, error };
}
