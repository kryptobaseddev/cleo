// @ts-nocheck
/**
 * Projects page server load — lists all projects registered in the
 * global nexus.db registry and resolves the active project context.
 *
 * @task T622
 */

import {
  clearActiveProjectId,
  getActiveProjectId,
  listRegisteredProjects,
  setActiveProjectId,
} from '$lib/server/project-context.js';
import type { Actions, PageServerLoad } from './$types';

export const load = ({ cookies }: Parameters<PageServerLoad>[0]) => {
  const activeProjectId = getActiveProjectId(cookies);
  const projects = listRegisteredProjects();

  return {
    projects,
    activeProjectId,
  };
};

export const actions = {
  /** Switch to a project by setting the context cookie. */
  switchProject: async ({ request, cookies }: import('./$types').RequestEvent) => {
    const data = await request.formData();
    const projectId = data.get('projectId');
    if (typeof projectId === 'string' && projectId) {
      setActiveProjectId(cookies, projectId);
    }
    return { success: true };
  },

  /** Clear the active project context (fall back to default). */
  clearProject: async ({ cookies }: import('./$types').RequestEvent) => {
    clearActiveProjectId(cookies);
    return { success: true };
  },
};
;null as any as Actions;