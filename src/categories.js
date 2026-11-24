// Category rules the page shares: the list filter, name input and what a failed write means to
// the user. The catalog itself lives in src/sync.js.

// The filter: every task, tasks with no category, or one category's ID.
export const ALL = 'all';
export const UNCATEGORIZED = 'none';

export const MAX_CATEGORIES = 50;
export const MAX_NAME_LENGTH = 48;

export function filterByCategory(todos, filter) {
  if (filter === ALL) return todos;
  const id = filter === UNCATEGORIZED ? null : filter;
  return todos.filter((todo) => (todo.categoryId ?? null) === id);
}

// The filter after the catalog changed. A category that is gone (deleted here or elsewhere), or
// a missing catalog, falls back to All.
export function keepFilter(filter, categories) {
  if (filter === ALL || !categories) return ALL;
  if (filter === UNCATEGORIZED) return filter;
  return categories.some((category) => category.id === filter) ? filter : ALL;
}

// The server's name rule (server/category-input.js): trimmed, 1 to 48 code points, no control
// characters. Case is kept.
export function readCategoryName(raw) {
  const name = raw.trim();
  const length = [...name].length;
  if (length === 0) return { name, error: 'empty' };
  if (length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) return { name, error: 'invalid' };
  return { name, error: null };
}

export const NAME_MESSAGES = {
  empty: 'Enter a category name.',
  invalid: `Use 1 to ${MAX_NAME_LENGTH} characters for the name.`,
  taken: 'A category with that name already exists.',
};

// What to tell the user about a failed category write. `reloaded`: the snapshot was reloaded
// after it, so the list on screen is the server's.
export function categoryErrorText(error, reloaded) {
  const fresh = reloaded ? ' The list is up to date now.' : '';
  switch (error?.code) {
    case 'CATEGORY_LIMIT':
      return `You can have up to ${MAX_CATEGORIES} categories. Delete one to add another.`;
    case 'DUPLICATE_NAME':
      return error.message || NAME_MESSAGES.taken;
    case 'REVISION_CONFLICT':
    case 'NOT_FOUND':
      return `This category changed in another tab or device.${fresh} Try again if needed.`;
    default:
      if (error?.status === 400) return NAME_MESSAGES.invalid;
      return `Couldn't save the category.${fresh} Check your connection and try again.`;
  }
}
