/**
 * SvelteKit server hooks for CLEO Studio.
 *
 * Responsibilities:
 *   1. Resolve the active project context from the cookie and attach it
 *      to `event.locals.projectCtx` for every page + API load.
 *   2. Refresh the CSRF token cookie on every request so mutation
 *      modals always have one to echo back (see
 *      `$lib/server/csrf.ts`).
 *   3. Enforce a same-origin guard on every mutating admin endpoint
 *      (`/api/project/**` POST/DELETE). Studio binds to loopback in
 *      production — the guard is belt-and-braces in case it is ever
 *      bound to a LAN address.
 *
 * @task T990
 * @wave 1E
 */

import { type Handle, json } from '@sveltejs/kit';
import { isSameOriginRequest, refreshCsrfToken } from '$lib/server/csrf.js';
import {
  getActiveProjectId,
  resolveDefaultProjectContext,
  resolveProjectContext,
} from '$lib/server/project-context.js';

/** Paths whose mutation verbs must pass the same-origin guard. */
const GUARDED_PATH_PREFIX = '/api/project';

/** HTTP verbs treated as state-changing by the guard. */
const GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const handle: Handle = async ({ event, resolve }) => {
  // --- project context resolution --------------------------------------
  const activeId = getActiveProjectId(event.cookies);
  const ctx = (activeId && resolveProjectContext(activeId)) || resolveDefaultProjectContext();
  event.locals.projectCtx = ctx;

  // --- CSRF cookie refresh ---------------------------------------------
  refreshCsrfToken(event.cookies);

  // --- same-origin guard for admin mutations ---------------------------
  if (
    event.url.pathname.startsWith(GUARDED_PATH_PREFIX) &&
    GUARDED_METHODS.has(event.request.method.toUpperCase())
  ) {
    if (!isSameOriginRequest(event.request)) {
      return json(
        {
          success: false,
          error: {
            code: 'E_CROSS_ORIGIN',
            message: 'Admin mutations require a same-origin request.',
          },
        },
        { status: 403 },
      );
    }
  }

  return resolve(event);
};
