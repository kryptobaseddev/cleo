/**
 * Health check endpoint for the CLEO Studio server.
 *
 * GET /api/health
 *   {
 *     ok, service, version,          // identity
 *     checkedAt, uptime,             // time
 *     databases: {
 *       nexus: { available, rowCount, schemaVersion, path },
 *       brain: { … },
 *       tasks: { … },
 *       conduit: { … },
 *       signaldock: { … },
 *     }
 *   }
 *
 * Version is derived at runtime from `packages/studio/package.json`
 * (T990 audit fix — was hardcoded as `2026.4.47`). Row counts + schema
 * versions are queried on every request; all SQLite calls are guarded
 * with `try/catch` so a corrupted DB cannot crash the endpoint.
 *
 * @task T990
 * @wave 1E
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '@sveltejs/kit';
import {
  getBrainDb,
  getConduitDb,
  getDbStatus,
  getNexusDb,
  getSignaldockDb,
  getTasksDb,
} from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/**
 * Resolve and cache the Studio package version. Reads
 * `packages/studio/package.json` once per process via an eagerly-run
 * IIFE so we never repeat file I/O on every `/api/health` hit.
 *
 * Falls back to `'unknown'` if the file cannot be parsed (e.g. during
 * a broken build). The fallback is explicit rather than silent so an
 * operator can diagnose a wedged deploy.
 */
const pkgVersion: string = (() => {
  try {
    const pkgPath = path.resolve(
      fileURLToPath(new URL('../../../../package.json', import.meta.url)),
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** Cache the process start time so uptime is relative to boot, not request. */
const bootedAt = Date.now();

/**
 * Report structure for a single database probe. `available` is the
 * only always-set field — all others are best-effort and may be null
 * when the DB is missing, locked, or the schema is unknown.
 */
interface DbReport {
  available: boolean;
  rowCount: number | null;
  schemaVersion: string | null;
  path: string;
}

/** Query `SELECT COUNT(*)` for the given table, swallowing schema errors. */
function safeCount(
  db: {
    prepare: (sql: string) => { get: () => unknown };
  },
  table: string,
): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? null;
  } catch {
    return null;
  }
}

/**
 * Attempt to read `PRAGMA user_version` — standard SQLite convention
 * for schema versioning. Returns a string for JSON consistency
 * (SQLite returns int, but some tools prefer `"7"` over `7`).
 */
function safeSchemaVersion(db: {
  prepare: (sql: string) => { get: () => unknown };
}): string | null {
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const value = row?.user_version;
    return typeof value === 'number' ? String(value) : null;
  } catch {
    return null;
  }
}

export const GET: RequestHandler = ({ locals }) => {
  const dbStatus = getDbStatus(locals.projectCtx);

  const nexusReport: DbReport = {
    available: dbStatus.nexus,
    rowCount: null,
    schemaVersion: null,
    path: dbStatus.nexusPath,
  };
  const brainReport: DbReport = {
    available: dbStatus.brain,
    rowCount: null,
    schemaVersion: null,
    path: dbStatus.brainPath,
  };
  const tasksReport: DbReport = {
    available: dbStatus.tasks,
    rowCount: null,
    schemaVersion: null,
    path: dbStatus.tasksPath,
  };
  const conduitReport: DbReport = {
    available: dbStatus.conduit,
    rowCount: null,
    schemaVersion: null,
    path: dbStatus.conduitPath,
  };
  const signaldockReport: DbReport = {
    available: dbStatus.signaldock,
    rowCount: null,
    schemaVersion: null,
    path: dbStatus.signaldockPath,
  };

  if (dbStatus.nexus) {
    const db = getNexusDb();
    if (db) {
      nexusReport.rowCount = safeCount(db, 'nexus_nodes');
      nexusReport.schemaVersion = safeSchemaVersion(db);
    }
  }

  if (dbStatus.brain) {
    const db = getBrainDb(locals.projectCtx);
    if (db) {
      brainReport.rowCount = safeCount(db, 'brain_observations');
      brainReport.schemaVersion = safeSchemaVersion(db);
    }
  }

  if (dbStatus.tasks) {
    const db = getTasksDb(locals.projectCtx);
    if (db) {
      tasksReport.rowCount = safeCount(db, 'tasks');
      tasksReport.schemaVersion = safeSchemaVersion(db);
    }
  }

  if (dbStatus.conduit) {
    const db = getConduitDb(locals.projectCtx);
    if (db) {
      conduitReport.schemaVersion = safeSchemaVersion(db);
    }
  }

  if (dbStatus.signaldock) {
    const db = getSignaldockDb();
    if (db) {
      signaldockReport.schemaVersion = safeSchemaVersion(db);
    }
  }

  return json({
    ok: true,
    service: 'cleo-studio',
    version: pkgVersion,
    checkedAt: new Date().toISOString(),
    uptime: Math.round((Date.now() - bootedAt) / 1000),
    databases: {
      nexus: nexusReport,
      brain: brainReport,
      tasks: tasksReport,
      conduit: conduitReport,
      signaldock: signaldockReport,
    },
  });
};
