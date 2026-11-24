import {
  addTodo,
  editTodo,
  toggleTodo,
  dueReminders,
  nextFireTime,
  sortByUrgency,
} from './todos.js';
import { categoryColor } from './tags.js';
import {
  ALL, categoryErrorText, filterByCategory, keepFilter, NAME_MESSAGES, readCategoryName, UNCATEGORIZED,
} from './categories.js';
import { isCompleted, isOverdue } from './reminders.js';
import * as api from './storage.js';
import { createSync } from './sync.js';
import { readTaskInput } from './task-input.js';
import { autoScrollStep, createDrag, keyboardTarget } from './drag.js';
import {
  CALENDAR_KEYS, DEFAULT_TIME, addDays, addMonths, canGoBack, dayLabel, dayName, defaultReminder,
  EARLIEST_DAY, localDate, monthGrid, monthLabel, parseDate, pickerDue, splitDue,
} from './picker.js';
import { createSheetViewport } from './viewport.js';

const app = document.querySelector('.app');
const header = document.getElementById('app-header');
const title = document.getElementById('app-title');
const dragStatus = document.getElementById('drag-status');
const form = document.getElementById('add-form');
const input = document.getElementById('new-todo');
const addButton = document.getElementById('add-button');
const addToggle = document.getElementById('add-toggle');
const addShelf = document.getElementById('add-shelf');
const list = document.getElementById('todo-list');
const emptyState = document.getElementById('empty-state');
const summary = document.getElementById('summary');
const hintLimit = document.getElementById('hint-limit');
const categoryRow = document.getElementById('category-row');
const categoryFilter = document.getElementById('category-filter');
const manageButton = document.getElementById('category-manage');
const panel = document.getElementById('category-panel');
const panelTitle = document.getElementById('category-panel-title');
const panelDone = document.getElementById('category-done');
const categoryForm = document.getElementById('category-form');
const categoryName = document.getElementById('category-name');
const categoryAdd = document.getElementById('category-add');
const categoryStatus = document.getElementById('category-status');
const categoryList = document.getElementById('category-list');
const categoryEmpty = document.getElementById('category-empty');
const filterEmpty = document.getElementById('filter-empty');
const banner = document.getElementById('banner');
const bannerIcon = document.getElementById('banner-icon');
const bannerText = document.getElementById('banner-text');
const bannerDismiss = document.getElementById('banner-dismiss');
const announcer = document.getElementById('announcer');
const editorAnnouncer = document.getElementById('reminder-announcer');
const layer = document.getElementById('reminder-layer');
const scrim = document.getElementById('reminder-scrim');
const editor = document.getElementById('reminder-editor');
const sheetBody = document.getElementById('sheet-body');
const textInput = document.getElementById('edit-text');
const editCategory = document.getElementById('edit-category');
const reminderOn = document.getElementById('reminder-on');
const pickerDetail = document.getElementById('picker-detail');
const dateButton = document.getElementById('reminder-date-button');
const dateValue = document.getElementById('reminder-date-value');
const dateInput = document.getElementById('reminder-date');
const calendar = document.getElementById('calendar');
const calMonth = document.getElementById('cal-month');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calWeekdays = document.getElementById('cal-weekdays');
const calDays = document.getElementById('cal-days');
const timeInput = document.getElementById('reminder-time');
const repeatSelect = document.getElementById('reminder-repeat');
const message = document.getElementById('reminder-message');
const messageIcon = document.getElementById('reminder-message-icon');
const messageText = document.getElementById('reminder-message-text');
const editorStart = document.getElementById('reminder-start');
const editorEnd = document.getElementById('reminder-end');
const deleteButton = document.getElementById('task-delete');
const cancelButton = document.getElementById('reminder-cancel');
const saveButton = document.getElementById('reminder-save');
const repeatIcon = document.getElementById('repeat-icon');
const alertIcon = document.getElementById('alert-icon');
const infoIcon = document.getElementById('info-icon');
const gripIcon = document.getElementById('grip-icon');
const syncNote = document.getElementById('sync-note');
const syncText = document.getElementById('sync-text');
const syncRetry = document.getElementById('sync-retry');
const syncDismiss = document.getElementById('sync-dismiss');

const sheetViewport = createSheetViewport({ layer, body: sheetBody });
// Static controls that a render may send focus back to.
withKey(categoryFilter, 'category-filter');
withKey(categoryName, 'category-name');

const MAX_DELAY = 2 ** 31 - 1; // setTimeout's limit (about 24.8 days); check() re-arms when it fires
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE_MS = 2 * 1200; // the fired row's 2 pulses (styles.css reminder-pulse)
// A claim the server refused while this tab still sees the occurrence as due (its clock is ahead,
// say) waits this long before it is tried again. So does a claim that failed to reach the server.
const CLAIM_RETRY_MS = 30_000;
const NOTE_DISMISSED_KEY = 'task-manager.blocked-note-dismissed';

const CHANGED_ELSEWHERE = 'This task changed in another tab or device. The list is up to date now, so try again.';
const CATEGORY_GONE = 'The category you chose was deleted. The list is up to date now, so try again.';
const DELETE_QUESTION = 'Delete category? Its tasks will become uncategorized.';

// The list-level notice (permission denied or unsupported).
const NOTE_TEXT = 'Notifications off';
const SKELETON_ROWS = 3;
// The sheet's one message line. Short: no helper text.
const MESSAGES = {
  invalid: { kind: 'error', icon: alertIcon, text: 'Enter a valid date and time.' },
  // The title, by readTaskInput's error (the rule that also disables Add).
  empty: { kind: 'error', icon: alertIcon, text: 'Enter a task title.' },
  long: { kind: 'error', icon: alertIcon, text: 'Keep the title to 2,000 characters or fewer.' },
  past: { kind: 'warn', icon: infoIcon, text: 'That time has passed' },
  done: { kind: 'warn', icon: infoIcon, text: 'This task is done' },
  blocked: { kind: 'info', icon: infoIcon, text: NOTE_TEXT },
};

// The signed-in user's todos as shown: the server's rows plus changes still being saved.
// Nothing about tasks is kept in browser storage.
const sync = createSync(api, { onChange: syncChanged, seenRevision: (id) => displayed.get(id) });
// The revision of each row as it is on screen. A change is made against what the user sees, and
// sync.js cancels a change made against a row that a reload has since replaced.
const displayed = new Map();
let state = [];
let phase = 'signed-out'; // 'loading' | 'ready' | 'error' once signed in
let sessionToken = null; // the CSRF token of the session this view belongs to
let sessionEmail = null;
let revalidating = false; // a CSRF rejection asked the auth module to re-read the session
let resuming = false;
let viewSignature = '[]';
// Creates that may or may not have reached the server: the title -> their IDs, oldest first.
// Adding the same title again reuses one of those IDs, so a create that did land can't be
// doubled. Another title never takes an ID that isn't its own.
const createDrafts = new Map();
let retryAction = null;
const claiming = new Set(); // "id:due" occurrences being claimed by this tab
const claimBackoff = new Map(); // "id:due" -> time before which it isn't claimed again
let recheckTimer;
const openNotifications = new Set(); // closed when the session ends
// View state: never saved, never in the URL.
let filter = ALL; // ALL, UNCATEGORIZED or a category ID
let reminderId = null; // todo whose task sheet is open
let draft = null; // the sheet's starting values and the user's category choice
let optionsSignature = null; // the catalog the two category selects were built from
// The Manage panel: `panelRow` is the row in rename ({id, mode: 'rename', value, revision}) or delete
// confirmation ({id, mode: 'confirm', name, revision}); `panelBusy` is the write waiting for the server.
let panelRow = null;
let categoryCreateDraft = null; // { id, name }, retained if the create is unconfirmed
let panelBusy = null; // null | { id, kind: 'create' | 'rename' | 'delete' | 'refresh' }
let panelSignature = null;
let reminderTouched = false; // a field was changed, or Save tried: show its error
const fired = new Map(); // todo id -> when its "just fired" pulse started (performance.now())
let noteDismissed = readNoteDismissed(); // the blocked-notifications note, for this session

let rendering = false;
let renderPending = false;
let pendingFocus; // focus keys for the deferred render
let pressing = false;
const afterPress = []; // updates that would move the list, held until the press is released
let viewEpoch = 0; // bumped whenever the view is cleared for another (or a re-read) session
let timer; // the one reminder timeout
let bannerTimer;

// The sync model changed: a local change was applied, or the server answered. Re-render only when
// something visible changed (a confirmed row replacing its optimistic copy usually changes nothing
// but the revision), so an answer arriving mid-typing doesn't replace a field being edited.
function syncChanged() {
  state = sync.todos;
  // A deleted category (here or elsewhere) stops filtering: the view goes back to All.
  filter = keepFilter(filter, sync.categories);
  if (panelRow) {
    const category = findCategory(panelRow.id);
    if (!category || (panelRow.mode === 'confirm' &&
        (category.revision !== panelRow.revision || category.name !== panelRow.name))) panelRow = null;
  }
  if (reminderId !== null && !sync.categories) draft.chosenCategoryId = draft.categoryId;
  const draftFocus = invalidateDraft();
  const signature = JSON.stringify([state.map(({ revision, ...todo }) => todo), sync.categories]);
  if (signature !== viewSignature || draftFocus) {
    viewSignature = signature;
    renderSoon(draftFocus ?? (renderPending ? pendingFocus : undefined));
  } else if (!renderPending) {
    // Nothing visible changed, so the screen already shows these rows.
    noteDisplayed();
  }
}

