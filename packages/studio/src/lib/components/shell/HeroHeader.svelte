<!--
  HeroHeader — page-level hero with eyebrow, title, subtitle, optional
  meta line and a right-aligned action slot.

  Used across Wave 1E surfaces (Dashboard, Admin, Sessions, Pipeline,
  Task Detail) to replace the ad-hoc page headers that had been
  duplicating hex literals and spacing values before token migration.

  Visual anatomy:

      [LIVE ●]  EYEBROW (uppercase)            [ action slot ]
      Page Title Here
      subtitle line — dim, one paragraph max
      meta · mono · faint

  No internal state. Actions are fully owned by the caller via the
  `actions` snippet.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link HeroHeader}.
   */
  interface Props {
    /** Uppercase eyebrow rendered above the title. */
    eyebrow?: string;
    /** Page title. Required. Rendered at `--text-2xl`. */
    title: string;
    /** Supporting subtitle, dim colour. */
    subtitle?: string;
    /** Monospace meta line under the subtitle (path, timestamp, …). */
    meta?: string;
    /** Show a pulsing live dot next to the eyebrow. */
    liveIndicator?: boolean;
    /** Optional right-aligned action slot (buttons, chips, …). */
    actions?: Snippet;
    /** Extra class names forwarded to the root. */
    class?: string;
  }

  let {
    eyebrow,
    title,
    subtitle,
    meta,
    liveIndicator = false,
    actions,
    class: extraClass = '',
  }: Props = $props();
</script>

<header class="hero {extraClass}">
  <div class="hero-left">
    {#if eyebrow || liveIndicator}
      <div class="hero-eyebrow-row">
        {#if liveIndicator}
          <span class="hero-live" aria-hidden="true">
            <span class="hero-live-dot"></span>
            <span class="hero-live-label">LIVE</span>
          </span>
        {/if}
        {#if eyebrow}
          <span class="hero-eyebrow">{eyebrow}</span>
        {/if}
      </div>
    {/if}
    <h1 class="hero-title">{title}</h1>
    {#if subtitle}
      <p class="hero-subtitle">{subtitle}</p>
    {/if}
    {#if meta}
      <p class="hero-meta" aria-label="Page metadata">{meta}</p>
    {/if}
  </div>
  {#if actions}
    <div class="hero-actions" role="toolbar" aria-label="Page actions">
      {@render actions()}
    </div>
  {/if}
</header>

<style>
  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-6);
    padding-bottom: var(--space-5);
    margin-bottom: var(--space-6);
    border-bottom: 1px solid var(--border);
    position: relative;
  }

  .hero::after {
    /* Subtle violet underline — NASA telemetry bar feel. */
    content: '';
    position: absolute;
    left: 0;
    bottom: -1px;
    width: 64px;
    height: 1px;
    background: var(--accent);
    box-shadow: 0 0 12px var(--accent-halo);
  }

  .hero-left {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
  }

  .hero-eyebrow-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 1rem;
  }

  .hero-live {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--success);
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .hero-live-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--success);
    box-shadow: 0 0 8px var(--success);
    animation: hero-pulse var(--ease-pulse);
  }

  @keyframes hero-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .hero-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .hero-title {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.015em;
    line-height: var(--leading-tight);
    margin: 0;
  }

  .hero-subtitle {
    font-size: var(--text-base);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
    max-width: 72ch;
  }

  .hero-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    margin: 0;
    letter-spacing: 0.02em;
  }

  .hero-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .hero {
      flex-direction: column;
      align-items: stretch;
    }

    .hero-actions {
      justify-content: flex-start;
    }
  }
</style>
