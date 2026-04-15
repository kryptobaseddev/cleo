/**
 * POST /api/project/[id]/reindex
 *
 * Re-indexes a project by calling the same `cleo nexus analyze <projectPath> --json`
 * command as the index endpoint. "analyze" handles both initial index and re-index.
 *
 * The project path is resolved by looking up the project ID in the
 * listRegisteredProjects() registry. Returns a LAFS envelope on success
 * or a 502 with reason on CLI failure.
 *
 * @task T657
 */

import { json } from '@sveltejs/kit';
import { listRegisteredProjects } from '$lib/server/project-context.js';
import { runCleoCli } from '$lib/server/spawn-cli.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
  const projectId = params.id;

  if (!projectId?.trim()) {
    return json({ success: false, error: { message: 'Missing project id' } }, { status: 400 });
  }

  const projects = listRegisteredProjects();
  const project = projects.find((p) => p.projectId === projectId);

  if (!project) {
    return json(
      { success: false, error: { message: `Project ${projectId} not found in registry` } },
      { status: 404 },
    );
  }

  const result = await runCleoCli(['nexus', 'analyze', project.projectPath, '--json']);

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
