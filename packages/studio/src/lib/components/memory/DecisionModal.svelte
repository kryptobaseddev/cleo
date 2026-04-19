<!--
  DecisionModal — capture a brain decision.

  Fields: decision, rationale, alternatives (chip list), taskId (optional
  context), epicId (optional context).

  Alternatives are managed as a Chip list — add via a small inline input,
  remove by clicking the Chip again (action mode). This mirrors the
  pattern used in the Tasks Explorer tag field.

  Submits via POST /api/memory/decision-store.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Button, Chip, ChipGroup, Input, Modal, Textarea } from '$lib/ui';

  /**
   * Props for {@link DecisionModal}.
   */
  interface Props {
    /** Bindable visibility. */
    open: boolean;
    /** Called with the new decision ID on successful save. */
    onSuccess?: (id: string) => void;
    /** Called with a human-readable error when the save fails. */
    onError?: (message: string) => void;
  }

  let { open = $bindable(false), onSuccess, onError }: Props = $props();

  let decision = $state('');
  let rationale = $state('');
  let alternatives = $state<string[]>([]);
  let altDraft = $state('');
  let taskId = $state('');
  let epicId = $state('');

  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let decisionError = $state<string | null>(null);
  let rationaleError = $state<string | null>(null);

  function addAlt(): void {
    const v = altDraft.trim();
    if (!v) return;
    if (alternatives.includes(v)) {
      altDraft = '';
      return;
    }
    alternatives = [...alternatives, v];
    altDraft = '';
  }

  function removeAlt(v: string): void {
    alternatives = alternatives.filter((a) => a !== v);
  }

  function onAltKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      addAlt();
    }
  }

  function validate(): boolean {
    let ok = true;
    decisionError = null;
    rationaleError = null;

    if (decision.trim().length < 1) {
      decisionError = 'Decision statement is required.';
      ok = false;
    }
    if (rationale.trim().length < 1) {
      rationaleError = 'Rationale is required.';
      ok = false;
    }

    return ok;
  }

  function reset(): void {
    decision = '';
    rationale = '';
    alternatives = [];
    altDraft = '';
    taskId = '';
    epicId = '';
    submitting = false;
    formError = null;
    decisionError = null;
    rationaleError = null;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (!validate()) return;

    submitting = true;
    formError = null;

    try {
      const res = await fetch('/api/memory/decision-store', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: decision.trim(),
          rationale: rationale.trim(),
          alternatives: alternatives.length > 0 ? alternatives : undefined,
          taskId: taskId.trim() || undefined,
          contextEpicId: epicId.trim() || undefined,
        }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        data?: { id: string };
        error?: { message?: string };
      };
      if (!res.ok || body.success === false) {
        const msg = body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const id = body.data?.id ?? '';
      onSuccess?.(id);
      reset();
      open = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      formError = msg;
      onError?.(msg);
    } finally {
      submitting = false;
    }
  }

  function onClose(): void {
    if (!submitting) reset();
  }
</script>

<Modal bind:open title="Store decision" onclose={onClose} maxWidth={36}>
  <form
    class="decision-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <Textarea
      label="Decision"
      bind:value={decision}
      placeholder="We decided to…"
      rows={2}
      autoResize
      error={decisionError ?? undefined}
      required
    />

    <Textarea
      label="Rationale"
      bind:value={rationale}
      placeholder="Why this choice — constraints, trade-offs, evidence"
      rows={4}
      autoResize
      error={rationaleError ?? undefined}
      required
    />

    <div class="alt-field">
      <span class="alt-label">Alternatives considered</span>
      <div class="alt-row">
        <Input
          value={altDraft}
          placeholder="Add alternative and press Enter"
          oninput={(e) => (altDraft = (e.target as HTMLInputElement).value)}
        />
        <Button variant="secondary" size="sm" onclick={addAlt}>Add</Button>
      </div>
      {#if alternatives.length > 0}
        <ChipGroup label="Alternatives">
          {#each alternatives as alt (alt)}
            <Chip mode="action" active={true} onclick={() => removeAlt(alt)}>
              {alt} ✕
            </Chip>
          {/each}
        </ChipGroup>
      {/if}
      <!-- hidden key handler: Input doesn't forward keydown; we attach via a wrapper -->
      <input
        type="hidden"
        onkeydown={onAltKey}
      />
    </div>

    <div class="ctx-grid">
      <Input label="Task ID (optional)" bind:value={taskId} placeholder="T123" />
      <Input label="Epic ID (optional)" bind:value={epicId} placeholder="T100" />
    </div>

    {#if formError}
      <p class="form-error" role="alert" aria-live="polite">{formError}</p>
    {/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)} disabled={submitting}>Cancel</Button>
    <Button
      variant="primary"
      onclick={() => {
        void submit();
      }}
      loading={submitting}
    >
      Store decision
    </Button>
  {/snippet}
</Modal>

<style>
  .decision-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .alt-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .alt-label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }

  .alt-row {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
  }

  .ctx-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .form-error {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--danger-soft);
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: 500;
  }
</style>
