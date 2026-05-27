/**
 * NEXUS index diff — compare relation/node counts between two git commits.
 *
 * Runs an incremental pipeline re-analysis against the current working tree
 * state and compares relation/node counts against the pre-analysis snapshot.
 * Reports new relations, removed relations, and regression classification.
 *
 * @task T1473
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';

/** Health classification for a diff result. */
export type NexusDiffHealth =
  | 'STABLE'
  | 'RELATIONS_ADDED'
  | 'RELATIONS_REDUCED'
  | 'REGRESSIONS_DETECTED';

/** Options for {@link diffNexusIndex}. */
export interface NexusDiffOptions {
  /** Git ref for the "before" snapshot (default: 'HEAD~1'). */
  beforeRef?: string;
  /** Git ref for the "after" snapshot (default: 'HEAD'). */
  afterRef?: string;
  /** Override the project ID (default: derived from repoPath). */
  projectIdOverride?: string;
}

/** Result envelope for {@link diffNexusIndex}. */
export interface NexusDiffResult {
  /** Resolved "before" ref. */
  beforeRef: string;
  /** Resolved "after" ref. */
  afterRef: string;
  /** Short SHA for beforeRef. */
  beforeSha: string;
  /** Short SHA for afterRef. */
  afterSha: string;
  /** Project ID. */
  projectId: string;
  /** Absolute repository path. */
  repoPath: string;
  /** Changed files detected between the refs. */
  changedFiles: string[];
  /** Node count before the incremental run. */
  nodesBefore: number;
  /** Node count after. */
  nodesAfter: number;
  /** New nodes added. */
  newNodes: number;
  /** Nodes removed. */
  removedNodes: number;
  /** Relation count before. */
  relationsBefore: number;
  /** Relation count after. */
  relationsAfter: number;
  /** New relations added. */
  newRelations: number;
  /** Relations removed. */
  removedRelations: number;
  /** Health classification. */
  healthStatus: NexusDiffHealth;
  /** Regression messages (empty if none). */
  regressions: string[];
}

/**
 * Diff the NEXUS index between two git commits.
 *
 * Snapshots current node/relation counts, runs an incremental pipeline for
 * the changed files, then re-counts to compute deltas. Regressions are
 * flagged when more than 5 relations are removed or any nodes are removed.
 *
 * @param repoPath - Absolute path to the repository.
 * @param opts     - Optional before/after git refs and project ID override.
 * @returns Diff result with health classification.
 *
 * @example
 * const result = await diffNexusIndex('/home/user/myproject');
 * console.log(result.healthStatus, result.regressions);
 */
export async function diffNexusIndex(
  repoPath: string,
  opts: NexusDiffOptions = {},
): Promise<NexusDiffResult> {
  const projectId =
    opts.projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
  const { execFile: execFileNode } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileNode);

  const beforeRef = opts.beforeRef ?? 'HEAD~1';
  const afterRef = opts.afterRef ?? 'HEAD';

  const resolveSha = async (ref: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', ref], {
        timeout: 5_000,
        cwd: repoPath,
      });
      return stdout.trim();
    } catch {
      return ref;
    }
  };

  const [beforeSha, afterSha] = await Promise.all([resolveSha(beforeRef), resolveSha(afterRef)]);

  let changedFiles: string[] = [];
  try {
    const { stdout: diffOutput } = await execFileAsync(
      'git',
      ['diff', '--name-only', beforeSha, afterSha],
      { timeout: 10_000, cwd: repoPath },
    );
    changedFiles = diffOutput
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.rs')));
  } catch {
    // git diff failed — proceed with full status comparison
  }

  const { getNexusDb, nexusSchema } = await import('@cleocode/core/store/nexus-sqlite' as string);
  const db = await getNexusDb();

  let relationsBefore = 0;
  let nodesBefore = 0;
  try {
    const allRelsBefore = db.select().from(nexusSchema.nexusRelations).all() as Array<
      Record<string, unknown>
    >;
    const allNodesBefore = db.select().from(nexusSchema.nexusNodes).all() as Array<
      Record<string, unknown>
    >;
    relationsBefore = allRelsBefore.filter((r) => r['projectId'] === projectId).length;
    nodesBefore = allNodesBefore.filter((n) => n['projectId'] === projectId).length;
  } catch {
    // DB not yet initialized
  }

  const { runPipeline } = await import('@cleocode/nexus/pipeline' as string);
  const pipelineResult = await runPipeline(
    repoPath,
    projectId,
    db,
    {
      nexusNodes: nexusSchema.nexusNodes,
      nexusRelations: nexusSchema.nexusRelations,
    },
    undefined,
    { incremental: true },
  );

  let relationsAfter = 0;
  let nodesAfter = 0;
  try {
    const allRelsAfter = db.select().from(nexusSchema.nexusRelations).all() as Array<
      Record<string, unknown>
    >;
    const allNodesAfter = db.select().from(nexusSchema.nexusNodes).all() as Array<
      Record<string, unknown>
    >;
    relationsAfter = allRelsAfter.filter((r) => r['projectId'] === projectId).length;
    nodesAfter = allNodesAfter.filter((n) => n['projectId'] === projectId).length;
  } catch {
    relationsAfter = pipelineResult.relationCount;
    nodesAfter = pipelineResult.nodeCount;
  }

  const newRelations = Math.max(0, relationsAfter - relationsBefore);
  const removedRelations = Math.max(0, relationsBefore - relationsAfter);
  const newNodes = Math.max(0, nodesAfter - nodesBefore);
  const removedNodes = Math.max(0, nodesBefore - nodesAfter);

  const regressions: string[] = [];
  if (removedRelations > 5) {
    regressions.push(`${removedRelations} relations removed — verify no broken call chains`);
  }
  if (removedNodes > 0) {
    regressions.push(`${removedNodes} symbols removed — callers may be broken`);
  }

  const healthStatus: NexusDiffHealth =
    regressions.length > 0
      ? 'REGRESSIONS_DETECTED'
      : removedRelations > 0
        ? 'RELATIONS_REDUCED'
        : newRelations > 0
          ? 'RELATIONS_ADDED'
          : 'STABLE';

  return {
    beforeRef,
    afterRef,
    beforeSha,
    afterSha,
    projectId,
    repoPath,
    changedFiles,
    nodesBefore,
    nodesAfter,
    newNodes,
    removedNodes,
    relationsBefore,
    relationsAfter,
    newRelations,
    removedRelations,
    healthStatus,
    regressions,
  };
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusDiff(
  repoPath: string,
  beforeRef?: string,
  afterRef?: string,
  projectId?: string,
): Promise<EngineResult<NexusDiffResult>> {
  try {
    const result = await diffNexusIndex(repoPath, {
      beforeRef,
      afterRef,
      projectIdOverride: projectId,
    });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
