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
const isSessionError = (error) => error?.status === 401 || error?.code === 'INVALID_CSRF';
// The server's copy changed or is gone: reload before anything else.
const needsReload = (error) => error?.status === 409 || error?.status === 404;
// No answer, or a server error: the write may or may not have landed.
const isUncertain = (error) => error?.status === 0 || error?.status >= 500;
const isInvalidWrite = (error) => error?.code === 'INVALID_WRITE_RESPONSE';

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
  let todoRefreshError = null;
  let categoryRefreshError = null;
  const unconfirmedTodoCreates = new Set();
  // A server result that may include remote changes sets the oldest revision an edit may have seen.
  // Successful local writes may advance the row without invalidating other queued edits.
  const refreshedAt = new Map();

  function captureSession() {
    const gen = generation;
    const token = api.currentToken?.();
    return () => gen === generation && token === api.currentToken?.();
  }

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

  async function reloadNow(isCurrent) {
    if (!isCurrent()) return false;
    const { todos, categories: catalog } = await api.readSnapshot();
    if (!isCurrent()) return false;
    const previous = new Map(confirmed.map((todo) => [todo.id, todo]));
    const current = new Set(todos.map((todo) => todo.id));
    for (const id of refreshedAt.keys()) {
      if (!current.has(id)) refreshedAt.delete(id);
    }
    for (const todo of todos) trackRefresh(previous.get(todo.id), todo);
    confirmed = todos;
    categories = catalog && sortCategories(catalog);
    todoRefreshError = null;
    categoryRefreshError = null;
    loaded = true;
    changed();
    return true;
  }

  // Keep the original failure if the snapshot is unavailable, unless the read found a session error.
  async function recoverSnapshot(isCurrent, error) {
    let reloaded = false;
    try {
      reloaded = await reloadNow(isCurrent);
    } catch (readError) {
      if (isStale(readError)) return { ok: false, stale: true };
      if (isSessionError(readError)) error = readError;
    }
    if (!isCurrent()) return { ok: false, stale: true };
    return { ok: false, error, reloaded };
  }

  // One write. `apply` is the optimistic change (omitted for claims); `send` gets the confirmed row
  // (or null for a create) and resolves to the server's row (or null after a delete).
  // `holds(row)`, if given, is the change's assumption about the confirmed row when its turn comes;
  // if it no longer holds (another tab changed the row), the change is refused as a conflict.
  function write({ id, apply, send, needsRow = true, commit, holds, skipIf }) {
    const isCurrent = captureSession();
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
    const stale = () => {
      if (pending.includes(entry)) {
        settle();
        changed();
      }
      return { ok: false, stale: true };
    };
    return enqueue(async () => {
      if (!isCurrent()) return stale();
      if (todoRefreshError) {
        const result = await recoverSnapshot(isCurrent, todoRefreshError);
        if (!isCurrent() || result.stale) return stale();
        if (!result.reloaded) {
          settle();
          changed();
          return { ...result, revision: confirmed.find((todo) => todo.id === id)?.revision ?? null };
        }
      }
      const row = confirmed.find((todo) => todo.id === id) ?? null;
      if (!needsRow && unconfirmedTodoCreates.delete(id) && row) {
        settle();
        changed();
        return { ok: true, todo: row, reconciled: true };
      }
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
      if (skipIf?.(row)) {
        settle();
        changed();
        return { ok: false, skipped: true };
      }
      if (holds && !holds(row)) {
        settle();
        const result = await recoverSnapshot(isCurrent, { status: 409, code: 'STALE_CHANGE' });
        if (!isCurrent() || result.stale) return stale();
        if (!result.reloaded) changed();
        return { ...result, revision: row.revision };
      }
      try {
        if (!isCurrent()) return stale();
        const result = await send(row);
        if (!isCurrent()) return stale();
        settle();
        confirmed = commit(confirmed, result);
        if (!needsRow || !result) refreshedAt.delete(id);
        changed();
        return { ok: true, todo: result };
      } catch (error) {
        if (!isCurrent() || isStale(error)) return stale();
        if (isInvalidWrite(error)) {
          todoRefreshError = error;
          if (!needsRow) unconfirmedTodoCreates.add(id);
        }
        settle();
        changed();
        const result = needsReload(error) || isInvalidWrite(error)
          ? await recoverSnapshot(isCurrent, error) : { ok: false, error, reloaded: false };
        if (!isCurrent()) return stale();
        // `revision`: the row this change was sent against, so a retry can tell whether anything
        // (this change, or another tab) has touched the row since.
        return result.stale ? result : { ...result, revision: row?.revision ?? null };
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
  function categoryWrite(send, commit, creating = false) {
    const isCurrent = captureSession();
    return enqueue(async () => {
      if (!isCurrent()) return { ok: false, stale: true };
      if (!creating && categoryRefreshError) return { ok: false, error: categoryRefreshError, reloaded: false };
      let result;
      try {
        result = await send();
      } catch (error) {
        if (!isCurrent() || isStale(error)) return { ok: false, stale: true };
        if (needsReload(error) || isUncertain(error)) {
          if (!creating || isInvalidWrite(error)) categoryRefreshError = error;
          const recovery = await recoverSnapshot(isCurrent, error);
          return isCurrent() ? recovery : { ok: false, stale: true };
        }
        return { ok: false, error, reloaded: false };
      }
      if (!isCurrent()) return { ok: false, stale: true };
      const reconcile = commit(result);
      changed();
      if (reconcile) {
        try {
          if (!await reloadNow(isCurrent) || !isCurrent()) return { ok: false, stale: true };
        } catch (error) {
          if (!isCurrent() || isStale(error)) return { ok: false, stale: true };
          return { ok: false, error, repairFailed: true };
        }
      }
      return { ok: true };
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
    get categoryRefreshRequired() {
      return categoryRefreshError !== null;
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
      unconfirmedTodoCreates.clear();
      todoRefreshError = null;
      categoryRefreshError = null;
      confirmed = [];
      categories = null;
      pending = [];
      view = [];
      loaded = false;
      queue = Promise.resolve();
    },

    // Replaces the confirmed rows with the server's list, after any queued writes.
    load() {
      const isCurrent = captureSession();
      return enqueue(async () => {
        try {
          const reloaded = await reloadNow(isCurrent);
          return reloaded && isCurrent() ? { ok: true } : { ok: false, stale: true };
        } catch (error) {
          if (!isCurrent() || isStale(error)) return { ok: false, stale: true };
          return { ok: false, error };
        }
      });
    },

    // `todo` is the full local row from addTodo(); a retry passes the same row (same UUID).
    // A 409 for that UUID means an earlier, uncertain attempt was saved: the reload shows it.
    async create(todo) {
      const isCurrent = captureSession();
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
      if (!isCurrent()) return { ok: false, stale: true };
      if (!result.ok && result.reloaded && (result.error?.code === 'DUPLICATE_ID' || isInvalidWrite(result.error))) {
        unconfirmedTodoCreates.delete(todo.id);
        const row = confirmed.find((item) => item.id === todo.id);
        if (row) return { ok: true, todo: row, reconciled: true };
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
    // `rearm` ({due, repeat}) re-sends an unchanged, already-fired reminder in the queue slot right
    // after the edit, only if the edit was accepted and the row's reminder is still that one. The
    // result's `rearmed` is that write's outcome.
    // `guard` ({revision, categoryId}, set on a retry) drops the category from the write when the
    // row has moved on by the time it is sent, so it can't undo a newer assignment.
    edit(id, fields, rearm, guard) {
      let accepted = false;
      const result = write({
        id,
        apply: (todos) => editTodo(todos, id, fields),
        send: async (row) => {
          let body = fields;
          if (guard && fields.categoryId !== undefined &&
            (row.revision !== guard.revision || (row.categoryId ?? null) !== guard.categoryId)) {
            const { categoryId, ...rest } = fields;
            body = rest;
          }
          const saved = await api.patchTodo(id, row.revision, 'edit', body);
          accepted = true;
          return saved;
        },
        commit: (todos, row) => sortByPosition(replace(todos, row)),
      });
      if (rearm) {
        const { due, repeat } = rearm;
        result.rearmed = write({
          id,
          apply: (todos) => (accepted ? setReminder(todos, id, due, repeat) : todos),
          skipIf: (row) => !accepted || row.due !== due || row.repeat !== repeat || row.notified !== due,
          send: (row) => api.patchTodo(id, row.revision, 'setReminder', { due, repeat }),
          commit: (todos, row) => sortByPosition(replace(todos, row)),
        });
      }
      return result;
    },

    clearReminder(id) {
      return patch(id, (todos) => clearReminder(todos, id), 'clearReminder', {});
    },

    // A retry keeps the draft's UUID and checks the current catalog before sending another POST.
    async createCategory(name, id = crypto.randomUUID(), retry = false) {
      const isCurrent = captureSession();
      const result = await categoryWrite(async () => {
        if (retry || categoryRefreshError) {
          if (!await reloadNow(isCurrent) || !isCurrent()) return null;
          const existing = categories?.find((item) => item.id === id);
          if (existing) return existing;
        }
        return api.createCategory({ id, name });
      }, putCategory, true);
      if (!isCurrent()) return { ok: false, stale: true };
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
    deleteCategory(id, revision = revisionOf(id)) {
      return categoryWrite(() => api.deleteCategory(id, revision), (todos) => {
        const rows = new Map(confirmed.map((todo) => [todo.id, todo]));
        categories = categories?.filter((category) => category.id !== id) ?? null;
        for (const row of todos) {
          trackRefresh(rows.get(row.id), row);
          rows.set(row.id, row);
        }
        let reconcile = false;
        for (const todo of rows.values()) {
          if (todo.categoryId !== id) continue;
          reconcile = true;
          // Keep the last known link and block edits until the row can be refreshed.
          refreshedAt.set(todo.id, todo.revision + 1);
        }
        confirmed = sortByPosition([...rows.values()]);
        return reconcile;
      });
    },

    // Claims each occurrence on the server before the caller alerts it, so two tabs alert once.
    // Candidates are re-checked against the confirmed row when their turn in the queue comes.
    // Resolves {claimed, conflicts, error}: conflicts are occurrences another tab (or a change)
    // got to first; the list has been reloaded before this resolves.
    claim(candidates, clock = Date.now) {
      const isCurrent = captureSession();
      return enqueue(async () => {
        const claimed = [];
        const conflicts = [];
        let error = null;
        if (!isCurrent()) return { claimed, conflicts, error, stale: true };
        if (todoRefreshError) {
          const recovery = await recoverSnapshot(isCurrent, todoRefreshError);
          if (!isCurrent()) return { claimed, conflicts, error, stale: true };
          if (recovery.stale || !recovery.reloaded) return { ...recovery, claimed, conflicts };
        }
        for (const { id, due } of candidates) {
          const row = confirmed.find((todo) => todo.id === id);
          if (!row || row.due !== due || row.notified === due || !isOverdue(row, clock())) continue;
          try {
            if (!isCurrent()) return { claimed: [], conflicts, error, stale: true };
            const result = await api.patchTodo(id, row.revision, 'markNotified', { due });
            if (!isCurrent()) return { claimed: [], conflicts, error, stale: true };
            confirmed = replace(confirmed, result);
            claimed.push(result);
          } catch (failure) {
            if (!isCurrent() || isStale(failure)) return { claimed: [], conflicts, error, stale: true };
            if (isInvalidWrite(failure)) {
              todoRefreshError = failure;
              error = failure;
              break;
            } else if (needsReload(failure)) {
              conflicts.push({ id, due });
            } else {
              error = failure;
              break;
            }
          }
        }
        if (conflicts.length || isInvalidWrite(error)) {
          const recovery = await recoverSnapshot(isCurrent, error);
          if (!isCurrent() || recovery.stale) return { claimed: [], conflicts, error, stale: true };
          error = recovery.error;
        }
        if (!isCurrent()) return { claimed: [], conflicts, error, stale: true };
        if (claimed.length || conflicts.length) changed();
        return { claimed, conflicts, error };
      });
    },
  };
}
