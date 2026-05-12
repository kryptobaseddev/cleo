/**
 * Pure todo CRUD operations. Immutable — all functions return new arrays.
 * No DOM, no side effects, so these are safe to unit-test under node:test.
 */

/**
 * @typedef {Object} Todo
 * @property {string} id
 * @property {string} title
 * @property {boolean} done
 * @property {number} sessions - completed pomodoro sessions on this todo
 * @property {number} createdAt
 */

/**
 * Generate a collision-resistant id.
 * Uses crypto.randomUUID when available, falls back to timestamp+rand.
 */
export function newId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a new todo and append it to the list.
 * @param {Todo[]} todos
 * @param {string} title
 * @returns {Todo[]} new list (original unchanged)
 */
export function addTodo(todos, title) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) return todos.slice();
  const todo = {
    id: newId(),
    title: trimmed,
    done: false,
    sessions: 0,
    createdAt: Date.now(),
  };
  return [...todos, todo];
}

/**
 * Update the title of an existing todo. Empty/whitespace titles are ignored.
 * @param {Todo[]} todos
 * @param {string} id
 * @param {string} title
 * @returns {Todo[]}
 */
export function editTodo(todos, id, title) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) return todos.slice();
  return todos.map((t) => (t.id === id ? { ...t, title: trimmed } : t));
}

/**
 * Delete a todo by id.
 * @param {Todo[]} todos
 * @param {string} id
 * @returns {Todo[]}
 */
export function deleteTodo(todos, id) {
  return todos.filter((t) => t.id !== id);
}

/**
 * Toggle the done flag on a todo.
 * @param {Todo[]} todos
 * @param {string} id
 * @returns {Todo[]}
 */
export function toggleComplete(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

/**
 * Increment the session counter for a todo (called when a work phase ends).
 * @param {Todo[]} todos
 * @param {string} id
 * @returns {Todo[]}
 */
export function incrementSession(todos, id) {
  if (!id) return todos;
  return todos.map((t) => (t.id === id ? { ...t, sessions: (t.sessions || 0) + 1 } : t));
}

/**
 * Look up a todo by id.
 * @param {Todo[]} todos
 * @param {string} id
 * @returns {Todo | undefined}
 */
export function findTodo(todos, id) {
  return todos.find((t) => t.id === id);
}
