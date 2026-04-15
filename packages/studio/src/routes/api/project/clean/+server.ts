/**
 * POST /api/project/clean
 *
 * Calls `cleo nexus projects clean --json` with optional flags derived from the
 * request body. Always performs a dry-run unless `dryRun: false` is explicitly
 * passed in the body — this prevents accidental data loss.
 *
 * Request body (all optional):
 *   {
 *     includeTemp?: boolean;       — include .temp paths (--include-temp)
 *     includeTests?: boolean;      — include test/tmp/fixture/scratch/sandbox paths (--include-tests)
 *     includeUnhealthy?: boolean;  — include unhealthy projects (--unhealthy)
 *     includeNeverIndexed?: boolean; — include never-indexed projects (--never-indexed)
 *     pattern?: string;            — regex filter (--pattern <regex>)
 *     dryRun?: boolean;            — defaults to true; pass false for real purge
 *   }
 *
 * Returns a LAFS envelope or a 502 with reason on CLI failure.
 *
 * @task T657
 */

import { json } from '@sveltejs/kit';
import { runCleoCli } from '$lib/server/spawn-cli.js';
import type { RequestHandler } from './$types';

/** Validated and normalised body for /api/project/clean. */
interface CleanBody {
  includeTemp?: boolean;
  includeTests?: boolean;
  includeUnhealthy?: boolean;
  includeNeverIndexed?: boolean;
  pattern?: string;
  dryRun?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: CleanBody = {};

  try {
    const raw = await request.json();
    if (typeof raw === 'object' && raw !== null) {
      body = raw as CleanBody;
    }
  } catch {
    // No body or non-JSON body is acceptable; use defaults
  }

  // Safety default: ALWAYS dry-run unless explicitly opted out
  const dryRun = body.dryRun !== false;

  const args: string[] = ['nexus', 'projects', 'clean', '--json'];

  if (dryRun) {
    args.push('--dry-run');
  } else {
    // Real purge requires --yes to skip interactive confirmation
    args.push('--yes');
  }

  if (body.includeTemp) args.push('--include-temp');
  if (body.includeTests) args.push('--include-tests');
  if (body.includeUnhealthy) args.push('--unhealthy');
  if (body.includeNeverIndexed) args.push('--never-indexed');
  if (typeof body.pattern === 'string' && body.pattern.trim()) {
    args.push('--pattern', body.pattern.trim());
  }

  const result = await runCleoCli(args);

  if (!result.ok) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'CLI command failed';
    return json(
      {
        success: false,
        error: { message: reason, code: 'CLI_FAILURE' },
        meta: { exitCode: result.exitCode, dryRun },
      },
      { status: 502 },
    );
  }

  return json(result.envelope ?? { success: true, data: { dryRun } });
};
