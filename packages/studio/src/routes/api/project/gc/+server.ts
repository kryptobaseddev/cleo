/**
 * POST /api/project/gc
 *
 * Runs `cleo nexus gc --json` to garbage-collect orphan rows / dead
 * edges in the nexus symbol graph. Always defaults to `--dry-run` unless
 * the caller explicitly sends `{ dryRun: false }`.
 *
 * @task T990
 * @wave 1E
 */

import { recordAudit } from '$lib/server/audit-log.js';
import { executeCliAction } from '$lib/server/cli-action.js';
import type { RequestHandler } from './$types';

interface GcBody {
  dryRun?: boolean;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  let body: GcBody = {};
  try {
    const raw = await request.json();
    if (raw && typeof raw === 'object') {
      body = raw as GcBody;
    }
  } catch {
    // empty body is fine
  }

  const dryRun = body.dryRun !== false;
  const args: string[] = ['nexus', 'gc', '--json'];
  if (dryRun) {
    args.push('--dry-run');
  } else {
    args.push('--yes');
  }

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.gc',
    target: locals.projectCtx.projectId || locals.projectCtx.projectPath,
    result: dryRun ? 'dry-run' : 'initiated',
  });

  const response = await executeCliAction(args, {
    errorCode: 'E_GC_FAILED',
    meta: { dryRun },
  });

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.gc',
    target: locals.projectCtx.projectId || locals.projectCtx.projectPath,
    result: response.status === 200 ? 'success' : 'failure',
    detail: dryRun ? 'dry-run' : 'live',
  });

  return response;
};
