<!--
  PatternModal — capture a brain pattern.

  Fields: pattern (body), context, type (classification), impact.
  Submits via POST /api/memory/pattern-store.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Button, Modal, Textarea } from '$lib/ui';
  import Select, { type SelectOption } from '$lib/ui/Select.svelte';

  /** Local mirror of contracts `MemoryPatternType`. Keep in sync with operations/memory.ts. */
  type MemoryPatternType = 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';
  /** Local mirror of contracts `MemoryPatternImpact`. */
  type MemoryPatternImpact = 'low' | 'medium' | 'high';

  /**
   * Props for {@link PatternModal}.
   */
  interface Props {
    /** Bindable visibility. */
    open: boolean;
    /** Called with the new pattern ID on successful save. */
    onSuccess?: (id: string) => void;
    /** Called with a human-readable error when the save fails. */
    onError?: (message: string) => void;
  }

  let { open = $bindable(false), onSuccess, onError }: Props = $props();

  const TYPE_OPTIONS: SelectOption<MemoryPatternType>[] = [
    { value: 'workflow', label: 'Workflow' },
    { value: 'blocker', label: 'Blocker' },
    { value: 'success', label: 'Success' },
    { value: 'failure', label: 'Failure' },
    { value: 'optimization', label: 'Optimization' },
  ];

  const IMPACT_OPTIONS: SelectOption<MemoryPatternImpact>[] = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];

  let patternText = $state('');
  let contextText = $state('');
  let patternType = $state<MemoryPatternType>('workflow');
  let impact = $state<MemoryPatternImpact>('medium');

  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let patternError = $state<string | null>(null);
  let contextError = $state<string | null>(null);

  function validate(): boolean {
    let ok = true;
    patternError = null;
    contextError = null;

    if (patternText.trim().length < 1) {
      patternError = 'Pattern description is required.';
      ok = false;
    }
    if (contextText.trim().length < 1) {
      contextError = 'Context is required — where / when does this pattern apply?';
      ok = false;
    }

    return ok;
  }

  function reset(): void {
    patternText = '';
    contextText = '';
    patternType = 'workflow';
    impact = 'medium';
    submitting = false;
    formError = null;
    patternError = null;
    contextError = null;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (!validate()) return;

    submitting = true;
    formError = null;

    try {
      const res = await fetch('/api/memory/pattern-store', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pattern: patternText.trim(),
          context: contextText.trim(),
          type: patternType,
          impact,
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

<Modal bind:open title="Store pattern" onclose={onClose} maxWidth={36}>
  <form
    class="pattern-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <Textarea
      label="Pattern"
      bind:value={patternText}
      placeholder="Describe the recurring shape — what, when, why"
      rows={4}
      autoResize
      error={patternError ?? undefined}
      required
    />

    <Textarea
      label="Context"
      bind:value={contextText}
      placeholder="Where does this apply? What triggers it?"
      rows={3}
      autoResize
      error={contextError ?? undefined}
      required
    />

    <div class="meta-grid">
      <Select label="Type" bind:value={patternType} options={TYPE_OPTIONS} />
      <Select label="Impact" bind:value={impact} options={IMPACT_OPTIONS} />
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
      Store pattern
    </Button>
  {/snippet}
</Modal>

<style>
  .pattern-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .meta-grid {
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
