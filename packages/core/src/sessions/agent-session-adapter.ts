/**
 * CLEO wrapper around `llmtxt/sdk.AgentSession` — T947 Step 2.
 *
 * Satisfies owner Constraint #4 (zero primitive duplication) per GitHub
 * issue #96: CLEO no longer rolls its own session-level audit receipts,
 * crypto-random session IDs, or manual state-transition writes. Those
 * primitives come from llmtxt's {@link AgentSession}, and this module
 * only adapts them to CLEO's project layout.
 *
 * Responsibilities:
 *   - Open an {@link AgentSession} backed by a lightweight `standalone`
 *     llmtxt backend scoped to `<projectRoot>/.cleo/llmtxt/`, ONLY when
 *     llmtxt's optional peer dependencies (`better-sqlite3`,
 *     `drizzle-orm/better-sqlite3`) are installed.
 *   - Wrap a caller-provided async unit of work in `session.contribute()`
 *     so the receipt's `eventCount` and (optionally) `documentIds` are
 *     populated with programmatic proof.
 *   - Close the session and emit a {@link ContributionReceipt}. The
 *     receipt is appended to `.cleo/audit/receipts.jsonl` alongside the
 *     existing ADR-051 evidence trail (`.cleo/audit/gates.jsonl`,
 *     `.cleo/audit/force-bypass.jsonl`) so all tamper-evident records
 *     live in one place on disk.
 *   - Degrade gracefully when llmtxt peer deps are absent: every entry
 *     point resolves to `{ result, receipt: null }` and NEVER throws,
 *     so `cleo complete` / `cleo session` behaviour is unchanged in
 *     minimal environments.
 *
 * Non-goals:
 *   - Remote sync. We intentionally choose `topology: 'standalone'` so
 *     the backend is a per-project SQLite file with zero network
 *     surface. Cross-machine receipt replication is a Wave B concern.
 *   - Replacing the existing CLEO `Session` record in `tasks.db`. This
 *     adapter runs ALONGSIDE `startSession` / `endSession`; CLEO owns
 *     session metadata, llmtxt owns the signed receipt.
 *
 * @task T947
 * @adr ADR-051 (Gate Integrity & Evidence) — receipts are the session-
 *      level companion to per-gate audit records.
 * @see packages/core/src/tasks/gate-audit.ts
 * @see packages/core/src/store/llmtxt-blob-adapter.ts (mirror peer-dep
 *      lazy-load pattern)
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import type { AgentSession, ContributionReceipt } from 'llmtxt/sdk';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Options for opening / wrapping a CLEO AgentSession.
 *
 * `sessionId` and `agentId` SHOULD match the values CLEO persists in
 * `tasks.db` so downstream correlation between a CLEO session row and
 * its signed receipt is trivial.
 */
export interface AgentSessionAdapterOptions {
  /**
   * CLEO session id (e.g. `session-1712345678-a1b2c3`). When supplied
   * it is passed straight through to {@link AgentSession}; otherwise
   * llmtxt generates a `crypto.randomUUID()` sessionId.
   */
  readonly sessionId?: string;

  /**
   * Agent identifier. Falls back to `CLEO_AGENT_ID` env, then `"cleo"`.
   * Used by llmtxt as the authenticated agent on every contribute() write
   * and embedded verbatim into the receipt.
   */
  readonly agentId?: string;

  /**
   * Absolute project root — the directory that contains `.cleo/`. All
   * llmtxt data lives under `<projectRoot>/.cleo/llmtxt/` and all
   * receipts under `<projectRoot>/.cleo/audit/receipts.jsonl`.
   *
   * Defaults to `process.cwd()`.
   */
  readonly projectRoot?: string;

  /**
   * Human-readable label for the session (surfaced in receipts and
   * operator tooling). Defaults to `<agentId> <ISO-timestamp>` via
   * the AgentSession default.
   */
  readonly label?: string;
}

/**
 * Opaque handle returned by {@link openAgentSession}. Callers MUST pass
 * the same handle to {@link closeAgentSession}; treating the inner
 * `session` field as public API is UNSUPPORTED and WILL break when
 * llmtxt tightens its visibility rules.
 */
