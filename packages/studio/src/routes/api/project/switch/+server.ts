/**
 * POST /api/project/switch
 *
 * Accepts `{ projectId: string }` as JSON, sets the active project cookie,
 * and returns `{ success: true }`.  Used by the header ProjectSelector
 * component for client-side project switching without a full page form POST.
 *
 * @task T646
 */

import { error, json } from '@sveltejs/kit';
import { setActiveProjectId } from '$lib/server/project-context.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).projectId !== 'string'
  ) {
    throw error(400, 'Missing or invalid projectId');
  }

  const projectId = (body as Record<string, unknown>).projectId as string;
  if (!projectId.trim()) {
    throw error(400, 'projectId must not be empty');
  }

  setActiveProjectId(cookies, projectId);
  return json({ success: true });
};
