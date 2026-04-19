<!--
  EmptyState — placeholder shown when a list / panel has no data.

  Slot structure:
    - `icon`      : large mark (emoji / svg) at the top
    - (title)     : `title` prop
    - (subtitle)  : `subtitle` prop
    - `action`    : CTA button / link area

  Accepts a `variant` to switch between neutral (default) and warning
  tones — useful when an empty state is the result of an error (e.g.
  "Could not load tasks") rather than legitimate emptiness.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link EmptyState}.
   */
  interface Props {
    /** Big headline. */
    title: string;
    /** Supporting copy. */
    subtitle?: string;
    /** Visual tone. `neutral` (default) or `warning`. */
    variant?: 'neutral' | 'warning';
    /** Extra class names. */
    class?: string;
    /** Icon / mark slot. */
    icon?: Snippet;
    /** Action slot — typically a primary button. */
    action?: Snippet;
  }

  let {
    title,
    subtitle,
    variant = 'neutral',
    class: extraClass = '',
    icon,
    action,
  }: Props = $props();
</script>

<div class="empty v-{variant} {extraClass}" role="status" aria-live="polite">
  {#if icon}
    <div class="icon" aria-hidden="true">{@render icon()}</div>
  {/if}
  <h3 class="title">{title}</h3>
  {#if subtitle}
    <p class="subtitle">{subtitle}</p>
  {/if}
  {#if action}
    <div class="action">{@render action()}</div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-6);
    text-align: center;
    color: var(--text-dim);
    background: var(--bg-elev-1);
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
  }

  .empty.v-warning {
    border-color: color-mix(in srgb, var(--warning) 45%, transparent);
    background: color-mix(in srgb, var(--warning) 6%, var(--bg-elev-1));
  }

  .icon {
    font-size: var(--text-2xl);
    line-height: 1;
    color: var(--text-faint);
    margin-bottom: var(--space-1);
  }

  .empty.v-warning .icon {
    color: var(--warning);
  }

  .title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    line-height: var(--leading-tight);
    margin: 0;
  }

  .subtitle {
    font-size: var(--text-sm);
    color: var(--text-dim);
    max-width: 48ch;
    line-height: var(--leading-normal);
    margin: 0;
  }

  .action {
    margin-top: var(--space-3);
  }
</style>
