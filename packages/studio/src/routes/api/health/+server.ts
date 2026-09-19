/**
 * Studio health reports observed read-only store probes, not complete runtime
 * realm coverage. Project graph and global registry are assessed separately.
 * @packageDocumentation
 */
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeCoverageStatus } from '@cleocode/contracts';
import type { DualScope } from '@cleocode/core/store/dual-scope-db';
import { json } from '@sveltejs/kit';
import { getNexusDbPath, getTasksDbPath } from '$lib/server/cleo-home.js';
import { withStudioReadSnapshot } from '$lib/server/db/connections.js';
import { version as pkgVersion } from '../../../../package.json';
import type { RequestHandler } from './$types';

/** Process-local boot time; other worker realms are not observed here. */
const bootedAt = Date.now();

/** Existing database report extended with explicit probe scope and failures. */
interface DbReport {
  available: boolean;
  rowCount: number | null;
  schemaVersion: string | null;
  path: string;
  scope: DualScope;
  projectId: string | null;
  table: string;
  coverage: KnowledgeCoverageStatus;
  errors: string[];
  lifecycle: 'owned-read-only-snapshot';
  observedPragmas: Record<string, string | number | null>;
}

/** Read an observed pragma without substituting defaults for missing results. */
function readPragma(db: DatabaseSync, pragma: string): string | number | null {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma] ?? (row ? Object.values(row)[0] : null);
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** Probe a known schema table; identifiers are fixed by the route, never request input. */
function probe(path: string, scope: DualScope, projectId: string | null, table: string): DbReport {
  const report: DbReport = {
    available: existsSync(path),
    rowCount: null,
    schemaVersion: null,
    path,
    scope,
    projectId,
    table,
    coverage: 'missing',
    errors: [],
    lifecycle: 'owned-read-only-snapshot',
    observedPragmas: {},
  };
  try {
    const observed = withStudioReadSnapshot(path, (db) => {
      for (const pragma of ['journal_mode', 'foreign_keys', 'busy_timeout', 'query_only']) {
        report.observedPragmas[pragma] = readPragma(db, pragma);
      }
      const version = readPragma(db, 'user_version');
      report.schemaVersion = version === null ? null : String(version);
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM main.${table}`).get();
      if (typeof row?.cnt !== 'number') throw new Error(`Invalid count result for ${table}`);
      return row.cnt;
    });
    if (observed === null) {
      report.available = false;
      report.errors.push('Database file is absent; no count was assessed.');
    } else {
      report.rowCount = observed;
      report.coverage = 'current';
    }
  } catch (error) {
    report.coverage = 'failed';
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}

/**
 * Probe selected project/global stores through bounded owned snapshot lifetimes.
 * @param event - Request carrying the selected project context.
 * @returns JSON diagnostics with store identity, observed counts and explicit coverage limits.
 * @remarks `ok` describes only the listed store probes. Coverage remains partial
 * because live core/worker handles are not inventoried by this endpoint.
 * @example
 * ```ts
 * const response = await fetch('/api/health');
 * const health = await response.json();
 * ```
 */
export const GET: RequestHandler = ({ locals }) => {
  const context = locals.projectCtx;
  const projectPath = getTasksDbPath(context.projectPath);
  const globalPath = getNexusDbPath();
  const projectId = context.projectId || null;
  const databases = {
    nexus: probe(projectPath, 'project', projectId, 'nexus_nodes'),
    'project-registry': probe(globalPath, 'global', null, 'nexus_project_registry'),
    brain: probe(projectPath, 'project', projectId, 'brain_observations'),
    tasks: probe(projectPath, 'project', projectId, 'tasks_tasks'),
    conduit: probe(projectPath, 'project', projectId, 'conduit_messages'),
    'agent-registry': probe(globalPath, 'global', null, 'agent_registry_agents'),
  };
  const reports = Object.values(databases);
  return json({
    ok: reports.every((report) => report.coverage === 'current'),
    okScope: 'listed-store-probes-only',
    service: 'cleo-studio',
    version: pkgVersion,
    checkedAt: new Date().toISOString(),
    uptime: Math.round((Date.now() - bootedAt) / 1000),
    projectId,
    coverage: {
      status: reports.some((report) => report.coverage === 'failed') ? 'failed' : 'partial',
      observedRealms: ['studio-main'],
      unobservedRealms: ['core-main', 'core-workers'],
      limitations: [
        'Only independent read-only file snapshots are assessed; live runtime handles are not inventoried.',
        'A successful count does not establish graph freshness, caller completeness, authority or full runtime health.',
        ...(projectId === null
          ? ['Selected project has no persisted identity in its context.']
          : []),
      ],
    },
    databases,
  });
};
