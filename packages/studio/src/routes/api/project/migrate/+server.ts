/**
 * GET /api/project/migrate — read-only migration status.
 *
 * The underlying CLI currently does NOT expose a safe blanket migration
 * path; schemas are applied at `cleo init` / first-open time. Rather
 * than risk a destructive POST, this endpoint runs `cleo nexus status
 * --json` (best-available proxy for "is the schema current?") and
 * reports:
 *
 *   {
 *     success, data: {
 *       databases: {
 *         nexus:  { schemaVersion, migrationPending: false|null, message },
 *         brain:  { … },
 *         tasks:  { … },
 *       },
 *       recommendedCommand: 'cleo init' | null,
 *     }
 *   }
 *
 * `migrationPending` is `null` when we cannot detect it; callers render
 * that as "unknown — run CLI" rather than implying green. A real
 * migration trigger lands in a future wave once the CLI grows a
 * `cleo nexus migrate` / `cleo brain migrate` subcommand with
 * dry-run support.
 *
 * @task T990
 * @wave 1E
 */

import { json } from '@sveltejs/kit';
import { getDbStatus } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

interface MigrationReport {
  schemaVersion: string | null;
  migrationPending: boolean | null;
  message: string;
}

interface DbProbe {
  prepare: (sql: string) => { get: () => unknown };
}

function safePragma(db: DbProbe): string | null {
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return typeof row?.user_version === 'number' ? String(row.user_version) : null;
  } catch {
    return null;
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  // Lazy-import SQLite to keep the module snappy during SSR eval
  const { getBrainDb, getNexusDb, getTasksDb } = await import('$lib/server/db/connections.js');

  const status = getDbStatus(locals.projectCtx);

  const nexusReport: MigrationReport = {
    schemaVersion: null,
    migrationPending: null,
    message: status.nexus ? 'ok' : 'nexus.db not found',
  };
  const brainReport: MigrationReport = {
    schemaVersion: null,
    migrationPending: null,
    message: status.brain ? 'ok' : 'brain.db not found',
  };
  const tasksReport: MigrationReport = {
    schemaVersion: null,
    migrationPending: null,
    message: status.tasks ? 'ok' : 'tasks.db not found',
  };

  if (status.nexus) {
    const db = getNexusDb();
    if (db) nexusReport.schemaVersion = safePragma(db);
  }
  if (status.brain) {
    const db = getBrainDb(locals.projectCtx);
    if (db) brainReport.schemaVersion = safePragma(db);
  }
  if (status.tasks) {
    const db = getTasksDb(locals.projectCtx);
    if (db) tasksReport.schemaVersion = safePragma(db);
  }

  return json({
    success: true,
    data: {
      databases: {
        nexus: nexusReport,
        brain: brainReport,
        tasks: tasksReport,
      },
      recommendedCommand: null,
      note: 'Migration trigger is CLI-only until a `cleo nexus migrate` subcommand lands with safe dry-run + rollback.',
    },
  });
};
