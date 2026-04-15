/**
 * POST /api/project/[id]/index
 *
 * Triggers a full nexus index for a project by calling:
 *   `cleo nexus analyze <projectPath> --json`
 *
 * The project path is resolved by looking up the project ID in the
 * listRegisteredProjects() registry. Returns a LAFS envelope on success
 * or a 4xx with structured error envelope on CLI failure.
 *
 * @task T722
 */

import { json } from '@sveltejs/kit';
import { executeCliAction } from '$lib/server/cli-action.js';
import { listRegisteredProjects } from '$lib/server/project-context.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
  const projectId = params.id;

  if (!projectId?.trim()) {
    return json(
      { success: false, error: { code: 'E_MISSING_ID', message: 'Missing project id' } },
      { status: 400 },
    );
  }

  const projects = listRegisteredProjects();
  const project = projects.find((p) => p.projectId === projectId);

  if (!project) {
    return json(
      {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Project ${projectId} not found in registry` },
      },
      { status: 404 },
    );
  }

  return executeCliAction(['nexus', 'analyze', project.projectPath, '--json'], {
    errorCode: 'E_INDEX_FAILED',
    meta: { projectId, projectPath: project.projectPath },
  });
};
