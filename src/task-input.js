// The add form's input rules, shared with the edit form: "#tags" are pulled out of the text the
// same way (parseTodoInput) and the title must pass the same check the server makes (validText).
import { parseTodoInput } from './tags.js';
import { validText } from './todos.js';

// `error`: null, 'empty' (no title left once tags are taken out) or 'invalid' (too long, or NUL).
export function readTaskInput(raw, baseTags = []) {
  const { text, tags } = parseTodoInput(raw, baseTags);
  const error = text === '' ? 'empty' : validText(text) ? null : 'invalid';
  return { text, tags, error };
}

// The edit field's starting value: the title, then its tags as "#tag" words, so reading it back
// with readTaskInput gives the same task.
export function formatTaskInput({ text, tags }) {
  return [text, ...tags.map((tag) => `#${tag}`)].join(' ');
}