export interface AgentSessionHandle {
  /** The underlying llmtxt AgentSession. */
  readonly session: AgentSession;
  /** Absolute project root used for receipt persistence. */
  readonly projectRoot: string;
  /**
   * Tear-down hook registered with the llmtxt backend. MUST be invoked
   * after `session.close()` to release SQLite handles and reapers.
   */
  readonly closeBackend: () => Promise<void>;
}

/**
 * Result envelope returned by {@link wrapWithAgentSession}.
 *
 * `receipt` is `null` when llmtxt peer deps are absent or when session
 * open/close degraded to a no-op. Callers MUST handle the null case
 * (the original `result` is always present when the wrapped fn
 * completed successfully).
 *
 * @typeParam T - Return type of the wrapped function.
 */
export interface WrappedResult<T> {
  /** Return value of the wrapped async function. */
  readonly result: T;
  /** llmtxt ContributionReceipt, or `null` if peer deps were absent. */
  readonly receipt: ContributionReceipt | null;
}

/**
 * Resolve the absolute path of the receipts audit log.
 *
 * Mirrors the shape of {@link getGateAuditPath} so operators can glob
 * `.cleo/audit/*.jsonl` to find every ADR-051 artifact.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to `.cleo/audit/receipts.jsonl`.
 *
 * @task T947
 * @adr ADR-051 §6
 */
export function getReceiptsAuditPath(projectRoot: string): string {
  return resolvePath(projectRoot, '.cleo', 'audit', 'receipts.jsonl');
}

/**
 * Open an llmtxt AgentSession, or return `null` if llmtxt peer deps are
 * absent. NEVER throws — peer-dep failure, filesystem failure, and
 * backend-open failure all degrade to `null` and are logged at debug.
 *
 * The returned handle MUST be closed via {@link closeAgentSession} to
 * flush the receipt and release SQLite handles.
 *
 * @param options - Session options (see {@link AgentSessionAdapterOptions}).
 * @returns A handle, or `null` when the adapter cannot be initialised.
 *
 * @task T947
 */
export async function openAgentSession(
  options: AgentSessionAdapterOptions = {},
): Promise<AgentSessionHandle | null> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const agentId = options.agentId ?? process.env.CLEO_AGENT_ID ?? 'cleo';

  let createBackendFn: typeof import('llmtxt').createBackend;
  let AgentSessionCtor: typeof import('llmtxt/sdk').AgentSession;
  try {
    const [llmtxtMod, sdkMod] = await Promise.all([import('llmtxt'), import('llmtxt/sdk')]);
    createBackendFn = llmtxtMod.createBackend;
    AgentSessionCtor = sdkMod.AgentSession;
  } catch {
    // llmtxt itself not resolvable — caller is in a stripped-down env.
    return null;
  }

  let backend: Awaited<ReturnType<typeof createBackendFn>>;
  try {
    backend = await createBackendFn({
      topology: 'standalone',
      storagePath: resolvePath(projectRoot, '.cleo', 'llmtxt'),
    });
    await backend.open();
  } catch {
    // Most common failure: `better-sqlite3` / `drizzle-orm/better-sqlite3`
    // are optional peers of llmtxt and may be absent. Degrade silently.
    return null;
  }

  try {
    const session = new AgentSessionCtor({
      backend,
      agentId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.label ? { label: options.label } : {}),
    });
    await session.open();
    return {
      session,
      projectRoot,
      closeBackend: async () => {
        // llmtxt's Backend exposes close(); we ignore failures so the
        // adapter remains best-effort under teardown.
        try {
          await backend.close();
        } catch {
          /* best-effort */
        }
      },
    };
  } catch {
    // Session open failed after backend was alive — try to release it.
    await backend.close().catch(() => {
      /* best-effort */
    });
    return null;
  }
}

/**
 * Close a previously-opened AgentSession and persist the receipt.
 *
 * Behaviour:
 *   - Calls `session.close()` which emits a {@link ContributionReceipt}
 *     (llmtxt handles all state transitions and Ed25519 signing once
 *     llmtxt T461 ships).
 *   - Appends the receipt to `.cleo/audit/receipts.jsonl` as a single
 *     JSON line (matches `.cleo/audit/gates.jsonl`).
 *   - Returns the receipt so callers (e.g. `cleo complete`) can surface
 *     `receiptId` on the CLI envelope.
 *   - Swallows `SESSION_CLOSE_PARTIAL` errors: the partial receipt is
 *     still returned and persisted, matching llmtxt's best-effort
 *     close contract.
 *   - Returns `null` on any unexpected throw so teardown NEVER breaks
 *     the caller.
 *
 * @param handle - Handle previously returned by {@link openAgentSession}.
 * @returns The emitted receipt, or `null` on failure.
 *
 * @task T947
 * @adr ADR-051 §6
 */
