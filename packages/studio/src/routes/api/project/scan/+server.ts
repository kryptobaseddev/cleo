/**
 * POST /api/project/scan
 *
 * Calls `cleo nexus projects scan --json` with optional flags derived from the
 * request body. This is a global operation — it scans the filesystem for
 * projects and optionally registers them.
 *
 * Request body (all optional):
 *   {
 *     roots?: string;     — comma-separated root paths to scan (--roots <paths>)
 *     maxDepth?: number;  — max directory depth (--max-depth <n>)
 *     autoRegister?: boolean; — auto-register discovered projects (--auto-register)
 *   }
 *
 * Returns a LAFS envelope or a 4xx with structured error envelope on CLI failure.
 *
 * @task T722
 */

import { executeCliAction } from '$lib/server/cli-action.js';
import type { RequestHandler } from './$types';

/** Validated and normalised body for /api/project/scan. */
interface ScanBody {
  roots?: string;
  maxDepth?: number;
  autoRegister?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: ScanBody = {};

  try {
    const raw = await request.json();
    if (typeof raw === 'object' && raw !== null) {
      body = raw as ScanBody;
    }
  } catch {
    // No body or non-JSON body is acceptable; use defaults
  }

  const args: string[] = ['nexus', 'projects', 'scan', '--json'];

  if (typeof body.roots === 'string' && body.roots.trim()) {
    args.push('--roots', body.roots.trim());
  }

  if (typeof body.maxDepth === 'number' && body.maxDepth > 0) {
    args.push('--max-depth', String(Math.floor(body.maxDepth)));
  }

  if (body.autoRegister) {
    args.push('--auto-register');
  }

  return executeCliAction(args, {
    errorCode: 'E_SCAN_FAILED',
    meta: { roots: body.roots, maxDepth: body.maxDepth, autoRegister: body.autoRegister },
  });
};
