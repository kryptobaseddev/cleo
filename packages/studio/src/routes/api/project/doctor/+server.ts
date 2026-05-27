/**
 * POST /api/project/doctor
 *
 * Runs `cleo nexus doctor --json` for the active project context and
 * optionally a specific project id (query string `?id=` or body
 * `{ projectId }`). Returns the raw diagnostics envelope from the CLI.
 *
 * The endpoint is read-only from a data perspective (it does not
 * mutate rows), but we treat it as a POST because it is a long-running
 * shell-out that the operator intentionally triggers. Same-origin guard
 * still applies via `hooks.server.ts`.
 *
 * @task T990
 * @wave 1E
 */

import { recordAudit } from '$lib/server/audit-log.js';
import { executeCliAction } from '$lib/server/cli-action.js';
import type { RequestHandler } from './$types';

interface DoctorBody {
  projectId?: string;
  path?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  let body: DoctorBody = {};
  try {
    const raw = await request.json();
    if (raw && typeof raw === 'object') {
      body = raw as DoctorBody;
    }
  } catch {
    // empty body is fine — fall back to active project context
  }

  const args: string[] = ['nexus', 'doctor', '--json'];
  if (typeof body.projectId === 'string' && body.projectId.trim()) {
    args.push('--project', body.projectId.trim());
  } else if (typeof body.path === 'string' && body.path.trim()) {
    args.push('--path', body.path.trim());
  }

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.doctor',
    target: body.projectId ?? body.path ?? locals.projectCtx.projectId ?? null,
    result: 'initiated',
  });

  const response = await executeCliAction(args, {
    errorCode: 'E_DOCTOR_FAILED',
    meta: { projectId: body.projectId, path: body.path },
  });

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.doctor',
    target: body.projectId ?? body.path ?? locals.projectCtx.projectId ?? null,
    result: response.status === 200 ? 'success' : 'failure',
  });

  return response;
};
