<script lang="ts">
  import type { PageData } from './$types';
  import type { SubtaskRow, DepTask, ManifestEntry, LinkedCommit } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const { task, subtasks, parent, manifestEntries, linkedCommits } = data;

  function priorityClass(p: string): string {
    if (p === 'critical') return 'priority-critical';
    if (p === 'high') return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  function statusIcon(s: string): string {
    if (s === 'done') return '✓';
    if (s === 'active') return '●';
    if (s === 'blocked') return '✗';
    return '○';
  }

  function statusClass(s: string): string {
    if (s === 'done') return 'status-done';
    if (s === 'active') return 'status-active';
    if (s === 'blocked') return 'status-blocked';
    return 'status-pending';
  }

  function gateIcon(passed: boolean): string {
    return passed ? '✓' : '·';
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function formatDateShort(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return iso;
    }
  }

  function subtaskVerif(row: SubtaskRow): { implemented: boolean; testsPassed: boolean; qaPassed: boolean } | null {
    try {
      if (!row.verification_json) return null;
      const v = JSON.parse(row.verification_json);
      return v.gates ?? null;
    } catch {
      return null;
    }
  }

  const doneSubtasks = subtasks.filter((s: SubtaskRow) => s.status === 'done').length;
  const subtaskPct = subtasks.length > 0 ? Math.round((doneSubtasks / subtasks.length) * 100) : 0;

  /**
   * Derive a per-criterion pass state from the overall verification.
   * We don't have per-criterion tracking in tasks.db — only overall gate state.
   * If verification.passed is true, all criteria pass. Otherwise none pass (pending).
   */
  function acCheckClass(verificationPassed: boolean | null): string {
    if (verificationPassed === true) return 'ac-pass';
    return 'ac-pending';
  }

  function acCheckIcon(verificationPassed: boolean | null): string {
    if (verificationPassed === true) return '✓';
    return '○';
  }

  /** Map artifact type to a short readable label. */
  function artifactTypeLabel(type: string): string {
    const map: Record<string, string> = {
      implementation: 'impl',
      analysis: 'analysis',
      research: 'research',
      fix: 'fix',
      audit: 'audit',
      specification: 'spec',
      consensus: 'consensus',
      report: 'report',
    };
    return map[type] ?? type;
  }

  /** Truncate a long summary for display. */
  function truncate(s: string | null, max: number): string {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  /** Extract just the filename from a path. */
  function basename(p: string): string {
    return p.split('/').pop() ?? p;
  }

  // Collapsible notes state
  let notesExpanded = $state(true);
  let manifestExpanded = $state(true);
  let commitsExpanded = $state(true);
</script>

<svelte:head>
  <title>{task.id} — {task.title} — CLEO Studio</title>
</svelte:head>

<div class="task-detail">
  <!-- Breadcrumb -->
  <nav class="breadcrumb">
    <a href="/tasks">Tasks</a>
    {#if parent}
      <span class="crumb-sep">›</span>
      <a href="/tasks/{parent.id}">{parent.id}</a>
    {/if}
    <span class="crumb-sep">›</span>
    <span class="crumb-current">{task.id}</span>
  </nav>

  <div class="task-layout">
    <!-- Main content -->
    <div class="task-main">
      <!-- Title + status -->
      <div class="task-header">
        <div class="task-title-row">
          <span class="task-id-badge">{task.id}</span>
          <span class="task-status-badge {statusClass(task.status)}">
            {statusIcon(task.status)} {task.status}
          </span>
          <span class="task-priority-badge {priorityClass(task.priority)}">{task.priority}</span>
          {#if task.type !== 'task'}
            <span class="task-type-badge">{task.type}</span>
          {/if}
          {#if task.size}
            <span class="task-size-badge">{task.size}</span>
          {/if}
        </div>
        <h1 class="task-title">{task.title}</h1>
        {#if task.description}
          <div class="task-description">{task.description}</div>
        {/if}
      </div>

      <!-- Acceptance criteria -->
      {#if task.acceptance && task.acceptance.length > 0}
        <section class="detail-section">
          <h2 class="section-title">
            Acceptance Criteria
            <span class="ac-count">{task.acceptance.length} criteria</span>
            {#if task.verification?.passed}
              <span class="ac-all-pass">ALL PASSED</span>
            {/if}
          </h2>
          <ul class="acceptance-list">
            {#each task.acceptance as criterion}
              {@const passed = task.verification?.passed ?? null}
              <li class="acceptance-item {acCheckClass(passed)}">
                <span class="acceptance-check {acCheckClass(passed)}">{acCheckIcon(passed)}</span>
                <span class="acceptance-text">{criterion}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Verification gates -->
      {#if task.verification}
        {@const v = task.verification}
        <section class="detail-section">
          <h2 class="section-title">
            Verification Gates
            <span class="verif-badge" class:passed={v.passed}>
              {v.passed ? 'PASSED' : `Round ${v.round} — Pending`}
            </span>
          </h2>
          <div class="gates-grid">
            <div class="gate" class:gate-passed={v.gates.implemented} class:gate-failed={!v.gates.implemented && v.passed === false && v.round > 1}>
              <span class="gate-icon">{gateIcon(v.gates.implemented)}</span>
              <span class="gate-label">Implemented</span>
            </div>
            <div class="gate" class:gate-passed={v.gates.testsPassed} class:gate-failed={!v.gates.testsPassed && v.passed === false && v.round > 1}>
              <span class="gate-icon">{gateIcon(v.gates.testsPassed)}</span>
              <span class="gate-label">Tests Passed</span>
            </div>
            <div class="gate" class:gate-passed={v.gates.qaPassed} class:gate-failed={!v.gates.qaPassed && v.passed === false && v.round > 1}>
              <span class="gate-icon">{gateIcon(v.gates.qaPassed)}</span>
              <span class="gate-label">QA Passed</span>
            </div>
          </div>
          {#if v.lastAgent || v.lastUpdated}
            <p class="verif-meta">
              {#if v.lastAgent}Last agent: <span class="verif-agent">{v.lastAgent}</span>{/if}
              {#if v.lastUpdated} · {formatDate(v.lastUpdated)}{/if}
            </p>
          {/if}
          {#if v.failureLog && v.failureLog.length > 0}
            <div class="failure-log">
              <div class="failure-log-header">Failure Log ({v.failureLog.length} entries)</div>
              {#each v.failureLog as entry}
                <div class="failure-entry">{entry}</div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- Notes / history -->
      {#if task.notes && task.notes.length > 0}
        <section class="detail-section">
          <button
            class="section-title section-title-btn"
            onclick={() => { notesExpanded = !notesExpanded; }}
            type="button"
          >
            Notes &amp; History
            <span class="note-count">{task.notes.length}</span>
            <span class="collapse-icon">{notesExpanded ? '▾' : '▸'}</span>
          </button>
          {#if notesExpanded}
            <div class="notes-feed">
              {#each task.notes as note, i}
                <div class="note-entry">
                  <span class="note-index">{i + 1}</span>
                  <span class="note-text">{note}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- Linked MANIFEST artifacts -->
      {#if manifestEntries && manifestEntries.length > 0}
        <section class="detail-section">
          <button
            class="section-title section-title-btn"
            onclick={() => { manifestExpanded = !manifestExpanded; }}
            type="button"
          >
            Agent Artifacts
            <span class="artifact-count">{manifestEntries.length}</span>
            <span class="collapse-icon">{manifestExpanded ? '▾' : '▸'}</span>
          </button>
          {#if manifestExpanded}
            <div class="artifact-list">
              {#each manifestEntries as entry}
                <div class="artifact-card" class:artifact-complete={entry.status === 'complete'} class:artifact-partial={entry.status === 'partial'} class:artifact-blocked={entry.status === 'blocked'}>
                  <div class="artifact-header">
                    <span class="artifact-type">{artifactTypeLabel(entry.type)}</span>
                    <span class="artifact-status artifact-status-{entry.status}">{entry.status}</span>
                    {#if entry.date}
                      <span class="artifact-date">{formatDateShort(entry.date)}</span>
                    {/if}
                    <span class="artifact-id">{entry.id}</span>
                  </div>
                  {#if entry.title}
                    <div class="artifact-title">{entry.title}</div>
                  {/if}
                  {#if entry.summary}
                    <div class="artifact-summary">{truncate(entry.summary, 300)}</div>
                  {/if}
                  {#if entry.output}
                    <div class="artifact-output">
                      <span class="artifact-output-label">Output:</span>
                      <code class="artifact-output-path">{entry.output}</code>
                    </div>
                  {/if}
                  {#if entry.files && entry.files.length > 0}
                    <div class="artifact-files">
                      {#each entry.files as f}
                        <code class="artifact-file">{basename(f)}</code>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- Linked git commits -->
      {#if linkedCommits && linkedCommits.length > 0}
        <section class="detail-section">
          <button
            class="section-title section-title-btn"
            onclick={() => { commitsExpanded = !commitsExpanded; }}
            type="button"
          >
            Git Commits
            <span class="commit-count">{linkedCommits.length}</span>
            <span class="collapse-icon">{commitsExpanded ? '▾' : '▸'}</span>
          </button>
          {#if commitsExpanded}
            <div class="commit-list">
              {#each linkedCommits as commit}
                <div class="commit-row">
                  <div class="commit-header">
                    <code class="commit-sha">{commit.sha}</code>
                    <span class="commit-subject">{commit.subject}</span>
                    {#if commit.date}
                      <span class="commit-date">{formatDateShort(commit.date)}</span>
                    {/if}
                  </div>
                  {#if commit.files && commit.files.length > 0}
                    <div class="commit-files">
                      {#each commit.files.slice(0, 10) as f}
                        <code class="commit-file">{f}</code>
                      {/each}
                      {#if commit.files.length > 10}
                        <span class="commit-files-more">+{commit.files.length - 10} more</span>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- Subtask tree -->
      {#if subtasks.length > 0}
        <section class="detail-section">
          <h2 class="section-title">
            {task.type === 'epic' ? 'Children' : 'Subtasks'}
            <span class="subtask-progress">{doneSubtasks}/{subtasks.length} ({subtaskPct}%)</span>
          </h2>
          <div class="subtask-progress-bar">
            <div class="subtask-done-fill" style="width:{subtaskPct}%"></div>
          </div>
          <div class="subtask-list">
            {#each subtasks as sub}
              {@const gates = subtaskVerif(sub)}
              <a href="/tasks/{sub.id}" class="subtask-row">
                <span class="subtask-status {statusClass(sub.status)}">{statusIcon(sub.status)}</span>
                <div class="subtask-info">
                  <span class="subtask-id">{sub.id}</span>
                  {#if sub.type !== 'task'}
                    <span class="subtask-type">{sub.type}</span>
                  {/if}
                  <span class="subtask-title">{sub.title}</span>
                </div>
                <div class="subtask-meta">
                  <span class="subtask-priority {priorityClass(sub.priority)}">{sub.priority}</span>
                  {#if gates}
                    <div class="gate-icons">
                      <span class="gate-dot" class:gate-dot-pass={gates.implemented} title="Implemented">I</span>
                      <span class="gate-dot" class:gate-dot-pass={gates.testsPassed} title="Tests">T</span>
                      <span class="gate-dot" class:gate-dot-pass={gates.qaPassed} title="QA">Q</span>
                    </div>
                  {/if}
                </div>
              </a>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Dependencies & blockers -->
      {#if task.upstream.length > 0 || task.downstream.length > 0}
        <section class="detail-section">
          <h2 class="section-title">Dependencies</h2>

          {#if task.upstream.length > 0}
            <div class="dep-group">
              <div class="dep-group-label dep-blocked-label">
                ↑ Blocked by ({task.upstream.length}) — must complete before this task
              </div>
              {#snippet depRow(dep: DepTask)}
                <a href="/tasks/{dep.id}" class="dep-row">
                  <span class="dep-status {statusClass(dep.status)}">{statusIcon(dep.status)}</span>
                  <span class="dep-id">{dep.id}</span>
                  <span class="dep-title">{dep.title}</span>
                  <span class="dep-priority {priorityClass(dep.priority)}">{dep.priority}</span>
                </a>
              {/snippet}
              <div class="dep-list">
                {#each task.upstream as dep}
                  {@render depRow(dep)}
                {/each}
              </div>
            </div>
          {/if}

          {#if task.downstream.length > 0}
            <div class="dep-group">
              <div class="dep-group-label dep-blocking-label">
                ↓ Blocking ({task.downstream.length}) — these tasks wait on this one
              </div>
              {#snippet depRow2(dep: DepTask)}
                <a href="/tasks/{dep.id}" class="dep-row">
                  <span class="dep-status {statusClass(dep.status)}">{statusIcon(dep.status)}</span>
                  <span class="dep-id">{dep.id}</span>
                  <span class="dep-title">{dep.title}</span>
                  <span class="dep-priority {priorityClass(dep.priority)}">{dep.priority}</span>
                </a>
              {/snippet}
              <div class="dep-list">
                {#each task.downstream as dep}
                  {@render depRow2(dep)}
                {/each}
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>

    <!-- Sidebar -->
    <aside class="task-sidebar">
      <dl class="meta-list">
        <div class="meta-row">
          <dt>Status</dt>
          <dd class="{statusClass(task.status)}">{statusIcon(task.status)} {task.status}</dd>
        </div>
        <div class="meta-row">
          <dt>Priority</dt>
          <dd class="{priorityClass(task.priority)}">{task.priority}</dd>
        </div>
        <div class="meta-row">
          <dt>Type</dt>
          <dd>{task.type}</dd>
        </div>
        {#if task.size}
          <div class="meta-row">
            <dt>Size</dt>
            <dd>{task.size}</dd>
          </div>
        {/if}
        {#if task.pipeline_stage}
          <div class="meta-row">
            <dt>Stage</dt>
            <dd>{task.pipeline_stage}</dd>
          </div>
        {/if}
        {#if task.phase}
          <div class="meta-row">
            <dt>Phase</dt>
            <dd>{task.phase}</dd>
          </div>
        {/if}
        {#if task.assignee}
          <div class="meta-row">
            <dt>Assignee</dt>
            <dd>{task.assignee}</dd>
          </div>
        {/if}
        <div class="meta-row">
          <dt>Created</dt>
          <dd>{formatDate(task.created_at)}</dd>
        </div>
        <div class="meta-row">
          <dt>Updated</dt>
          <dd>{formatDate(task.updated_at)}</dd>
        </div>
        {#if task.completed_at}
          <div class="meta-row">
            <dt>Completed</dt>
            <dd>{formatDate(task.completed_at)}</dd>
          </div>
        {/if}
        {#if task.labels && task.labels.length > 0}
          <div class="meta-row">
            <dt>Labels</dt>
            <dd>
              <div class="label-chips">
                {#each task.labels as lbl}
                  <span class="label-chip">{lbl}</span>
                {/each}
              </div>
            </dd>
          </div>
        {/if}
        <!-- Linked artifact count summary -->
        {#if (manifestEntries && manifestEntries.length > 0) || (linkedCommits && linkedCommits.length > 0)}
          <div class="meta-row meta-row-artifacts">
            <dt>Artifacts</dt>
            <dd class="artifact-summary-counts">
              {#if manifestEntries && manifestEntries.length > 0}
                <span class="artifact-pill">{manifestEntries.length} agent output{manifestEntries.length === 1 ? '' : 's'}</span>
              {/if}
              {#if linkedCommits && linkedCommits.length > 0}
                <span class="artifact-pill">{linkedCommits.length} commit{linkedCommits.length === 1 ? '' : 's'}</span>
              {/if}
            </dd>
          </div>
        {/if}
        <!-- Notes count in sidebar -->
        {#if task.notes && task.notes.length > 0}
          <div class="meta-row">
            <dt>Notes</dt>
            <dd>{task.notes.length} note{task.notes.length === 1 ? '' : 's'}</dd>
          </div>
        {/if}
      </dl>

      <div class="sidebar-nav">
        <a href="/tasks" class="sidebar-link">← All Tasks</a>
        {#if parent}
          <a href="/tasks/tree/{parent.id}" class="sidebar-link">View Epic Tree</a>
        {:else if task.type === 'epic'}
          <a href="/tasks/tree/{task.id}" class="sidebar-link">View as Tree</a>
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  .task-detail {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .breadcrumb a {
    color: #64748b;
    text-decoration: none;
  }

  .breadcrumb a:hover {
    color: #a855f7;
  }

  .crumb-sep {
    color: #475569;
  }

  .crumb-current {
    color: #94a3b8;
  }

  /* Layout */
  .task-layout {
    display: grid;
    grid-template-columns: 1fr 240px;
    gap: 1.5rem;
    align-items: start;
  }

  @media (max-width: 800px) {
    .task-layout { grid-template-columns: 1fr; }
  }

  /* Header */
  .task-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #2d3748;
  }

  .task-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .task-id-badge {
    font-size: 0.75rem;
    font-weight: 700;
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .task-status-badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: #1a1f2e;
  }

  .task-priority-badge {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .task-type-badge {
    font-size: 0.7rem;
    color: #64748b;
    background: #1a1f2e;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .task-size-badge {
    font-size: 0.7rem;
    color: #64748b;
    background: #1a1f2e;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #2d3748;
  }

  .task-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #f1f5f9;
    line-height: 1.4;
  }

  .task-description {
    font-size: 0.875rem;
    color: #94a3b8;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Sections */
  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 0;
    border-bottom: 1px solid #1e2435;
  }

  .section-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .section-title-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    text-align: left;
    width: 100%;
  }

  .section-title-btn:hover {
    color: #e2e8f0;
  }

  .collapse-icon {
    margin-left: auto;
    color: #475569;
    font-size: 0.75rem;
  }

  /* Acceptance */
  .ac-count {
    font-size: 0.7rem;
    color: #64748b;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .ac-all-pass {
    font-size: 0.675rem;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    background: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .acceptance-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .acceptance-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: #e2e8f0;
    padding: 0.375rem 0.5rem;
    border-radius: 4px;
    background: #161b27;
  }

  .acceptance-item.ac-pass {
    background: rgba(34, 197, 94, 0.05);
    border-left: 2px solid rgba(34, 197, 94, 0.4);
  }

  .acceptance-item.ac-pending {
    border-left: 2px solid #2d3748;
  }

  .acceptance-check {
    flex-shrink: 0;
    margin-top: 0.1rem;
    font-size: 0.875rem;
    width: 1rem;
    text-align: center;
  }

  .acceptance-check.ac-pass {
    color: #22c55e;
  }

  .acceptance-check.ac-pending {
    color: #475569;
  }

  .acceptance-text {
    flex: 1;
  }

  /* Verification gates */
  .verif-badge {
    font-size: 0.675rem;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    background: #1a1f2e;
    color: #64748b;
    border: 1px solid #2d3748;
    text-transform: uppercase;
  }

  .verif-badge.passed {
    background: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    border-color: rgba(34, 197, 94, 0.3);
  }

  .gates-grid {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .gate {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    min-width: 90px;
  }

  .gate.gate-passed {
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(34, 197, 94, 0.05);
  }

  .gate.gate-failed {
    border-color: rgba(239, 68, 68, 0.3);
    background: rgba(239, 68, 68, 0.04);
  }

  .gate-icon {
    font-size: 1rem;
    color: #475569;
  }

  .gate.gate-passed .gate-icon {
    color: #22c55e;
  }

  .gate.gate-failed .gate-icon {
    color: #ef4444;
  }

  .gate-label {
    font-size: 0.7rem;
    color: #64748b;
  }

  .gate.gate-passed .gate-label {
    color: #86efac;
  }

  .gate.gate-failed .gate-label {
    color: #fca5a5;
  }

  .verif-meta {
    font-size: 0.75rem;
    color: #475569;
  }

  .verif-agent {
    color: #a855f7;
  }

  .failure-log {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border: 1px solid rgba(249, 115, 22, 0.2);
    border-radius: 6px;
    overflow: hidden;
  }

  .failure-log-header {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #f97316;
    background: rgba(249, 115, 22, 0.08);
    padding: 0.375rem 0.75rem;
    border-bottom: 1px solid rgba(249, 115, 22, 0.15);
  }

  .failure-entry {
    font-size: 0.75rem;
    color: #f97316;
    padding: 0.375rem 0.75rem;
    border-bottom: 1px solid rgba(249, 115, 22, 0.1);
    background: rgba(249, 115, 22, 0.03);
  }

  .failure-entry:last-child {
    border-bottom: none;
  }

  /* Notes feed */
  .note-count {
    font-size: 0.7rem;
    color: #64748b;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    background: #1e2435;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .notes-feed {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .note-entry {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    font-size: 0.8125rem;
    padding: 0.625rem 0.75rem;
    background: #161b27;
    border: 1px solid #1e2435;
    border-radius: 6px;
    border-left: 3px solid #a855f7;
  }

  .note-index {
    font-size: 0.675rem;
    color: #a855f7;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    min-width: 1rem;
    padding-top: 0.05rem;
    flex-shrink: 0;
  }

  .note-text {
    color: #cbd5e1;
    line-height: 1.5;
    flex: 1;
    word-break: break-word;
    white-space: pre-wrap;
  }

  /* Artifact cards */
  .artifact-count, .commit-count {
    font-size: 0.7rem;
    color: #64748b;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    background: #1e2435;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .artifact-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .artifact-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem;
    background: #161b27;
    border: 1px solid #1e2435;
    border-radius: 6px;
    border-left: 3px solid #2d3748;
  }

  .artifact-card.artifact-complete {
    border-left-color: #22c55e;
  }

  .artifact-card.artifact-partial {
    border-left-color: #eab308;
  }

  .artifact-card.artifact-blocked {
    border-left-color: #ef4444;
  }

  .artifact-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .artifact-type {
    font-size: 0.675rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .artifact-status {
    font-size: 0.675rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .artifact-status-complete { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
  .artifact-status-partial { background: rgba(234, 179, 8, 0.1); color: #eab308; }
  .artifact-status-blocked { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
  .artifact-status-unknown { background: #1e2435; color: #64748b; }

  .artifact-date {
    font-size: 0.675rem;
    color: #475569;
  }

  .artifact-id {
    font-size: 0.675rem;
    color: #475569;
    font-family: monospace;
    margin-left: auto;
  }

  .artifact-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #e2e8f0;
    line-height: 1.4;
  }

  .artifact-summary {
    font-size: 0.8rem;
    color: #94a3b8;
    line-height: 1.55;
  }

  .artifact-output {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
  }

  .artifact-output-label {
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.675rem;
    flex-shrink: 0;
  }

  .artifact-output-path {
    font-size: 0.75rem;
    color: #a855f7;
    font-family: monospace;
    background: rgba(168, 85, 247, 0.05);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    word-break: break-all;
  }

  .artifact-files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .artifact-file {
    font-size: 0.7rem;
    color: #64748b;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    font-family: monospace;
  }

  /* Git commits */
  .commit-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .commit-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    background: #161b27;
    border: 1px solid #1e2435;
    border-radius: 6px;
    border-left: 3px solid #3b82f6;
  }

  .commit-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .commit-sha {
    font-size: 0.75rem;
    color: #3b82f6;
    font-family: monospace;
    background: rgba(59, 130, 246, 0.08);
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .commit-subject {
    font-size: 0.8125rem;
    color: #e2e8f0;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .commit-date {
    font-size: 0.675rem;
    color: #475569;
    flex-shrink: 0;
  }

  .commit-files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .commit-file {
    font-size: 0.675rem;
    color: #64748b;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    font-family: monospace;
  }

  .commit-files-more {
    font-size: 0.675rem;
    color: #475569;
    padding: 0.1rem 0.25rem;
  }

  /* Subtasks */
  .subtask-progress {
    font-size: 0.75rem;
    color: #22c55e;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .subtask-progress-bar {
    height: 4px;
    background: #1e2435;
    border-radius: 2px;
    overflow: hidden;
  }

  .subtask-done-fill {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .subtask-list {
    display: flex;
    flex-direction: column;
    border: 1px solid #2d3748;
    border-radius: 6px;
    overflow: hidden;
  }

  .subtask-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .subtask-row:hover {
    background: #21273a;
  }

  .subtask-row:last-child {
    border-bottom: none;
  }

  .subtask-status {
    font-size: 0.75rem;
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .subtask-info {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .subtask-id {
    font-size: 0.7rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .subtask-type {
    font-size: 0.675rem;
    color: #64748b;
    background: #1e2435;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .subtask-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtask-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .subtask-priority {
    font-size: 0.675rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .gate-icons {
    display: flex;
    gap: 2px;
  }

  .gate-dot {
    font-size: 0.6rem;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    background: #1e2435;
    color: #475569;
    font-weight: 600;
  }

  .gate-dot.gate-dot-pass {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  /* Sidebar */
  .task-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .meta-list {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid #1e2435;
  }

  .meta-row:last-child {
    border-bottom: none;
  }

  .meta-row dt {
    font-size: 0.75rem;
    color: #64748b;
    white-space: nowrap;
    padding-top: 0.1rem;
  }

  .meta-row dd {
    font-size: 0.8125rem;
    color: #e2e8f0;
    text-align: right;
  }

  .meta-row-artifacts dd {
    text-align: right;
  }

  .artifact-summary-counts {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: flex-end;
  }

  .artifact-pill {
    font-size: 0.675rem;
    color: #94a3b8;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .label-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    justify-content: flex-end;
  }

  .label-chip {
    font-size: 0.675rem;
    background: #1e2435;
    color: #94a3b8;
    padding: 0.15rem 0.375rem;
    border-radius: 3px;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .sidebar-link {
    font-size: 0.8125rem;
    color: #64748b;
    text-decoration: none;
    padding: 0.5rem 0.875rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    transition: color 0.15s, border-color 0.15s;
  }

  .sidebar-link:hover {
    color: #a855f7;
    border-color: rgba(168, 85, 247, 0.3);
  }

  /* Dependencies section */
  .dep-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.75rem;
  }

  .dep-group:last-child {
    margin-bottom: 0;
  }

  .dep-group-label {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.25rem 0;
  }

  .dep-blocked-label { color: #ef4444; }
  .dep-blocking-label { color: #eab308; }

  .dep-list {
    display: flex;
    flex-direction: column;
    border: 1px solid #2d3748;
    border-radius: 6px;
    overflow: hidden;
  }

  .dep-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .dep-row:hover {
    background: #21273a;
  }

  .dep-row:last-child {
    border-bottom: none;
  }

  .dep-status {
    font-size: 0.7rem;
    flex-shrink: 0;
    width: 1rem;
    text-align: center;
  }

  .dep-id {
    font-size: 0.675rem;
    font-weight: 600;
    color: #a855f7;
    flex-shrink: 0;
  }

  .dep-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dep-priority {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  /* Shared status/priority colors */
  :global(.status-done) { color: #22c55e; }
  :global(.status-active) { color: #3b82f6; }
  :global(.status-blocked) { color: #ef4444; }
  :global(.status-pending) { color: #475569; }
  :global(.priority-critical) { color: #ef4444; }
  :global(.priority-high) { color: #f97316; }
  :global(.priority-medium) { color: #eab308; }
  :global(.priority-low) { color: #64748b; }
</style>
