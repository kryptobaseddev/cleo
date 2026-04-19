<!--
  Modal — native `<dialog>` with accessible shell.

  Uses the browser's built-in dialog element:
    - `showModal()` traps focus automatically.
    - ESC closes (cancel event → close()).
    - backdrop click closes (opt-in via `closeOnBackdrop`, default true).
    - focus returns to the previously-focused element on close.

  `aria-labelledby` points at the title slot's root. When authors need
  a description they should add `aria-describedby` via `extraProps`.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link Modal}.
   */
  interface Props {
    /** Bindable open state. `true` shows the modal, `false` closes. */
    open?: boolean;
    /** Accessible title shown in the header AND bound via aria-labelledby. */
    title: string;
    /**
     * When true (default), a click on the backdrop closes the modal.
     * Set false for destructive confirm flows.
     */
    closeOnBackdrop?: boolean;
    /**
     * Maximum width of the dialog in rem. Defaults to 32 (512px).
     */
    maxWidth?: number;
    /** Extra class names on the dialog. */
    class?: string;
    /** Header slot — overrides the default title markup. */
    header?: Snippet;
    /** Body content. */
    children?: Snippet;
    /** Footer slot — typically action buttons. */
    footer?: Snippet;
    /** Close callback. */
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    closeOnBackdrop = true,
    maxWidth = 32,
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
  const titleId = `cleo-mo-${uid}-title`;

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
    // Native <dialog> reports the dialog itself as the target when the
    // click lands on the ::backdrop pseudo-element.
    if (e.target === dialogEl) handleClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="cleo-modal {extraClass}"
  aria-labelledby={titleId}
  style="--cleo-modal-max: {maxWidth}rem"
  onclose={handleClose}
  onclick={handleBackdropClick}
>
  <div class="modal-surface" role="document">
    <header class="modal-header">
      {#if header}
        {@render header()}
      {:else}
        <h2 id={titleId} class="modal-title">{title}</h2>
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
    <div class="modal-body">
      {#if children}{@render children()}{/if}
    </div>
    {#if footer}
      <footer class="modal-footer">{@render footer()}</footer>
    {/if}
  </div>
</dialog>

<style>
  .cleo-modal {
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-elev-1);
    color: var(--text);
    max-width: min(var(--cleo-modal-max), calc(100vw - var(--space-6)));
    width: 100%;
    max-height: calc(100vh - var(--space-6));
    box-shadow: var(--shadow-lg);
    font-family: var(--font-sans);
  }

  .cleo-modal::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    animation: backdrop-in var(--duration-enter) ease forwards;
  }

  .cleo-modal[open] {
    animation: modal-in var(--duration-enter) ease forwards;
  }

  @keyframes backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.96); }
    to   { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .cleo-modal,
    .cleo-modal::backdrop {
      animation: none;
    }
  }

  .modal-surface {
    display: flex;
    flex-direction: column;
    max-height: inherit;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .modal-title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
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
    transition: background var(--ease), color var(--ease),
      border-color var(--ease);
  }

  .close-btn:hover {
    background: var(--bg-elev-2);
    color: var(--text);
  }

  .close-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .modal-body {
    padding: var(--space-5);
    overflow-y: auto;
    flex: 1;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
</style>
