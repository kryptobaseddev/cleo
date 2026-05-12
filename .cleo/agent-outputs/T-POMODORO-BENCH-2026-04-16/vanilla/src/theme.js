// @ts-check
/**
 * Theme manager — cycles auto → light → dark → auto.
 * Persists to localStorage under 'focus.theme.v1'.
 * Applies <html data-theme="..."> so CSS tokens pick it up.
 */

const KEY = 'focus.theme.v1';
/** @type {readonly ('auto' | 'light' | 'dark')[]} */
export const THEMES = ['auto', 'light', 'dark'];

/**
 * Load the persisted theme, defaulting to 'auto'.
 * @returns {'auto' | 'light' | 'dark'}
 */
export function loadTheme() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {}
  return 'auto';
}

/**
 * Save and apply a theme.
 * @param {'auto' | 'light' | 'dark'} theme
 */
export function applyTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch {}
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
}

/**
 * Cycle to the next theme in the sequence.
 * @param {'auto' | 'light' | 'dark'} current
 * @returns {'auto' | 'light' | 'dark'}
 */
export function nextTheme(current) {
  const i = THEMES.indexOf(current);
  return THEMES[(i + 1) % THEMES.length];
}
