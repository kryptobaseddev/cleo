<!--
  Task detail page — Wave 1E upgrade.

  Two-column layout:
    - Left 60%: Hero with id+status+priority badges, stage strip, gate
      visualization (6 gates · I · T · Q · D · S · C), description,
      acceptance, manifest, commits.
    - Right 40%: dependency graph (Wave 1C's TaskDepGraph), deps list,
      linked observations/decisions, subtask hierarchy tree.

  All hex literals have been replaced with tokens. Reads from
  `+page.server.ts` which already lives here — no additional SQL.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import {
    gatesFromJson,
    PriorityBadge,
    StatusBadge,
    formatTime,
  } from '$lib/components/tasks';
  import TaskDepGraph from '$lib/components/TaskDepGraph.svelte';
  import type { TaskDepEdge, TaskDepNode } from '$lib/components/TaskDepGraph.svelte';
  import { Badge, Breadcrumb, Button, Card } from '$lib/ui';
  import type { BreadcrumbItem } from '$lib/ui';
  import type { PageData } from './$types';
  import type { DepTask, SubtaskRow } from './+page.server.js';
  import type { TaskPriority, TaskStatus } from '@cleocode/contracts';

  const KNOWN_STATUSES = new Set<TaskStatus>([
    'pending',
    'active',
    'blocked',
    'done',
    'cancelled',
    'archived',
    'proposed',
  ]);
  const KNOWN_PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical']);

  function toStatus(value: string): TaskStatus {
    return (KNOWN_STATUSES as Set<string>).has(value) ? (value as TaskStatus) : 'pending';
  }

  function toPriority(value: string): TaskPriority {
    return (KNOWN_PRIORITIES as Set<string>).has(value)
      ? (value as TaskPriority)
      : 'medium';
  }

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const task = $derived(data.task);
  const subtasks = $derived(data.subtasks);
  const parent = $derived(data.parent);
  const manifestEntries = $derived(data.manifestEntries);
  const linkedCommits = $derived(data.linkedCommits);

  const breadcrumbs = $derived<BreadcrumbItem[]>([
    { label: 'Tasks', href: '/tasks' },
    ...(parent ? [{ label: parent.id, href: `/tasks/${parent.id}` }] : []),
    { label: task.id },
  ]);

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
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  function truncate(s: string | null, max: number): string {
    if (!s) return '';
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  function basename(p: string): string {
    return p.split('/').pop() ?? p;
  }

  interface GateViz {
    key: string;
    label: string;
    passed: boolean;
  }

  const sixGates = $derived<GateViz[]>([
    { key: 'I', label: 'Implemented', passed: task.verification?.gates.implemented ?? false },
    { key: 'T', label: 'Tests', passed: task.verification?.gates.testsPassed ?? false },
    { key: 'Q', label: 'QA', passed: task.verification?.gates.qaPassed ?? false },
    { key: 'D', label: 'Documented', passed: false },
    { key: 'S', label: 'Security', passed: false },
    { key: 'C', label: 'Cleanup', passed: false },
  ]);

  const gatesPassed = $derived(sixGates.filter((g) => g.passed).length);

  function subtaskGates(row: SubtaskRow): { implemented: boolean; testsPassed: boolean; qaPassed: boolean } {
    return gatesFromJson(row.verification_json);
  }

  const doneSubtasks = $derived(subtasks.filter((s: SubtaskRow) => s.status === 'done').length);
  const subtaskPct = $derived(
    subtasks.length > 0 ? Math.round((doneSubtasks / subtasks.length) * 100) : 0,
  );

  // ---- Hero metadata line ----
  const heroMeta = $derived<string>(
    [
      task.pipeline_stage ? `stage: ${task.pipeline_stage}` : null,
      task.size ? `size: ${task.size}` : null,
      task.assignee ? `assigned: ${task.assignee}` : null,
      `updated ${formatTime(task.updated_at)}`,
    ]
      .filter((x): x is string => x !== null)
      .join(' · '),
  );

  function priorityTone(p: string): 'danger' | 'warning' | 'info' | 'neutral' {
    if (p === 'critical' || p === 'high') return 'danger';
    if (p === 'medium') return 'warning';
    if (p === 'low') return 'neutral';
    return 'info';
  }

  function manifestTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'complete') return 'success';
    if (status === 'partial') return 'warning';
    if (status === 'blocked') return 'danger';
    return 'neutral';
  }

  /**
   * Build the node list for the 1-hop ego graph centred on this task.
   * Includes this task (marked focal) + every upstream + every
   * downstream task.
   */
  function buildDepNodes(): TaskDepNode[] {
    const nodes: TaskDepNode[] = [
      {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        type: task.type,
        isFocus: true,
      },
    ];
    for (const u of task.upstream) {
      nodes.push({
        id: u.id,
        title: u.title,
        status: u.status,
        priority: u.priority,
        type: 'task',
        isFocus: false,
      });
    }
    for (const d of task.downstream) {
      nodes.push({
        id: d.id,
        title: d.title,
        status: d.status,
        priority: d.priority,
        type: 'task',
        isFocus: false,
      });
    }
    return nodes;
  }

  /**
   * Edges flow `source → target` where `source` is the dependent and
   * `target` is the blocker. Upstream blockers point INTO the focal;
   * downstream dependents have the focal pointing INTO them.
   */
  function buildDepEdges(): TaskDepEdge[] {
    const edges: TaskDepEdge[] = [];
    for (const u of task.upstream) {
      edges.push({ source: task.id, target: u.id });
    }
    for (const d of task.downstream) {
      edges.push({ source: d.id, target: task.id });
    }
    return edges;
  }
