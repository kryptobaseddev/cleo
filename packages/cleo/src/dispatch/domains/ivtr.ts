/**
 * IVTR Dispatch Domain Handler
 *
 * Handles `cleo orchestrate ivtr <taskId> --<action>` operations.
 *
 * Operations (all routed through this handler):
 *
 * QUERY:
 *   ivtr.status   — return current phase + evidence list + phase history
 *
 * MUTATE:
 *   ivtr.start     — begin Implement phase (returns resolved prompt)
 *   ivtr.next      — advance from current phase to next (validates evidence; returns prompt)
 *   ivtr.release   — FINAL gate: requires I+V+T evidence, marks task done
 *   ivtr.loop-back — rewind to specified phase with failure evidence attached
 *
 * All state is persisted via the `ivtr_state` JSON column on `tasks`.
 *
 * @epic T810
 * @task T811
 */

import type { IvtrPhase, IvtrPhaseEntry } from '@cleocode/core/internal';
import {
  advanceIvtr,
  autoRunGatesAndRecord,
  E_IVTR_MAX_RETRIES,
  extractTypedGates,
  getIvtrState,
  getLogger,
  getProjectRoot,
  getTask,
  loopBackIvtr,
  releaseIvtr,
  resolvePhasePrompt,
  startIvtr,
} from '@cleocode/core/internal';
import { releaseIvtrAutoSuggest } from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, wrapResult } from './_base.js';

const log = getLogger('domain:ivtr');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that a string is a legal IvtrPhase (excluding 'released'). */
function isLoopBackTarget(phase: string): phase is Exclude<IvtrPhase, 'released'> {
  return phase === 'implement' || phase === 'validate' || phase === 'test';
}

