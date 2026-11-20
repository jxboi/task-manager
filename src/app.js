import {
  addTodo,
  editTodo,
  toggleTodo,
  addTag,
  allTags,
  filterByTags,
  dueReminders,
  nextFireTime,
  sortByUrgency,
} from './todos.js';
import { MAX_TAGS, normalizeTag, parseTodoInput, tagColor } from './tags.js';
import { isOverdue, parseLocalInput, toLocalInput } from './reminders.js';
import * as api from './storage.js';
import { createSync } from './sync.js';
import { formatTaskInput, readTaskInput } from './task-input.js';
import { popoverTop } from './popover.js';

const app = document.querySelector('.app');
const form = document.getElementById('add-form');
const input = document.getElementById('new-todo');
const addButton = document.getElementById('add-button');
const list = document.getElementById('todo-list');
const emptyState = document.getElementById('empty-state');
const summary = document.getElementById('summary');
const clearFilters = document.getElementById('clear-filters');
const hintDefault = document.getElementById('hint-default');
const hintAuto = document.getElementById('hint-auto');
const filterWrap = document.getElementById('filter-wrap');
const filterBar = document.getElementById('filter-bar');
const footer = document.getElementById('footer');
const banner = document.getElementById('banner');
const bannerIcon = document.getElementById('banner-icon');
const bannerText = document.getElementById('banner-text');
const bannerDismiss = document.getElementById('banner-dismiss');
const announcer = document.getElementById('announcer');
const editorAnnouncer = document.getElementById('reminder-announcer');
const layer = document.getElementById('reminder-layer');
const scrim = document.getElementById('reminder-scrim');
const editor = document.getElementById('reminder-editor');
const editorFor = document.getElementById('reminder-for');
const editorTitle = document.getElementById('reminder-title');
const textField = document.getElementById('edit-text-field');
const textInput = document.getElementById('edit-text');
const whenLabel = document.getElementById('reminder-when-label');
const whenInput = document.getElementById('reminder-when');
const repeatSelect = document.getElementById('reminder-repeat');
const repeatHelp = document.getElementById('reminder-repeat-help');
const message = document.getElementById('reminder-message');
const messageIcon = document.getElementById('reminder-message-icon');
const messageText = document.getElementById('reminder-message-text');
const actions = document.getElementById('reminder-actions');
const editorStart = document.getElementById('reminder-start');
const editorEnd = document.getElementById('reminder-end');
const removeButton = document.getElementById('reminder-remove');
const cancelButton = document.getElementById('reminder-cancel');
const saveButton = document.getElementById('reminder-save');
const trashIcon = document.getElementById('trash-icon');
const pencilIcon = document.getElementById('pencil-icon');
const xIcon = document.getElementById('x-icon');
const bellIcon = document.getElementById('bell-icon');
const repeatIcon = document.getElementById('repeat-icon');
const alertIcon = document.getElementById('alert-icon');
const infoIcon = document.getElementById('info-icon');
const syncNote = document.getElementById('sync-note');
const syncText = document.getElementById('sync-text');
const syncRetry = document.getElementById('sync-retry');
const syncDismiss = document.getElementById('sync-dismiss');

