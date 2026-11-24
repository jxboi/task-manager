import {
  addTodo,
  editTodo,
  toggleTodo,
  allTags,
  filterByTags,
  dueReminders,
  nextFireTime,
  sortByUrgency,
} from './todos.js';
import { MAX_TAGS, normalizeTag, tagColor } from './tags.js';
import { isCompleted, isOverdue } from './reminders.js';
import * as api from './storage.js';
import { createSync } from './sync.js';
import { readTaskEdit, readTaskInput } from './task-input.js';
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
const summaryRow = document.getElementById('summary-row');
const clearFilters = document.getElementById('clear-filters');
const hintLimit = document.getElementById('hint-limit');
const filterWrap = document.getElementById('filter-wrap');
const filterBar = document.getElementById('filter-bar');
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
const editTags = document.getElementById('edit-tags');
const tagAdd = document.getElementById('edit-tag-add');
const tagField = document.getElementById('edit-tag-field');
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
const xIcon = document.getElementById('x-icon');
const repeatIcon = document.getElementById('repeat-icon');
const alertIcon = document.getElementById('alert-icon');
const infoIcon = document.getElementById('info-icon');
const gripIcon = document.getElementById('grip-icon');
const syncNote = document.getElementById('sync-note');
const syncText = document.getElementById('sync-text');
const syncRetry = document.getElementById('sync-retry');
const syncDismiss = document.getElementById('sync-dismiss');

const sheetViewport = createSheetViewport({ layer, body: sheetBody });

const INVALID_FLASH_MS = 400;
const MAX_DELAY = 2 ** 31 - 1; // setTimeout's limit (about 24.8 days); check() re-arms when it fires
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE_MS = 2 * 1200; // the fired row's 2 pulses (styles.css reminder-pulse)
// A claim the server refused while this tab still sees the occurrence as due (its clock is ahead,
// say) waits this long before it is tried again. So does a claim that failed to reach the server.
const CLAIM_RETRY_MS = 30_000;
const NOTE_DISMISSED_KEY = 'task-manager.blocked-note-dismissed';

