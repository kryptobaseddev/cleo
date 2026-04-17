/**
 * Atomicity enforcement for thin-agent / ORC-006 compliance.
 *
 * Workers are defined as atomic if they touch ≤ {@link MAX_WORKER_FILES} files
 * with an explicit AC.files declaration. This prevents workers from
 * accidentally becoming sprawling lead-scope work and keeps audit trails
 * reviewable.
 *
 * Orchestrator and lead roles are not subject to this gate — they are
 * explicitly allowed broader scope by design.
 *
 * @task T889 Orchestration Coherence v3
 * @task T894 Atomicity guard (W3-3)
 */

import type { AgentSpawnCapability } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';

/**
 * Maximum number of files a worker-role task may declare before it must be
 * split into subtasks or promoted to a lead role.
 */
export const MAX_WORKER_FILES = 3;

/**
 * Stable LAFS error codes emitted by {@link checkAtomicity}.
 *
 * - `E_ATOMICITY_VIOLATION` — worker declared more than {@link MAX_WORKER_FILES}
 *   files.
 * - `E_ATOMICITY_NO_SCOPE` — worker did not declare any files (missing
 *   AC.files).
 */
export type AtomicityErrorCode = 'E_ATOMICITY_VIOLATION' | 'E_ATOMICITY_NO_SCOPE';

/**
 * Input shape for {@link checkAtomicity}.
 *
 * Callers may provide the declared files via either {@link declaredFiles} or
 * the convenience alias {@link acFiles}. When both are present, `declaredFiles`
 * wins.
 */
export interface AtomicityInput {
  /** Task id being checked (used in error messages). */
  taskId: string;
  /** Agent role this task is about to be dispatched to. */
  role: AgentSpawnCapability;
  /** Free-text acceptance criteria lines (not parsed by this check). */
  acceptance?: readonly string[];
  /** Explicit files scope (canonical field). */
  declaredFiles?: readonly string[];
  /** Alias for {@link declaredFiles} — matches AC.files casing. */
  acFiles?: readonly string[];
}

/**
 * Result of {@link checkAtomicity}.
 *
 * On success, only `allowed` and `meta` are populated. On failure, `code`,
 * `message`, and `fixHint` describe the rejection and how to remedy it.
 */
export interface AtomicityResult {
  /** Whether the spawn is permitted under the atomicity rule. */
  allowed: boolean;
  /** Error code when `allowed === false`. */
  code?: AtomicityErrorCode;
  /** Human-readable message when `allowed === false`. */
  message?: string;
  /** Suggested fix when `allowed === false`. */
  fixHint?: string;
  /** Counts observed during the check. */
  meta?: {
    /** Number of declared files (AC.files) observed. */
    fileCount: number;
    /** Whether an explicit file-scope declaration was present. */
    hasScope: boolean;
  };
}

/**
 * Check that a task about to be spawned respects the atomicity rule for its
 * declared role.
 *
 * Only the `worker` role is gated. `orchestrator` and `lead` roles pass
 * through unconditionally — they are permitted broader scope by design and
 * coordinate atomic workers downstream.
 *
 * Worker tasks MUST:
 * 1. Declare at least one file via AC.files (missing scope → `E_ATOMICITY_NO_SCOPE`).
 * 2. Declare no more than {@link MAX_WORKER_FILES} files (overflow →
 *    `E_ATOMICITY_VIOLATION`).
 *
 * @param input - Task metadata and declared role.
 * @returns Atomicity decision plus diagnostics.
 *
 * @example
 * ```typescript
 * const result = checkAtomicity({
 *   taskId: 'T1001',
 *   role: 'worker',
 *   declaredFiles: ['packages/core/src/foo.ts'],
 * });
 * if (!result.allowed) {
 *   throw new AtomicityViolationError(result);
 * }
 * ```
 */
export function checkAtomicity(input: AtomicityInput): AtomicityResult {
  // Only worker role is gated. orchestrator + lead pass through.
  if (input.role === 'orchestrator' || input.role === 'lead') {
    return { allowed: true };
  }

  // Worker role: require explicit file scope.
  const files = input.declaredFiles ?? input.acFiles ?? [];
  const hasScope = files.length > 0;

  if (!hasScope) {
    return {
      allowed: false,
      code: 'E_ATOMICITY_NO_SCOPE',
      message: `Worker role for task ${input.taskId} lacks file scope (AC.files). Workers MUST declare their files.`,
      fixHint: `Update task ${input.taskId} with --files "path/a.ts,path/b.ts" OR promote role to 'lead' if scope is inherently broad.`,
      meta: { fileCount: 0, hasScope: false },
    };
  }

  if (files.length > MAX_WORKER_FILES) {
    const splitCount = Math.ceil(files.length / MAX_WORKER_FILES);
    return {
      allowed: false,
      code: 'E_ATOMICITY_VIOLATION',
      message: `Worker role for task ${input.taskId} declares ${files.length} files (max ${MAX_WORKER_FILES}). Split into subtasks or promote to lead.`,
      fixHint: `Split task ${input.taskId} into ${splitCount} subtasks with cleo add --parent ${input.taskId}`,
      meta: { fileCount: files.length, hasScope: true },
    };
  }

  return { allowed: true, meta: { fileCount: files.length, hasScope: true } };
}

/**
 * Thrown when {@link checkAtomicity} rejects a spawn.
 *
 * Carries a stable LAFS `code` and numeric `exitCode` aligned with
 * {@link ExitCode.ATOMICITY_VIOLATION} so CLI callers can surface exit 69
 * without additional mapping.
 *
 * @example
 * ```typescript
 * const result = checkAtomicity(input);
 * if (!result.allowed) {
 *   throw new AtomicityViolationError(result);
 * }
 * ```
 */
export class AtomicityViolationError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code: AtomicityErrorCode;
  /** Numeric exit code aligned with {@link ExitCode.ATOMICITY_VIOLATION}. */
  readonly exitCode: ExitCode = ExitCode.ATOMICITY_VIOLATION;
  /** Diagnostic metadata from the originating check. */
  readonly meta: AtomicityResult['meta'];
  /** Suggested fix extracted from the originating check. */
  readonly fixHint: string | undefined;

  /**
   * @param result - The rejection result returned by {@link checkAtomicity}.
   * @throws {TypeError} if called with an `allowed: true` result.
   */
  constructor(result: AtomicityResult) {
    if (result.allowed || !result.code) {
      throw new TypeError(
        'AtomicityViolationError must be constructed from a rejected AtomicityResult',
      );
    }
    super(result.message ?? 'Atomicity violation');
    this.name = 'AtomicityViolationError';
    this.code = result.code;
    this.meta = result.meta;
    this.fixHint = result.fixHint;
  }
}
