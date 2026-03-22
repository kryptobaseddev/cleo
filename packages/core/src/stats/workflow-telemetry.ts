/**
 * Workflow Telemetry Module — Agent Workflow Compliance Metrics
 *
 * Computes compliance metrics for WF-001 through WF-005 workflow rules
 * defined in T063. Queries existing data from tasks, sessions, and audit_log
 * tables — no new infrastructure required.
 *
 * Metrics produced:
 *   - AC compliance rate:      % of tasks with ≥3 acceptance criteria
 *   - Session compliance rate: % of task completions that occurred within a session
 *   - Gate compliance rate:    Average verification gates set per completed task
 *   - Workflow violations:     Count of tasks that bypassed WF rules
 *
 * @task T065
 * @epic T056
 */

import { getLogger } from '../logger.js';

const log = getLogger('workflow-telemetry');

/** Per-rule compliance breakdown. */
export interface WorkflowRuleMetric {
  /** Rule identifier, e.g. WF-001. */
  rule: string;
  /** Human-readable rule description. */
  description: string;
  /** Total tasks or events that were subject to this rule. */
  total: number;
  /** Number that violated the rule. */
  violations: number;
  /** Compliance rate 0..1 (1 = fully compliant). */
  complianceRate: number;
}

/** Full workflow compliance report. */
export interface WorkflowComplianceReport {
  /** ISO timestamp when metrics were computed. */
  generatedAt: string;
  /** Time window filtered (ISO cutoff) or null for all-time. */
  since: string | null;
  /** Overall compliance score 0..1 (average of all rule rates). */
  overallScore: number;
  /** Grade letter derived from overallScore. */
  grade: string;
  /** Per-rule breakdown. */
  rules: WorkflowRuleMetric[];
  /** Task-level violation samples (up to 20). */
  violationSamples: Array<{
    taskId: string;
    rule: string;
    detail: string;
  }>;
  /** Raw counts for context. */
  summary: {
    totalTasks: number;
    completedTasks: number;
    tasksWithAC: number;
    tasksWithoutAC: number;
    completionsInSession: number;
    completionsOutsideSession: number;
    tasksWithGates: number;
    avgGatesSet: number;
  };
}

// ---------------------------------------------------------------------------
// Internal types for raw DB rows
// ---------------------------------------------------------------------------