/** Extract an evidence array from params (accepts string[] or comma-separated string). */
function extractEvidence(params?: Record<string, unknown>): string[] {
  const raw = params?.['evidence'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map((s) => s.trim());
  return [];
}

// ---------------------------------------------------------------------------
// IvtrHandler
// ---------------------------------------------------------------------------

/**
 * Standalone domain handler for IVTR orchestration operations.
 *
 * Designed to be instantiated by the `OrchestrateHandler` and delegated to
 * for all `ivtr.*` sub-operations. Not registered as a top-level domain name
 * in the domain registry — it is accessed via `orchestrate.ivtr.*`.
 */
export class IvtrHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // query — read-only
  // -----------------------------------------------------------------------

  /**
   * Handle read-only IVTR queries.
   *
   * Supported operations:
   * - `status` — return IvtrState + resolved summary for a task
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const taskId = params?.['taskId'] as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'ivtr',
              'status',
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const cwd = getProjectRoot();
          const state = await getIvtrState(taskId, { cwd });

          if (!state) {
            return wrapResult(
              {
                success: true,
                data: {
                  taskId,
                  started: false,
                  currentPhase: null,
                  phaseHistory: [],
                  message: `Task ${taskId} has no active IVTR loop. Run --start to begin.`,
                },
              },
              'query',
              'ivtr',
              operation,
              startTime,
            );
          }

          return wrapResult(
            {
              success: true,
              data: {
                taskId,
                started: true,
                currentPhase: state.currentPhase,
                startedAt: state.startedAt,
                phaseHistory: state.phaseHistory,
                loopBackCount: state.loopBackCount ?? {
                  implement: 0,
                  validate: 0,
                  test: 0,
                  released: 0,
                },
                evidenceCount: state.phaseHistory.reduce(
                  (acc: number, e: IvtrPhaseEntry) => acc + e.evidenceRefs.length,
                  0,
                ),
              },
            },
            'query',
            'ivtr',
            operation,
            startTime,
          );
        }

        default:
          return errorResult(
            'query',
            'ivtr',
            operation,
            'E_INVALID_OPERATION',
            `Unknown ivtr query operation: ${operation}`,
            startTime,
          );
      }
    } catch (err) {
      log.error({ err, operation }, 'IvtrHandler query error');
      return handleErrorResult('query', 'ivtr', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // mutate — state-modifying
  // -----------------------------------------------------------------------

  /**
   * Handle state-modifying IVTR mutations.
   *
   * Supported operations:
   * - `start`     — begin Implement phase, return resolved prompt
   * - `next`      — advance from current phase to next, return prompt for next phase
   * - `release`   — run final gate, mark task done
   * - `loop-back` — rewind to specified phase with failure evidence
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      const taskId = params?.['taskId'] as string | undefined;
      if (!taskId) {
        return errorResult(
          'mutate',
          'ivtr',
          operation,
          'E_INVALID_INPUT',
          'taskId is required',
          startTime,
        );
      }

      const cwd = getProjectRoot();
      const agentIdentity = params?.['agentIdentity'] as string | undefined;

      switch (operation) {
        // ------------------------------------------------------------------
        // ivtr.start — begin the implement phase
        // ------------------------------------------------------------------
        case 'start': {
          const task = await getTask(taskId, cwd);
          if (!task) {
            return errorResult(
              'mutate',
              'ivtr',
              operation,
              'E_NOT_FOUND',
              `Task ${taskId} not found`,
              startTime,
            );
          }

          const state = await startIvtr(taskId, { cwd, agentIdentity });
          const prompt = resolvePhasePrompt(
            taskId,
            state,
            task.title,
            task.description ?? '(no description)',
          );

          return wrapResult(
            {
              success: true,
              data: {
                taskId,
                currentPhase: state.currentPhase,
                startedAt: state.startedAt,
                resolvedPrompt: prompt,
                message: `IVTR loop started. Implement phase is now active for task ${taskId}.`,
              },
            },
            'mutate',
            'ivtr',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // ivtr.next — advance to the next phase (requires prior evidence)
        // ------------------------------------------------------------------
        case 'next': {
          const task = await getTask(taskId, cwd);
          if (!task) {
            return errorResult(
              'mutate',
              'ivtr',
              operation,
              'E_NOT_FOUND',
              `Task ${taskId} not found`,
              startTime,
            );
          }

          const evidence = extractEvidence(params);
          const autoRunTests = params?.['autoRunTests'] === true;

          const state = await advanceIvtr(taskId, evidence, { cwd, agentIdentity });

          // --auto-run-tests: when the new phase is 'test', invoke runGates atomically.
          let autoRunResult: Awaited<ReturnType<typeof autoRunGatesAndRecord>> | undefined;
          if (autoRunTests && state.currentPhase === 'test') {
            const acceptanceItems = (task.acceptance ?? []) as (string | object)[];
            const typedGateEntries = extractTypedGates(
              acceptanceItems as Parameters<typeof extractTypedGates>[0],
            );
            const gates = typedGateEntries.map((e) => e.gate);

            autoRunResult = await autoRunGatesAndRecord(taskId, gates, agentIdentity, cwd);

            // Record the auto-run evidence sha256 back into the phase entry.
            // autoRunGatesAndRecord already mutates phaseHistory and persists,
            // so we only need to include it in the evidence summary for the caller.
          }

          // Extract typed gates for test-phase prompt enrichment.
          const acceptanceItems = (task.acceptance ?? []) as (string | object)[];
          const typedGates =
            state.currentPhase === 'test'
              ? extractTypedGates(acceptanceItems as Parameters<typeof extractTypedGates>[0]).map(
                  (e) => e.gate,
                )
              : undefined;

          // T799: resolvePhasePrompt injects ## Attached Documents section via cleo docs
          // Signature: (taskId, state, title, desc, acceptanceGates?, evidenceBundle=[])
          // Note: sync function; evidence bundle is ImplEvidenceSummary[] (pre-fetched)
          const prompt = resolvePhasePrompt(
            taskId,
            state,
            task.title,
            task.description ?? '(no description)',
            typedGates,
            [],
          );

          return wrapResult(
            {
              success: true,
              data: {
                taskId,
                previousPhase: state.phaseHistory[state.phaseHistory.length - 2]?.phase ?? null,
                currentPhase: state.currentPhase,
                evidenceRecorded: evidence.length,
                resolvedPrompt: prompt,
                ...(autoRunResult
                  ? {
                      autoRunTests: {
                        attachmentSha256: autoRunResult.attachmentSha256,
                        testsPassed: autoRunResult.testsPassed,
                        testsFailed: autoRunResult.testsFailed,
                        exitCode: autoRunResult.exitCode,
                        evidenceRecord: autoRunResult.evidenceRecord,
                      },
                    }
                  : {}),
                message: `Phase advanced to '${state.currentPhase}' for task ${taskId}.${autoRunResult ? ` Auto-run gates: ${autoRunResult.testsPassed} passed, ${autoRunResult.testsFailed} failed.` : ''}`,
              },
            },
            'mutate',
            'ivtr',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // ivtr.release — FINAL gate
        // ------------------------------------------------------------------
        case 'release': {
          const result = await releaseIvtr(taskId, { cwd });

          if (!result.released) {
            return wrapResult(
              {
                success: false,
                error: {
                  code: 'E_IVTR_GATE_FAILED',
                  message: `Release gate failed for task ${taskId}: ${result.failures?.join('; ')}`,
                  details: { failures: result.failures },
                },
              },
              'mutate',
              'ivtr',
              operation,
              startTime,
            );
          }

          // T820 RELEASE-07: Check whether all sibling tasks in the parent epic
          // are now released. If so, emit a `cleo release ship` auto-suggestion
          // so the operator is guided to the next step without manual discovery.
          let autoSuggest: {
            epicId: string | null;
            epicFullyReleased: boolean;
            suggestedCommand: string | null;
            message: string;
          } | null = null;

          try {
            const suggestResult = await releaseIvtrAutoSuggest(taskId, cwd);
            if (suggestResult.success && suggestResult.data) {
              const d = suggestResult.data as {
                epicId: string | null;
                epicFullyReleased: boolean;
                suggestedCommand: string | null;
                message: string;
              };
              autoSuggest = {
                epicId: d.epicId,
                epicFullyReleased: d.epicFullyReleased,
                suggestedCommand: d.suggestedCommand,
                message: d.message,
              };
            }
          } catch {
            // Auto-suggest is best-effort; never block the release on its failure.
          }

          return wrapResult(
            {
              success: true,
              data: {
                taskId,
                released: true,
                message: `Task ${taskId} has been released. All IVTR phases passed. Status set to done.`,
                ...(autoSuggest ? { autoSuggest } : {}),
              },
            },
            'mutate',
            'ivtr',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // ivtr.loop-back — rewind on failure
        // ------------------------------------------------------------------
        case 'loop-back': {
          const phaseRaw = params?.['phase'] as string | undefined;
          const reason = params?.['reason'] as string | undefined;

          if (!phaseRaw || !isLoopBackTarget(phaseRaw)) {
            return errorResult(
              'mutate',
              'ivtr',
              operation,
              'E_INVALID_INPUT',
              `--phase must be one of: implement, validate, test. Got: '${phaseRaw ?? ''}'`,
              startTime,
            );
          }
          if (!reason) {
            return errorResult(
              'mutate',
              'ivtr',
              operation,
              'E_INVALID_INPUT',
              '--reason is required for loop-back',
              startTime,
            );
          }

          const task = await getTask(taskId, cwd);
          if (!task) {
            return errorResult(
              'mutate',
              'ivtr',
              operation,
              'E_NOT_FOUND',
              `Task ${taskId} not found`,
              startTime,
            );
          }

          const evidence = extractEvidence(params);

          let state: Awaited<ReturnType<typeof loopBackIvtr>>;
          try {
            state = await loopBackIvtr(taskId, phaseRaw, reason, evidence, {
              cwd,
              agentIdentity,
            });
          } catch (loopBackErr) {
            // Surface E_IVTR_MAX_RETRIES as a structured HITL escalation error.
            const msg = loopBackErr instanceof Error ? loopBackErr.message : String(loopBackErr);
            if (msg.startsWith(E_IVTR_MAX_RETRIES)) {
              log.warn({ taskId, phase: phaseRaw }, 'IVTR max retries reached — HITL escalation');
              return wrapResult(
                {
                  success: false,
                  error: {
                    code: E_IVTR_MAX_RETRIES,
                    message: msg,
                    details: {
                      taskId,
                      phase: phaseRaw,
                      hitlEscalation: true,
                      escalationNote:
                        'Maximum loop-backs reached. A human must inspect the loop-back history and resolve the root cause before the IVTR loop can continue.',
                    },
                  },
                },
                'mutate',
                'ivtr',
                operation,
                startTime,
              );
            }
            throw loopBackErr;
          }

          const prompt = resolvePhasePrompt(
            taskId,
            state,
            task.title,
            task.description ?? '(no description)',
          );

          return wrapResult(
            {
              success: true,
              data: {
                taskId,
                loopedBackTo: phaseRaw,
                reason,
                currentPhase: state.currentPhase,
                loopBackCount: state.loopBackCount ?? {
                  implement: 0,
                  validate: 0,
                  test: 0,
                  released: 0,
                },
                resolvedPrompt: prompt,
                message: `IVTR loop-back recorded. Phase rewound to '${phaseRaw}' for task ${taskId}.`,
              },
            },
            'mutate',
            'ivtr',
            operation,
            startTime,
          );
        }

        default:
          return errorResult(
            'mutate',
            'ivtr',
            operation,
            'E_INVALID_OPERATION',
            `Unknown ivtr mutate operation: ${operation}`,
            startTime,
          );
      }
    } catch (err) {
      log.error({ err, operation }, 'IvtrHandler mutate error');
      return handleErrorResult('mutate', 'ivtr', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  /** Return declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status'],
      mutate: ['start', 'next', 'release', 'loop-back'],
    };
  }
}
