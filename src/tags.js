// Tags are no longer a user concept. The server still reads them from older clients and folds
// them into the title (server/todo-input.js), and their colors live on as category colors.
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 24;

// Number of color slots in styles.css ([data-color="0"] ... [data-color="7"]).
// Changing it, or the hash below, recolors every tag for everyone.
export const PALETTE_SIZE = 8;

// Idempotent: normalizing a normalized tag gives it back, so load() never changes saved tags.
// A tag can't start with "#" once one is stripped ("##work" is invalid, not "#work").
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-');
  const length = [...tag].length;
  return length === 0 || length > MAX_TAG_LENGTH || tag.startsWith('#') ? null : tag;
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

// FNV-1a 32-bit hash of the tag's UTF-8 bytes, mod PALETTE_SIZE.
export function tagColor(tag) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(tag)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash % PALETTE_SIZE;
}

// A category's card and sheet color: its name hashed like a tag, so a category converted from a
// task's first tag (migration 0006) keeps the color that tag had.
export function categoryColor(name) {
  return tagColor(name.trim().toLowerCase().replace(/\s+/g, '-'));
}
