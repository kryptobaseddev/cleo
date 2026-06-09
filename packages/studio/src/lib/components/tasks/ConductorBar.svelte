<!--
  ConductorBar — the dispatch command bar for the agent-lifecycle dispatcher
  board (T11930 · M5).

  When a Backlog/Ready card is selected, this bar surfaces the "Dispatch"
  affordance: an explicit, confirm-gated action that SPAWNS a real worker in a
  git worktree via `orchestrate.spawn` (server-side, through the gateway — see
  `/api/tasks/[id]/dispatch`). Spawning is real + expensive, so the trigger is a
  two-step confirm, never a hover or a single stray click.

  The bar also VISUALISES the orchestrator → Lead → worker role chain it is
  about to compose, built ONLY from existing primitives (StatBlock + Badge) —
  zero new card primitives (T11930 AC3).

  This component owns NO spawn logic itself: it reports the intent via
  {@link Props.onDispatch}; the page route owns the server call + lane move +
  toast. That keeps spawn strictly server-side (the bar never touches the raw
  client).

  @task T11930
  @epic T11559
-->
<script lang="ts">
  import StatBlock from '$lib/components/shell/StatBlock.svelte';
  import { Badge, Button, Select } from '$lib/ui';

  interface Props {
    /** The selected task id eligible for dispatch (Backlog/Ready). */
    taskId: string;
    /** The selected task's title (shown in the bar). */
    title: string;
    /** The lane the card sits in (`backlog` | `ready`). */
    lane: string;
    /** Whether a dispatch is in flight (disables the trigger). */
    busy?: boolean;
    /**
     * Invoked when the operator confirms a dispatch. The page owns the actual
     * server call, optimistic lane move, and toast. `tier` is the spawn prompt
     * depth (0=minimal · 1=default · 2=full).
     */
    onDispatch: (tier: 0 | 1 | 2) => void;
    /** Dismiss the bar without dispatching. */
    onClose: () => void;
  }

  let { taskId, title, lane, busy = false, onDispatch, onClose }: Props = $props();

  /** Two-step confirm — spawning is real + expensive. */
  let confirming = $state(false);
  /** Spawn tier, mapped to the `--tier` knob on `orchestrate.spawn`. */
  let tier = $state<'0' | '1' | '2'>('1');

  const tierOptions = [
    { value: '0', label: 'Tier 0 · minimal' },
    { value: '1', label: 'Tier 1 · default' },
    { value: '2', label: 'Tier 2 · full' },
  ];

  function requestDispatch(): void {
    if (busy) return;
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    onDispatch(Number(tier) as 0 | 1 | 2);
  }

  function cancelConfirm(): void {
    confirming = false;
  }
</script>

<aside class="conductor" aria-label={`Dispatch ${taskId}`}>
  <div class="conductor-id">
    <Badge tone="accent" size="sm">{taskId}</Badge>
    <span class="conductor-title" title={title}>{title}</span>
    <Badge tone="neutral" size="sm">{lane}</Badge>
  </div>

  <!-- Role chain the spawn will compose — StatBlock + Badge only (AC3). -->
  <div class="role-chain" aria-label="Orchestrator to Lead to worker chain">
    <StatBlock label="Orchestrator" value="you" tone="info" hint="dispatcher board" />
    <span class="chain-arrow" aria-hidden="true">→</span>
    <StatBlock label="Lead" value="orchestrate" tone="accent" hint="spawn pipeline" />
    <span class="chain-arrow" aria-hidden="true">→</span>
    <StatBlock label="Worker" value="worktree" tone="neutral" hint="isolated agent" />
  </div>

  <div class="conductor-actions">
    <Select bind:value={tier} options={tierOptions} disabled={busy || confirming} />
    {#if confirming}
      <span class="confirm-prompt">Spawn a real worker?</span>
      <Button variant="primary" size="sm" onclick={requestDispatch} disabled={busy}>
        Confirm dispatch
      </Button>
      <Button variant="ghost" size="sm" onclick={cancelConfirm} disabled={busy}>Cancel</Button>
    {:else}
      <Button variant="primary" size="sm" onclick={requestDispatch} disabled={busy}>
        {busy ? 'Dispatching…' : 'Dispatch →'}
      </Button>
      <Button variant="ghost" size="sm" onclick={onClose} disabled={busy}>Close</Button>
    {/if}
  </div>
</aside>

<style>
  .conductor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--accent-soft, var(--border));
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }

  .conductor-id {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .conductor-title {
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .role-chain {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .chain-arrow {
    display: flex;
    align-items: center;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  .conductor-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .confirm-prompt {
    font-size: var(--text-2xs);
    color: var(--warning, var(--text-dim));
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