const CHANGED_ELSEWHERE = 'This task changed in another tab or device. The list is up to date now, so try again.';

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
// Creates that may or may not have reached the server: the parsed task (text and every tag it
// gets, active filter included) -> their IDs, oldest first. Adding exactly the same task again
// reuses one of those IDs, so a create that did land can't be doubled. A different task (other
// text, or the same text under another filter) never takes an ID that isn't its own.
const createDrafts = new Map();
const draftKey = (text, tags) => JSON.stringify([text, tags]);
let retryAction = null;
const claiming = new Set(); // "id:due" occurrences being claimed by this tab
const claimBackoff = new Map(); // "id:due" -> time before which it isn't claimed again
let recheckTimer;
const openNotifications = new Set(); // closed when the session ends
// View state: never saved, never in the URL.
let activeTags = []; // A to Z
let reminderId = null; // todo whose task sheet is open
let draft = null; // the sheet's starting point: { text, tags, due, repeat } of that todo
let draftTags = []; // the tags the sheet will save (a copy of the todo's, edited by its chips)
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
// but the revision), so an answer arriving mid-typing doesn't replace the "+ tag" field.
function syncChanged() {
  state = sync.todos;
  // A filter tag drops out once no todo uses it; with none left the view is back to All.
  const inUse = new Set(state.flatMap((todo) => todo.tags));
  activeTags = activeTags.filter((tag) => inUse.has(tag));
  const signature = JSON.stringify(state.map(({ revision, ...todo }) => todo));
  if (signature !== viewSignature) {
    viewSignature = signature;
    renderSoon(renderPending ? pendingFocus : undefined);
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

// The list as shown: the tag filter, then overdue todos on top. Used by the list and fallback
// focus, so they always agree.
function visibleTodos(now) {
  return sortByUrgency(filterByTags(state, activeTags), now);
}

function setFilter(tags, focusKeys) {
  activeTags = [...tags].sort();
  render(focusKeys);
}

function toggleFilter(tag, focusKeys) {
  setFilter(
    activeTags.includes(tag) ? activeTags.filter((active) => active !== tag) : [...activeTags, tag],
    focusKeys,
  );
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

function renderFilterChip(tag, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'filter-chip';

  const name = document.createElement('span');
  const number = document.createElement('span');
  number.className = 'filter-count';
  number.textContent = count;

  if (tag === null) {
    withKey(button, 'filter');
    button.classList.add('filter-all');
    button.setAttribute('aria-pressed', String(activeTags.length === 0));
    button.setAttribute('aria-label', `All, ${plural(count, 'task')}`);
    name.textContent = 'All';
  } else {
    withKey(button, 'filter', tag);
    button.dataset.tag = tag;
    button.dataset.color = tagColor(tag);
    button.setAttribute('aria-pressed', String(activeTags.includes(tag)));
    button.setAttribute('aria-label', `${tag}, ${plural(count, 'task')}`);
    name.textContent = `#${tag}`;
  }

  button.append(name, number);
  return button;
}

// A row's tag: "#name" with its dot. Not interactive: the filter bar filters, the sheet edits.
function renderTagChip(tag) {
  const chip = document.createElement('span');
  chip.className = 'tag';
  chip.dataset.color = tagColor(tag);
  const label = document.createElement('span');
  label.className = 'tag-label';
  label.dataset.tag = tag;
  label.textContent = `#${tag}`;
  chip.append(label);
  return chip;
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

// The body button's name: the title plus what the stamp and tags show, then the action.
function rowName(todo, overdue, ticked, now) {
  const parts = [todo.text];
  if (todo.due !== null) {
    const when = formatDue(todo.due, now);
    const repeats = todo.repeat === 'none' ? '' : `, repeats ${todo.repeat}`;
    if (ticked) parts.push(`Done today, next due ${when}${repeats}`);
    else if (overdue) parts.push(`Overdue, was due ${when}${repeats}`);
    else parts.push(`Reminder ${when}${repeats}`);
  }
  if (todo.tags.length > 0) parts.push(`Tags: ${todo.tags.join(', ')}`);
  parts.push('Edit task');
  return parts.join('. ');
}

function renderTodo(todo, now) {
  const completed = isCompleted(todo, now);
  const overdue = isOverdue(todo, now);
  const ticked = isTicked(todo, now);
  const item = document.createElement('li');
  item.className = completed && !ticked ? 'todo is-done' : 'todo';
  item.classList.toggle('is-ticked', ticked);
  item.classList.toggle('is-overdue', overdue);
  item.classList.toggle('is-editing', reminderId === todo.id);
  item.dataset.id = todo.id;
  // The card takes its first tag's shelf color (styles.css [data-color]).
  if (todo.tags.length > 0) item.dataset.color = tagColor(todo.tags[0]);
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
  open.setAttribute('aria-label', rowName(todo, overdue, ticked, now));

  const title = document.createElement('span');
  title.className = 'todo-text';
  title.textContent = todo.text;
  open.append(title);

  if (todo.due !== null || todo.tags.length > 0) {
    const meta = document.createElement('span');
    meta.className = 'todo-meta';
    if (todo.due !== null) meta.append(renderStamp(todo, overdue, ticked, now));
    meta.append(...todo.tags.map(renderTagChip));
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
  const tags = allTags(state);
  const visible = visibleTodos(now);
  const filtering = activeTags.length > 0;

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
  // No counts: the row shows only Clear while a filter is on. While loading, its live region says
  // "Loading your tasks" to screen readers alone.
  summary.textContent = loading ? 'Loading your tasks' : '';
  summary.setAttribute('aria-busy', String(loading));
  summaryRow.classList.toggle('is-quiet', !ready || !filtering);
  syncAddButton();
  // Under the composer: which shelf a new task goes on (the selected tags).
  addShelf.hidden = activeTags.length === 0;
  addShelf.textContent = activeTags.length === 0 ? '' : `Adds to ${activeTags.map((tag) => `#${tag}`).join(', ')}`;
  clearFilters.hidden = !filtering || !ready;
  // A load error is a card in the list slot; other sync notes are a line above the list.
  syncNote.classList.toggle('is-block', phase === 'error');

  // One tag selected: that shelf's view. The title names it and the header takes its color.
  const shelf = ready && activeTags.length === 1 ? activeTags[0] : null;
  title.textContent = shelf ?? 'Tasks';
  if (shelf) header.dataset.color = tagColor(shelf);
  else delete header.dataset.color;

  const scroll = filterBar.scrollLeft;
  filterWrap.hidden = !ready || tags.length === 0;
  filterBar.replaceChildren(
    renderFilterChip(null, state.length),
    ...tags.map(({ tag, count }) => renderFilterChip(tag, count)),
  );
  filterBar.scrollLeft = scroll;

  if (loading) list.replaceChildren(...Array.from({ length: SKELETON_ROWS }, renderSkeleton));
  else list.replaceChildren(...visible.map((todo) => renderTodo(todo, now)));
  list.classList.toggle('is-loading', loading);
  list.setAttribute('aria-busy', String(loading));
  list.hidden = !loading && visible.length === 0;
  emptyState.hidden = !ready || visible.length > 0;

  const controls = new Map(
    [...app.querySelectorAll('[data-focus-key]')].map((element) => [element.dataset.focusKey, element]),
  );
  const target = keys.map((focusKey) => controls.get(focusKey)).find(Boolean);
  if (target) target.focus();
  else if (focusKeys) focusComposer();
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

// Same parse and check as submit (and the edit form): with the active filter tags, which can push
// a #tag back into the title.
function syncAddButton() {
  const { error } = readTaskInput(input.value, activeTags);
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

// Opens the task sheet, prefilled with the task's title, tags, reminder and repeat.
// The row can outlive its task until the pending render (a failed add rolled it back mid-press).
function openEditor(id) {
  const todo = findTodo(id);
  if (!todo) return;
  reminderId = id;
  reminderTouched = false;
  draft = { text: todo.text, tags: [...todo.tags], due: todo.due, repeat: todo.repeat };
  draftTags = [...todo.tags];
  editor.setAttribute('aria-label', `Edit “${todo.text}”`);
  textInput.value = todo.text;
  closeTagField();
  renderDraftTags();
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
  closeTagField();
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
    todo.tags.length !== opened.tags.length || todo.tags.some((tag, index) => tag !== opened.tags[index]);
}

// The sheet's tags: chips with a ×, for the draft's tags. "Add tag" hides at the cap.
function renderDraftTags() {
  editTags.replaceChildren(...draftTags.map((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.dataset.color = tagColor(tag);
    const label = document.createElement('span');
    label.className = 'tag-label';
    label.dataset.tag = tag;
    label.textContent = `#${tag}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-remove';
    remove.dataset.tag = tag;
    remove.setAttribute('aria-label', `Remove tag ${tag}`);
    remove.append(icon(xIcon));
    chip.append(label, remove);
    return chip;
  }));
  tagAdd.hidden = !tagField.hidden || draftTags.length >= MAX_TAGS;
  // The sheet is tinted with its first tag's shelf color, like the task's card.
  if (draftTags.length > 0) editor.dataset.color = tagColor(draftTags[0]);
  else delete editor.dataset.color;
}

// "Add tag" becomes an inline field: Enter adds and stays open, Esc closes.
function openTagField() {
  tagField.hidden = false;
  tagField.value = '';
  tagAdd.hidden = true;
  tagField.focus();
}

function closeTagField() {
  tagField.hidden = true;
  tagField.value = '';
  tagField.removeAttribute('aria-invalid');
  tagAdd.hidden = draftTags.length >= MAX_TAGS;
}

// The same rules as "+ tag" (normalized, no duplicates, at most MAX_TAGS), against the draft.
// Returns false when the tag is refused.
function addDraftTag(raw) {
  const tag = normalizeTag(raw);
  if (tag === null || draftTags.includes(tag) || draftTags.length >= MAX_TAGS) return false;
  draftTags = [...draftTags, tag];
  renderDraftTags();
  syncEditor();
  return true;
}

// Clears the rejected text after the flash, unless the user has typed something new since.
function rejectTag(field) {
  const rejected = field.value;
  field.setAttribute('aria-invalid', 'true');
  setTimeout(() => {
    field.removeAttribute('aria-invalid');
    if (field.value === rejected) field.value = '';
  }, INVALID_FLASH_MS);
}

// Save: one write with the title, tags and reminder, shown at once and rolled back if the server
// refuses it (a 409 reloads and says the task changed in another tab).
function saveEditor() {
  // Save can fire without a blur (Enter in Time, a script click): a tag still typed is kept.
  if (!tagField.hidden && tagField.value.trim() !== '') addDraftTag(tagField.value);
  const { text, tags, error } = readTaskEdit(textInput.value, draft.text, draftTags);
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
  const fields = { text, tags, due, repeat: due === null ? 'none' : repeatSelect.value };
  const reminderChanged = fields.due !== todo.due || fields.repeat !== todo.repeat;
  // The edited row can leave the view (a filter tag removed): focus then goes to a neighbour.
  const keys = [...openerKeys(id), ...rowFallbackKeys(id)];
  if (due !== null) requestPermission(); // the browser's own prompt does the asking
  closeEditor();
  if (due !== null && reminderChanged) {
    if (notificationsBlocked() && !noteDismissed) showBanner('note', NOTE_TEXT);
    else if (!banner.hidden && banner.classList.contains('is-note')) hideBanner();
  }
  if (editTodo([todo], id, fields)[0] !== todo) {
    if (reminderChanged) fired.delete(id);
    hideSync();
    saveEdit(id, fields);
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
function saveEdit(id, fields) {
  saved(id, sync.edit(id, fields), () => {
    const todo = findTodo(id);
    if (todo && editTodo([todo], id, fields)[0] !== todo) saveEdit(id, fields);
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
  const titleError = readTaskEdit(textInput.value, draft.text, draftTags).error;
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
  const { text, tags, error } = readTaskInput(raw, activeTags);
  if (error !== null || phase !== 'ready') return;
  const [todo] = addTodo([], text, tags);
  // Re-adding a draft whose save was uncertain sends the same ID: a 409 then means it was saved.
  const draft = draftKey(todo.text, todo.tags);
  const retryIds = createDrafts.get(draft);
  if (retryIds) {
    todo.id = retryIds.shift();
    if (retryIds.length === 0) createDrafts.delete(draft);
  }
  hideSync();
  const result = sync.create(todo);
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
  if (uncertain) createDrafts.set(draft, [...(createDrafts.get(draft) ?? []), todo.id]);
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

clearFilters.addEventListener('click', () => {
  setFilter([], [key('filter')]);
});

filterBar.addEventListener('click', (event) => {
  const chip = event.target.closest('.filter-chip');
  if (!chip) return;
  if (chip.dataset.tag === undefined) setFilter([], [key('filter')]);
  else toggleFilter(chip.dataset.tag, [key('filter', chip.dataset.tag)]);
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
  // A row's tags don't filter: the body is one button that opens the task sheet.
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
// went, counted among the rows shown. `tags` is the filter the move was made under.
function reorder(id, target, tags = activeTags) {
  const todo = findTodo(id);
  if (!todo) return;
  const filter = [...tags];
  saved(id, sync.move(id, target.anchorId, target.side, filter), () => {
    if (findTodo(id) && findTodo(target.anchorId)) reorder(id, target, filter);
  });
  const ids = reorderableIds();
  announce(`Moved “${todo.text}” to position ${ids.indexOf(id) + 1} of ${ids.length}.`);
}

// Keyboard: Up/Down (Alt or not) move one place, Home/End to the first/last place.
list.addEventListener('keydown', (event) => {
  const handle = event.target.closest('.todo-handle');
  if (!handle || drag || !REORDER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
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
  if (!handle || drag || app.inert || event.button !== 0 || event.isPrimary === false) return;
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
    tags: [...activeTags],
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
  document.addEventListener('touchmove', onDragTouchMove, { passive: false });
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
  document.removeEventListener('touchmove', onDragTouchMove);
  if (!drag) return;
  const { state, row, handle, rows, slot, frame, tags } = drag;
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
  reorder(row.dataset.id, target, tags);
}

// While dragging: Esc puts the row back, and iOS gets no chance to scroll or zoom.
document.addEventListener('keydown', (event) => {
  if (drag && event.key === 'Escape') {
    event.preventDefault();
    endDrag(false);
  }
});
function onDragTouchMove(event) {
  if (drag) event.preventDefault();
}
window.addEventListener('blur', () => endDrag(false));

// Focus landing on a just-fired row (by Tab or click) ends its highlight.
list.addEventListener('focusin', (event) => {
  if (!rendering) dismissFired(event.target.closest('.todo')?.dataset.id);
});

// Esc ends every highlight. Capture phase, so it also runs when a "+ tag" field or the reminder
// editor uses the same Esc to close (they still do; this neither stops nor prevents the event).
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

editTags.addEventListener('click', (event) => {
  const button = event.target.closest?.('.tag-remove');
  if (!button) return;
  const removed = draftTags.indexOf(button.dataset.tag);
  draftTags = draftTags.filter((tag) => tag !== button.dataset.tag);
  renderDraftTags();
  syncEditor();
  const removes = editTags.querySelectorAll('.tag-remove');
  (removes[Math.min(removed, removes.length - 1)] ?? (tagAdd.hidden ? textInput : tagAdd)).focus();
});
tagAdd.addEventListener('click', openTagField);
tagField.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    // Closes the field only; the sheet stays open.
    event.preventDefault();
    event.stopPropagation();
    closeTagField();
    tagAdd.focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    if (tagField.value.trim() === '') return;
    if (!addDraftTag(tagField.value)) {
      rejectTag(tagField);
    } else if (draftTags.length >= MAX_TAGS) {
      closeTagField();
      textInput.focus();
    } else {
      tagField.value = '';
    }
  }
});
// Leaving the field adds what was typed (if it is a valid tag) and closes it.
tagField.addEventListener('blur', () => {
  if (tagField.hidden) return;
  if (tagField.value.trim() !== '') addDraftTag(tagField.value);
  closeTagField();
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
  const outcome = await result;
  if (outcome.stale) return;
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
    const retryNow = () => reconcileThen(id, outcome.revision, retry);
    showSync("Couldn't save your change.", retryNow);
  }
}

// After an uncertain failure the change may have been saved anyway (only the answer was lost),
// and another tab may have acted on it since. Reload first. Re-send only if the row is still at
// `revision`, the one the change was sent against: then neither it nor anything else landed.
// Any other revision means the row moved on (this change, or a later edit elsewhere, such as a
// recurring reminder that was claimed and advanced). The server's row is kept and shown, and
// nothing is re-sent or re-alerted.
async function reconcileThen(id, revision, retry) {
  const result = await sync.load();
  if (result.stale) return;
  if (!result.ok) {
    if (!handleSessionError(result.error)) {
      showSync("Couldn't save your change.", () => reconcileThen(id, revision, retry));
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
  activeTags = [];
  if (reminderId !== null) closeEditor();
  // Nothing of the old account stays in the hidden sheet or the live regions.
  editor.removeAttribute('aria-label');
  textInput.value = '';
  // Hiding the composer would drop focus to the page; the + button keeps it. The auth flow may
  // still move it on to sign-in or retry.
  const composerFocused = [input, addButton].includes(document.activeElement);
  setComposerOpen(false);
  if (composerFocused) addToggle.focus();
  draftTags = [];
  editTags.replaceChildren();
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
    if (wasReady) renderSoon(); // a press may be in progress: don't replace the row under it
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
