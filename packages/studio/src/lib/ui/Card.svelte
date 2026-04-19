<!--
  Card — container surface with optional header/footer slots.

  Three padding densities (compact / cozy / comfy) and an
  `interactive` flag that adds a hover lift using `--shadow-hover` +
  a 1px `translateY(-1px)`. When `interactive` is set, authors are
  expected to place a clickable child (link or button) inside — the
  Card itself is not focusable.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { CardDensity } from './types.js';

  /**
   * Props for {@link Card}.
   */
  interface Props {
    /** Padding density. Defaults to `cozy` (16px). */
    padding?: CardDensity;
    /**
     * When true, the card shows a hover lift + shadow. Does NOT make
     * the root focusable — place a link/button inside instead.
     */
    interactive?: boolean;
    /**
     * Visual elevation:
     *   0 — flat (bg only)
     *   1 — default (bg-elev-1, border)
     *   2 — raised (bg-elev-2, border-strong, shadow-md)
     */
    elevation?: 0 | 1 | 2;
    /** Extra class names forwarded to the root. */
    class?: string;
    /** Optional header slot. */
    header?: Snippet;
    /** Default content slot. */
    children?: Snippet;
    /** Optional footer slot. */
    footer?: Snippet;
  }

  let {
    padding = 'cozy',
    interactive = false,
    elevation = 1,
    class: extraClass = '',
    header,
    children,
    footer,
  }: Props = $props();
</script>

<article
  class="card p-{padding} e-{elevation} {extraClass}"
  class:interactive
>
  {#if header}
    <header class="card-header">{@render header()}</header>
  {/if}
  <div class="card-body">
    {#if children}{@render children()}{/if}
  </div>
  {#if footer}
    <footer class="card-footer">{@render footer()}</footer>
  {/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text);
    transition: border-color var(--ease), background var(--ease),
      box-shadow var(--ease), transform var(--ease);
    overflow: hidden;
  }

  .card.e-0 {
    background: var(--bg);
    border-color: var(--border);
  }

  .card.e-1 {
    background: var(--bg-elev-1);
    border-color: var(--border);
  }

  .card.e-2 {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
    box-shadow: var(--shadow-md);
  }

  .card.interactive:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-hover);
    transform: translateY(-1px);
  }

  /* padding applies to the body; header/footer have their own dividers */
  .card.p-compact .card-body {
    padding: var(--space-2);
  }

  .card.p-cozy .card-body {
    padding: var(--space-4);
  }

  .card.p-comfy .card-body {
    padding: var(--space-6);
  }

  .card-header,
  .card-footer {
    padding: var(--space-3) var(--space-4);
  }

  .card-header {
    border-bottom: 1px solid var(--border);
  }

  .card-footer {
    border-top: 1px solid var(--border);
    background: var(--bg);
  }

  .card-body {
    flex: 1;
    min-width: 0;
  }
</style>
