<!--
  Badge — generic semantic pill.

  One component, six tones, two sizes. Consumers like StatusBadge and
  PriorityBadge wrap Badge with domain-specific mapping logic while
  keeping their public prop API unchanged (see Wave 0 brief §5).

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Size, Tone } from './types.js';

  /**
   * Props for {@link Badge}.
   */
  interface Props {
    /** Semantic tone. Defaults to `neutral`. */
    tone?: Tone;
    /** Size. Only `sm | md` supported. Defaults to `md`. */
    size?: Extract<Size, 'sm' | 'md'>;
    /**
     * When true, remove the tinted background and render label only.
     * Useful for dense list rows where a full pill would be noisy.
     */
    subtle?: boolean;
    /**
     * When true, round fully (pill-shape). Defaults to `false` (rounded
     * square). Set to `true` for count badges.
     */
    pill?: boolean;
    /** Icon / glyph slot shown before the label. */
    icon?: Snippet;
    /** Default slot — the badge text. */
    children?: Snippet;
    /** Extra class names. */
    class?: string;
    /** Optional accessible label override (for icon-only badges). */
    'aria-label'?: string;
  }

  let {
    tone = 'neutral',
    size = 'md',
    subtle = false,
    pill = false,
    icon,
    children,
    class: extraClass = '',
    'aria-label': ariaLabel,
  }: Props = $props();
</script>

<span
  class="badge t-{tone} s-{size} {extraClass}"
  class:subtle
  class:pill
  role="status"
  aria-label={ariaLabel}
>
  {#if icon}
    <span class="badge-icon" aria-hidden="true">{@render icon()}</span>
  {/if}
  {#if children}
    <span class="badge-label">{@render children()}</span>
  {/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: var(--leading-tight);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .badge.s-sm {
    font-size: 0.625rem;
    padding: 1px var(--space-2);
    gap: 3px;
  }

  .badge.s-md {
    font-size: var(--text-2xs);
    padding: 2px var(--space-2);
    gap: var(--space-1);
  }

  .badge.pill {
    border-radius: var(--radius-pill);
    padding-left: var(--space-3);
    padding-right: var(--space-3);
  }

  .badge-icon {
    display: inline-flex;
    align-items: center;
    font-size: 0.75rem;
    line-height: 1;
  }

  /* ------------- tones ------------- */
  .t-neutral {
    background: var(--neutral-soft);
    color: var(--text-dim);
  }

  .t-success {
    background: var(--success-soft);
    color: var(--success);
  }

  .t-warning {
    background: var(--warning-soft);
    color: var(--warning);
  }

  .t-danger {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .t-info {
    background: var(--info-soft);
    color: var(--info);
  }

  .t-accent {
    background: var(--accent-soft);
    color: var(--accent);
  }

  /* subtle variant — transparent background, text-only colour */
  .badge.subtle {
    background: transparent;
    padding-left: 0;
    padding-right: 0;
  }
</style>
