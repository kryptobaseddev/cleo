/**
 * Nexus API contracts and ingestion bridge (T1569).
 *
 * Migrated from packages/cleo/src/dispatch/engines/nexus-engine.ts.
 * All five contract/ingestion functions live here:
 *   - nexusContractsSync  — extract and store HTTP/gRPC/topic contracts
 *   - nexusContractsShow  — compatibility matrix between two projects
 *   - nexusContractsLinkTasks — link contracts to tasks via git-log linker
 *   - nexusConduitScan    — link conduit messages to symbols
 *   - nexusTaskSymbols    — show symbols touched by a task
 *
 * Static imports replace the lazy `await import(... as string)` pattern.
 *
 * @task T1569
 * @task T1117
 */

import type {
  ContractCompatibilityMatrix,
  ContractMatch,
  NexusTaskSymbolsResult,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { linkConduitMessagesToSymbols } from '../memory/graph-memory-bridge.js';
import {
  extractGrpcContracts,
  extractHttpContracts,
  extractTopicContracts,
  matchContracts,
} from './api-extractors/index.js';
import { assessKnowledgeCoverage, recordKnowledgeGap } from './knowledge.js';
import { projectHolding } from './path-map.js';
import { requirePermission } from './permissions.js';
import { nexusGetProjectById } from './registry.js';
import { getTaskKnowledgeEvidence } from './task-evidence.js';
import { getSymbolsForTask, runGitLogTaskLinker } from './tasks-bridge.js';

/**
 * Extract HTTP, gRPC, and topic contracts from a project and store them in nexus.db.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
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
    const [httpContracts, grpcContracts, topicContracts] = await Promise.all([
      extractHttpContracts(projectId, repoPath),
      extractGrpcContracts(projectId, repoPath),
      extractTopicContracts(projectId, repoPath),
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
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusContractsShow(
  projectAId: string,
  projectBId: string,
  projectRoot: string,
): Promise<EngineResult<ContractCompatibilityMatrix>> {
  try {
    const projectA = await nexusGetProjectById(projectRoot, projectAId);
    const projectB = await nexusGetProjectById(projectRoot, projectBId);
    if (!projectA || !projectB) {
      // @sync-invariant none:local-only contract comparison requires registered query targets, never a guessed filesystem path
      return engineError('E_NOT_FOUND', 'Both project ids must resolve to registered projects.');
    }
    if (
      projectHolding(projectA.path, projectA.projectId) !== 'yes' ||
      projectHolding(projectB.path, projectB.projectId) !== 'yes'
    ) {
      // @sync-invariant none:local-only missing or mismatched local checkouts cannot supply graph evidence
      return engineError(
        'E_NOT_FOUND',
        'A registered project checkout is unavailable or has a different identity. Run cleo doctor projects.',
      );
    }
    await requirePermission(projectA.projectId, 'read', 'contracts.show');
    await requirePermission(projectB.projectId, 'read', 'contracts.show');

    const [httpA, grpcA, topicA] = await Promise.all([
      extractHttpContracts(projectA.projectId, projectA.path),
      extractGrpcContracts(projectA.projectId, projectA.path),
      extractTopicContracts(projectA.projectId, projectA.path),
    ]);
    const [httpB, grpcB, topicB] = await Promise.all([
      extractHttpContracts(projectB.projectId, projectB.path),
      extractGrpcContracts(projectB.projectId, projectB.path),
      extractTopicContracts(projectB.projectId, projectB.path),
    ]);

    const contractsA = [...(httpA ?? []), ...(grpcA ?? []), ...(topicA ?? [])];
    const contractsB = [...(httpB ?? []), ...(grpcB ?? []), ...(topicB ?? [])];
    const matches: ContractMatch[] = matchContracts(contractsA, contractsB);

    const compatibleCount = matches.filter((m) => m.compatibility === 'compatible').length;
    const incompatibleCount = matches.filter((m) => m.compatibility === 'incompatible').length;
    const partialCount = matches.filter((m) => m.compatibility === 'partial').length;
    const overallCompatibility =
      matches.length > 0 ? Math.round((compatibleCount / matches.length) * 100) : 0;

    const matrix: ContractCompatibilityMatrix = {
      projectAId: projectA.projectId,
      projectBId: projectB.projectId,
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
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusContractsLinkTasks(
  projectId: string,
  repoPath: string,
): Promise<EngineResult<unknown>> {
  try {
    const result = await runGitLogTaskLinker(projectId, repoPath);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Scan conduit messages for symbol mentions and write conduit_mentions_symbol edges.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusConduitScan(
  projectRoot: string,
): Promise<EngineResult<{ scanned: number; linked: number }>> {
  try {
    const result = await linkConduitMessagesToSymbols(projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show code symbols touched by a task via task_touches_symbol forward-lookup.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusTaskSymbols(
  taskId: string,
  projectRoot: string,
): Promise<EngineResult<NexusTaskSymbolsResult>> {
  try {
    const coverage = await assessKnowledgeCoverage(projectRoot);
    const taskEvidence = await getTaskKnowledgeEvidence(taskId, projectRoot, coverage);
    const symbols = await getSymbolsForTask(taskId, projectRoot, taskEvidence);
    if (symbols.length === 0) {
      recordKnowledgeGap(
        coverage,
        coverage.maintenanceState === 'pending' ? 'partial' : 'missing',
        coverage.maintenanceState === 'pending'
          ? 'Task evidence assessment is deferred; zero matches do not establish missing evidence.'
          : 'No task evidence has been resolved to indexed symbols.',
      );
    }
    return engineSuccess({ taskId, count: symbols.length, symbols, coverage });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
