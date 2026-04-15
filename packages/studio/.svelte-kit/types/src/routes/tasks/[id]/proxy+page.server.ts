// @ts-nocheck
/**
 * Task detail page server load — single task, subtasks, verification, acceptance.
 */

import { error } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

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

export const load = ({ locals, params }: Parameters<PageServerLoad>[0]) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    error(503, 'tasks.db unavailable');
  }

  const { id } = params;

  const row = db
    .prepare(
      `SELECT id, title, description, status, priority, type, parent_id,
              pipeline_stage, size, phase, labels_json, acceptance_json,
              verification_json, created_at, updated_at, completed_at,
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
  };

  const subtasks = db
    .prepare(
      `SELECT id, title, status, priority, type, pipeline_stage, size,
              verification_json, acceptance_json, created_at, completed_at
       FROM tasks WHERE parent_id = ?
       ORDER BY position ASC, created_at ASC`,
    )
    .all(id) as SubtaskRow[];

  // Parent breadcrumb
  let parent: { id: string; title: string; type: string } | null = null;
  if (row.parent_id) {
    parent =
      (db.prepare('SELECT id, title, type FROM tasks WHERE id = ?').get(row.parent_id) as
        | { id: string; title: string; type: string }
        | undefined) ?? null;
  }

  return { task, subtasks, parent };
};
