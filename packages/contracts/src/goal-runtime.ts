/**
 * Wire shapes of the CLEO Goal runtime bin (`@cleocode/goal`, bin `cleo-goal`,
 * alias `ocg`) that CLEO parses. CLEO talks to the runtime only through these
 * JSON outputs (T13791); an unknown `schemaVersion` is refused, never guessed.
 *
 * @task T13819
 * @task T13820
 * @task T13821
 * @epic T13791
 */

/**
 * Environment variable naming the harness whose Stop the dispatcher is
 * answering (`claude-code` or `codex`), set on the `cleo-goal tick` child so
 * the tick can tell harnesses apart (T13884).
 */
export const GOAL_TICK_PROVIDER_ENV = 'CLEO_HOOK_PROVIDER';

/** The only `schemaVersion` this CLEO understands for every shape below. */
export const GOAL_RUNTIME_SCHEMA_VERSION = 1;

/** Run state reported by `cleo-goal status --json`; `none` when no goal is live. */
export type GoalRuntimeRunStatus =
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'needs_review'
  | 'budget_limited'
  | 'complete'
  | 'failed'
  | 'aborted'
  | 'superseded'
  | 'none';

/** One criterion of the live goal. */
export interface GoalRuntimeCriterion {
  readonly id: string;
  readonly statement: string;
  readonly status: string;
  readonly essential: boolean;
  readonly invariant: boolean;
  /** Who judged it (`host`, `verifier`, …); `null` while unjudged (T13870). */
  readonly by: string | null;
  /** The judge's note; `null` when there is none (T13870). */
  readonly detail: string | null;
}

/** One budget dimension (turns, tokens, time, …). */
export interface GoalRuntimeBudgetPart {
  readonly name: string;
  readonly used: number;
  readonly limit: number;
}

/**
 * `cleo-goal status --json` stdout. The bin exits 0 whenever the project was
 * readable, including with no goal (`goal: null`, `status: 'none'`).
 */
export interface GoalRuntimeStatus {
  readonly schemaVersion: typeof GOAL_RUNTIME_SCHEMA_VERSION;
  readonly goal: string | null;
  readonly runId: string | null;
  readonly title: string;
  readonly status: GoalRuntimeRunStatus;
  readonly priority?: string;
  readonly turn: number;
  readonly reason: string | null;
  readonly criteria: readonly GoalRuntimeCriterion[];
  readonly proven: number;
  readonly total: number;
  readonly budget: { readonly ratio: number; readonly parts: readonly GoalRuntimeBudgetPart[] };
  readonly verdict: {
    readonly passed: boolean;
    readonly lines: readonly string[];
    readonly turn: number;
  } | null;
  readonly blocker: {
    readonly key: string;
    readonly count: number;
    readonly reason: string;
  } | null;
  /** Epoch milliseconds. */
  readonly updatedAt: number;
}

/**
 * One OpenCode v2 `plugins` entry: a spec, a `[spec, options]` tuple, or a
 * `{ package, options }` object.
 */
export type GoalRuntimePluginEntry =
  | string
  | readonly [string, Readonly<Record<string, unknown>>]
  | { readonly package: string; readonly options?: Readonly<Record<string, unknown>> };

/**
 * `cleo-goal install --project --json` stdout on exit 0. Writes only the
 * project's `.opencode/opencode.json` (OpenCode v2 `plugins` key).
 */
export interface GoalRuntimeInstall {
  readonly schemaVersion: typeof GOAL_RUNTIME_SCHEMA_VERSION;
  readonly action: 'installed' | 'already-present' | 'updated' | 'dry-run';
  readonly file: string;
  /** The npm or git spec registered (`github:…#vX.Y.Z` until npm publish). */
  readonly spec: string;
  readonly plugins: readonly GoalRuntimePluginEntry[];
}

/** `cleo-goal` stdout on exit 1 (exit 2 is a usage error on stderr only). */
export interface GoalRuntimeError {
  readonly schemaVersion: typeof GOAL_RUNTIME_SCHEMA_VERSION;
  readonly error: string;
}
