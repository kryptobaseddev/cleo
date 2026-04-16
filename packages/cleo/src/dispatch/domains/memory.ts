/**
 * Memory Domain Handler (Dispatch Layer) — Brain.db Cognitive Memory
 *
 * Handles brain.db-backed cognitive memory operations: observations, decisions,
 * patterns, learnings, and the 3-layer retrieval protocol (find/timeline/fetch).
 *
 * Manifest/pipeline operations have been moved to the pipeline domain.
 * Context injection has been moved to sessions/context-inject.ts.
 *
 * @task T5241
 * @epic T5149
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  getBrainDb,
  getBrainNativeDb,
  resolveAnthropicApiKey,
  resolveAnthropicApiKeySource,
} from '@cleocode/core/internal';
import {
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFetch,
  // Brain.db cognitive memory operations
  memoryFind,
  // PageIndex graph operations (T5385)
  memoryGraphAdd,
  memoryGraphContext,
  memoryGraphNeighbors,
  memoryGraphRelated,
  memoryGraphRemove,
  memoryGraphShow,
  memoryGraphStatsFull,
  memoryGraphTrace,
  // Learning operations
  memoryLearningFind,
  memoryLearningStore,
  // Brain memory linking
  memoryLink,
  memoryObserve,
  // Pattern operations
  memoryPatternFind,
  memoryPatternStore,
  memoryQualityReport,
  memoryReasonSimilar,
  // Reasoning & hybrid search (T5388-T5393)
  memoryReasonWhy,
  memorySearchHybrid,
  memoryTimeline,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Memory Handler Class
// ---------------------------------------------------------------------------
// MemoryHandler
// ---------------------------------------------------------------------------

export class MemoryHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'find': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await memoryFind(
            {
              query,
              limit: params?.limit as number | undefined,
              tables: params?.tables as string[] | undefined,
              dateStart: params?.dateStart as string | undefined,
              dateEnd: params?.dateEnd as string | undefined,
              // T418: optional agent filter for per-agent mental model retrieval
              agent: params?.agent as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'timeline': {
          const anchor = params?.anchor as string;
          if (!anchor) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'anchor is required',
              startTime,
            );
          }
          const result = await memoryTimeline(
            {
              anchor,
              depthBefore: params?.depthBefore as number | undefined,
              depthAfter: params?.depthAfter as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'fetch': {
          const ids = params?.ids as string[] | undefined;
          if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'ids is required (non-empty array)',
              startTime,
            );
          }
          const result = await memoryFetch({ ids }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'decision.find': {
          const result = await memoryDecisionFind(
            {
              query: params?.query as string | undefined,
              taskId: params?.taskId as string | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'pattern.find': {
          const result = await memoryPatternFind(
            {
              type: params?.type as Parameters<typeof memoryPatternFind>[0]['type'],
              impact: params?.impact as Parameters<typeof memoryPatternFind>[0]['impact'],
              query: params?.query as string | undefined,
              minFrequency: params?.minFrequency as number | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'learning.find': {
          const result = await memoryLearningFind(
            {
              query: params?.query as string | undefined,
              minConfidence: params?.minConfidence as number | undefined,
              actionableOnly: params?.actionableOnly as boolean | undefined,
              applicableType: params?.applicableType as string | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.show': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphShow({ nodeId }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.neighbors': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphNeighbors(
            { nodeId, edgeType: params?.edgeType as string | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.trace': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphTrace(
            { nodeId, maxDepth: params?.maxDepth as number | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.related': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphRelated(
            { nodeId, edgeType: params?.edgeType as string | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.context': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphContext({ nodeId }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.stats': {
          const result = await memoryGraphStatsFull(projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'reason.why': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await memoryReasonWhy({ taskId }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'reason.similar': {
          const entryId = params?.entryId as string;
          if (!entryId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'entryId is required',
              startTime,
            );
          }
          const result = await memoryReasonSimilar(
            { entryId, limit: params?.limit as number | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'search.hybrid': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await memorySearchHybrid(
            {
              query,
              ftsWeight: params?.ftsWeight as number | undefined,
              vecWeight: params?.vecWeight as number | undefined,
              graphWeight: params?.graphWeight as number | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'quality': {
          const result = await memoryQualityReport(projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'code.links': {
          const { listCodeLinks } = await import('@cleocode/core/internal');
          const links = await listCodeLinks(projectRoot);
          return wrapResult(
            { success: true, data: links },
            'query',
            'memory',
            operation,
            startTime,
          );
        }

        case 'code.memories-for-code': {
          const symbol = params?.symbol as string;
          if (!symbol) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'symbol is required',
              startTime,
            );
          }
          const { queryMemoriesForCode } = await import('@cleocode/core/internal');
          const result = await queryMemoriesForCode(projectRoot, symbol);
          return wrapResult(
            { success: true, data: result },
            'query',
            'memory',
            operation,
            startTime,
          );
        }

        case 'code.for-memory': {
          const memoryId = params?.memoryId as string;
          if (!memoryId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'memoryId is required',
              startTime,
            );
          }
          const { queryCodeForMemory } = await import('@cleocode/core/internal');
          const result = await queryCodeForMemory(projectRoot, memoryId);
          return wrapResult(
            { success: true, data: result },
            'query',
            'memory',
            operation,
            startTime,
          );
        }

        // T791 — LLM extraction backend status
        case 'llm-status': {
          const resolvedSource = resolveAnthropicApiKeySource();
          const extractionEnabled = resolveAnthropicApiKey() !== null;

          // Query brain.db for the most recent extraction event
          let lastExtractionRun: string | null = null;
          try {
            await getBrainDb(projectRoot);
            const nativeDb = getBrainNativeDb();
            if (nativeDb) {
              const row = nativeDb
                .prepare(
                  `SELECT created_at FROM brain_observations
                   WHERE source_type IN ('observer', 'reflector', 'transcript')
                   ORDER BY created_at DESC LIMIT 1`,
                )
                .get() as { created_at: string } | undefined;
              if (row?.created_at) {
                lastExtractionRun = row.created_at.replace(' ', 'T');
                if (!lastExtractionRun.includes('Z')) lastExtractionRun += 'Z';
              }
            }
          } catch {
            // brain.db unavailable — non-fatal
          }

          return wrapResult(
            {
              success: true,
              data: {
                resolvedSource,
                extractionEnabled,
                lastExtractionRun,
                testCommand: 'cleo memory reflect --json',
              },
            },
            'query',
            'memory',
            operation,
            startTime,
          );
        }

        // T792 — surface unverified-but-highly-cited entries as verification queue
        case 'pending-verify': {
          const minCitations = (params?.minCitations as number | undefined) ?? 5;
          const limitVal = (params?.limit as number | undefined) ?? 50;

          try {
            await getBrainDb(projectRoot);
            const nativeDb = getBrainNativeDb();
            if (!nativeDb) {
              return errorResult(
                'query',
                'memory',
                operation,
                'E_DB_UNAVAILABLE',
                'brain.db is unavailable',
                startTime,
              );
            }

            interface PendingRow {
              id: string;
              title: string | null;
              source_confidence: string | null;
              citation_count: number;
              memory_tier: string | null;
              created_at: string;
            }

            const tables = [
              { name: 'brain_observations', labelCol: 'title' },
              { name: 'brain_decisions', labelCol: 'decision' },
              { name: 'brain_patterns', labelCol: 'pattern' },
              { name: 'brain_learnings', labelCol: 'insight' },
            ] as const;

            const allPending: Array<PendingRow & { table: string }> = [];

            for (const t of tables) {
              try {
                const rawRows = nativeDb
                  .prepare(
                    `SELECT id,
                            COALESCE(${t.labelCol}, id) AS title,
                            source_confidence,
                            citation_count,
                            memory_tier,
                            created_at
                     FROM ${t.name}
                     WHERE verified = 0
                       AND citation_count >= ?
                       AND invalid_at IS NULL
                     ORDER BY citation_count DESC
                     LIMIT ?`,
                  )
                  .all(minCitations, limitVal);
                const rows: PendingRow[] = rawRows.map((raw) => {
                  const r = raw as Record<string, unknown>;
                  return {
                    id: String(r['id'] ?? ''),
                    title: r['title'] != null ? String(r['title']) : null,
                    source_confidence:
                      r['source_confidence'] != null ? String(r['source_confidence']) : null,
                    citation_count: Number(r['citation_count'] ?? 0),
                    memory_tier: r['memory_tier'] != null ? String(r['memory_tier']) : null,
                    created_at: String(r['created_at'] ?? ''),
                  };
                });
                for (const row of rows) {
                  allPending.push({ ...row, table: t.name.replace('brain_', '') });
                }
              } catch {
                // Table may not have the column — skip
              }
            }

            // Sort globally by citation_count DESC and apply overall limit
            allPending.sort((a, b) => b.citation_count - a.citation_count);
            const items = allPending.slice(0, limitVal);

            return wrapResult(
              {
                success: true,
                data: {
                  count: items.length,
                  minCitations,
                  items,
                  hint: `Run 'cleo memory verify <id>' to promote an entry to verified=true`,
                },
              },
              'query',
              'memory',
              operation,
              startTime,
            );
          } catch (dbErr) {
            return handleErrorResult('query', 'memory', operation, dbErr, startTime);
          }
        }

        default:
          return unsupportedOp('query', 'memory', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:memory').error(
        { gateway: 'query', domain: 'memory', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'memory', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'observe': {
          const text = params?.text as string;
          if (!text) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'text is required',
              startTime,
            );
          }
          const result = await memoryObserve(
            {
              text,
              title: params?.title as string | undefined,
              type: params?.type as string | undefined,
              project: params?.project as string | undefined,
              sourceSessionId: params?.sourceSessionId as string | undefined,
              sourceType: params?.sourceType as string | undefined,
              // T417: optional agent provenance for mental model observations
              agent: params?.agent as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'decision.store': {
          const decision = params?.decision as string;
          const rationale = params?.rationale as string;
          if (!decision || !rationale) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'decision and rationale are required',
              startTime,
            );
          }
          const result = await memoryDecisionStore(
            {
              decision,
              rationale,
              alternatives: params?.alternatives as string[] | undefined,
              taskId: params?.taskId as string | undefined,
              sessionId: params?.sessionId as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'pattern.store': {
          const patternText = params?.pattern as string;
          const context = params?.context as string;
          if (!patternText || !context) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'pattern and context are required',
              startTime,
            );
          }
          const result = await memoryPatternStore(
            {
              type:
                (params?.type as Parameters<typeof memoryPatternStore>[0]['type']) || 'workflow',
              pattern: patternText,
              context,
              impact: params?.impact as Parameters<typeof memoryPatternStore>[0]['impact'],
              antiPattern: params?.antiPattern as string | undefined,
              mitigation: params?.mitigation as string | undefined,
              examples: params?.examples as string[] | undefined,
              successRate: params?.successRate as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'learning.store': {
          const insight = params?.insight as string;
          const source = params?.source as string;
          if (!insight || !source) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'insight and source are required',
              startTime,
            );
          }
          const result = await memoryLearningStore(
            {
              insight,
              source,
              confidence: (params?.confidence as number) ?? 0.5,
              actionable: params?.actionable as boolean | undefined,
              application: params?.application as string | undefined,
              applicableTypes: params?.applicableTypes as string[] | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'link': {
          const taskId = params?.taskId as string;
          const entryId = params?.entryId as string;
          if (!taskId || !entryId) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'taskId and entryId are required',
              startTime,
            );
          }
          const result = await memoryLink({ taskId, entryId }, projectRoot);
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'graph.add': {
          const result = await memoryGraphAdd(
            {
              nodeId: params?.nodeId as string | undefined,
              nodeType: params?.nodeType as string | undefined,
              label: params?.label as string | undefined,
              metadataJson: params?.metadataJson as string | undefined,
              fromId: params?.fromId as string | undefined,
              toId: params?.toId as string | undefined,
              edgeType: params?.edgeType as string | undefined,
              weight: params?.weight as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'graph.remove': {
          const result = await memoryGraphRemove(
            {
              nodeId: params?.nodeId as string | undefined,
              fromId: params?.fromId as string | undefined,
              toId: params?.toId as string | undefined,
              edgeType: params?.edgeType as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'code.link': {
          const memoryId = params?.memoryId as string;
          const codeSymbol = params?.codeSymbol as string;
          if (!memoryId || !codeSymbol) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'memoryId and codeSymbol are required',
              startTime,
            );
          }
          const { linkMemoryToCode } = await import('@cleocode/core/internal');
          const linked = await linkMemoryToCode(projectRoot, memoryId, codeSymbol);
          return wrapResult(
            { success: true, data: { linked } },
            'mutate',
            'memory',
            operation,
            startTime,
          );
        }

        case 'code.auto-link': {
          const { autoLinkMemories } = await import('@cleocode/core/internal');
          const result = await autoLinkMemories(projectRoot);
          return wrapResult(
            { success: true, data: result },
            'mutate',
            'memory',
            operation,
            startTime,
          );
        }

        // T792 — promote an agent observation to verified=true (owner/cleo-prime only)
        case 'verify': {
          const entryId = params?.id as string;
          if (!entryId) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'id is required (the observation/decision/pattern/learning ID to verify)',
              startTime,
            );
          }

          // Caller identity: no agent param = terminal invocation (owner). Agents must
          // pass --agent <name>; only 'cleo-prime' and 'owner' are permitted.
          const callerAgent = params?.agent as string | undefined;
          if (callerAgent && callerAgent !== 'cleo-prime' && callerAgent !== 'owner') {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_FORBIDDEN',
              `verify requires agent identity 'cleo-prime' or 'owner'; got '${callerAgent}'`,
              startTime,
            );
          }

          try {
            await getBrainDb(projectRoot);
            const nativeDb = getBrainNativeDb();
            if (!nativeDb) {
              return errorResult(
                'mutate',
                'memory',
                operation,
                'E_DB_UNAVAILABLE',
                'brain.db is unavailable',
                startTime,
              );
            }

            const tables = [
              'brain_observations',
              'brain_decisions',
              'brain_patterns',
              'brain_learnings',
            ] as const;

            const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
            let found = false;
            let foundTable = '';
            let alreadyVerified = false;

            for (const tbl of tables) {
              try {
                const row = nativeDb
                  .prepare(
                    `SELECT id, verified FROM ${tbl} WHERE id = ? AND invalid_at IS NULL LIMIT 1`,
                  )
                  .get(entryId) as { id: string; verified: number } | undefined;

                if (row) {
                  found = true;
                  foundTable = tbl;
                  alreadyVerified = row.verified === 1;

                  if (!alreadyVerified) {
                    nativeDb
                      .prepare(`UPDATE ${tbl} SET verified = 1, updated_at = ? WHERE id = ?`)
                      .run(now, entryId);
                  }
                  break;
                }
              } catch {
                // Try next table
              }
            }

            if (!found) {
              return errorResult(
                'mutate',
                'memory',
                operation,
                'E_NOT_FOUND',
                `Entry '${entryId}' not found in any brain table (or is invalidated)`,
                startTime,
              );
            }

            return wrapResult(
              {
                success: true,
                data: {
                  id: entryId,
                  table: foundTable.replace('brain_', ''),
                  verified: true,
                  alreadyVerified,
                  verifiedAt: alreadyVerified ? null : now,
                },
              },
              'mutate',
              'memory',
              operation,
              startTime,
            );
          } catch (dbErr) {
            return handleErrorResult('mutate', 'memory', operation, dbErr, startTime);
          }
        }

        default:
          return unsupportedOp('mutate', 'memory', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:memory').error(
        { gateway: 'mutate', domain: 'memory', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'memory', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'find',
        'timeline',
        'fetch',
        'decision.find',
        'pattern.find',
        'learning.find',
        'graph.show',
        'graph.neighbors',
        'graph.trace',
        'graph.related',
        'graph.context',
        'graph.stats',
        'reason.why',
        'reason.similar',
        'search.hybrid',
        'quality',
        'code.links',
        'code.memories-for-code',
        'code.for-memory',
        // T791 — LLM extraction backend status
        'llm-status',
        // T792 — pending verification queue
        'pending-verify',
      ],
      mutate: [
        'observe',
        'decision.store',
        'pattern.store',
        'learning.store',
        'link',
        'graph.add',
        'graph.remove',
        'code.link',
        'code.auto-link',
        // T792 — promote entry to verified=true
        'verify',
      ],
    };
  }
}
