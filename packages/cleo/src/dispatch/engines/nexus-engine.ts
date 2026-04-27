/**
 * Nexus Engine — Thin wrapper layer for nexus domain operations.
 *
 * Delegates all business logic to src/core/nexus/ and src/core/snapshot/.
 * Each function catches errors and wraps them into EngineResult.
 *
 * Sub-domains:
 *   Registry   - init, register, unregister, sync, reconcile, list, show, status
 *   Query      - resolve, deps, graph, path, blockers, orphans
 *   Discovery  - discover related tasks, search across projects
 *   Sharing    - status, snapshot export/import
 *
 * @task T5704
 * @epic T5701
 */

import {
  augmentSymbol,
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  nexusDiscoverRelated as discoverRelated,
  executeTransfer,
  exportSnapshot,
  exportUserProfile,
  formatAugmentResults,
  getBrainNativeDb,
  getDefaultSnapshotPath,
  getNexusDb,
  getNexusNativeDb,
  getSharingStatus,
  getUserProfileTrait,
  importSnapshot,
  importUserProfile,
  listSigils,
  listUserProfile,
  type NexusPermissionLevel,
  nexusDeps,
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  orphanDetection,
  paginate,
  previewTransfer,
  nexusReadRegistry as readRegistry,
  readSnapshot,
  reinforceTrait,
  resolveTask,
  type SigilSyncResult,
  searchAcrossProjects,
  setPermission,
  supersedeTrait,
  syncCanonicalSigils,
  type TransferParams,
  type TransferResult,
  upsertUserProfileTrait,
  validateSyntax,
  writeSnapshot,
} from '@cleocode/core/internal';
import { cleoErrorToEngineError, type EngineResult, engineError, engineSuccess } from './_error.js';

// Re-export EngineResult for consumers
export type { EngineResult };

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

/**
 * Get nexus status (initialized, project count, last updated).
 */
export async function nexusStatus(): Promise<
  EngineResult<{
    initialized: boolean;
    projectCount: number;
    lastUpdated: string | null;
  }>
