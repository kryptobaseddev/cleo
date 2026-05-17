<!--
  /setup — guided web setup wizard (T9427 · E3 §5.3 T-E3-8).

  Step-by-step counterpart to `cleo setup`. The wizard renders one
  section at a time so the operator can complete (or revisit) each
  step independently:

    1. LLM provider + API key
       - Provider select + API-key entry. Submits directly to the
         existing POST /api/credentials endpoint (T9426) so the
         secret never traverses the generic /api/setup pipeline.

    2. Project conventions (strictness preset)
       - `strict | standard | minimal` radio. Submits to
         POST /api/setup/section/project-conventions.

  Per-section completion state is persisted in `localStorage` under
  `cleo.studio.setup.v1`. The operator can close the tab, come back,
  and resume on the last unfinished section — completed sections show
  their summary line and can be re-run.

  SECURITY: the API key value is held in component state only for the
  duration of the submit. The /api/credentials endpoint never echoes it
  back; the page does not persist it to localStorage.

  Follow-up: Playwright E2E suite — same gap as T9426. Tracked as the
  next item under E-CONFIG-AUTH-UNIFY E3.

  @task T9427
  @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-8)
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, Input, Select } from '$lib/ui';

  // ---------------------------------------------------------------------------
  // Wizard step definitions
  // ---------------------------------------------------------------------------

  /** Persisted per-section snapshot. */
  interface SectionState {
    /** Was this section completed at least once? */
    completed: boolean;
    /** Final summary line returned by the wizard / credentials API. */
    summary: string;
    /** Epoch ms of the last successful completion. */
    completedAt: number | null;
  }

  type SectionId = 'llm' | 'project-conventions';

  const SECTIONS: ReadonlyArray<{
    id: SectionId;
    title: string;
    blurb: string;
  }> = [
    {
      id: 'llm',
      title: 'LLM provider + API key',
      blurb:
        'Connect at least one LLM provider so CLEO can dispatch agents. The key is written to the unified credential pool — never to config.',
    },
    {
      id: 'project-conventions',
      title: 'Project conventions',
      blurb:
        'Pick the strictness preset that will gate this project. Affects lint, type-check, and test gating defaults.',
    },
  ];

  const STORAGE_KEY = 'cleo.studio.setup.v1';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let activeSection = $state<SectionId>('llm');
  let sectionState = $state<Record<SectionId, SectionState>>({
    llm: { completed: false, summary: '', completedAt: null },
    'project-conventions': { completed: false, summary: '', completedAt: null },
  });

  // LLM form
  let llmProvider = $state<string>('anthropic');
  let llmLabel = $state<string>('default');
  let llmApiKey = $state<string>('');
  let llmSubmitting = $state(false);
  let llmError = $state<string | null>(null);

  // Conventions form
  let conventionsPreset = $state<'strict' | 'standard' | 'minimal'>('standard');
  let conventionsSubmitting = $state(false);
  let conventionsError = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Provider list — keep in sync with /keys page + ALLOWED_PROVIDERS server-side.
  // ---------------------------------------------------------------------------

  const PROVIDER_OPTIONS = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'moonshot', label: 'Moonshot' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'bedrock', label: 'AWS Bedrock' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'xai', label: 'xAI' },
    { value: 'groq', label: 'Groq' },
    { value: 'kimi-code', label: 'Kimi Code' },
    { value: 'ollama', label: 'Ollama' },
  ];

  const PRESET_OPTIONS = [
    { value: 'strict', label: 'Strict — full enforcement' },
    { value: 'standard', label: 'Standard — recommended' },
    { value: 'minimal', label: 'Minimal — allow most opt-outs' },
  ];

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  function loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<SectionId, SectionState>>;
      for (const section of SECTIONS) {
        const slice = parsed[section.id];
        if (slice && typeof slice === 'object') {
          sectionState[section.id] = {
            completed: Boolean(slice.completed),
            summary: typeof slice.summary === 'string' ? slice.summary : '',
            completedAt: typeof slice.completedAt === 'number' ? slice.completedAt : null,
          };
        }
      }
      // Resume on the first incomplete section.
      const firstIncomplete = SECTIONS.find((s) => !sectionState[s.id].completed);
      activeSection = (firstIncomplete?.id ?? SECTIONS[0]?.id ?? 'llm') as SectionId;
    } catch {
      // Corrupted state — fall back to defaults.
    }
  }

  function persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sectionState));
    } catch {
      // localStorage may be disabled — non-fatal.
    }
  }

  function markCompleted(id: SectionId, summary: string): void {
    sectionState[id] = {
      completed: true,
      summary,
      completedAt: Date.now(),
    };
    persist();
  }

  // ---------------------------------------------------------------------------
  // LLM submit — direct to /api/credentials (T9426).
  // ---------------------------------------------------------------------------

  async function submitLlm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (llmSubmitting) return;
    if (llmApiKey.trim() === '') {
      llmError = 'API key is required.';
      return;
    }
    llmSubmitting = true;
    llmError = null;
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: llmProvider,
          label: llmLabel.trim() || 'default',
          apiKey: llmApiKey,
        }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: { provider: string; label: string };
        error?: { code: string; message: string };
      };
      if (!res.ok || !body.success) {
        llmError = body.error?.message ?? `HTTP ${res.status}`;
        return;
      }
      const provider = body.data?.provider ?? llmProvider;
      const label = body.data?.label ?? llmLabel;
      markCompleted('llm', `added ${provider}:${label} to pool`);
      llmApiKey = '';
      // Auto-advance to the next incomplete section.
      const next = SECTIONS.find((s) => !sectionState[s.id].completed);
      if (next) activeSection = next.id;
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
    } finally {
      llmSubmitting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Project-conventions submit — via /api/setup/section/project-conventions.
  // ---------------------------------------------------------------------------

  async function submitConventions(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (conventionsSubmitting) return;
    conventionsSubmitting = true;
    conventionsError = null;
    try {
      const res = await fetch('/api/setup/section/project-conventions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strictness: conventionsPreset }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: { section: string; success: boolean; changes: boolean; summary: string };
        error?: { code: string; message: string };
      };
      if (!res.ok || !body.success) {
        conventionsError = body.error?.message ?? `HTTP ${res.status}`;
        return;
      }
      const summary = body.data?.summary ?? `applied ${conventionsPreset} preset`;
      if (body.data?.success === false) {
        conventionsError = summary;
        return;
      }
      markCompleted('project-conventions', summary);
    } catch (e) {
      conventionsError = e instanceof Error ? e.message : String(e);
    } finally {
      conventionsSubmitting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(loadFromStorage);

  // ---------------------------------------------------------------------------
  // Derived display helpers
  // ---------------------------------------------------------------------------

  const completedCount = $derived(SECTIONS.filter((s) => sectionState[s.id].completed).length);
</script>

<svelte:head>
  <title>Setup — CLEO Studio</title>
</svelte:head>

<section class="setup-page">
  <header class="page-header">
    <div>
      <h1>Setup CLEO</h1>
      <p class="muted">
        Walk through each section to wire CLEO for this project. Sections persist independently —
        leave and resume at any step.
      </p>
    </div>
    <Badge tone={completedCount === SECTIONS.length ? 'success' : 'info'}>
      {completedCount} / {SECTIONS.length} complete
    </Badge>
  </header>

  <ol class="step-rail" aria-label="Setup sections">
    {#each SECTIONS as section, idx (section.id)}
      {@const state = sectionState[section.id]}
      <li>
        <button
          type="button"
          class="step-pill"
          class:active={activeSection === section.id}
          class:done={state.completed}
          onclick={() => (activeSection = section.id)}
        >
          <span class="step-num">{idx + 1}</span>
          <span class="step-title">{section.title}</span>
          {#if state.completed}
            <Badge tone="success" size="sm">done</Badge>
          {/if}
        </button>
      </li>
    {/each}
  </ol>

  {#if activeSection === 'llm'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">1. {SECTIONS[0]?.title ?? 'LLM provider + API key'}</h2>
      {/snippet}
      <p class="muted">{SECTIONS[0]?.blurb}</p>

      {#if sectionState.llm.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.llm.summary}</span>
          <span class="muted small"
            >Re-submit to add another credential, or visit <a href="/keys">/keys</a> to manage the
            full pool.</span
          >
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitLlm}>
        <Select
          label="Provider"
          name="provider"
          bind:value={llmProvider}
          options={PROVIDER_OPTIONS}
        />
        <Input
          label="Credential label"
          name="label"
          placeholder="default"
          bind:value={llmLabel}
          description="A short name so you can identify this key in the pool (e.g. 'work-pri')."
        />
        <Input
          label="API key"
          name="apiKey"
          type="password"
          placeholder="paste your provider API key"
          bind:value={llmApiKey}
          required
          description="Submitted to POST /api/credentials. Stored at 0600 in ~/.cleo/llm-credentials.json; the API never echoes the value back."
        />
        {#if llmError}
          <div class="form-error" role="alert">{llmError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={llmSubmitting} disabled={llmSubmitting}>
            Save credential
          </Button>
        </div>
      </form>
    </Card>
  {:else if activeSection === 'project-conventions'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">2. {SECTIONS[1]?.title ?? 'Project conventions'}</h2>
      {/snippet}
      <p class="muted">{SECTIONS[1]?.blurb}</p>

      {#if sectionState['project-conventions'].completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState['project-conventions'].summary}</span>
          <span class="muted small">Re-submit to change the preset.</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitConventions}>
        <Select
          label="Strictness preset"
          name="strictness"
          bind:value={conventionsPreset}
          options={PRESET_OPTIONS}
        />
        {#if conventionsError}
          <div class="form-error" role="alert">{conventionsError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={conventionsSubmitting} disabled={conventionsSubmitting}>
            Apply preset
          </Button>
        </div>
      </form>
    </Card>
  {/if}

  {#if completedCount === SECTIONS.length}
    <Card padding="cozy">
      <div class="completion-banner" role="status">
        <Badge tone="success">All set</Badge>
        <span>
          Both required sections are complete. You can now dispatch tasks — or jump to
          <a href="/keys">/keys</a> to add more credentials.
        </span>
      </div>
    </Card>
  {/if}
</section>

<style>
  .setup-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem;
    max-width: 56rem;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .page-header h1 {
    font-size: 1.5rem;
    margin: 0 0 0.25rem;
  }

  .muted {
    color: var(--text-dim, #888);
    font-size: 0.9rem;
    margin: 0;
  }

  .muted.small {
    font-size: 0.8rem;
  }

  .step-rail {
    list-style: none;
    display: flex;
    gap: 0.5rem;
    padding: 0;
    margin: 0;
    flex-wrap: wrap;
  }

  .step-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--border, #ddd);
    background: var(--bg-elev-1, #fff);
    color: inherit;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .step-pill:hover {
    background: var(--bg-elev-2, #f4f4f4);
  }

  .step-pill.active {
    border-color: var(--accent, #36c);
    box-shadow: 0 0 0 2px var(--accent-soft, rgba(51, 102, 204, 0.15));
  }

  .step-pill.done {
    border-color: var(--success, #2a8);
  }

  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: var(--bg-elev-2, #f4f4f4);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .step-title {
    font-weight: 500;
  }

  .section-title {
    font-size: 1rem;
    margin: 0;
    font-weight: 600;
  }

  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .form-error {
    color: var(--danger, #c33);
    background: var(--danger-bg, #fee);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .completion-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elev-2, #f4f8f4);
    border-radius: 4px;
    font-size: 0.9rem;
  }
</style>