function noteDisplayed() {
  displayed.clear();
  for (const todo of state) displayed.set(todo.id, todo.revision);
}

function findTodo(id) {
  return state.find((todo) => todo.id === id);
}

function findCategory(id) {
  return id == null ? undefined : sync.categories?.find((category) => category.id === id);
}

// The list as shown: the category filter, then overdue todos on top. Used by the list and
// fallback focus, so they always agree.
function visibleTodos(now) {
  return sortByUrgency(filterByCategory(state, filter), now);
}

// Moves are made in the whole list, so they are off while a filter hides some of it.
function reorderLocked() {
  return filter !== ALL;
}

// Every focusable control gets a stable key so focus survives a re-render.
function key(...parts) {
  return JSON.stringify(parts);
}

function withKey(element, ...parts) {
  element.dataset.focusKey = key(...parts);
  return element;
}

function icon(template) {
  return template.content.firstElementChild.cloneNode(true);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Due text in the browser's locale and zone: "Today 5:30 PM", "Tomorrow 9:00 AM", "Mon 7:00 PM"
// (within 6 days either side), "Dec 4, 9:00 AM", "Jan 8, 2027, 9:00 AM" (another year).
// A formatter fixes its zone when created, so they are rebuilt when the browser's zone changes:
// the text then agrees with the Date math (and the editor), which always uses the current zone.
let formats;
function getFormats() {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (formats?.zone !== zone) {
    const format = (options) => new Intl.DateTimeFormat(undefined, options);
    formats = {
      zone,
      time: format({ hour: 'numeric', minute: '2-digit' }),
      weekday: format({ weekday: 'short' }),
      longWeekday: format({ weekday: 'long' }),
      date: format({ month: 'short', day: 'numeric' }),
      yearDate: format({ month: 'short', day: 'numeric', year: 'numeric' }),
    };
  }
  return formats;
}
const RELATIVE_DAYS = new Map([[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']]);

// Local calendar day number, so a day difference ignores the time of day and DST.
function dayNumber(date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function formatDue(ms, now) {
  const date = new Date(ms);
  const today = new Date(now);
  const days = dayNumber(date) - dayNumber(today);
  const { time, weekday, date: monthDay, yearDate } = getFormats();
  const clock = time.format(date);
  if (RELATIVE_DAYS.has(days)) return `${RELATIVE_DAYS.get(days)} ${clock}`;
  if (Math.abs(days) <= 6) return `${weekday.format(date)} ${clock}`;
  const day = date.getFullYear() === today.getFullYear() ? monthDay : yearDate;
  return `${day.format(date)}, ${clock}`;
}

const REPEAT_LABELS = { daily: 'Daily', weekly: 'Weekly' };

// A row's category: its name in neutral ink. Not interactive: the filter filters, the sheet edits.
function renderCategoryLabel(category) {
  const label = document.createElement('span');
  label.className = 'todo-category';
  label.textContent = category.name;
  return label;
}

// A ticked recurring task: checked for today, back tomorrow.
function isTicked(todo, now) {
  return todo.completedUntil != null && isCompleted(todo, now);
}

// The time stamp, in words and mono: "Today 5:30 PM · ⟳ Daily", "Overdue · Today 8:30 AM",
// "Done today · next Tomorrow 8:00 AM · ⟳ Daily". Overdue is said in words, not only by color;
// the due time has no icon, an overdue one keeps its alert mark.
function renderStamp(todo, overdue, ticked, now) {
  const stamp = document.createElement('span');
  stamp.className = overdue ? 'stamp is-overdue' : 'stamp';
  const when = document.createElement('span');
  when.className = 'stamp-when';
  if (ticked) {
    const lead = document.createElement('span');
    lead.className = 'stamp-lead';
    lead.textContent = 'Done today · next';
    stamp.append(lead);
  }
  const text = document.createElement('span');
  text.className = 'reminder-when';
  text.textContent = overdue ? `Overdue · ${formatDue(todo.due, now)}` : formatDue(todo.due, now);
  if (overdue) when.append(icon(alertIcon));
  when.append(text);
  stamp.append(when);
  if (todo.repeat !== 'none' && !overdue) {
    const repeat = document.createElement('span');
    repeat.className = 'stamp-repeat';
    const label = document.createElement('span');
    label.className = 'reminder-repeat-label';
    label.textContent = REPEAT_LABELS[todo.repeat];
    repeat.append(icon(repeatIcon), label);
    stamp.append(repeat);
  }
  return stamp;
}

// The body button's name: the title plus what the stamp and category show, then the action.
function rowName(todo, category, overdue, ticked, now) {
  const parts = [todo.text];
  if (todo.due !== null) {
    const when = formatDue(todo.due, now);
    const repeats = todo.repeat === 'none' ? '' : `, repeats ${todo.repeat}`;
    if (ticked) parts.push(`Done today, next due ${when}${repeats}`);
    else if (overdue) parts.push(`Overdue, was due ${when}${repeats}`);
    else parts.push(`Reminder ${when}${repeats}`);
  }
  if (category) parts.push(`Category: ${category.name}`);
  parts.push('Edit task');
  return parts.join('. ');
}

function renderTodo(todo, now) {
  const completed = isCompleted(todo, now);
  const overdue = isOverdue(todo, now);
  const ticked = isTicked(todo, now);
  const category = findCategory(todo.categoryId);
  const item = document.createElement('li');
  item.className = completed && !ticked ? 'todo is-done' : 'todo';
  item.classList.toggle('is-ticked', ticked);
  item.classList.toggle('is-overdue', overdue);
  item.classList.toggle('is-editing', reminderId === todo.id);
  item.dataset.id = todo.id;
  // The card takes its category's shelf color (styles.css [data-color]), hashed from the name.
  if (category) item.dataset.color = categoryColor(category.name);
  if (fired.has(todo.id)) {
    item.classList.add('is-fired');
    // Re-renders continue the pulse where it was instead of restarting it.
    item.style.animationDelay = `${Math.round(fired.get(todo.id) - performance.now())}ms`;
  }

  const checkbox = withKey(document.createElement('input'), 'checkbox', todo.id);
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-checkbox';
  checkbox.id = `todo-${todo.id}`;
  checkbox.checked = completed;
  checkbox.setAttribute('aria-label', ticked ? `${todo.text}, done for today` : todo.text);

  // The whole body opens the task sheet.
  const open = withKey(document.createElement('button'), 'open', todo.id);
  open.type = 'button';
  open.className = 'todo-open';
  open.setAttribute('aria-haspopup', 'dialog');
  open.setAttribute('aria-expanded', String(reminderId === todo.id));
  open.setAttribute('aria-label', rowName(todo, category, overdue, ticked, now));

  const title = document.createElement('span');
  title.className = 'todo-text';
  title.textContent = todo.text;
  open.append(title);

  if (todo.due !== null || category) {
    const meta = document.createElement('span');
    meta.className = 'todo-meta';
    if (todo.due !== null) meta.append(renderStamp(todo, overdue, ticked, now));
    if (category) meta.append(renderCategoryLabel(category));
    open.append(meta);
  }

  item.append(checkbox, open);
  // The drag handle. Overdue tasks stay on top by due time, so they have none (a spacer keeps
  // the column).
  if (overdue) {
    const spacer = document.createElement('span');
    spacer.className = 'todo-handle-space';
    spacer.setAttribute('aria-hidden', 'true');
    item.append(spacer);
  } else {
    const handle = withKey(document.createElement('button'), 'handle', todo.id);
    handle.type = 'button';
    handle.className = 'todo-handle';
    handle.setAttribute('aria-label', `Reorder ${todo.text}`);
    handle.setAttribute('aria-describedby', 'reorder-hint');
    // Under a category filter the grip stays in place but can't be pressed or focused.
    handle.disabled = reorderLocked();
    handle.append(icon(gripIcon));
    item.append(handle);
  }
  return item;
}

function renderSkeleton() {
  const item = document.createElement('li');
  item.className = 'skeleton';
  item.setAttribute('aria-hidden', 'true');
  const lines = document.createElement('span');
  lines.className = 'skeleton-lines';
  lines.append(document.createElement('span'), document.createElement('span'));
  item.append(lines);
  return item;
}

// focusKeys: controls to focus after rendering, first match wins; if none exists, the
// new-task input. Without it, whatever had focus keeps it.
function render(focusKeys) {
  const keys = focusKeys ?? [document.activeElement?.dataset?.focusKey];
  const now = Date.now(); // one instant for the whole render: overdue marks, order and due text agree
  const visible = visibleTodos(now);
  const filtering = filter !== ALL;

  rendering = true;
  noteDisplayed();
  renderPending = false;
  pendingFocus = undefined;

  // A highlight ends once its todo is no longer overdue (completed, rolled over, changed, deleted),
  // and once its pulses are over (animationend normally clears it first).
  // Under reduced motion nothing pulses, so nothing stays fired.
  const pulseNow = performance.now();
  for (const [id, started] of fired) {
    const todo = findTodo(id);
    if (reducedMotion.matches || !todo || !isOverdue(todo, now) || pulseNow - started >= PULSE_MS) fired.delete(id);
  }
  // The todo being edited was deleted: close its editor.
  if (reminderId !== null && !findTodo(reminderId)) closeEditor();

  const ready = phase === 'ready';
  const loading = phase === 'loading';
  // The row is only a live region: while loading it says "Loading your tasks" to screen readers.
  summary.textContent = loading ? 'Loading your tasks' : '';
  summary.setAttribute('aria-busy', String(loading));
  syncAddButton();
  // Under the composer: new tasks start uncategorized, so under a category filter say where they go.
  const shelf = ready ? findCategory(filter) : undefined;
  addShelf.hidden = !shelf;
  addShelf.textContent = shelf ? 'New tasks go to Uncategorized.' : '';
  // A load error is a card in the list slot; other sync notes are a line above the list.
  syncNote.classList.toggle('is-block', phase === 'error');

  // One category selected: that shelf's view. The title names it and the header takes its color.
  title.textContent = shelf?.name ?? 'Tasks';
  if (shelf) header.dataset.color = categoryColor(shelf.name);
  else delete header.dataset.color;

  // Category controls need the server's catalog; without one (an older server) they stay hidden.
  const catalog = ready ? sync.categories : null;
  categoryRow.hidden = !catalog;
  if (!catalog && !panel.hidden) closePanel(false);
  renderCategoryOptions();
  categoryFilter.value = filter;
  renderPanel();

  if (loading) list.replaceChildren(...Array.from({ length: SKELETON_ROWS }, renderSkeleton));
  else list.replaceChildren(...visible.map((todo) => renderTodo(todo, now)));
  list.classList.toggle('is-loading', loading);
  list.setAttribute('aria-busy', String(loading));
  list.hidden = !loading && visible.length === 0;
  // No tasks at all: the welcome page. Tasks (or a filter) but none shown: say the filter did it.
  emptyState.hidden = !ready || visible.length > 0 || filtering;
  filterEmpty.hidden = !ready || visible.length > 0 || !filtering;

  const controls = new Map(
    [...app.querySelectorAll('[data-focus-key]')].map((element) => [element.dataset.focusKey, element]),
  );
  const target = keys.map((focusKey) => controls.get(focusKey)).find(Boolean);
  if (target) {
    target.focus();
    // A rebuilt rename field keeps the caret at the end of what was typed.
    if (target.classList.contains('category-field')) target.setSelectionRange?.(target.value.length, target.value.length);
  } else if (focusKeys) {
    focusComposer();
  }
  // Focus moved by the render itself is not the user's: focus handlers ignore it.
  rendering = false;

  if (reminderId !== null) {
    placeEditor();
    syncEditor(); // e.g. "That time has passed" once it has
  }
}

// Pressing a control can blur a field (and so re-render) before that control gets its click. Rendering in between would replace the pressed control and swallow the
// click, so a render requested during a press waits until the press has had its click.
// The press is tracked with pointer events: a touch fires pointerdown when the finger lands, well
// before the browser synthesizes mousedown/mouseup/click after the finger lifts. On pointerup the
// press stays held until the click (a touch's click can come in a later task); if no click comes
// (released elsewhere), a short fallback releases it. A cancelled press (scroll, drag) or the
// window losing focus releases it at once.
const CLICK_WAIT_MS = 400;
let releaseTimer = null;
let pressPointerId = null;
document.addEventListener('pointerdown', (event) => {
  if (event.isPrimary === false || event.button !== 0) return;
  clearTimeout(releaseTimer);
  pressing = true;
  pressPointerId = event.pointerId;
}, true);
document.addEventListener('pointerup', (event) => {
  if (!pressing || event.pointerId !== pressPointerId) return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, CLICK_WAIT_MS);
}, true);
// Capture: released before the control's own click handler runs; the held updates flush after it.
document.addEventListener('click', () => {
  if (pressing) release();
}, true);
document.addEventListener('pointercancel', (event) => {
  if (event.pointerId === pressPointerId) release();
}, true);
document.addEventListener('dragend', release, true);
window.addEventListener('blur', release);

function release() {
  clearTimeout(releaseTimer);
  pressing = false;
  pressPointerId = null;
  setTimeout(() => {
    flushRender();
    flushAfterPress();
  });
}

// Like renders, layout-moving updates (reopening the composer, the sync note) wait for a press
// to be released, so the pressed control stays under the pointer until its click.
function whenReleased(update) {
  if (pressing) afterPress.push(update);
  else update();
}

function flushAfterPress() {
  if (pressing) return;
  for (const update of afterPress.splice(0)) update();
}

function renderSoon(focusKeys) {
  renderPending = true;
  pendingFocus = focusKeys;
  setTimeout(flushRender);
}

// Checked when it runs, not when queued: a press may have started since. release() flushes it.
function flushRender() {
  if (renderPending && !pressing) render(pendingFocus);
}

// Neighbouring rows in the current view, for when the acted-on row leaves it.
function rowFallbackKeys(id) {
  const visible = visibleTodos(Date.now());
  const index = visible.findIndex((todo) => todo.id === id);
  return [visible[index + 1], visible[index - 1]]
    .filter(Boolean)
    .map((todo) => key('checkbox', todo.id));
}

// Same check as submit (and the edit form).
function syncAddButton() {
  const { error } = readTaskInput(input.value);
  addButton.disabled = phase !== 'ready' || error !== null;
  // Say why Add is disabled when it is the length (the one reason that isn't obvious).
  const tooLong = error === 'invalid';
  hintLimit.hidden = !tooLong || form.hidden;
  hintLimit.textContent = tooLong ? MESSAGES.long.text : '';
}

// --- Reminders: alerting -------------------------------------------------------------------

const occurrence = ({ id, due }) => `${id}:${due}`;

// Claims every overdue, un-alerted todo on the server and alerts the ones this tab won, then arms
// the timer for the next one. Never trusts the timer: it compares against the clock, so an early,
// late or stale wake-up is harmless.
function check() {
  if (phase !== 'ready') return;
  const now = Date.now();
  for (const [name, until] of claimBackoff) if (until <= now) claimBackoff.delete(name);
  const ready = dueReminders(state, now).filter((todo) => {
    const name = occurrence(todo);
    return !claiming.has(name) && !claimBackoff.has(name);
  });
  if (ready.length > 0) claim(ready);
  // Overdue marks and order depend on the time, so re-render even when nothing fired.
  renderSoon(renderPending ? pendingFocus : undefined);
  rearm(now);
}

// The claim is made before the alert, so two open tabs alert an occurrence once. If the page
// closes between the claim and the alert, that occurrence is not alerted again.
async function claim(ready) {
  const names = ready.map(occurrence);
  for (const name of names) claiming.add(name);
  const result = await sync.claim(ready.map(({ id, due }) => ({ id, due })));
  for (const name of names) claiming.delete(name);
  if (result.stale) return;
  if (result.claimed.length > 0) {
    const claimed = sortByUrgency(result.claimed, Date.now());
    notify(claimed);
    // The pulse is the whole highlight: with reduced motion the row is simply overdue.
    if (!reducedMotion.matches) {
      const started = performance.now();
      for (const todo of claimed) fired.set(todo.id, started);
    }
    renderSoon(renderPending ? pendingFocus : undefined);
  }
  // Another tab got there first (the reload shows it), or the server doesn't see it as due yet.
  for (const conflict of result.conflicts) claimBackoff.set(occurrence(conflict), Date.now() + CLAIM_RETRY_MS);
  // A failed claim waits before it is tried again, whatever the failure, so it can't spin.
  if (result.error) {
    for (const name of names) claimBackoff.set(name, Date.now() + CLAIM_RETRY_MS);
    handleSessionError(result.error);
  }
  if (result.conflicts.length > 0 || result.error) {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(check, CLAIM_RETRY_MS);
  }
  check();
}

// One timer for reminder due times and completion cutoffs.
function rearm(now) {
  clearTimeout(timer);
  if (phase !== 'ready') return;
  const next = nextFireTime(state, now);
  timer = next === null ? undefined : setTimeout(check, Math.min(next - now, MAX_DELAY));
}

function notificationsBlocked() {
  return typeof Notification === 'undefined' || Notification.permission === 'denied';
}

// One due todo: its own notification. Several (typical after a while away): one grouped one.
function notify(ready) {
  const [first] = ready;
  const count = ready.length;
  announce(count === 1 ? `Reminder due: ${first.text}` : `${count} reminders due`);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification =
      count === 1
        ? new Notification(first.text, { body: 'Reminder', tag: first.id })
        : new Notification(`${count} reminders due`, { body: `${first.text} and ${count - 1} more` });
    openNotifications.add(notification);
    notification.onclose = () => openNotifications.delete(notification);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker: in-app alerting only.
  }
}

// Only ever from the Save click (a user gesture); not awaited, the reminder saves either way.
function requestPermission() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  try {
    Promise.resolve(Notification.requestPermission()).catch(() => {});
  } catch {
    // An old callback-only API or a refusal to ask: treated like a dismissed prompt.
  }
}

// While the bottom sheet is open the page (and its status line) is inert, so the announcement
// goes to a live region inside the sheet. Only the latest announcement is kept.
function announce(text) {
  const [target, other] = app.inert ? [editorAnnouncer, announcer] : [announcer, editorAnnouncer];
  other.textContent = '';
  target.textContent = text;
}

function showBanner(kind, text, clearAfter) {
  clearTimeout(bannerTimer);
  announcer.textContent = ''; // so a banner change can't re-read an earlier alert
  banner.className = `banner is-${kind}`;
  bannerIcon.replaceChildren(icon(kind === 'note' ? infoIcon : repeatIcon));
  bannerText.textContent = text;
  bannerDismiss.hidden = kind !== 'note';
  banner.hidden = false;
  if (clearAfter) bannerTimer = setTimeout(hideBanner, clearAfter);
}

function hideBanner() {
  clearTimeout(bannerTimer);
  banner.hidden = true;
  bannerText.textContent = '';
}

function readNoteDismissed() {
  try {
    return globalThis.sessionStorage.getItem(NOTE_DISMISSED_KEY) === '1';
  } catch {
    return false; // storage unavailable: the in-memory flag still holds for this page
  }
}

function dismissNote() {
  noteDismissed = true;
  hideBanner();
  try {
    globalThis.sessionStorage.setItem(NOTE_DISMISSED_KEY, '1');
  } catch {
    // Kept in memory only.
  }
}

// Ends a highlight on the existing row, without a render (which would replace the rows and move
// focus).
function dismissFired(id) {
  if (!fired.delete(id)) return;
  const row = [...list.children].find((item) => item.dataset.id === id);
  if (row) {
    row.classList.remove('is-fired');
    row.style.animationDelay = '';
  }
}

function dismissAllFired() {
  for (const id of [...fired.keys()]) dismissFired(id);
}

// --- Task sheet ----------------------------------------------------------------------------

// Opens the task sheet, prefilled with the task's title, category, reminder and repeat.
// The row can outlive its task until the pending render (a failed add rolled it back mid-press).
function openEditor(id) {
  const todo = findTodo(id);
  if (!todo) return;
  reminderId = id;
  reminderTouched = false;
  const categoryId = todo.categoryId ?? null;
  draft = { text: todo.text, categoryId, chosenCategoryId: categoryId, due: todo.due, repeat: todo.repeat };
  editor.setAttribute('aria-label', `Edit “${todo.text}”`);
  textInput.value = todo.text;
  optionsSignature = null; // rebuild the sheet's select for this task
  renderCategoryOptions();
  const fields = splitDue(todo.due);
  reminderOn.checked = fields.on;
  dateInput.value = fields.date;
  timeInput.value = fields.time;
  repeatSelect.value = todo.repeat;
  setCalendarOpen(false);
  layer.hidden = false;
  // Before the focus below: the sheet follows the visual viewport, and the focus (which brings up
  // the iOS keyboard, inside the tap's gesture) is revealed once the keyboard is up.
  sheetViewport.start();
  render(); // the opener shows aria-expanded; the page behind goes inert
  syncEditor();
  textInput.focus({ preventScroll: true });
  textInput.setSelectionRange?.(textInput.value.length, textInput.value.length);
}

// Hides the sheet without rendering; callers render (or renderSoon) with their focus.
function closeEditor() {
  reminderId = null;
  layer.hidden = true;
  sheetViewport.stop();
  app.inert = false;
  editorAnnouncer.textContent = '';
  setCalendarOpen(false);
  hideMessage();
}

// Where focus goes back to when the sheet closes: the row's body button.
function openerKeys(id) {
  return [key('open', id), key('checkbox', id)];
}

function cancelEditor() {
  const id = reminderId;
  closeEditor();
  render(openerKeys(id));
}

function editedElsewhere(todo, opened) {
  return todo.text !== opened.text || todo.due !== opened.due || todo.repeat !== opened.repeat ||
    (todo.categoryId ?? null) !== opened.categoryId;
}

// The sheet is tinted with the chosen category's shelf color, like the task's card.
function tintEditor() {
  const category = findCategory(draft?.chosenCategoryId);
  if (category) editor.dataset.color = categoryColor(category.name);
  else delete editor.dataset.color;
}

function categoryOption(value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

function categoryOptions(catalog, ...builtIns) {
  if (!catalog?.length) return builtIns;
  const group = document.createElement('optgroup');
  group.setAttribute('label', 'Categories');
  group.append(...catalog.map(({ id, name }) => categoryOption(id, name)));
  return [...builtIns, group];
}

// The filter select and the sheet's select, rebuilt only when the catalog changes, so a render
// while one is open doesn't close it. The sheet's selection comes from the draft.
function renderCategoryOptions() {
  const catalog = sync.categories;
  const signature = JSON.stringify(catalog?.map(({ id, name }) => [id, name]) ?? null);
  if (signature === optionsSignature) return;
  optionsSignature = signature;
  categoryFilter.replaceChildren(...categoryOptions(
    catalog, categoryOption(ALL, 'All categories'), categoryOption(UNCATEGORIZED, 'Uncategorized'),
  ));
  categoryFilter.value = filter;
  const chosen = reminderId === null ? null : draft.chosenCategoryId;
  editCategory.replaceChildren(...categoryOptions(catalog, categoryOption('', 'Uncategorized')));
  // Without a catalog the task's category can't be shown or changed; saves leave it as it is.
  editCategory.disabled = !catalog;
  editCategory.value = findCategory(chosen) ? chosen : '';
  if (reminderId !== null) tintEditor();
}

// An open sheet whose task's category, or the one chosen in it, was deleted can't be saved as it
// stands: it closes, and the user starts again from the refreshed task. Returns where focus goes.
function invalidateDraft() {
  if (reminderId === null || !sync.categories) return undefined;
  const gone = (id) => id !== null && !findCategory(id);
  if (!gone(draft.categoryId) && !gone(draft.chosenCategoryId)) return undefined;
  const id = reminderId;
  closeEditor();
  showSync(CATEGORY_GONE);
  return openerKeys(id);
}

// Save: one write with the title, reminder and category, shown at once and rolled back if the
// server refuses it (a 409 reloads and says the task changed in another tab).
function saveEditor() {
  const { text, error } = readTaskInput(textInput.value);
  const due = editorDue();
  if (error !== null || due === undefined) {
    reminderTouched = true;
    syncEditor();
    (error !== null ? textInput : invalidPickerField()).focus();
    return;
  }
  const id = reminderId;
  const todo = findTodo(id);
  if (!todo || editedElsewhere(todo, draft)) {
    // An editable field changed (another tab, or a refresh) after the sheet opened: its prefilled
    // values are stale, and saving them would overwrite that change. Show the conflict instead.
    // A reminder firing here (`notified`, the revision) touches none of them, so it keeps the draft.
    closeEditor();
    showSync(CHANGED_ELSEWHERE);
    render(todo ? openerKeys(id) : undefined);
    return;
  }
  const fields = { text, due, repeat: due === null ? 'none' : repeatSelect.value };
  // The category is sent only when the user changed it, so an edit made without touching it
  // can't undo another tab's change to the link.
  const categoryId = draft.chosenCategoryId;
  const originalCategoryId = draft.categoryId;
  if (sync.categories && categoryId !== originalCategoryId) fields.categoryId = categoryId;
  const reminderChanged = fields.due !== todo.due || fields.repeat !== todo.repeat;
  // The edited row can leave the view (its category changed under a filter): focus then goes to a
  // neighbour, else the filter.
  const keys = [...openerKeys(id), ...rowFallbackKeys(id), key('category-filter')];
  if (due !== null) requestPermission(); // the browser's own prompt does the asking
  closeEditor();
  if (due !== null && reminderChanged) {
    if (notificationsBlocked() && !noteDismissed) showBanner('note', NOTE_TEXT);
    else if (!banner.hidden && banner.classList.contains('is-note')) hideBanner();
  }
  if (editTodo([todo], id, fields)[0] !== todo) {
    if (reminderChanged) fired.delete(id);
    hideSync();
    saveEdit(id, fields, originalCategoryId);
  }
  // An unchanged reminder that already fired is saved again to re-arm it (it alerts once more).
  if (due !== null && !reminderChanged && todo.notified === todo.due) {
    fired.delete(id);
    hideSync();
    rearmReminder(id, due, fields.repeat);
  }
  render(keys);
}

function rearmReminder(id, due, repeat) {
  saved(id, sync.setReminder(id, due, repeat), () => {
    const todo = findTodo(id);
    if (todo && todo.notified === todo.due && todo.due === due && todo.repeat === repeat) rearmReminder(id, due, repeat);
  });
  check();
}

// `retry` (after an uncertain failure) re-sends only if the row doesn't already match the edit.
function saveEdit(id, fields, originalCategoryId) {
  saved(id, sync.edit(id, fields), () => {
    const todo = sync.confirmed.find((row) => row.id === id);
    if (!todo) return;
    const { categoryId, ...otherFields } = fields;
    const retryFields = categoryId !== undefined && (!sync.categories ||
      (todo.categoryId ?? null) !== originalCategoryId ||
      (categoryId !== null && !findCategory(categoryId))) ? otherFields : fields;
    if (editTodo([todo], id, retryFields)[0] !== todo) saveEdit(id, retryFields, originalCategoryId);
  });
  check();
}

// Delete task: at once, no confirm. Focus goes to the next row's checkbox, or the composer.
function deleteFromEditor() {
  const id = reminderId;
  const keys = rowFallbackKeys(id);
  closeEditor();
  removeRow(id);
  render(keys);
}

// The sheet is modal: the page behind is inert.
function placeEditor() {
  app.inert = true;
}

// Tab wraps inside the sheet (see the edge guards).
function editorFocusables() {
  return [...editor.querySelectorAll('button, input, select')].filter(
    (element) => !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden]') &&
      !element.classList.contains('reminder-edge'),
  );
}

function markInvalid(field, invalid) {
  if (invalid) {
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', 'reminder-message');
  } else {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
}

function hideMessage() {
  message.hidden = true;
  message.removeAttribute('role');
  messageText.textContent = '';
}

function pickerFields() {
  return {
    on: reminderOn.checked,
    date: dateInput.value,
    time: timeInput.value,
    badInput: Boolean(dateInput.validity?.badInput || timeInput.validity?.badInput),
  };
}

// The instant the picker describes: null for no reminder, undefined when invalid.
function editorDue() {
  return pickerDue(pickerFields(), findTodo(reminderId).due);
}

// The picker control an invalid reminder points at: the date when it is missing, else the time.
function invalidPickerField() {
  return dateInput.value === '' ? dateButton : timeInput;
}

// Save state, field validity, the picker's rows and the one message, from the current inputs.
function syncEditor() {
  const todo = findTodo(reminderId);
  const rawDue = editorDue();
  const invalid = rawDue === undefined;
  const due = invalid ? null : rawDue;
  const showError = invalid && reminderTouched;
  const titleError = readTaskInput(textInput.value).error;
  const showTitleError = titleError !== null && reminderTouched;
  const now = Date.now();

  saveButton.setAttribute('aria-disabled', String(invalid || titleError !== null));
  // One message at a time, title first: only the field it is about points at it.
  markInvalid(textInput, showTitleError);
  markInvalid(timeInput, showError && !showTitleError && dateInput.value !== '');
  markInvalid(dateButton, showError && !showTitleError && dateInput.value === '');

  reminderOn.setAttribute('aria-checked', String(reminderOn.checked));
  pickerDetail.hidden = !reminderOn.checked;
  dateValue.textContent = dateInput.value ? dayLabel(dateInput.value, now) : 'None';
  renderCalendar();

  // "Has passed" only for a newly chosen time (an overdue task being renamed stays as it is).
  let next = null;
  if (showTitleError) next = MESSAGES[titleError === 'empty' ? 'empty' : 'long'];
  else if (showError) next = MESSAGES.invalid;
  else if (due !== null && due !== todo.due && due <= now) next = MESSAGES.past;
  else if (due !== null && todo.completedUntil == null && todo.completed) next = MESSAGES.done;
  else if (due !== null && notificationsBlocked()) next = MESSAGES.blocked;

  if (next === null) {
    hideMessage();
  } else if (messageText.textContent !== next.text || message.hidden) {
    // Only touch the live region when the message changes, so it isn't re-announced per keystroke.
    message.className = `reminder-message is-${next.kind}`;
    if (next.kind === 'error') message.setAttribute('role', 'alert');
    else message.removeAttribute('role');
    messageIcon.replaceChildren(icon(next.icon));
    messageText.textContent = next.text;
    message.hidden = false;
  }
  placeEditor();
}

// --- Task sheet: the inline month calendar -------------------------------------------------

let calendarView = null; // { year, month } on show

function setCalendarOpen(open) {
  calendar.hidden = !open;
  dateButton.setAttribute('aria-expanded', String(open));
  if (open) {
    const shown = parseDate(dateInput.value) ?? parseDate(localDate(Date.now()));
    calendarView = { year: shown.year, month: shown.month };
    renderCalendar();
  }
}

// The day that takes the calendar's one tab stop: the chosen day, today, or the first day shown.
function calendarStop(cells) {
  const days = cells.filter(Boolean).map((cell) => cell.date);
  return [dateInput.value, localDate(Date.now())].find((date) => days.includes(date)) ?? days[0];
}

function renderCalendar() {
  if (calendar.hidden || !calendarView) return;
  const now = Date.now();
  const { year, month } = calendarView;
  const today = localDate(now);
  const cells = monthGrid(year, month);
  const stop = calendarStop(cells);
  // A re-render (a timer, a refresh) keeps focus on the day that had it.
  const focusedDay = calDays.contains(document.activeElement) ? document.activeElement.dataset?.date : undefined;
  calMonth.textContent = monthLabel(year, month);
  const navFocus = [calPrev, calNext].find((control) => control === document.activeElement);
  calPrev.disabled = !canGoBack(year, month);
  if (calWeekdays.children.length === 0) {
    const format = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    // 2026-11-22 is a Sunday: the grid starts on Sunday.
    calWeekdays.replaceChildren(...Array.from({ length: 7 }, (_, index) => {
      const name = document.createElement('span');
      name.textContent = format.format(new Date(2026, 10, 22 + index));
      return name;
    }));
  }
  calDays.replaceChildren(...cells.map((cell) => {
    if (cell === null) return document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cal-day';
    button.dataset.date = cell.date;
    button.setAttribute('aria-label', dayName(cell.date));
    button.setAttribute('aria-pressed', String(cell.date === dateInput.value));
    if (cell.date === today) button.setAttribute('aria-current', 'date');
    button.tabIndex = cell.date === stop ? 0 : -1;
    const number = document.createElement('span');
    number.textContent = String(cell.day);
    button.append(number);
    return button;
  }));
  if (focusedDay) focusCalendarDay(focusedDay);
  // A control that disables itself (Previous month at the first month) must not drop focus out of
  // the sheet: it goes to the chosen day, else the first day, else Next month.
  if (navFocus?.disabled) {
    const target = calDays.querySelector?.(`[data-date="${dateInput.value}"]`) ??
      calDays.querySelector?.('.cal-day') ?? calNext;
    target.focus();
  }
}

function focusCalendarDay(date) {
  calDays.querySelector?.(`[data-date="${date}"]`)?.focus();
}

// A day chosen in the calendar: the hidden native date input holds it; a time starts at 9:00 AM.
function chooseDay(date) {
  dateInput.value = date;
  if (timeInput.value === '') timeInput.value = DEFAULT_TIME;
  reminderTouched = true;
  syncEditor();
}

function showMonth(delta) {
  calendarView = addMonths(calendarView.year, calendarView.month, delta);
  renderCalendar();
}

// --- Categories: the Manage panel ------------------------------------------------------------

// An in-page panel under the filter row (not a dialog, so the task sheet never stacks on it).
// Category writes wait for the server: the list changes only once it has answered.

function setPanelStatus(text, error = false) {
  categoryStatus.textContent = text;
  categoryStatus.classList.toggle('is-error', error);
}

function openPanel() {
  panel.hidden = false;
  panelSignature = null;
  setPanelStatus('');
  render();
  panelTitle.focus();
}

// Hides the panel and drops its rows; `returnFocus` puts focus back on Manage.
function closePanel(returnFocus) {
  panel.hidden = true;
  panelRow = null;
  panelSignature = null;
  categoryList.replaceChildren();
  categoryName.removeAttribute('aria-invalid');
  setPanelStatus('');
  manageButton.setAttribute('aria-expanded', 'false');
  if (returnFocus) manageButton.focus();
}

function panelButton(text, action, id, className = 'text-button') {
  const button = withKey(document.createElement('button'), `category-${action}`, id);
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.textContent = text;
  if (panelBusy !== null) button.setAttribute('aria-disabled', 'true');
  return button;
}

// One row: the name with Rename and Delete, the rename field, or the delete question.
function renderCategoryRow(category) {
  const { id, name } = category;
  const item = document.createElement('li');
  item.className = 'category-item';
  item.dataset.id = id;
  if (panelBusy?.id === id) item.setAttribute('aria-busy', 'true');
  const mode = panelRow?.id === id ? panelRow.mode : null;
  const actions = document.createElement('div');
  actions.className = 'category-actions';
  if (mode === 'rename') {
    item.classList.add('is-renaming');
    const field = withKey(document.createElement('input'), 'category-field', id);
    field.type = 'text';
    field.className = 'category-field';
    field.value = panelRow.value;
    field.autocomplete = 'off';
    field.enterKeyHint = 'done';
    field.setAttribute('aria-label', `New name for ${name}`);
    if (panelRow.invalid) field.setAttribute('aria-invalid', 'true');
    actions.append(panelButton('Cancel', 'cancel', id), panelButton('Save', 'save', id, 'add-button'));
    item.append(field, actions);
  } else if (mode === 'confirm') {
    item.classList.add('is-confirming');
    const question = document.createElement('p');
    question.className = 'category-question';
    question.id = `category-question-${id}`;
    question.textContent = DELETE_QUESTION;
    const cancel = panelButton('Cancel', 'cancel', id);
    const remove = panelButton('Delete', 'confirm', id, 'add-button category-confirm');
    for (const button of [cancel, remove]) button.setAttribute('aria-describedby', question.id);
    remove.setAttribute('aria-label', `Delete ${name}`);
    actions.append(cancel, remove);
    item.append(question, actions);
  } else {
    const label = document.createElement('span');
    label.className = 'category-name';
    label.textContent = name;
    const rename = panelButton('Rename', 'rename', id);
    rename.setAttribute('aria-label', `Rename ${name}`);
    const remove = panelButton('Delete', 'delete', id, 'text-button category-delete');
    remove.setAttribute('aria-label', `Delete ${name}`);
    actions.append(rename, remove);
    item.append(label, actions);
  }
  return item;
}

// Rows are rebuilt only when what they show changes, so a timed render doesn't replace the
// rename field being typed in.
function renderPanel() {
  manageButton.setAttribute('aria-expanded', String(!panel.hidden));
  if (panel.hidden) return;
  const catalog = sync.categories ?? [];
  categoryEmpty.hidden = catalog.length > 0;
  categoryAdd.setAttribute('aria-disabled', String(panelBusy !== null));
  const signature = JSON.stringify([catalog, panelRow && [panelRow.id, panelRow.mode], panelBusy]);
  if (signature === panelSignature) return;
  panelSignature = signature;
  categoryList.replaceChildren(...catalog.map(renderCategoryRow));
}

// Focus for after a row goes away: the next row, the previous one, else the name field.
function rowNeighbourKeys(id) {
  const catalog = sync.categories ?? [];
  const index = catalog.findIndex((category) => category.id === id);
  return [catalog[index + 1], catalog[index - 1]].filter(Boolean)
    .map((category) => key('category-rename', category.id)).concat(key('category-name'));
}

async function createCategory() {
  if (panelBusy !== null || !sync.categories) return;
  const { name, error } = readCategoryName(categoryName.value);
  if (error) {
    categoryName.setAttribute('aria-invalid', 'true');
    setPanelStatus(NAME_MESSAGES[error], true);
    categoryName.focus();
    return;
  }
  const retry = categoryCreateDraft?.name === name;
  if (!retry) categoryCreateDraft = { id: crypto.randomUUID(), name };
  const epoch = viewEpoch;
  panelBusy = { id: null, kind: 'create' };
  setPanelStatus('Adding…');
  render();
  const todos = sync.confirmed;
  const result = await sync.createCategory(name, categoryCreateDraft.id, retry);
  if (result.stale || epoch !== viewEpoch) return;
  panelBusy = null;
  if (sync.confirmed !== todos) check();
  if (result.ok) {
    categoryCreateDraft = null;
    if (readCategoryName(categoryName.value).name === name) categoryName.value = '';
    setPanelStatus(`Added “${result.category.name}”.`);
  } else if (!handleSessionError(result.error)) {
    setPanelStatus(categoryErrorText(result.error, result.reloaded), true);
  }
  render();
}

async function renameCategory(id) {
  const category = findCategory(id);
  if (panelBusy !== null || !category || panelRow?.id !== id) return;
  const { revision } = panelRow;
  const { name, error } = readCategoryName(panelRow.value);
  if (error) {
    panelRow.invalid = true;
    panelSignature = null;
    setPanelStatus(NAME_MESSAGES[error], true);
    render([key('category-field', id)]);
    return;
  }
  if (name === category.name && revision === category.revision) {
    panelRow = null;
    render([key('category-rename', id)]);
    return;
  }
  const epoch = viewEpoch;
  panelBusy = { id, kind: 'rename' };
  setPanelStatus('Saving…');
  render();
  const result = await sync.renameCategory(id, name, revision);
  if (result.stale || epoch !== viewEpoch) return;
  panelBusy = null;
  if (result.ok) {
    panelRow = null;
    setPanelStatus(`Renamed to “${name}”.`);
    render([key('category-rename', id)]);
    return;
  }
  if (handleSessionError(result.error)) return;
  if (result.reloaded) check();
  if (result.error?.status === 409 || sync.categoryRefreshRequired) panelRow = null;
  setPanelStatus(categoryErrorText(result.error, result.reloaded), true);
  render([key(panelRow ? 'category-field' : 'category-rename', id), ...rowNeighbourKeys(id)]);
}

async function deleteCategory(id) {
  if (panelBusy !== null || panelRow?.mode !== 'confirm' || panelRow.id !== id) return;
  const { name, revision } = panelRow;
  const epoch = viewEpoch;
  const fallback = rowNeighbourKeys(id);
  panelBusy = { id, kind: 'delete' };
  setPanelStatus('Deleting…');
  render();
  const result = await sync.deleteCategory(id, revision);
  if (result.stale || epoch !== viewEpoch) return;
  panelBusy = null;
  panelRow = null; // after a failure, deleting again needs a fresh confirmation
  if (handleSessionError(result.error)) return;
  if (result.ok || result.reloaded || result.repairFailed) check();
  if (result.repairFailed) {
    setPanelStatus('');
    showSync("The task list couldn't be refreshed after deleting the category.", reloadList);
    render(fallback);
    return;
  }
  if (result.ok || (result.error?.status !== 409 && result.reloaded && !findCategory(id))) {
    setPanelStatus(`Deleted “${name}”. Its tasks are uncategorized now.`);
    render(fallback);
    return;
  }
  setPanelStatus(categoryErrorText(result.error, result.reloaded), true);
  render([key('category-delete', id), ...fallback]);
}

manageButton.addEventListener('click', () => {
  if (panel.hidden) openPanel();
  else closePanel(true);
});
panelDone.addEventListener('click', () => closePanel(true));

categoryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  createCategory();
});
categoryName.addEventListener('input', () => categoryName.removeAttribute('aria-invalid'));

categoryList.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  const id = button?.closest('.category-item')?.dataset.id;
  if (!id || panelBusy !== null) return;
  const { action } = button.dataset;
  if (action === 'rename' || action === 'delete') {
    if (sync.categoryRefreshRequired) {
      const epoch = viewEpoch;
      panelBusy = { id, kind: 'refresh' };
      render();
      const result = await sync.load();
      if (result.stale || epoch !== viewEpoch) return;
      panelBusy = null;
      if (!result.ok) {
        if (!handleSessionError(result.error)) setPanelStatus("The latest list couldn't be loaded.", true);
        render();
        return;
      }
      check();
      if (panel.hidden || !findCategory(id)) {
        render(rowNeighbourKeys(id));
        return;
      }
    }
    const category = findCategory(id);
    if (!category) return;
    const renaming = action === 'rename';
    panelRow = renaming
      ? { id, mode: 'rename', value: category.name, revision: category.revision }
      : { id, mode: 'confirm', name: category.name, revision: category.revision };
    setPanelStatus('');
    render([key(renaming ? 'category-field' : 'category-cancel', id)]);
  } else if (action === 'cancel') {
    const mode = panelRow?.mode;
    panelRow = null;
    setPanelStatus('');
    render([key(mode === 'confirm' ? 'category-delete' : 'category-rename', id)]);
  } else if (action === 'save') {
    renameCategory(id);
  } else if (action === 'confirm') {
    deleteCategory(id);
  }
});

