<!--
  Drawer — side sheet that slides from the left or right edge.

  Built on native `<dialog>` so we inherit focus trap + ESC-to-close +
  focus restoration for free. Animation differs from Modal: the
  backdrop still fades, but the panel translates in from the chosen
  edge rather than scaling up.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Placement } from './types.js';

  /**
   * Props for {@link Drawer}.
   */
  interface Props {
    /** Bindable open state. */
    open?: boolean;
    /** Accessible title. */
    title: string;
    /**
     * Which edge to anchor the panel to. Only `left` | `right` are
     * honoured for now — the type reuses the general {@link Placement}
     * vocabulary for future extension to top / bottom sheets.
     */
    placement?: Extract<Placement, 'left' | 'right'>;
    /** When true (default) backdrop clicks close the drawer. */
    closeOnBackdrop?: boolean;
    /** Panel width in rem. Defaults to 24 (384px). */
    width?: number;
    /** Extra class names. */
    class?: string;
    /** Optional custom header. */
    header?: Snippet;
    /** Body content. */
    children?: Snippet;
    /** Footer slot. */
    footer?: Snippet;
    /** Close callback. */
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    placement = 'right',
    closeOnBackdrop = true,
    width = 24,
    class: extraClass = '',
    header,
    children,
    footer,
    onclose,
  }: Props = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);
  const uid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const titleId = `cleo-dr-${uid}-title`;

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  function handleClose(): void {
    open = false;
    onclose?.();
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (!closeOnBackdrop || !dialogEl) return;
    if (e.target === dialogEl) handleClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="cleo-drawer place-{placement} {extraClass}"
  aria-labelledby={titleId}
  style="--cleo-drawer-w: {width}rem"
  onclose={handleClose}
  onclick={handleBackdropClick}
>
  <aside class="drawer-surface" aria-label={title}>
    <header class="drawer-header">
      {#if header}
        {@render header()}
      {:else}
        <h2 id={titleId} class="drawer-title">{title}</h2>
      {/if}
      <button
        type="button"
        class="close-btn"
        aria-label="Close"
        onclick={handleClose}
      >
        ✕
      </button>
    </header>
    <div class="drawer-body">
      {#if children}{@render children()}{/if}
    </div>
    {#if footer}
      <footer class="drawer-footer">{@render footer()}</footer>
    {/if}
  </aside>
</dialog>

<style>
  .cleo-drawer {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    margin: 0;
    font-family: var(--font-sans);
  }

  .cleo-drawer::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    animation: backdrop-in var(--duration-enter) ease forwards;
  }

  @keyframes backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .drawer-surface {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    width: min(var(--cleo-drawer-w), calc(100vw - var(--space-6)));
    background: var(--bg-elev-1);
    border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
    animation: slide-in-r var(--duration-enter) cubic-bezier(0.2, 0.8, 0.2, 1)
      forwards;
  }

  .cleo-drawer.place-right .drawer-surface {
    right: 0;
    border-left: 1px solid var(--border-strong);
    border-right: none;
  }

  .cleo-drawer.place-left .drawer-surface {
    left: 0;
    border-right: 1px solid var(--border-strong);
    border-left: none;
    animation-name: slide-in-l;
  }

  @keyframes slide-in-r {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }

  @keyframes slide-in-l {
    from { transform: translateX(-100%); }
    to   { transform: translateX(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .drawer-surface,
    .cleo-drawer::backdrop {
      animation: none;
    }
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .drawer-title {
    font-size: var(--text-md);
    font-weight: 600;
    line-height: var(--leading-tight);
    margin: 0;
  }

  .close-btn {
    appearance: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: var(--text-md);
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--ease), color var(--ease);
  }

  .close-btn:hover {
    background: var(--bg-elev-2);
    color: var(--text);
  }

  .close-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .drawer-body {
    padding: var(--space-5);
    overflow-y: auto;
    flex: 1;
  }

  .drawer-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
</style>
