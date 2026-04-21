/**
 * Nexus Bridge Generator
 *
 * Generates .cleo/nexus-bridge.md from nexus.db content. This file is
 * the code intelligence equivalent of memory-bridge.md — it summarizes
 * the codebase graph for agent consumption.
 *
 * Content assembly:
 *   - Index status (file count, node count, relation count, last indexed)
 *   - Symbol counts by kind (functions, classes, methods, etc.)
 *   - Relation counts by type (calls, imports, extends, etc.)
 *   - Top entry points (most outgoing CALLS edges, exported)
 *   - Functional clusters (communities by symbol count)
 *   - Code intelligence command reference
 *
 * Regeneration triggers:
 *   - cleo nexus analyze (called after pipeline flush)
 *   - Manual: cleo nexus refresh-bridge
 *
 * @task T551
 * @epic T549
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveBridgeMode } from '../system/bridge-mode.js';

// ============================================================================
// Types
// ============================================================================

/** Raw row for node kind counts. */
interface NodeKindCountRow {
  kind: string;
  count: number;
}

/** Raw row for relation type counts. */
interface RelationTypeCountRow {
  type: string;
  count: number;
}

/** Raw row for top entry points. */
interface EntryPointRow {
  name: string | null;
  file_path: string | null;
  callees: number;
  is_exported: number;
}

/** Raw row for community/cluster nodes. */
interface CommunityRow {
  id: string;
  label: string;
  meta_json: string | null;
  indexed_at: string;
}

/** Raw row for index metadata. */
interface IndexMetaRow {
  total_nodes: number;
  total_relations: number;
  file_count: number;
  last_indexed_at: string | null;
}

// ============================================================================
// DB helpers
// ============================================================================

