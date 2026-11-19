export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 24;

// Number of color slots in styles.css ([data-color="0"] ... [data-color="7"]).
// Changing it, or the hash below, recolors every tag for everyone.
export const PALETTE_SIZE = 8;

// "#tag" at the start of the input or after whitespace, so "C#" and "email#1" are not tags.
const TOKEN = /(^|\s)#([^\s#]+)/g;

export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-');
  const length = [...tag].length;
  return length === 0 || length > MAX_TAG_LENGTH ? null : tag;
}

// Normalizes a list of tags: invalid ones and duplicates dropped, first MAX_TAGS kept.
export function normalizeTags(list) {
  const tags = [];
  for (const raw of list) {
    const tag = normalizeTag(raw);
    if (tag !== null && !tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
  }
  return tags;
}

// Pulls "#tags" out of new-todo text. `baseTags` (the active filter) come first and count
// toward the cap; tokens that are invalid or don't fit stay in the text as plain words.
export function parseTodoInput(raw, baseTags = []) {
  const tags = normalizeTags(baseTags);
  const text = raw
    .replace(TOKEN, (token, before, body) => {
      const tag = normalizeTag(body);
      if (tag === null) return token;
      if (tags.includes(tag)) return before;
      if (tags.length >= MAX_TAGS) return token;
      tags.push(tag);
      return before;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, tags };
}

// FNV-1a 32-bit hash of the tag's UTF-8 bytes, mod PALETTE_SIZE.
export function tagColor(tag) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(tag)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash % PALETTE_SIZE;
}
