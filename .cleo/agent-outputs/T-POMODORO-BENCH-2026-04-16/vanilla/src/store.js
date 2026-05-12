// @ts-check
/**
 * Todo store — pure functions over a plain object + optional localStorage persistence.
 *
 * State shape:
 *   {
 *     todos: Todo[],
 *     selectedId: string | null,
 *     dailyTotal: { date: string (YYYY-MM-DD), count: number }
 *   }
 *
 * Todo shape:
 *   { id: string, text: string, done: boolean, sessions: number, createdAt: number }
 *
 * All mutation helpers return a NEW state object (immutable-style) so they are
 * trivially testable without mocking.
 */

export const STORAGE_KEY = 'focus.state.v1';

/** @typedef {{ id: string, text: string, done: boolean, sessions: number, createdAt: number }} Todo */
/** @typedef {{ todos: Todo[], selectedId: string | null, dailyTotal: { date: string, count: number } }} TodoState */

/**
 * Return an ISO-like date string in the user's local timezone (YYYY-MM-DD).
 * @param {Date} [d]
 * @returns {string}
 */
export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Create a fresh empty state.
 * @returns {TodoState}
 */
export function emptyState() {
  return {
    todos: [],
    selectedId: null,
    dailyTotal: { date: todayKey(), count: 0 },
  };
}

/**
 * Generate a short-ish unique id. Uses crypto when available for real builds,
 * falls back to timestamp+random for Node tests that don't expose crypto.
 * @returns {string}
 */
export function makeId() {
  if (typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Add a new todo. Returns a new state.
 * @param {TodoState} state
 * @param {string} text
 * @returns {TodoState}
 */
export function addTodo(state, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return state;
  /** @type {Todo} */
  const todo = {
    id: makeId(),
    text: trimmed,
    done: false,
    sessions: 0,
    createdAt: Date.now(),
  };
  return { ...state, todos: [todo, ...state.todos] };
}

/**
 * Edit a todo's text. No-op when id missing or text empty.
 * @param {TodoState} state
 * @param {string} id
 * @param {string} text
 * @returns {TodoState}
 */
export function editTodo(state, id, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return state;
  return {
    ...state,
    todos: state.todos.map(t => t.id === id ? { ...t, text: trimmed } : t),
  };
}

/**
 * Delete a todo by id. Clears selectedId when removing the selected todo.
 * @param {TodoState} state
 * @param {string} id
 * @returns {TodoState}
 */
export function deleteTodo(state, id) {
  const todos = state.todos.filter(t => t.id !== id);
  const selectedId = state.selectedId === id ? null : state.selectedId;
  return { ...state, todos, selectedId };
}

/**
 * Toggle a todo's done flag.
 * @param {TodoState} state
 * @param {string} id
 * @returns {TodoState}
 */
export function toggleTodo(state, id) {
  return {
    ...state,
    todos: state.todos.map(t => t.id === id ? { ...t, done: !t.done } : t),
  };
}

/**
 * Select a todo (or clear when id == null).
 * @param {TodoState} state
 * @param {string | null} id
 * @returns {TodoState}
 */
export function selectTodo(state, id) {
  if (id != null && !state.todos.some(t => t.id === id)) return state;
  return { ...state, selectedId: id };
}

/**
 * Increment the session counter on the currently selected todo AND the daily
 * total. Used after completing a Work phase. Rolls over the daily counter
 * when the stored date no longer matches today.
 * @param {TodoState} state
 * @returns {TodoState}
 */
export function incrementSession(state) {
  const today = todayKey();
  const dailyTotal = state.dailyTotal.date === today
    ? { date: today, count: state.dailyTotal.count + 1 }
    : { date: today, count: 1 };

  if (!state.selectedId) return { ...state, dailyTotal };

  const todos = state.todos.map(t =>
    t.id === state.selectedId ? { ...t, sessions: t.sessions + 1 } : t
  );
  return { ...state, todos, dailyTotal };
}

/**
 * Serialize state to a JSON string.
 * @param {TodoState} state
 * @returns {string}
 */
export function serialize(state) {
  return JSON.stringify(state);
}

/**
 * Parse a serialized state string. Returns emptyState on invalid input.
 * Ensures shape defaults, filling missing fields from emptyState.
 * @param {string | null | undefined} raw
 * @returns {TodoState}
 */
export function deserialize(raw) {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const base = emptyState();
    return {
      todos: Array.isArray(parsed.todos)
        ? parsed.todos.filter(t => t && typeof t.id === 'string' && typeof t.text === 'string').map(t => ({
            id: t.id,
            text: t.text,
            done: !!t.done,
            sessions: Number.isFinite(t.sessions) ? t.sessions : 0,
            createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
          }))
        : base.todos,
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
      dailyTotal: parsed.dailyTotal && typeof parsed.dailyTotal === 'object'
        ? {
            date: typeof parsed.dailyTotal.date === 'string' ? parsed.dailyTotal.date : todayKey(),
            count: Number.isFinite(parsed.dailyTotal.count) ? parsed.dailyTotal.count : 0,
          }
        : base.dailyTotal,
    };
  } catch {
    return emptyState();
  }
}

/**
 * Load state from a storage-like object. Defaults to localStorage when in
 * browser context. Pure enough to test with an in-memory stub.
 * @param {{ getItem(k: string): string | null }} [storage]
 * @returns {TodoState}
 */
export function load(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return emptyState();
  const raw = store.getItem(STORAGE_KEY);
  const state = deserialize(raw);
  // daily rollover at load time
  const today = todayKey();
  if (state.dailyTotal.date !== today) {
    return { ...state, dailyTotal: { date: today, count: 0 } };
  }
  return state;
}

/**
 * Save state to a storage-like object.
 * @param {TodoState} state
 * @param {{ setItem(k: string, v: string): void }} [storage]
 */
export function save(state, storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  store.setItem(STORAGE_KEY, serialize(state));
}