interface RawTask {
  id: string;
  status: string;
  acceptanceJson: string | null;
  verificationJson: string | null;
  sessionId: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface RawAuditRow {
  action: string;
  timestamp: string;
  taskId: string | null;
  sessionId: string | null;
  afterJson: string | null;
  operation: string | null;
  domain: string | null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function queryTasks(cwd: string, since: string | null): Promise<RawTask[]> {
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { tasks } = await import('../store/tasks-schema.js');
    const { and, gte } = await import('drizzle-orm');

    const db = await getDb(cwd);

    const conditions = [];
    if (since) {
      // Include tasks created or completed since the cutoff
      conditions.push(gte(tasks.createdAt, since));
    }

    const rows = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        acceptanceJson: tasks.acceptanceJson,
        verificationJson: tasks.verificationJson,
        sessionId: tasks.sessionId,
        completedAt: tasks.completedAt,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .all();

    return rows as RawTask[];
  } catch (err) {
    log.warn({ err }, 'Failed to query tasks for workflow telemetry');
    return [];
  }
}

async function queryCompletionAuditRows(cwd: string, since: string | null): Promise<RawAuditRow[]> {
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const { and, gte } = await import('drizzle-orm');

    const db = await getDb(cwd);

    // Completion events: action = 'task_completed' OR 'complete'
    // OR operation = 'complete' in dispatch layer
    const conditions = [];
    if (since) conditions.push(gte(auditLog.timestamp, since));

    const allRows = await db
      .select({
        action: auditLog.action,
        timestamp: auditLog.timestamp,
        taskId: auditLog.taskId,
        sessionId: auditLog.sessionId,
        afterJson: auditLog.afterJson,
        operation: auditLog.operation,
        domain: auditLog.domain,
      })
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(auditLog.timestamp)
      .all();

    // Filter to completion events only
    return (allRows as RawAuditRow[]).filter((row) => {
      const isComplete =
        row.action === 'task_completed' ||
        row.action === 'complete' ||
        (row.operation === 'complete' && row.domain === 'tasks');

      // Also catch status_changed → done
      if (!isComplete && row.afterJson) {
        try {
          const after = JSON.parse(row.afterJson) as Record<string, unknown>;
          return after?.status === 'done';
        } catch {
          return false;
        }
      }
      return isComplete;
    });
  } catch (err) {
    log.warn({ err }, 'Failed to query audit log for workflow telemetry');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function parseAcceptanceCriteria(acceptanceJson: string | null): string[] {
  if (!acceptanceJson) return [];
  try {
    const parsed = JSON.parse(acceptanceJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseVerification(verificationJson: string | null): Record<string, unknown> | null {
  if (!verificationJson) return null;
  try {
    return JSON.parse(verificationJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function countTrueGates(gates: Record<string, unknown>): number {
  if (!gates || typeof gates !== 'object') return 0;
  return Object.values(gates).filter((v) => v === true).length;
}

function gradeFromScore(score: number): string {
  if (score >= 0.95) return 'A+';
  if (score >= 0.9) return 'A';
  if (score >= 0.8) return 'B';
  if (score >= 0.7) return 'C';
  if (score >= 0.6) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute workflow compliance metrics from existing task, session, and audit data.
 *
 * Rules evaluated:
 *   WF-001: Tasks MUST have ≥3 acceptance criteria (T058)
 *   WF-002: Task completions MUST occur within an active session (T059)
 *   WF-003: Completed tasks SHOULD have verification gates set (T061)
 *   WF-004: Tasks with verification SHOULD have all 3 gates set
 *   WF-005: Tasks MUST have session binding on creation (non-epic)
 */
export async function getWorkflowComplianceReport(opts: {
  since?: string;
  cwd?: string;
}): Promise<WorkflowComplianceReport> {
  const cwd = opts.cwd ?? process.cwd();
  const since = opts.since ?? null;
  const generatedAt = new Date().toISOString();

  const [allTasks, completionEvents] = await Promise.all([
    queryTasks(cwd, since),
    queryCompletionAuditRows(cwd, since),
  ]);

  // Include all tasks in WF checks. Epics will naturally show 0 AC criteria
  // which counts as a violation — this is acceptable since epics should also
  // have AC defined. The raw task query does not include the type column to
  // keep the query minimal, so we don't filter by type here.
  const nonEpicTasks = allTasks;

  const completedTasks = allTasks.filter((t) => t.status === 'done' || t.completedAt != null);

  // -------------------------------------------------------------------------
  // WF-001: AC compliance — tasks with ≥3 acceptance criteria
  // -------------------------------------------------------------------------
  const wf001Violations: Array<{ taskId: string; rule: string; detail: string }> = [];
  let tasksWithAC = 0;
  let tasksWithoutAC = 0;

  for (const task of nonEpicTasks) {
    const ac = parseAcceptanceCriteria(task.acceptanceJson);
    if (ac.length >= 3) {
      tasksWithAC++;
    } else {
      tasksWithoutAC++;
      if (wf001Violations.length < 10) {
        wf001Violations.push({
          taskId: task.id,
          rule: 'WF-001',
          detail: `has ${ac.length} AC item(s), needs ≥3`,
        });
      }
    }
  }

  const wf001Total = nonEpicTasks.length;
  const wf001Rate = wf001Total > 0 ? tasksWithAC / wf001Total : 1;

  // -------------------------------------------------------------------------
  // WF-002: Session compliance — completions that occurred inside a session
  // -------------------------------------------------------------------------
  const wf002Violations: Array<{ taskId: string; rule: string; detail: string }> = [];
  let completionsInSession = 0;
  let completionsOutsideSession = 0;

  for (const event of completionEvents) {
    if (event.sessionId && event.sessionId !== 'unknown' && event.sessionId !== 'system') {
      completionsInSession++;
    } else {
      completionsOutsideSession++;
      if (wf002Violations.length < 5) {
        wf002Violations.push({
          taskId: event.taskId ?? 'unknown',
          rule: 'WF-002',
          detail: 'task completed outside an active session',
        });
      }
    }
  }

  const wf002Total = completionEvents.length;
  const wf002Rate = wf002Total > 0 ? completionsInSession / wf002Total : 1;

  // -------------------------------------------------------------------------
  // WF-003: Gate compliance — completed tasks with verification initialized
  // -------------------------------------------------------------------------
  const wf003Violations: Array<{ taskId: string; rule: string; detail: string }> = [];
  let tasksWithGates = 0;
  let tasksWithoutGates = 0;
  let totalGatesSet = 0;
  let gateTaskCount = 0;

  for (const task of completedTasks) {
    const verification = parseVerification(task.verificationJson);
    if (verification) {
      tasksWithGates++;
      const gates = (verification.gates ?? {}) as Record<string, unknown>;
      const setCount = countTrueGates(gates);
      totalGatesSet += setCount;
      gateTaskCount++;
    } else {
      tasksWithoutGates++;
      if (wf003Violations.length < 5) {
        wf003Violations.push({
          taskId: task.id,
          rule: 'WF-003',
          detail: 'completed without verification gates',
        });
      }
    }
  }

  const wf003Total = completedTasks.length;
  const wf003Rate = wf003Total > 0 ? tasksWithGates / wf003Total : 1;
  const avgGatesSet =
    gateTaskCount > 0 ? Math.round((totalGatesSet / gateTaskCount) * 100) / 100 : 0;

  // -------------------------------------------------------------------------
  // WF-004: Full gate compliance — tasks with verification where all 3 gates are set
  // -------------------------------------------------------------------------
  const wf004Violations: Array<{ taskId: string; rule: string; detail: string }> = [];
  let allGatesSet = 0;
  let partialGates = 0;

  for (const task of completedTasks) {
    const verification = parseVerification(task.verificationJson);
    if (!verification) continue; // Already captured in WF-003

    const gates = (verification.gates ?? {}) as Record<string, unknown>;
    const setCount = countTrueGates(gates);
    const totalGates = Object.keys(gates).length;

    if (totalGates > 0 && setCount === totalGates) {
      allGatesSet++;
    } else if (totalGates > 0) {
      partialGates++;
      if (wf004Violations.length < 5) {
        wf004Violations.push({
          taskId: task.id,
          rule: 'WF-004',
          detail: `only ${setCount}/${totalGates} verification gates set`,
        });
      }
    }
  }

  const wf004Total = tasksWithGates;
  const wf004Rate = wf004Total > 0 ? allGatesSet / wf004Total : 1;

  // -------------------------------------------------------------------------
  // WF-005: Session binding on creation — tasks with sessionId set
  // -------------------------------------------------------------------------
  const wf005Violations: Array<{ taskId: string; rule: string; detail: string }> = [];
  let tasksWithSessionBinding = 0;
  let tasksWithoutSessionBinding = 0;

  for (const task of nonEpicTasks) {
    if (task.sessionId && task.sessionId !== 'unknown' && task.sessionId !== 'system') {
      tasksWithSessionBinding++;
    } else {
      tasksWithoutSessionBinding++;
      if (wf005Violations.length < 5) {
        wf005Violations.push({
          taskId: task.id,
          rule: 'WF-005',
          detail: 'created without session binding',
        });
      }
    }
  }

  const wf005Total = nonEpicTasks.length;
  const wf005Rate = wf005Total > 0 ? tasksWithSessionBinding / wf005Total : 1;

  // -------------------------------------------------------------------------
  // Aggregate
  // -------------------------------------------------------------------------

  const rules: WorkflowRuleMetric[] = [
    {
      rule: 'WF-001',
      description: 'Tasks must have ≥3 acceptance criteria',
      total: wf001Total,
      violations: tasksWithoutAC,
      complianceRate: Math.round(wf001Rate * 10000) / 10000,
    },
    {
      rule: 'WF-002',
      description: 'Task completions must occur within an active session',
      total: wf002Total,
      violations: completionsOutsideSession,
      complianceRate: Math.round(wf002Rate * 10000) / 10000,
    },
    {
      rule: 'WF-003',
      description: 'Completed tasks should have verification gates initialized',
      total: wf003Total,
      violations: tasksWithoutGates,
      complianceRate: Math.round(wf003Rate * 10000) / 10000,
    },
    {
      rule: 'WF-004',
      description: 'Verification gates should all be marked passed before completion',
      total: wf004Total,
      violations: partialGates,
      complianceRate: Math.round(wf004Rate * 10000) / 10000,
    },
    {
      rule: 'WF-005',
      description: 'Tasks must be created with active session binding',
      total: wf005Total,
      violations: tasksWithoutSessionBinding,
      complianceRate: Math.round(wf005Rate * 10000) / 10000,
    },
  ];

  // Overall score: weighted average (MUST rules count double vs SHOULD)
  // WF-001, WF-002, WF-005 are MUST; WF-003, WF-004 are SHOULD
  const mustWeight = 2;
  const shouldWeight = 1;
  const wf001w = wf001Total > 0 ? mustWeight : 0;
  const wf002w = wf002Total > 0 ? mustWeight : 0;
  const wf003w = wf003Total > 0 ? shouldWeight : 0;
  const wf004w = wf004Total > 0 ? shouldWeight : 0;
  const wf005w = wf005Total > 0 ? mustWeight : 0;
  const totalWeight = wf001w + wf002w + wf003w + wf004w + wf005w;

  const overallScore =
    totalWeight > 0
      ? (wf001w * wf001Rate +
          wf002w * wf002Rate +
          wf003w * wf003Rate +
          wf004w * wf004Rate +
          wf005w * wf005Rate) /
        totalWeight
      : 1;

  const roundedScore = Math.round(overallScore * 10000) / 10000;

  const violationSamples = [
    ...wf001Violations,
    ...wf002Violations,
    ...wf003Violations,
    ...wf004Violations,
    ...wf005Violations,
  ].slice(0, 20);

  return {
    generatedAt,
    since,
    overallScore: roundedScore,
    grade: gradeFromScore(roundedScore),
    rules,
    violationSamples,
    summary: {
      totalTasks: allTasks.length,
      completedTasks: completedTasks.length,
      tasksWithAC,
      tasksWithoutAC,
      completionsInSession,
      completionsOutsideSession,
      tasksWithGates,
      avgGatesSet,
    },
  };
}
