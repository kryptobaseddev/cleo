<!--
  /setup — guided web setup wizard for all 8 CLEO sections (T9614 · E-CLEO-SETUP-V2).

  Step-by-step counterpart to `cleo setup`. The wizard renders one section
  at a time so the operator can complete (or revisit) each step independently.

  Section order (canonical):
    1. llm               — provider + API key (via POST /api/credentials)
    2. identity          — agent name + optional SOUL.md
    3. sentient          — daemon enable + tier-2 toggle
    4. project-conventions — strictness preset
    5. harness           — pi vs claude-code
    6. brain             — memory bridge mode + retention + embedding
    7. integrations      — SignalDock + Studio + Conduit
    8. verification      — read-only health checks

  Per-section completion state is persisted in `localStorage` under
  `cleo.studio.setup.v2`. The operator can close the tab, come back, and
  resume on the last unfinished section.

  SECURITY: the API key value is held in component state only for the
  duration of the submit. The /api/credentials endpoint never echoes it
  back; the page does not persist it to localStorage.

  @task T9614
  @epic E-CLEO-SETUP-V2 (T9591)
  @see docs/plans/E-CLEO-SETUP-V2.md §3.8
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, Input, Select } from '$lib/ui';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  /** Persisted per-section snapshot. */
  interface SectionState {
    completed: boolean;
    summary: string;
    completedAt: number | null;
  }

  type SectionId =
    | 'llm'
    | 'identity'
    | 'sentient'
    | 'project-conventions'
    | 'harness'
    | 'brain'
    | 'integrations'
    | 'verification';

  interface SectionDef {
    id: SectionId;
    title: string;
    blurb: string;
  }

  // ---------------------------------------------------------------------------
  // Section definitions (canonical order)
  // ---------------------------------------------------------------------------

  const SECTIONS: ReadonlyArray<SectionDef> = [
    {
      id: 'llm',
      title: 'LLM provider + API key',
      blurb:
        'Connect at least one LLM provider so CLEO can dispatch agents. The key is written to the unified credential pool — never to config.',
    },
    {
      id: 'identity',
      title: 'Agent identity',
      blurb:
        'Set the agent display name (agent.name in global config) and an optional SOUL.md persona block for this project.',
    },
    {
      id: 'sentient',
      title: 'Sentient daemon',
      blurb: 'Enable or disable the CLEO sentient daemon and Tier-2 autonomous proposal generation.',
    },
    {
      id: 'project-conventions',
      title: 'Project conventions',
      blurb:
        'Pick the strictness preset that will gate this project. Affects AC enforcement, session policy, and lifecycle defaults.',
    },
    {
      id: 'harness',
      title: 'Active harness',
      blurb: 'Choose the execution harness: Pi (Raspberry Pi node) or Claude Code (local VS Code).',
    },
    {
      id: 'brain',
      title: 'BRAIN memory',
      blurb:
        'Configure how BRAIN context is surfaced: digest (live summary), file (static bridge), or disabled.',
    },
    {
      id: 'integrations',
      title: 'Integrations',
      blurb:
        'Enable SignalDock transport, the Studio web UI, or a custom Conduit database path for this project.',
    },
    {
      id: 'verification',
      title: 'Verification',
      blurb:
        'Read-only health checks: confirms credentials, config, harness, SignalDock, and BRAIN DB are all reachable.',
    },
  ];

  const STORAGE_KEY = 'cleo.studio.setup.v2';

  // ---------------------------------------------------------------------------
  // Initial state factory
  // ---------------------------------------------------------------------------

  function makeInitialState(): Record<SectionId, SectionState> {
    return {
      llm: { completed: false, summary: '', completedAt: null },
      identity: { completed: false, summary: '', completedAt: null },
      sentient: { completed: false, summary: '', completedAt: null },
      'project-conventions': { completed: false, summary: '', completedAt: null },
      harness: { completed: false, summary: '', completedAt: null },
      brain: { completed: false, summary: '', completedAt: null },
      integrations: { completed: false, summary: '', completedAt: null },
      verification: { completed: false, summary: '', completedAt: null },
    };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let activeSection = $state<SectionId>('llm');
  let sectionState = $state<Record<SectionId, SectionState>>(makeInitialState());

  // --- 1. LLM ---
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
  let llmProvider = $state('anthropic');
  let llmLabel = $state('default');
  let llmApiKey = $state('');
  let llmSubmitting = $state(false);
  let llmError = $state<string | null>(null);

  // --- 2. Identity ---
  let identityName = $state('');
  let identitySoulMd = $state('');
  let identitySubmitting = $state(false);
  let identityError = $state<string | null>(null);

  // --- 3. Sentient ---
  let sentientEnabled = $state(false);
  let tier2Enabled = $state(false);
  let sentientSubmitting = $state(false);
  let sentientError = $state<string | null>(null);

  // --- 4. Project conventions ---
  const PRESET_OPTIONS = [
    { value: 'strict', label: 'Strict — full enforcement' },
    { value: 'standard', label: 'Standard — recommended' },
    { value: 'minimal', label: 'Minimal — allow most opt-outs' },
  ];
  let conventionsPreset = $state<'strict' | 'standard' | 'minimal'>('standard');
  let conventionsSubmitting = $state(false);
  let conventionsError = $state<string | null>(null);

  // --- 5. Harness ---
  const HARNESS_OPTIONS = [
    { value: 'claude-code', label: 'Claude Code (local VS Code extension)' },
    { value: 'pi', label: 'Pi (Raspberry Pi node)' },
  ];
  let harnessChoice = $state<'pi' | 'claude-code'>('claude-code');
  let harnessSubmitting = $state(false);
  let harnessError = $state<string | null>(null);

  // --- 6. Brain ---
  const BRAIN_MODE_OPTIONS = [
    { value: 'digest', label: 'Digest — live memory summary (recommended)' },
    { value: 'file', label: 'File — static bridge files written to disk' },
    { value: 'disabled', label: 'Disabled — no BRAIN injection' },
  ];
  let brainMode = $state<'digest' | 'file' | 'disabled'>('digest');
  let brainRetentionDays = $state('0');
  let brainEmbeddingEnabled = $state(false);
  let brainSubmitting = $state(false);
  let brainError = $state<string | null>(null);

  // --- 7. Integrations ---
  let intgSignaldockEnabled = $state(false);
  let intgSignaldockEndpoint = $state('http://localhost:4000');
  let intgStudioEnabled = $state(false);
  let intgConduitPath = $state('');
  let intgSubmitting = $state(false);
  let intgError = $state<string | null>(null);

  // --- 8. Verification ---
  let verifRunning = $state(false);
  let verifError = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Persistence
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
      const firstIncomplete = SECTIONS.find((s) => !sectionState[s.id].completed);
      activeSection = (firstIncomplete?.id ?? SECTIONS[0]?.id ?? 'llm') as SectionId;
    } catch {
      /* corrupted state — fall back to defaults */
    }
  }

  function persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sectionState));
    } catch {
      /* localStorage disabled — non-fatal */
    }
  }

  function markCompleted(id: SectionId, summary: string): void {
    sectionState[id] = { completed: true, summary, completedAt: Date.now() };
    persist();
    // Auto-advance to the next incomplete section.
    const next = SECTIONS.find((s) => !sectionState[s.id].completed);
    if (next) activeSection = next.id;
  }

  // ---------------------------------------------------------------------------
  // Generic section submit helper (POST /api/setup/section/:name)
  // ---------------------------------------------------------------------------

  async function runSection(
    id: SectionId,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; summary: string; errorMessage: string }> {
    const res = await fetch(`/api/setup/section/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { section: string; success: boolean; changes: boolean; summary: string };
      error?: { code: string; message: string };
    };
    if (!res.ok || !json.success) {
      return { ok: false, summary: '', errorMessage: json.error?.message ?? `HTTP ${res.status}` };
    }
    if (json.data?.success === false) {
      return { ok: false, summary: json.data.summary, errorMessage: json.data.summary };
    }
    return { ok: true, summary: json.data?.summary ?? 'done', errorMessage: '' };
  }

  // ---------------------------------------------------------------------------
  // Submit handlers
  // ---------------------------------------------------------------------------

  /** 1. LLM — bypasses /api/setup, posts direct to /api/credentials. */
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
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
    } finally {
      llmSubmitting = false;
    }
  }

  /** 2. Identity */
  async function submitIdentity(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (identitySubmitting) return;
    if (identityName.trim() === '') {
      identityError = 'Agent name is required.';
      return;
    }
    identitySubmitting = true;
    identityError = null;
    try {
      const r = await runSection('identity', {
        agentName: identityName.trim(),
        soulMdContent: identitySoulMd.trim() || undefined,
      });
      if (!r.ok) {
        identityError = r.errorMessage;
        return;
      }
      markCompleted('identity', r.summary);
    } catch (e) {
      identityError = e instanceof Error ? e.message : String(e);
    } finally {
      identitySubmitting = false;
    }
  }

  /** 3. Sentient */
  async function submitSentient(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sentientSubmitting) return;
    sentientSubmitting = true;
    sentientError = null;
    try {
      const r = await runSection('sentient', {
        sentientEnabled,
        tier2Enabled,
      });
      if (!r.ok) {
        sentientError = r.errorMessage;
        return;
      }
      markCompleted('sentient', r.summary);
    } catch (e) {
      sentientError = e instanceof Error ? e.message : String(e);
    } finally {
      sentientSubmitting = false;
    }
  }

  /** 4. Project conventions */
  async function submitConventions(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (conventionsSubmitting) return;
    conventionsSubmitting = true;
    conventionsError = null;
    try {
      const r = await runSection('project-conventions', { strictness: conventionsPreset });
      if (!r.ok) {
        conventionsError = r.errorMessage;
        return;
      }
      markCompleted('project-conventions', r.summary);
    } catch (e) {
      conventionsError = e instanceof Error ? e.message : String(e);
    } finally {
      conventionsSubmitting = false;
    }
  }

  /** 5. Harness */
  async function submitHarness(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (harnessSubmitting) return;
    harnessSubmitting = true;
    harnessError = null;
    try {
      const r = await runSection('harness', { harness: harnessChoice });
      if (!r.ok) {
        harnessError = r.errorMessage;
        return;
      }
      markCompleted('harness', r.summary);
    } catch (e) {
      harnessError = e instanceof Error ? e.message : String(e);
    } finally {
      harnessSubmitting = false;
    }
  }

  /** 6. Brain */
  async function submitBrain(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (brainSubmitting) return;
    brainSubmitting = true;
    brainError = null;
    try {
      const retDays = parseInt(brainRetentionDays, 10);
      if (!Number.isInteger(retDays) || retDays < 0) {
        brainError = 'Retention days must be a non-negative integer (0 = forever).';
        return;
      }
      const r = await runSection('brain', {
        brainBridgeMode: brainMode,
        brainRetentionDays: retDays,
        brainEmbeddingEnabled: brainEmbeddingEnabled,
      });
      if (!r.ok) {
        brainError = r.errorMessage;
        return;
      }
      markCompleted('brain', r.summary);
    } catch (e) {
      brainError = e instanceof Error ? e.message : String(e);
    } finally {
      brainSubmitting = false;
    }
  }

  /** 7. Integrations */
  async function submitIntegrations(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (intgSubmitting) return;
    intgSubmitting = true;
    intgError = null;
    try {
      const body: Record<string, unknown> = {
        signaldockEnabled: intgSignaldockEnabled,
        studioEnabled: intgStudioEnabled,
      };
      if (intgSignaldockEnabled && intgSignaldockEndpoint.trim()) {
        body['signaldockEndpoint'] = intgSignaldockEndpoint.trim();
      }
      if (intgConduitPath.trim()) {
        body['conduitPath'] = intgConduitPath.trim();
      }
      const r = await runSection('integrations', body);
      if (!r.ok) {
        intgError = r.errorMessage;
        return;
      }
      markCompleted('integrations', r.summary);
    } catch (e) {
      intgError = e instanceof Error ? e.message : String(e);
    } finally {
      intgSubmitting = false;
    }
  }

  /** 8. Verification (run-only, no input form) */
  async function runVerification(): Promise<void> {
    if (verifRunning) return;
    verifRunning = true;
    verifError = null;
    try {
      const r = await runSection('verification', { nonInteractive: true });
      if (!r.ok) {
        verifError = r.errorMessage;
        return;
      }
      markCompleted('verification', r.summary);
    } catch (e) {
      verifError = e instanceof Error ? e.message : String(e);
    } finally {
      verifRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(loadFromStorage);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const completedCount = $derived(SECTIONS.filter((s) => sectionState[s.id].completed).length);
  const allDone = $derived(completedCount === SECTIONS.length);
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
    <Badge tone={allDone ? 'success' : 'info'}>
      {completedCount} / {SECTIONS.length} complete
    </Badge>
  </header>

  <!-- Step rail -->
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

  <!-- ── 1. LLM ── -->
  {#if activeSection === 'llm'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">1. LLM provider + API key</h2>
      {/snippet}
      <p class="muted">{SECTIONS[0]?.blurb}</p>

      {#if sectionState.llm.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.llm.summary}</span>
          <span class="muted small"
            >Re-submit to add another credential, or visit <a href="/keys">/keys</a> to manage the
            pool.</span
          >
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitLlm}>
        <Select label="Provider" name="provider" bind:value={llmProvider} options={PROVIDER_OPTIONS} />
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
          description="Stored in the credential pool at ~/.cleo/brain.db — never echoed back."
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

  <!-- ── 2. Identity ── -->
  {:else if activeSection === 'identity'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">2. Agent identity</h2>
      {/snippet}
      <p class="muted">{SECTIONS[1]?.blurb}</p>

      {#if sectionState.identity.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.identity.summary}</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitIdentity}>
        <Input
          label="Agent display name"
          name="agentName"
          placeholder='e.g. "Atlas"'
          bind:value={identityName}
          required
          description="Written to agent.name in the global config (~/.cleo/config.json)."
        />
        <Input
          label="SOUL.md content (optional)"
          name="soulMdContent"
          placeholder="I am Atlas, ..."
          bind:value={identitySoulMd}
          description="Optional persona block written to .cleo/SOUL.md in the project root. Leave blank to skip."
        />
        {#if identityError}
          <div class="form-error" role="alert">{identityError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={identitySubmitting} disabled={identitySubmitting}>
            Save identity
          </Button>
        </div>
      </form>
    </Card>

  <!-- ── 3. Sentient ── -->
  {:else if activeSection === 'sentient'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">3. Sentient daemon</h2>
      {/snippet}
      <p class="muted">{SECTIONS[2]?.blurb}</p>

      {#if sectionState.sentient.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.sentient.summary}</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitSentient}>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={sentientEnabled} />
          <span>Enable sentient daemon</span>
          <span class="muted small"
            >Writes to .cleo/sentient-state.json. The daemon proposes tasks autonomously.</span
          >
        </label>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={tier2Enabled} disabled={!sentientEnabled} />
          <span>Enable Tier-2 autonomous proposals</span>
          <span class="muted small">Only applicable when the daemon is enabled.</span>
        </label>
        {#if sentientError}
          <div class="form-error" role="alert">{sentientError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={sentientSubmitting} disabled={sentientSubmitting}>
            Save sentient settings
          </Button>
        </div>
      </form>
    </Card>

  <!-- ── 4. Project conventions ── -->
  {:else if activeSection === 'project-conventions'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">4. Project conventions</h2>
      {/snippet}
      <p class="muted">{SECTIONS[3]?.blurb}</p>

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

  <!-- ── 5. Harness ── -->
  {:else if activeSection === 'harness'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">5. Active harness</h2>
      {/snippet}
      <p class="muted">{SECTIONS[4]?.blurb}</p>

      {#if sectionState.harness.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.harness.summary}</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitHarness}>
        <Select
          label="Harness"
          name="harness"
          bind:value={harnessChoice}
          options={HARNESS_OPTIONS}
        />
        {#if harnessError}
          <div class="form-error" role="alert">{harnessError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={harnessSubmitting} disabled={harnessSubmitting}>
            Save harness
          </Button>
        </div>
      </form>
    </Card>

  <!-- ── 6. Brain ── -->
  {:else if activeSection === 'brain'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">6. BRAIN memory</h2>
      {/snippet}
      <p class="muted">{SECTIONS[5]?.blurb}</p>

      {#if sectionState.brain.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.brain.summary}</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitBrain}>
        <Select
          label="Memory bridge mode"
          name="brainBridgeMode"
          bind:value={brainMode}
          options={BRAIN_MODE_OPTIONS}
        />
        <Input
          label="Retention days"
          name="brainRetentionDays"
          type="number"
          placeholder="0"
          bind:value={brainRetentionDays}
          description="How long to keep memory entries (0 = keep forever)."
        />
        <label class="toggle-row">
          <input type="checkbox" bind:checked={brainEmbeddingEnabled} />
          <span>Enable embedding index</span>
          <span class="muted small"
            >Enables semantic search via local vector index. Requires extra disk space.</span
          >
        </label>
        {#if brainError}
          <div class="form-error" role="alert">{brainError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={brainSubmitting} disabled={brainSubmitting}>
            Save BRAIN settings
          </Button>
        </div>
      </form>
    </Card>

  <!-- ── 7. Integrations ── -->
  {:else if activeSection === 'integrations'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">7. Integrations</h2>
      {/snippet}
      <p class="muted">{SECTIONS[6]?.blurb}</p>

      {#if sectionState.integrations.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.integrations.summary}</span>
        </div>
      {/if}

      <form class="setup-form" onsubmit={submitIntegrations}>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={intgSignaldockEnabled} />
          <span>Enable SignalDock transport</span>
          <span class="muted small">Connects CLEO to the SignalDock message bus.</span>
        </label>
        {#if intgSignaldockEnabled}
          <Input
            label="SignalDock endpoint"
            name="signaldockEndpoint"
            placeholder="http://localhost:4000"
            bind:value={intgSignaldockEndpoint}
            description="HTTP(S) URL of the SignalDock server. Must be reachable from this machine."
          />
        {/if}
        <label class="toggle-row">
          <input type="checkbox" bind:checked={intgStudioEnabled} />
          <span>Enable Studio web UI</span>
          <span class="muted small">Start Studio with <code>cleo studio start</code>.</span>
        </label>
        <Input
          label="Custom Conduit DB path (optional)"
          name="conduitPath"
          placeholder="/absolute/path/to/conduit.db"
          bind:value={intgConduitPath}
          description="Leave blank to use the default Conduit path for this project."
        />
        {#if intgError}
          <div class="form-error" role="alert">{intgError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={intgSubmitting} disabled={intgSubmitting}>
            Save integrations
          </Button>
        </div>
      </form>
    </Card>

  <!-- ── 8. Verification ── -->
  {:else if activeSection === 'verification'}
    <Card padding="cozy">
      {#snippet header()}
        <h2 class="section-title">8. Verification</h2>
      {/snippet}
      <p class="muted">{SECTIONS[7]?.blurb}</p>

      {#if sectionState.verification.completed}
        <div class="completion-banner" role="status">
          <Badge tone="success">Completed</Badge>
          <span>{sectionState.verification.summary}</span>
          <span class="muted small">Re-run at any time to re-check connectivity.</span>
        </div>
      {/if}

      {#if verifError}
        <div class="form-error" role="alert">{verifError}</div>
      {/if}
      <div class="form-actions" style="margin-top: 0.75rem;">
        <Button loading={verifRunning} disabled={verifRunning} onclick={runVerification}>
          Run health checks
        </Button>
      </div>
    </Card>
  {/if}

  <!-- All-done banner -->
  {#if allDone}
    <Card padding="cozy">
      <div class="completion-banner" role="status">
        <Badge tone="success">All set</Badge>
        <span>
          All 8 sections are complete. You can now dispatch tasks — or revisit any section above.
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

  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
    flex-wrap: wrap;
  }

  .toggle-row input[type='checkbox'] {
    margin-top: 0.15rem;
    flex-shrink: 0;
  }
</style>
