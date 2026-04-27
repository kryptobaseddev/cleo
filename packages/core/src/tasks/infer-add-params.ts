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
import { getAccessor } from '../store/data-accessor.js';
import { currentTask } from '../task-work/index.js';

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
}

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
 * Parse acceptance criteria from a raw CLI string.
 *
 * Supports two formats:
 * - JSON array: `'["AC1","AC2","AC3"]'`
 * - Pipe-separated: `"AC1|AC2|AC3"`
 *
 * @param raw - Raw string from `--acceptance` flag
 * @returns Array of trimmed, non-empty acceptance criteria strings
 *
 * @task T1490
 */
export function parseAcceptanceCriteria(raw: string): string[] {
  if (raw.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((s: unknown) => String(s).trim()).filter(Boolean);
      }
    } catch {
      // Not valid JSON — fall through to pipe-delimited parsing
    }
  }
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
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
  //   - No explicit parent was provided
  //   - Task type is not 'epic' (epics are root-level containers)
  if (!input.parentRaw && input.type !== 'epic') {
    try {
      const accessor = await getAccessor(projectRoot);
      const focusResult = await currentTask(undefined, accessor);
      if (focusResult.currentTask) {
        result.inferredParent = focusResult.currentTask;
      }
    } catch {
      // Session lookup is non-fatal — proceed without inference
    }
  }

  return result;
}
