<!--
  LearningModal — capture a brain learning.

  Fields: insight, source, confidence [0..1], actionable flag,
  application (how-to), applicableTypes (comma-separated tags).
  Submits via POST /api/memory/learning-store.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Button, Chip, ChipGroup, Input, Modal, Textarea } from '$lib/ui';

  /**
   * Props for {@link LearningModal}.
   */
  interface Props {
    /** Bindable visibility. */
    open: boolean;
    /** Called with the new learning ID on successful save. */
    onSuccess?: (id: string) => void;
    /** Called with a human-readable error when the save fails. */
    onError?: (message: string) => void;
  }

  let { open = $bindable(false), onSuccess, onError }: Props = $props();

  let insight = $state('');
  let source = $state('');
  let confidence = $state(0.5);
  let actionable = $state(false);
  let application = $state('');
  let tagDraft = $state('');
  let applicableTypes = $state<string[]>([]);

  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let insightError = $state<string | null>(null);
  let sourceError = $state<string | null>(null);

  function addTag(): void {
    const v = tagDraft.trim();
    if (!v) return;
    if (applicableTypes.includes(v)) {
      tagDraft = '';
      return;
    }
    applicableTypes = [...applicableTypes, v];
    tagDraft = '';
  }

  function removeTag(v: string): void {
    applicableTypes = applicableTypes.filter((t) => t !== v);
  }

  function validate(): boolean {
    let ok = true;
    insightError = null;
    sourceError = null;

    if (insight.trim().length < 1) {
      insightError = 'Insight statement is required.';
      ok = false;
    }
    if (source.trim().length < 1) {
      sourceError = 'Source reference is required.';
      ok = false;
    }
    return ok;
  }

  function reset(): void {
    insight = '';
    source = '';
    confidence = 0.5;
    actionable = false;
    application = '';
    tagDraft = '';
    applicableTypes = [];
    submitting = false;
    formError = null;
    insightError = null;
    sourceError = null;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (!validate()) return;

    submitting = true;
    formError = null;

    try {
      const res = await fetch('/api/memory/learning-store', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          insight: insight.trim(),
          source: source.trim(),
          confidence,
          actionable,
          application: application.trim() || undefined,
          applicableTypes: applicableTypes.length > 0 ? applicableTypes : undefined,
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

  function onConfidenceInput(e: Event): void {
    const n = Number((e.target as HTMLInputElement).value);
    confidence = Number.isFinite(n) ? n : 0.5;
  }
</script>

<Modal bind:open title="Store learning" onclose={onClose} maxWidth={36}>
  <form
    class="learning-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <Textarea
      label="Insight"
      bind:value={insight}
      placeholder="The key thing you learned"
      rows={3}
      autoResize
      error={insightError ?? undefined}
      required
    />

    <Input
      label="Source"
      bind:value={source}
      placeholder="Where this came from — file, task, session, commit"
      error={sourceError ?? undefined}
      required
    />

    <div class="confidence-field">
      <span class="field-label">Confidence · {confidence.toFixed(2)}</span>
      <input
        class="slider"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={confidence}
        oninput={onConfidenceInput}
        aria-label="Confidence"
      />
    </div>

    <label class="checkbox-row">
      <input type="checkbox" bind:checked={actionable} />
      <span>Actionable — concrete steps recorded below</span>
    </label>

    {#if actionable}
      <Textarea
        label="How to apply"
        bind:value={application}
        placeholder="Concrete application of the insight"
        rows={3}
        autoResize
      />
    {/if}

    <div class="tag-field">
      <span class="field-label">Applicable types (optional)</span>
      <div class="tag-row">
        <Input
          value={tagDraft}
          placeholder="e.g. refactor, pattern — press Add"
          oninput={(e) => (tagDraft = (e.target as HTMLInputElement).value)}
        />
        <Button variant="secondary" size="sm" onclick={addTag}>Add</Button>
      </div>
      {#if applicableTypes.length > 0}
        <ChipGroup label="Tags">
          {#each applicableTypes as t (t)}
            <Chip mode="action" active={true} onclick={() => removeTag(t)}>
              {t} ✕
            </Chip>
          {/each}
        </ChipGroup>
      {/if}
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
      Store learning
    </Button>
  {/snippet}
</Modal>

<style>
  .learning-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .confidence-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field-label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }

  .slider {
    width: 100%;
    accent-color: var(--accent);
  }

  .checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-dim);
    cursor: pointer;
    user-select: none;
  }

  .checkbox-row input[type='checkbox'] {
    accent-color: var(--accent);
  }

  .tag-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .tag-row {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
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
