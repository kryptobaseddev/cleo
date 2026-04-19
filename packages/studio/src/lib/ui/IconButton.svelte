<!--
  IconButton — square icon-only button.

  Thin wrapper around {@link Button} that enforces `aria-label`, removes
  the label slot, and squares the aspect ratio. Use for toolbar actions
  (close, copy, expand, refresh) where a visible text label would crowd
  the layout.

  `aria-label` is REQUIRED — the component's TypeScript props enforce it
  so authors cannot ship an unlabelled icon button.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Variant, Size } from './types.js';

  /**
   * Props for {@link IconButton}.
   */
  interface Props {
    /** REQUIRED accessible label for screen readers. */
    'aria-label': string;
    /** Visual variant. Defaults to `ghost`. */
    variant?: Variant;
    /** Size scale. Defaults to `md`. */
    size?: Extract<Size, 'sm' | 'md' | 'lg'>;
    /** Disabled state. */
    disabled?: boolean;
    /** Loading state — shows a spinner instead of the icon. */
    loading?: boolean;
    /** Click handler. */
    onclick?: (event: MouseEvent) => void;
    /** Tooltip-style native title, shown on hover. Defaults to `aria-label`. */
    title?: string;
    /** Extra class names. */
    class?: string;
    /** Default slot — the icon (SVG, glyph, emoji). */
    children?: Snippet;
  }

  let {
    'aria-label': ariaLabel,
    variant = 'ghost',
    size = 'md',
    disabled = false,
    loading = false,
    onclick,
    title,
    class: extraClass = '',
    children,
  }: Props = $props();

  const rootClass = $derived(
    `icon-btn v-${variant} s-${size} ${loading ? 'is-loading' : ''} ${extraClass}`.trim(),
  );
</script>

<button
  type="button"
  class={rootClass}
  aria-label={ariaLabel}
  aria-busy={loading ? 'true' : undefined}
  title={title ?? ariaLabel}
  {disabled}
  {onclick}
>
  {#if children}{@render children()}{/if}
</button>

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    font-family: var(--font-sans);
    cursor: pointer;
    padding: 0;
    transition: background var(--ease), border-color var(--ease),
      color var(--ease), box-shadow var(--ease), transform var(--ease);
    flex-shrink: 0;
  }

  .icon-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .icon-btn:not(:disabled):active {
    transform: scale(0.94);
  }

  .icon-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .s-sm {
    width: 24px;
    height: 24px;
    font-size: var(--text-xs);
  }

  .s-md {
    width: 30px;
    height: 30px;
    font-size: var(--text-sm);
  }

  .s-lg {
    width: 36px;
    height: 36px;
    font-size: var(--text-md);
  }

  .v-primary {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }

  .v-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, white 15%);
  }

  .v-secondary {
    background: var(--bg-elev-1);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .v-secondary:hover:not(:disabled) {
    background: var(--bg-elev-2);
    border-color: var(--accent);
    color: var(--accent);
  }

  .v-ghost {
    background: transparent;
    color: var(--text-dim);
  }

  .v-ghost:hover:not(:disabled) {
    background: var(--bg-elev-1);
    color: var(--text);
  }

  .v-subtle {
    background: var(--bg-elev-1);
    color: var(--text-dim);
    border-color: var(--border);
  }

  .v-subtle:hover:not(:disabled) {
    background: var(--bg-elev-2);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .v-danger {
    background: transparent;
    color: var(--danger);
  }

  .v-danger:hover:not(:disabled) {
    background: var(--danger-soft);
  }

  .is-loading {
    cursor: progress;
  }
</style>
