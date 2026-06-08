/**
 * `SkillExecutor` — the Dependency-Inversion (DIP) seam for the GenKit-phase
 * skill dispatcher (P1 · T11476 · E-SKILL-EXECUTOR-CONTRACT · epic T11391).
 *
 * A **skill** is a multi-step capability composed from the atomic tool
 * primitives ({@link ./atomic.js}) — read/write/search/shell/etc. The atomic
 * tool layer is pure side-effect plumbing; the SKILLS layer is where those
 * primitives are sequenced into a unit of agent work (run a lint, scaffold a
 * file, summarize a tree). This module declares the ABSTRACTION the dispatcher
 * depends on so the concrete in-process implementation
 * (`SkillExecutorAdapter`, T11477) can be INJECTED rather than imported. That is
 * the classic DIP move: high-level dispatch policy and low-level execution
 * mechanism both depend on this contract, not on each other.
 *
 * ## Why it lives in `@cleocode/contracts`
 *
 * The skill dispatcher (a high-level orchestration concern) and the executor
 * adapter (a low-level mechanism wiring an LLM/GenKit flow over the guarded
 * tools) must agree on ONE shape without either importing the other. Putting the
 * interface here — alongside the atomic-tool I/O shapes it builds on — lets
 * `core`, `mcp-adapter`, `caamp`, and `cleo-os` bind to a single seam and lets
 * tests substitute a fake executor with no runtime dependency.
 *
 * ## Boundary contract (T11476 acceptance)
 *
 * - **AC1** — `execute({ skillId, context, tools }) -> Promise<{ status, output,
 *   error }>`. The result envelope intentionally mirrors the playbook runtime's
 *   `AgentDispatcher.dispatch()` result so a `SkillExecutor` reads as an
 *   in-process `AgentDispatcher` specialization (NOT a clone of it).
 * - **AC2** — depends ONLY on the guarded-tool surface ({@link GuardedToolSurface},
 *   itself derived purely from {@link ./atomic.js} I/O shapes) and contract-local
 *   types. ZERO `@cleocode/*` runtime coupling: the `tools` dependency is the
 *   structural shape of `@cleocode/core`'s `createToolGuard()` result, declared
 *   here so neither contracts nor the dispatcher import `core`.
 * - **AC3** — deliberately NOT named `SessionEngine` (that collides with
 *   `core/src/sessions/`). A `SkillExecutor` is an in-process
 *   `AgentDispatcher`-shaped executor, not a session lifecycle owner.
 *
 * Types-only — no runtime logic (Gate 10 `contracts-purity`).
 *
 * @epic T11391
 * @task T11476
 * @saga T11387
 * @see ./atomic.js — the tool I/O shapes this seam composes over
 */

import type { RunShellInput, RunShellResult } from './agent-tools.js';
import type {
  ExecuteShellInput,
  ExecuteShellResult,
  PathExistsInput,
  PathExistsResult,
  ReadFileInput,
  ReadFileResult,
  RunGitInput,
  WriteFileInput,
  WriteFileResult,
} from './atomic.js';

// ---------------------------------------------------------------------------
// Guarded tool surface — the dependency a SkillExecutor receives by injection
// ---------------------------------------------------------------------------

/**
 * The deny-first guarded primitive surface a {@link SkillExecutor} is handed to
 * perform side-effecting work. Every method is built purely from the atomic-tool
 * I/O shapes in {@link ./atomic.js}, so this interface carries ZERO coupling to
 * any `@cleocode/*` runtime package.
 *
 * This is the contract-pure SHAPE of `@cleocode/core`'s `createToolGuard()`
 * result (`ToolGuard` in `packages/core/src/tools/guard.ts`). It is declared
 * here — not imported from `core` — so the skill dispatcher depends on an
 * abstraction (DIP) and the concrete guard is injected. The `core` `ToolGuard`
 * remains structurally assignable to this surface.
 *
 * @remarks Mirrors `ToolGuard` member-for-member. When a new atomic primitive is
 *   added to the guard chokepoint, add it here too so the surfaces stay in sync.
 */
