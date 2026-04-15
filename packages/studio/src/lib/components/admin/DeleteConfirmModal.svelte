<script lang="ts">
  interface Props {
    /** Display name of the project to delete. */
    projectName: string;
    /** Called when the user confirms deletion. */
    onConfirm: () => void;
    /** Called when the modal is dismissed without action. */
    onClose: () => void;
  }

  let { projectName, onConfirm, onClose }: Props = $props();

  let inputValue = $state('');

  const confirmed = $derived(inputValue === projectName);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Backdrop -->
<div
  class="modal-backdrop"
  role="presentation"
  onclick={onClose}
  onkeydown={handleKeydown}
></div>

<!-- Dialog -->
<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
  <div class="modal-header">
    <h2 id="delete-modal-title" class="modal-title">Delete Project</h2>
    <button type="button" class="close-btn" onclick={onClose} aria-label="Close">&#x2715;</button>
  </div>

  <div class="modal-body">
    <p class="warning-text">
      This action will remove the project from the nexus registry. It will not delete files on
      disk.
    </p>

    <p class="confirm-label">
      Type <strong class="project-name-hint">{projectName}</strong> to confirm:
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

  <div class="modal-footer">
    <button type="button" class="btn btn-cancel" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={onConfirm}
      disabled={!confirmed}
    >
      Delete
    </button>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
  }

  .modal-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    width: min(440px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #2d3748;
  }

  .modal-title {
    font-size: 1rem;
    font-weight: 600;
    color: #f1f5f9;
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 1rem;
    padding: 0.25rem;
    line-height: 1;
  }

  .close-btn:hover {
    color: #94a3b8;
  }

  .modal-body {
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .warning-text {
    font-size: 0.875rem;
    color: #94a3b8;
    margin: 0;
    line-height: 1.5;
  }

  .confirm-label {
    font-size: 0.875rem;
    color: #cbd5e1;
    margin: 0;
  }

  .project-name-hint {
    color: #ef4444;
    font-family: monospace;
    font-weight: 600;
  }

  .confirm-input {
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 5px;
    padding: 0.5rem 0.75rem;
    color: #f1f5f9;
    font-size: 0.875rem;
    font-family: monospace;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s;
  }

  .confirm-input:focus {
    border-color: #ef4444;
  }

  .modal-footer {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    padding: 1rem 1.25rem;
    border-top: 1px solid #2d3748;
  }

  .btn {
    padding: 0.375rem 1rem;
    border-radius: 5px;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  }

  .btn-cancel {
    background: transparent;
    color: #94a3b8;
    border-color: #2d3748;
  }

  .btn-cancel:hover {
    background: #2d3748;
    color: #e2e8f0;
  }

  .btn-danger {
    background: #ef4444;
    color: white;
    border-color: #ef4444;
  }

  .btn-danger:hover:not(:disabled) {
    background: #dc2626;
    border-color: #dc2626;
  }

  .btn-danger:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
