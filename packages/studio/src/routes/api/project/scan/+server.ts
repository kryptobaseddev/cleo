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
 * Returns a LAFS envelope or a 502 with reason on CLI failure.
 *
 * @task T657
 */

import { json } from '@sveltejs/kit';
import { runCleoCli } from '$lib/server/spawn-cli.js';
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

  const result = await runCleoCli(args);

  if (!result.ok) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'CLI command failed';
    return json(
      {
        success: false,
        error: { message: reason, code: 'CLI_FAILURE' },
        meta: { exitCode: result.exitCode },
      },
      { status: 502 },
    );
  }

  return json(result.envelope ?? { success: true });
};
