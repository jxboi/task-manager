// Static attributes of an element in index.html, by id (the DOM stub in dom.js doesn't load them).
import { readFileSync } from 'node:fs';

const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

export function markupAttributes(id) {
  const tag = markup.match(new RegExp(`<\\w+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`No element #${id} in index.html`);
  return Object.fromEntries(Array.from(tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)).slice(1).map(([, name, value = '']) => [name, value]));
}