const INVALID_FLASH_MS = 400;
const ROLLOVER_MS = 6000;
const MAX_DELAY = 2 ** 31 - 1; // setTimeout's limit (about 24.8 days); check() re-arms when it fires
const sheetQuery = window.matchMedia('(max-width: 639px), (hover: none)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE_MS = 2 * 1200; // the fired row's 2 pulses (styles.css reminder-pulse)
// A claim the server refused while this tab still sees the occurrence as due (its clock is ahead,
// say) waits this long before it is tried again. So does a claim that failed to reach the server.
const CLAIM_RETRY_MS = 30_000;
const NOTE_DISMISSED_KEY = 'task-manager.blocked-note-dismissed';

const BLOCKED_TEXT = 'Notifications are blocked or unavailable. Due tasks will be highlighted on this page.';
// The list-level note: short enough for one line at 375px (the editor keeps the longer BLOCKED_TEXT).
const NOTE_TEXT = 'Notifications off. Reminders show only here.';
const MESSAGES = {
  invalid: { kind: 'error', icon: alertIcon, text: 'Enter a valid date and time.' },
  // The edit form's title, by readTaskInput's error (the rule that also disables Add).
  empty: { kind: 'error', icon: alertIcon, text: 'Enter a task title.' },
  long: { kind: 'error', icon: alertIcon, text: 'Keep the title to 2,000 characters or fewer.' },
  done: { kind: 'warn', icon: infoIcon, text: "This task is done, so its reminder won't alert. Uncheck it to turn alerts back on." },
  past: { kind: 'warn', icon: infoIcon, text: 'That time has passed. Saving will mark this task overdue and alert right away.' },
  blocked: { kind: 'warn', icon: infoIcon, text: BLOCKED_TEXT },
  ask: {
    kind: 'info',
    icon: bellIcon,
    text: 'When you save, your browser will ask to allow notifications. If you say no, due tasks are still highlighted on this page.',
  },
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
let editingId = null; // todo whose "+ tag" field is open
let reminderId = null; // todo whose editor is open
// 'reminder': the reminder editor (date and repeat). 'task': the edit form, the same editor with
// the task's title and tags field above, where an empty date means no reminder.
let editorMode = 'reminder';
let reminderTouched = false; // a field was changed, or Save tried: show its error
let sheetMode = null; // editor layout last applied: true = bottom sheet, false = popover
const fired = new Map(); // todo id -> when its "just fired" pulse started (performance.now())
let noteDismissed = readNoteDismissed(); // the blocked-notifications note, for this session

let rendering = false;
let renderPending = false;
let pendingFocus; // focus keys for the deferred render
let returnFocus = null; // where focus goes if a press that closed the editor left nothing focused
let pressing = false;
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

// The list as shown: the tag filter, then overdue todos on top. Used by the list, the footer and
// fallback focus, so they always agree.
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

function hashtags(tags, conjunction) {
  const names = tags.map((tag) => `#${tag}`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}`;
}

function filterPhrase() {
  return activeTags.length >= 3 ? plural(activeTags.length, 'tag') : hashtags(activeTags, 'or');
}

function summaryText(todos) {
  if (todos.length === 0) return 'Nothing to do yet';
  const remaining = todos.filter((todo) => !todo.completed).length;
  const text = remaining === 0 ? 'All done' : `${remaining} to do`;
  return activeTags.length === 0 ? text : `${text} in ${filterPhrase()}`;
}

function footerText(todos) {
  const completed = todos.filter((todo) => todo.completed).length;
  const text = `${completed} of ${todos.length} completed`;
  return activeTags.length === 0 ? text : `${text} in ${filterPhrase()}`;
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

function renderTagChip(todo, tag) {
  const chip = document.createElement('span');
  chip.className = activeTags.includes(tag) ? 'tag is-match' : 'tag';
  chip.dataset.color = tagColor(tag);

  const label = withKey(document.createElement('button'), 'tag', todo.id, tag);
  label.type = 'button';
  label.className = 'tag-label';
  label.dataset.tag = tag;
  label.setAttribute('aria-label', `Filter by ${tag}`);
  label.setAttribute('aria-pressed', String(activeTags.includes(tag)));
  label.textContent = `#${tag}`;

  const remove = withKey(document.createElement('button'), 'remove', todo.id, tag);
  remove.type = 'button';
  remove.className = 'tag-remove';
  remove.dataset.tag = tag;
  remove.setAttribute('aria-label', `Remove tag ${tag} from “${todo.text}”`);
  remove.append(icon(xIcon));

  chip.append(label, remove);
  return chip;
}

function renderTagControl(todo, tagDraft) {
  if (editingId === todo.id) {
    const field = withKey(document.createElement('input'), 'tag-field', todo.id);
    field.type = 'text';
    field.className = 'tag-field';
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'New tag');
    // A render the user didn't ask for (a reminder firing) keeps what they were typing.
    if (tagDraft.id === todo.id) field.value = tagDraft.value;
    return field;
  }
  if (todo.tags.length >= MAX_TAGS) return null;
  const button = withKey(document.createElement('button'), 'add-tag', todo.id);
  button.type = 'button';
  button.className = 'tag-add';
  button.setAttribute('aria-label', `Add tag to “${todo.text}”`);
  button.textContent = '+ tag';
  return button;
}

const reminderOpen = (id) => reminderId === id && editorMode === 'reminder';

function renderReminderAdd(todo) {
  const button = withKey(document.createElement('button'), 'add-reminder', todo.id);
  button.type = 'button';
  button.className = 'reminder-add';
  button.setAttribute('aria-label', `Add reminder to “${todo.text}”`);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', String(reminderOpen(todo.id)));
  button.append(icon(bellIcon), '+ reminder');
  return button;
}

// The due chip. Overdue is said in words ("Overdue · …" and the name), not only by color.
function renderReminderChip(todo, overdue, now) {
  const when = formatDue(todo.due, now);
  const repeats = todo.repeat === 'none' ? '' : `, repeats ${todo.repeat}`;
  const button = withKey(document.createElement('button'), 'reminder', todo.id);
  button.type = 'button';
  button.className = overdue ? 'reminder-chip is-overdue' : 'reminder-chip';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', String(reminderOpen(todo.id)));
  button.setAttribute(
    'aria-label',
    `${overdue ? `Overdue, was due ${when}` : `Reminder ${when}`}${repeats}. Edit reminder for “${todo.text}”`,
  );

  button.append(icon(overdue ? alertIcon : bellIcon));
  const text = document.createElement('span');
  text.className = 'reminder-when';
  text.textContent = overdue ? `Overdue · ${when}` : when;
  button.append(text);

  if (todo.repeat !== 'none') {
    const repeat = document.createElement('span');
    repeat.className = 'reminder-repeat';
    const label = document.createElement('span');
    label.className = 'reminder-repeat-label';
    label.textContent = REPEAT_LABELS[todo.repeat];
    repeat.append(icon(repeatIcon), label);
    button.append(repeat);
  }
  return button;
}

function renderTodo(todo, now, tagDraft) {
  const overdue = isOverdue(todo, now);
  const item = document.createElement('li');
  item.className = todo.completed ? 'todo is-done' : 'todo';
  item.classList.toggle('is-overdue', overdue);
  item.classList.toggle('is-editing', reminderId === todo.id);
  item.dataset.id = todo.id;
  if (fired.has(todo.id)) {
    item.classList.add('is-fired');
    // Re-renders continue the pulse where it was instead of restarting it.
    item.style.animationDelay = `${Math.round(fired.get(todo.id) - performance.now())}ms`;
  }

  const checkbox = withKey(document.createElement('input'), 'checkbox', todo.id);
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-checkbox';
  checkbox.id = `todo-${todo.id}`;
  checkbox.checked = todo.completed;

  const label = document.createElement('label');
  label.className = 'todo-text';
  label.htmlFor = checkbox.id;
  label.textContent = todo.text;

  const body = document.createElement('div');
  body.className = 'todo-body';
  body.append(label);

  if (todo.due !== null) {
    const meta = document.createElement('div');
    meta.className = 'todo-meta';
    meta.append(renderReminderChip(todo, overdue, now));
    body.append(meta);
  }

  const tags = document.createElement('div');
  tags.className = 'todo-tags';
  tags.append(...todo.tags.map((tag) => renderTagChip(todo, tag)));
  const control = renderTagControl(todo, tagDraft);
  if (control) tags.append(control);
  if (todo.due === null) tags.append(renderReminderAdd(todo));
  // Untagged rows only show the chip row when "+ tag" / "+ reminder" are revealed.
  if (todo.tags.length === 0 && editingId !== todo.id) tags.classList.add('is-empty');
  body.append(tags);

  const deleteButton = withKey(document.createElement('button'), 'delete', todo.id);
  deleteButton.type = 'button';
  deleteButton.className = 'todo-delete';
  deleteButton.setAttribute('aria-label', `Delete “${todo.text}”`);
  deleteButton.append(icon(trashIcon));

  // Opens the edit form (the editor in 'task' mode), prefilled with this task.
  const editButton = withKey(document.createElement('button'), 'edit', todo.id);
  editButton.type = 'button';
  editButton.className = 'todo-edit';
  editButton.setAttribute('aria-label', `Edit “${todo.text}”`);
  editButton.setAttribute('aria-haspopup', 'dialog');
  editButton.setAttribute('aria-expanded', String(reminderId === todo.id && editorMode === 'task'));
  editButton.append(icon(pencilIcon));

  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'todo-actions';
  actionsGroup.append(editButton, deleteButton);

  item.append(checkbox, body, actionsGroup);
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
  const openField = list.querySelector('.tag-field');
  const tagDraft = { id: openField?.closest('.todo').dataset.id, value: openField?.value };

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
  if (phase === 'loading') summary.textContent = 'Loading your tasks…';
  else if (phase === 'error') summary.textContent = "Couldn't load your tasks";
  else summary.textContent = summaryText(visible);
  summary.setAttribute('aria-busy', String(phase === 'loading'));
  syncAddButton();
  clearFilters.hidden = !filtering;
  hintDefault.hidden = filtering;
  hintAuto.hidden = !filtering;
  // Names exactly the tags a new todo will get (the active ones, up to the cap).
  const autoTags = parseTodoInput('', activeTags).tags;
  hintAuto.textContent = filtering ? `New tasks get ${hashtags(autoTags, 'and')} automatically` : '';

  const scroll = filterBar.scrollLeft;
  filterWrap.hidden = tags.length === 0;
  filterBar.replaceChildren(
    renderFilterChip(null, state.length),
    ...tags.map(({ tag, count }) => renderFilterChip(tag, count)),
  );
  filterBar.scrollLeft = scroll;

  list.replaceChildren(...visible.map((todo) => renderTodo(todo, now, tagDraft)));
  list.hidden = visible.length === 0;
  emptyState.hidden = !ready || visible.length > 0;
  footer.hidden = visible.length === 0;
  footer.textContent = footerText(visible);

  const controls = new Map(
    [...app.querySelectorAll('[data-focus-key]')].map((element) => [element.dataset.focusKey, element]),
  );
  const target = keys.map((focusKey) => controls.get(focusKey)).find(Boolean);
  if (target) target.focus();
  else if (focusKeys) input.focus();
  // Focus moved by the render itself is not the user's: focus handlers ignore it.
  rendering = false;

  if (reminderId !== null) {
    placeEditor();
    syncEditor(); // e.g. "That time has passed" once it has
  }
}

// Pressing a control blurs an open "+ tag" field (or closes the reminder editor) before that
// control gets its click. Rendering in between would replace the pressed control and swallow the
// click, so a render requested during a press waits until the button is released (click comes first).
// A press can end without mouseup (a drag, or the window losing focus), so those release it too.
// The row losing focus keeps its revealed controls until the press ends: collapsing it on mousedown
// would shift the pressed control (in a row below) out from under the pointer and lose the click.
document.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  pressing = true;
  document.activeElement?.closest('.todo')?.classList.add('is-held');
}, true);
document.addEventListener('mouseup', release, true);
document.addEventListener('dragend', release, true);
window.addEventListener('blur', release);

