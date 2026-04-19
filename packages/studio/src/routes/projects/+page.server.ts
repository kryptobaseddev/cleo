/**
 * Projects page server load — lists all projects registered in the
 * global nexus.db registry, resolves the active context, and primes
 * the audit log panel.
 *
 * @task T990
 * @wave 1E
 */

import { readAuditLog } from '$lib/server/audit-log.js';
import {
  clearActiveProjectId,
  getActiveProjectId,
  listRegisteredProjects,
  setActiveProjectId,
} from '$lib/server/project-context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, locals }) => {
  const activeProjectId = getActiveProjectId(cookies);
  const projects = listRegisteredProjects();
  const auditEntries = readAuditLog(locals.projectCtx.projectPath, 80);

  return {
    projects,
    activeProjectId,
    auditEntries,
    activeProjectName: locals.projectCtx.name,
  };
};

export const actions: Actions = {
  /** Switch to a project by setting the context cookie. */
  switchProject: async ({ request, cookies }) => {
    const data = await request.formData();
    const projectId = data.get('projectId');
    if (typeof projectId === 'string' && projectId) {
      setActiveProjectId(cookies, projectId);
    }
    return { success: true };
  },

  /** Clear the active project context (fall back to default). */
  clearProject: async ({ cookies }) => {
    clearActiveProjectId(cookies);
    return { success: true };
  },
};