categoryList.addEventListener('input', (event) => {
  if (!event.target.matches('.category-field') || panelRow?.mode !== 'rename') return;
  panelRow.value = event.target.value;
  panelRow.invalid = false;
  event.target.removeAttribute('aria-invalid');
});

categoryList.addEventListener('keydown', (event) => {
  if (!event.target.matches('.category-field') || event.isComposing) return;
  const { id } = event.target.closest('.category-item').dataset;
  if (event.key === 'Enter') {
    event.preventDefault();
    renameCategory(id);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    panelRow = null;
    setPanelStatus('');
    render([key('category-rename', id)]);
  }
});

// Esc backs out one step: a delete question first, else the whole panel.
panel.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
  if (panelRow) {
    const { id } = panelRow;
    panelRow = null;
    render([key('category-delete', id)]);
  } else {
    closePanel(true);
  }
});

// --- Composer: the + button by the title reveals the new-task field --------------------------

function setComposerOpen(open) {
  form.hidden = !open;
  addToggle.setAttribute('aria-expanded', String(open));
  syncAddButton();
}

// Where focus goes back to after an action: the field while it is open, else the + button.
function focusComposer() {
  (form.hidden ? addToggle : input).focus();
}

// + opens the field and focuses it (on a phone, the keyboard comes up); pressed again it closes,
// keeping what was typed.
addToggle.addEventListener('click', () => {
  setComposerOpen(form.hidden);
  focusComposer();
});