function release() {
  pressing = false;
  for (const row of list.querySelectorAll('.is-held')) row.classList.remove('is-held');
  setTimeout(flushRender);
}

function renderSoon(focusKeys) {
  renderPending = true;
  pendingFocus = focusKeys;
  if (!pressing) setTimeout(flushRender);
}

function flushRender() {
  if (renderPending) render(pendingFocus);
  if (returnFocus && !pressing) {
    const keys = returnFocus;
    returnFocus = null;
    if (document.activeElement === document.body || !document.activeElement) render(keys);
  }
}

// Neighbouring rows in the current view, for when the acted-on row leaves it.
function rowFallbackKeys(id) {
  const visible = visibleTodos(Date.now());
  const index = visible.findIndex((todo) => todo.id === id);
  return [visible[index + 1], visible[index - 1]]
    .filter(Boolean)
    .map((todo) => key('checkbox', todo.id));
}

// Focus goes back to "+ tag", or to the last chip when the todo is at the cap.
function tagControlKeys(id) {
  const lastTag = findTodo(id).tags.at(-1);
  return [key('add-tag', id), lastTag && key('tag', id, lastTag), key('checkbox', id)];
}

function closeTagField(id) {
  editingId = null;
  render(tagControlKeys(id));
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

// Same parse and check as submit (and the edit form): with the active filter tags, which can push
// a #tag back into the title.
function syncAddButton() {
  addButton.disabled = phase !== 'ready' || readTaskInput(input.value, activeTags).error !== null;
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

// One timer, to the next due time; no polling.
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

// Ends a highlight on the existing row, without a render: a render would replace an open
// "+ tag" field (in any row) and lose its caret and selection.
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

// --- Reminders: editor ---------------------------------------------------------------------

// `mode` 'task' opens the edit form: the same editor, prefilled with the task's title and tags
// (as the add field would take them), its reminder and its repeat.
function openEditor(id, mode = 'reminder') {
  const todo = findTodo(id);
  const task = mode === 'task';
  reminderId = id;
  editorMode = mode;
  reminderTouched = false;
  editorTitle.textContent = task ? 'Edit task' : 'Reminder';
  editorFor.textContent = todo.text;
  editorFor.hidden = task; // the Task field shows it
  editor.setAttribute('aria-label', task ? `Edit “${todo.text}”` : `Reminder for “${todo.text}”`);
  textField.hidden = !task;
  textInput.value = task ? formatTaskInput(todo) : '';
  whenLabel.textContent = task ? 'Reminder' : 'Date and time';
  whenInput.value = todo.due === null ? '' : toLocalInput(todo.due);
  repeatSelect.value = todo.repeat;
  // In the edit form an emptied date removes the reminder on Save, so there is no Remove button.
  removeButton.hidden = task || todo.due === null;
  layer.hidden = false;
  render(); // the opener shows aria-expanded; render places the editor
  syncEditor();
  // The popover is placed to fit; focusing it never scrolls the page.
  const first = task ? textInput : whenInput;
  first.focus({ preventScroll: true });
  if (task) first.setSelectionRange?.(first.value.length, first.value.length);
}

// Hides the editor without rendering; callers render (or renderSoon) with their focus.
function closeEditor() {
  reminderId = null;
  layer.hidden = true;
  app.inert = false;
  editorAnnouncer.textContent = '';
  hideMessage();
}

// Where focus goes back to when the editor closes: the control that opened it, in its row.
function openerKeys(id, mode = editorMode) {
  const todo = findTodo(id);
  if (mode === 'task') return [key('edit', id), key('checkbox', id)];
  return todo && todo.due !== null ? [key('reminder', id)] : [key('add-reminder', id), key('checkbox', id)];
}

function cancelEditor() {
  const id = reminderId;
  const mode = editorMode;
  closeEditor();
  render(openerKeys(id, mode));
}

function saveEditor() {
  if (editorMode === 'task') {
    saveTaskEditor();
    return;
  }
  const due = editorDue();
  if (due === null) {
    // Save is aria-disabled: a no-op that shows why.
    reminderTouched = true;
    syncEditor();
    whenInput.focus();
    return;
  }
  const id = reminderId;
  const repeat = repeatSelect.value;
  requestPermission();
  closeEditor(); // first: the sheet makes the status line inert
  // The blocked note, until dismissed: then it stays hidden for the session, even on later Saves.
  if (notificationsBlocked() && !noteDismissed) showBanner('note', NOTE_TEXT);
  else if (!banner.hidden && banner.classList.contains('is-note')) hideBanner();
  fired.delete(id);
  saveReminder(id, due, repeat);
  render(openerKeys(id));
}

// The edit form's Save: one write with the title, tags and reminder, shown at once and rolled back
// if the server refuses it (a 409 reloads and says the task changed in another tab).
function saveTaskEditor() {
  const { text, tags, error } = readTaskInput(textInput.value);
  const due = editorDue();
  if (error !== null || due === undefined) {
    reminderTouched = true;
    syncEditor();
    (error !== null ? textInput : whenInput).focus();
    return;
  }
  const id = reminderId;
  const todo = findTodo(id);
  const fields = { text, tags, due, repeat: due === null ? 'none' : repeatSelect.value };
  const reminderChanged = fields.due !== todo.due || fields.repeat !== todo.repeat;
  // The edited row can leave the view (a filter tag removed): focus then goes to a neighbour.
  const keys = [...openerKeys(id, 'task'), ...rowFallbackKeys(id)];
  if (due !== null) requestPermission(); // as the reminder editor does; "ask" said it would
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
  render(keys);
}

// `retry` (after an uncertain failure) re-sends only if the row doesn't already match the edit.
function saveEdit(id, fields) {
  saved(id, sync.edit(id, fields), () => {
    const todo = findTodo(id);
    if (todo && editTodo([todo], id, fields)[0] !== todo) saveEdit(id, fields);
  });
  check();
}

function saveReminder(id, due, repeat) {
  // A time already past alerts right away (once saved); otherwise this re-arms the timer.
  saved(id, sync.setReminder(id, due, repeat), () => {
    const todo = findTodo(id);
    if (todo && (todo.due !== due || todo.repeat !== repeat)) saveReminder(id, due, repeat);
  });
  check();
}

function removeReminder() {
  const id = reminderId;
  closeEditor();
  fired.delete(id);
  clearSavedReminder(id);
  render(openerKeys(id));
}

function clearSavedReminder(id) {
  saved(id, sync.clearReminder(id), () => findTodo(id)?.due != null && clearSavedReminder(id));
  check();
}

// The bottom sheet (under 640px, or a touch screen) is modal: the page behind is inert. The popover is not.
function placeEditor() {
  const sheet = sheetQuery.matches;
  if (sheet !== sheetMode) {
    sheetMode = sheet;
    layer.classList.toggle('is-sheet', sheet);
    if (sheet) editor.setAttribute('aria-modal', 'true');
    else editor.removeAttribute('aria-modal');
    // DOM order is focus order: the sheet stacks Save first, then Cancel and Remove.
    const focused = document.activeElement;
    actions.replaceChildren(...(sheet ? [saveButton, cancelButton, removeButton] : [removeButton, cancelButton, saveButton]));
    if (actions.contains(focused)) focused.focus();
  }
  app.inert = sheet;
  if (sheet) {
    editor.style.left = '';
    editor.style.top = '';
    return;
  }
  const row = [...list.children].find((item) => item.dataset.id === reminderId);
  if (!row) return;
  // The edit form opens under the task's text and chips, so it doesn't cover what it edits.
  const anchor = editorMode === 'task' ? '.todo-body' : '.reminder-chip, .reminder-add';
  const opener = row.querySelector(anchor) ?? row;
  const rect = opener.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(rect.left, viewport - editor.offsetWidth - 8));
  editor.style.left = `${left + window.scrollX}px`;
  const top = popoverTop(rect.top, rect.bottom, editor.offsetHeight, window.innerHeight);
  editor.style.top = `${top + window.scrollY}px`;
}

function editorFocusables() {
  return [textInput, whenInput, repeatSelect, ...actions.children].filter(
    (element) => !element.hidden && !(element === textInput && textField.hidden),
  );
}

// `describedBy`: the field's own description, kept alongside the message.
function markInvalid(field, invalid, describedBy) {
  const ids = [invalid && 'reminder-message', describedBy].filter(Boolean).join(' ');
  if (invalid) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
  if (ids) field.setAttribute('aria-describedby', ids);
  else field.removeAttribute('aria-describedby');
}

function hideMessage() {
  message.hidden = true;
  message.removeAttribute('role');
  messageText.textContent = '';
}

// The instant in the date field. An unchanged field keeps the saved instant: in the repeated hour
// when clocks go back, its text ("01:30") would read back as the other 01:30.
// In the reminder editor null means invalid. In the edit form an empty field is null (no
// reminder) and undefined means invalid (a half-typed date also reads as '', so badInput is checked).
function editorDue() {
  const todo = findTodo(reminderId);
  if (editorMode === 'task' && whenInput.value === '') return whenInput.validity?.badInput ? undefined : null;
  const due = todo.due !== null && whenInput.value === toLocalInput(todo.due) ? todo.due : parseLocalInput(whenInput.value);
  return editorMode === 'task' && due === null ? undefined : due;
}

// Save state, field validity, the repeat helper and the one message, from the current inputs.
function syncEditor() {
  const todo = findTodo(reminderId);
  const task = editorMode === 'task';
  const rawDue = editorDue();
  // From here `due` is the instant or null; `invalid` is about the date field only.
  const invalid = task ? rawDue === undefined : rawDue === null;
  const due = invalid ? null : rawDue;
  const showError = invalid && reminderTouched;
  const titleError = task ? readTaskInput(textInput.value).error : null;
  const showTitleError = titleError !== null && reminderTouched;

  saveButton.setAttribute('aria-disabled', String(invalid || titleError !== null));
  // One message at a time, title first: only the field it is about points at it.
  markInvalid(textInput, showTitleError, 'edit-text-hint');
  markInvalid(whenInput, showError && !showTitleError);

  const repeat = repeatSelect.value;
  repeatHelp.hidden = due === null || repeat === 'none';
  // Emptied when hidden: it is the select's description, and hidden text is still read from there.
  repeatHelp.textContent = '';
  if (!repeatHelp.hidden) {
    const date = new Date(due);
    const { longWeekday, time } = getFormats();
    const day = repeat === 'daily' ? 'day' : longWeekday.format(date);
    repeatHelp.textContent = `Repeats every ${day} at ${time.format(date)}`;
  }

  // In the edit form the reminder notes only apply with a date set, and "has passed" only to a
  // newly chosen time (an overdue task whose title is being edited stays as it is).
  const reminderNotes = !task || due !== null;
  const newTime = !task || due !== todo.due;
  let next = null;
  if (showTitleError) next = MESSAGES[titleError === 'empty' ? 'empty' : 'long'];
  else if (showError) next = MESSAGES.invalid;
  else if (!invalid && due !== null && newTime && due <= Date.now()) next = MESSAGES.past;
  else if (!invalid && reminderNotes && todo.completed) next = MESSAGES.done;
  else if (reminderNotes && typeof Notification !== 'undefined' && Notification.permission === 'default') next = MESSAGES.ask;
  else if (!invalid && reminderNotes && notificationsBlocked()) next = MESSAGES.blocked;

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
  // The message and helper change the editor's height, which its placement depends on.
  placeEditor();
}

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
  input.value = '';
  addButton.disabled = true;
  render();
  input.focus();
  const outcome = await result;
  if (outcome.ok || outcome.stale) return;
  // The draft goes back into the field unless something new was typed meanwhile.
  if (input.value === '') {
    input.value = raw;
    syncAddButton();
  }
  // A duplicate ID whose reload failed is uncertain too: keep the ID for the next try.
  const { status, code } = outcome.error ?? {};
  const uncertain = !outcome.error || status === 0 || status >= 500 || code === 'DUPLICATE_ID';
  if (uncertain) createDrafts.set(draft, [...(createDrafts.get(draft) ?? []), todo.id]);
  if (handleSessionError(outcome.error)) return;
  showSync(uncertain
    ? `Couldn't add “${text}”. Check your connection, then press Add to try again.`
    : `Couldn't add “${text}”. Check it and try again.`);
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
    if (current?.completed === before.completed && current.due === before.due) toggle(id);
  });
  // A repeating todo moved to its next time and stays unchecked: say so.
  if (!after.completed && after.due !== before.due) {
    showBanner('info', `Done for now. “${after.text}” is next due ${formatDue(after.due, now)}.`, ROLLOVER_MS);
  }
  check();
}

