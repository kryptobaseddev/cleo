/**
 * `theme.svelte.ts` — the client-only Svelte-5 RUNE store backing the
 * multi-theme operator-console switcher (T11796 · E6-RESKIN-SHELL).
 *
 * The store owns the active `[data-theme]` selection + the light/dark
 * preference and reflects BOTH onto the `<html>` element so every
 * `var(--…)` reference in `tokens.css` re-resolves for free. It persists
 * the choice to `localStorage` so a reload restores it, and it is a no-op
 * under SSR (guards every `document` / `localStorage` access) — a route
 * mounts it inside a `$effect` (client-only) exactly like the saga-board
 * store.
 *
 * ## Why a class with `$state`
 *
 * `$state` is a compiler rune that only works inside a `.svelte` /
 * `.svelte.ts` module. A class instance with `$state` fields is the
 * canonical Svelte-5 shared-reactive-object pattern (same shape as
 * {@link import('./saga-board.svelte.js').SagaBoardStore}) — a component
 * reads `theme.active` reactively and calls `theme.set(...)` to switch.
 *
 * @packageDocumentation
 * @module $lib/stores/theme
 *
 * @task T11796 — multi-theme token blocks + client-only theme rune
 * @epic T11561 — E6-RESKIN-SHELL
 * @saga T11555
 */

/** The catalogue of operator-console themes (mirrors `tokens.css` blocks). */
export const STUDIO_THEMES = ['hermes', 'nous', 'bronze', 'slate', 'mono'] as const;

/** One operator-console theme id. */
export type StudioTheme = (typeof STUDIO_THEMES)[number];

/** Human-readable labels for the theme switcher UI. */
export const STUDIO_THEME_LABELS: Record<StudioTheme, string> = {
  hermes: 'Hermes',
  nous: 'Nous',
  bronze: 'Bronze',
  slate: 'Slate',
  mono: 'Mono',
};

/** The default theme when nothing is persisted. */
export const DEFAULT_STUDIO_THEME: StudioTheme = 'hermes';

/** `localStorage` keys the store reads / writes. */
const THEME_KEY = 'cleo-studio-theme';
const MODE_KEY = 'cleo-studio-theme-mode';

/** Narrow an arbitrary string to a known theme, else the default. */
function coerceTheme(value: string | null): StudioTheme {
  return (STUDIO_THEMES as readonly string[]).includes(value ?? '')
    ? (value as StudioTheme)
    : DEFAULT_STUDIO_THEME;
}

/**
 * The reactive theme store. Construct via {@link createThemeStore}.
 *
 * Holds the active theme + light-mode flag as `$state`; `apply()` reflects
 * them onto `<html>` (`data-theme` + a `.light` class). All DOM access is
 * SSR-guarded so the store is safe to instantiate at module scope and
 * `apply()` from a client `$effect`.
 */
export class ThemeStore {
  /** The active operator-console theme. */
  #active = $state<StudioTheme>(DEFAULT_STUDIO_THEME);
  /** Whether the light operator-console variant is active. */
  #light = $state(false);

  /**
   * @param initial - Optional SSR-provided initial theme (e.g. from a cookie).
   */
  constructor(initial?: StudioTheme) {
    if (initial) this.#active = initial;
  }

  /** The active theme id. */
  get active(): StudioTheme {
    return this.#active;
  }

  /** Whether the light variant is active. */
  get light(): boolean {
    return this.#light;
  }

  /** The ordered theme catalogue (static). */
  get themes(): readonly StudioTheme[] {
    return STUDIO_THEMES;
  }

  /**
   * Hydrate from `localStorage` (client-only) then reflect onto `<html>`.
   * Idempotent + SSR-safe (no-op on the server). A route calls this once
   * from a client `$effect`.
   */
  hydrate(): void {
    if (typeof localStorage !== 'undefined') {
      this.#active = coerceTheme(localStorage.getItem(THEME_KEY));
      this.#light = localStorage.getItem(MODE_KEY) === 'light';
    }
    this.apply();
  }

  /**
   * Switch to a new theme, persist it, and re-apply.
   *
   * @param theme - The theme to activate.
   */
  set(theme: StudioTheme): void {
    this.#active = theme;
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, theme);
    this.apply();
  }

  /**
   * Toggle the light operator-console variant, persist it, and re-apply.
   */
  toggleLight(): void {
    this.#light = !this.#light;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MODE_KEY, this.#light ? 'light' : 'dark');
    }
    this.apply();
  }

  /**
   * Reflect the current `$state` onto the document root. SSR-safe (the
   * `document` guard makes this a no-op on the server).
   */
  apply(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', this.#active);
    root.classList.toggle('light', this.#light);
  }
}

/**
 * Create a {@link ThemeStore}. The ergonomic entry point a route uses.
 *
 * @param initial - Optional SSR initial theme.
 * @returns A fresh reactive theme store.
 *
 * @example
 * ```ts
 * const theme = createThemeStore();
 * $effect(() => { theme.hydrate(); });
 * ```
 */
export function createThemeStore(initial?: StudioTheme): ThemeStore {
  return new ThemeStore(initial);
}
