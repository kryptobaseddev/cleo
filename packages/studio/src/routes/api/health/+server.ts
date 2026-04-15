/**
 * Health check endpoint for the CLEO Studio server.
 * GET /api/health → { ok: true, version: string, databases: {...} }
 */

import { json } from '@sveltejs/kit';
import { getDbStatus } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  const dbStatus = getDbStatus();
  return json({
    ok: true,
    service: 'cleo-studio',
    version: '2026.4.47',
    databases: {
      nexus: dbStatus.nexus ? 'available' : 'not found',
      brain: dbStatus.brain ? 'available' : 'not found',
      tasks: dbStatus.tasks ? 'available' : 'not found',
    },
    paths: {
      nexus: dbStatus.nexusPath,
      brain: dbStatus.brainPath,
      tasks: dbStatus.tasksPath,
    },
  });
};