function removeRow(id) {
  saved(id, sync.remove(id), () => findTodo(id) && removeRow(id));
  check();
}

function addSavedTag(id, tag) {
  saved(id, sync.addTag(id, tag), () => findTodo(id) && !findTodo(id).tags.includes(tag) && addSavedTag(id, tag));
}

function removeSavedTag(id, tag) {
  saved(id, sync.removeTag(id, tag), () => findTodo(id)?.tags.includes(tag) && removeSavedTag(id, tag));
}

// Tries a tag from the "+ tag" field. Returns the todo's tags after it, or null if rejected
// (invalid, a duplicate or over the cap) without asking the server.
function tryAddTag(id, raw) {
  const next = addTag(state, id, raw);
  if (next === state) return null;
  addSavedTag(id, normalizeTag(raw));
  return next.find((todo) => todo.id === id).tags;
}

list.addEventListener('click', (event) => {
  const row = event.target.closest('.todo');
  if (!row) return;
  const { id } = row.dataset;
  // Any tap or click on a just-fired row ends its highlight.
  dismissFired(id);

  const button = event.target.closest('button');
  if (!button) return;
  const { tag } = button.dataset;

  if (button.matches('.todo-delete')) {
    const keys = rowFallbackKeys(id);
    removeRow(id);
    render(keys);
  } else if (button.matches('.tag-label')) {
    // If the row leaves the view, keep focus on the same tag in the filter bar.
    toggleFilter(tag, [key('tag', id, tag), key('filter', tag)]);
  } else if (button.matches('.tag-remove')) {
    const tags = findTodo(id).tags;
    const nextTag = tags[tags.indexOf(tag) + 1];
    removeSavedTag(id, tag);
    render([
      nextTag && key('tag', id, nextTag),
      key('add-tag', id),
      ...rowFallbackKeys(id),
    ]);
  } else if (button.matches('.tag-add')) {
    editingId = id;
    render([key('tag-field', id)]);
  } else if (button.matches('.reminder-chip, .reminder-add')) {
    if (reminderOpen(id)) cancelEditor();
    else openEditor(id);
  } else if (button.matches('.todo-edit')) {
    if (reminderId === id && editorMode === 'task') cancelEditor();
    else openEditor(id, 'task');
  }
});

