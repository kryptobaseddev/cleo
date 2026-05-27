// lib/todos.js — Pure, immutable todo CRUD. No DOM, no storage.

/** Generate a stable unique id. */
export function newId() {
  if (typeof globalThis !== "undefined"
      && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Factory for a fresh todo. */
export function createTodo(text) {
  const trimmed = String(text ?? "").trim();
  return {
    id: newId(),
    text: trimmed,
    completed: false,
    sessionCount: 0,
    createdAt: Date.now(),
  };
}

export function addTodo(list, text) {
  const todo = createTodo(text);
  if (!todo.text) return list;
  return [...list, todo];
}

export function editTodo(list, id, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return list;
  return list.map(t => (t.id === id ? { ...t, text: trimmed } : t));
}

export function deleteTodo(list, id) {
  return list.filter(t => t.id !== id);
}

export function toggleTodo(list, id) {
  return list.map(t => (t.id === id ? { ...t, completed: !t.completed } : t));
}

export function incrementSession(list, id) {
  return list.map(t => (t.id === id ? { ...t, sessionCount: t.sessionCount + 1 } : t));
}

/** Find a todo by id (undefined if missing). */
export function findTodo(list, id) {
  return list.find(t => t.id === id);
}
