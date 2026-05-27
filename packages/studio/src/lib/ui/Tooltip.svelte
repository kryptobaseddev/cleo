<!--
  Tooltip — hover / focus reveal with configurable placement and delay.

  Uses CSS-only positioning based on the `placement` prop. No Floating
  UI, no popover API quirks — just absolute-positioned children over
  the trigger. Accessible because:
    - the tooltip's id is bound via `aria-describedby` on the trigger
    - hover AND keyboard focus both reveal
    - ESC hides
    - disappears on blur / mouseleave

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Placement } from './types.js';

  /**
   * Props for {@link Tooltip}.
   */
  interface Props {
    /** Tooltip text. Plain-string API keeps rendering predictable for AT. */
    content: string;
    /** Placement relative to the trigger. Defaults to `top`. */
    placement?: Placement;
    /** Reveal delay in ms. Defaults to 200. */
    delay?: number;
    /** Extra class names on the wrapper. */
    class?: string;
    /**
     * Default slot — the trigger element. Authors should put an actual
     * interactive element (button / link) inside, not a bare span.
     */
    children?: Snippet;
  }

  let {
    content,
    placement = 'top',
    delay = 200,
    class: extraClass = '',
    children,
  }: Props = $props();

  const uid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const tipId = `cleo-tt-${uid}`;

  let open = $state(false);
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  function show(): void {
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      open = true;
    }, delay);
  }

  function hide(): void {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    open = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') hide();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tt-wrap {extraClass}"
  aria-describedby={open ? tipId : undefined}
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={show}
  onfocusout={hide}
  onkeydown={onKey}
>
  {#if children}{@render children()}{/if}
  <span
    class="tt p-{placement}"
    class:open
    id={tipId}
    role="tooltip"
  >{content}</span>
</span>

<style>
  .tt-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .tt {
    position: absolute;
    z-index: 1000;
    padding: var(--space-1) var(--space-2);
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 500;
    line-height: var(--leading-tight);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--ease), transform var(--ease);
    box-shadow: var(--shadow-sm);
  }

  .tt.open {
    opacity: 1;
  }

  .tt.p-top {
    left: 50%;
    bottom: calc(100% + var(--space-2));
    transform: translateX(-50%) translateY(4px);
  }

  .tt.p-top.open {
    transform: translateX(-50%) translateY(0);
  }

  .tt.p-bottom {
    left: 50%;
    top: calc(100% + var(--space-2));
    transform: translateX(-50%) translateY(-4px);
  }

  .tt.p-bottom.open {
    transform: translateX(-50%) translateY(0);
  }

  .tt.p-left {
    right: calc(100% + var(--space-2));
    top: 50%;
    transform: translateY(-50%) translateX(4px);
  }

  .tt.p-left.open {
    transform: translateY(-50%) translateX(0);
  }

  .tt.p-right {
    left: calc(100% + var(--space-2));
    top: 50%;
    transform: translateY(-50%) translateX(-4px);
  }

  .tt.p-right.open {
    transform: translateY(-50%) translateX(0);
  }
</style>