// On the form, so Escape works from the Add button too; not while an IME composition is open.
form.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
  setComposerOpen(false);
  addToggle.focus();
});

// --- Events --------------------------------------------------------------------------------

input.addEventListener('input', syncAddButton);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = input.value;
  const { text, error } = readTaskInput(raw);
  if (error !== null || phase !== 'ready') return;
  const [todo] = addTodo([], text);
  // Re-adding a draft whose save was uncertain sends the same ID: a 409 then means it was saved.
  const retryIds = createDrafts.get(todo.text);
  if (retryIds) {
    todo.id = retryIds.shift();
    if (retryIds.length === 0) createDrafts.delete(todo.text);
  }
  hideSync();
  const result = sync.create(todo);
  // Under a category filter the new (uncategorized) task isn't shown: say where it went.
  if (findCategory(filter)) announce(`Added “${todo.text}” to Uncategorized.`);
  // The field stays open for the next task.
  input.value = '';
  addButton.disabled = true;
  render();
  input.focus();
  const outcome = await result;
  if (outcome.ok || outcome.stale) return;
  // A duplicate ID whose reload failed is uncertain too: keep the ID for the next try.
  const { status, code } = outcome.error ?? {};
  const uncertain = !outcome.error || status === 0 || status >= 500 || code === 'DUPLICATE_ID';
  if (uncertain) createDrafts.set(todo.text, [...(createDrafts.get(todo.text) ?? []), todo.id]);
  const sessionError = handleSessionError(outcome.error);
  // The draft goes back into the field unless something new was typed meanwhile, and the field
  // reopens if it was closed, so the draft can be retried. Not mid-press (that would move the
  // pressed control), and not if the view has since been cleared for another session.
  const epoch = viewEpoch;
  whenReleased(() => {
    if (epoch !== viewEpoch || phase !== 'ready') return;
    if (input.value === '') {
      input.value = raw;
      syncAddButton();
    }
    if (form.hidden) setComposerOpen(true);
    if (!sessionError) showSync(`Couldn't add “${text}”.`);
  });
});

