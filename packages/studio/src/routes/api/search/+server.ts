/**
 * Cross-project symbol search API endpoint.
 *
 * GET /api/search?q=<term>&scope=all|current
 *
 * Searches nexus_nodes across all registered projects (scope=all) or
 * just the current/active project (scope=current).
 *
 * Query params:
 *   q      - search term (required, min 2 chars)
 *   scope  - "all" (default) or "current"
 *   limit  - max results per project (default 20, max 100)
 *
 * Returns a LAFS-compliant JSON envelope.
 *
 * @task T622
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { json } from '@sveltejs/kit';
import { getCleoHome } from '$lib/server/cleo-home.js';
import { getActiveProjectId, listRegisteredProjects } from '$lib/server/project-context.js';
import type { RequestHandler } from './$types';

const _require = createRequire(import.meta.url);
type _DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSync;
};

interface SymbolHit {
  projectId: string;
  projectName: string;
  nodeId: string;
  name: string;
  kind: string;
  filePath: string | null;
  startLine: number | null;
  language: string | null;
  docSummary: string | null;
  isExported: boolean;
}

export const GET: RequestHandler = ({ url, cookies }) => {
  const startTime = Date.now();
  const q = url.searchParams.get('q') ?? '';
  const scope = url.searchParams.get('scope') ?? 'all';
  const limitParam = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(1, limitParam), 100);

  if (q.length < 2) {
    return json(
      {
        success: false,
        error: { code: 'E_INVALID_INPUT', message: 'q must be at least 2 characters' },
        meta: {
          operation: 'api.search',
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 400 },
    );
  }

  try {
    const nexusPath = join(getCleoHome(), 'nexus.db');
    if (!existsSync(nexusPath)) {
      return json({
        success: true,
        data: { query: q, scope, results: [], totalHits: 0 },
        meta: {
          operation: 'api.search',
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Determine which project IDs to search
    let projectFilter: string[] | null = null;
    if (scope === 'current') {
      const activeId = getActiveProjectId(cookies);
      if (activeId) {
        projectFilter = [activeId];
      }
    }

    const allProjects = listRegisteredProjects();
    const projectNameById = new Map(allProjects.map((p) => [p.projectId, p.name]));

    const db = new DatabaseSync(nexusPath, { open: true });
    const hits: SymbolHit[] = [];

    try {
      const term = `%${q.toLowerCase()}%`;

      if (projectFilter) {
        // Scoped to specific project(s)
        for (const projectId of projectFilter) {
          const rows = db
            .prepare(
              `SELECT id, project_id, name, kind, file_path, start_line, language, doc_summary, is_exported
               FROM nexus_nodes
               WHERE project_id = ?
                 AND lower(name) LIKE ?
                 AND kind NOT IN ('community', 'process', 'file', 'folder')
               ORDER BY
                 CASE kind
                   WHEN 'function' THEN 0 WHEN 'method' THEN 1 WHEN 'class' THEN 2
                   WHEN 'interface' THEN 3 WHEN 'type_alias' THEN 4 ELSE 5
                 END, name
               LIMIT ?`,
            )
            .all(projectId, term, limit) as Array<{
            id: string;
            project_id: string;
            name: string | null;
            kind: string;
            file_path: string | null;
            start_line: number | null;
            language: string | null;
            doc_summary: string | null;
            is_exported: number;
          }>;

          for (const row of rows) {
            if (!row.name) continue;
            hits.push({
              projectId: row.project_id,
              projectName: projectNameById.get(row.project_id) ?? row.project_id,
              nodeId: row.id,
              name: row.name,
              kind: row.kind,
              filePath: row.file_path ?? null,
              startLine: row.start_line ?? null,
              language: row.language ?? null,
              docSummary: row.doc_summary ?? null,
              isExported: row.is_exported === 1,
            });
          }
        }
      } else {
        // Search all projects
        const rows = db
          .prepare(
            `SELECT id, project_id, name, kind, file_path, start_line, language, doc_summary, is_exported
             FROM nexus_nodes
             WHERE lower(name) LIKE ?
               AND kind NOT IN ('community', 'process', 'file', 'folder')
             ORDER BY
               CASE kind
                 WHEN 'function' THEN 0 WHEN 'method' THEN 1 WHEN 'class' THEN 2
                 WHEN 'interface' THEN 3 WHEN 'type_alias' THEN 4 ELSE 5
               END, name
             LIMIT ?`,
          )
          .all(term, limit * Math.max(allProjects.length, 1)) as Array<{
          id: string;
          project_id: string;
          name: string | null;
          kind: string;
          file_path: string | null;
          start_line: number | null;
          language: string | null;
          doc_summary: string | null;
          is_exported: number;
        }>;

        for (const row of rows) {
          if (!row.name) continue;
          hits.push({
            projectId: row.project_id,
            projectName: projectNameById.get(row.project_id) ?? row.project_id,
            nodeId: row.id,
            name: row.name,
            kind: row.kind,
            filePath: row.file_path ?? null,
            startLine: row.start_line ?? null,
            language: row.language ?? null,
            docSummary: row.doc_summary ?? null,
            isExported: row.is_exported === 1,
          });
        }
      }
    } finally {
      db.close();
    }

    return json({
      success: true,
      data: {
        query: q,
        scope,
        results: hits,
        totalHits: hits.length,
      },
      meta: {
        operation: 'api.search',
        duration_ms: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(
      {
        success: false,
        error: { code: 'E_SEARCH_FAILED', message: msg },
        meta: {
          operation: 'api.search',
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 500 },
    );
  }
};
