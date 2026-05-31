/**
 * CLI `cleo classify <taskId>` — readiness + persona routing surface.
 *
 * Thin dispatch over two core predicates:
 *   1. `classifyReadiness(task)` — grill-gate verdict (proceed | grill) with
 *      trigger codes surfaced so agents know exactly what must be resolved
 *      before autonomous execution.
 *   2. `classifyTask(task)` — persona-registry routing that determines which
 *      agent persona (project-orchestrator, project-dev-lead, etc.) the task
 *      should be spawned with, and at what confidence.
 *
 * Both predicates are pure functions in `packages/core/src/orchestration/`.
 * This handler is PURE GLUE: parse → load task → call predicates → emit.
 *
 * Usage:
 *   cleo classify <taskId>
 *   cleo classify T1234
 *
 * Output (one LAFS envelope):
 *   {
 *     taskId, title,
 *     readiness: { verdict, reason, triggers },
 *     routing:   { agentId, role, confidence, reason, usedFallback }
 *   }
 *
 * @task T11499 E7-CLOSE-LOOPS AC2 — cleo classify surfacing classifyReadiness
 * @saga T11492 SG-AUTOPILOT
 */

import { classifyReadiness, classifyTask, getProjectRoot } from '@cleocode/core';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo classify <taskId>` — classify a task for readiness and persona routing.
 *
 * Returns a LAFS envelope with the grill-gate verdict and the best-match
 * agent persona, so autopilot routes and spawn decisions use real classification
 * signals instead of hardcoded stubs.
 *
 * @task T11499 E7-CLOSE-LOOPS
 */
export const classifyCommand = defineCommand({
  meta: {
    name: 'classify',
    description:
      'Classify a task: readiness verdict (proceed|grill) + persona routing (agent, confidence)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to classify (e.g. T1234)',
      required: true,
    },
  },
  async run({ args }) {
    const taskId = args.taskId as string;
    const projectRoot = getProjectRoot();

    // Load the task via the store layer (matches sentient.ts pattern).
    const { getDb } = await import('@cleocode/core/store/sqlite.js');
    const { tasks } = await import('@cleocode/core/store/tasks-schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb(projectRoot);
    const row = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();

    if (!row) {
      cliOutput(
        {
          success: false,
          error: { code: 'E_NOT_FOUND', message: `Task ${taskId} not found` },
        },
        { command: 'classify', operation: 'classify.show' },
      );
      return;
    }

    // Parse labels and acceptance from JSON columns.
    const labels: string[] = (() => {
      try {
        const parsed: unknown = JSON.parse(row.labelsJson ?? '[]');
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    })();

    const acceptance: string[] = (() => {
      try {
        const parsed: unknown = JSON.parse(row.acceptanceJson ?? '[]');
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    })();

    // Build the minimal Task object used by both predicates.
    const task = {
      id: row.id,
      title: row.title,
      description: row.description ?? '',
      status: row.status,
      priority: row.priority ?? 'medium',
      type: row.type ?? undefined,
      kind: row.kind ?? undefined,
      size: row.size ?? undefined,
      pipelineStage: row.pipelineStage ?? undefined,
      blockedBy: row.blockedBy ?? undefined,
      phase: row.phase ?? undefined,
      scope: row.scope ?? undefined,
      labels,
      acceptance,
      createdAt: row.createdAt,
    };

    // Run both predicates (pure — no I/O).
    const readiness = classifyReadiness(task);
    const routing = classifyTask(task);

    cliOutput(
      {
        taskId: row.id,
        title: row.title,
        readiness: {
          verdict: readiness.verdict,
          reason: readiness.reason,
          triggers: readiness.triggers,
        },
        routing: {
          agentId: routing.agentId,
          role: routing.role,
          confidence: routing.confidence,
          reason: routing.reason,
          usedFallback: routing.usedFallback,
          warning: routing.warning,
        },
      },
      { command: 'classify', operation: 'classify.show' },
    );
  },
});
