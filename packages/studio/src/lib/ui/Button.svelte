<!--
  Button — the canonical interactive primitive.

  Renders as `<button>` unless `href` is set, in which case it renders
  as `<a>` with ARIA role="button"-equivalent semantics preserved via
  native link behaviour. When `loading` is true an inline Spinner
  replaces the left icon slot and `aria-busy` is set.

  Variants: primary | secondary | ghost | danger | subtle
  Sizes:    sm | md | lg

  Keyboard + focus are handled natively. `:focus-visible` uses the
  global `--shadow-focus` halo. Press-feedback is a 98% scale in
  `var(--ease)` (suppressed under reduced motion via token).

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Spinner from './Spinner.svelte';
  import type { Variant, Size } from './types.js';

  /**
   * Props for {@link Button}.
   */
  interface Props {
    /** Visual variant. Defaults to `primary`. */
    variant?: Variant;
    /** Size scale. Defaults to `md`. */
    size?: Extract<Size, 'sm' | 'md' | 'lg'>;
    /** When set, renders `<a href>` instead of `<button>`. */
    href?: string;
    /** Native button `type`. Ignored when `href` is set. Defaults to `button`. */
    type?: 'button' | 'submit' | 'reset';
    /** Disabled state — skips hover / focus styles and blocks clicks. */
    disabled?: boolean;
    /**
     * Loading state — replaces the left icon with an inline spinner,
     * disables the button, and sets `aria-busy`.
     */
    loading?: boolean;
    /**
     * When `true`, renders as a full-width block. Defaults to `false`.
     */
    block?: boolean;
    /** Extra class names forwarded to the root element. */
    class?: string;
    /** Native click handler. */
    onclick?: (event: MouseEvent) => void;
    /** Target / rel for anchor rendering. */
    target?: string;
    rel?: string;
    /** ARIA label override for icon-heavy buttons. */
    'aria-label'?: string;
    /** Default slot — button label or icon+label composition. */
    children?: Snippet;
    /** Icon slot rendered before the label. */
    iconLeft?: Snippet;
    /** Icon slot rendered after the label. */
    iconRight?: Snippet;
  }

  let {
    variant = 'primary',
    size = 'md',
    href,
    type = 'button',
    disabled = false,
    loading = false,
    block = false,
    class: extraClass = '',
    onclick,
    target,
    rel,
    'aria-label': ariaLabel,
    children,
    iconLeft,
    iconRight,
  }: Props = $props();

  const isLink = $derived(typeof href === 'string' && href.length > 0);
  const rootClass = $derived(
    `cleo-btn v-${variant} s-${size} ${block ? 'block' : ''} ${loading ? 'is-loading' : ''} ${extraClass}`.trim(),
  );
</script>

{#if isLink}
  <a
    class={rootClass}
    href={disabled ? undefined : href}
    {target}
    {rel}
    aria-disabled={disabled ? 'true' : undefined}
    aria-busy={loading ? 'true' : undefined}
    aria-label={ariaLabel}
    onclick={disabled ? undefined : onclick}
    tabindex={disabled ? -1 : undefined}
    role="button"
  >
    {#if loading}
      <span class="slot-left"><Spinner size={size === 'lg' ? 'sm' : 'xs'} label="" /></span>
    {:else if iconLeft}
      <span class="slot-left">{@render iconLeft()}</span>
    {/if}
    {#if children}
      <span class="label">{@render children()}</span>
    {/if}
    {#if iconRight}
      <span class="slot-right">{@render iconRight()}</span>
    {/if}
  </a>
{:else}
  <button
    class={rootClass}
    {type}
    {disabled}
    aria-busy={loading ? 'true' : undefined}
    aria-label={ariaLabel}
    {onclick}
  >
    {#if loading}
      <span class="slot-left"><Spinner size={size === 'lg' ? 'sm' : 'xs'} label="" /></span>
    {:else if iconLeft}
      <span class="slot-left">{@render iconLeft()}</span>
    {/if}
    {#if children}
      <span class="label">{@render children()}</span>
    {/if}
    {#if iconRight}
      <span class="slot-right">{@render iconRight()}</span>
    {/if}
  </button>
{/if}

<style>
  .cleo-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    font-family: var(--font-sans);
    font-weight: 600;
    line-height: var(--leading-tight);
    text-decoration: none;
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease),
      color var(--ease), box-shadow var(--ease), transform var(--ease);
    user-select: none;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
  }

  .cleo-btn.block {
    display: flex;
    width: 100%;
  }

  .cleo-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .cleo-btn:not(:disabled):active:not([aria-disabled='true']) {
    transform: scale(0.98);
  }

  .cleo-btn:disabled,
  .cleo-btn[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .cleo-btn.is-loading {
    cursor: progress;
  }

  /* ------------- sizes ------------- */
  .s-sm {
    height: 28px;
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
  }

  .s-md {
    height: 34px;
    padding: 0 var(--space-4);
    font-size: var(--text-sm);
  }

  .s-lg {
    height: 40px;
    padding: 0 var(--space-5);
    font-size: var(--text-base);
  }

  /* ------------- variants ------------- */
  .v-primary {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }

  .v-primary:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--accent) 85%, white 15%);
    border-color: color-mix(in srgb, var(--accent) 85%, white 15%);
  }

  .v-secondary {
    background: var(--bg-elev-1);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .v-secondary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--bg-elev-2);
    border-color: var(--accent);
    color: var(--accent);
  }

  .v-ghost {
    background: transparent;
    color: var(--text-dim);
    border-color: transparent;
  }

  .v-ghost:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--bg-elev-1);
    color: var(--text);
  }

  .v-subtle {
    background: var(--bg-elev-1);
    color: var(--text-dim);
    border-color: var(--border);
  }

  .v-subtle:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--bg-elev-2);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .v-danger {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }

  .v-danger:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--danger);
    color: var(--bg);
    border-color: var(--danger);
  }

  /* ------------- slots ------------- */
  .slot-left,
  .slot-right {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .label {
    display: inline-flex;
    align-items: center;
  }
</style>
