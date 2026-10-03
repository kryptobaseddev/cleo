/**
 * Per-agent spawn identity allocation (T11343 · Epic T11284 · SG-COGNITIVE-SUBSTRATE).
 *
 * FOUNDATION primitive that dissolves BOTH multi-agent session-bleed AND
 * memory scope-leakage. Before this module, every spawn threaded the
 * orchestrator's `getActiveSession()` id into the subagent prompt + isolation
 * shell, so every short-lived `cleo` call inside a worktree collapsed onto
 * "whoever touched the DB last". This module gives each spawned agent its OWN
 * session bound to a deterministic `agentHandle`, so `resolveSessionIdFromEnv()`
 * (the env-first resolver) returns the agent's own identity.
 *
 * The handle is derived deterministically from the task id so re-spawning the
 * same task (e.g. `--resume`) reuses the existing per-agent session rather than
 * leaking a fresh session row on every spawn.
 *
 * @task T11343
 * @epic T11284
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { getErrorDefinition } from '../error-catalog.js';
import { CleoError } from '../errors.js';
import { generateSessionId } from '../sessions/session-id.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { withLock } from '../store/lock.js';
import { endSession } from '../store/session-store.js';
import {
  claimSpawnedTask,
  releaseSpawnClaim,
  type SpawnClaimReceipt,
} from '../task-work/claims.js';

/**
 * Resolved per-agent spawn identity returned by {@link allocateSpawnSession}.
 *
 * @task T11343
 */
export interface SpawnAgentIdentity {
  /** The per-agent CLEO session id to inject as `CLEO_SESSION_ID`. */
  sessionId: string;
  /** The per-agent identity handle to inject as `CLEO_AGENT_ID`. */
  agentId: string;
  /** The deterministic agent handle bound to the session row. */
  agentHandle: string;
  /**
   * `true` when an existing same-handle active session was reused, `false`
   * when a fresh per-agent session row was created.
   */
  reused: boolean;
}

/**
 * Derive a deterministic agent handle for a spawned task.
 *
 * The handle is stable across re-spawns of the same task so the per-agent
 * session is reused rather than re-created. Lower-cased to match the
 * `cleo-agent-<task>` peer-id convention used elsewhere in the spawn pipeline.
 *
 * @param taskId - The task being spawned (e.g. `"T1234"`).
 * @returns Deterministic handle (e.g. `"agent-t1234"`).
 * @task T11343
 */
export function deriveAgentHandle(taskId: string): string {
  return `agent-${taskId.toLowerCase()}`;
}

/**
 * Allocate (or reuse) a per-agent session for a spawned task.
 *
 * Resolution order:
 * 1. If an active session already carries the derived `agentHandle`, reuse it
 *    (idempotent across `--resume` / re-spawn). `reused: true`.
 * 2. Otherwise create a fresh `active` session row bound to the handle and
 *    return its id. `reused: false`.
 *
 * The orchestrator's own session is NEVER returned — that is the bleed the
 * Epic exists to eliminate. The returned `sessionId` is what the spawn pipeline
 * injects as `CLEO_SESSION_ID` into the isolation shell.
 *
 * Throws when the session row cannot be read or written. Spawn callers go
 * through {@link requireSpawnSession}, which turns that into a refusal: a
 * spawned agent never inherits the orchestrator's session (T12500).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId      - The task being spawned.
 * @param opts.scope  - Session scope string (defaults to `"global"`).
 * @returns The allocated/reused per-agent identity.
 * @task T11343
 */
export async function allocateSpawnSession(
  projectRoot: string,
  taskId: string,
  opts: { scope?: string } = {},
): Promise<SpawnAgentIdentity> {
  const agentHandle = deriveAgentHandle(taskId);
  const accessor = await getTaskAccessor(projectRoot);

  // T12506 — steps (1)+(2) are check-then-insert. Two concurrent spawns of one
  // task both missed in (1) and both inserted, yielding two "own" sessions for
  // one agent handle. Serialise them with a cross-process file lock keyed by
  // the handle so exactly one inserts and every other allocator reuses it.
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  return withLock(
    join(cleoDir, `spawn-session.${agentHandle}`),
    async () => {
      // (1) Reuse an existing active session for this exact handle.
      const sessions = await accessor.loadSessions();
      const existing = electSpawnSession(
        sessions.filter((s: Session) => s.status === 'active' && s.agentHandle === agentHandle),
      );
      if (existing) {
        return { sessionId: existing.id, agentId: agentHandle, agentHandle, reused: true };
      }

      // (2) Create a fresh per-agent session row bound to the handle.
      const now = new Date().toISOString();
      const sessionId = generateSessionId();
      const session: Session = {
        id: sessionId,
        name: `spawn-${agentHandle}`,
        status: 'active',
        scope: { type: opts.scope === 'global' || !opts.scope ? 'global' : opts.scope },
        taskWork: { taskId, setAt: now },
        startedAt: now,
        lastActivity: now,
        agentHandle,
        agentIdentifier: agentHandle,
        scopeKind: 'global',
        scopeId: null,
        resumeCount: 0,
      };
      await accessor.upsertSingleSession(session);
      return { sessionId, agentId: agentHandle, agentHandle, reused: false };
    },
    { retries: 30 },
  );
}

/**
 * Deterministically pick the canonical per-agent session among concurrent
 * candidates: earliest `startedAt`, ties broken by the smallest id, so
 * duplicate rows left by allocations made before T12506 resolve to one
 * session deterministically.
 *
 * @param candidates - Active sessions bound to one agent handle.
 * @returns The elected session, or `undefined` when there are none.
 * @task T12506
 */