> {
  try {
    const registry = await readRegistry();
    const initialized = registry !== null;
    const projectCount = initialized ? Object.keys(registry.projects).length : 0;
    return engineSuccess({
      initialized,
      projectCount,
      lastUpdated: registry?.lastUpdated ?? null,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List all registered projects.
 */
export async function nexusListProjects(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    projects: Awaited<ReturnType<typeof nexusList>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const projects = await nexusList('', {});
    const page = paginate(projects, limit, offset);
    return {
      success: true,
      data: {
        projects: page.items as Awaited<ReturnType<typeof nexusList>>,
        count: projects.length,
        total: projects.length,
        filtered: projects.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show a single project by name.
 */
export async function nexusShowProject(
  name: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusGetProject>>>> {
  try {
    const project = await nexusGetProject('', { name });
    if (!project) {
      return engineError('E_NOT_FOUND', `Project not found: ${name}`);
    }
    return engineSuccess(project);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolve a cross-project task query.
 */
export async function nexusResolve(
  query: string,
  currentProject?: string,
): Promise<EngineResult<Awaited<ReturnType<typeof resolveTask>>>> {
  try {
    if (!validateSyntax(query)) {
      return engineError(
        'E_INVALID_INPUT',
        `Invalid query syntax: ${query}. Expected: T001, project:T001, .:T001, or *:T001`,
      );
    }
    const result = await resolveTask('', { query, currentProject });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get cross-project dependencies for a task query.
 */
export async function nexusDepsQuery(
  query: string,
  direction: 'forward' | 'reverse' = 'forward',
): Promise<EngineResult<Awaited<ReturnType<typeof nexusDeps>>>> {
  try {
    const result = await nexusDeps('', { query, direction });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Build the global dependency graph.
 */
export async function nexusGraph(): Promise<
  EngineResult<Awaited<ReturnType<typeof buildGlobalGraph>>>
> {
  try {
    const graph = await buildGlobalGraph('', {});
    return engineSuccess(graph);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get the critical path across projects.
 */
export async function nexusCriticalPath(): Promise<
  EngineResult<Awaited<ReturnType<typeof criticalPath>>>
> {
  try {
    const path = await criticalPath('', {});
    return engineSuccess(path);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Analyze impact of changing a symbol.
 *
 * Runs BFS from the target symbol to find all symbols that would be affected
 * by changes to it, optionally with detailed reasons (caller count, edge strength, depth).
 *
 * @task T1013
 */
export async function nexusImpact(
  symbol: string,
  projectId?: string,
  why?: boolean,
): Promise<
  EngineResult<{
    targetNodeId: string | null;
    why: boolean;
    affected: Array<{ nodeId: string; label: string; kind: string; reasons: string[] }>;
    riskLevel: string;
  }>
> {
  try {
    await getNexusDb();
    const db = getNexusNativeDb();

    if (!db) {
      return engineSuccess({
        targetNodeId: null,
        why: why ?? false,
        affected: [],
        riskLevel: 'NONE',
      });
    }

    // Get all nodes for the project
    const allNodes = db
      .prepare(
        `SELECT id, label, kind, file_path, name, project_id
           FROM nexus_nodes
          WHERE project_id = ?
            AND kind NOT IN ('community','process','file','folder')`,
      )
      .all(projectId || '') as Array<{
      id: string;
      label: string | null;
      kind: string | null;
      file_path: string | null;
      name: string | null;
      project_id: string;
    }>;

    const lowerSymbol = symbol.toLowerCase();
    const candidates = allNodes.filter((n) => {
      const haystack = (n.name ?? n.label ?? '').toLowerCase();
      return haystack.length > 0 && haystack.includes(lowerSymbol);
    });

    // Prefer exact matches, then shortest labels
    candidates.sort((a, b) => {
      const an = (a.name ?? a.label ?? '').toLowerCase();
      const bn = (b.name ?? b.label ?? '').toLowerCase();
      const exactA = an === lowerSymbol ? 0 : 1;
      const exactB = bn === lowerSymbol ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;
      return an.length - bn.length;
    });

    const target = candidates[0];
    if (!target) {
      return engineSuccess({
        targetNodeId: null,
        why: why ?? false,
        affected: [],
        riskLevel: 'NONE',
      });
    }

    // Get all relations
    const allRelations = db
      .prepare(
        `SELECT source_id, target_id, type, weight
           FROM nexus_relations
          WHERE project_id = ?
            AND type IN ('calls','imports','accesses')`,
      )
      .all(projectId || '') as Array<{
      source_id: string;
      target_id: string;
      type: string;
      weight: number | null;
    }>;

    // Build reverse adjacency map (targetId -> list of sources)
    const reverseAdj = new Map<string, typeof allRelations>();
    for (const rel of allRelations) {
      const list = reverseAdj.get(rel.target_id);
      if (list) {
        list.push(rel);
      } else {
        reverseAdj.set(rel.target_id, [rel]);
      }
    }

    // Incoming count for reason generation
    const incomingCount = new Map<string, number>();
    for (const rel of allRelations) {
      incomingCount.set(rel.target_id, (incomingCount.get(rel.target_id) ?? 0) + 1);
    }

    // Node lookup
    const nodeById = new Map<string, (typeof allNodes)[0]>();
    for (const n of allNodes) {
      nodeById.set(n.id, n);
    }

    // BFS from target
    const visited = new Set<string>([target.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];
    const affected: Array<{ nodeId: string; label: string; kind: string; reasons: string[] }> = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (item.depth >= 3) continue; // maxDepth = 3

      const callers = reverseAdj.get(item.id) ?? [];
      for (const edge of callers) {
        if (visited.has(edge.source_id)) continue;
        visited.add(edge.source_id);
        const depth = item.depth + 1;
        const callerNode = nodeById.get(edge.source_id);
        const reasons: string[] = [];

        if (why) {
          const calls = incomingCount.get(edge.source_id) ?? 0;
          if (calls > 0) {
            reasons.push(`called by ${calls} place${calls === 1 ? '' : 's'}`);
          }
          if (edge.weight != null && edge.weight > 0) {
            reasons.push(`strength=${edge.weight.toFixed(3)} via ${edge.type}`);
          } else {
            reasons.push(`edge type ${edge.type} (weight=0 — no plasticity yet)`);
          }
          reasons.push(`depth=${depth} hop from target ${target.label ?? target.id}`);
        }

        affected.push({
          nodeId: edge.source_id,
          label: callerNode?.label ?? edge.source_id,
          kind: callerNode?.kind ?? 'unknown',
          reasons,
        });

        queue.push({ id: edge.source_id, depth });
      }
    }

    // Determine risk level
    let riskLevel = 'NONE';
    if (affected.length > 0) {
      if (affected.length > 10) {
        riskLevel = 'CRITICAL';
      } else if (affected.length > 5) {
        riskLevel = 'HIGH';
      } else if (affected.length > 2) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }
    }

    return engineSuccess({
      targetNodeId: target.id,
      why: why ?? false,
      affected,
      riskLevel,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Query highest-weight symbols/nodes from nexus plasticity or brain page nodes.
 *
 * Prioritizes brain.db page_nodes (quality_score) over nexus_relations (aggregate weight).
 * Supports optional --kind (nexus) or --nodeType (brain) filter.
 * Returns graceful empty result with note when neither DB is available.
 *
 * @task T1006
 * @task T1013
 */
export async function nexusTopEntries(params?: {
  limit?: number;
  kind?: string;
  nodeType?: string;
}): Promise<
  EngineResult<{
    entries: unknown[];
    count: number;
    limit: number;
    kind?: string | null;
    nodeType?: string | null;
    note?: string;
  }>
> {
  try {
    const limit =
      typeof params?.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 20;

    // Brain.db path takes priority: query brain_page_nodes by quality_score.
    const brainDb = getBrainNativeDb();
    if (brainDb !== null && brainDb !== undefined) {
      try {
        const nodeType = params?.nodeType ? String(params.nodeType) : null;
        const sql =
          nodeType === null
            ? `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
                 FROM brain_page_nodes
                ORDER BY quality_score DESC
                LIMIT ?`
            : `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
                 FROM brain_page_nodes
                WHERE node_type = ?
                ORDER BY quality_score DESC
                LIMIT ?`;
        const bindArgs: (string | number)[] = nodeType === null ? [limit] : [nodeType, limit];
        const rows = brainDb.prepare(sql).all(...bindArgs) as Array<{
          id: string;
          node_type: string | null;
          label: string | null;
          quality_score: number | null;
          last_activity_at: string | null;
          metadata_json: string | null;
        }>;

        const entries = rows.map((r) => ({
          id: r.id,
          node_type: r.node_type ?? 'unknown',
          label: r.label ?? r.id,
          quality_score: r.quality_score ?? 0,
          last_activity_at: r.last_activity_at ?? '',
          metadata_json: r.metadata_json ?? null,
        }));

        return engineSuccess({
          entries,
          count: entries.length,
          limit,
          nodeType,
        });
      } catch {
        // brain_page_nodes table not yet created — fall through to nexus
      }
    }

    // Nexus.db fallback: check if a nexus.db connection is already open.
    // We intentionally do NOT call getNexusDb() here — that would create a new
    // DB even when the caller has not initialised the registry, masking the
    // "unavailable" state that tests expect.
    const nexusDb = getNexusNativeDb();

    if (!nexusDb) {
      // Both DBs unavailable → return graceful empty result with a note
      return engineSuccess({
        entries: [],
        count: 0,
        limit,
        kind: params?.kind ? String(params.kind) : null,
        note: 'Neither brain.db nor nexus.db is available. Run "cleo nexus init" to initialize.',
      });
    }

    try {
      const kind = params?.kind ? String(params.kind) : null;
      const sql =
        kind === null
          ? `SELECT r.source_id,
                    SUM(COALESCE(r.weight, 0)) AS totalWeight,
                    COUNT(*)                   AS edgeCount,
                    n.label,
                    n.kind,
                    n.file_path
               FROM nexus_relations r
               LEFT JOIN nexus_nodes n ON n.id = r.source_id
              GROUP BY r.source_id
              ORDER BY totalWeight DESC, edgeCount DESC
              LIMIT ?`
          : `SELECT r.source_id,
                    SUM(COALESCE(r.weight, 0)) AS totalWeight,
                    COUNT(*)                   AS edgeCount,
                    n.label,
                    n.kind,
                    n.file_path
               FROM nexus_relations r
               LEFT JOIN nexus_nodes n ON n.id = r.source_id
              WHERE n.kind = ?
              GROUP BY r.source_id
              ORDER BY totalWeight DESC, edgeCount DESC
              LIMIT ?`;
      const bindArgs: (string | number)[] = kind === null ? [limit] : [kind, limit];
      const rows = nexusDb.prepare(sql).all(...bindArgs) as Array<{
        source_id: string;
        totalWeight: number;
        edgeCount: number;
        label: string | null;
        kind: string | null;
        file_path: string | null;
      }>;

      const entries = rows.map((r) => ({
        nodeId: r.source_id,
        label: r.label ?? r.source_id,
        kind: r.kind ?? 'unknown',
        filePath: r.file_path ?? null,
        totalWeight: r.totalWeight,
        edgeCount: r.edgeCount,
      }));

      const result: {
        entries: unknown[];
        count: number;
        limit: number;
        kind?: string | null;
        note?: string;
      } = {
        entries,
        count: entries.length,
        limit,
        kind,
      };

      if (entries.length === 0) {
        result.note =
          'No high-impact sources detected yet. Code plasticity will accumulate as the system indexes and analyzes dependencies.';
      }

      return engineSuccess(result);
    } catch {
      // nexus_relations / nexus_nodes tables not present — treat as empty.
      return engineSuccess({
        entries: [],
        count: 0,
        limit,
        kind: params?.kind ? String(params.kind) : null,
        note: 'Nexus registry not yet initialized. Run "cleo nexus init" to start.',
      });
    }
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Analyze blockers for a task query.
 */
export async function nexusBlockers(
  query: string,
): Promise<EngineResult<Awaited<ReturnType<typeof blockingAnalysis>>>> {
  try {
    const analysis = await blockingAnalysis('', { query });
    return engineSuccess(analysis);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List orphaned cross-project tasks.
 */
export async function nexusOrphans(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    orphans: Awaited<ReturnType<typeof orphanDetection>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const orphans = await orphanDetection('', {});
    const page = paginate(orphans, limit, offset);
    return {
      success: true,
      data: {
        orphans: page.items as Awaited<ReturnType<typeof orphanDetection>>,
        count: orphans.length,
        total: orphans.length,
        filtered: orphans.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Discovery & Search
// ---------------------------------------------------------------------------

/**
 * Discover tasks related to a given task query across projects.
 */
/**
 * Discover tasks related to a given task query across projects.
 * Delegates all business logic to src/core/nexus/discover.ts.
 */
export async function nexusDiscover(
  taskQuery: string,
  method: string = 'auto',
  limit: number = 10,
): Promise<
  EngineResult<{
    query: string;
    method: string;
    results: Array<{
      project: string;
      taskId: string;
      title: string;
      score: number;
      type: string;
      reason: string;
    }>;
    total: number;
  }>
> {
  try {
    const result = await discoverRelated('', { query: taskQuery, method, limit });
    if ('error' in result) {
      return engineError(result.error.code as 'E_INVALID_INPUT', result.error.message);
    }
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Search for tasks across all registered projects.
 */
/**
 * Search for tasks across all registered projects.
 * Delegates all business logic to src/core/nexus/discover.ts.
 */
export async function nexusSearch(
  pattern: string,
  projectFilter?: string,
  limit: number = 20,
): Promise<
  EngineResult<{
    pattern: string;
    results: Array<{
      id: string;
      title: string;
      status: string;
      priority?: string;
      description?: string;
      _project: string;
    }>;
    resultCount: number;
  }>
> {
  try {
    const result = await searchAcrossProjects('', { pattern, project: projectFilter, limit });
    if ('error' in result) {
      return engineError(
        result.error.code as 'E_INVALID_INPUT' | 'E_NOT_FOUND',
        result.error.message,
      );
    }
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Registry mutation operations
// ---------------------------------------------------------------------------

/**
 * Initialize the nexus.
 */
export async function nexusInitialize(): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusInit('', {});
    return engineSuccess({ message: 'NEXUS initialized successfully' });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Register a project in the nexus.
 */
export async function nexusRegisterProject(
  path: string,
  name?: string,
  permission: NexusPermissionLevel = 'read',
): Promise<EngineResult<{ hash: string; message: string }>> {
  try {
    const hash = await nexusRegister('', { path, name, permission });
    return engineSuccess({ hash, message: `Project registered with hash: ${hash}` });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Unregister a project from the nexus.
 */
export async function nexusUnregisterProject(
  name: string,
): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusUnregister('', { name });
    return engineSuccess({ message: `Project unregistered: ${name}` });
  } catch (error) {
    return cleoErrorToEngineError(error, 'E_INTERNAL', `Failed to unregister project: ${name}`);
  }
}

/**
 * Sync a specific project or all projects.
 */
export async function nexusSyncProject(name?: string): Promise<EngineResult<unknown>> {
  try {
    if (name) {
      await nexusSync('', { name });
      return engineSuccess({ message: `Project synced: ${name}` });
    }
    const result = await nexusSyncAll();
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Set permission level for a project.
 */
export async function nexusSetPermission(
  name: string,
  level: NexusPermissionLevel,
): Promise<EngineResult<{ message: string }>> {
  try {
    await setPermission('', { name, level });
    return engineSuccess({ message: `Permission for '${name}' set to '${level}'` });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reconcile the nexus registry with the filesystem.
 */
export async function nexusReconcileProject(
  projectRoot: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusReconcile>>>> {
  try {
    const result = await nexusReconcile(projectRoot, {});
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Sharing operations
// ---------------------------------------------------------------------------

/**
 * Get sharing status for a project.
 */
export async function nexusShareStatus(
  projectRoot: string,
): Promise<EngineResult<Awaited<ReturnType<typeof getSharingStatus>>>> {
  try {
    const result = await getSharingStatus(projectRoot, {});
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Export a snapshot of the project's tasks.
 */
export async function nexusShareSnapshotExport(
  projectRoot: string,
  outputPath?: string,
): Promise<
  EngineResult<{
    path: string;
    taskCount: number;
    checksum: string;
  }>
> {
  try {
    const snapshot = await exportSnapshot(projectRoot);
    const resolvedPath = outputPath ?? getDefaultSnapshotPath(projectRoot);
    await writeSnapshot(snapshot, resolvedPath);
    return engineSuccess({
      path: resolvedPath,
      taskCount: snapshot._meta.taskCount,
      checksum: snapshot._meta.checksum,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Import a snapshot into the project.
 */
export async function nexusShareSnapshotImport(
  projectRoot: string,
  inputPath: string,
): Promise<EngineResult<Awaited<ReturnType<typeof importSnapshot>>>> {
  try {
    const snapshot = await readSnapshot(inputPath);
    const result = await importSnapshot(snapshot, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Transfer operations
// ---------------------------------------------------------------------------

/**
 * Preview a cross-project task transfer (dry run).
 */
export async function nexusTransferPreview(
  params: TransferParams,
): Promise<EngineResult<TransferResult>> {
  try {
    const result = await previewTransfer(params);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Execute a cross-project task transfer.
 */
export async function nexusTransferExecute(
  params: TransferParams,
): Promise<EngineResult<TransferResult>> {
  try {
    const result = await executeTransfer(params);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Hook augmentation
// ---------------------------------------------------------------------------

/**
 * Augment a symbol pattern with code context for PreToolUse hook injection.
 *
 * Searches nexus_nodes by label/path using LIKE (BM25 search via FTS5 TBD).
 * Returns top 5 callable symbols with callers/callees/community metadata.
 * Gracefully no-ops (empty results) if nexus.db is absent or stale.
 *
 * Used by: packages/core/src/nexus/hooks-augment.ts
 *
 * @task T1061
 * @epic T1042
 */
export async function nexusAugment(
  pattern: string,
  limit?: number,
): Promise<
  EngineResult<{
    pattern: string;
    results: Array<{
      id: string;
      label: string;
      kind: string;
      filePath?: string;
      startLine?: number;
      endLine?: number;
      callersCount: number;
      calleesCount: number;
      communityId?: number;
      communitySize?: number;
    }>;
    text: string;
  }>
> {
  try {
    const results = augmentSymbol(pattern, limit ?? 5);
    const text = formatAugmentResults(results);
    return engineSuccess({
      pattern,
      results,
      text,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// T1115 — Living Brain primitives (5 verbs)
// ---------------------------------------------------------------------------

/**
 * Full cross-substrate context for a code symbol.
 *
 * Calls {@link getSymbolFullContext} from the Living Brain SDK.
 *
 * @param symbolId - Symbol name or nexus node ID.
 * @param projectRoot - Absolute project root path.
 * @task T1115
 */
export async function nexusFullContext(
  symbolId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').SymbolFullContext>> {
  try {
    const { getSymbolFullContext } = await import('@cleocode/core/nexus/living-brain.js' as string);
    const result = await getSymbolFullContext(symbolId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Full code impact for a task: files, symbols, blast radius, brain observations, decisions.
 *
 * Calls {@link getTaskCodeImpact} from the Living Brain SDK.
 *
 * @param taskId - Task ID (e.g., 'T001').
 * @param projectRoot - Absolute project root path.
 * @task T1115
 */
export async function nexusTaskFootprint(
  taskId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').TaskCodeImpact>> {
  try {
    const { getTaskCodeImpact } = await import('@cleocode/core/nexus/living-brain.js' as string);
    const result = await getTaskCodeImpact(taskId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Code anchors for a brain memory entry: linked nexus nodes, tasks, plasticity signal.
 *
 * Calls {@link getBrainEntryCodeAnchors} from the Living Brain SDK.
 *
 * @param entryId - Brain entry node ID (e.g., 'observation:abc123').
 * @param projectRoot - Absolute project root path.
 * @task T1115
 */
export async function nexusBrainAnchors(
  entryId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').CodeAnchorResult>> {
  try {
    const { getBrainEntryCodeAnchors } = await import(
      '@cleocode/core/nexus/living-brain.js' as string
    );
    const result = await getBrainEntryCodeAnchors(entryId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Causal trace: why is a code symbol structured this way?
 *
 * Calls {@link reasonWhySymbol} from the brain-reasoning SDK.
 *
 * @param symbolId - Symbol name or nexus node ID.
 * @param projectRoot - Absolute project root path.
 * @task T1115
 */
export async function nexusWhy(
  symbolId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').CodeReasonTrace>> {
  try {
    const { reasonWhySymbol } = await import('@cleocode/core/memory/brain-reasoning.js' as string);
    const result = await (
      reasonWhySymbol as (
        s: string,
        p: string,
      ) => Promise<import('@cleocode/contracts').CodeReasonTrace>
    )(symbolId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Full merged structural + task + brain impact report for a code symbol.
 *
 * Calls {@link reasonImpactOfChange} from the Living Brain SDK.
 *
 * @param symbolId - Symbol name or nexus node ID.
 * @param projectRoot - Absolute project root path.
 * @task T1115
 */
export async function nexusImpactFull(
  symbolId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').ImpactFullReport>> {
  try {
    const { reasonImpactOfChange } = await import('@cleocode/core/nexus/living-brain.js' as string);
    const result = await (
      reasonImpactOfChange as (
        s: string,
        p: string,
      ) => Promise<import('@cleocode/contracts').ImpactFullReport>
    )(symbolId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// T1116 — Code Intelligence CLI surface (4 verbs)
// ---------------------------------------------------------------------------

/**
 * Route map for a project: all routes with their handlers and dependencies.
 *
 * Calls {@link getRouteMap} from the route-analysis SDK.
 *
 * @param projectId - Project identifier (auto-derived from path if omitted).
 * @param projectRoot - Absolute project root path.
 * @task T1116
 */
export async function nexusRouteMap(
  projectId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').RouteMapResult>> {
  try {
    const { getRouteMap } = await import('@cleocode/core/nexus/route-analysis.js' as string);
    const result = await (
      getRouteMap as (
        id: string,
        root: string,
      ) => Promise<import('@cleocode/contracts').RouteMapResult>
    )(projectId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Shape compatibility check for a route handler vs. its callers.
 *
 * Calls {@link shapeCheck} from the route-analysis SDK.
 *
 * @param routeSymbol - Route symbol ID (format: `<filePath>::<routeName>`).
 * @param projectId - Project identifier.
 * @param projectRoot - Absolute project root path.
 * @task T1116
 */
export async function nexusShapeCheck(
  routeSymbol: string,
  projectId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').ShapeCheckResult>> {
  try {
    const { shapeCheck } = await import('@cleocode/core/nexus/route-analysis.js' as string);
    const result = await (
      shapeCheck as (
        sym: string,
        id: string,
        root: string,
      ) => Promise<import('@cleocode/contracts').ShapeCheckResult>
    )(routeSymbol, projectId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * BM25 code symbol search against the nexus augment index.
 *
 * Delegates to {@link nexusAugment} — `search-code` is a thin alias that
 * exposes the augment BM25 index as a named dispatch operation.
 *
 * @param pattern - Search query (symbol name, file pattern, or keyword).
 * @param limit - Maximum results (default 10).
 * @task T1116
 */
export async function nexusSearchCode(
  pattern: string,
  limit: number,
): Promise<EngineResult<unknown>> {
  return nexusAugment(pattern, limit);
}

/**
 * Generate (or read) the community-grouped wiki index from the nexus code graph.
 *
 * Calls {@link generateNexusWikiIndex} from the wiki-index SDK.
 *
 * @param outputDir - Directory to write wiki files (default: `.cleo/wiki`).
 * @param projectRoot - Absolute project root path.
 * @param options - Optional generation flags (communityFilter, incremental, loomProvider).
 * @task T1116
 */
export async function nexusWiki(
  outputDir: string,
  projectRoot: string,
  options?: {
    communityFilter?: string;
    incremental?: boolean;
  },
): Promise<EngineResult<import('@cleocode/contracts').NexusWikiResult>> {
  try {
    const { generateNexusWikiIndex } = await import('@cleocode/core/nexus/wiki-index.js' as string);
    const result = await (
      generateNexusWikiIndex as (
        outDir: string,
        cwd: string,
        opts?: {
          communityFilter?: string;
          incremental?: boolean;
          loomProvider?: null;
          projectRoot?: string;
        },
      ) => Promise<import('@cleocode/contracts').NexusWikiResult>
    )(outputDir, projectRoot, {
      communityFilter: options?.communityFilter,
      incremental: options?.incremental ?? false,
      loomProvider: null,
      projectRoot,
    });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// T1117 — Contracts + ingestion bridge verbs
// ---------------------------------------------------------------------------

/**
 * Extract HTTP, gRPC, and topic contracts from a project and store them in nexus.db.
 *
 * Delegates to the three extractors in @cleocode/core/nexus/api-extractors/.
 *
 * @param projectId - Project identifier (base64url of repoPath by default).
 * @param repoPath - Absolute path to the project root.
 * @task T1117
 */
export async function nexusContractsSync(
  projectId: string,
  repoPath: string,
): Promise<
  EngineResult<{
    projectId: string;
    repoPath: string;
    http: number;
    grpc: number;
    topic: number;
    totalCount: number;
  }>
> {
  try {
    const [{ extractHttpContracts }, { extractGrpcContracts }, { extractTopicContracts }] =
      await Promise.all([
        import('@cleocode/core/nexus/api-extractors/http-extractor.js' as string),
        import('@cleocode/core/nexus/api-extractors/grpc-extractor.js' as string),
        import('@cleocode/core/nexus/api-extractors/topic-extractor.js' as string),
      ]);

    const [httpContracts, grpcContracts, topicContracts] = await Promise.all([
      (extractHttpContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectId,
        repoPath,
      ),
      (extractGrpcContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectId,
        repoPath,
      ),
      (extractTopicContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectId,
        repoPath,
      ),
    ]);

    const http = httpContracts?.length ?? 0;
    const grpc = grpcContracts?.length ?? 0;
    const topic = topicContracts?.length ?? 0;
    return engineSuccess({
      projectId,
      repoPath,
      http,
      grpc,
      topic,
      totalCount: http + grpc + topic,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show contract compatibility matrix between two registered projects.
 *
 * Calls the contract matcher from @cleocode/core/nexus/api-extractors/matcher.
 *
 * @param projectAId - First project identifier.
 * @param projectBId - Second project identifier.
 * @param projectRoot - Absolute project root path.
 * @task T1117
 */
export async function nexusContractsShow(
  projectAId: string,
  projectBId: string,
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/contracts').ContractCompatibilityMatrix>> {
  try {
    const { extractHttpContracts, extractGrpcContracts, extractTopicContracts, matchContracts } =
      await import('@cleocode/core/nexus/api-extractors/index.js' as string);

    const repoPathA = Buffer.from(projectAId, 'base64url').toString() || projectRoot;
    const repoPathB = Buffer.from(projectBId, 'base64url').toString() || projectRoot;

    const [httpA, grpcA, topicA, httpB, grpcB, topicB] = await Promise.all([
      (extractHttpContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectAId,
        repoPathA,
      ),
      (extractGrpcContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectAId,
        repoPathA,
      ),
      (extractTopicContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectAId,
        repoPathA,
      ),
      (extractHttpContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectBId,
        repoPathB,
      ),
      (extractGrpcContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectBId,
        repoPathB,
      ),
      (extractTopicContracts as (id: string, root: string) => Promise<unknown[]>)(
        projectBId,
        repoPathB,
      ),
    ]);

    const contractsA = [...(httpA ?? []), ...(grpcA ?? []), ...(topicA ?? [])];
    const contractsB = [...(httpB ?? []), ...(grpcB ?? []), ...(topicB ?? [])];
    const matches = (
      matchContracts as (
        a: unknown[],
        b: unknown[],
      ) => import('@cleocode/contracts').ContractMatch[]
    )(contractsA, contractsB);

    const compatibleCount = matches.filter((m) => m.compatibility === 'compatible').length;
    const incompatibleCount = matches.filter((m) => m.compatibility === 'incompatible').length;
    const partialCount = matches.filter((m) => m.compatibility === 'partial').length;
    const overallCompatibility =
      matches.length > 0 ? Math.round((compatibleCount / matches.length) * 100) : 0;

    const matrix: import('@cleocode/contracts').ContractCompatibilityMatrix = {
      projectAId,
      projectBId,
      matches,
      compatibleCount,
      incompatibleCount,
      partialCount,
      overallCompatibility,
      recommendations: [],
    };
    return engineSuccess(matrix);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Link extracted contracts to tasks via task_touches_symbol edges.
 *
 * Calls {@link runGitLogTaskLinker} from the tasks-bridge.
 *
 * @param projectId - Project identifier.
 * @param repoPath - Absolute path to the project root.
 * @task T1117
 */
export async function nexusContractsLinkTasks(
  projectId: string,
  repoPath: string,
): Promise<EngineResult<unknown>> {
  try {
    const { runGitLogTaskLinker } = await import('@cleocode/core/nexus/tasks-bridge.js' as string);
    const result = await (runGitLogTaskLinker as (id: string, root: string) => Promise<unknown>)(
      projectId,
      repoPath,
    );
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Scan conduit messages for symbol mentions and write conduit_mentions_symbol edges.
 *
 * Calls {@link linkConduitMessagesToSymbols} from the graph-memory-bridge.
 * Gracefully no-ops when conduit.db or nexus.db is absent.
 *
 * @param projectRoot - Absolute project root path.
 * @task T1117
 */
export async function nexusConduitScan(
  projectRoot: string,
): Promise<EngineResult<{ scanned: number; linked: number }>> {
  try {
    const { linkConduitMessagesToSymbols } = await import(
      '@cleocode/core/memory/graph-memory-bridge.js' as string
    );
    const result = await (
      linkConduitMessagesToSymbols as (root: string) => Promise<{ scanned: number; linked: number }>
    )(projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show code symbols touched by a task via task_touches_symbol forward-lookup.
 *
 * Calls {@link getSymbolsForTask} from the tasks-bridge.
 *
 * @param taskId - Task ID (e.g., `T001`).
 * @param projectRoot - Absolute project root path.
 * @task T1117
 */
export async function nexusTaskSymbols(
  taskId: string,
  projectRoot: string,
): Promise<
  EngineResult<{
    taskId: string;
    count: number;
    symbols: import('@cleocode/contracts').SymbolReference[];
  }>
> {
  try {
    const { getSymbolsForTask } = await import('@cleocode/core/nexus/tasks-bridge.js' as string);
    const symbols = await (
      getSymbolsForTask as (
        id: string,
        root: string,
      ) => Promise<import('@cleocode/contracts').SymbolReference[]>
    )(taskId, projectRoot);
    return engineSuccess({ taskId, count: symbols.length, symbols });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// T1080 — User-profile CLI verbs (profile.view, profile.get, profile.import,
//          profile.export, profile.reinforce, profile.upsert, profile.supersede)
// ---------------------------------------------------------------------------

import type {
  NexusProfileExportResult,
  NexusProfileGetResult,
  NexusProfileImportResult,
  NexusProfileReinforceResult,
  NexusProfileSupersedeResult,
  NexusProfileUpsertResult,
  NexusProfileViewResult,
  UserProfileTrait,
} from '@cleocode/contracts';

/**
 * List all user-profile traits, optionally filtered by minimum confidence.
 *
 * @param minConfidence - Minimum confidence threshold (0.0–1.0).  Default 0.0.
 * @param includeSuperseded - Include superseded traits.  Default false.
 * @task T1080
 */
export async function nexusProfileView(
  minConfidence?: number,
  includeSuperseded?: boolean,
): Promise<EngineResult<NexusProfileViewResult>> {
  try {
    const nexusDb = await getNexusDb();
    const traits = await listUserProfile(nexusDb, { minConfidence, includeSuperseded });
    return engineSuccess({ traits, count: traits.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Fetch a single user-profile trait by key.
 *
 * @param traitKey - Trait key to look up (required).
 * @task T1080
 */
export async function nexusProfileGet(
  traitKey: string,
): Promise<EngineResult<NexusProfileGetResult>> {
  try {
    const nexusDb = await getNexusDb();
    const trait = await getUserProfileTrait(nexusDb, traitKey);
    return engineSuccess({ trait });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Import user-profile traits from a portable JSON file.
 *
 * @param path - Absolute path to the JSON file.  Defaults to
 *               `~/.cleo/user_profile.json`.
 * @task T1080
 */
export async function nexusProfileImport(
  path?: string,
): Promise<EngineResult<NexusProfileImportResult>> {
  try {
    const result = await importUserProfile(path);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Export user-profile traits to a portable JSON file.
 *
 * @param path - Absolute output path.  Defaults to `~/.cleo/user_profile.json`.
 * @task T1080
 */
export async function nexusProfileExport(
  path?: string,
): Promise<EngineResult<NexusProfileExportResult>> {
  try {
    const result = await exportUserProfile(path);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reinforce an existing user-profile trait (increment count + boost confidence).
 *
 * @param traitKey - Key of the trait to reinforce.
 * @param source   - Source for this reinforcement.  Defaults to "manual".
 * @task T1080
 */
export async function nexusProfileReinforce(
  traitKey: string,
  source?: string,
): Promise<EngineResult<NexusProfileReinforceResult>> {
  try {
    const nexusDb = await getNexusDb();
    await reinforceTrait(nexusDb, traitKey, source ?? 'manual');
    const updated = await getUserProfileTrait(nexusDb, traitKey);
    if (!updated) {
      return engineError('E_NOT_FOUND', `Trait not found: ${traitKey}`);
    }
    return engineSuccess({
      reinforcementCount: updated.reinforcementCount,
      confidence: updated.confidence,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Create or update a user-profile trait.
 *
 * Accepts the wire-format `Pick<UserProfileTrait, ...>` from the dispatch
 * surface (`NexusProfileUpsertParams.trait`) and fills in engine-managed
 * fields (`firstObservedAt`, `lastReinforcedAt`, `reinforcementCount`,
 * `supersededBy`) with safe defaults. The persistence layer
 * (`upsertUserProfileTrait`) preserves the original `firstObservedAt` for
 * existing rows, so callers SHOULD not override it.
 *
 * @param trait - Wire-format trait (required) — only user-supplied fields.
 * @task T1080
 * @task T1434 — accept Pick subset to match `NexusProfileUpsertParams.trait`
 */
export async function nexusProfileUpsert(
  trait: Pick<
    UserProfileTrait,
    'traitKey' | 'traitValue' | 'confidence' | 'source' | 'derivedFromMessageId'
  >,
): Promise<EngineResult<NexusProfileUpsertResult>> {
  try {
    const nexusDb = await getNexusDb();
    const existing = await getUserProfileTrait(nexusDb, trait.traitKey);
    const now = new Date().toISOString();
    const fullTrait: UserProfileTrait = {
      ...trait,
      firstObservedAt: existing?.firstObservedAt ?? now,
      lastReinforcedAt: now,
      reinforcementCount: existing ? existing.reinforcementCount + 1 : 1,
      supersededBy: existing?.supersededBy ?? null,
    };
    await upsertUserProfileTrait(nexusDb, fullTrait);
    return engineSuccess({ created: existing === null });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Mark a trait as superseded by another.
 *
 * @param oldKey - Trait key being deprecated.
 * @param newKey - Trait key that replaces it.
 * @task T1080
 */
export async function nexusProfileSupersede(
  oldKey: string,
  newKey: string,
): Promise<EngineResult<NexusProfileSupersedeResult>> {
  try {
    const nexusDb = await getNexusDb();
    await supersedeTrait(nexusDb, oldKey, newKey);
    return engineSuccess({ oldKey, newKey });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Sigil operations (T1148 Wave 8 + T1386 sync)
// ---------------------------------------------------------------------------

import type { NexusSigilListResult } from '@cleocode/contracts';

/**
 * List every sigil currently stored in nexus.db, optionally filtered by role.
 *
 * @param role - Optional role filter (e.g. "orchestrator", "lead", "worker",
 *               "specialist", "subagent").
 * @task T1386
 */
export async function nexusSigilList(role?: string): Promise<EngineResult<NexusSigilListResult>> {
  try {
    const nexusDb = await getNexusDb();
    const sigils = await listSigils(nexusDb, role ? { role } : undefined);
    return engineSuccess({ sigils, count: sigils.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Populate the sigils table with one row per canonical CANT agent shipped
 * with `@cleocode/agents`.  Idempotent — repeated runs upsert the same rows.
 *
 * @task T1386
 */
export async function nexusSigilSync(): Promise<EngineResult<SigilSyncResult>> {
  try {
    const result = await syncCanonicalSigils();
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
