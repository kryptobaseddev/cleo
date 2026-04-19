<!--
  Chip — single toggle / action pill.

  Used inside {@link ChipGroup} for filter panels, inline tag inputs, and
  keyword facets. In toggle mode the button sets `aria-pressed` so
  assistive tech announces the on/off state.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link Chip}.
   */
  interface Props {
    /** Bindable active state for toggle-style chips. */
    active?: boolean;
    /**
     * Interaction mode.
     *   `toggle` — a pressable button with aria-pressed.
     *   `action` — a fire-and-forget button (no pressed state).
     *   `inert`  — render as `<span>` (no interaction).
     */
    mode?: 'toggle' | 'action' | 'inert';
    /** Optional numeric count trailing the label. */
    count?: number;
    /**
     * Optional hex colour to tint the chip when active. Falls back to
     * `--accent`. Consumed via the `--chip-tint` custom property so the
     * same token-consumption pattern as FilterChipGroup is preserved.
     */
    tint?: string;
    /** Disabled state. */
    disabled?: boolean;
    /** Extra class names. */
    class?: string;
    /** Default slot — the chip label. */
    children?: Snippet;
    /** Icon / dot slot rendered before the label. */
    leading?: Snippet;
    /** Click handler. Fires on activate for toggle & action modes. */
    onclick?: () => void;
  }

  let {
    active = $bindable(false),
    mode = 'toggle',
    count,
    tint,
    disabled = false,
    class: extraClass = '',
    children,
    leading,
    onclick,
  }: Props = $props();

  function handleClick(): void {
    if (disabled) return;
    if (mode === 'toggle') active = !active;
    onclick?.();
  }

  const tintStyle = $derived(tint ? `--chip-tint:${tint};` : undefined);
</script>

{#if mode === 'inert'}
  <span class="chip inert {extraClass}" class:active style={tintStyle}>
    {#if leading}
      <span class="leading" aria-hidden="true">{@render leading()}</span>
    {/if}
    <span class="chip-label">
      {#if children}{@render children()}{/if}
    </span>
    {#if typeof count === 'number'}
      <span class="chip-count">{count}</span>
    {/if}
  </span>
{:else}
  <button
    type="button"
    class="chip {extraClass}"
    class:active
    class:action={mode === 'action'}
    aria-pressed={mode === 'toggle' ? active : undefined}
    {disabled}
    onclick={handleClick}
    style={tintStyle}
  >
    {#if leading}
      <span class="leading" aria-hidden="true">{@render leading()}</span>
    {/if}
    <span class="chip-label">
      {#if children}{@render children()}{/if}
    </span>
    {#if typeof count === 'number'}
      <span class="chip-count">{count}</span>
    {/if}
  </button>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: var(--leading-tight);
    cursor: pointer;
    transition: background var(--ease), color var(--ease),
      border-color var(--ease), box-shadow var(--ease);
  }

  .chip:hover:not(:disabled):not(.inert) {
    color: var(--text);
    background: var(--bg-elev-2);
  }

  .chip:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .chip.active {
    color: var(--text);
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .chip.active[style*="--chip-tint"] {
    background: color-mix(in srgb, var(--chip-tint) 20%, transparent);
    color: var(--chip-tint);
    border-color: color-mix(in srgb, var(--chip-tint) 45%, transparent);
  }

  .chip:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .chip.inert {
    cursor: default;
  }

  .leading {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .chip-label {
    line-height: 1;
    white-space: nowrap;
  }

  .chip-count {
    font-size: 0.625rem;
    opacity: 0.85;
    background: rgba(255, 255, 255, 0.05);
    padding: 0.075rem var(--space-2);
    border-radius: var(--radius-pill);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
</style>
