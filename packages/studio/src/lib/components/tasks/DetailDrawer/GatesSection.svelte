<!--
  GatesSection — acceptance-gate visualization.

  Reads the six canonical gate booleans off `task.verification`
  (implemented / testsPassed / qaPassed / documented / securityPassed
  / cleanupDone) and renders them as a horizontal strip of pill
  indicators.  Passing gates light up with the success token; failing
  gates stay muted.

  @task T990
  @wave 1C
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';

  interface GateDefinition {
    key: string;
    label: string;
  }

  const GATES: readonly GateDefinition[] = [
    { key: 'implemented', label: 'Impl' },
    { key: 'testsPassed', label: 'Tests' },
    { key: 'qaPassed', label: 'QA' },
    { key: 'documented', label: 'Docs' },
    { key: 'securityPassed', label: 'Sec' },
    { key: 'cleanupDone', label: 'Cleanup' },
  ] as const;

  interface Props {
    task: Task;
  }

  let { task }: Props = $props();

  /**
   * Read the verification-gate map off `task.acceptance` — the contract
   * keeps verification inside the acceptance array. When the field is
   * absent, every gate reads as `false`.
   */
  const gates = $derived.by<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const g of GATES) out[g.key] = false;
    const acceptance = task.acceptance;
    if (!Array.isArray(acceptance)) return out;
    for (const item of acceptance) {
      if (typeof item === 'string') continue;
      const kind = (item as { kind?: string }).kind;
      const gate = (item as { gate?: string }).gate;
      const passed = (item as { passed?: boolean }).passed === true;
      const gateKey = gate ?? kind;
      if (gateKey && gateKey in out && passed) {
        out[gateKey] = true;
      }
    }
    return out;
  });

  const passed = $derived(Object.values(gates).filter(Boolean).length);
</script>

<section class="gates-section">
  <h4 class="section-h">
    Gates
    <span class="count-badge">{passed} / {GATES.length}</span>
  </h4>
  <div class="gate-row">
    {#each GATES as gate (gate.key)}
      {@const isPassed = gates[gate.key]}
      <span
        class="gate-pill"
        class:passed={isPassed}
        title={`${gate.label}: ${isPassed ? 'passed' : 'not yet'}`}
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="lbl">{gate.label}</span>
      </span>
    {/each}
  </div>
</section>

<style>
  .gates-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .section-h {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    margin: 0;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .count-badge {
    font-size: 0.625rem;
    color: var(--text-dim);
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
  }

  .gate-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .gate-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--text-faint);
    font-size: 0.625rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .gate-pill .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }

  .gate-pill.passed {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, transparent);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }

  .gate-pill.passed .dot {
    background: var(--success);
    box-shadow: 0 0 6px color-mix(in srgb, var(--success) 60%, transparent);
  }
</style>