/** Type-safe wrapper for DatabaseSync.prepare().all(). */
function typedAll<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Type-safe wrapper for DatabaseSync.prepare().get(). */
function typedGet<T>(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

// ============================================================================
// Query helpers
// ============================================================================

/** Query total node/relation counts and last indexed timestamp. */
function queryIndexMeta(db: DatabaseSync, projectId: string): IndexMetaRow {
  try {
    const nodeMeta = typedGet<{
      total_nodes: number;
      file_count: number;
      last_indexed_at: string | null;
    }>(
      db,
      `SELECT COUNT(*) as total_nodes,
              COUNT(CASE WHEN kind = 'file' THEN 1 END) as file_count,
              MAX(indexed_at) as last_indexed_at
       FROM nexus_nodes
       WHERE project_id = ?`,
      projectId,
    );

    const relMeta = typedGet<{ total_relations: number }>(
      db,
      `SELECT COUNT(*) as total_relations
       FROM nexus_relations
       WHERE project_id = ?`,
      projectId,
    );

    return {
      total_nodes: nodeMeta?.total_nodes ?? 0,
      total_relations: relMeta?.total_relations ?? 0,
      file_count: nodeMeta?.file_count ?? 0,
      last_indexed_at: nodeMeta?.last_indexed_at ?? null,
    };
  } catch {
    return {
      total_nodes: 0,
      total_relations: 0,
      file_count: 0,
      last_indexed_at: null,
    };
  }
}

/** Query node counts grouped by kind. */
function queryNodeKindCounts(db: DatabaseSync, projectId: string): NodeKindCountRow[] {
  try {
    return typedAll<NodeKindCountRow>(
      db,
      `SELECT kind, COUNT(*) as count
       FROM nexus_nodes
       WHERE project_id = ?
         AND kind NOT IN ('file', 'folder', 'community', 'process')
       GROUP BY kind
       ORDER BY count DESC
       LIMIT 10`,
      projectId,
    );
  } catch {
    return [];
  }
}

/** Query relation counts grouped by type. */
function queryRelationTypeCounts(db: DatabaseSync, projectId: string): RelationTypeCountRow[] {
  try {
    return typedAll<RelationTypeCountRow>(
      db,
      `SELECT type, COUNT(*) as count
       FROM nexus_relations
       WHERE project_id = ?
         AND type NOT IN ('member_of', 'step_in_process', 'entry_point_of')
       GROUP BY type
       ORDER BY count DESC
       LIMIT 8`,
      projectId,
    );
  } catch {
    return [];
  }
}

/** Query top entry points by outgoing CALLS edge count. */
function queryTopEntryPoints(db: DatabaseSync, projectId: string, limit = 5): EntryPointRow[] {
  try {
    return typedAll<EntryPointRow>(
      db,
      `SELECT n.name, n.file_path, COUNT(*) as callees, n.is_exported
       FROM nexus_relations r
       JOIN nexus_nodes n ON r.source_id = n.id
       WHERE r.type = 'calls'
         AND r.project_id = ?
         AND n.kind IN ('function', 'method', 'constructor')
       GROUP BY r.source_id
       ORDER BY callees DESC
       LIMIT ?`,
      projectId,
      limit,
    );
  } catch {
    return [];
  }
}

/** Query community nodes ordered by member count. */
function queryCommunities(db: DatabaseSync, projectId: string, limit = 6): CommunityRow[] {
  try {
    return typedAll<CommunityRow>(
      db,
      `SELECT id, label, meta_json, indexed_at
       FROM nexus_nodes
       WHERE project_id = ?
         AND kind = 'community'
       ORDER BY indexed_at DESC
       LIMIT ?`,
      projectId,
      limit,
    );
  } catch {
    return [];
  }
}

/** Query count of execution flow (process) nodes. */
function queryProcessCount(db: DatabaseSync, projectId: string): number {
  try {
    const row = typedGet<{ count: number }>(
      db,
      `SELECT COUNT(*) as count
       FROM nexus_nodes
       WHERE project_id = ?
         AND kind = 'process'`,
      projectId,
    );
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Content generation
// ============================================================================

/**
 * Generate nexus bridge markdown content from nexus.db.
 * Returns the full markdown string (does not write to disk).
 *
 * @param projectId - Project registry ID used to scope nexus.db queries
 * @param repoPath - Absolute path to the repository root (used for display)
 * @returns Markdown string summarizing the code intelligence index
 */
export async function generateNexusBridgeContent(
  projectId: string,
  repoPath: string,
): Promise<string> {
  const { getNexusDb, getNexusNativeDb } = await import('../store/nexus-sqlite.js');

  // Ensure DB is initialized
  await getNexusDb();
  const nativeDb = getNexusNativeDb();

  if (!nativeDb) {
    return buildEmptyBridge(repoPath);
  }

  // Check whether this project has been indexed at all
  const meta = queryIndexMeta(nativeDb, projectId);
  if (meta.total_nodes === 0) {
    return buildEmptyBridge(repoPath);
  }

  const lines: string[] = [
    '# CLEO Nexus Bridge — Code Intelligence',
    '',
    `> Auto-generated from nexus index. Regenerate with \`cleo nexus analyze\`.`,
    `> Project: ${repoPath}`,
    '',
  ];

  // --- Index Status ---
  const kindCounts = queryNodeKindCounts(nativeDb, projectId);
  const relCounts = queryRelationTypeCounts(nativeDb, projectId);
  const processCount = queryProcessCount(nativeDb, projectId);
  const communities = queryCommunities(nativeDb, projectId);

  const symbolBreakdown = kindCounts.map((r) => `${r.kind}s: ${r.count}`).join(', ');

  const callsCount = relCounts.find((r) => r.type === 'calls')?.count ?? 0;
  const importsCount = relCounts.find((r) => r.type === 'imports')?.count ?? 0;
  const extendsCount = relCounts.find((r) => r.type === 'extends')?.count ?? 0;

  const freshnessLabel = meta.last_indexed_at ? meta.last_indexed_at.slice(0, 10) : 'unknown';

  lines.push('## Index Status');
  lines.push('');
  lines.push(`- **Files**: ${meta.file_count.toLocaleString()} indexed`);
  lines.push(
    `- **Symbols**: ${meta.total_nodes.toLocaleString()} total${symbolBreakdown ? ` (${symbolBreakdown})` : ''}`,
  );
  lines.push(
    `- **Relations**: ${meta.total_relations.toLocaleString()} total (calls: ${callsCount.toLocaleString()}, imports: ${importsCount.toLocaleString()}, extends: ${extendsCount.toLocaleString()})`,
  );
  lines.push(`- **Communities**: ${communities.length} functional clusters`);
  lines.push(`- **Execution Flows**: ${processCount} traced processes`);
  lines.push(`- **Last Indexed**: ${meta.last_indexed_at ?? 'never'}`);
  lines.push(`- **Date**: ${freshnessLabel}`);
  lines.push('');

  // --- Top Entry Points ---
  const entryPoints = queryTopEntryPoints(nativeDb, projectId);
  if (entryPoints.length > 0) {
    lines.push('## Top Entry Points');
    lines.push('');
    entryPoints.forEach((ep, i) => {
      const name = ep.name ?? '(unknown)';
      const filePath = ep.file_path ?? '';
      const displayPath = filePath.length > 60 ? `...${filePath.slice(-57)}` : filePath;
      lines.push(`${i + 1}. \`${name}\` — ${displayPath} (${ep.callees} callees)`);
    });
    lines.push('');
  }

  // --- Functional Clusters ---
  if (communities.length > 0) {
    lines.push('## Functional Clusters');
    lines.push('');
    communities.forEach((c, i) => {
      let symbolCount = 0;
      let topFolder = '';
      try {
        if (c.meta_json) {
          const meta = JSON.parse(c.meta_json) as Record<string, unknown>;
          symbolCount = typeof meta['symbolCount'] === 'number' ? meta['symbolCount'] : 0;
          const folders = meta['topFolders'];
          if (Array.isArray(folders) && folders.length > 0) {
            topFolder = String(folders[0]);
          }
        }
      } catch {
        // ignore parse errors
      }
      const symbolsLabel = symbolCount > 0 ? ` (${symbolCount} symbols)` : '';
      const folderLabel = topFolder ? ` — ${topFolder}` : '';
      lines.push(`${i + 1}. **${c.label}**${symbolsLabel}${folderLabel}`);
    });
    lines.push('');
  }

  // --- Code Intelligence Commands ---
  lines.push('## Code Intelligence Commands');
  lines.push('');
  lines.push('| Need | Command |');
  lines.push('|------|---------|');
  lines.push('| What calls this function? | `cleo nexus context <symbol>` |');
  lines.push('| What breaks if I change this? | `cleo nexus impact <symbol>` |');
  lines.push('| What functional areas exist? | `cleo nexus clusters` |');
  lines.push('| What execution flows exist? | `cleo nexus flows` |');
  lines.push('| Re-index after code changes | `cleo nexus analyze` |');
  lines.push('| Index freshness check | `cleo nexus status` |');
  lines.push('');

  return lines.join('\n');
}

/**
 * Write nexus bridge content to .cleo/nexus-bridge.md.
 *
 * When `brain.memoryBridge.mode` is `'cli'` (default), the file write is skipped
 * and the function returns `{ written: false }` without error (T999). This keeps
 * nexus-bridge behaviour aligned with memory-bridge — the two bridges share the
 * same injection-mode gate.
 *
 * Set mode to `'file'` to restore legacy file-based injection behaviour.
 *
 * @param projectRoot - Absolute path to the project root
 * @param projectId - Project registry ID (used to scope nexus.db queries)
 * @returns Result with path and whether the file was written
 */
export async function writeNexusBridge(
  projectRoot: string,
  projectId?: string,
): Promise<{ path: string; written: boolean }> {
  const cleoDir = join(projectRoot, '.cleo');
  const bridgePath = join(cleoDir, 'nexus-bridge.md');

  // Derive project ID from path if not provided (matches nexus analyze convention)
  const resolvedProjectId =
    projectId ?? Buffer.from(projectRoot).toString('base64url').slice(0, 32);

  try {
    // Mode gate (T999 · T1013): skip file write when mode='cli'.
    // Aligns nexus-bridge with the existing memory-bridge gate so both siblings
    // honour the same `brain.memoryBridge.mode` config key.
    const mode = await resolveBridgeMode(projectRoot);
    if (mode === 'cli') {
      return { path: bridgePath, written: false };
    }

    const content = await generateNexusBridgeContent(resolvedProjectId, projectRoot);

    if (!existsSync(cleoDir)) {
      mkdirSync(cleoDir, { recursive: true });
    }

    // Only write if content changed (avoid unnecessary git noise)
    if (existsSync(bridgePath)) {
      const existing = readFileSync(bridgePath, 'utf-8');
      // Compare without the date line since it changes daily
      const stripDate = (s: string) => s.replace(/^> Date: .*/m, '');
      if (stripDate(existing) === stripDate(content)) {
        return { path: bridgePath, written: false };
      }
    }

    writeFileSync(bridgePath, content, 'utf-8');
    return { path: bridgePath, written: true };
  } catch (err) {
    console.error(
      '[CLEO] Failed to write nexus bridge:',
      err instanceof Error ? err.message : String(err),
    );
    return { path: bridgePath, written: false };
  }
}

/**
 * Best-effort nexus bridge refresh. Never throws.
 * Called after cleo nexus analyze completes.
 *
 * @param projectRoot - Absolute path to the project root
 * @param projectId - Project registry ID (used to scope nexus.db queries)
 */
export async function refreshNexusBridge(projectRoot: string, projectId?: string): Promise<void> {
  try {
    await writeNexusBridge(projectRoot, projectId);
  } catch (err) {
    console.error(
      '[CLEO] Nexus bridge refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Build placeholder content when no index data exists. */
function buildEmptyBridge(repoPath: string): string {
  return [
    '# CLEO Nexus Bridge — Code Intelligence',
    '',
    `> Auto-generated from nexus index. Regenerate with \`cleo nexus analyze\`.`,
    `> Project: ${repoPath}`,
    '',
    '## Index Status',
    '',
    'Not indexed. Run `cleo nexus analyze` to build the code intelligence index.',
    '',
    '## Code Intelligence Commands',
    '',
    '| Need | Command |',
    '|------|---------|',
    '| Build the index | `cleo nexus analyze` |',
    '| Check index status | `cleo nexus status` |',
    '| What calls this function? | `cleo nexus context <symbol>` |',
    '| What breaks if I change this? | `cleo nexus impact <symbol>` |',
    '| What functional areas exist? | `cleo nexus clusters` |',
    '| What execution flows exist? | `cleo nexus flows` |',
    '',
  ].join('\n');
}
