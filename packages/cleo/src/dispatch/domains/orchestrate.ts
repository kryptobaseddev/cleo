/**
 * Orchestrate Domain Handler (Dispatch Layer)
 *
 * Handles multi-agent orchestration: dependency analysis, wave computation,
 * spawn readiness, parallel coordination, and orchestration context.
 * All operations delegate to native engine functions.
 *
 * Wave 7a additions (T379):
 * - orchestrate.classify (T408) — prompt-based team routing stub
 * - orchestrate.fanout (T409) — Promise.allSettled spawn wrapper
 * - orchestrate.fanout.status (T415) — fanout status stub
 * - orchestrate.analyze mode="parallel-safety" (T410) — dep-graph grouping
 *
 * @epic T4820
 * @epic T377
 */

import {
  getLogger,
  getProjectRoot,
  instantiateTessera,
  listTesseraTemplates,
  paginate,
  showTessera,
} from '@cleocode/core/internal';
import {
  orchestrateAnalyze,
  orchestrateBootstrap,
  orchestrateContext,
  orchestrateHandoff,
  orchestrateNext,
  orchestrateParallelEnd,
  orchestrateParallelStart,
  orchestrateReady,
  orchestrateSpawn,
  orchestrateSpawnExecute,
  orchestrateStartup,
  orchestrateStatus,
  orchestrateUnblockOpportunities,
  orchestrateValidate,
  orchestrateWaves,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, getListParams, handleErrorResult, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';
import { ConduitHandler } from './conduit.js';
import { IvtrHandler } from './ivtr.js';

/** Shared ConduitHandler instance for conduit.* sub-operations (ADR-042). */
const conduitHandler = new ConduitHandler();

/** Shared IvtrHandler instance for ivtr.* sub-operations (T811). */
const ivtrHandler = new IvtrHandler();

// ---------------------------------------------------------------------------
// OrchestrateHandler
// ---------------------------------------------------------------------------

export class OrchestrateHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateStatus(epicId, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'next': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateNext(epicId, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'ready': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateReady(epicId, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'analyze': {
          const epicId = params?.epicId as string;
          const mode = params?.mode as string | undefined;

          // T410: parallel-safety mode — dep-graph grouping without epicId
          if (mode === 'parallel-safety') {
            const taskIds = params?.taskIds as string[] | undefined;
            const result = await orchestrateAnalyzeParallelSafety(taskIds ?? [], projectRoot);
            return wrapResult(result, 'query', 'orchestrate', 'analyze', startTime);
          }

          const result = await orchestrateAnalyze(epicId, projectRoot, mode);
          return wrapResult(result, 'query', 'orchestrate', 'analyze', startTime);
        }

        case 'classify': {
          // T408: prompt-based team routing stub.
          //
          // ADR-030 §5 Challenge Questions:
          // Q1: Is this operation idempotent? Yes — same request + context produces same routing.
          // Q2: What is the failure mode when no team matches? Returns confidence=0 with null team.
          // Q3: Should this be a query or mutate? Query — no state is written; routing is advisory.
          // Q4: How does this compose with orchestrate.spawn? Classify first, then spawn to the
          //     returned team's lead using the returned protocol.
          // Q5: What prevents stale team registry data? The classifier reads live .cant files at
          //     runtime; W7b adds cache invalidation on file-change events.
          const request = params?.request as string | undefined;
          if (!request) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'request is required',
              startTime,
            );
          }
          const context = params?.context as string | undefined;
          const result = await orchestrateClassify(request, context, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'fanout.status': {
          // T433 STAB-1: reads results from the in-process fanoutManifestStore.
          const manifestEntryId = params?.manifestEntryId as string | undefined;
          if (!manifestEntryId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'manifestEntryId is required',
              startTime,
            );
          }
          const entry = fanoutManifestStore.get(manifestEntryId);
          if (!entry) {
            return {
              meta: dispatchMeta('query', 'orchestrate', operation, startTime),
              success: true,
              data: {
                manifestEntryId,
                pending: [] as string[],
                running: [] as string[],
                complete: [] as string[],
                failed: [] as string[],
                found: false,
              },
            };
          }
          const spawned = entry.results.filter((r) => r.status === 'spawned').map((r) => r.taskId);
          const failed = entry.results.filter((r) => r.status === 'failed').map((r) => r.taskId);
          return {
            meta: dispatchMeta('query', 'orchestrate', operation, startTime),
            success: true,
            data: {
              manifestEntryId,
              pending: [] as string[],
              running: spawned,
              complete: [] as string[],
              failed,
              found: true,
              completedAt: entry.completedAt,
            },
          };
        }

        case 'context': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateContext(epicId, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'waves': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateWaves(epicId, projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'bootstrap': {
          const speed = params?.speed as 'fast' | 'full' | 'complete' | undefined;
          const result = await orchestrateBootstrap(projectRoot, { speed });
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'unblock.opportunities': {
          const result = await orchestrateUnblockOpportunities(projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'tessera.list': {
          const id = params?.id as string | undefined;
          if (id) {
            const template = showTessera(id);
            if (!template) {
              return errorResult(
                'query',
                'orchestrate',
                'tessera.list',
                'E_NOT_FOUND',
                `Tessera template "${id}" not found`,
                startTime,
              );
            }
            return {
              meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
              success: true,
              data: template,
            };
          }
          const templates = listTesseraTemplates();
          const { limit, offset } = getListParams(params);
          const page = paginate(templates, limit, offset);
          return {
            meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
            success: true,
            data: {
              templates: page.items,
              count: templates.length,
              total: templates.length,
              filtered: templates.length,
            },
            page: page.page,
          };
        }

        // ADR-042: conduit sub-operations routed through orchestrate domain
        case 'conduit.status':
          return conduitHandler.query('status', params);
        case 'conduit.peek':
          return conduitHandler.query('peek', params);

        // T811: IVTR orchestration harness sub-operations
        case 'ivtr.status':
          return ivtrHandler.query('status', params);

        default:
          return errorResult(
            'query',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'query', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'orchestrate', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateStartup(epicId, projectRoot);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'spawn': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawn(taskId, protocolType, projectRoot, tier);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'handoff': {
          const taskId = params?.taskId as string;
          const protocolType = params?.protocolType as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          if (!protocolType) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'protocolType is required',
              startTime,
            );
          }
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateHandoff(
            {
              taskId,
              protocolType,
              note: params?.note as string | undefined,
              nextAction: params?.nextAction as string | undefined,
              variant: params?.variant as string | undefined,
              tier,
              idempotencyKey: params?.idempotencyKey as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'spawn.execute': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const adapterId = params?.adapterId as string | undefined;
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawnExecute(
            taskId,
            adapterId,
            protocolType,
            projectRoot,
            tier,
          );
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'validate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await orchestrateValidate(taskId, projectRoot);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'parallel': {
          return routeByParam(params, 'action', {
            start: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = await orchestrateParallelStart(epicId, wave, projectRoot);
              return wrapResult(result, 'mutate', 'orchestrate', 'parallel', startTime);
            },
            end: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = await orchestrateParallelEnd(epicId, wave, projectRoot);
              return wrapResult(result, 'mutate', 'orchestrate', 'parallel', startTime);
            },
          });
        }

        case 'fanout': {
          // T409: Promise.allSettled fanout wrapper.
          //
          // ADR-030 §5 Challenge Questions:
          // Q1: Is this idempotent? No — each call triggers new spawn attempts.
          // Q2: What happens on partial failure? allSettled collects all; results
          //     include per-item status and error fields. Orchestrator decides retry.
          // Q3: Does this block the orchestrator? No — allSettled runs concurrently
          //     and returns aggregate results. The caller decides whether to await.
          // Q4: How does this relate to orchestrate.spawn? fanout is the N-task
          //     coordinator; spawn is the single-task primitive. fanout wraps spawn.
          // Q5: What is the manifestEntryId for? Correlates with fanout.status so
          //     the orchestrator can poll fanout progress across turns.
          const items = params?.items as
            | Array<{ team: string; taskId: string; skill?: string }>
            | undefined;
          if (!items || !Array.isArray(items) || items.length === 0) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'items array is required and must be non-empty',
              startTime,
            );
          }
          const result = await orchestrateFanout(items, projectRoot);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'tessera.instantiate': {
          const templateId = params?.templateId as string;
          const epicId = params?.epicId as string;
          if (!templateId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'templateId is required',
              startTime,
            );
          }
          if (!epicId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const template = showTessera(templateId);
          if (!template) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_NOT_FOUND',
              `Tessera template "${templateId}" not found`,
              startTime,
            );
          }
          const variables = (params?.variables as Record<string, unknown>) ?? {};
          const instance = await instantiateTessera(
            template,
            { templateId, epicId, variables: { epicId, ...variables } },
            projectRoot,
          );
          return {
            meta: dispatchMeta('mutate', 'orchestrate', operation, startTime),
            success: true,
            data: instance,
          };
        }

        // ADR-042: conduit sub-operations routed through orchestrate domain
        case 'conduit.start':
          return conduitHandler.mutate('start', params);
        case 'conduit.stop':
          return conduitHandler.mutate('stop', params);
        case 'conduit.send':
          return conduitHandler.mutate('send', params);

        // T811: IVTR orchestration harness sub-operations
        case 'ivtr.start':
          return ivtrHandler.mutate('start', params);
        case 'ivtr.next':
          return ivtrHandler.mutate('next', params);
        case 'ivtr.release':
          return ivtrHandler.mutate('release', params);
        case 'ivtr.loop-back':
          return ivtrHandler.mutate('loop-back', params);

        default:
          return errorResult(
            'mutate',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'mutate', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'orchestrate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status',
        'next',
        'ready',
        'analyze',
        'context',
        'waves',
        'bootstrap',
        'unblock.opportunities',
        'tessera.list',
        // Wave 7a (T379)
        'classify',
        'fanout.status',
        // ADR-042: conduit sub-operations
        'conduit.status',
        'conduit.peek',
        // T811: IVTR orchestration harness
        'ivtr.status',
      ],
      mutate: [
        'start',
        'spawn',
        'handoff',
        'spawn.execute',
        'validate',
        'parallel',
        'tessera.instantiate',
        // Wave 7a (T379)
        'fanout',
        // ADR-042: conduit sub-operations
        'conduit.start',
        'conduit.stop',
        'conduit.send',
        // T811: IVTR orchestration harness
        'ivtr.start',
        'ivtr.next',
        'ivtr.release',
        'ivtr.loop-back',
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Wave 7a handler functions (T408, T409, T410)
// ---------------------------------------------------------------------------

/** Classify result shape returned by orchestrate.classify. */
interface ClassifyResult {
  /** Matched team name, or null if no match. */
  team: string | null;
  /** Lead agent name within the matched team, or null. */
  lead: string | null;
  /** Suggested protocol type for the spawn. */
  protocol: string | null;
  /** Stage hint from the matched team's stages list. */
  stage: string | null;
  /** Confidence score 0.0–1.0 (stub always returns 0.5). */
  confidence: number;
  /** Human-readable reasoning for the classification. */
  reasoning: string;
}

/**
 * T408 — Classify a request against the CANT team registry.
 *
 * Implementation: prompt-based reasoning stub. Reads team definitions from the
 * canonical CANT workflows dir and performs substring matching against each
 * team's `consult-when` hint. Returns the highest-scoring team.
 *
 * Real LLM-based routing will replace this in a later wave once the runtime
 * bridge (W7b) has loaded `.cant` team definitions into memory.
 *
 * @param request - The request text to classify.
 * @param context - Optional additional context.
 * @param projectRoot - Project root directory.
 * @returns EngineResult containing ClassifyResult.
 */
async function orchestrateClassify(
  request: string,
  context: string | undefined,
  projectRoot: string,
): Promise<{ success: boolean; data?: ClassifyResult; error?: { code: string; message: string } }> {
  try {
    const { getCleoCantWorkflowsDir } = await import('@cleocode/core/internal');
    const { readFileSync, readdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const workflowsDir = getCleoCantWorkflowsDir();
    const combined = `${request} ${context ?? ''}`.toLowerCase();

    // Walk .cant files and look for `consult-when:` entries.
    const matches: Array<{ team: string; score: number; consultWhen: string; stages: string[] }> =
      [];

    if (existsSync(workflowsDir)) {
      const files = readdirSync(workflowsDir).filter((f: string) => f.endsWith('.cant'));
      for (const file of files) {
        try {
          const src = readFileSync(join(workflowsDir, file), 'utf-8');
          // Extract team name
          const teamMatch = /^team\s+(\S+):/m.exec(src);
          if (!teamMatch) continue;
          const teamName = teamMatch[1]!;

          // Extract consult-when hint
          const cwMatch = /consult-when:\s*["']?(.+?)["']?\s*$/m.exec(src);
          const consultWhen = cwMatch ? cwMatch[1]!.trim() : '';

          // Extract stages
          const stagesMatch = /stages:\s*\[([^\]]+)\]/.exec(src);
          const stages = stagesMatch ? stagesMatch[1]!.split(',').map((s: string) => s.trim()) : [];

          // Simple substring scoring: count hint word matches in request
          const hintWords = consultWhen.toLowerCase().split(/\s+/);
          const score = hintWords.filter((w: string) => combined.includes(w)).length;
          matches.push({ team: teamName, score, consultWhen, stages });
        } catch {
          // skip unreadable files
        }
      }
    }

    // Also check project-local .cant files
    const localCantDir = join(projectRoot, '.cleo', 'workflows');
    if (existsSync(localCantDir)) {
      const files = readdirSync(localCantDir).filter((f: string) => f.endsWith('.cant'));
      for (const file of files) {
        try {
          const src = readFileSync(join(localCantDir, file), 'utf-8');
          const teamMatch = /^team\s+(\S+):/m.exec(src);
          if (!teamMatch) continue;
          const teamName = teamMatch[1]!;
          const cwMatch = /consult-when:\s*["']?(.+?)["']?\s*$/m.exec(src);
          const consultWhen = cwMatch ? cwMatch[1]!.trim() : '';
          const stagesMatch = /stages:\s*\[([^\]]+)\]/.exec(src);
          const stages = stagesMatch ? stagesMatch[1]!.split(',').map((s: string) => s.trim()) : [];
          const hintWords = consultWhen.toLowerCase().split(/\s+/);
          const score = hintWords.filter((w: string) => combined.includes(w)).length;
          matches.push({ team: teamName, score, consultWhen, stages });
        } catch {
          // skip
        }
      }
    }

    if (matches.length === 0) {
      return {
        success: true,
        data: {
          team: null,
          lead: null,
          protocol: null,
          stage: null,
          confidence: 0,
          reasoning:
            'No CANT team definitions found. Seed teams.cant in the global workflows dir ' +
            '(W7b runtime enforcement) to enable team routing.',
        },
      };
    }

    // Pick the best match
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0]!;

    return {
      success: true,
      data: {
        team: best.team,
        lead: null, // lead resolution requires W7b runtime bridge
        protocol: 'base-subagent', // default protocol stub
        stage: best.stages[0] ?? null,
        confidence: best.score > 0 ? 0.5 : 0.1,
        reasoning:
          best.score > 0
            ? `Matched team '${best.team}' via consult-when hint: "${best.consultWhen}"`
            : `No strong match found; defaulting to first registered team '${best.team}'`,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'classify', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_CLASSIFY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Single fanout item shape. */
interface FanoutItem {
  /** Team name to route the task to. */
  team: string;
  /** Task ID to spawn. */
  taskId: string;
  /** Optional skill to inject into the spawn context. */
  skill?: string;
}

/** Result for a single fanout item. */
interface FanoutItemResult {
  /** Task ID. */
  taskId: string;
  /** Outcome status — 'spawned' when the spawn adapter accepted the task, 'failed' on error. */
  status: 'spawned' | 'failed';
  /** Adapter instance ID returned by the spawn adapter, when available. */
  instanceId?: string;
  /** Error message if status is failed. */
  error?: string;
}

/**
 * In-process store for fanout manifest entries.
 *
 * Keyed by manifestEntryId (generated in orchestrateFanout).
 * Populated when a fanout completes so that orchestrate.fanout.status
 * can categorise results across orchestrator turns.
 */
/** Maximum number of fanout manifest entries retained in memory. */
const FANOUT_MANIFEST_MAX_SIZE = 64;

const fanoutManifestStore = new Map<
  string,
  {
    results: FanoutItemResult[];
    completedAt: string;
  }
>();

/**
 * Evict oldest entries when the manifest store exceeds the size cap.
 * Map iteration order is insertion order, so deleting the first key
 * removes the oldest entry.
 */
function evictFanoutManifest(): void {
  while (fanoutManifestStore.size > FANOUT_MANIFEST_MAX_SIZE) {
    const oldest = fanoutManifestStore.keys().next().value;
    if (oldest !== undefined) fanoutManifestStore.delete(oldest);
  }
}

/**
 * T409 / T433 — Fan out N spawn requests via Promise.allSettled.
 *
 * Each item is dispatched concurrently through orchestrateSpawnExecute
 * (T432/W7a adapter registry path). Results are persisted in the
 * in-process fanoutManifestStore so that orchestrate.fanout.status can
 * categorise them across orchestrator turns.
 *
 * @param items - Array of fanout items to dispatch.
 * @param projectRoot - Project root directory.
 * @returns EngineResult with aggregated results and a manifest entry ID.
 */
async function orchestrateFanout(
  items: FanoutItem[],
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const manifestEntryId = `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Promise.allSettled wrapper — each item is processed concurrently via
    // the adapter registry's orchestrateSpawnExecute path (T432/W7a wired).
    const settled = await Promise.allSettled(
      items.map(async (item): Promise<FanoutItemResult> => {
        const spawnResult = await orchestrateSpawnExecute(
          item.taskId,
          /* adapterId */ undefined,
          /* protocolType */ undefined,
          projectRoot,
          /* tier */ undefined,
        );
        if (!spawnResult.success) {
          return {
            taskId: item.taskId,
            status: 'failed',
            error: spawnResult.error?.message ?? `Spawn failed for task ${item.taskId}`,
          };
        }
        const data = spawnResult.data as Record<string, unknown> | undefined;
        return {
          taskId: item.taskId,
          status: 'spawned',
          instanceId: typeof data?.instanceId === 'string' ? data.instanceId : undefined,
        };
      }),
    );

    const results: FanoutItemResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      return {
        taskId: items[i]!.taskId,
        status: 'failed',
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    });

    // Persist results in the in-process manifest store so that
    // orchestrate.fanout.status can categorise them across turns.
    fanoutManifestStore.set(manifestEntryId, {
      results,
      completedAt: new Date().toISOString(),
    });
    evictFanoutManifest();

    return {
      success: true,
      data: {
        manifestEntryId,
        results,
        total: items.length,
        spawned: results.filter((r) => r.status === 'spawned').length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'fanout', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_FANOUT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * T410 — Analyze a list of tasks for parallel safety.
 *
 * Walks `Task.depends` (stored as `blockers` in the accessor) to build a
 * transitive dependency closure. Two tasks are parallel-safe if neither
 * appears in the other's transitive closure.
 *
 * Returns `{parallelSafe: boolean, groups: string[][]}` where each group
 * contains tasks with no intra-group dependency edges.
 *
 * @param taskIds - List of task IDs to analyze.
 * @param projectRoot - Project root directory.
 * @returns EngineResult with parallel safety analysis.
 */
async function orchestrateAnalyzeParallelSafety(
  taskIds: string[],
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  if (taskIds.length === 0) {
    return {
      success: true,
      data: {
        parallelSafe: true,
        groups: [] as string[][],
        note: 'No tasks provided — trivially parallel-safe',
      },
    };
  }

  try {
    const { getAccessor } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const result = await accessor.queryTasks({});
    const allTasks = result?.tasks ?? [];

    // Build a lookup map from task ID to its direct dependencies.
    const depMap = new Map<string, string[]>();
    for (const t of allTasks) {
      // Tasks store deps in `blockers` field which maps to Task.depends.
      const deps: string[] = (t as { blockers?: string[] }).blockers ?? [];
      depMap.set(t.id, deps);
    }

    /**
     * Compute the transitive dependency closure for a given task ID.
     * Returns the set of all task IDs that `id` transitively depends on.
     */
    function transitiveClose(id: string, visited = new Set<string>()): Set<string> {
      if (visited.has(id)) return visited;
      visited.add(id);
      const deps = depMap.get(id) ?? [];
      for (const dep of deps) {
        transitiveClose(dep, visited);
      }
      return visited;
    }

    // Build the closure for each task in the input set.
    const closures = new Map<string, Set<string>>();
    for (const id of taskIds) {
      closures.set(id, transitiveClose(id));
    }

    /**
     * Two tasks are parallel-safe if:
     * - neither appears in the other's transitive closure.
     */
    function parallelSafe(a: string, b: string): boolean {
      const closureA = closures.get(a) ?? new Set();
      const closureB = closures.get(b) ?? new Set();
      return !closureA.has(b) && !closureB.has(a);
    }

    // Greedy group assignment — assigns tasks to the first group where they
    // are safe relative to all existing members.
    const groups: string[][] = [];
    for (const id of taskIds) {
      let placed = false;
      for (const group of groups) {
        if (group.every((member) => parallelSafe(id, member))) {
          group.push(id);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([id]);
      }
    }

    const isFullyParallelSafe = groups.length <= 1;

    return {
      success: true,
      data: {
        parallelSafe: isFullyParallelSafe,
        groups,
        taskCount: taskIds.length,
        groupCount: groups.length,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'analyze/parallel-safety', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_ANALYZE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
