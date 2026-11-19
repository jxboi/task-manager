export function addTodo(todos, text) {
  const trimmed = text.trim();
  if (trimmed === '') return todos;
  return [
    ...todos,
    { id: crypto.randomUUID(), text: trimmed, completed: false, createdAt: Date.now() },
  ];
}

export function toggleTodo(todos, id) {
  return todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo));
}

export function removeTodo(todos, id) {
  return todos.filter((todo) => todo.id !== id);
}
