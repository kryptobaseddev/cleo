<!--
  Spinner — pure-CSS loading ring.

  No SVG, no JS runtime, zero dependencies. Honours
  `prefers-reduced-motion` via the `--ease-breathe` token which collapses
  to 0ms in the reduced-motion media query — the ring then renders as a
  static arc. Default size is `md` (16px).

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Size } from './types.js';

  /**
   * Props for {@link Spinner}.
   */
  interface Props {
    /** Diameter token. Defaults to `md` (16px). */
    size?: Size;
    /**
     * Accessible label. Defaults to `"Loading"`. Set to `""` when the
     * surrounding element already owns an accessible name.
     */
    label?: string;
  }

  let { size = 'md', label = 'Loading' }: Props = $props();
</script>

<span
  class="spinner size-{size}"
  role={label ? 'status' : 'presentation'}
  aria-label={label || undefined}
  aria-live={label ? 'polite' : undefined}
></span>

<style>
  .spinner {
    display: inline-block;
    border-radius: var(--radius-pill);
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  .size-xs {
    width: 10px;
    height: 10px;
    border-width: 1.5px;
  }

  .size-sm {
    width: 14px;
    height: 14px;
    border-width: 1.5px;
  }

  .size-md {
    width: 16px;
    height: 16px;
    border-width: 2px;
  }

  .size-lg {
    width: 22px;
    height: 22px;
    border-width: 2px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Reduced-motion: freeze the ring at a stable 3-quarter arc rather
   * than disappearing it — users still get a visual "loading" cue. */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
