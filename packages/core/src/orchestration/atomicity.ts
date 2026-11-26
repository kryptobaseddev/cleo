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
 * @task T9214 Atomicity gate UX hardening (W4)
 */

import type { AgentSpawnCapability } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';

/**
 * Maximum number of files a worker-role task may declare before it must be
 * split into subtasks with each child owning at most this many files.
 *
 * Test files that accompany a declared source file do not count toward it
 * (see {@link countScopedFiles} and {@link ATOMIC_SCOPE_RULE}).
 */
export const MAX_WORKER_FILES = 3;

/**
 * The worker file-scope rule in one sentence, stated in every refusal so the
 * caller sees which files counted.
 *
 * @task T14633
 */
export const ATOMIC_SCOPE_RULE =
  `A worker task may declare at most ${MAX_WORKER_FILES} counted files. A test file ` +
  '(`*.test.*`, `*.spec.*`, or under `__tests__/`) that pairs with a declared source file ' +
  'by name stem in the same directory (`src/foo.ts` with `src/foo.test.ts` or ' +
  '`src/__tests__/foo.test.ts`) does not count; the source must be a code file, so a test ' +
  'never pairs with `foo.json`. Every source file and every unpaired test file counts.';

/**
 * Whether a declared path is a test file under {@link ATOMIC_SCOPE_RULE}.
 *
 * @param path - A declared file path.
 * @returns True for `*.test.*`, `*.spec.*` and anything under `__tests__/`.
 * @task T14633
 */
export function isAtomicScopeTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return /\.(test|spec)\.[^/]+$/.test(base) || /(^|\/)__tests__\//.test(normalized);
}

/**
 * Extensions of the code files a test may pair with. A declared data or
 * config file (`foo.json`, `foo.md`) never absorbs a test.
 */
const ATOMIC_SCOPE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'svelte',
  'vue',
  'py',
  'rs',
  'go',
  'rb',
  'java',
  'php',
  'cs',
]);

/** Split a path into its directory and basename, with `/` separators. */
function splitScopePath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return { dir: normalized.slice(0, slash + 1), base: normalized.slice(slash + 1) };
}

/** The basename without its last extension (`foo.test.ts` → `foo.test`). */
function stripExtension(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The key a declared source file pairs on: its directory and name stem
 * (`src/foo.ts` → `src/|foo`), or null when it is not a code file.
 */
function sourcePairKey(path: string): string | null {
  const { dir, base } = splitScopePath(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || !ATOMIC_SCOPE_CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) {
    return null;
  }
  return `${dir}|${base.slice(0, dot)}`;
}

/**
 * The key a test file pairs on: the directory of the source it would test and
 * its stem without the `.test`/`.spec` suffix. A test directly under
 * `__tests__/` pairs with the directory above it (`src/__tests__/foo.test.ts`
 * → `src/|foo`); a sibling test keeps its own directory.
 */
function testPairKey(path: string): string {
  const { dir, base } = splitScopePath(path);
  const sourceDir = /(^|\/)__tests__\/$/.test(dir) ? dir.slice(0, -'__tests__/'.length) : dir;
  return `${sourceDir}|${stripExtension(base).replace(/\.(test|spec)$/, '')}`;
}

/**
 * Count the files of a worker scope that count toward {@link MAX_WORKER_FILES}.
 *
 * Applies {@link ATOMIC_SCOPE_RULE}: every source file counts, and a test file
 * counts unless a declared code file has its stem in the directory it tests (a
 * sibling, or the parent of its `__tests__/`). So a scope of test files only,
 * an orphan test, or same-stem tests in other directories count in full.
 *
 * @param files - The declared files.
 * @returns The counted-file total.
 * @task T14633
 * @task T14636
 */
export function countScopedFiles(files: readonly string[]): number {
  const sources = files.filter((file) => !isAtomicScopeTestFile(file));
  const sourceKeys = new Set(sources.map(sourcePairKey).filter((key) => key !== null));
  const unpairedTests = files.filter(
    (file) => isAtomicScopeTestFile(file) && !sourceKeys.has(testPairKey(file)),
  );
  return sources.length + unpairedTests.length;
}

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
 * Structured waiver reason recorded when an orchestrator-tier caller defers
 * scope declaration to the spawned worker.
 *
 * Only tier-1+ orchestrators may pass this waiver. Tier-0 (direct user) callers
 * MUST still declare files explicitly — widening the waiver to tier-0 is
 * explicitly out of scope per T9214 constraints.
 */
export type AtomicityWaiverReason = 'orchestrator-scope-tier1-call';

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
  /**
   * The task's parent (usually its epic), named in the refusal's sibling-task
   * route. Omitted for a root task.
   */
  parentId?: string | null;
  /**
   * The task's type. A `subtask` cannot hold children, so its refusal omits
   * the convert-to-children route.
   */
  taskType?: string;
  /**
   * Structured waiver that allows a tier-1+ orchestrator to defer file-scope
   * declaration to the spawned worker at commit time.
   *
   * Setting this to `'orchestrator-defer'` bypasses `E_ATOMICITY_NO_SCOPE`
   * for the child task and records `atomicity_waiver:
   * 'orchestrator-scope-tier1-call'` in the returned result so the caller
   * can emit an auditable manifest entry.
   *
   * IMPORTANT: This waiver MUST NOT be used by tier-0 (direct user) callers
   * — only by orchestrators that are explicitly delegating scope accountability
   * to the worker. The waiver does NOT suppress `E_ATOMICITY_VIOLATION` (file-
   * count overflow).
   *
   * @task T9214 — orchestrator-defer UX hardening
   */
  scope?: 'orchestrator-defer';
}

