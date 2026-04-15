/**
 * DELETE /api/project/[id]
 *
 * Removes a project from the global nexus.db registry by calling:
 *   `cleo nexus projects remove <id> --json`
 *
 * Returns a LAFS envelope on success or a 4xx with structured error envelope on CLI failure.
 *
 * @task T722
 */

import { json } from '@sveltejs/kit';
import { executeCliAction } from '$lib/server/cli-action.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
  const projectId = params.id;

  if (!projectId?.trim()) {
    return json(
      { success: false, error: { code: 'E_MISSING_ID', message: 'Missing project id' } },
      { status: 400 },
    );
  }

  return executeCliAction(['nexus', 'projects', 'remove', projectId, '--json'], {
    errorCode: 'E_DELETE_FAILED',
    meta: { projectId },
  });
};