categoryFilter.addEventListener('change', () => {
  filter = keepFilter(categoryFilter.value, sync.categories);
  render();
});

list.addEventListener('change', (event) => {
  if (!event.target.matches('.todo-checkbox')) return;
  const { id } = event.target.closest('.todo').dataset;
  toggle(id);
  render([key('checkbox', id)]);
});

function toggle(id) {
  const before = findTodo(id);
  if (!before) return;
  const now = Date.now();
  const [after] = toggleTodo([before], id, now);
  fired.delete(id);
  saved(id, sync.toggle(id, now, before), () => {
    const current = findTodo(id);
    if (current && current.due === before.due &&
        (current.completedUntil ?? null) === (before.completedUntil ?? null) &&
        isCompleted(current, Date.now()) === isCompleted(before, now)) toggle(id);
  });
  if (after.due !== before.due) {
    // The row's stamp shows it; screen readers hear it from the status region.
    announce(`“${after.text}” is next due ${formatDue(after.due, now)}.`);
  }
  check();
}

function removeRow(id) {
  saved(id, sync.remove(id), () => findTodo(id) && removeRow(id));
  check();
}

list.addEventListener('click', (event) => {
  const row = event.target.closest('.todo');
  if (!row) return;
  const { id } = row.dataset;
  // Any tap or click on a just-fired row ends its highlight.
  dismissFired(id);
  // The body is one button that opens the task sheet.
  const button = event.target.closest('.todo-open');
  if (!button) return;
  if (reminderId === id) cancelEditor();
  else openEditor(id);
});

