// One category per task. A category is a short lowercase word or phrase ("work", "side-project"),
// typed as "#work" in a new task or picked in the task sheet. Each one gets a fixed color.
export const MAX_CATEGORY_LENGTH = 24;

// Number of color slots in styles.css ([data-color="0"] ... [data-color="7"]).
// Changing it, or the hash below, recolors every category for everyone.
export const PALETTE_SIZE = 8;

// "#word" at the start of the input or after whitespace, so "C#" and "email#1" are not categories.
const TOKEN = /(^|\s)#([^\s#]+)/g;

// Idempotent: normalizing a normalized category gives it back. A category can't start with "#"
// once one is stripped ("##work" is invalid, not "#work").
export function normalizeCategory(raw) {
  if (typeof raw !== 'string') return null;
  const category = raw.trim().replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-');
  const length = [...category].length;
  return length === 0 || length > MAX_CATEGORY_LENGTH || category.startsWith('#') || category.includes('\0')
    ? null
    : category;
}

// Pulls the category out of new-task text. The first valid "#word" sets it (over `baseCategory`,
// the selected shelf) and is taken out; any later "#word" stays in the title as plain text.
export function parseTodoInput(raw, baseCategory = null) {
  let category = baseCategory === null ? null : normalizeCategory(baseCategory);
  let taken = false;
  const text = raw
    .replace(TOKEN, (token, before, body) => {
      if (taken) return token;
      const parsed = normalizeCategory(body);
      if (parsed === null) return token;
      category = parsed;
      taken = true;
      return before;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, category };
}

// FNV-1a 32-bit hash of the category's UTF-8 bytes, mod PALETTE_SIZE. The same hash the tags
// used, so a task keeps the color its first tag had.
export function categoryColor(category) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(category)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash % PALETTE_SIZE;
}
