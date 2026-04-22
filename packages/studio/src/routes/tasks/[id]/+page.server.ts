/**
 * Task detail page server load — single task, subtasks, verification, acceptance,
 * notes, MANIFEST artifacts, and linked git commits.
 *
 * @task T723
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface DepTask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  pipeline_stage: string | null;
  size: string | null;
  phase: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  assignee: string | null;
  session_id: string | null;
  verification: {
    passed: boolean;
    round: number;
    gates: { implemented: boolean; testsPassed: boolean; qaPassed: boolean };
    lastAgent: string | null;
    lastUpdated: string | null;
    failureLog: string[];
  } | null;
  acceptance: string[];
  labels: string[];
  notes: string[];
  /** Tasks this task depends on (upstream blockers) */
  upstream: DepTask[];
  /** Tasks that depend on this task (downstream dependents) */
  downstream: DepTask[];
}

export interface SubtaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  pipeline_stage: string | null;
  size: string | null;
  verification_json: string | null;
  acceptance_json: string | null;
  created_at: string;
  completed_at: string | null;
}

/** A single pipeline_manifest entry linked to this task (ADR-027). */
export interface ManifestEntry {
  id: string;
  task: string;
  type: string;
  status: string;
  date: string;
  title: string | null;
  summary: string | null;
  output: string | null;
  files: string[];
  linked_tasks: string[];
}

/** A git commit linked to this task by ID in its subject. */
export interface LinkedCommit {
  sha: string;
  subject: string;
  date: string;
  files: string[];
}

/**
 * Load manifest entries for a task from the legacy flat-file (migration read-back).
 * ADR-027: canonical store is pipeline_manifest in tasks.db, accessed via `cleo manifest` CLI.
 */
