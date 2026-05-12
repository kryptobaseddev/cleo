// lib/storage.js — Pure localStorage persistence with safe defaults.
// Designed to be importable in Node tests (guards missing window/localStorage).

export const STORAGE_KEY = "pomodoro.v1";
export const THEME_KEY = "pomodoro.theme";

export const DEFAULTS = Object.freeze({
  todos: [],
  settings: { work: 25, short: 5, long: 15 },
  counters: {}, // { [todoId]: totalSessions }
  dailyTotal: 0,
  dailyTotalDate: null, // ISO date string "YYYY-MM-DD"
  selectedId: null,
  theme: null, // null = auto (match OS)
});

/** Deep-freeze a structure so consumers don't mutate DEFAULTS accidentally. */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/** Safe getter — returns DEFAULTS on any failure. */
export function load(storage = getStorage()) {
  const out = cloneDefaults();
  if (!storage) return out;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Merge known keys only — tolerate missing or extra keys.
      for (const k of Object.keys(out)) {
        if (k in parsed) out[k] = parsed[k];
      }
      // Re-merge nested settings so a partial settings object keeps defaults.
      out.settings = { ...DEFAULTS.settings, ...(parsed.settings || {}) };
    }
  } catch {
    // Corrupt JSON or access denied — fall back to defaults.
  }
  return out;
}

/** Safe writer — swallows quota / security errors. */
export function save(state, storage = getStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clear(storage = getStorage()) {
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function loadTheme(storage = getStorage()) {
  if (!storage) return null;
  try { return storage.getItem(THEME_KEY); } catch { return null; }
}

export function saveTheme(theme, storage = getStorage()) {
  if (!storage) return;
  try { storage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

/** Returns the platform storage or null if unavailable. */
function getStorage() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch { /* access denied */ }
  return null;
}

/** Local-date ISO key, e.g. "2026-04-15". */
export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Apply daily-total rollover if the stored date is stale. Returns updated state. */
export function rolloverDailyTotal(state, now = new Date()) {
  const today = todayISO(now);
  if (state.dailyTotalDate !== today) {
    return { ...state, dailyTotal: 0, dailyTotalDate: today };
  }
  return state;
}