/**
 * Result of {@link checkAtomicity}.
 *
 * On success, only `allowed` and `meta` are populated. On failure, `code`,
 * `message`, and `fixHint` describe the rejection and how to remedy it.
 * When a waiver is granted, `atomicity_waiver` is set so callers can emit
 * an auditable manifest entry.
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
  /**
   * Structured waiver reason recorded when an orchestrator uses
   * `scope: 'orchestrator-defer'` to bypass `E_ATOMICITY_NO_SCOPE`.
   *
   * Callers MUST persist this value in the spawn manifest entry so the
   * bypass is auditable.
   *
   * @task T9214
   */
  atomicity_waiver?: AtomicityWaiverReason;
  /** Counts observed during the check. */
  meta?: {
    /** Number of declared files (AC.files) observed. */
    fileCount: number;
    /** Files counted toward {@link MAX_WORKER_FILES} under {@link ATOMIC_SCOPE_RULE}. */
    countedFileCount?: number;
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
 * Orchestrators (tier-1+) may set `input.scope = 'orchestrator-defer'` to let
 * the worker declare its own scope at commit time. This produces
 * `allowed: true` with `atomicity_waiver: 'orchestrator-scope-tier1-call'` in
 * the result — callers MUST persist the waiver in the spawn manifest.
 *
 * @param input - Task metadata and declared role.
 * @returns Atomicity decision plus diagnostics.
 *
 * @example
 * ```typescript
 * // Standard path — worker declares files.
 * const result = checkAtomicity({
 *   taskId: 'T1001',
 *   role: 'worker',
 *   declaredFiles: ['packages/core/src/foo.ts'],
 * });
 * if (!result.allowed) {
 *   throw new AtomicityViolationError(result);
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Orchestrator-defer waiver — scope accountability delegated to worker.
 * const result = checkAtomicity({
 *   taskId: 'T1002',
 *   role: 'worker',
 *   scope: 'orchestrator-defer',
 * });
 * // result.allowed === true
 * // result.atomicity_waiver === 'orchestrator-scope-tier1-call'
 * // Caller MUST record atomicity_waiver in spawn manifest.
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
    // Orchestrator-defer waiver: a tier-1+ caller explicitly delegates scope
    // accountability to the worker. Grant the spawn but record the waiver so
    // the manifest entry remains auditable.
    if (input.scope === 'orchestrator-defer') {
      return {
        allowed: true,
        atomicity_waiver: 'orchestrator-scope-tier1-call',
        meta: { fileCount: 0, hasScope: false },
      };
    }

    return {
      allowed: false,
      code: 'E_ATOMICITY_NO_SCOPE',
      message: `Worker role for task ${input.taskId} lacks file scope (AC.files). Workers MUST declare their files.`,
      fixHint: `Child task ${input.taskId} has no file scope. Either declare files on the task (e.g. \`cleo update ${input.taskId} --files "path/a.ts,path/b.ts"\`), or pass \`--orchestrator-defer\` to \`cleo orchestrate spawn\` to let the worker declare scope at commit time (tier-1+ orchestrators only).`,
      meta: { fileCount: 0, hasScope: false },
    };
  }

  const countedFileCount = countScopedFiles(files);
  if (countedFileCount > MAX_WORKER_FILES) {
    const id = input.taskId;
    const fixHint = buildScopeFixHint(id, input.parentId ?? null, input.taskType !== 'subtask');
    return {
      allowed: false,
      code: 'E_ATOMICITY_VIOLATION',
      message:
        `Task ${id} declares ${files.length} files, ${countedFileCount} of which count toward the ` +
        `atomic scope (max ${MAX_WORKER_FILES}). Rule: ${ATOMIC_SCOPE_RULE}`,
      fixHint,
      meta: { fileCount: files.length, countedFileCount, hasScope: true },
    };
  }

  return { allowed: true, meta: { fileCount: files.length, countedFileCount, hasScope: true } };
}

/**
 * The three routes out of an over-scoped worker task, each a command that
 * works whether or not the task carries its own text acceptance criteria.
 *
 * Plain `cleo add --parent <task>` is never offered: `addTask` refuses a child
 * under a task with text ACs (PM-Core V2 design-point 3), so the route that
 * splits under the task itself carries `--auto-decompose`.
 *
 * @param taskId - The refused task.
 * @param parentId - Its parent, for the sibling route; null for a root task.
 * @param canHoldChildren - False for a subtask, which drops the third route.
 * @returns The fix text.
 * @task T14633
 */
function buildScopeFixHint(
  taskId: string,
  parentId: string | null,
  canHoldChildren: boolean,
): string {
  const siblingParent = parentId ? ` --parent ${parentId}` : '';
  const narrowAndSibling =
    `Pick one route:\n` +
    `1. Narrow the scope to ≤${MAX_WORKER_FILES} source files (accompanying tests do not count): ` +
    `cleo update ${taskId} --files "path/a.ts,path/a.test.ts"\n` +
    `2. File the remaining work as sibling tasks${parentId ? ` under ${parentId}` : ''}, then narrow ${taskId} as in route 1: ` +
    `cleo add "<title>"${siblingParent} --relates ${taskId} --files "path/d.ts,path/e.ts" --acceptance "<criteria>"`;
  if (!canHoldChildren) return narrowAndSibling;
  return (
    `${narrowAndSibling}\n` +
    `3. Convert ${taskId}'s acceptance criteria into child tasks and spawn each child: ` +
    `cleo add "<title>" --type subtask --parent ${taskId} --auto-decompose --files "path/a.ts,path/b.ts" --acceptance "<criteria>"` +
    ` (the child that receives the moved criteria, data.autoDecomposed.childId, needs its own ` +
    `\`cleo update <childId> --files "..."\` before it can spawn)`
  );
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