export async function closeAgentSession(
  handle: AgentSessionHandle,
): Promise<ContributionReceipt | null> {
  let receipt: ContributionReceipt | null = null;
  try {
    receipt = await handle.session.close();
  } catch (err) {
    // SESSION_CLOSE_PARTIAL carries the receipt on the error object.
    // See llmtxt/sdk/session.ts (AgentSessionError.receipt).
    const maybePartial = err as { receipt?: ContributionReceipt };
    if (maybePartial?.receipt !== undefined) {
      receipt = maybePartial.receipt;
    } else {
      receipt = null;
    }
  }

  if (receipt !== null) {
    try {
      await persistReceipt(handle.projectRoot, receipt);
    } catch {
      /* Best-effort — receipt is still returned to caller. */
    }
  }

  await handle.closeBackend();
  return receipt;
}

/**
 * Wrap an async function inside an AgentSession, returning both the
 * function's result and a persisted receipt (when peer deps allow).
 *
 * Contract:
 *   - The wrapped `fn` ALWAYS runs. Its result is returned verbatim on
 *     success, and its thrown error is re-thrown verbatim on failure.
 *   - When peer deps are present, `fn` is invoked inside
 *     {@link AgentSession.contribute}, so its returned object is
 *     scanned for `documentId` / `documentIds` fields (see llmtxt spec
 *     §3.3) and eventCount is incremented.
 *   - When peer deps are absent, `fn` runs unwrapped and the returned
 *     `receipt` is `null`.
 *   - On error, no receipt is emitted (the session is closed with
 *     zero eventCount — llmtxt spec §3.3 MUST NOT increment on error).
 *     The error propagates.
 *
 * @typeParam T - Return type of the wrapped function.
 * @param options - Adapter options (see {@link AgentSessionAdapterOptions}).
 * @param fn - The async work unit to wrap.
 * @returns An envelope with `result` (always present on success) and
 *          `receipt` (null when peer deps unavailable).
 *
 * @example
 * ```ts
 * const { result, receipt } = await wrapWithAgentSession(
 *   { sessionId, agentId: 'cleo', projectRoot: '/repo' },
 *   async () => {
 *     return applyTaskCompletion(task);
 *   },
 * );
 * if (receipt) console.log(receipt.sessionId, receipt.eventCount);
 * ```
 *
 * @task T947
 * @adr ADR-051 §6
 */
export async function wrapWithAgentSession<T>(
  options: AgentSessionAdapterOptions,
  fn: () => Promise<T>,
): Promise<WrappedResult<T>> {
  const handle = await openAgentSession(options);

  if (handle === null) {
    // Peer deps absent or backend init failed — run unwrapped.
    const result = await fn();
    return { result, receipt: null };
  }

  let result: T;
  try {
    // contribute() re-throws caller errors after leaving eventCount
    // unchanged (llmtxt spec §3.3). We mirror that: propagate the
    // error AFTER attempting to close the session with zero work.
    result = await handle.session.contribute(async () => fn());
  } catch (err) {
    // Close the session to release presence / backend handles, but
    // do NOT persist a receipt for a failed run — matches llmtxt
    // spec §3.3 (eventCount is zero, so the receipt is empty).
    await handle.session.close().catch(() => {
      /* best-effort */
    });
    await handle.closeBackend();
    throw err;
  }

  const receipt = await closeAgentSession(handle);
  return { result, receipt };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Append a {@link ContributionReceipt} to `.cleo/audit/receipts.jsonl`.
 *
 * Creates the audit directory on first use. Serialises the receipt as
 * a single JSON line so the file remains valid JSON-lines.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param receipt - Receipt emitted by {@link AgentSession.close}.
 *
 * @internal
 * @task T947
 */
async function persistReceipt(projectRoot: string, receipt: ContributionReceipt): Promise<void> {
  const path = getReceiptsAuditPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(receipt)}\n`;
  await appendFile(path, line, { encoding: 'utf-8' });
}
