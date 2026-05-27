<!--
  ObserveModal — capture a brain observation.

  Wraps `$lib/ui/Modal`. Submits via POST /api/memory/observe. Emits
  `onSuccess(newId)` on 200 so the parent can refresh the list; emits
  `onError(message)` otherwise.

  Client-side validation (zod is overkill for this schema — a small
  pure function is lighter and stays strictly typed):
    - title: 1..200 chars
    - text:  1..10000 chars

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Button, Input, Modal, Textarea } from '$lib/ui';
  import Select, { type SelectOption } from '$lib/ui/Select.svelte';

  /**
   * Local mirror of `MemoryObservationKind` from
   * `@cleocode/contracts/operations/memory` — the root contracts
   * package only re-exports the higher-level `Memory*` shapes, so we
   * pin the literal union here. Keep in sync with the contract file.
   */
  type MemoryObservationKind =
    | 'discovery'
    | 'change'
    | 'feature'
    | 'bugfix'
    | 'decision'
    | 'refactor';

  /**
   * Props for {@link ObserveModal}.
   */
  interface Props {
    /** Bindable visibility. */
    open: boolean;
    /** Called with the new observation ID on successful save. */
    onSuccess?: (id: string) => void;
    /** Called with a human-readable error when the save fails. */
    onError?: (message: string) => void;
  }

  let { open = $bindable(false), onSuccess, onError }: Props = $props();

  const TYPE_OPTIONS: SelectOption<MemoryObservationKind>[] = [
    { value: 'discovery', label: 'Discovery' },
    { value: 'change', label: 'Change' },
    { value: 'feature', label: 'Feature' },
    { value: 'bugfix', label: 'Bug fix' },
    { value: 'decision', label: 'Decision' },
    { value: 'refactor', label: 'Refactor' },
  ];

  let title = $state('');
  let text = $state('');
  let observationType = $state<MemoryObservationKind>('discovery');
  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let titleError = $state<string | null>(null);
  let textError = $state<string | null>(null);

  function validate(): boolean {
    let ok = true;
    titleError = null;
    textError = null;

    if (title.trim().length < 1) {
      titleError = 'Title is required.';
      ok = false;
    } else if (title.length > 200) {
      titleError = 'Title must be 200 characters or fewer.';
      ok = false;
    }

    if (text.trim().length < 1) {
      textError = 'Observation body is required.';
      ok = false;
    } else if (text.length > 10_000) {
      textError = 'Observation body is too long (max 10 000 chars).';
      ok = false;
    }

    return ok;
  }

  function reset(): void {
    title = '';
    text = '';
    observationType = 'discovery';
    submitting = false;
    formError = null;
    titleError = null;
    textError = null;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (!validate()) return;

    submitting = true;
    formError = null;

    try {
      const res = await fetch('/api/memory/observe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          text: text.trim(),
          type: observationType,
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

<Modal bind:open title="New observation" onclose={onClose} maxWidth={34}>
  <form
    class="observe-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <Input
      label="Title"
      bind:value={title}
      placeholder="Short memorable headline"
      error={titleError ?? undefined}
      required
    />

    <Textarea
      label="Observation"
      bind:value={text}
      placeholder="What happened? What changed? What did you learn?"
      rows={6}
      maxlength={10_000}
      autoResize
      error={textError ?? undefined}
      required
    />

    <Select
      label="Kind"
      bind:value={observationType}
      options={TYPE_OPTIONS}
    />

    {#if formError}
      <p class="form-error" role="alert" aria-live="polite">{formError}</p>
    {/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)} disabled={submitting}>
      Cancel
    </Button>
    <Button
      variant="primary"
      onclick={() => {
        void submit();
      }}
      loading={submitting}
    >
      Save observation
    </Button>
  {/snippet}
</Modal>

<style>
  .observe-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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
