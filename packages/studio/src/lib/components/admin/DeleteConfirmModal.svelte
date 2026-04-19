<!--
  DeleteConfirmModal — typed-word confirmation before removing a
  project from the nexus.db registry.

  Refactored onto `$lib/ui/Modal` so focus is trapped by the native
  `<dialog>` primitive and Esc / backdrop-click close behaviour is
  handled centrally. Matches the Wave 1E rule that every destructive
  admin action requires typing an exact word.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Button, Modal } from '$lib/ui';

  interface Props {
    open?: boolean;
    /** Display name of the project to delete. */
    projectName: string;
    /** Called when the user confirms. */
    onConfirm: () => void;
    /** Called when dismissed without action. */
    onClose?: () => void;
  }

  let { open = $bindable(true), projectName, onConfirm, onClose }: Props = $props();

  let inputValue = $state('');
  const confirmed = $derived(inputValue === projectName);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  function handleConfirm(): void {
    if (!confirmed) return;
    onConfirm();
  }
</script>

<Modal bind:open title="Delete project" maxWidth={28} closeOnBackdrop={false} onclose={handleClose}>
  <div class="body">
    <p class="warning">
      This removes the project from the nexus registry. Files on disk are not touched.
    </p>
    <p class="hint">
      Type <strong class="keyword">{projectName}</strong> to confirm:
    </p>
    <input
      type="text"
      class="confirm-input"
      placeholder={projectName}
      bind:value={inputValue}
      autocomplete="off"
      spellcheck="false"
    />
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Cancel</Button>
    <Button variant="danger" disabled={!confirmed} onclick={handleConfirm}>
      Delete
    </Button>
  {/snippet}
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .warning {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--text);
    margin: 0;
  }

  .keyword {
    font-family: var(--font-mono);
    color: var(--danger);
    font-weight: 700;
  }

  .confirm-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    outline: none;
    transition: border-color var(--ease), box-shadow var(--ease);
  }

  .confirm-input:focus-visible {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }
</style>