export function electSpawnSession(candidates: readonly Session[]): Session | undefined {
  return [...candidates].sort((a, b) =>
    a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt.localeCompare(b.startedAt),
  )[0];
}

/** Outcome of {@link requireSpawnSession}: an explicit per-agent session, or a refusal. */
export type SpawnSessionResolution =
  | {
      readonly ok: true;
      readonly identity: SpawnAgentIdentity;
      /**
       * The task claim this spawn took (T12502). Pass the resolution to
       * {@link abandonSpawnSession} when the spawn fails after this point.
       */
      readonly claim: SpawnClaimReceipt;
    }
  | {
      readonly ok: false;
      /**
       * The REAL failure's LAFS code (T12500 review): a `CleoError` keeps its
       * catalog code (e.g. `E_CLEO_LOCK_TIMEOUT`); anything else — a SQLite or
       * I/O failure — is `E_INTERNAL`. Never relabelled `E_SESSION_UNBOUND`.
       */
      readonly code: string;
      /** Numeric exit code matching {@link code}. */
      readonly exitCode: number;
      readonly message: string;
      readonly fix: string;
      /** Why allocation (or the task claim) failed. */
      readonly cause: string;
      /**
       * Structured refusal details — for `E_TASK_CLAIMED`, the
       * `TaskClaimedDetails` naming the holder and lease expiry (T12502).
       */
      readonly details?: Record<string, unknown>;
    };

/**
 * Allocate the spawned agent's OWN session, or refuse the spawn (T12500 · epic T12497).
 *
 * Before T12500 both spawn paths caught an allocation failure and fell back to
 * `getActiveSession()` — the newest active row, i.e. usually the ORCHESTRATOR's
 * session — and injected it as the child's `CLEO_SESSION_ID`. The child then
 * ended, attributed to and focused the orchestrator's session. There is no
 * safe session to guess, so a failed allocation now fails the spawn, carrying
 * the underlying store error rather than falling back.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId - The task being spawned.
 * T12502: the spawned session then takes the task's claim lease
 * ({@link claimSpawnedTask}). Another session's claim refuses the spawn with
 * `E_TASK_CLAIMED` naming the holder, and a session created for this refused
 * spawn is ended again so it does not leak.
 *
 * @param allocate - Allocation strategy (defaults to {@link allocateSpawnSession}; tests inject failures).
 * @returns The explicit per-agent identity, or a typed refusal.
 * @task T12500
 * @task T12502
 */
export async function requireSpawnSession(
  projectRoot: string,
  taskId: string,
  allocate: (root: string, id: string) => Promise<SpawnAgentIdentity> = allocateSpawnSession,
): Promise<SpawnSessionResolution> {
  let identity: SpawnAgentIdentity;
  try {
    identity = await allocate(projectRoot, taskId);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const cleoDef = err instanceof CleoError ? getErrorDefinition(err.code) : undefined;
    return {
      ok: false,
      code: cleoDef?.lafsCode ?? 'E_INTERNAL',
      exitCode: err instanceof CleoError ? err.code : ExitCode.GENERAL_ERROR,
      message:
        `Could not allocate a session for spawned task ${taskId}: ${cause}. ` +
        "Refusing to hand it the orchestrator's session.",
      fix:
        "Check the task store with 'cleo doctor', then retry the spawn. A spawned agent " +
        "always runs under its own session (CLEO_SESSION_ID), never the orchestrator's.",
      cause,
    };
  }
  let claim: SpawnClaimReceipt;
  try {
    claim = await claimSpawnedTask(projectRoot, taskId, {
      sessionId: identity.sessionId,
      agentId: identity.agentId,
    });
  } catch (err) {
    if (!identity.reused) {
      await endSession(identity.sessionId, 'spawn refused: task claimed', projectRoot).catch(
        () => undefined,
      );
    }
    const cause = err instanceof Error ? err.message : String(err);
    const cleo = err instanceof CleoError ? err : undefined;
    return {
      ok: false,
      code: (cleo && getErrorDefinition(cleo.code)?.lafsCode) ?? 'E_INTERNAL',
      exitCode: cleo?.code ?? ExitCode.GENERAL_ERROR,
      message: `Refusing to spawn ${taskId}: ${cause}`,
      fix: cleo?.fix ?? "Check the task store with 'cleo doctor', then retry the spawn.",
      cause,
      ...(cleo?.details ? { details: cleo.details } : {}),
    };
  }
  return { ok: true, identity, claim };
}

/**
 * Undo a {@link requireSpawnSession} whose spawn then failed (T12502): give
 * the task claim back to its previous holder (the orchestrator on a
 * hand-off) and end the per-agent session if this spawn created it, so a
 * failed spawn strands neither a lease nor an active session. A re-spawn's
 * reused session and its own earlier lease are kept. Best-effort.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId - The task whose spawn failed.
 * @param resolution - The successful resolution returned for this spawn.
 * @task T12502
 */
export async function abandonSpawnSession(
  projectRoot: string,
  taskId: string,
  resolution: Extract<SpawnSessionResolution, { ok: true }>,
): Promise<void> {
  const { identity, claim } = resolution;
  await releaseSpawnClaim(projectRoot, taskId, identity.sessionId, claim);
  if (!identity.reused) {
    await endSession(identity.sessionId, 'spawn failed before dispatch', projectRoot).catch(
      () => undefined,
    );
  }
}
