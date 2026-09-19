/**
 * Pre-dispatch inference for `cleo add` — file detection, acceptance criteria
 * parsing, and parent-from-session lookup.
 *
 * Extracted from `packages/cleo/src/cli/commands/add.ts` (T1490) so that the
 * CLI layer remains a thin parse-and-delegate shell and all domain inference
 * lives in Core.
 *
 * Callers are responsible for any `process.stderr` output — this module never
 * writes to stdout/stderr directly.
 *
 * @task T1490
 */

import { execFileSync } from 'node:child_process';
import { getTaskAccessor } from '../store/data-accessor.js';
import { currentTask } from '../task-work/index.js';
import { parseAcceptanceCriteria } from './acceptance-input.js';

export { parseAcceptanceCriteria } from './acceptance-input.js';

/**
 * Input parameters for `inferTaskAddParams`.
 */
export interface InferAddParamsInput {
  /** Task title — forwarded to GitNexus query. */
  title: string;
  /** Optional task description — forwarded to GitNexus query for better ranking. */
  description?: string;
  /** When true and `filesRaw` is absent, invoke GitNexus to suggest files. */
  filesInfer?: boolean;
  /** Raw comma-separated file list from the `--files` CLI flag. */
  filesRaw?: string;
  /** Raw acceptance criteria string from the `--acceptance` CLI flag. */
  acceptanceRaw?: string;
  /** Already-resolved parent ID (from `--parent` or `--parent-id` flags). */
  parentRaw?: string;
  /** Task type string — inference is skipped when type is `'epic'`. */
  type?: string;
}

/**
 * Resolved inference results for `cleo add`.
 *
 * Only fields that were resolved or inferred are present; absent fields mean
 * "no change from what the CLI already determined".
 */
export interface InferAddParamsResult {
  /** Resolved file list (from inference or explicit `--files`). */
  files?: string[];
  /**
   * True when `--files-infer` was requested but GitNexus returned no results.
   * The caller should emit a warning to stderr.
   */
  filesInferWarning?: boolean;
  /** Parsed acceptance criteria array. */
  acceptance?: string[];
  /** Parent task ID inferred from the active session's current task. */
  inferredParent?: string;
  /**
   * Why parent inference produced (or declined to produce) a parent.
   *
   * Always populated when inference was ATTEMPTED — i.e. no explicit
   * `--parent` and a non-epic type. Absent when the caller named a parent, so
   * a present value means "this parent did not come from your command".
   *
   * @remarks
   * T12136 (GH #1232/#1238): the inference itself was announced only through
   * `humanInfo`, which is silent under `--json`/`--quiet` — so the population
   * that gets hurt by it (agents) never saw it. The caller then hit
   * `E_CLEO_DEPTH_EXCEEDED` naming a task it had never mentioned, with advice
   * pointing at an epic it had never intended to file under. Carrying the
   * decision in the RESULT, rather than only on a human-only stderr channel,
   * is what lets the machine-readable surfaces name it too.
   */
  parentInference?: ParentInference;
}

/** Outcome of the session-based parent inference step. */
export interface ParentInference {
  /** `'applied'` when a parent was inferred; otherwise why it was not. */
  outcome: 'applied' | 'no-current-task' | 'stale-terminal' | 'lookup-failed';
  /** The session's `current` pointer, when there was one. */
  candidateId?: string;
  /** Status of the candidate when it was rejected as stale. */
  candidateStatus?: string;
  /** Human-readable statement of what happened, safe to surface verbatim. */
  note: string;
}

/**
 * Statuses that disqualify a session's `current` pointer from supplying a
 * parent.
 *
 * @remarks
 * T12136: a `current` pointer outlives the work it points at. This session's
 * own pointer was `T12100` — set 2026-08-19, status `done`, in a session
 * started 2026-08-01 — and would have parented any new task under a task
 * finished weeks earlier. Inheriting a parent from completed work is never
 * what the caller meant, so a terminal candidate is declined rather than
 * silently used.
 */
const NON_INFERABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled', 'archived']);

/**
 * Infer files touched by a task from its title and description using GitNexus.
 *
 * Constructs a query from title + description, invokes `gitnexus query --json`,
 * and extracts file paths from the result.
 *
 * Fallback: if GitNexus is unavailable or returns empty results, returns an
 * empty array.
 *
 * @param title - Task title
 * @param description - Optional task description
 * @returns Array of inferred file paths (may be empty)
 *
 * @task T1330
 * @task T1490
 */
