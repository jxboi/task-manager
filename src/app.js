import { addTodo, toggleTodo, removeTodo, addTag, removeTag, allTags, filterByTags } from './todos.js';
import { MAX_TAGS, parseTodoInput, tagColor } from './tags.js';
import { load, save } from './storage.js';

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
const trashIcon = document.getElementById('trash-icon');
const xIcon = document.getElementById('x-icon');

const INVALID_FLASH_MS = 400;

let state = load();
// View state: never saved, never in the URL.
let activeTags = []; // A to Z
let editingId = null; // todo whose "+ tag" field is open

let rendering = false;
let renderPending = false;
let pressing = false;

render();

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
  remove.append(xIcon.content.cloneNode(true));

  chip.append(label, remove);
  return chip;
}

function renderTagControl(todo) {
  if (editingId === todo.id) {
    const field = withKey(document.createElement('input'), 'tag-field', todo.id);
    field.type = 'text';
    field.className = 'tag-field';
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'New tag');
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

function renderTodo(todo) {
  const item = document.createElement('li');
  item.className = todo.completed ? 'todo is-done' : 'todo';
  item.dataset.id = todo.id;

  const checkbox = withKey(document.createElement('input'), 'checkbox', todo.id);
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-checkbox';
  checkbox.id = `todo-${todo.id}`;
  checkbox.checked = todo.completed;

  const label = document.createElement('label');
  label.className = 'todo-text';
  label.htmlFor = checkbox.id;
  label.textContent = todo.text;

  const tags = document.createElement('div');
  tags.className = 'todo-tags';
  tags.append(...todo.tags.map((tag) => renderTagChip(todo, tag)));
  const control = renderTagControl(todo);
  if (control) tags.append(control);
  // Untagged rows only show the chip row when "+ tag" is revealed.
  if (todo.tags.length === 0 && editingId !== todo.id) tags.classList.add('is-empty');

  const body = document.createElement('div');
  body.className = 'todo-body';
  body.append(label, tags);

  const deleteButton = withKey(document.createElement('button'), 'delete', todo.id);
  deleteButton.type = 'button';
  deleteButton.className = 'todo-delete';
  deleteButton.setAttribute('aria-label', `Delete “${todo.text}”`);
  deleteButton.append(trashIcon.content.cloneNode(true));

  item.append(checkbox, body, deleteButton);
  return item;
}

// focusKeys: controls to focus after rendering, first match wins; if none exists, the
// new-task input. Without it, whatever had focus keeps it.
function render(focusKeys) {
  const keys = focusKeys ?? [document.activeElement?.dataset?.focusKey];
  const tags = allTags(state);
  const visible = filterByTags(state, activeTags);
  const filtering = activeTags.length > 0;

  rendering = true;
  renderPending = false;

  summary.textContent = summaryText(visible);
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

  list.replaceChildren(...visible.map(renderTodo));
  list.hidden = visible.length === 0;
  emptyState.hidden = visible.length > 0;
  footer.hidden = visible.length === 0;
  footer.textContent = footerText(visible);

  rendering = false;

  const controls = new Map(
    [...app.querySelectorAll('[data-focus-key]')].map((element) => [element.dataset.focusKey, element]),
  );
  const target = keys.map((focusKey) => controls.get(focusKey)).find(Boolean);
  if (target) target.focus();
  else if (focusKeys) input.focus();
}

// Pressing a control blurs an open "+ tag" field before that control gets its click.
// Rendering in between would replace the pressed control and swallow the click, so a
// render requested during a press waits until the button is released (click comes first).
document.addEventListener('mousedown', () => {
  pressing = true;
}, true);
document.addEventListener('mouseup', () => {
  pressing = false;
  setTimeout(flushRender);
}, true);

function renderSoon() {
  renderPending = true;
  if (!pressing) setTimeout(flushRender);
}

function flushRender() {
  if (renderPending) render();
}

// Neighbouring rows in the current view, for when the acted-on row leaves it.
function rowFallbackKeys(id) {
  const visible = filterByTags(state, activeTags);
  const index = visible.findIndex((todo) => todo.id === id);
  return [visible[index + 1], visible[index - 1]]
    .filter(Boolean)
    .map((todo) => key('checkbox', todo.id));
}

// Focus goes back to "+ tag", or to the last chip when the todo is at the cap.
function closeTagField(id) {
  const lastTag = state.find((todo) => todo.id === id).tags.at(-1);
  editingId = null;
  render([key('add-tag', id), lastTag && key('tag', id, lastTag), key('checkbox', id)]);
}

function rejectTag(field) {
  field.setAttribute('aria-invalid', 'true');
  setTimeout(() => {
    field.removeAttribute('aria-invalid');
    field.value = '';
  }, INVALID_FLASH_MS);
}

input.addEventListener('input', () => {
  addButton.disabled = parseTodoInput(input.value).text === '';
});

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
  update(toggleTodo(state, id), [key('checkbox', id)]);
});

list.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { id } = button.closest('.todo').dataset;
  const { tag } = button.dataset;

  if (button.matches('.todo-delete')) {
    update(removeTodo(state, id), rowFallbackKeys(id));
  } else if (button.matches('.tag-label')) {
    // If the row leaves the view, keep focus on the same tag in the filter bar.
    toggleFilter(tag, [key('tag', id, tag), key('filter', tag)]);
  } else if (button.matches('.tag-remove')) {
    const tags = state.find((todo) => todo.id === id).tags;
    const nextTag = tags[tags.indexOf(tag) + 1];
    update(removeTag(state, id, tag), [
      nextTag && key('tag', id, nextTag),
      key('add-tag', id),
      ...rowFallbackKeys(id),
    ]);
  } else if (button.matches('.tag-add')) {
    editingId = id;
    render([key('tag-field', id)]);
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
    if (next === state) rejectTag(field);
    else update(next, [key('tag-field', id)]);
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
  renderSoon();
});
