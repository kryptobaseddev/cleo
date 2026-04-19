<!--
  LabelsSection — labels + acceptance criteria rendered as two small cards.

  @task T990
  @wave 1C
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';

  interface Props {
    task: Task;
  }

  let { task }: Props = $props();

  const acceptanceStrings = $derived.by<string[]>(() => {
    if (!Array.isArray(task.acceptance)) return [];
    return task.acceptance
      .map((item) => (typeof item === 'string' ? item : (item.description ?? '')))
      .filter((s) => s.length > 0);
  });
</script>

{#if Array.isArray(task.labels) && task.labels.length > 0}
  <section class="sub-section">
    <h4 class="section-h">Labels</h4>
    <div class="labels-row">
      {#each task.labels as lbl (lbl)}
        <span class="label-pill">{lbl}</span>
      {/each}
    </div>
  </section>
{/if}

{#if acceptanceStrings.length > 0}
  <section class="sub-section">
    <h4 class="section-h">Acceptance Criteria</h4>
    <ul class="criteria-list">
      {#each acceptanceStrings as crit (crit)}
        <li>{crit}</li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .sub-section {
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
  }

  .labels-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .label-pill {
    font-size: 0.625rem;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 2px 7px;
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
  }

  .criteria-list {
    list-style: disc outside;
    padding-left: 1.125rem;
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
