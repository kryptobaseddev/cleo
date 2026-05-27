<!--
  ChipGroup — wrapper for a row of {@link Chip} elements.

  Provides `role="group"` semantics, an optional `label`, and a
  consistent padded tray. Authors place Chip (or any other inline
  element) inside the default slot.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link ChipGroup}.
   */
  interface Props {
    /** Lead-in label, e.g. `"Status"`. */
    label?: string;
    /** Extra class names. */
    class?: string;
    /** Chip children. */
    children?: Snippet;
  }

  let { label, class: extraClass = '', children }: Props = $props();
</script>

<div class="chip-group {extraClass}" role="group" aria-label={label ?? 'Chips'}>
  {#if label}
    <span class="chip-group-label">{label}</span>
  {/if}
  {#if children}{@render children()}{/if}
</div>

<style>
  .chip-group {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    flex-wrap: wrap;
  }

  .chip-group-label {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    padding: 0 var(--space-2);
    display: inline-flex;
    align-items: center;
    font-weight: 600;
  }
</style>
