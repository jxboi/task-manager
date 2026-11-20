import {
  addTodo,
  toggleTodo,
  removeTodo,
  addTag,
  removeTag,
  allTags,
  filterByTags,
  setReminder,
  clearReminder,
  markNotified,
  dueReminders,
  nextFireTime,
  sortByUrgency,
} from './todos.js';
import { MAX_TAGS, parseTodoInput, tagColor } from './tags.js';
import { isOverdue, parseLocalInput, toLocalInput } from './reminders.js';
import { load, save } from './storage.js';
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
const xIcon = document.getElementById('x-icon');
const bellIcon = document.getElementById('bell-icon');
const repeatIcon = document.getElementById('repeat-icon');
const alertIcon = document.getElementById('alert-icon');
const infoIcon = document.getElementById('info-icon');

const INVALID_FLASH_MS = 400;
const ROLLOVER_MS = 6000;
const MAX_DELAY = 2 ** 31 - 1; // setTimeout's limit (about 24.8 days); check() re-arms when it fires
const sheetQuery = window.matchMedia('(max-width: 639px), (hover: none)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE_MS = 2 * 1200; // the fired row's 2 pulses (styles.css reminder-pulse)
const NOTE_DISMISSED_KEY = 'task-manager.blocked-note-dismissed';

const BLOCKED_TEXT = 'Notifications are blocked or unavailable. Due tasks will be highlighted on this page.';
// The list-level note: short enough for one line at 375px (the editor keeps the longer BLOCKED_TEXT).
const NOTE_TEXT = 'Notifications off. Reminders show only here.';
const MESSAGES = {
  invalid: { kind: 'error', icon: alertIcon, text: 'Enter a valid date and time.' },
  done: { kind: 'warn', icon: infoIcon, text: "This task is done, so its reminder won't alert. Uncheck it to turn alerts back on." },
  past: { kind: 'warn', icon: infoIcon, text: 'That time has passed. Saving will mark this task overdue and alert right away.' },
  blocked: { kind: 'warn', icon: infoIcon, text: BLOCKED_TEXT },
  ask: {
    kind: 'info',
    icon: bellIcon,
    text: 'When you save, your browser will ask to allow notifications. If you say no, due tasks are still highlighted on this page.',
  },
};

let state = load();
// View state: never saved, never in the URL.
let activeTags = []; // A to Z
let editingId = null; // todo whose "+ tag" field is open
let reminderId = null; // todo whose reminder editor is open
let reminderTouched = false; // the date field was changed, or Save tried: show its error
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

function update(next, focusKeys) {
  commit(next);
  render(focusKeys);
}

function commit(next) {
  if (next !== state) {
    state = next;
    save(state);
  }
  // A filter tag drops out once no todo uses it; with none left the view is back to All.
  const inUse = new Set(state.flatMap((todo) => todo.tags));
  activeTags = activeTags.filter((tag) => inUse.has(tag));
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

function renderReminderAdd(todo) {
  const button = withKey(document.createElement('button'), 'add-reminder', todo.id);
  button.type = 'button';
  button.className = 'reminder-add';
  button.setAttribute('aria-label', `Add reminder to “${todo.text}”`);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', String(reminderId === todo.id));
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
  button.setAttribute('aria-expanded', String(reminderId === todo.id));
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

  item.append(checkbox, body, deleteButton);
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

  summary.textContent = summaryText(visible);
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
  emptyState.hidden = visible.length > 0;
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

// Same parse as submit: with the active filter tags, which can push a #tag back into the title.
function syncAddButton() {
  addButton.disabled = parseTodoInput(input.value, activeTags).text === '';
}

// --- Reminders: alerting -------------------------------------------------------------------

// Alerts every overdue, un-alerted todo once, then arms the timer for the next one. Never trusts
// the timer: it compares against the clock, so an early, late or stale wake-up is harmless.
function check() {
  const now = Date.now();
  const ready = dueReminders(state, now);
  if (ready.length > 0) {
    notify(ready);
    // The pulse is the whole highlight: with reduced motion the row is simply overdue.
    if (!reducedMotion.matches) {
      const started = performance.now();
      for (const todo of ready) fired.set(todo.id, started);
    }
    commit(markNotified(state, ready.map((todo) => todo.id)));
  }
  // Overdue marks and order depend on the time, so re-render even when nothing fired.
  renderSoon(renderPending ? pendingFocus : undefined);
  rearm(now);
}

// One timer, to the next due time; no polling.
function rearm(now) {
  clearTimeout(timer);
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

function openEditor(id) {
  const todo = findTodo(id);
  reminderId = id;
  reminderTouched = false;
  editorFor.textContent = todo.text;
  editor.setAttribute('aria-label', `Reminder for “${todo.text}”`);
  whenInput.value = todo.due === null ? '' : toLocalInput(todo.due);
  repeatSelect.value = todo.repeat;
  removeButton.hidden = todo.due === null;
  layer.hidden = false;
  render(); // the opener shows aria-expanded; render places the editor
  syncEditor();
  // The popover is placed to fit; focusing it never scrolls the page.
  whenInput.focus({ preventScroll: true });
}

// Hides the editor without rendering; callers render (or renderSoon) with their focus.
function closeEditor() {
  reminderId = null;
  layer.hidden = true;
  app.inert = false;
  editorAnnouncer.textContent = '';
  hideMessage();
}

function openerKeys(id) {
  const todo = findTodo(id);
  return todo && todo.due !== null ? [key('reminder', id)] : [key('add-reminder', id), key('checkbox', id)];
}

function cancelEditor() {
  const id = reminderId;
  closeEditor();
  render(openerKeys(id));
}

function saveEditor() {
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
  commit(setReminder(state, id, due, repeat));
  check(); // a time already past alerts right away; otherwise this re-arms the timer
  render(openerKeys(id));
}

function removeReminder() {
  const id = reminderId;
  closeEditor();
  fired.delete(id);
  commit(clearReminder(state, id));
  check();
  render(openerKeys(id));
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
  const opener = row.querySelector('.reminder-chip, .reminder-add') ?? row;
  const rect = opener.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(rect.left, viewport - editor.offsetWidth - 8));
  editor.style.left = `${left + window.scrollX}px`;
  const top = popoverTop(rect.top, rect.bottom, editor.offsetHeight, window.innerHeight);
  editor.style.top = `${top + window.scrollY}px`;
}

function editorFocusables() {
  return [whenInput, repeatSelect, ...actions.children].filter((element) => !element.hidden);
}

function hideMessage() {
  message.hidden = true;
  message.removeAttribute('role');
  messageText.textContent = '';
}

// The instant in the date field. An unchanged field keeps the saved instant: in the repeated hour
// when clocks go back, its text ("01:30") would read back as the other 01:30.
function editorDue() {
  const todo = findTodo(reminderId);
  return todo.due !== null && whenInput.value === toLocalInput(todo.due) ? todo.due : parseLocalInput(whenInput.value);
}

// Save state, field validity, the repeat helper and the one message, from the current inputs.
function syncEditor() {
  const todo = findTodo(reminderId);
  const due = editorDue();
  const invalid = due === null;
  const showError = invalid && reminderTouched;

  saveButton.setAttribute('aria-disabled', String(invalid));
  if (showError) {
    whenInput.setAttribute('aria-invalid', 'true');
    whenInput.setAttribute('aria-describedby', 'reminder-message');
  } else {
    whenInput.removeAttribute('aria-invalid');
    whenInput.removeAttribute('aria-describedby');
  }

  const repeat = repeatSelect.value;
  repeatHelp.hidden = invalid || repeat === 'none';
  // Emptied when hidden: it is the select's description, and hidden text is still read from there.
  repeatHelp.textContent = '';
  if (!repeatHelp.hidden) {
    const date = new Date(due);
    const { longWeekday, time } = getFormats();
    const day = repeat === 'daily' ? 'day' : longWeekday.format(date);
    repeatHelp.textContent = `Repeats every ${day} at ${time.format(date)}`;
  }

  let next = null;
  if (showError) next = MESSAGES.invalid;
  else if (!invalid && due <= Date.now()) next = MESSAGES.past;
  else if (!invalid && todo.completed) next = MESSAGES.done;
  else if (typeof Notification !== 'undefined' && Notification.permission === 'default') next = MESSAGES.ask;
  else if (!invalid && notificationsBlocked()) next = MESSAGES.blocked;

  if (next === null) {
    hideMessage();
  } else if (messageText.textContent !== next.text || message.hidden) {
    // Only touch the live region when the message changes, so it isn't re-announced per keystroke.
    message.className = `reminder-message is-${next.kind}`;
    if (next === MESSAGES.invalid) message.setAttribute('role', 'alert');
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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const { text, tags } = parseTodoInput(input.value, activeTags);
  if (text === '') return;
  update(addTodo(state, text, tags));
  input.value = '';
  addButton.disabled = true;
  input.focus();
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
  const before = findTodo(id);
  const next = toggleTodo(state, id, Date.now());
  const after = next.find((todo) => todo.id === id);
  fired.delete(id);
  commit(next);
  // A repeating todo moved to its next time and stays unchecked: say so.
  if (!after.completed && after.due !== before.due) {
    showBanner('info', `Done for now. “${after.text}” is next due ${formatDue(after.due, Date.now())}.`, ROLLOVER_MS);
  }
  check();
  render([key('checkbox', id)]);
});

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
    commit(removeTodo(state, id));
    check();
    render(keys);
  } else if (button.matches('.tag-label')) {
    // If the row leaves the view, keep focus on the same tag in the filter bar.
    toggleFilter(tag, [key('tag', id, tag), key('filter', tag)]);
  } else if (button.matches('.tag-remove')) {
    const tags = findTodo(id).tags;
    const nextTag = tags[tags.indexOf(tag) + 1];
    update(removeTag(state, id, tag), [
      nextTag && key('tag', id, nextTag),
      key('add-tag', id),
      ...rowFallbackKeys(id),
    ]);
  } else if (button.matches('.tag-add')) {
    editingId = id;
    render([key('tag-field', id)]);
  } else if (button.matches('.reminder-chip, .reminder-add')) {
    if (reminderId === id) cancelEditor();
    else openEditor(id);
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
    const next = addTag(state, id, field.value);
    if (next === state) {
      rejectTag(field);
    } else if (next.find((todo) => todo.id === id).tags.length >= MAX_TAGS) {
      commit(next);
      closeTagField(id);
    } else {
      field.value = ''; // added: the re-rendered field starts empty
      update(next, [key('tag-field', id)]);
    }
  }
});

list.addEventListener('focusout', (event) => {
  const field = event.target;
  // Ignore fields removed by a render, and the window itself losing focus.
  if (rendering || !field.matches('.tag-field') || field === document.activeElement) return;
  const { id } = field.closest('.todo').dataset;
  if (editingId !== id) return;
  if (field.value.trim() !== '') commit(addTag(state, id, field.value));
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

whenInput.addEventListener('input', () => {
  reminderTouched = true;
  syncEditor();
});
repeatSelect.addEventListener('change', syncEditor);
saveButton.addEventListener('click', saveEditor);
cancelButton.addEventListener('click', cancelEditor);
removeButton.addEventListener('click', removeReminder);
scrim.addEventListener('click', cancelEditor);

editor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelEditor();
  } else if (event.key === 'Enter' && event.target === whenInput) {
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
  const opener = event.target.closest?.('.reminder-chip, .reminder-add');
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

// Catch up after the tab was hidden, the machine slept or the timer was throttled.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') check();
});
window.addEventListener('focus', check);

// Start: missed reminders alert once, then the first render.
check();
render();
