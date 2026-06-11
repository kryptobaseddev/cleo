<!--
  ThemeSwitcher — the client-only operator-console theme picker (T11798 ·
  E6-RESKIN-SHELL).

  A thin, presentational control bound to the {@link ThemeStore} rune. It
  renders the theme catalogue as a segmented selector plus a light/dark
  toggle and reflects the active theme onto `<html>` via the store (which
  re-resolves every `var(--…)` token for free). SSR-safe: the store guards
  all `document` / `localStorage` access, and this component reads
  `theme.active` reactively.

  The host route is responsible for `theme.hydrate()` inside a client
  `$effect` so the persisted choice restores on load — this component only
  switches.

  @task T11798
  @epic T11561 — E6-RESKIN-SHELL
  @saga T11555
-->
<script lang="ts">
  import {
    STUDIO_THEME_LABELS,
    type StudioTheme,
    type ThemeStore,
  } from '$lib/stores/theme.svelte.js';

  interface Props {
    /** The shared theme rune store (constructed + hydrated by the host route). */
    theme: ThemeStore;
  }

  let { theme }: Props = $props();

  function selectTheme(t: StudioTheme): void {
    theme.set(t);
  }
</script>

<div class="theme-switcher" role="group" aria-label="Operator console theme">
  <div class="seg" role="radiogroup" aria-label="Theme palette">
    {#each theme.themes as t (t)}
      <button
        type="button"
        class="seg-btn"
        class:active={theme.active === t}
        role="radio"
        aria-checked={theme.active === t}
        title={`${STUDIO_THEME_LABELS[t]} theme`}
        onclick={() => selectTheme(t)}
      >
        <span class="swatch" data-theme={t} aria-hidden="true"></span>
        {STUDIO_THEME_LABELS[t]}
      </button>
    {/each}
  </div>

  <button
    type="button"
    class="mode-btn"
    aria-pressed={theme.light}
    title="Toggle light operator console"
    onclick={() => theme.toggleLight()}
  >
    {theme.light ? 'Light' : 'Dark'}
  </button>
</div>

<style>
  .theme-switcher {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
  }

  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: color var(--ease), background var(--ease);
  }

  .seg-btn:hover {
    color: var(--text);
  }

  .seg-btn.active {
    color: var(--bg);
    background: var(--accent);
  }

  .seg-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-pill);
    /* The swatch carries its OWN data-theme so each pip previews that
       theme's accent regardless of the active console theme. */
    background: var(--accent);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
  }

  .mode-btn {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    background: var(--bg-elev-2);
    color: var(--text-dim);
    font-size: var(--text-2xs);
    font-weight: 600;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease);
  }

  .mode-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .mode-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }
</style>
