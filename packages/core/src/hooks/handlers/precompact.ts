/**
 * PreCompact Programmatic Hook Handler (T1013).
 *
 * Programmatic fallback for the `PreCompact` hook event that flushes
 * any pending in-flight observations to `brain.db` and checkpoints the
 * SQLite WAL *before* Claude Code's context compaction boundary.
 *
 * This handler exists as a pure-TS complement to the shell script at
 * `packages/core/templates/hooks/precompact-safestop.sh`. When the CLEO
 * hook registry is embedded inside a runtime (e.g. the `cleo daemon`,
 * SDK-hosted agents, or tests), the bash shim path is unavailable —
 * this handler guarantees the same flush + WAL-checkpoint behaviour
 * regardless of transport.
 *
 * Key contracts:
 *
 * - Runs at priority 110 so it fires **before** `brain-pre-compact`
 *   (priority 100 in `context-hooks.ts`), guaranteeing the queued
 *   observations land on disk before the compaction snapshot write.
 * - Returns a {@link PreCompactHookEnvelope} LAFS-shaped result for
 *   callers who invoke `handlePreCompactFlush` directly. The shape is
 *   `{success, data: {flushed, walCheckpointed}, meta}` on success and
 *   `{success: false, error, meta}` on failure.
 * - Never throws. All errors are captured in the returned envelope so
 *   Claude Code's compaction sequence is never interrupted by CLEO.
 * - Idempotent: a second call after a successful flush returns
 *   `{flushed: 0, walCheckpointed: <db-dependent>}` with zero errors.
 *
 * @task T1013
 * @epic T1000
 */

import { type PrecompactFlushResult, precompactFlush } from '../../memory/precompact-flush.js';
import { hooks } from '../registry.js';
import type { PreCompactPayload } from '../types.js';

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

/**
 * Success-case data payload for the pre-compact hook envelope.
 *
 * Mirrors the shape of {@link PrecompactFlushResult} but without the
 * internal `errors` array (errors surface in the envelope's `meta`
 * block via `meta.warnings` for observability).
 */
export interface PreCompactHookData {
  /** Number of observations persisted to `brain_observations`. */
  flushed: number;
  /** Whether `PRAGMA wal_checkpoint(TRUNCATE)` was executed. */
  walCheckpointed: boolean;
}

/** Error block mirroring LAFSError contract (minimal surface). */
export interface PreCompactHookError {
  /** Stable error code for downstream routing. */
  code: string;
  /** Human-readable error description. */
  message: string;
  /** Optional machine-readable details (e.g. captured error list). */
  details?: Record<string, unknown>;
}

/** Metadata block returned with every invocation. */
export interface PreCompactHookMeta {
  /** ISO 8601 timestamp when the hook finished executing. */
  timestamp: string;
  /** Absolute path to the project root the flush targeted. */
  projectRoot: string;
  /** Optional session identifier inherited from the PreCompact payload. */
  sessionId?: string;
  /**
   * Non-fatal warnings captured during flush. Populated from the
   * {@link PrecompactFlushResult}'s `errors` array so callers can observe
   * best-effort flush failures without breaking the envelope contract.
   */
  warnings: string[];
  /** Wall-clock duration of the flush in milliseconds. */
  durationMs: number;
}

/** Discriminated union envelope returned by {@link handlePreCompactFlush}. */
export type PreCompactHookEnvelope =
  | { success: true; data: PreCompactHookData; meta: PreCompactHookMeta }
  | { success: false; error: PreCompactHookError; meta: PreCompactHookMeta };

// ---------------------------------------------------------------------------
// Handler implementation
// ---------------------------------------------------------------------------

/**
 * Programmatic PreCompact hook handler.
 *
 * Delegates to {@link precompactFlush} and wraps the result in a LAFS-shaped
 * envelope. Always resolves (never throws) so the surrounding compaction
 * pipeline cannot be blocked by a CLEO failure.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - PreCompact event payload (session + token metadata).
 * @returns Resolved {@link PreCompactHookEnvelope} describing the flush.
 *
 * @example
 * ```typescript
 * const envelope = await handlePreCompactFlush('/tmp/project', {
 *   timestamp: new Date().toISOString(),
 *   sessionId: 'ses-1',
 *   tokensBefore: 120000,
 *   reason: 'auto-compact',
 * });
 * if (envelope.success) {
 *   console.log(`Flushed ${envelope.data.flushed} observations`);
 * }
 * ```
 */
export async function handlePreCompactFlush(
  projectRoot: string,
  payload: PreCompactPayload,
): Promise<PreCompactHookEnvelope> {
  const start = Date.now();

  // `precompactFlush` is itself best-effort and never throws, but we wrap in
  // a try/catch anyway so unexpected programming errors surface as a LAFS
  // failure envelope instead of a rejected promise.
  let flushResult: PrecompactFlushResult;
  try {
    flushResult = await precompactFlush(projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_PRECOMPACT_FLUSH_FAILED',
        message: `precompactFlush threw unexpectedly: ${message}`,
      },
      meta: {
        timestamp: new Date().toISOString(),
        projectRoot,
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        warnings: [],
        durationMs: Date.now() - start,
      },
    };
  }

  return {
    success: true,
    data: {
      flushed: flushResult.flushed,
      walCheckpointed: flushResult.walCheckpointed,
    },
    meta: {
      timestamp: new Date().toISOString(),
      projectRoot,
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      warnings: flushResult.errors,
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Stable hook registration ID. Exported so tests (and operators debugging
 * registry state) can look up this handler deterministically.
 */
export const PRECOMPACT_FLUSH_HOOK_ID = 'brain-precompact-flush';

/**
 * Priority of the pre-compact flush handler (110). Runs *before*
 * `brain-pre-compact` (priority 100 in `context-hooks.ts`), ensuring
 * queued observations are persisted and the WAL is checkpointed prior
 * to any observation writes triggered by the compaction boundary.
 */
export const PRECOMPACT_FLUSH_HOOK_PRIORITY = 110;

/**
 * Registry-facing adapter around {@link handlePreCompactFlush}.
 *
 * The hook registry's {@link import('../types.js').HookHandler} contract
 * requires `Promise<void>`, but we preserve the richer envelope return
 * type for programmatic callers (SDK agents, tests, orchestrators). The
 * adapter simply awaits the envelope, discards the return value, and
 * resolves — the envelope's own error capture guarantees the flush is
 * best-effort regardless of transport.
 */
export async function precompactHookRegistryAdapter(
  projectRoot: string,
  payload: PreCompactPayload,
): Promise<void> {
  await handlePreCompactFlush(projectRoot, payload);
}

hooks.register({
  id: PRECOMPACT_FLUSH_HOOK_ID,
  event: 'PreCompact',
  handler: precompactHookRegistryAdapter,
  priority: PRECOMPACT_FLUSH_HOOK_PRIORITY,
});