export interface GuardedToolSurface {
  /** Read a file as text through the guard. */
  readFileText(input: ReadFileInput): Promise<ReadFileResult>;
  /** Read + parse a JSON file through the guard. */
  readJson<T>(path: string): Promise<T>;
  /** Atomically write a file (tmp-then-rename) through the guard. */
  writeFileAtomic(input: WriteFileInput): Promise<WriteFileResult>;
  /** Test path existence + kind through the guard. */
  pathExists(input: PathExistsInput): Promise<PathExistsResult>;
  /** Run a command with explicit cwd/env/timeout through the guard. */
  executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult>;
  /**
   * Run a command under a pseudo-terminal (PTY) through the guard, falling back
   * to a non-PTY spawn when a PTY backend is unavailable. Subject to the same
   * deny-first command policy + env scrubbing as {@link GuardedToolSurface.executeShell}.
   */
  executePty(input: RunShellInput): Promise<RunShellResult>;
  /** Run a git subcommand through the guard. */
  runGit(input: RunGitInput): Promise<ExecuteShellResult>;
}

// ---------------------------------------------------------------------------
// Execution I/O — input envelope + terminal result
// ---------------------------------------------------------------------------

/**
 * Terminal status of a single skill execution. Mirrors the playbook runtime's
 * `DispatchResult.status` so a {@link SkillExecutor} envelope is structurally
 * compatible with an `AgentDispatcher` result.
 */
export type SkillExecuteStatus = 'success' | 'failure';

/**
 * Input envelope for a single skill execution (AC1: `{ skillId, context, tools }`).
 *
 * The executor receives the skill identity, an opaque accumulated context, and
 * the guarded tool surface it is permitted to use. It MUST NOT reach for
 * ambient/global tools — all side effects flow through {@link SkillExecuteInput.tools}.
 */
export interface SkillExecuteInput {
  /** Stable identifier of the skill to execute (registry slug / id). */
  readonly skillId: string;
  /**
   * Accumulated bindings / inputs for this execution. Opaque key-value map so
   * the contract stays decoupled from any concrete skill's parameter schema;
   * each skill validates its own slice of this at the adapter boundary.
   */
  readonly context: Readonly<Record<string, unknown>>;
  /**
   * The deny-first guarded tool surface the executor may use. Injected by the
   * caller (DIP) — the executor never constructs its own guard.
   */
  readonly tools: GuardedToolSurface;
}

/**
 * Terminal result envelope of a single skill execution (AC1: `{ status, output,
 * error }`). Mirrors the playbook runtime's `DispatchResult` shape so callers
 * that already consume `AgentDispatcher` results can consume a `SkillExecutor`
 * result without a wrapper.
 */
export interface SkillExecuteResult {
  /** Whether the skill execution succeeded or failed. */
  readonly status: SkillExecuteStatus;
  /**
   * Key-value pairs produced by the skill, merged into the caller's context on
   * success. Empty (not absent) when a skill produces no bindings.
   */
  readonly output: Readonly<Record<string, unknown>>;
  /**
   * Human-readable failure reason. Present iff
   * `status === 'failure'`; omitted on success.
   */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// The DIP seam
// ---------------------------------------------------------------------------

/**
 * Dependency-Inversion abstraction for the in-process skill executor.
 *
 * The skill dispatcher depends on THIS interface; the concrete
 * `SkillExecutorAdapter` (T11477) — which wires a GenKit/LLM flow over the
 * injected {@link GuardedToolSurface} — is supplied by injection. A
 * `SkillExecutor` is an in-process `AgentDispatcher`-shaped executor: it
 * resolves and runs a single skill and returns a success/failure envelope; it
 * is NOT a session lifecycle owner (deliberately NOT `SessionEngine`, AC3).
 *
 * @example
 * ```ts
 * // High-level dispatch policy depends on the abstraction, not the adapter.
 * async function runOneSkill(
 *   executor: SkillExecutor,
 *   skillId: string,
 *   tools: GuardedToolSurface,
 * ): Promise<SkillExecuteResult> {
 *   return executor.execute({ skillId, context: {}, tools });
 * }
 * ```
 */
export interface SkillExecutor {
  /**
   * Execute a single skill and return a terminal success/failure envelope.
   *
   * @param input - Skill identity, accumulated context, and the guarded tool
   *   surface the skill is permitted to use.
   * @returns The terminal {@link SkillExecuteResult} for this execution.
   */
  execute(input: SkillExecuteInput): Promise<SkillExecuteResult>;
}