// --- Reorder ---------------------------------------------------------------------------------

const REORDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

// The rows that can be reordered, as shown: the filtered view below its overdue block.
function reorderableIds(now = Date.now()) {
  return visibleTodos(now).filter((todo) => !isOverdue(todo, now)).map((todo) => todo.id);
}

// Sends one move (applied at once, rolled back if the server refuses it) and says where the task
// went, counted among the rows shown.
function reorder(id, target) {
  if (reorderLocked()) return;
  const todo = findTodo(id);
  if (!todo) return;
  saved(id, sync.move(id, target.anchorId, target.side), () => {
    if (findTodo(id) && findTodo(target.anchorId)) reorder(id, target);
  });
  const ids = reorderableIds();
  announce(`Moved “${todo.text}” to position ${ids.indexOf(id) + 1} of ${ids.length}.`);
}

// Keyboard: Up/Down (Alt or not) move one place, Home/End to the first/last place.
list.addEventListener('keydown', (event) => {
  const handle = event.target.closest('.todo-handle');
  if (!handle || drag || reorderLocked() || !REORDER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
  event.preventDefault(); // the arrows would scroll the page
  const { id } = handle.closest('.todo').dataset;
  const todo = findTodo(id);
  if (!todo) return;
  const target = keyboardTarget(reorderableIds(), id, event.key);
  if (!target) {
    const top = event.key === 'ArrowUp' || event.key === 'Home';
    announce(`“${todo.text}” is already ${top ? 'first' : 'last'}.`);
    return;
  }
  reorder(id, target);
  render([key('handle', id)]);
});

// Pointer drag (touch, pen and mouse) on the handle. The handle has touch-action: none, so a
// drag that starts on it never scrolls the page; everywhere else scrolls as usual. Renders wait
// for the press to end (see `pressing`), so the rows stay put under the finger.
let drag = null;

list.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.todo-handle');
  if (!handle || drag || reorderLocked() || app.inert || event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault(); // no text selection, and the handle doesn't take focus from a field
  const row = handle.closest('.todo');
  const ids = new Set(reorderableIds());
  const rows = [...list.children].filter((item) => ids.has(item.dataset.id));
  if (rows.length < 2 || !rows.includes(row)) return;
  const measured = rows.map((item) => {
    const rect = item.getBoundingClientRect();
    return { id: item.dataset.id, top: rect.top + window.scrollY, height: rect.height };
  });
  const state = createDrag(measured, row.dataset.id, event.clientY + window.scrollY);
  const slot = document.createElement('li');
  slot.className = 'todo-slot';
  slot.setAttribute('aria-hidden', 'true');
  slot.style.height = `${measured[state.from].height}px`;
  list.append(slot);
  drag = {
    state, row, handle, rows, slot,
    pointerId: event.pointerId,
    clientY: event.clientY,
    frame: requestAnimationFrame(autoScroll),
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Not capturable (already released): the drag still follows the pointer until it ends.
  }
  handle.addEventListener('pointermove', onDragMove);
  handle.addEventListener('pointerup', onDragEnd);
  handle.addEventListener('pointercancel', onDragCancel);
  handle.addEventListener('lostpointercapture', onDragEnd);
  list.classList.add('is-reordering');
  document.documentElement.classList.add('is-reordering');
  row.classList.add('is-lifted');
  layoutDrag();
});

function onDragMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.clientY = event.clientY;
  layoutDrag();
}

function onDragEnd(event) {
  if (drag && event.pointerId === drag.pointerId) endDrag(true);
}

function onDragCancel(event) {
  if (drag && event.pointerId === drag.pointerId) endDrag(false);
}

// Places the lifted row under the pointer, slides the rows it passes, and draws the gap.
function layoutDrag() {
  const { state, row, rows, slot } = drag;
  if (!row.isConnected) {
    endDrag(false); // the list was rebuilt under the drag (a session change, say)
    return;
  }
  state.move(drag.clientY + window.scrollY);
  row.style.transform = `translateY(${state.offset}px)`;
  const shifts = state.shifts();
  for (const item of rows) {
    if (item !== row) item.style.transform = shifts[item.dataset.id] ? `translateY(${shifts[item.dataset.id]}px)` : '';
  }
  const listTop = list.getBoundingClientRect().top + window.scrollY + list.clientTop;
  slot.style.top = `${state.slotTop() - listTop}px`;
  // Visual only: screen readers use the keyboard reorder and its announcement.
  dragStatus.textContent = `Moving to position ${state.index + 1} of ${rows.length}`;
  dragStatus.hidden = false;
}

// Near the top or bottom of the screen the page scrolls, and the row with it.
function autoScroll() {
  if (!drag) return;
  const step = autoScrollStep(drag.clientY, window.innerHeight);
  if (step) {
    const before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY !== before) layoutDrag();
  }
  if (drag) drag.frame = requestAnimationFrame(autoScroll);
}

// Drops (commit) or puts the row back. A drop moves the row in the page at once, so it doesn't
// flash back to its old place before the held render shows the saved order.
function endDrag(commit) {
  if (!drag) return;
  const { state, row, handle, rows, slot, frame } = drag;
  drag = null;
  cancelAnimationFrame(frame);
  handle.removeEventListener('pointermove', onDragMove);
  handle.removeEventListener('pointerup', onDragEnd);
  handle.removeEventListener('pointercancel', onDragCancel);
  handle.removeEventListener('lostpointercapture', onDragEnd);
  for (const item of rows) item.style.transform = '';
  slot.remove();
  dragStatus.hidden = true;
  list.classList.remove('is-reordering');
  document.documentElement.classList.remove('is-reordering');
  row.classList.remove('is-lifted');
  const target = commit && row.isConnected ? state.target() : null;
  if (!target) return;
  const anchor = rows.find((item) => item.dataset.id === target.anchorId);
  anchor.parentNode.insertBefore(row, target.side === 'before' ? anchor : anchor.nextSibling);
  reorder(row.dataset.id, target);
}

// While dragging: Esc puts the row back, and iOS gets no chance to scroll or zoom.
document.addEventListener('keydown', (event) => {
  if (drag && event.key === 'Escape') {
    event.preventDefault();
    endDrag(false);
  }
});
document.addEventListener('touchmove', (event) => {
  if (drag) event.preventDefault();
}, { passive: false });
window.addEventListener('blur', () => endDrag(false));

// Focus landing on a just-fired row (by Tab or click) ends its highlight.
list.addEventListener('focusin', (event) => {
  if (!rendering) dismissFired(event.target.closest('.todo')?.dataset.id);
});

// Esc ends every highlight. Capture phase, so it also runs when the Manage panel or the task
// sheet uses the same Esc to close (they still do; this neither stops nor prevents the event).
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismissAllFired();
}, true);

// Reduced motion turned on mid-pulse: CSS drops the animation without an animationend.
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) dismissAllFired();
});

// The end of the 2 pulses ends the highlight.
list.addEventListener('animationend', (event) => {
  if (event.animationName === 'reminder-pulse') dismissFired(event.target.closest('.todo')?.dataset.id);
});

bannerDismiss.addEventListener('click', () => {
  if (banner.classList.contains('is-note')) dismissNote();
  else hideBanner();
  focusComposer();
});

for (const field of [textInput, timeInput, dateInput]) {
  field.addEventListener('input', () => {
    reminderTouched = true;
    syncEditor();
  });
}
// Safari's time field reports its value on change.
timeInput.addEventListener('change', () => {
  reminderTouched = true;
  syncEditor();
});
repeatSelect.addEventListener('change', syncEditor);

// The Reminder switch: on with no date starts at today 9:00 AM (or tomorrow) and opens the
// calendar; off keeps the fields, so turning it back on restores them.
reminderOn.addEventListener('change', () => {
  if (reminderOn.checked && dateInput.value === '') {
    const start = defaultReminder(Date.now());
    dateInput.value = start.date;
    if (timeInput.value === '') timeInput.value = start.time;
    setCalendarOpen(true);
  }
  if (!reminderOn.checked) setCalendarOpen(false);
  syncEditor();
});

