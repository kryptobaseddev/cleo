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
  generateMemoryBridgeContent,
  getBrainDb,
  getBrainNativeDb,
  resolveAnthropicApiKey,
  resolveAnthropicApiKeySource,
} from '@cleocode/core/internal';
import {
  approveBackfillRun,
  listBackfillRuns,
  rollbackBackfillRun,
  stagedBackfillRun,
} from '@cleocode/core/memory/brain-backfill.js';
import { precompactFlush } from '@cleocode/core/memory/precompact-flush.js';
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

        // T1262 — brain noise detector (read-only, E1-parallel per council verdict)
        case 'doctor': {
          const { scanBrainNoise } = await import('@cleocode/core/memory/brain-doctor.js');
          const result = await scanBrainNoise(projectRoot);
          const assertClean = params?.['assert-clean'] as boolean | undefined;
          if (assertClean && !result.isClean) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_BRAIN_NOISE_DETECTED',
              `Brain noise detected: ${result.findings.length} pattern(s) across ${result.totalScanned} entries. ` +
                result.findings.map((f) => `${f.pattern}(${f.count})`).join(', ') +
                '. Run `cleo memory doctor` for details. Fix noise before enabling Sentient v1 (M7 gate).',
              startTime,
            );
          }
          return wrapResult(result, 'query', 'memory', operation, startTime);
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

        // T1006 — summarized top-N observations as session briefing digest
        case 'digest': {
          const limitVal = (params?.limit as number | undefined) ?? 10;

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

            interface DigestRow {
              id: string;
              title: string | null;
              text: string;
              citation_count: number;
              quality_score: number | null;
              memory_tier: string | null;
              created_at: string;
            }

            let rows: DigestRow[] = [];
            try {
              const rawRows = nativeDb
                .prepare(
                  `SELECT id,
                          title,
                          text,
                          citation_count,
                          quality_score,
                          memory_tier,
                          created_at
                   FROM brain_observations
                   WHERE invalid_at IS NULL
                   ORDER BY citation_count DESC, quality_score DESC
                   LIMIT ?`,
                )
                .all(limitVal);
              rows = rawRows.map((raw) => {
                const r = raw as Record<string, unknown>;
                return {
                  id: String(r['id'] ?? ''),
                  title: r['title'] != null ? String(r['title']) : null,
                  text: String(r['text'] ?? ''),
                  citation_count: Number(r['citation_count'] ?? 0),
                  quality_score: r['quality_score'] != null ? Number(r['quality_score']) : null,
                  memory_tier: r['memory_tier'] != null ? String(r['memory_tier']) : null,
                  created_at: String(r['created_at'] ?? ''),
                };
              });
            } catch {
              // brain_observations may not exist yet — return empty digest
            }

            // Build a brief text summary from the top entries
            const summaryLines = rows.map((r, i) => {
              const label = r.title ?? r.id;
              const snippet = r.text.slice(0, 80).replace(/\n/g, ' ');
              return `${i + 1}. [${r.id}] ${label} — ${snippet}${r.text.length > 80 ? '…' : ''}`;
            });

            return wrapResult(
              {
                success: true,
                data: {
                  count: rows.length,
                  limit: limitVal,
                  summary: summaryLines.join('\n'),
                  observations: rows,
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

        // T1006 — tail recent observations with optional filters
        case 'recent': {
          const limitVal = (params?.limit as number | undefined) ?? 20;
          const sinceParam = params?.since as string | undefined;
          const typeFilter = params?.type as string | undefined;
          const sessionFilter = params?.session as string | undefined;
          const tierFilter = params?.tier as string | undefined;

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

            // Parse `since` as an ISO duration (e.g. "24h", "7d", "30m") or ISO timestamp
            let sinceIso: string | undefined;
            if (sinceParam) {
              const durationMatch = /^(\d+)(m|h|d|w)$/i.exec(sinceParam);
              if (durationMatch) {
                const amount = Number(durationMatch[1]);
                const unit = durationMatch[2].toLowerCase();
                const ms =
                  unit === 'm'
                    ? amount * 60_000
                    : unit === 'h'
                      ? amount * 3_600_000
                      : unit === 'd'
                        ? amount * 86_400_000
                        : amount * 7 * 86_400_000;
                sinceIso = new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
              } else {
                // Assume it's an ISO timestamp or SQLite datetime string
                sinceIso = sinceParam;
              }
            }

            interface RecentRow {
              id: string;
              title: string | null;
              text: string;
              type: string | null;
              source_session_id: string | null;
              memory_tier: string | null;
              created_at: string;
            }

            const clauses: string[] = ['invalid_at IS NULL'];
            const bindArgs: (string | number)[] = [];

            if (sinceIso) {
              clauses.push('created_at >= ?');
              bindArgs.push(sinceIso);
            }
            if (typeFilter) {
              clauses.push('type = ?');
              bindArgs.push(typeFilter);
            }
            if (sessionFilter) {
              clauses.push('source_session_id = ?');
              bindArgs.push(sessionFilter);
            }
            if (tierFilter) {
              clauses.push('memory_tier = ?');
              bindArgs.push(tierFilter);
            }
            bindArgs.push(limitVal);

            const whereClause = clauses.join(' AND ');

            let rows: RecentRow[] = [];
            try {
              const rawRows = nativeDb
                .prepare(
                  `SELECT id, title, text, type, source_session_id, memory_tier, created_at
                   FROM brain_observations
                   WHERE ${whereClause}
                   ORDER BY created_at DESC
                   LIMIT ?`,
                )
                .all(...bindArgs);
              rows = rawRows.map((raw) => {
                const r = raw as Record<string, unknown>;
                return {
                  id: String(r['id'] ?? ''),
                  title: r['title'] != null ? String(r['title']) : null,
                  text: String(r['text'] ?? ''),
                  type: r['type'] != null ? String(r['type']) : null,
                  source_session_id:
                    r['source_session_id'] != null ? String(r['source_session_id']) : null,
                  memory_tier: r['memory_tier'] != null ? String(r['memory_tier']) : null,
                  created_at: String(r['created_at'] ?? ''),
                };
              });
            } catch {
              // brain_observations may not have all columns — return empty
            }

            return wrapResult(
              {
                success: true,
                data: {
                  count: rows.length,
                  limit: limitVal,
                  since: sinceIso ?? null,
                  observations: rows,
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

        // T1006 — read diary-typed observations
        case 'diary': {
          const limitVal = (params?.limit as number | undefined) ?? 20;

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

            interface DiaryRow {
              id: string;
              title: string | null;
              text: string;
              source_session_id: string | null;
              memory_tier: string | null;
              created_at: string;
            }

            let rows: DiaryRow[] = [];
            try {
              const rawRows = nativeDb
                .prepare(
                  `SELECT id, title, text, source_session_id, memory_tier, created_at
                   FROM brain_observations
                   WHERE type = 'diary'
                     AND invalid_at IS NULL
                   ORDER BY created_at DESC
                   LIMIT ?`,
                )
                .all(limitVal);
              rows = rawRows.map((raw) => {
                const r = raw as Record<string, unknown>;
                return {
                  id: String(r['id'] ?? ''),
                  title: r['title'] != null ? String(r['title']) : null,
                  text: String(r['text'] ?? ''),
                  source_session_id:
                    r['source_session_id'] != null ? String(r['source_session_id']) : null,
                  memory_tier: r['memory_tier'] != null ? String(r['memory_tier']) : null,
                  created_at: String(r['created_at'] ?? ''),
                };
              });
            } catch {
              // brain_observations may not have type column — return empty
            }

            return wrapResult(
              {
                success: true,
                data: {
                  count: rows.length,
                  limit: limitVal,
                  type: 'diary',
                  entries: rows,
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

        // T1006 — long-poll stream of recent brain writes (SSE-style polling stub)
        // Returns the latest N observations created after an optional cursor.
        // Clients call this in a loop, advancing the cursor with the returned `nextCursor`.
        case 'watch': {
          const cursorParam = params?.cursor as string | undefined;
          const limitVal = (params?.limit as number | undefined) ?? 10;

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

            interface WatchRow {
              id: string;
              title: string | null;
              text: string;
              type: string | null;
              memory_tier: string | null;
              created_at: string;
            }

            const clauses: string[] = ['invalid_at IS NULL'];
            const bindArgs: (string | number)[] = [];

            if (cursorParam) {
              clauses.push('created_at > ?');
              bindArgs.push(cursorParam);
            }
            bindArgs.push(limitVal);

            let rows: WatchRow[] = [];
            try {
              const rawRows = nativeDb
                .prepare(
                  `SELECT id, title, text, type, memory_tier, created_at
                   FROM brain_observations
                   WHERE ${clauses.join(' AND ')}
                   ORDER BY created_at ASC
                   LIMIT ?`,
                )
                .all(...bindArgs);
              rows = rawRows.map((raw) => {
                const r = raw as Record<string, unknown>;
                return {
                  id: String(r['id'] ?? ''),
                  title: r['title'] != null ? String(r['title']) : null,
                  text: String(r['text'] ?? ''),
                  type: r['type'] != null ? String(r['type']) : null,
                  memory_tier: r['memory_tier'] != null ? String(r['memory_tier']) : null,
                  created_at: String(r['created_at'] ?? ''),
                };
              });
            } catch {
              // brain_observations may not exist yet
            }

            const nextCursor =
              rows.length > 0 ? rows[rows.length - 1]!.created_at : (cursorParam ?? null);

            return wrapResult(
              {
                success: true,
                data: {
                  count: rows.length,
                  cursor: cursorParam ?? null,
                  nextCursor,
                  events: rows,
                  hint: 'Poll again with cursor=nextCursor to stream new writes',
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

        // T1003 — list staged backfill runs (pending/approved/rolled-back)
        case 'backfill.list': {
          try {
            const status = params?.status as string | undefined;
            const limit = params?.limit as number | undefined;
            const runs = await listBackfillRuns(projectRoot, { status, limit });
            return wrapResult(
              {
                success: true,
                data: {
                  count: runs.length,
                  runs,
                  hint: `Use 'cleo memory backfill.approve <runId>' or 'cleo memory backfill.rollback <runId>'`,
                },
              },
              'query',
              'memory',
              operation,
              startTime,
            );
          } catch (listErr) {
            return handleErrorResult('query', 'memory', operation, listErr, startTime);
          }
        }

        // T999 — stream brain.db memory-bridge content directly (cli mode default)
        case 'bridge': {
          const content = await generateMemoryBridgeContent(projectRoot);
          return wrapResult(
            { success: true, data: { content } },
            'query',
            'memory',
            operation,
            startTime,
          );
        }

        // T997 — read-only view over STDP weights + retrieval log + citation data
        case 'promote-explain': {
          const entryId = params?.id as string;
          if (!entryId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'id is required',
              startTime,
            );
          }

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

            // 1. Locate entry in typed tables
            const typedTables = [
              { name: 'brain_observations', labelCol: 'title' },
              { name: 'brain_decisions', labelCol: 'decision' },
              { name: 'brain_patterns', labelCol: 'pattern' },
              { name: 'brain_learnings', labelCol: 'insight' },
            ] as const;

            interface TypedRow {
              id: string;
              citation_count: number;
              quality_score: number | null;
              memory_tier: string | null;
              tier_promoted_at: string | null;
              verified: number;
            }

            let foundTable = '';
            let typedRow: TypedRow | undefined;

            for (const t of typedTables) {
              try {
                const row = nativeDb
                  .prepare(
                    `SELECT id, citation_count, quality_score, memory_tier, tier_promoted_at, verified
                     FROM ${t.name}
                     WHERE id = ? AND invalid_at IS NULL
                     LIMIT 1`,
                  )
                  .get(entryId) as TypedRow | undefined;
                if (row) {
                  typedRow = row;
                  foundTable = t.name.replace('brain_', '');
                  break;
                }
              } catch {
                // Table may not have all columns yet — try next
              }
            }

            if (!typedRow) {
              return errorResult(
                'query',
                'memory',
                operation,
                'E_NOT_FOUND',
                `Entry '${entryId}' not found in any brain table (or is invalidated)`,
                startTime,
              );
            }

            // 2. Query prune_candidate (column may not exist on older DBs)
            let pruneCandidate = false;
            try {
              const pruneRow = nativeDb
                .prepare(`SELECT prune_candidate FROM brain_${foundTable} WHERE id = ? LIMIT 1`)
                .get(entryId) as { prune_candidate: number } | undefined;
              pruneCandidate = (pruneRow?.prune_candidate ?? 0) === 1;
            } catch {
              // prune_candidate column not yet present — degrade gracefully
            }

            // 3. Query brain_page_edges STDP weights for this entry's page-node
            interface EdgeRow {
              from_id: string;
              to_id: string;
              edge_type: string;
              weight: number;
              reinforcement_count: number;
              last_reinforced_at: string | null;
            }

            let stdpWeights: EdgeRow[] = [];
            try {
              const edgeRows = nativeDb
                .prepare(
                  `SELECT from_id, to_id, edge_type, weight,
                          COALESCE(reinforcement_count, 0) AS reinforcement_count,
                          last_reinforced_at
                   FROM brain_page_edges
                   WHERE (from_id = ? OR to_id = ?)
                     AND plasticity_class IN ('hebbian', 'stdp')
                   ORDER BY weight DESC
                   LIMIT 20`,
                )
                .all(entryId, entryId) as unknown as EdgeRow[];
              stdpWeights = edgeRows;
            } catch {
              // plasticity_class column may not exist — fall back to unfiltered weight query
              try {
                const edgeRows = nativeDb
                  .prepare(
                    `SELECT from_id, to_id, edge_type, weight,
                            COALESCE(reinforcement_count, 0) AS reinforcement_count,
                            last_reinforced_at
                     FROM brain_page_edges
                     WHERE from_id = ? OR to_id = ?
                     ORDER BY weight DESC
                     LIMIT 20`,
                  )
                  .all(entryId, entryId) as unknown as EdgeRow[];
                stdpWeights = edgeRows;
              } catch {
                // brain_page_edges unavailable — degrade gracefully
              }
            }

            // 4. Query brain_retrieval_log for retrieval count and last access
            let retrievalCount = 0;
            let lastAccessedAt: string | null = null;
            try {
              interface RetrievalSummary {
                retrieval_count: number;
                last_accessed_at: string | null;
              }
              const logRow = nativeDb
                .prepare(
                  `SELECT COUNT(*) AS retrieval_count,
                          MAX(created_at) AS last_accessed_at
                   FROM brain_retrieval_log
                   WHERE entry_ids LIKE ?`,
                )
                .get(`%${entryId}%`) as RetrievalSummary | undefined;
              retrievalCount = logRow?.retrieval_count ?? 0;
              lastAccessedAt = logRow?.last_accessed_at ?? null;
              if (lastAccessedAt && !lastAccessedAt.includes('T')) {
                lastAccessedAt = lastAccessedAt.replace(' ', 'T');
                if (!lastAccessedAt.endsWith('Z')) lastAccessedAt += 'Z';
              }
            } catch {
              // retrieval log unavailable — degrade gracefully
            }

            // 5. Determine promotion tier and explanation
            const citationCount = typedRow.citation_count ?? 0;
            const qualityScore = typedRow.quality_score ?? null;
            const memoryTier = typedRow.memory_tier ?? null;
            const promotedAt = typedRow.tier_promoted_at ?? null;
            const verified = typedRow.verified === 1;

            const stdpWeightMax =
              stdpWeights.length > 0 ? Math.max(...stdpWeights.map((e) => e.weight)) : 0;

            let tier: 'promoted' | 'rejected' | 'pending';
            let explanation: string;

            if (pruneCandidate) {
              tier = 'rejected';
              explanation =
                `Entry flagged as prune candidate. ` +
                `quality_score=${qualityScore ?? 'null'}, citation_count=${citationCount}, ` +
                `retrieval_count=${retrievalCount}. ` +
                `Meets pruning criteria: low quality and/or zero citations over time.`;
            } else if (
              memoryTier === 'long' ||
              memoryTier === 'medium' ||
              verified ||
              promotedAt !== null
            ) {
              tier = 'promoted';
              explanation =
                `Entry promoted to memory tier '${memoryTier ?? 'promoted'}'. ` +
                `citation_count=${citationCount}, retrieval_count=${retrievalCount}, ` +
                `stdp_weight_max=${stdpWeightMax.toFixed(3)}, verified=${verified}. ` +
                (promotedAt ? `Tier promotion recorded at ${promotedAt}.` : 'Verified by owner.');
            } else {
              tier = 'pending';
              explanation =
                `Entry has not yet been promoted or flagged for pruning. ` +
                `memory_tier='${memoryTier ?? 'short'}', citation_count=${citationCount}, ` +
                `retrieval_count=${retrievalCount}, stdp_weight_max=${stdpWeightMax.toFixed(3)}. ` +
                `Increase retrieval frequency or citation count to qualify for promotion.`;
            }

            const scoreBreakdown = {
              stdpWeightMax,
              retrievalCount,
              lastAccessedAt,
              citationCount,
              qualityScore,
              pruneCandidate,
              verified,
            };

            const weights = stdpWeights.map((e) => ({
              fromId: e.from_id,
              toId: e.to_id,
              edgeType: e.edge_type,
              weight: e.weight,
              reinforcementCount: e.reinforcement_count,
              lastReinforcedAt: e.last_reinforced_at,
            }));

            return wrapResult(
              {
                success: true,
                data: {
                  id: entryId,
                  table: foundTable,
                  tier,
                  explanation,
                  promotedAt: promotedAt ?? null,
                  stdpWeights: weights,
                  scoreBreakdown,
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
          // T799: parse optional attachment refs (comma-separated sha256 list or JSON array)
          const rawAttach = params?.attach as string | string[] | undefined;
          let attachmentRefs: string[] | undefined;
          if (Array.isArray(rawAttach)) {
            attachmentRefs = rawAttach.filter((r) => typeof r === 'string' && r.length > 0);
          } else if (typeof rawAttach === 'string' && rawAttach.trim()) {
            attachmentRefs = rawAttach
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean);
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
              // T799: optional attachment refs
              attachmentRefs,
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
          // pass --agent <name>; only canonical orchestrator identities and 'owner' are
          // permitted to promote entries to verified=true.
          //
          // Live-data migration shim (T1258 E1): 'cleo-prime' is accepted alongside
          // 'project-orchestrator' for backward compatibility with persisted agent
          // session records that pre-date the ADR-055 D032 canonical naming refactor.
          // New agents MUST use 'project-orchestrator'. 'cleo-prime' acceptance may be
          // removed in a future clean-forward pass once all persisted sessions are expired.
          const VERIFY_PERMITTED_IDENTITIES = new Set([
            'owner',
            'project-orchestrator',
            'cleo-prime', // legacy alias — see migration shim note above
          ]);
          const callerAgent = params?.agent as string | undefined;
          if (callerAgent && !VERIFY_PERMITTED_IDENTITIES.has(callerAgent)) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_FORBIDDEN',
              `verify requires agent identity 'project-orchestrator' or 'owner'; got '${callerAgent}'`,
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

        // T1006 — write a diary-typed observation (thin wrapper over observe)
        case 'diary.write': {
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
              type: 'diary',
              sourceSessionId: params?.sourceSessionId as string | undefined,
              agent: params?.agent as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        // T1004 — flush in-flight observations + WAL checkpoint before context compaction
        case 'precompact-flush': {
          try {
            const flushResult = await precompactFlush(projectRoot);
            return wrapResult(
              {
                success: true,
                data: flushResult,
              },
              'mutate',
              'memory',
              operation,
              startTime,
            );
          } catch (flushErr) {
            return handleErrorResult('mutate', 'memory', operation, flushErr, startTime);
          }
        }

        // T1003 — stage a new graph backfill run (rows held pending approval)
        case 'backfill.run': {
          try {
            const source = params?.source as string | undefined;
            const kind = params?.kind as string | undefined;
            const targetTable = params?.targetTable as string | undefined;
            const result = await stagedBackfillRun(projectRoot, { source, kind, targetTable });
            return wrapResult(
              {
                success: true,
                data: {
                  runId: result.run.id,
                  run: result.run,
                  empty: result.empty,
                  hint: result.empty
                    ? 'All candidate nodes already present — nothing to backfill'
                    : `Run staged with ${result.run.rowsAffected} rows. Approve with 'cleo memory backfill.approve ${result.run.id}'`,
                },
              },
              'mutate',
              'memory',
              operation,
              startTime,
            );
          } catch (runErr) {
            return handleErrorResult('mutate', 'memory', operation, runErr, startTime);
          }
        }

        // T1003 — approve a staged backfill run (commits rows to live tables)
        case 'backfill.approve': {
          const runId = params?.runId as string | undefined;
          if (!runId) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'runId is required',
              startTime,
            );
          }
          try {
            const approvedBy = params?.approvedBy as string | undefined;
            const result = await approveBackfillRun(projectRoot, runId, approvedBy);
            return wrapResult(
              {
                success: true,
                data: {
                  runId: result.run.id,
                  run: result.run,
                  alreadySettled: result.alreadySettled,
                  backfillResult: result.backfillResult ?? null,
                  hint: result.alreadySettled
                    ? `Run '${runId}' was already settled (status: ${result.run.status})`
                    : `Backfill committed: ${result.backfillResult?.nodesInserted ?? 0} nodes inserted`,
                },
              },
              'mutate',
              'memory',
              operation,
              startTime,
            );
          } catch (approveErr) {
            return handleErrorResult('mutate', 'memory', operation, approveErr, startTime);
          }
        }

        // T1003 — rollback a backfill run (removes staged/committed rows)
        case 'backfill.rollback': {
          const runId = params?.runId as string | undefined;
          if (!runId) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'runId is required',
              startTime,
            );
          }
          try {
            const result = await rollbackBackfillRun(projectRoot, runId);
            return wrapResult(
              {
                success: true,
                data: {
                  runId: result.run.id,
                  run: result.run,
                  alreadySettled: result.alreadySettled,
                  deletedRows: result.deletedRows,
                  hint: result.alreadySettled
                    ? `Run '${runId}' was already rolled back`
                    : result.deletedRows > 0
                      ? `Rolled back: deleted ${result.deletedRows} committed rows`
                      : 'Run was still staged — no committed rows to delete',
                },
              },
              'mutate',
              'memory',
              operation,
              startTime,
            );
          } catch (rollbackErr) {
            return handleErrorResult('mutate', 'memory', operation, rollbackErr, startTime);
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
        // T1262 — brain noise detector (E1-parallel, read-only)
        'doctor',
        // T791 — LLM extraction backend status
        'llm-status',
        // T792 — pending verification queue
        'pending-verify',
        // T999 — live memory-bridge content from brain.db (cli mode)
        'bridge',
        // T997 — read-only explainability view for promotion decisions
        'promote-explain',
        // T1006 — summarized top-N observations as session briefing digest
        'digest',
        // T1006 — tail recent observations with optional filters
        'recent',
        // T1006 — diary-typed observations (requires diary enum from T1005)
        'diary',
        // T1006 — long-poll stream of recent brain writes (SSE-style polling stub)
        'watch',
        // T1003 — list staged backfill runs
        'backfill.list',
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
        // T1004 — flush in-flight observations + WAL checkpoint before context compaction
        'precompact-flush',
        // T1006 — write a diary-typed observation
        'diary.write',
        // T1003 — staged backfill operations
        'backfill.run',
        'backfill.approve',
        'backfill.rollback',
      ],
    };
  }
}