</script>

<svelte:head>
  <title>{task.id} — {task.title} — CLEO Studio</title>
</svelte:head>

<div class="task-detail">
  <Breadcrumb items={breadcrumbs} />

  <HeroHeader eyebrow={task.type.toUpperCase()} title={task.title} meta={heroMeta}>
    {#snippet actions()}
      <StatusBadge status={toStatus(task.status)} />
      <PriorityBadge priority={toPriority(task.priority)} />
      {#if task.size}
        <Badge tone="neutral" size="sm">{task.size}</Badge>
      {/if}
    {/snippet}
  </HeroHeader>

  <div class="detail-layout">
    <!-- LEFT COLUMN ---------------------------------------------- -->
    <div class="detail-main">
      <!-- Gate visualization ------------------------------------- -->
      <section class="gate-section">
        <div class="gate-head">
          <span class="section-label">Verification gates</span>
          <span class="gate-counter">{gatesPassed}/{sixGates.length}</span>
          {#if task.verification?.passed}
            <Badge tone="success" size="sm">ALL PASSED</Badge>
          {:else if task.verification}
            <Badge tone="warning" size="sm">Round {task.verification.round}</Badge>
          {/if}
        </div>
        <div class="gate-strip">
          {#each sixGates as gate}
            <div class="gate" class:passed={gate.passed} title={gate.label}>
              <span class="gate-key">{gate.key}</span>
              <span class="gate-label">{gate.label}</span>
              <span class="gate-icon" aria-hidden="true">{gate.passed ? '✓' : '·'}</span>
            </div>
          {/each}
        </div>
      </section>

      <!-- Description + acceptance -------------------------------- -->
      {#if task.description}
        <section class="prose-section">
          <span class="section-label">Description</span>
          <div class="prose">{task.description}</div>
        </section>
      {/if}

      {#if task.acceptance && task.acceptance.length > 0}
        <section class="ac-section">
          <span class="section-label">
            Acceptance criteria
            <span class="section-meta">{task.acceptance.length} criteria</span>
          </span>
          <ul class="ac-list">
            {#each task.acceptance as criterion}
              {@const passed = task.verification?.passed ?? false}
              <li class="ac-item" class:passed>
                <span class="ac-check" aria-hidden="true">{passed ? '✓' : '○'}</span>
                <span class="ac-text">{criterion}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Notes --------------------------------------------------- -->
      {#if task.notes && task.notes.length > 0}
        <section class="prose-section">
          <span class="section-label">
            Notes
            <span class="section-meta">{task.notes.length} entries</span>
          </span>
          <ol class="notes-list">
            {#each task.notes as note, i}
              <li class="note-item">
                <span class="note-index">#{i + 1}</span>
                <span class="note-text">{note}</span>
              </li>
            {/each}
          </ol>
        </section>
      {/if}

      <!-- Manifest artifacts -------------------------------------- -->
      {#if manifestEntries && manifestEntries.length > 0}
        <section class="artifacts-section">
          <span class="section-label">
            Agent artifacts
            <span class="section-meta">{manifestEntries.length}</span>
          </span>
          <div class="artifact-list">
            {#each manifestEntries as entry (entry.id)}
              <article class="artifact" data-status={entry.status}>
                <header class="artifact-head">
                  <Badge tone="accent" size="sm">{entry.type}</Badge>
                  <Badge tone={manifestTone(entry.status)} size="sm">{entry.status}</Badge>
                  {#if entry.date}
                    <time class="artifact-date">{formatDateShort(entry.date)}</time>
                  {/if}
                  <code class="artifact-id">{entry.id}</code>
                </header>
                {#if entry.title}
                  <h3 class="artifact-title">{entry.title}</h3>
                {/if}
                {#if entry.summary}
                  <p class="artifact-summary">{truncate(entry.summary, 300)}</p>
                {/if}
                {#if entry.output}
                  <div class="artifact-output">
                    <span class="artifact-output-label">output:</span>
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
              </article>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Git commits --------------------------------------------- -->
      {#if linkedCommits && linkedCommits.length > 0}
        <section class="commits-section">
          <span class="section-label">
            Git commits
            <span class="section-meta">{linkedCommits.length}</span>
          </span>
          <ol class="commits-list">
            {#each linkedCommits as commit}
              <li class="commit-item">
                <code class="commit-sha">{commit.sha}</code>
                <span class="commit-subject">{commit.subject}</span>
                {#if commit.date}
                  <time class="commit-date">{formatDateShort(commit.date)}</time>
                {/if}
                {#if commit.files && commit.files.length > 0}
                  <div class="commit-files">
                    {#each commit.files.slice(0, 6) as f}
                      <code class="commit-file">{f}</code>
                    {/each}
                    {#if commit.files.length > 6}
                      <span class="commit-files-more">+{commit.files.length - 6}</span>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    </div>

    <!-- RIGHT COLUMN --------------------------------------------- -->
    <aside class="detail-side">
      <!-- Dependency graph ---------------------------------------- -->
      {#if task.upstream.length > 0 || task.downstream.length > 0}
        {@const depNodes = buildDepNodes()}
        {@const depEdges = buildDepEdges()}
        <section class="side-section">
          <span class="section-label">Dependency graph</span>
          <Card padding="cozy" elevation={0}>
            <TaskDepGraph nodes={depNodes} edges={depEdges} height="260px" />
          </Card>
        </section>
      {/if}

      <!-- Deps ---------------------------------------------------- -->
      {#if task.upstream.length > 0}
        <section class="side-section">
          <span class="section-label dep-label dep-blocked">
            ↑ Blocked by
            <span class="section-meta">{task.upstream.length}</span>
          </span>
          <ul class="dep-list">
            {#each task.upstream as dep}
              <li><a class="dep" href={`/tasks/${dep.id}`}>{depRow(dep)}</a></li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if task.downstream.length > 0}
        <section class="side-section">
          <span class="section-label dep-label dep-blocking">
            ↓ Blocking
            <span class="section-meta">{task.downstream.length}</span>
          </span>
          <ul class="dep-list">
            {#each task.downstream as dep}
              <li><a class="dep" href={`/tasks/${dep.id}`}>{depRow(dep)}</a></li>
            {/each}
          </ul>
        </section>
      {/if}

      {#snippet depRow(dep: DepTask)}
        <span class="dep-row">
          <StatusBadge status={toStatus(dep.status)} compact />
          <span class="dep-id">{dep.id}</span>
          <span class="dep-title">{dep.title}</span>
          <Badge tone={priorityTone(dep.priority)} size="sm" subtle>{dep.priority}</Badge>
        </span>
      {/snippet}

      <!-- Subtasks ------------------------------------------------ -->
      {#if subtasks.length > 0}
        <section class="side-section">
          <span class="section-label">
            {task.type === 'epic' ? 'Children' : 'Subtasks'}
            <span class="section-meta">
              {doneSubtasks}/{subtasks.length} · {subtaskPct}%
            </span>
          </span>
          <div class="subtask-progress" aria-hidden="true">
            <div class="subtask-progress-fill" style={`width: ${subtaskPct}%`}></div>
          </div>
          <ul class="subtask-list">
            {#each subtasks as sub}
              {@const gates = subtaskGates(sub)}
              <li>
                <a class="subtask" href={`/tasks/${sub.id}`}>
                  <StatusBadge status={toStatus(sub.status)} compact />
                  <span class="subtask-id">{sub.id}</span>
                  <span class="subtask-title">{sub.title}</span>
                  <span class="subtask-gates" aria-hidden="true">
                    <span class="g-dot" class:g-pass={gates.implemented}>I</span>
                    <span class="g-dot" class:g-pass={gates.testsPassed}>T</span>
                    <span class="g-dot" class:g-pass={gates.qaPassed}>Q</span>
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Sidebar meta -------------------------------------------- -->
      <Card padding="cozy" elevation={1}>
        <dl class="meta-list">
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
          {#if task.phase}
            <div class="meta-row">
              <dt>Phase</dt>
              <dd>{task.phase}</dd>
            </div>
          {/if}
          {#if task.labels && task.labels.length > 0}
            <div class="meta-row">
              <dt>Labels</dt>
              <dd>
                <div class="label-chips">
                  {#each task.labels as lbl}
                    <Badge tone="neutral" size="sm">{lbl}</Badge>
                  {/each}
                </div>
              </dd>
            </div>
          {/if}
        </dl>
      </Card>

      <div class="sidebar-nav">
        <Button variant="ghost" size="sm" href="/tasks" block>← All Tasks</Button>
        {#if task.type === 'epic'}
          <Button variant="ghost" size="sm" href={`/tasks?hierarchy=${task.id}`} block>
            View as tree
          </Button>
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  .task-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 1400px;
    margin: 0 auto;
  }

  .detail-layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
    gap: var(--space-6);
    align-items: start;
  }

  @media (max-width: 960px) {
    .detail-layout {
      grid-template-columns: 1fr;
    }
  }

  .detail-main,
  .detail-side {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }

  .section-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .section-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.04em;
    text-transform: none;
    font-weight: 400;
  }

  /* ------------- gate strip ------------- */
  .gate-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .gate-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .gate-counter {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .gate-strip {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: var(--space-2);
  }

  @media (max-width: 580px) {
    .gate-strip {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  .gate {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color var(--ease), background var(--ease);
  }

  .gate.passed {
    border-color: color-mix(in srgb, var(--success) 40%, transparent);
    background: color-mix(in srgb, var(--success-soft) 50%, var(--bg-elev-1));
  }

  .gate-key {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text-faint);
    line-height: 1;
  }

  .gate.passed .gate-key {
    color: var(--success);
  }

  .gate-label {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .gate.passed .gate-label {
    color: var(--success);
  }

  .gate-icon {
    font-size: var(--text-md);
    color: var(--text-faint);
  }

  .gate.passed .gate-icon {
    color: var(--success);
  }

  /* ------------- prose / acceptance ------------- */
  .prose-section,
  .ac-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .prose {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ac-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .ac-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .ac-item.passed {
    border-left-color: var(--success);
    background: color-mix(in srgb, var(--success-soft) 30%, var(--bg-elev-1));
  }

  .ac-check {
    font-family: var(--font-mono);
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .ac-item.passed .ac-check {
    color: var(--success);
  }

  .ac-text {
    flex: 1;
  }

  /* ------------- notes ------------- */
  .notes-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .note-item {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .note-index {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 700;
    flex-shrink: 0;
  }

  .note-text {
    flex: 1;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ------------- artifacts ------------- */
  .artifacts-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .artifact-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .artifact {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }

  .artifact[data-status='complete'] { border-left-color: var(--success); }
  .artifact[data-status='partial']  { border-left-color: var(--warning); }
  .artifact[data-status='blocked']  { border-left-color: var(--danger); }

  .artifact-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .artifact-date {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .artifact-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    margin-left: auto;
  }

  .artifact-title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    margin: 0;
  }

  .artifact-summary {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .artifact-output {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }

  .artifact-output-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .artifact-output-path {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
    background: var(--accent-halo);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    word-break: break-all;
  }

  .artifact-files {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .artifact-file,
  .commit-file {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  /* ------------- commits ------------- */
  .commits-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .commit-item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--info);
    border-radius: var(--radius-sm);
  }

  .commit-sha {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--info);
    background: var(--info-soft);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    grid-column: 1;
    grid-row: 1;
  }

  .commit-subject {
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    grid-column: 2;
    grid-row: 1;
  }

  .commit-date {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    grid-column: 3;
    grid-row: 1;
  }

  .commit-files {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .commit-files-more {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  /* ------------- side column ------------- */
  .side-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dep-label {
    font-family: var(--font-mono);
  }

  .dep-blocked {
    color: var(--danger);
  }

  .dep-blocking {
    color: var(--warning);
  }

  .dep-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dep {
    display: flex;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease), border-color var(--ease);
  }

  .dep:hover {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .dep-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-width: 0;
  }

  .dep-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .dep-title {
    font-size: var(--text-sm);
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtask-progress {
    height: 3px;
    background: var(--bg-elev-2);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .subtask-progress-fill {
    height: 100%;
    background: var(--success);
    transition: width var(--ease-slow);
  }

  @media (prefers-reduced-motion: reduce) {
    .subtask-progress-fill { transition: none; }
  }

  .subtask-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .subtask {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease);
  }

  .subtask:hover {
    background: var(--bg-elev-2);
  }

  .subtask-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .subtask-title {
    font-size: var(--text-sm);
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtask-gates {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .g-dot {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    width: 13px;
    height: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs);
    background: var(--bg-elev-2);
    color: var(--border-strong);
    font-weight: 700;
  }

  .g-dot.g-pass {
    background: var(--success-soft);
    color: var(--success);
  }

  .meta-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .meta-row:last-child {
    border-bottom: none;
  }

  .meta-row dt {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .meta-row dd {
    font-size: var(--text-sm);
    color: var(--text);
    margin: 0;
    text-align: right;
  }

  .label-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
