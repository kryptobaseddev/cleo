/**
 * Validation for the `severity` and `kind` task-axis filters on read paths.
 *
 * Why this module exists (T12120 · GH #1245, #1246)
 * -------------------------------------------------
 * `severity` and `kind` are ADR-066 first-class axes that `cleo add` persists,
 * but neither had a read path: `cleo list --severity P0` returned every task
 * in the project, and `cleo list --severity BOGUS` did the same. A filter that
 * is accepted and then not applied **fails open** — it answers "show me only
 * the critical items" with "here is everything", which is the most dangerous
 * possible response because the result is indistinguishable from a successful
 * narrow query.
 *
 * The rule this module enforces is therefore narrower than "validate input":
 * an unrecognised filter value must never widen a result set. It must be a
 * typed `E_VALIDATION` naming the accepted values, so a typo is visible
 * immediately rather than becoming a confident wrong answer.
 *
 * Runtime validation lives here (`core/`) rather than in `contracts/` because
 * `packages/contracts/` is types-only — see AGENTS.md gate 10.
 *
 * @task T12120
 */

import type { TaskKind, TaskSeverity } from '@cleocode/contracts';
import { ExitCode, TASK_KINDS, TASK_SEVERITIES } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Shape accepted by {@link assertTaskAxisFilters} — one axis value or a list. */
export interface TaskAxisFilterInput {
  severity?: string | string[] | undefined;
  kind?: string | string[] | undefined;
}

/** Narrowed axis values, safe to hand to the query builder. */
export interface TaskAxisFilters {
  severity?: TaskSeverity[];
  kind?: TaskKind[];
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.length > 0 ? list : undefined;
}

/**
 * Validate and narrow the `severity` / `kind` filter values for a task query.
 *
 * @param input - Raw filter values as they arrive from the dispatch payload.
 * @returns Only the axes that were supplied, narrowed to their enum types.
 * @throws CleoError `E_VALIDATION` (exit 6) when any value is outside the
 *         accepted set. The message names the offending value and every
 *         accepted value, because the alternative — silently dropping the
 *         constraint — returns the whole table.
 *
 * @example
 * ```ts
 * assertTaskAxisFilters({ severity: 'P0' });      // { severity: ['P0'] }
 * assertTaskAxisFilters({ severity: 'BOGUS' });   // throws E_VALIDATION
 * assertTaskAxisFilters({});                      // {}
 * ```
 */
export function assertTaskAxisFilters(input: TaskAxisFilterInput): TaskAxisFilters {
  const out: TaskAxisFilters = {};

  const severities = asList(input.severity);
  if (severities) {
    for (const value of severities) {
      if (!(TASK_SEVERITIES as readonly string[]).includes(value)) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid --severity value '${value}'. Accepted: ${TASK_SEVERITIES.join(' | ')}.`,
          {
            fix: `Pass one of: ${TASK_SEVERITIES.join(', ')}.`,
            details: { field: 'severity', expected: [...TASK_SEVERITIES], actual: value },
          },
        );
      }
    }
    out.severity = severities as TaskSeverity[];
  }

  const kinds = asList(input.kind);
  if (kinds) {
    for (const value of kinds) {
      if (!(TASK_KINDS as readonly string[]).includes(value)) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid --kind value '${value}'. Accepted: ${TASK_KINDS.join(' | ')}.`,
          {
            fix: `Pass one of: ${TASK_KINDS.join(', ')}.`,
            details: { field: 'kind', expected: [...TASK_KINDS], actual: value },
          },
        );
      }
    }
    out.kind = kinds as TaskKind[];
  }

  return out;
}
