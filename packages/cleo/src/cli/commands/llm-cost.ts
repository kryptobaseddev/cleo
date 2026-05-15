/**
 * CLI handler: `cleo llm cost <session-id>`
 *
 * Computes the cumulative USD cost for a given session by reading
 * `token_usage` records from the project tasks.db, filtering by
 * `session_id`, and summing costs via {@link computeCost}.
 *
 * ## Data-source note (ADR-072 Wave 4b)
 *
 * The `token_usage` table is the canonical persistence layer for token
 * telemetry. In the current deployment the LlmExecutor done-event emitter is
 * not yet wired to write rows (ADR-072 Wave 4b pending). As a result most
 * sessions will return `recordCount: 0` and `totalUsd: 0`. The CLI surface
 * exists and is correct; rows will appear automatically once Wave 4b lands.
 *
 * Use `"current"` as the session-id to resolve to the active session from
 * the `CLEO_SESSION_ID` environment variable (set by `cleo session start`).
 *
 * @task T9274
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 * @see ADR-072 Wave 4b — live usage wiring at LlmExecutor done event
 */

import { getProjectRoot } from '@cleocode/core/internal';
import { type CanonicalUsage, computeCost } from '@cleocode/core/llm/usage-pricing';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single cost breakdown entry — one row from the `token_usage` table
 * together with its computed USD cost.
 *
 * @task T9274
 */
export interface LlmCostBreakdownEntry {
  /** Row identifier. */
  id: string;
  /** Provider name (e.g. `anthropic`, `openai`). */
  provider: string;
  /** Model identifier used for pricing lookup. */
  model: string | null;
  /** Canonical usage extracted from the row. */
  usage: CanonicalUsage;
  /** Computed USD cost for this row (USD). */
  costUsd: number;
  /** ISO timestamp when the row was recorded. */
  createdAt: string;
}

/**
 * Aggregate cost result returned by the `cleo llm cost` subcommand.
 *
 * @task T9274
 */
export interface LlmCostResult {
  /** Session identifier queried. */
  sessionId: string;
  /** Total USD cost across all records. */
  totalUsd: number;
  /** Number of token_usage records found for the session. */
  recordCount: number;
  /** Per-record breakdown sorted by createdAt ascending. */
  breakdown: LlmCostBreakdownEntry[];
  /**
   * Informational note when no records are found — indicates that the
   * live usage wiring is pending ADR-072 Wave 4b (LlmExecutor done event).
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the raw session-id CLI argument.
 *
 * Accepts `"current"` as a shorthand for the `CLEO_SESSION_ID` environment
 * variable (populated by `cleo session start`). Falls back to the literal
 * string `"current"` when no session is active so that the DB query still
 * runs and produces an honest empty result.
 *
 * @param raw - Raw positional argument from citty.
 * @returns Resolved session id string.
 *
 * @task T9274
 */
function resolveSessionId(raw: string): string {
  if (raw === 'current') {
    const envId = process.env['CLEO_SESSION_ID'];
    if (envId) return envId;
    // No active session — fall through with 'current'; DB query returns 0 rows.
    return 'current';
  }
  return raw;
}

/**
 * Query token_usage rows for a session and compute per-row USD costs.
 *
 * The `listTokenUsage` function is imported lazily (inside this async function)
 * to keep CLI startup fast and to avoid circular module dependencies — the
 * same pattern used by other `cleo llm` subcommands.
 *
 * Returns an empty array when no rows exist. This is the expected state until
 * ADR-072 Wave 4b wires the LlmExecutor done-event to write rows.
 *
 * @param projectRoot - Absolute path to the project root (`.cleo` parent).
 * @param sessionId   - Session identifier to filter by.
 * @returns Cost breakdown entries sorted by `createdAt` ascending.
 *
 * @task T9274
 * @see ADR-072 Wave 4b
 */
async function loadSessionCostBreakdown(
  projectRoot: string,
  sessionId: string,
): Promise<LlmCostBreakdownEntry[]> {
  const { listTokenUsage } = await import(/* webpackIgnore: true */ '@cleocode/core/internal');

  const result = await listTokenUsage(projectRoot, {
    sessionId,
    limit: 1000, // Practical upper bound for a single session.
  });

  const entries: LlmCostBreakdownEntry[] = result.records.map(
    (row: {
      id: string;
      provider: string;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      createdAt: string;
    }) => {
      const usage: CanonicalUsage = {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      };
      const model = row.model ?? 'unknown';
      return {
        id: row.id,
        provider: row.provider,
        model: row.model,
        usage,
        costUsd: computeCost(usage, model),
        createdAt: row.createdAt,
      };
    },
  );

  // Chronological order for a readable breakdown.
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * `cleo llm cost <session-id>` — compute cumulative session LLM cost.
 *
 * Reads `token_usage` rows from the project `tasks.db` filtered by the given
 * session-id, computes per-row USD cost via {@link computeCost} +
 * {@link PRICING_SNAPSHOT}, and emits a LAFS-envelope result.
 *
 * @example
 * ```
 * # Query a specific session
 * cleo llm cost sess_abc123
 *
 * # Query the currently active session
 * cleo llm cost current
 *
 * # Machine-readable JSON output
 * cleo llm cost current --json
 * ```
 *
 * @task T9274
 * @epic T9261
 * @see ADR-072 Wave 4b — live LlmExecutor usage wiring (pending)
 */
export const costCommand = defineCommand({
  meta: {
    name: 'cost',
    description:
      'Compute cumulative USD cost for an LLM session from recorded token_usage entries. ' +
      'Use "current" to resolve the active session from CLEO_SESSION_ID. ' +
      'Returns totalUsd=0 when no usage records exist yet (ADR-072 Wave 4b pending).',
  },
  args: {
    sessionId: {
      type: 'positional',
      description: 'Session id to query, or "current" for the active session',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const rawSessionId = String(a['sessionId'] ?? '');

    if (!rawSessionId) {
      cliError('session-id is required', 6, {
        name: 'E_VALIDATION',
        fix: 'Provide a session id or "current": cleo llm cost <session-id>',
      });
      process.exit(6);
    }

    const sessionId = resolveSessionId(rawSessionId);
    const projectRoot = getProjectRoot(process.cwd());

    let breakdown: LlmCostBreakdownEntry[];
    try {
      breakdown = await loadSessionCostBreakdown(projectRoot, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`Failed to query token_usage: ${message}`, 1, {
        name: 'E_QUERY_FAILED',
        fix: 'Ensure tasks.db is initialized: cleo session start',
      });
      process.exit(1);
    }

    const totalUsd = breakdown.reduce((sum, entry) => sum + entry.costUsd, 0);

    const result: LlmCostResult = {
      sessionId,
      totalUsd,
      recordCount: breakdown.length,
      breakdown,
    };

    if (breakdown.length === 0) {
      result.note =
        'No token_usage records found for this session. ' +
        'Live usage wiring is pending ADR-072 Wave 4b (LlmExecutor done event). ' +
        'Records will appear automatically once that wave ships.';
    }

    cliOutput(result, {
      command: 'llm-cost',
      operation: 'llm.cost',
    });
  },
});
