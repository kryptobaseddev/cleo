/**
 * POST /api/project/reindex-all
 *
 * Fan out `cleo nexus analyze <path> --json` over every registered
 * project serially. Returns an array of per-project results.
 *
 * Serial (not parallel) because each reindex spawns a full AST pass
 * that already saturates one CPU core; parallelising would just
 * contend for the same resources and slow the whole batch down.
 *
 * Request body (optional):
 *   {
 *     onlyStale?: boolean;   — skip projects indexed in the last N days
 *     staleDays?: number;    — threshold used when onlyStale=true (default 7)
 *   }
 *
 * @task T990
 * @wave 1E
 */

import { json } from '@sveltejs/kit';
import { recordAudit } from '$lib/server/audit-log.js';
import { listRegisteredProjects } from '$lib/server/project-context.js';
import { runCleoCli } from '$lib/server/spawn-cli.js';
import type { RequestHandler } from './$types';

interface ReindexAllBody {
  onlyStale?: boolean;
  staleDays?: number;
}

interface PerProjectResult {
  projectId: string;
  name: string;
  path: string;
  status: 'success' | 'failure' | 'skipped';
  error?: string;
  elapsedMs: number;
}

function isStale(lastIndexed: string | null, days: number): boolean {
  if (!lastIndexed) return true; // never indexed → definitely stale
  const age = Date.now() - new Date(lastIndexed).getTime();
  return age > days * 24 * 60 * 60 * 1000;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  let body: ReindexAllBody = {};
  try {
    const raw = await request.json();
    if (raw && typeof raw === 'object') {
      body = raw as ReindexAllBody;
    }
  } catch {
    // fall through with defaults
  }

  const onlyStale = body.onlyStale === true;
  const staleDays = typeof body.staleDays === 'number' && body.staleDays > 0 ? body.staleDays : 7;

  const projects = listRegisteredProjects();

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.reindex-all',
    target: null,
    result: 'initiated',
    meta: { onlyStale, staleDays, total: projects.length },
  });

  const results: PerProjectResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const project of projects) {
    const start = Date.now();

    if (onlyStale && !isStale(project.lastIndexed, staleDays)) {
      skipped++;
      results.push({
        projectId: project.projectId,
        name: project.name,
        path: project.projectPath,
        status: 'skipped',
        elapsedMs: Date.now() - start,
      });
      continue;
    }

    const result = await runCleoCli(['nexus', 'analyze', project.projectPath, '--json']);
    const elapsedMs = Date.now() - start;

    if (result.ok) {
      succeeded++;
      results.push({
        projectId: project.projectId,
        name: project.name,
        path: project.projectPath,
        status: 'success',
        elapsedMs,
      });
    } else {
      failed++;
      const error =
        (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || 'CLI command failed';
      results.push({
        projectId: project.projectId,
        name: project.name,
        path: project.projectPath,
        status: 'failure',
        error,
        elapsedMs,
      });
    }
  }

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.reindex-all',
    target: null,
    result: failed === 0 ? 'success' : 'failure',
    meta: { succeeded, failed, skipped, total: projects.length },
  });

  return json({
    success: failed === 0,
    data: {
      total: projects.length,
      succeeded,
      failed,
      skipped,
      results,
    },
  });
};
