/**
 * Root layout server load — supplies active project context and full project
 * list to every page in CLEO Studio so the header ProjectSelector has data
 * without requiring a per-page load function.
 *
 * @task T646
 */

import { getActiveProjectId, listRegisteredProjects } from '$lib/server/project-context.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ cookies }) => {
  const activeProjectId = getActiveProjectId(cookies);
  const projects = listRegisteredProjects();

  return {
    projects,
    activeProjectId,
  };
};
