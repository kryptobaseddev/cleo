<!--
  /keys — credential pool management UI.

  Lists every entry in the unified credential pool grouped by provider,
  showing label · source · authType · expiry · last-status. Operators
  can:

    - Add a new manual API-key credential via the inline form
      (POST /api/credentials).
    - Remove any entry via the per-row "Remove" button
      (DELETE /api/credentials/:provider/:label).

  SECURITY: this page NEVER displays a credential value. The API
  responses do not carry `accessToken`/`refreshToken`, so even a
  compromised browser context cannot exfiltrate keys via this route.

  @task T9426
  @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-7)
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, Input, Select } from '$lib/ui';
  import type { SafeCredentialEntry } from '../api/credentials/+server.js';

  // -------------------------------------------------------------------------
  // State (Svelte 5 runes)
  // -------------------------------------------------------------------------

  let entries = $state<SafeCredentialEntry[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let formOpen = $state(false);
  let formProvider = $state<string>('anthropic');
  let formLabel = $state('');
  let formApiKey = $state('');
  let formSubmitting = $state(false);
  let formError = $state<string | null>(null);

  let removingKey = $state<string | null>(null);
  let toastMessages = $state<string[]>([]);

  // -------------------------------------------------------------------------
  // Derived: group entries by provider for display.
  // -------------------------------------------------------------------------

  const groupedEntries = $derived.by(() => {
    const groups = new Map<string, SafeCredentialEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.provider);
      if (list) {
        list.push(entry);
      } else {
        groups.set(entry.provider, [entry]);
      }
    }
    // Stable ordering: provider name asc, then priority asc within a group.
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, list]) => ({
        provider,
        entries: list.slice().sort((a, b) => a.priority - b.priority),
      }));
  });

  // -------------------------------------------------------------------------
  // Provider option list — keep in sync with API server's ALLOWED_PROVIDERS.
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Network — load / add / remove
  // -------------------------------------------------------------------------

  async function loadEntries(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/credentials');
      const body = (await res.json()) as {
        success: boolean;
        data?: { entries: SafeCredentialEntry[] };
        error?: { code: string; message: string };
      };
      if (!res.ok || !body.success) {
        loadError = body.error?.message ?? `HTTP ${res.status}`;
      } else if (body.data) {
        entries = body.data.entries;
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function submitForm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (formSubmitting) return;
    formSubmitting = true;
    formError = null;
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: formProvider,
          label: formLabel,
          apiKey: formApiKey,
        }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: { provider: string; label: string };
        error?: { code: string; message: string };
      };
      if (!res.ok || !body.success) {
        formError = body.error?.message ?? `HTTP ${res.status}`;
        return;
      }
      toastMessages = [
        ...toastMessages,
        `Added '${formProvider}/${formLabel}' (manual / api_key)`,
      ];
      formProvider = 'anthropic';
      formLabel = '';
      formApiKey = '';
      formOpen = false;
      await loadEntries();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      formSubmitting = false;
    }
  }

  async function removeEntry(entry: SafeCredentialEntry): Promise<void> {
    const key = `${entry.provider}::${entry.label}`;
    if (removingKey === key) return;
    if (
      !confirm(
        `Remove credential '${entry.provider}/${entry.label}' (source: ${entry.source})?\n\n` +
          `This will also suppress its source from future seed passes.`,
      )
    ) {
      return;
    }
    removingKey = key;
    try {
      const encProvider = encodeURIComponent(entry.provider);
      const encLabel = encodeURIComponent(entry.label);
      const res = await fetch(`/api/credentials/${encProvider}/${encLabel}`, {
        method: 'DELETE',
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: {
          provider: string;
          label: string;
          removed: boolean;
          cleaned: string[];
          hints: string[];
          suppressed: boolean;
        };
        error?: { code: string; message: string };
      };
      if (!res.ok || !body.success) {
        toastMessages = [
          ...toastMessages,
          `Failed to remove '${entry.provider}/${entry.label}': ${body.error?.message ?? 'unknown error'}`,
        ];
        return;
      }
      const summary = body.data;
      if (summary) {
        const parts = [
          `Removed '${summary.provider}/${summary.label}'`,
          summary.suppressed ? `suppressed source` : null,
          summary.cleaned.length > 0 ? `cleaned ${summary.cleaned.length} path(s)` : null,
        ].filter(Boolean);
        toastMessages = [...toastMessages, parts.join(' · ')];
        for (const hint of summary.hints) {
          toastMessages = [...toastMessages, `hint: ${hint}`];
        }
      }
      await loadEntries();
    } catch (e) {
      toastMessages = [...toastMessages, `Network error: ${e instanceof Error ? e.message : e}`];
    } finally {
      removingKey = null;
    }
  }

  function dismissToast(idx: number): void {
    toastMessages = toastMessages.filter((_, i) => i !== idx);
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) return 'never';
    const ms = expiresAt - Date.now();
    if (ms < 0) return 'expired';
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  }

  function statusTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'ok') return 'success';
    if (status === 'exhausted') return 'warning';
    if (status === 'invalid') return 'danger';
    return 'neutral';
  }

  onMount(loadEntries);
