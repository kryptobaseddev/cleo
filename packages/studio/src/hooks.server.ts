/**
 * SvelteKit server hooks for CLEO Studio.
 *
 * Reads the active project cookie on every request and resolves
 * the corresponding ProjectContext, making it available via
 * `event.locals.projectCtx` for all page loads and API endpoints.
 *
 * Falls back to the default project context (CLEO_ROOT / cwd) when
 * no project cookie is set or the project ID is invalid.
 */

import type { Handle } from '@sveltejs/kit';
import {
  getActiveProjectId,
  resolveDefaultProjectContext,
  resolveProjectContext,
} from '$lib/server/project-context.js';

export const handle: Handle = async ({ event, resolve }) => {
  const activeId = getActiveProjectId(event.cookies);
  const ctx = (activeId && resolveProjectContext(activeId)) || resolveDefaultProjectContext();
  event.locals.projectCtx = ctx;
  return resolve(event);
};
