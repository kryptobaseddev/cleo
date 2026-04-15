/**
 * DELETE /api/project/[id]
 *
 * Removes a project from the global nexus.db registry by calling:
 *   `cleo nexus projects remove <id> --json`
 *
 * Returns a LAFS envelope on success or a 502 with reason on CLI failure.
 *
 * @task T657
 */

import { json } from '@sveltejs/kit';
import { runCleoCli } from '$lib/server/spawn-cli.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
  const projectId = params.id;

  if (!projectId?.trim()) {
    return json({ success: false, error: { message: 'Missing project id' } }, { status: 400 });
  }

  const result = await runCleoCli(['nexus', 'projects', 'remove', projectId, '--json']);

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