</script>

<svelte:head>
  <title>Credentials — CLEO Studio</title>
</svelte:head>

<section class="keys-page">
  <header class="page-header">
    <div>
      <h1>Credential pool</h1>
      <p class="muted">
        Manage the unified LLM credential pool. Secrets are write-only — values are never returned
        to the browser.
      </p>
    </div>
    <Button variant="primary" onclick={() => (formOpen = !formOpen)}>
      {formOpen ? 'Cancel' : 'Add credential'}
    </Button>
  </header>

  {#if formOpen}
    <Card padding="cozy">
      <form class="add-form" onsubmit={submitForm}>
        <Select
          label="Provider"
          name="provider"
          bind:value={formProvider}
          options={PROVIDER_OPTIONS}
        />
        <Input
          label="Label"
          name="label"
          placeholder="e.g. work-pri or personal-1"
          bind:value={formLabel}
          required
        />
        <Input
          label="API key"
          name="apiKey"
          type="password"
          placeholder="paste the raw key — never displayed again"
          bind:value={formApiKey}
          required
          description="Stored at 0600 in ~/.cleo/llm-credentials.json; the API will never echo it back."
        />
        {#if formError}
          <div class="form-error" role="alert">{formError}</div>
        {/if}
        <div class="form-actions">
          <Button type="submit" loading={formSubmitting} disabled={formSubmitting}
            >Save credential</Button
          >
        </div>
      </form>
    </Card>
  {/if}

  {#if toastMessages.length > 0}
    <ul class="toasts" aria-live="polite">
      {#each toastMessages as msg, idx (idx)}
        <li>
          <span>{msg}</span>
          <button type="button" class="toast-close" onclick={() => dismissToast(idx)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if loading}
    <p class="muted">Loading credentials…</p>
  {:else if loadError}
    <Card padding="cozy">
      <div class="load-error" role="alert">Failed to load credentials: {loadError}</div>
      <Button variant="secondary" onclick={loadEntries}>Retry</Button>
    </Card>
  {:else if entries.length === 0}
    <Card padding="cozy">
      <p class="muted">
        No credentials in the pool yet. Click <strong>Add credential</strong> or run
        <code>cleo llm add</code> from the CLI.
      </p>
    </Card>
  {:else}
    <div class="groups">
      {#each groupedEntries as group (group.provider)}
        <Card padding="cozy">
          {#snippet header()}
            <h2 class="group-title">
              {group.provider}
              <span class="muted">· {group.entries.length} {group.entries.length === 1 ? 'entry' : 'entries'}</span>
            </h2>
          {/snippet}
          <table class="entries">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Source</th>
                <th scope="col">Auth type</th>
                <th scope="col">Expiry</th>
                <th scope="col">Last status</th>
                <th scope="col" class="actions-col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each group.entries as entry (entry.label)}
                <tr>
                  <td>{entry.label}</td>
                  <td><Badge tone="info" size="sm">{entry.source}</Badge></td>
                  <td>{entry.authType}</td>
                  <td>{formatExpiry(entry.expiresAt)}</td>
                  <td>
                    {#if entry.lastStatus}
                      <Badge tone={statusTone(entry.lastStatus)} size="sm">{entry.lastStatus}</Badge>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                  <td class="actions-col">
                    <Button
                      variant="danger"
                      size="sm"
                      loading={removingKey === `${entry.provider}::${entry.label}`}
                      disabled={removingKey !== null}
                      onclick={() => removeEntry(entry)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </Card>
      {/each}
    </div>
  {/if}
</section>

<style>
  .keys-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem;
    max-width: 64rem;
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

  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .form-error,
  .load-error {
    color: var(--danger, #c33);
    background: var(--danger-bg, #fee);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .toasts {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .toasts li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--bg-elev-2, #f4f4f4);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
  }

  .toast-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.25rem;
    color: var(--text-dim, #666);
  }

  .toast-close:hover {
    color: var(--text, #000);
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .group-title {
    font-size: 1rem;
    margin: 0;
    font-weight: 600;
  }

  table.entries {
    width: 100%;
    border-collapse: collapse;
  }

  table.entries th,
  table.entries td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border, #eee);
    font-size: 0.9rem;
  }

  table.entries th {
    font-weight: 600;
    color: var(--text-dim, #666);
    background: var(--bg-elev-1, transparent);
  }

  .actions-col {
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