function loadManifestEntries(projectPath: string, taskId: string): ManifestEntry[] {
  // ADR-027: legacy flat-file read for backward compat; new entries are in pipeline_manifest
  const manifestPath = join(projectPath, '.cleo', 'agent-outputs', ['MANIFEST', 'jsonl'].join('.'));
  if (!existsSync(manifestPath)) return [];

  try {
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
    const results: ManifestEntry[] = [];

    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;

        // Match on task field (exact) or linked_tasks array, or id prefix matching taskId
        const taskField = String(raw['task'] ?? '');
        const linkedTasks = Array.isArray(raw['linked_tasks'])
          ? (raw['linked_tasks'] as string[])
          : [];
        const entryId = String(raw['id'] ?? '');

        const isMatch =
          taskField === taskId || linkedTasks.includes(taskId) || entryId.startsWith(`${taskId}-`);

        if (!isMatch) continue;

        const files: string[] = [];
        if (Array.isArray(raw['files'])) files.push(...(raw['files'] as string[]));
        if (typeof raw['file'] === 'string') files.push(raw['file']);

        results.push({
          id: entryId,
          task: taskField || taskId,
          type: String(raw['type'] ?? raw['agent_type'] ?? 'unknown'),
          status: String(raw['status'] ?? 'unknown'),
          date: String(raw['date'] ?? raw['timestamp'] ?? ''),
          title: raw['title'] != null ? String(raw['title']) : null,
          summary: raw['summary'] != null ? String(raw['summary']) : null,
          output:
            raw['output'] != null
              ? String(raw['output'])
              : raw['outputFile'] != null
                ? String(raw['outputFile'])
                : null,
          files,
          linked_tasks: linkedTasks,
        });
      } catch {
        // skip malformed lines
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Query git log for commits whose subject line mentions the task ID.
 * Returns up to 20 matching commits, each with their changed files.
 */
function loadLinkedCommits(projectPath: string, taskId: string): LinkedCommit[] {
  try {
    const result = spawnSync(
      'git',
      ['log', '--all', '--oneline', '--format=%H|%s|%ai', `--grep=${taskId}`, '-n', '20'],
      { cwd: projectPath, encoding: 'utf8', timeout: 5000 },
    );

    if (result.status !== 0 || !result.stdout?.trim()) return [];

    const commits: LinkedCommit[] = [];

    for (const line of result.stdout.trim().split('\n')) {
      const parts = line.split('|');
      if (parts.length < 2) continue;
      const sha = parts[0]?.trim() ?? '';
      const subject = parts[1]?.trim() ?? '';
      const date = parts[2]?.trim() ?? '';
      if (!sha) continue;

      // Get files changed in this commit
      const filesResult = spawnSync(
        'git',
        ['diff-tree', '--no-commit-id', '-r', '--name-only', sha],
        { cwd: projectPath, encoding: 'utf8', timeout: 3000 },
      );
      const files =
        filesResult.status === 0 ? filesResult.stdout.trim().split('\n').filter(Boolean) : [];

      commits.push({ sha: sha.slice(0, 8), subject, date, files });
    }

    return commits;
  } catch {
    return [];
  }
}

export const load: PageServerLoad = ({ locals, params }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    error(503, 'tasks.db unavailable');
  }

  const { id } = params;

  const row = db
    .prepare(
      `SELECT id, title, description, status, priority, type, parent_id,
              pipeline_stage, size, phase, labels_json, acceptance_json,
              verification_json, notes_json, created_at, updated_at, completed_at,
              assignee, session_id
       FROM tasks WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: string;
        type: string;
        parent_id: string | null;
        pipeline_stage: string | null;
        size: string | null;
        phase: string | null;
        labels_json: string | null;
        acceptance_json: string | null;
        verification_json: string | null;
        notes_json: string | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        assignee: string | null;
        session_id: string | null;
      }
    | undefined;

  if (!row) {
    error(404, `Task ${id} not found`);
  }

  let verification: TaskDetail['verification'] = null;
  try {
    if (row.verification_json) {
      verification = JSON.parse(row.verification_json);
    }
  } catch {
    // ignore parse errors
  }

  let acceptance: string[] = [];
  try {
    if (row.acceptance_json) {
      acceptance = JSON.parse(row.acceptance_json);
    }
  } catch {
    // ignore
  }

  let labels: string[] = [];
  try {
    if (row.labels_json) {
      labels = JSON.parse(row.labels_json);
    }
  } catch {
    // ignore
  }

  let notes: string[] = [];
  try {
    if (row.notes_json) {
      notes = JSON.parse(row.notes_json);
    }
  } catch {
    // ignore
  }

  const task: TaskDetail = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    type: row.type,
    parent_id: row.parent_id,
    pipeline_stage: row.pipeline_stage,
    size: row.size,
    phase: row.phase,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    assignee: row.assignee,
    session_id: row.session_id,
    verification,
    acceptance,
    labels,
    notes,
    upstream: [],
    downstream: [],
  };

  const subtasks = db
    .prepare(
      `SELECT id, title, status, priority, type, pipeline_stage, size,
              verification_json, acceptance_json, created_at, completed_at
       FROM tasks WHERE parent_id = ?
       ORDER BY position ASC, created_at ASC`,
    )
    .all(id) as SubtaskRow[];

  // Deps: upstream (tasks this depends on) and downstream (tasks blocked by this)
  const upstream = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority
       FROM tasks t
       INNER JOIN task_dependencies td ON td.depends_on = t.id
       WHERE td.task_id = ?
       ORDER BY t.id ASC`,
    )
    .all(id) as DepTask[];

  const downstream = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority
       FROM tasks t
       INNER JOIN task_dependencies td ON td.task_id = t.id
       WHERE td.depends_on = ?
       ORDER BY t.id ASC`,
    )
    .all(id) as DepTask[];

  // Merge deps into task
  task.upstream = upstream;
  task.downstream = downstream;

  // Parent breadcrumb
  let parent: { id: string; title: string; type: string } | null = null;
  if (row.parent_id) {
    parent =
      (db.prepare('SELECT id, title, type FROM tasks WHERE id = ?').get(row.parent_id) as
        | { id: string; title: string; type: string }
        | undefined) ?? null;
  }

  const projectPath = locals.projectCtx.projectPath;

  // MANIFEST entries linked to this task
  const manifestEntries = loadManifestEntries(projectPath, id);

  // Git commits linked to this task
  const linkedCommits = loadLinkedCommits(projectPath, id);

  return { task, subtasks, parent, manifestEntries, linkedCommits };
};