list.addEventListener('keydown', (event) => {
  const field = event.target;
  if (!field.matches('.tag-field')) return;
  const { id } = field.closest('.todo').dataset;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeTagField(id);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (field.value.trim() === '') return;
    const raw = field.value;
    field.value = ''; // added: the re-rendered field starts empty
    const tags = tryAddTag(id, raw);
    if (tags === null) {
      field.value = raw;
      rejectTag(field);
    } else if (tags.length >= MAX_TAGS) {
      closeTagField(id);
    } else {
      render([key('tag-field', id)]);
    }
  }
});

list.addEventListener('focusout', (event) => {
  const field = event.target;
  // Ignore fields removed by a render, and the window itself losing focus.
  if (rendering || !field.matches('.tag-field') || field === document.activeElement) return;
  const { id } = field.closest('.todo').dataset;
  if (editingId !== id) return;
  if (field.value.trim() !== '') tryAddTag(id, field.value);
  editingId = null;
  // Focus moving to another control stays there; focus moving nowhere goes back to "+ tag".
  renderSoon(event.relatedTarget ? undefined : tagControlKeys(id));
});

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
  input.focus();
});

for (const field of [textInput, whenInput]) {
  field.addEventListener('input', () => {
    reminderTouched = true;
    syncEditor();
  });
}
repeatSelect.addEventListener('change', syncEditor);
saveButton.addEventListener('click', saveEditor);
cancelButton.addEventListener('click', cancelEditor);
removeButton.addEventListener('click', removeReminder);
scrim.addEventListener('click', cancelEditor);