dateButton.addEventListener('click', () => {
  setCalendarOpen(calendar.hidden);
});
calPrev.addEventListener('click', () => showMonth(-1));
calNext.addEventListener('click', () => showMonth(1));
calDays.addEventListener('click', (event) => {
  const day = event.target.closest?.('.cal-day');
  if (!day || day.disabled) return;
  chooseDay(day.dataset.date);
  focusCalendarDay(day.dataset.date);
});
// Arrow keys move a day or a week (into the next or previous month).
calDays.addEventListener('keydown', (event) => {
  const day = event.target.closest?.('.cal-day');
  const delta = CALENDAR_KEYS[event.key];
  if (!day || delta === undefined) return;
  event.preventDefault();
  const date = addDays(day.dataset.date, delta);
  if (date < EARLIEST_DAY) return;
  const target = parseDate(date);
  if (target.year !== calendarView.year || target.month !== calendarView.month) {
    calendarView = { year: target.year, month: target.month };
  }
  renderCalendar();
  for (const button of calDays.children) if (button.dataset?.date) button.tabIndex = button.dataset.date === date ? 0 : -1;
  focusCalendarDay(date);
});

editCategory.addEventListener('change', () => {
  if (reminderId === null || !sync.categories) return;
  draft.chosenCategoryId = editCategory.value || null;
  tintEditor();
});

saveButton.addEventListener('click', saveEditor);
cancelButton.addEventListener('click', cancelEditor);
deleteButton.addEventListener('click', deleteFromEditor);
scrim.addEventListener('click', cancelEditor);

editor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (event.isComposing) return; // Esc cancels the IME composition, not the draft
    event.preventDefault();
    cancelEditor();
  } else if (event.key === 'Enter' && !event.isComposing && (event.target === timeInput || event.target === textInput)) {
    event.preventDefault();
    saveButton.click(); // the same path as clicking Save (the only place permission is asked)
  }
});

// Tab stays inside the sheet and wraps: focus reaching an edge guard goes round to the other end.
// Guards rather than a Tab key handler, because Tab also moves between the time field's parts.
editorStart.addEventListener('focus', () => editorFocusables().at(-1)?.focus());
editorEnd.addEventListener('focus', () => editorFocusables()[0]?.focus());

// Coming back to the tab: overdue marks catch up at once. The auth module re-reads the session
// and then sends `tasks:session`, which reloads the list before any reminder is claimed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderSoon(renderPending ? pendingFocus : undefined);
});

syncRetry.addEventListener('click', () => {
  const action = retryAction;
  hideSync();
  focusComposer();
  action?.();
});
syncDismiss.addEventListener('click', () => {
  hideSync();
  focusComposer();
});

// --- Saving and the session ----------------------------------------------------------------

function showSync(text, retry) {
  syncText.textContent = text;
  retryAction = retry ?? null;
  syncRetry.hidden = !retry;
  syncNote.hidden = false;
}

function hideSync() {
  syncNote.hidden = true;
  syncText.textContent = '';
  retryAction = null;
}

// 401: the session is over, back to sign-in. INVALID_CSRF: the session changed in another tab
// (signed out, or another account signed in), so the auth module re-reads it and this view resets
// for whoever is signed in now. Returns true when the error was one of those.
function handleSessionError(error) {
  if (error?.status === 401) {
    window.dispatchEvent(new CustomEvent('tasks:expired'));
    return true;
  }
  if (error?.code === 'INVALID_CSRF') {
    if (revalidating) {
      showSync('This change was blocked. Reload the page and try again.');
    } else {
      hideForRevalidation();
      revalidating = true;
      window.dispatchEvent(new CustomEvent('tasks:revalidate'));
    }
    return true;
  }
  return false;
}

// Reports a failed save. The change has already dropped out of the list (and a conflict has
// reloaded it); `retry` repeats the same change if it still applies.
async function saved(id, result, retry) {
  const epoch = viewEpoch;
  const outcome = await result;
  if (outcome.stale || epoch !== viewEpoch) return;
  if (outcome.ok) {
    rearm(Date.now());
    return;
  }
  // The change rolled back (a deleted row came back, say): recheck reminders and re-arm the timer.
  check();
  if (outcome.skipped) return; // the row is gone
  if (outcome.cancelled) {
    // The user acted before seeing the refreshed row.
    showSync(CHANGED_ELSEWHERE);
    return;
  }
  const { error } = outcome;
  if (handleSessionError(error)) return;
  if (error.status === 409 || error.status === 404) {
    if (outcome.reloaded) {
      showSync(CHANGED_ELSEWHERE);
    } else {
      showSync("This task changed in another tab or device, and the latest list couldn't be loaded. Try again.", reloadList);
    }
  } else if (error.status === 400) {
    showSync("Couldn't save that change.");
  } else {
    const retryNow = () => reconcileThen(id, outcome.revision, retry, epoch);
    showSync("Couldn't save your change.", retryNow);
  }
}

// After an uncertain failure the change may have been saved anyway (only the answer was lost),
// and another tab may have acted on it since. Reload first. Re-send only if the row is still at
// `revision`, the one the change was sent against: then neither it nor anything else landed.
// Any other revision means the row moved on (this change, or a later edit elsewhere, such as a
// recurring reminder that was claimed and advanced). The server's row is kept and shown, and
// nothing is re-sent or re-alerted.
async function reconcileThen(id, revision, retry, epoch) {
  if (epoch !== viewEpoch) return;
  const result = await sync.load();
  if (result.stale || epoch !== viewEpoch) return;
  if (!result.ok) {
    if (!handleSessionError(result.error)) {
      showSync("Couldn't save your change.", () => reconcileThen(id, revision, retry, epoch));
    }
    return;
  }
  const row = findTodo(id);
  if (row && row.revision === revision) retry?.();
  else if (row) showSync('This task was updated, possibly by your change. The list is up to date now. Check it and try again if needed.');
  check();
}

async function reloadList() {
  const result = await sync.load();
  if (result.stale) return;
  if (result.ok) check();
  else if (!handleSessionError(result.error)) {
    showSync("The latest list couldn't be loaded.", reloadList);
  }
}

// Leaves nothing of the previous session on the page: rows, filters, editors, drafts, alerts and
// timers. Answers still on their way for that session are ignored when they arrive.
function clearView() {
  viewEpoch += 1;
  afterPress.length = 0;
  sync.reset();
  state = [];
  viewSignature = '[]';
  filter = ALL;
  if (reminderId !== null) closeEditor();
  // No category of the old account stays in the selects, the panel or the sheet's tint.
  closePanel(false);
  panelBusy = null;
  categoryCreateDraft = null;
  categoryName.value = '';
  optionsSignature = null;
  renderCategoryOptions();
  delete editor.dataset.color;
  // Nothing of the old account stays in the hidden sheet or the live regions.
  editor.removeAttribute('aria-label');
  textInput.value = '';
  // Hiding the composer would drop focus to the page; the + button keeps it. The auth flow may
  // still move it on to sign-in or retry.
  const composerFocused = [input, addButton].includes(document.activeElement);
  setComposerOpen(false);
  if (composerFocused) addToggle.focus();
  reminderOn.checked = false;
  dateInput.value = '';
  timeInput.value = '';
  repeatSelect.value = 'none';
  announcer.textContent = '';
  editorAnnouncer.textContent = '';
  for (const notification of openNotifications) {
    try {
      notification.close();
    } catch {
      // Already gone.
    }
  }
  openNotifications.clear();
  fired.clear();
  claiming.clear();
  claimBackoff.clear();
  clearTimeout(timer);
  clearTimeout(recheckTimer);
  hideBanner();
  hideSync();
  input.value = '';
  createDrafts.clear();
  revalidating = false;
  resuming = false;
}

// The session may have changed (another tab signed in or out, or a request was refused): hide
// the list, drop its pending changes and alerts, and ignore answers still on their way until the
// auth module has re-read the session and sent `tasks:session`.
function hideForRevalidation() {
  if (phase === 'signed-out') return;
  clearView();
  phase = 'loading';
  render();
}

window.addEventListener('tasks:invalidate', hideForRevalidation);

async function loadList() {
  const result = await sync.load();
  if (result.stale) return;
  if (result.ok) {
    if (retryAction === startLoading) hideSync();
    const wasReady = phase === 'ready';
    phase = 'ready';
    // A press may be in progress: don't replace the row under it. Keep any focus already queued.
    if (wasReady) renderSoon(renderPending ? pendingFocus : undefined);
    else render();
    check(); // missed reminders alert once, after the list is current
    return;
  }
  if (handleSessionError(result.error)) return;
  if (phase === 'ready') {
    check(); // keep the list shown; claims still check against the server
    return;
  }
  phase = 'error';
  showSync("Couldn't load your tasks", startLoading);
  render();
}

function startLoading() {
  phase = 'loading';
  render();
  return loadList();
}

async function resume() {
  if (resuming || phase === 'signed-out') return;
  resuming = true;
  try {
    if (phase === 'ready') await loadList();
    else await startLoading();
  } finally {
    resuming = false;
  }
}

// From the auth module: `active` is the session now signed in, or null when signed out.
window.addEventListener('tasks:session', ({ detail: { active } }) => {
  if (!active) {
    clearView();
    phase = 'signed-out';
    sessionToken = null;
    sessionEmail = null;
    render();
    return;
  }
  if (active.csrfToken === sessionToken) {
    // The same session, re-read on return to the tab or after a blocked request.
    if (revalidating) {
      revalidating = false;
      resume();
      showSync('This change was blocked. Reload the page and try again.');
      return;
    }
    resume();
    return;
  }
  const switched = sessionEmail !== null && sessionEmail !== active.user.email;
  clearView();
  api.setToken(active.csrfToken);
  sessionToken = active.csrfToken;
  sessionEmail = active.user.email;
  startLoading();
  if (switched) showSync(`You're now signed in as ${active.user.name || active.user.email} in this browser.`);
});

render();
