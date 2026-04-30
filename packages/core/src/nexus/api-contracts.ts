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
  SymbolReference,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { linkConduitMessagesToSymbols } from '../memory/graph-memory-bridge.js';
import {
  extractGrpcContracts,
  extractHttpContracts,
  extractTopicContracts,
  matchContracts,
} from './api-extractors/index.js';
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
    const repoPathA = Buffer.from(projectAId, 'base64url').toString() || projectRoot;
    const repoPathB = Buffer.from(projectBId, 'base64url').toString() || projectRoot;

    const [httpA, grpcA, topicA, httpB, grpcB, topicB] = await Promise.all([
      extractHttpContracts(projectAId, repoPathA),
      extractGrpcContracts(projectAId, repoPathA),
      extractTopicContracts(projectAId, repoPathA),
      extractHttpContracts(projectBId, repoPathB),
      extractGrpcContracts(projectBId, repoPathB),
      extractTopicContracts(projectBId, repoPathB),
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
): Promise<
  EngineResult<{
    taskId: string;
    count: number;
    symbols: SymbolReference[];
  }>
> {
  try {
    const symbols = await getSymbolsForTask(taskId, projectRoot);
    return engineSuccess({ taskId, count: symbols.length, symbols });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
