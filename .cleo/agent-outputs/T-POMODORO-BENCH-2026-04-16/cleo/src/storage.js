/**
 * Pure localStorage persistence module.
 *
 * Provides load/save for application state with a schema version for
 * forward-compat migrations. Written as an ES module with a pluggable
 * backing store so it can run under node:test without a browser.
 */

export const STORAGE_KEY = 'pomodoro-todos:v1';
export const SCHEMA_VERSION = 1;

/**
 * Shape of the persisted state. Consumers should treat this as the
 * source of truth for types.
 */
export const DEFAULT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  todos: [],
  settings: {
    work: 25,
    short: 5,
    long: 15,
    cadence: 4,
  },
  counters: {
    dailyDate: null, // ISO YYYY-MM-DD
    dailyCount: 0,
  },
  selectedTodoId: null,
  theme: 'auto', // 'auto' | 'light' | 'dark'
});

/**
 * Return a deep clone of DEFAULT_STATE so callers can mutate safely.
 * @returns {object}
 */
export function defaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

/**
 * Load state from a store. Missing or malformed data yields defaults.
 * @param {{getItem: (k:string)=>string|null}} store
 * @returns {object}
 */
export function loadState(store) {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultState();
    return mergeWithDefaults(parsed);
  } catch {
    return defaultState();
  }
}

/**
 * Write state. Stringify is caller-safe (no circular refs expected).
 * @param {{setItem: (k:string, v:string)=>void}} store
 * @param {object} state
 */
export function saveState(store, state) {
  const payload = { ...state, schemaVersion: SCHEMA_VERSION };
  store.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/**
 * Merge loaded state with defaults so newly-added fields get sensible
 * values without user action.
 * @param {object} loaded
 * @returns {object}
 */
export function mergeWithDefaults(loaded) {
  const base = defaultState();
  return {
    ...base,
    ...loaded,
    settings: { ...base.settings, ...(loaded.settings || {}) },
    counters: { ...base.counters, ...(loaded.counters || {}) },
    todos: Array.isArray(loaded.todos) ? loaded.todos : [],
  };
}

/**
 * Tiny in-memory store for tests and SSR; API-compatible with Storage.
 */
export function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
  };
}
