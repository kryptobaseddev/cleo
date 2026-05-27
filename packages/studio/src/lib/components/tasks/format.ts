/**
 * Shared formatting helpers for the Task Explorer components.
 *
 * Extracted from four places that currently duplicate the same logic:
 *   - `routes/tasks/+page.svelte:142-181`
 *   - `routes/tasks/pipeline/+page.svelte:12-45`
 *   - `routes/tasks/graph/+page.svelte:39-65`
 *   - `routes/tasks/tree/[epicId]/+page.svelte:57-90`
 *
 * Consolidated per T950 so the new 3-tab Task Explorer (T953/T954/T955)
 * and the preserved `/tasks` dashboard all share one source of truth for
 * status colour, priority colour, gate extraction and relative time
 * rendering.
 *
 * ## Theme tokens
 *
 * Colours mirror the dark palette used by the standalone viz reference at
 * `/tmp/task-viz/index.html` and the current Studio `/tasks/*` pages:
 *
 * | Status     | Colour  | Token (viz) |
 * | ---------- | ------- | ----------- |
 * | pending    | #f59e0b | --pending   |
 * | active     | #3b82f6 | --in-progress |
 * | blocked    | #ef4444 | --blocked   |
 * | done       | #22c55e | --done      |
 * | cancelled  | #6b7280 | --cancelled |
 * | archived   | #475569 | --text-faint |
 * | proposed   | #a855f7 | --accent    |
 *
 * @task T950
 * @epic T949
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Short glyph used to render a task status inline.
 *
 * @param s - Task status.
 * @returns A single-character glyph matching the legacy Studio pipeline UI.
 */
export function statusIcon(s: TaskStatus): string {
  if (s === 'done') return '✓';
  if (s === 'active') return '●';
  if (s === 'blocked') return '✗';
  if (s === 'cancelled') return '⊘';
  if (s === 'archived') return '◌';
  if (s === 'proposed') return '◆';
  return '○';
}

/**
 * Semantic CSS class for a task status. Matches the tokens
 * defined in {@link StatusBadge} and the legacy `/tasks/*` pages.
 *
 * @param s - Task status.
 * @returns CSS class name in the `status-<name>` family.
 */
export function statusClass(s: TaskStatus): string {
  return `status-${s}`;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Semantic CSS class for a task priority. Matches the tokens defined in
 * {@link PriorityBadge} and the legacy `/tasks/*` pages.
 *
 * @param p - Task priority.
 * @returns CSS class name in the `priority-<name>` family.
 */
export function priorityClass(p: TaskPriority): string {
  return `priority-${p}`;
}

// ---------------------------------------------------------------------------
// Verification gates (I / T / Q)
// ---------------------------------------------------------------------------

/**
 * Tri-gate payload used by the card + drawer renderers.
 *
 * @property implemented - Implemented gate passed.
 * @property testsPassed - Tests gate passed.
 * @property qaPassed - QA gate passed.
 */
export interface GatesPassed {
  implemented: boolean;
  testsPassed: boolean;
  qaPassed: boolean;
}

/**
 * Extract the I / T / Q gate booleans from a raw `verification_json` string.
 *
 * Mirrors the behaviour of the three duplicate inline helpers in the current
 * `/tasks/*` pages — returns a safe all-false result on parse failure so the
 * UI renders grey dots instead of crashing.
 *
 * @param json - Raw JSON string from `tasks.verification_json`, or `null`.
 * @returns Object with `implemented`, `testsPassed`, `qaPassed` flags.
 */
export function gatesFromJson(json: string | null | undefined): GatesPassed {
  if (!json) return { implemented: false, testsPassed: false, qaPassed: false };
  try {
    const parsed = JSON.parse(json) as { gates?: Record<string, boolean | null> };
    const gates = parsed.gates ?? {};
    return {
      implemented: gates['implemented'] === true,
      testsPassed: gates['testsPassed'] === true,
      qaPassed: gates['qaPassed'] === true,
    };
  } catch {
    return { implemented: false, testsPassed: false, qaPassed: false };
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Relative "Xm ago / Xh ago / Xd ago" rendering of an ISO timestamp.
 *
 * Matches the legacy `formatTime()` in the `/tasks` dashboard so the
 * Recent Activity feed stays visually identical post-extraction.
 *
 * @param iso - ISO 8601 timestamp string.
 * @param now - Optional timestamp to compare against (for testing). Defaults to `Date.now()`.
 * @returns Short relative-time string, or the original input on parse failure.
 */
export function formatTime(iso: string, now: number = Date.now()): string {
  try {
    const d = new Date(iso);
    const diff = now - d.getTime();
    if (Number.isNaN(diff)) return iso;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Compute a 0-100 integer progress percentage.
 *
 * @param done - Count of completed children.
 * @param total - Total count of children.
 * @returns Integer percent (0-100). Returns 0 when `total` is 0.
 */
export function progressPct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}