export function inferFilesViaGitNexus(title: string, description?: string): string[] {
  const queryText = description ? `${title} ${description}` : title;

  try {
    const output = execFileSync('gitnexus', ['query', '--json', '--limit', '5', queryText], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = JSON.parse(output);
    const files = new Set<string>();

    if (Array.isArray(result)) {
      for (const process of result) {
        if (Array.isArray(process.symbols)) {
          for (const symbol of process.symbols) {
            if (symbol.location && typeof symbol.location === 'string') {
              const match = symbol.location.match(/^([^:]+):/);
              if (match?.[1]) {
                files.add(match[1]);
              }
            }
          }
        }
        if (Array.isArray(process.files)) {
          for (const file of process.files) {
            if (typeof file === 'string') {
              files.add(file);
            }
          }
        }
      }
    }

    return Array.from(files);
  } catch {
    return [];
  }
}

/**
 * Resolve pre-dispatch inference parameters for `cleo add`.
 *
 * Performs three inference steps (each independently non-fatal):
 * 1. **File inference** — resolves explicit `--files` CSV or invokes GitNexus
 *    when `--files-infer` is set.
 * 2. **Acceptance criteria parsing** — coerces pipe-separated or JSON-array
 *    `--acceptance` strings to a string array.
 * 3. **Parent inference** — when no explicit parent is set and the task type
 *    is not `'epic'`, looks up the active session's current task and returns
 *    it as `inferredParent`.
 *
 * The function never writes to `process.stderr`; callers are responsible for
 * surfacing `filesInferWarning` and `inferredParent` notices.
 *
 * @param projectRoot - Absolute path to the project root (passed to session lookup)
 * @param input - Resolved CLI flag values
 * @returns Partial inference result; absent fields = no inference available
 *
 * @task T1490
 */
export async function inferTaskAddParams(
  projectRoot: string,
  input: InferAddParamsInput,
): Promise<InferAddParamsResult> {
  const result: InferAddParamsResult = {};

  // ─── 1. File inference ──────────────────────────────────────────────────────
  if (input.filesInfer && !input.filesRaw) {
    const inferredFiles = inferFilesViaGitNexus(input.title, input.description);
    if (inferredFiles.length > 0) {
      result.files = inferredFiles;
    } else {
      result.filesInferWarning = true;
    }
  } else if (input.filesRaw) {
    result.files = input.filesRaw.split(',').map((s) => s.trim());
  }

  // ─── 2. Acceptance criteria parsing ─────────────────────────────────────────
  if (input.acceptanceRaw) {
    result.acceptance = parseAcceptanceCriteria(input.acceptanceRaw);
  }

  // ─── 3. Parent inference from session ────────────────────────────────────────
  // Only infer when:
  //   - No explicit parent was provided (including explicit "none" — user opted out)
  //   - Task type is not 'epic' (epics are root-level containers)
  //
  // T11293: `--parent none` is an explicit opt-out from the depth-2 focused-session
  // auto-parent trap. When the current focus task is at max depth (task depth 2),
  // auto-inference would fail with E_CLEO_DEPTH_EXCEEDED. The user signals "I know
  // this will be unparented — let strict-spine handle the containment check."
  if (!input.parentRaw && input.type !== 'epic') {
    try {
      const accessor = await getTaskAccessor(projectRoot);
      const focusResult = await currentTask(undefined, accessor);
      const candidateId = focusResult.currentTask;

      if (!candidateId) {
        result.parentInference = {
          outcome: 'no-current-task',
          note: 'no --parent given and the session has no current task; no parent inferred',
        };
      } else {
        // T12136 (GH #1232/#1238) — a `current` pointer outlives its work.
        // Check the candidate is still live BEFORE adopting it, so a task is
        // never filed under work that is already finished.
        const candidate = await accessor.loadSingleTask(candidateId);
        const candidateStatus = candidate?.status;
        if (candidateStatus !== undefined && NON_INFERABLE_STATUSES.has(candidateStatus)) {
          result.parentInference = {
            outcome: 'stale-terminal',
            candidateId,
            candidateStatus,
            note:
              `no --parent given; declined to inherit ${candidateId} from the session ` +
              `pointer because it is '${candidateStatus}'. Pass --parent <id> explicitly.`,
          };
        } else {
          result.inferredParent = candidateId;
          result.parentInference = {
            outcome: 'applied',
            candidateId,
            ...(candidateStatus !== undefined ? { candidateStatus } : {}),
            note:
              `no --parent given; inherited ${candidateId} from the active session ` +
              `pointer (cleo current), not from this command`,
          };
        }
      }
    } catch (err: unknown) {
      // T12136: still non-fatal, but no longer INDISTINGUISHABLE from
      // "there is no current task". A failed lookup and an absent pointer led
      // to the same silent outcome, so a broken session looked identical to a
      // clean one.
      result.parentInference = {
        outcome: 'lookup-failed',
        note:
          'no --parent given; the session lookup for parent inference failed, so no ' +
          `parent was inferred (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  return result;
}