editor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelEditor();
  } else if (event.key === 'Enter' && !event.isComposing && (event.target === whenInput || event.target === textInput)) {
    event.preventDefault();
    saveButton.click(); // the same path as clicking Save (the only place permission is asked)
  }
});

// Tab stays inside the editor and wraps: focus reaching an edge guard goes round to the other end.
// Guards rather than a Tab key handler, because Tab also moves between the date field's parts.
editorStart.addEventListener('focus', () => editorFocusables().at(-1).focus());
editorEnd.addEventListener('focus', () => editorFocusables()[0].focus());

// A press outside the popover cancels it (no blur-commit). The press itself goes on as usual, so
// the render waits for the click (see `pressing`). Pressing the control that opened it toggles it shut.
document.addEventListener('mousedown', (event) => {
  if (reminderId === null || layer.contains(event.target)) return;
  const opener = event.target.closest?.(editorMode === 'task' ? '.todo-edit' : '.reminder-chip, .reminder-add');
  if (opener && opener.closest('.todo').dataset.id === reminderId) return;
  // Focus stays on a control the press lands on; otherwise it goes back to the opener.
  returnFocus = openerKeys(reminderId);
  closeEditor();
  renderSoon();
}, true);

window.addEventListener('resize', () => {
  if (reminderId !== null) placeEditor();
});
sheetQuery.addEventListener('change', () => {
  if (reminderId !== null) placeEditor();
});

