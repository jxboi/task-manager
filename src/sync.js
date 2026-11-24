// The signed-in task list and category catalog as the server has them, plus local todo changes
// still on their way there.
// Every request goes through one queue, so writes reach the server in the order they were made and
// each one uses the revision the previous one returned. The view (`todos`) is the confirmed rows
// with the pending changes applied on top, so the page updates at once. A change the server
// rejects drops out of the view again. Category changes are not optimistic: they wait for the
// server's answer, in the same queue. reset() starts a new session: anything still in flight
// from the old one is ignored when it settles.
import {
  appendTodo,
  clearReminder,
  editTodo,
  moveTodo,
  removeTodo,
  setReminder,
  sortByPosition,
  toggleTodo,
} from './todos.js';
import { isOverdue } from './reminders.js';

const replace = (todos, row) => todos.map((todo) => (todo.id === row.id ? row : todo));
const isStale = (error) => error?.code === 'STALE_SESSION';
// The server's copy changed or is gone: reload before anything else.
const needsReload = (error) => error?.status === 409 || error?.status === 404;
// No answer, or a server error: the write may or may not have landed.
const isUncertain = (error) => error?.status === 0 || error?.status >= 500;

// Alphabetical by name for this browser's language, then by ID, so the list and the selects
// always agree.
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const sortCategories = (list) => [...list].sort((a, b) =>
  collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// `seenRevision(id)` is the revision of the row the user is looking at when a change is made (the
// page passes what it has rendered). Defaults to the row in the current view.
export function createSync(api, { onChange = () => {}, seenRevision } = {}) {
  let confirmed = [];
  // [{id, name, revision}], or null before a load and when the server sent no catalog.
  let categories = null;
  let pending = [];
  let view = [];
  let generation = 0;
  let queue = Promise.resolve();
  let loaded = false;
  // A server result that may include remote changes sets the oldest revision an edit may have seen.
  // Successful local writes may advance the row without invalidating other queued edits.
  const refreshedAt = new Map();

  function changed() {
    view = pending.reduce((todos, entry) => entry.apply(todos), confirmed);
    onChange();
  }

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  function trackRefresh(previous, row) {
    if (previous?.revision !== row.revision || previous?.createdAt !== row.createdAt) {
      refreshedAt.set(row.id, row.revision);
    }
  }

  async function reloadNow(gen) {
    const { todos, categories: catalog } = await api.readSnapshot();
    if (gen !== generation) return false;
    const previous = new Map(confirmed.map((todo) => [todo.id, todo]));
    const current = new Set(todos.map((todo) => todo.id));
    for (const id of refreshedAt.keys()) {
      if (!current.has(id)) refreshedAt.delete(id);
    }
    for (const todo of todos) trackRefresh(previous.get(todo.id), todo);
    confirmed = todos;
    categories = catalog && sortCategories(catalog);
    loaded = true;
    changed();
    return true;
  }

  // One write. `apply` is the optimistic change (omitted for claims); `send` gets the confirmed row
  // (or null for a create) and resolves to the server's row (or null after a delete).
  // `holds(row)`, if given, is the change's assumption about the confirmed row when its turn comes;
  // if it no longer holds (another tab changed the row), the change is refused as a conflict.
  function write({ id, apply, send, needsRow = true, commit, holds }) {
    const gen = generation;
    const seen = needsRow
      ? (seenRevision ? seenRevision(id) : view.find((todo) => todo.id === id)?.revision)
      : undefined;
    const entry = apply && { apply };
    if (entry) {
      pending.push(entry);
      changed();
    }
    const settle = () => {
      if (entry) pending = pending.filter((item) => item !== entry);
    };
    return enqueue(async () => {
      if (gen !== generation) return { ok: false, stale: true };
      const row = confirmed.find((todo) => todo.id === id) ?? null;
      if (needsRow && !row) {
        settle();
        changed();
        return { ok: false, skipped: true };
      }
      const refreshed = refreshedAt.get(id);
      if (needsRow && refreshed !== undefined && !(seen >= refreshed && seen <= row.revision)) {
        settle();
        changed();
        return { ok: false, cancelled: true };
      }
      if (holds && !holds(row)) {
        settle();
        const reloaded = await reloadNow(gen).catch(() => false);
        if (gen !== generation) return { ok: false, stale: true };
        if (!reloaded) changed();
        return { ok: false, error: { status: 409, code: 'STALE_CHANGE' }, reloaded, revision: row.revision };
      }
      try {
        const result = await send(row);
        if (gen !== generation) return { ok: false, stale: true };
        settle();
        confirmed = commit(confirmed, result);
        if (!needsRow || !result) refreshedAt.delete(id);
        changed();
        return { ok: true, todo: result };
      } catch (error) {
        if (gen !== generation || isStale(error)) return { ok: false, stale: true };
        settle();
        changed();
        const reloaded = needsReload(error) ? await reloadNow(gen).catch(() => false) : false;
        if (gen !== generation) return { ok: false, stale: true };
        // `revision`: the row this change was sent against, so a retry can tell whether anything
        // (this change, or another tab) has touched the row since.
        return { ok: false, error, reloaded, revision: row?.revision ?? null };
      }
    });
  }

  function patch(id, apply, action, fields, holds) {
    return write({
      id,
      apply,
      holds,
      send: (row) => api.patchTodo(id, row.revision, action, typeof fields === 'function' ? fields(row) : fields),
      commit: replace,
    });
  }

  // One category write, after everything queued before it. `send` resolves to the server's
  // answer and `commit` applies it, returning true when a snapshot is needed. A stale or missing
  // row (409, 404) or an uncertain failure
  // reloads the snapshot before the caller offers anything else, so a retry starts from the
  // server's catalog and a stale rename is never replayed.
  function categoryWrite(send, commit) {
    const gen = generation;
    return enqueue(async () => {
      if (gen !== generation) return { ok: false, stale: true };
      try {
        const result = await send(gen);
        if (gen !== generation) return { ok: false, stale: true };
        const reconcile = commit(result);
        changed();
        if (reconcile) await reloadNow(gen).catch(() => false);
        if (gen !== generation) return { ok: false, stale: true };
        return { ok: true };
      } catch (error) {
        if (gen !== generation || isStale(error)) return { ok: false, stale: true };
        const reload = needsReload(error) || isUncertain(error);
        const reloaded = reload ? await reloadNow(gen).catch(() => false) : false;
        if (gen !== generation) return { ok: false, stale: true };
        return { ok: false, error, reloaded };
      }
    });
  }

  const revisionOf = (id) => categories?.find((category) => category.id === id)?.revision;
  const putCategory = (category) => {
    categories = sortCategories([...(categories ?? []).filter((item) => item.id !== category.id), category]);
  };

  return {
    get todos() {
      return view;
    },
    get confirmed() {
      return confirmed;
    },
    get categories() {
      return categories;
    },
    get loaded() {
      return loaded;
    },
    get busy() {
      return pending.length > 0;
    },

    reset() {
      generation++;
      refreshedAt.clear();
      confirmed = [];
      categories = null;
      pending = [];
      view = [];
      loaded = false;
      queue = Promise.resolve();
    },

    // Replaces the confirmed rows with the server's list, after any queued writes.
    load() {
      const gen = generation;
      return enqueue(async () => {
        if (gen !== generation) return { ok: false, stale: true };
        try {
          return (await reloadNow(gen)) ? { ok: true } : { ok: false, stale: true };
        } catch (error) {
          if (gen !== generation || isStale(error)) return { ok: false, stale: true };
          return { ok: false, error };
        }
      });
    },

    // `todo` is the full local row from addTodo(); a retry passes the same row (same UUID).
    // A 409 for that UUID means an earlier, uncertain attempt was saved: the reload shows it.
    async create(todo) {
      const result = await write({
        id: todo.id,
        needsRow: false,
        apply: (todos) => (todos.some((item) => item.id === todo.id) ? todos : appendTodo(todos, todo)),
        send: () => api.createTodo(todo),
        commit: (todos, row) => {
          const next = [...todos.filter((item) => item.id !== row.id), row];
          return row.position == null ? next : sortByPosition(next);
        },
      });
      if (!result.ok && result.error?.code === 'DUPLICATE_ID' && result.reloaded &&
          confirmed.some((item) => item.id === todo.id)) {
        return { ok: true, todo: confirmed.find((item) => item.id === todo.id), reconciled: true };
      }
      return result;
    },

    // Moves a task before or after another one in the whole list. The result follows the normal
    // write contract. An unchanged move resolves with skipped.
    move(id, anchorId, side) {
      const apply = (todos) => moveTodo(todos, id, anchorId, side);
      if (apply(view) === view) return Promise.resolve({ ok: false, skipped: true });
      return write({
        id,
        apply,
        send: (row) => {
          if (confirmed.some((todo) => todo.id === anchorId) && apply(confirmed) === confirmed) return row;
          return api.patchTodo(id, row.revision, 'move', { anchorId, side });
        },
        commit: (todos, row) => sortByPosition(replace(todos, row)),
      });
    },

    // The browser works out the next occurrence of a repeating todo in its own zone; the server
    // checks the transition.
    // `before` is the row as shown when it was clicked: completing is only sent if the server's row
    // is still in that state, so a queued click can't undo another tab's completion.
    toggle(id, now, before) {
      return patch(id, (todos) => toggleTodo(todos, id, now), 'complete', (row) => {
        const after = toggleTodo([row], id, now)[0];
        return { completed: after.completed, due: after.due, completedUntil: after.completedUntil ?? undefined };
      }, before && ((row) => row.completed === before.completed && row.due === before.due &&
        (row.completedUntil ?? null) === (before.completedUntil ?? null)));
    },

    remove(id) {
      return write({
        id,
        apply: (todos) => removeTodo(todos, id),
        send: async (row) => {
          await api.deleteTodo(id, row.revision);
          return null;
        },
        commit: (todos) => removeTodo(todos, id),
      });
    },

    setReminder(id, due, repeat) {
      return patch(id, (todos) => setReminder(todos, id, due, repeat), 'setReminder', { due, repeat });
    },

    // The edit form: title, reminder and category in one write. `fields` is {text, due, repeat}
    // plus `categoryId` only when the user changed it (omitted keeps the server's link), so it
    // applies the same on the server as it did here.
    edit(id, fields) {
      return patch(id, (todos) => editTodo(todos, id, fields), 'edit', fields);
    },

    clearReminder(id) {
      return patch(id, (todos) => clearReminder(todos, id), 'clearReminder', {});
    },

    // A retry keeps the draft's UUID and checks the current catalog before sending another POST.
    async createCategory(name, id = crypto.randomUUID(), retry = false) {
      const result = await categoryWrite(async (gen) => {
        if (retry) {
          if (!await reloadNow(gen)) return null;
          const existing = categories?.find((item) => item.id === id);
          if (existing) return existing;
        }
        return api.createCategory({ id, name });
      }, putCategory);
      const category = categories?.find((item) => item.id === id);
      if (result.ok || (result.reloaded && category)) return { ok: true, category };
      return result;
    },

    // A rename from an open draft uses the revision seen when it opened.
    renameCategory(id, name, revision = revisionOf(id)) {
      return categoryWrite(() => api.renameCategory(id, revision, name), putCategory);
    },

    // Removes the category and, in the same step, applies the todos the server unlinked (no
    // category, new revisions). A link omitted from the response needs a fresh snapshot.
    deleteCategory(id) {
      const revision = revisionOf(id);
      return categoryWrite(() => api.deleteCategory(id, revision), (todos) => {
        const unlinked = new Map(todos.map((todo) => [todo.id, todo]));
        categories = categories?.filter((category) => category.id !== id) ?? null;
        let reconcile = false;
        confirmed = confirmed.map((todo) => {
          const row = unlinked.get(todo.id);
          if (row) {
            trackRefresh(todo, row);
            return row;
          }
          if (todo.categoryId !== id) return todo;
          reconcile = true;
          // Keep edits to this row blocked if the reconciliation read fails.
          refreshedAt.set(todo.id, todo.revision + 1);
          return { ...todo, categoryId: null };
        });
        return reconcile;
      });
    },

    // Claims each occurrence on the server before the caller alerts it, so two tabs alert once.
    // Candidates are re-checked against the confirmed row when their turn in the queue comes.
    // Resolves {claimed, conflicts, error}: conflicts are occurrences another tab (or a change)
    // got to first; the list has been reloaded before this resolves.
    claim(candidates, clock = Date.now) {
      const gen = generation;
      return enqueue(async () => {
        const claimed = [];
        const conflicts = [];
        let error = null;
        if (gen !== generation) return { claimed, conflicts, error, stale: true };
        for (const { id, due } of candidates) {
          const row = confirmed.find((todo) => todo.id === id);
          if (!row || row.due !== due || row.notified === due || !isOverdue(row, clock())) continue;
          try {
            const result = await api.patchTodo(id, row.revision, 'markNotified', { due });
            if (gen !== generation) return { claimed: [], conflicts, error, stale: true };
            confirmed = replace(confirmed, result);
            claimed.push(result);
          } catch (failure) {
            if (gen !== generation || isStale(failure)) return { claimed: [], conflicts, error, stale: true };
            if (needsReload(failure)) {
              conflicts.push({ id, due });
            } else {
              error = failure;
              break;
            }
          }
        }
        if (conflicts.length) await reloadNow(gen).catch(() => false);
        if (gen !== generation) return { claimed: [], conflicts, error, stale: true };
        if (claimed.length || conflicts.length) changed();
        return { claimed, conflicts, error };
      });
    },
  };
}
