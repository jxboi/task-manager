import { addTodo, toggleTodo, removeTodo } from './todos.js';
import { load, save } from './storage.js';

const form = document.getElementById('add-form');
const input = document.getElementById('new-todo');
const addButton = document.getElementById('add-button');
const list = document.getElementById('todo-list');
const emptyState = document.getElementById('empty-state');
const summary = document.getElementById('summary');
const footer = document.getElementById('footer');
const trashIcon = document.getElementById('trash-icon');

let state = load();
render(state);

function update(next) {
  state = next;
  save(state);
  render(state);
}

function summaryText(todos) {
  if (todos.length === 0) return 'Nothing to do yet';
  const remaining = todos.filter((todo) => !todo.completed).length;
  return remaining === 0 ? 'All done' : `${remaining} to do`;
}

function checkboxId(id) {
  return `todo-${id}`;
}

function renderTodo(todo) {
  const item = document.createElement('li');
  item.className = todo.completed ? 'todo is-done' : 'todo';
  item.dataset.id = todo.id;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-checkbox';
  checkbox.id = checkboxId(todo.id);
  checkbox.checked = todo.completed;

  const label = document.createElement('label');
  label.className = 'todo-text';
  label.htmlFor = checkbox.id;
  label.textContent = todo.text;

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'todo-delete';
  deleteButton.setAttribute('aria-label', `Delete “${todo.text}”`);
  deleteButton.append(trashIcon.content.cloneNode(true));

  item.append(checkbox, label, deleteButton);
  return item;
}

function render(todos) {
  const completed = todos.filter((todo) => todo.completed).length;

  summary.textContent = summaryText(todos);
  list.replaceChildren(...todos.map(renderTodo));
  list.hidden = todos.length === 0;
  emptyState.hidden = todos.length > 0;
  footer.hidden = todos.length === 0;
  footer.textContent = `${completed} of ${todos.length} completed`;
}

function focusCheckbox(id) {
  document.getElementById(checkboxId(id)).focus();
}

input.addEventListener('input', () => {
  addButton.disabled = input.value.trim() === '';
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  update(addTodo(state, input.value));
  input.value = '';
  addButton.disabled = true;
  input.focus();
});

list.addEventListener('change', (event) => {
  if (!event.target.matches('.todo-checkbox')) return;
  const { id } = event.target.closest('.todo').dataset;
  update(toggleTodo(state, id));
  focusCheckbox(id);
});

list.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('.todo-delete');
  if (!deleteButton) return;
  const { id } = deleteButton.closest('.todo').dataset;
  const index = state.findIndex((todo) => todo.id === id);
  update(removeTodo(state, id));
  const neighbour = state[index] ?? state[index - 1];
  if (neighbour) focusCheckbox(neighbour.id);
  else input.focus();
});
