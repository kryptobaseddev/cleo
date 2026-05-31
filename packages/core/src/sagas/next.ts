/**
 * sagaNext — one-shot "what should the orchestrator work on?" primitive.
 *
 * Composes {@link sagaList} + {@link sagaTraversal} to return the single
 * highest-priority non-terminal Saga with its ready frontier. The result is
 * the primary autonomous entry-point for `cleo go` (SG-AUTOPILOT / T11494).
 *
 * The canonical Saga-to-Saga order is encoded as a ranked list below (North
 * Star §0.1). The first non-terminal Saga in that list is the "active" saga
 * returned by `sagaNext`. If an explicit `sagaId` is supplied the traversal
 * is scoped to that Saga only.
 *
 * @task T11493 — E1-SAGA-RESOLVE: sagaNext() in core
 * @saga T11492 — SG-AUTOPILOT
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { sagaList } from './list.js';
import { type SagaTraversalResult, sagaTraversal } from './rollup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for {@link sagaNext}. */
export interface SagaNextParams {
  /**
   * Optional saga ID to scope the traversal. When omitted, the first
   * non-terminal Saga in canonical rank order is selected automatically.
   */
  sagaId?: string;
}

/**
 * Result payload for {@link sagaNext}.
 *
 * Extends the full traversal result with the active saga identity so callers
 * do not need a separate lookup.
 */
export interface SagaNextResult extends SagaTraversalResult {
  /** The saga ID that was selected (auto or explicit). */
  sagaId: string;
  /** Saga title. */
  sagaTitle?: string;
  /** Human-readable label from the canonical rank order table. */
  sagaLabel?: string;
  /**
   * Zero-based rank in the canonical Saga-to-Saga sequence (lower = higher
   * priority). Absent when `sagaId` was supplied explicitly.
   */
  canonicalRank?: number;
  /**
   * Total number of non-terminal sagas found. Useful for progress dashboards.
   */
  activeSagaCount: number;
}

// ---------------------------------------------------------------------------
// Canonical saga order (North Star §0.1)
// ---------------------------------------------------------------------------

/**
 * Canonical Saga-to-Saga ordering (rank-ascending, lower index = higher priority).
 *
 * This list mirrors the `ORDER` constant in `scripts/workgraph-status.mjs`
 * (the script is deleted in T11493 — this is the authoritative source).
 *
 * @task T11493
 */
export const CANONICAL_SAGA_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['T11242', 'dual cleo.db (FOUNDATION)'],
  ['T11492', 'AUTOPILOT: cleo go — build EARLY; it then DRIVES every saga below'],
  ['T11243', 'runtime: Rust supervisor + gateway'],
  ['T11387', 'package-arch: publish=1 + Tools/Skills'],
  ['T11480', 'CORE self-tooling (parallel)'],
  ['T10343', 'envelope-first (foundational doctrine)'],
  ['T10400', 'SDK-API (OpenAPI over gateway)'],
  ['T10404', 'agentic vertical: CANT runtime'],
  ['T10418', 'agentic vertical: tools catalog'],
  ['T10401', 'daemon-IPC (residue)'],
  ['T10402', 'cockpit TUI'],
  ['T10405', 'PSYCHE memory tiers 4-6'],
  ['T10406', 'four-bus integration (tier 7)'],
  ['T10409', 'vault-core'],
  ['T10419', 'channels'],
  ['T10403', 'GenKit substrate (phased)'],
  ['T11308', 'SDLC-optimize'],
  ['T11301', 'release-autonomy'],
  ['T11460', 'CI-workflow-canon'],
  ['T9799', 'skills-v2'],
  ['T11072', 'ADR-canon'],
  ['T11283', 'cognitive substrate'],
] as const;