// Coming back to the tab: overdue marks catch up at once. The auth module re-reads the session
// and then sends `tasks:session`, which reloads the list before any reminder is claimed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderSoon(renderPending ? pendingFocus : undefined);
});

syncRetry.addEventListener('click', () => {
  const action = retryAction;
  hideSync();
  input.focus();
  action?.();
});
syncDismiss.addEventListener('click', () => {
  hideSync();
  input.focus();
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
    showSync('This task changed in another tab or device. The list is up to date now, so try again.');
    return;
  }
  const { error } = outcome;
  if (handleSessionError(error)) return;
  if (error.status === 409 || error.status === 404) {
    if (outcome.reloaded) {
      showSync('This task changed in another tab or device. The list is up to date now, so try again.');
    } else {
      showSync("This task changed in another tab or device, and the latest list couldn't be loaded. Try again.", reloadList);
    }
  } else if (error.status === 400) {
    showSync("Couldn't save that change.");
  } else {
    const retryNow = () => reconcileThen(id, outcome.revision, retry);
    showSync("Couldn't save your change. Check your connection and try again.", retryNow);
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
      showSync("Couldn't save your change. Check your connection and try again.", () => reconcileThen(id, revision, retry));
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
    showSync("The latest list couldn't be loaded. Check your connection and try again.", reloadList);
  }
}

// Leaves nothing of the previous session on the page: rows, filters, editors, drafts, alerts and
// timers. Answers still on their way for that session are ignored when they arrive.
function clearView() {
  sync.reset();
  state = [];
  viewSignature = '[]';
  activeTags = [];
  editingId = null;
  if (reminderId !== null) closeEditor();
  // Nothing of the old account stays in the hidden editor or the live regions.
  editorFor.textContent = '';
  editor.removeAttribute('aria-label');
  textInput.value = '';
  whenInput.value = '';
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
    phase = 'ready';
    render();
    check(); // missed reminders alert once, after the list is current
    return;
  }
  if (handleSessionError(result.error)) return;
  if (phase === 'ready') {
    check(); // keep the list shown; claims still check against the server
    return;
  }
  phase = 'error';
  showSync("Couldn't load your tasks. Check your connection and try again.", startLoading);
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
