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

// What the edit form saves. The title field holds only the title, and the task's tags are kept as
// data (`draftTags`), never re-read from text, so any tag value survives. An untouched title is
// kept as it is (a saved "Review #42" is not turned into a tag); an edited one is read like the add
// field, so a typed "#tag" is added after the existing ones.
export function readTaskEdit(raw, openedText, draftTags) {
  if (raw === openedText) return { text: openedText, tags: draftTags, error: validText(openedText) ? null : 'invalid' };
  return readTaskInput(raw, draftTags);
}