/** Terminal saga statuses — sagas in these states are skipped by sagaNext. */
const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'deleted', 'archived', 'completed']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the next actionable Saga and its ready frontier.
 *
 * When no `sagaId` is provided, the function walks the canonical Saga-to-Saga
 * order and returns the first non-terminal Saga that exists in the database.
 * When `sagaId` is provided, the traversal is scoped to that Saga only.
 *
 * The result includes the full {@link SagaTraversalResult} (rollup counters,
 * member-epic progress, ready frontier, and blockers) extended with saga
 * identity fields for caller convenience.
 *
 * @param projectRoot - Absolute path to the project root (for DB resolution).
 * @param params - Optional parameters, currently `sagaId` for explicit scoping.
 * @returns EngineResult wrapping {@link SagaNextResult}.
 *
 * @task T11493
 * @saga T11492
 */
export async function sagaNext(
  projectRoot: string,
  params: SagaNextParams = {},
): Promise<EngineResult<SagaNextResult>> {
  // 1. Resolve the full saga list so we can filter terminal ones.
  const listResult = await sagaList(projectRoot);
  if (!listResult.success) {
    return engineError(
      'E_GENERAL',
      listResult.error?.message ?? 'Failed to list sagas for sagaNext',
    );
  }

  const sagas = listResult.data?.sagas ?? [];
  const nonTerminal = sagas.filter((s) => {
    const status = (s as { status?: string }).status ?? 'pending';
    return !TERMINAL_STATUSES.has(status);
  });
  const activeSagaCount = nonTerminal.length;

  // 2. Resolve which saga to traverse.
  let targetId: string;
  let canonicalRank: number | undefined;
  let sagaLabel: string | undefined;

  if (params.sagaId) {
    // Explicit saga — validate it exists.
    const found = sagas.find((s) => s.id === params.sagaId);
    if (!found) {
      return engineError('E_NOT_FOUND', `Saga ${params.sagaId} not found in the task graph`);
    }
    targetId = params.sagaId;
  } else {
    // Auto-select: walk canonical order, pick first non-terminal.
    const sagaStatusMap = new Map(
      sagas.map((s) => [s.id, (s as { status?: string }).status ?? 'pending']),
    );

    let selected: { id: string; label: string; rank: number } | null = null;
    for (let i = 0; i < CANONICAL_SAGA_ORDER.length; i++) {
      const [id, label] = CANONICAL_SAGA_ORDER[i];
      const status = sagaStatusMap.get(id);
      if (status === undefined) continue; // not in DB — skip
      if (TERMINAL_STATUSES.has(status)) continue; // terminal — skip
      selected = { id, label, rank: i };
      break;
    }

    if (!selected) {
      // All sagas in the canonical order are terminal (or missing).
      // Fall back to first non-terminal in the DB list.
      const firstActive = nonTerminal[0];
      if (!firstActive) {
        return engineSuccess<SagaNextResult>({
          sagaId: '',
          activeSagaCount: 0,
          readyFrontier: [],
          blockers: [],
          total: 0,
          done: 0,
          active: 0,
          blocked: 0,
          pending: 0,
          completionPct: 0,
        });
      }
      targetId = firstActive.id;
    } else {
      targetId = selected.id;
      canonicalRank = selected.rank;
      sagaLabel = selected.label;
    }
  }

  // 3. Run the full traversal on the selected saga.
  const traversalResult = await sagaTraversal(projectRoot, targetId);
  if (!traversalResult.success) {
    return engineError(
      traversalResult.error?.code ?? 'E_GENERAL',
      traversalResult.error?.message ?? `sagaTraversal failed for saga ${targetId}`,
    );
  }

  const traversal = traversalResult.data as SagaTraversalResult;

  // 4. Attach saga identity to the result.
  const saga = sagas.find((s) => s.id === targetId);
  const sagaTitle = (saga as { title?: string } | undefined)?.title;

  return engineSuccess<SagaNextResult>({
    ...traversal,
    sagaId: targetId,
    sagaTitle,
    sagaLabel,
    canonicalRank,
    activeSagaCount,
  });
}
