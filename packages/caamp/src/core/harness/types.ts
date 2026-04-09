/**
 * Harness layer type definitions.
 *
 * @remarks
 * Defines the contract every first-class CAAMP harness must implement.
 * A harness is a provider that CAAMP treats natively — not through the
 * generic MCP-config-file path. Pi is the first (and currently only)
 * harness. The interface is intentionally generic so future harnesses
 * (Goose, OpenCode, ...) can slot in without shape churn.
 *
 * All methods are async even when they could be sync, so implementations
 * that need I/O (filesystem, child process) are not forced to lie about
 * their return types.
 *
 * @packageDocumentation
 */

import type { WorktreeHandle } from '@cleocode/cant';
import type { Provider } from '../../types.js';
import type { HarnessTier } from './scope.js';

/**
 * Scope at which a harness operation should be performed.
 *
 * @remarks
 * Harness operations target either the user's global state root (e.g.
 * `~/.pi/agent/`) or a specific project directory. Project scope requires
 * the caller to provide the absolute project directory path — the harness
 * does not infer cwd.
 *
 * This two-tier scope is the legacy shape used by the skill and
 * instructions install paths. Pi-specific Wave-1 verbs (extensions,
 * sessions, models, prompts, themes) use the three-tier
 * {@link HarnessTier} hierarchy introduced in ADR-035 §D1 alongside this
 * type — the two coexist and neither replaces the other.
 *
 * @public
 */
export type HarnessScope = { kind: 'global' } | { kind: 'project'; projectDir: string };

/**
 * Options accepted by `resolveDefaultTargetProviders` (defined in
 * `./index.ts`).
 *
 * @remarks
 * Both fields are optional. When the entire options object is omitted the
 * helper behaves exactly as it did pre-ADR-035 §D7 in `auto` mode with Pi
 * installed — the no-regression contract for existing callers.
 *
 * Lives here in `types.ts` rather than next to the function so that
 * downstream packages can `import type { ResolveDefaultTargetProvidersOptions }`
 * without pulling in the harness dispatcher's runtime imports.
 *
 * @public
 */
export interface ResolveDefaultTargetProvidersOptions {
  /**
   * Explicit list of providers requested by the user (e.g. via `--agent`).
   *
   * @remarks
   * When supplied, this list signals that the caller is honouring an
   * explicit user selection rather than asking for the implicit default.
   * In `auto` mode, an explicit list that excludes Pi while Pi is installed
   * triggers a one-time deprecation warning per process. In `force-pi`
   * mode the explicit list is ignored if it does not contain Pi (Pi is
   * still required). In `legacy` mode the list is returned verbatim with
   * no warning.
   *
   * Pass `undefined` (or omit entirely) to request the implicit default
   * resolution.
   *
   * @defaultValue undefined
   */
  explicit?: Provider[];
}

/**
 * Controls how `resolveDefaultTargetProviders` (defined in `./index.ts`)
 * selects target providers at runtime invocation time.
 *
 * @remarks
 * Introduced by ADR-035 §D7 ("v3 exclusivity") to give users an explicit
 * knob over how aggressively CAAMP routes runtime commands through Pi
 * versus other installed providers.
 *
 * - `'auto'` (default) — Pi is preferred when installed; explicit
 *   `--agent <non-pi>` selections are still honoured but emit a one-time
 *   deprecation warning per process. Behaviourally identical to v2026.4.5
 *   when no explicit non-Pi target is supplied.
 * - `'force-pi'` — Pi is required at runtime invocation. The dispatcher
 *   throws with an `E_NOT_FOUND_RESOURCE`-shaped error when Pi is not
 *   installed; callers decide whether to surface this as an exit code 4
 *   or render a remediation hint.
 * - `'legacy'` — Pre-exclusivity behaviour. No deprecation warnings, no
 *   hard requirement on Pi. Matches the resolution order CAAMP shipped
 *   before ADR-035 §D7 landed; preserved so users with brittle scripts
 *   can pin until they migrate.
 *
 * **Important**: this setting affects RUNTIME INVOCATION paths only. Skill
 * and instruction install paths
 * (e.g. {@link dispatchInstallSkillAcrossProviders} and friends) are
 * UNAFFECTED and continue to dispatch to multiple providers regardless of
 * mode. See ADR-035 §D7 for the full design rationale.
 *
 * @public
 */
export type ExclusivityMode = 'auto' | 'force-pi' | 'legacy';

/**
 * Metadata describing a Pi extension discovered on disk.
 *
 * @remarks
 * Returned by {@link Harness.listExtensions}. The `tier` records which
 * tier the extension lives at so that callers can surface the
 * precedence story in their output.
 *
 * @public
 */
export interface ExtensionEntry {
  /** Extension name (file basename without the `.ts` extension). */
  name: string;
  /** Tier at which this entry lives. */
  tier: HarnessTier;
  /** Absolute on-disk path to the extension file. */
  path: string;
  /**
   * When `true`, this entry is shadowed by a higher-precedence entry
   * with the same name. Exposed so list output can warn about
   * cross-tier name collisions per ADR-035 §D1.
   * @defaultValue false
   */
  shadowed?: boolean;
}

/**
 * Metadata describing a Pi prompt directory discovered on disk.
 *
 * @remarks
 * Returned by {@link Harness.listPrompts}. Prompts are directories
 * containing a `prompt.md` plus optional metadata. The list operation
 * reads only the directory listing — never the prompt bodies — to keep
 * token usage minimal per ADR-035 §D1.
 *
 * @public
 */
export interface PromptEntry {
  /** Prompt name (directory basename). */
  name: string;
  /** Tier at which this entry lives. */
  tier: HarnessTier;
  /** Absolute on-disk path to the prompt directory. */
  path: string;
  /** See {@link ExtensionEntry.shadowed}. @defaultValue false */
  shadowed?: boolean;
}

/**
 * Metadata describing a Pi theme discovered on disk.
 *
 * @remarks
 * Returned by {@link Harness.listThemes}. Themes are single `.ts` or
 * `.json` files matching Pi's native theme module shape.
 *
 * @public
 */
export interface ThemeEntry {
  /** Theme name (file basename without the extension). */
  name: string;
  /** Tier at which this entry lives. */
  tier: HarnessTier;
  /** Absolute on-disk path to the theme file. */
  path: string;
  /** File extension of the theme file (e.g. `".ts"`, `".json"`). */
  fileExt: string;
  /** See {@link ExtensionEntry.shadowed}. @defaultValue false */
  shadowed?: boolean;
}

/**
 * Options accepted by the Pi install verbs (extensions, prompts, themes).
 *
 * @public
 */
export interface HarnessInstallOptions {
  /**
   * When `true`, overwrite an existing file at the target tier. When
   * `false` (the default) the install verb throws if the target exists.
   * @defaultValue false
   */
  force?: boolean;
}

/**
 * Counts of top-level CANT sections discovered in a `.cant` file.
 *
 * @remarks
 * Returned by {@link Harness.listCantProfiles} and
 * {@link Harness.validateCantProfile} so that callers can surface a
 * concise summary of every profile (agents, workflows, pipelines,
 * top-level hooks, and skill references declared by an agent's
 * `skills:` property) without reading the full document body.
 *
 * The cant-core AST tags every section as a single-key wrapper
 * (`{ Agent: { ... } }`, `{ Workflow: { ... } }`, etc.), so these
 * counters are derived by walking `document.sections` and bucketing
 * by tag. `skillCount` aggregates the unique skill names declared
 * across every Agent section's `skills:` property — it is NOT a
 * count of standalone `skill { ... }` blocks because cant-core does
 * not currently expose those at the document level.
 *
 * @public
 */
export interface CantProfileCounts {
  /** Number of `agent { ... }` sections in the document. */
  agentCount: number;
  /** Number of `workflow { ... }` sections in the document. */
  workflowCount: number;
  /** Number of `pipeline { ... }` sections in the document. */
  pipelineCount: number;
  /**
   * Number of hook bodies discovered. Top-level `Hook` sections plus
   * the `hooks` array nested inside every Agent section are summed.
   */
  hookCount: number;
  /**
   * Number of distinct skill names referenced via an Agent section's
   * `skills:` property (e.g. `skills: ["ct-cleo", "ct-task-executor"]`).
   * The count is de-duplicated across agents within a single document.
   */
  skillCount: number;
}

/**
 * Metadata describing a `.cant` profile installed at one of the three
 * Pi harness tiers.
 *
 * @remarks
 * Returned by {@link Harness.listCantProfiles}. Mirrors the shape of
 * {@link ExtensionEntry} so consumers can render both with the same
 * UI primitives, but adds a {@link counts} bag with parsed AST stats
 * so the list output can summarise each profile without forcing the
 * caller to re-parse every file.
 *
 * @public
 */
export interface CantProfileEntry {
  /** Profile name (basename of the `.cant` file without the extension). */
  name: string;
  /** Tier at which this entry lives. */
  tier: HarnessTier;
  /** Absolute on-disk path to the `.cant` file. */
  sourcePath: string;
  /** Parsed section counts for the profile. */
  counts: CantProfileCounts;
  /**
   * When `true`, this entry is shadowed by a higher-precedence entry
   * with the same name. Mirrors the shadow flag emitted by
   * {@link Harness.listExtensions} so the same UI logic applies.
   * @defaultValue false
   */
  shadowedByHigherTier?: boolean;
}

/**
 * Diagnostic emitted by the cant-core 42-rule validator, normalised to
 * the harness layer's vocabulary.
 *
 * @remarks
 * Mirrors the `NativeDiagnostic` shape exported by `@cleocode/cant`'s
 * native loader. Captured here as a first-class harness type so callers
 * never have to import from `@cleocode/cant` directly to consume
 * {@link Harness.validateCantProfile} results.
 *
 * @public
 */
export interface CantValidationDiagnostic {
  /** Cant-core rule id (`PARSE`, `S01`, `P06`, ...). */
  ruleId: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** 1-based line number where the diagnostic was emitted. */
  line: number;
  /** 1-based column number where the diagnostic was emitted. */
  col: number;
  /** Severity bucket from cant-core (`error`, `warning`, `info`, `hint`). */
  severity: 'error' | 'warning' | 'info' | 'hint';
}

/**
 * Result of validating a `.cant` profile via the cant-core 42-rule
 * engine.
 *
 * @remarks
 * Returned by {@link Harness.validateCantProfile}. The `valid` flag is
 * `true` only when no error-severity diagnostics were emitted (warnings
 * are tolerated, matching cant-core's own definition). The
 * {@link counts} bag is populated only when parsing succeeded — when
 * the file is so broken cant-core cannot produce a document, every
 * counter is `0` and the diagnostics array carries the parse errors.
 *
 * @public
 */
export interface ValidateCantProfileResult {
  /** Whether validation passed (no error-severity diagnostics). */
  valid: boolean;
  /** All diagnostics emitted by the 42-rule engine, in source order. */
  errors: CantValidationDiagnostic[];
  /** Section counts for the profile (zero when parsing failed). */
  counts: CantProfileCounts;
}

/**
 * Summary header extracted from the first line of a Pi session JSONL file.
 *
 * @remarks
 * Per ADR-035 §D2, `list`-style session operations read only line 1 of
 * each `*.jsonl` file — never the full body — so this shape is what
 * callers consume when enumerating sessions. The full session loader
 * returns raw JSONL line strings as a separate type
 * ({@link SessionDocument}).
 *
 * @public
 */
export interface SessionSummary {
  /** Session identifier as recorded in the line-1 header. */
  id: string;
  /** Session version as recorded in the line-1 header (e.g. `3`). */
  version: number;
  /** ISO-8601 timestamp from the line-1 header, or `null` when absent. */
  timestamp: string | null;
  /** Working directory recorded when the session was created. */
  cwd: string | null;
  /** Parent session id, if this session was forked from another. */
  parentSession: string | null;
  /** Absolute path to the session JSONL file on disk. */
  filePath: string;
  /** File modification time in milliseconds since the epoch. */
  mtimeMs: number;
}

/**
 * Raw content of a Pi session JSONL file, preserved line-by-line.
 *
 * @remarks
 * Returned by {@link Harness.showSession} when a caller needs the full
 * body. Each element is one JSONL line as a string (empty trailing
 * lines are stripped). Callers that need typed entries parse each line
 * themselves; the harness does not impose a type on entry bodies
 * because Pi's own entry schema is open-ended (`message`, `thinking`,
 * `custom`, etc.) and we do not want to fall behind Pi's schema
 * evolution.
 *
 * @public
 */
export interface SessionDocument {
  /** Header summary (same shape as {@link SessionSummary}). */
  summary: SessionSummary;
  /** Raw JSONL lines in file order, excluding the line-1 header. */
  entries: string[];
}

/**
 * Pi model definition as recorded under `models.json:providers[].models`.
 *
 * @remarks
 * Mirrors the `ModelDefinition` schema in
 * `@mariozechner/pi-coding-agent`'s model-registry. Fields are typed
 * loosely because Pi's schema is evolving (see ADR-035 §D3); the keys
 * captured here are the minimum a CAAMP verb needs to reason about.
 *
 * @public
 */
export interface PiModelDefinition {
  /** Model id within the provider (e.g. `"claude-opus-4-20250514"`). */
  id: string;
  /** Human-readable model name. */
  name: string;
  /**
   * Whether the model supports reasoning/thinking tokens.
   * @defaultValue undefined
   */
  reasoning?: boolean;
  /**
   * Allowed input modalities (e.g. `["text"]`, `["text", "image"]`).
   * @defaultValue undefined
   */
  input?: Array<'text' | 'image'>;
  /**
   * Context window size in tokens.
   * @defaultValue undefined
   */
  contextWindow?: number;
  /**
   * Maximum output tokens.
   * @defaultValue undefined
   */
  maxTokens?: number;
}

/**
 * Pi provider block as recorded under `models.json:providers[id]`.
 *
 * @remarks
 * Mirrors the `ProviderConfig` schema in Pi's model-registry.
 *
 * @public
 */
export interface PiModelProvider {
  /**
   * Custom base URL for the provider (overrides default).
   * @defaultValue undefined
   */
  baseUrl?: string;
  /**
   * API key or `$ENV_VAR` reference.
   * @defaultValue undefined
   */
  apiKey?: string;
  /**
   * Custom model definitions declared by the user.
   * @defaultValue undefined
   */
  models?: PiModelDefinition[];
}

/**
 * Entire `models.json` document shape used by Pi.
 *
 * @remarks
 * Mirrors the `ModelsConfig` schema in Pi's model-registry. CAAMP reads
 * and writes this file through {@link Harness.readModelsConfig} /
 * {@link Harness.writeModelsConfig}.
 *
 * @public
 */
export interface PiModelsConfig {
  /** Map of provider id → provider block. */
  providers: Record<string, PiModelProvider>;
}

/**
 * A model entry as surfaced by {@link Harness.listModels}.
 *
 * @remarks
 * Models are reported as a union of `models.json`-defined custom models
 * and `settings.json:enabledModels` selections, with flags that record
 * whether each entry is currently enabled and whether it is the
 * configured default.
 *
 * @public
 */
export interface ModelListEntry {
  /** Provider id (e.g. `"anthropic"`). */
  provider: string;
  /** Model id within the provider. */
  id: string;
  /** Human-readable name, from `models.json` when available. */
  name: string | null;
  /** `true` when the model is present in `settings.json:enabledModels`. */
  enabled: boolean;
  /** `true` when the model is the configured default. */
  isDefault: boolean;
  /**
   * `true` when this model is defined in `models.json` (custom). When
   * `false`, the entry originates from `settings.json:enabledModels`
   * only and is assumed to resolve against Pi's built-in registry.
   */
  custom: boolean;
}

/**
 * Description of a subagent task to be spawned under a harness.
 *
 * @remarks
 * Generic across harnesses: the same shape describes a Pi-managed child,
 * a future Goose-managed child, or any other. The {@link targetProviderId}
 * is a routing hint passed to the harness; concrete harnesses may use it
 * to select an inner agent or simply record it for observability.
 *
 * Per ADR-035 §D6, every spawn has a stable {@link taskId} and is
 * attributed to a parent session via {@link parentSessionId}. When the
 * caller provides {@link parentSessionPath}, the harness records a
 * `subagent_link` custom entry into that file so listing the parent
 * session surfaces its children automatically.
 *
 * @public
 */
export interface SubagentTask {
  /** Provider id of the agent to spawn (e.g. `"claude-code"`). */
  targetProviderId: string;
  /** The prompt / instruction to give the spawned agent. */
  prompt: string;
  /**
   * Stable task identifier used to derive the child session filename and
   * to correlate streamed events with their originating task.
   *
   * @remarks
   * When omitted, the harness generates a short id at spawn time so
   * legacy callers (pre-ADR-035 §D6) keep working. New callers SHOULD
   * always supply a deterministic value.
   *
   * @defaultValue undefined
   */
  taskId?: string;
  /**
   * Identifier of the parent session that owns this subagent.
   *
   * @remarks
   * Used to compose the child session filename
   * (`subagent-{parentSessionId}-{taskId}.jsonl`) per ADR-035 §D6.
   * When omitted, the harness substitutes `"orphan"` so legacy callers
   * still produce a well-formed file path.
   *
   * @defaultValue undefined
   */
  parentSessionId?: string;
  /**
   * Absolute path to the parent session JSONL file.
   *
   * @remarks
   * When supplied, the harness appends a {@link SubagentLinkEntry} as
   * a `custom` entry to this file at spawn time so listing the parent
   * surfaces its children automatically. When omitted, no link entry
   * is written and the parent session is not modified.
   *
   * @defaultValue undefined
   */
  parentSessionPath?: string;
  /**
   * Working directory for the spawned agent.
   * @defaultValue undefined
   */
  cwd?: string;
  /**
   * Environment variable overrides layered atop the parent environment.
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * Abort signal. When it aborts, the harness will terminate the subagent
   * via the configured SIGTERM-then-SIGKILL cleanup sequence.
   * @defaultValue undefined
   */
  signal?: AbortSignal;
}

/**
 * Per-call options that override harness-wide spawn defaults.
 *
 * @remarks
 * Introduced for ADR-035 §D6 streaming + cleanup semantics. Every field
 * is optional so callers that just want default behaviour can omit the
 * second argument entirely.
 *
 * @public
 */
export interface SubagentSpawnOptions {
  /**
   * Streaming callback invoked once per parsed event from the child.
   *
   * @remarks
   * The harness fires this for every line of stdout (parsed as JSON when
   * possible), every line of stderr, the final exit, and the
   * `subagent_link` write. Callbacks are best-effort: throwing from the
   * callback is caught and recorded as a stderr line so the spawn loop
   * is never aborted by user code.
   *
   * @defaultValue undefined
   */
  onStream?: (event: SubagentStreamEvent) => void;
  /**
   * Override the SIGTERM grace window before SIGKILL fires.
   *
   * @remarks
   * When omitted, the harness reads
   * `settings.json:pi.subagent.terminateGraceMs` (global scope) and
   * falls back to `5000` ms if absent or invalid. Tests use very small
   * values to keep cleanup checks fast.
   *
   * @defaultValue undefined
   */
  terminateGraceMs?: number;
  /**
   * Environment variable overrides layered atop the task-level env.
   *
   * @remarks
   * Convenience hook for per-call secrets that should not live on the
   * task object itself. Merged after {@link SubagentTask.env} so
   * call-site keys win.
   *
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * Working directory override that wins over {@link SubagentTask.cwd}.
   *
   * @remarks
   * Useful when the same task description is reused across multiple
   * working directories. When {@link worktree} is also set, the worktree
   * path is used as the cwd and this field is ignored.
   *
   * @defaultValue undefined
   */
  cwd?: string;
  /**
   * Git worktree handle providing physical + logical isolation for the
   * spawned subagent (ADR-041 §D2).
   *
   * @remarks
   * When set, `PiHarness.spawnSubagent` MUST:
   * 1. Pass `cwd: worktree.path` to the Pi subprocess.
   * 2. Inject the following env vars (before `opts.env` and `task.env`):
   *    - `CLEO_WORKTREE_ROOT`   = worktree.path
   *    - `CLEO_WORKTREE_BRANCH` = worktree.branch
   *    - `CLEO_PROJECT_HASH`    = worktree.projectHash
   *
   * These env vars allow `getProjectRoot()` inside the worker to resolve
   * DB paths against the correct worktree directory via the
   * `worktreeScope` AsyncLocalStorage (ADR-041 §D3) or direct env-var
   * inspection when AsyncLocalStorage is not in scope.
   *
   * @defaultValue undefined
   * @task T380
   */
  worktree?: WorktreeHandle;
}

/**
 * One streaming event surfaced through {@link SubagentSpawnOptions.onStream}.
 *
 * @remarks
 * Discriminated by {@link kind}:
 *
 * - `"message"` — a successfully parsed JSON line from the child's
 *   stdout. {@link payload} is the parsed object and {@link lineNumber}
 *   is the 1-based line index within the child's stdout stream.
 * - `"stderr"` — a single line from the child's stderr stream. The
 *   {@link payload} is `{ line: string }`. The harness NEVER injects
 *   stderr into the parent LLM context per ADR-035 §D6.
 * - `"exit"` — the child has exited. {@link payload} is a
 *   {@link SubagentExitResult}.
 * - `"link"` — the harness wrote a `subagent_link` custom entry to the
 *   parent session. {@link payload} is the {@link SubagentLinkEntry}.
 *
 * @public
 */
export interface SubagentStreamEvent {
  /** Event kind discriminator. */
  kind: 'message' | 'stderr' | 'exit' | 'link';
  /** Subagent identifier (matches {@link SubagentHandle.subagentId}). */
  subagentId: string;
  /**
   * 1-based line number within the child's stdout stream. Only set for
   * `"message"` events that originated from a parsed stdout line.
   * @defaultValue undefined
   */
  lineNumber?: number;
  /** Event payload, shaped according to {@link kind}. */
  payload: unknown;
}

/**
 * Resolution value of {@link SubagentHandle.exitPromise}.
 *
 * @remarks
 * Captured exactly once when the child process exits. The promise NEVER
 * rejects — failure is encoded by a non-zero {@link code}, a non-null
 * {@link signal}, or partial output preserved in the child session file
 * at {@link childSessionPath}.
 *
 * @public
 */
export interface SubagentExitResult {
  /**
   * Process exit code, or `null` when the child was terminated by a
   * signal before exiting normally.
   */
  code: number | null;
  /** Terminating signal, or `null` when the child exited normally. */
  signal: NodeJS.Signals | null;
  /** Absolute path to the child session JSONL file on disk. */
  childSessionPath: string;
  /** Wall-clock duration from spawn to exit, in milliseconds. */
  durationMs: number;
}

/**
 * `subagent_link` custom entry written into the parent session JSONL.
 *
 * @remarks
 * Written at spawn time (not at exit) so the parent always knows which
 * children were ever launched even if a child crashes before producing
 * output. The entry is a single JSON line appended to the parent session
 * file.
 *
 * @public
 */
export interface SubagentLinkEntry {
  /** Entry type discriminator (always `"subagent_link"`). */
  type: 'subagent_link';
  /** Subagent identifier matching {@link SubagentHandle.subagentId}. */
  subagentId: string;
  /** Task identifier from {@link SubagentTask.taskId}. */
  taskId: string;
  /** Absolute path to the child session JSONL file. */
  childSessionPath: string;
  /** ISO-8601 timestamp captured when the child was spawned. */
  startedAt: string;
}

/**
 * Final result of a subagent's execution (legacy v1 shape).
 *
 * @remarks
 * Preserved for back-compat with pre-ADR-035 §D6 callers. New code
 * SHOULD await {@link SubagentHandle.exitPromise} (which resolves with
 * a richer {@link SubagentExitResult}) instead. The harness still
 * populates this field on every spawn so existing tests and callers
 * keep working.
 *
 * @public
 */
export interface SubagentResult {
  /** Process exit code, or `null` if the process was killed by a signal. */
  exitCode: number | null;
  /** Full stdout captured from the subagent. */
  stdout: string;
  /** Full stderr captured from the subagent. */
  stderr: string;
  /**
   * Parsed JSON output, when the target supports a JSON output mode and
   * emitted well-formed JSON on stdout.
   * @defaultValue undefined
   */
  parsed?: unknown;
}

/**
 * Live handle to a running subagent.
 *
 * @remarks
 * Returned synchronously from {@link Harness.spawnSubagent}. The caller
 * may:
 *
 * - Await {@link exitPromise} to collect the rich {@link SubagentExitResult}
 *   (preferred path, ADR-035 §D6).
 * - Await {@link result} to collect the legacy {@link SubagentResult}
 *   (preserved for back-compat).
 * - Invoke {@link terminate} (preferred) or {@link abort} (legacy) to
 *   stop the child early via the configured SIGTERM-then-SIGKILL
 *   cleanup sequence.
 * - Inspect {@link recentStderr} for the most recent stderr lines
 *   captured by the harness — useful for post-mortem diagnostics
 *   without injecting stderr into the parent LLM context.
 *
 * @public
 */
export interface SubagentHandle {
  /**
   * Stable subagent identifier generated at spawn time.
   *
   * @remarks
   * Format: `sub-{taskId}-{shortRandom}`. Used to correlate
   * {@link SubagentStreamEvent} entries and `subagent_link` records
   * with this handle. Always defined (the harness never returns a
   * handle without one).
   */
  subagentId: string;
  /** Task identifier from {@link SubagentTask.taskId} (or generated default). */
  taskId: string;
  /** Absolute path to the child session JSONL file on disk. */
  childSessionPath: string;
  /** PID of the spawned process, or `null` if spawning did not yield one. */
  pid: number | null;
  /** Wall-clock timestamp captured immediately after spawn. */
  startedAt: Date;
  /**
   * Promise resolving to the rich exit result once the child process
   * has fully terminated. NEVER rejects — failures are encoded in the
   * resolved value (non-zero code, non-null signal, partial output in
   * the session file).
   */
  exitPromise: Promise<SubagentExitResult>;
  /**
   * Promise resolving to the legacy {@link SubagentResult} shape.
   *
   * @remarks
   * Preserved for back-compat. Resolves to the same exit code as
   * {@link exitPromise} plus the full captured stdout / stderr buffers
   * and a best-effort `parsed` field for callers that emit a single
   * JSON document.
   */
  result: Promise<SubagentResult>;
  /**
   * Terminate the subagent gracefully.
   *
   * @remarks
   * Sends SIGTERM, waits for the configured grace window, then sends
   * SIGKILL if the child is still alive. Idempotent — subsequent calls
   * after the first are no-ops. Returns once the cleanup sequence has
   * fully resolved.
   */
  terminate(): Promise<void>;
  /**
   * Synchronously trigger the cleanup sequence (legacy v1 alias for
   * {@link terminate}).
   *
   * @remarks
   * Preserved so existing callers that use `handle.abort()` keep
   * working. Internally enqueues the same SIGTERM-then-SIGKILL flow as
   * {@link terminate} but does not return the resulting promise.
   */
  abort: () => void;
  /**
   * Snapshot of the most recent stderr lines captured for this child.
   *
   * @remarks
   * Bounded ring buffer (last 100 lines) so memory cannot grow without
   * bound under chatty stderr. Stderr is NEVER injected into the
   * parent LLM context — this accessor is intended for diagnostics and
   * post-mortem inspection only.
   */
  recentStderr(): string[];
}

/**
 * Contract every first-class harness must implement.
 *
 * @remarks
 * A harness is a provider that CAAMP treats natively — installing skills,
 * MCP bridges, instruction files, and subagent spawns through harness-specific
 * mechanisms rather than a generic MCP config file. Pi is the first concrete
 * harness; the interface is shaped so future harnesses (Goose, OpenCode, ...)
 * can be added without changing any caller code.
 *
 * Optional methods ({@link spawnSubagent}, {@link configureModels}) may be
 * omitted by harnesses that cannot support them. Callers MUST feature-check
 * before invoking.
 *
 * @public
 */
export interface Harness {
  /** Short id matching the provider id (e.g. `"pi"`). */
  readonly id: string;

  /** The underlying resolved provider entry. */
  readonly provider: Provider;

  /**
   * Install a skill using the harness's native mechanism.
   *
   * @remarks
   * For Pi: copy the source skill directory into
   * `~/.pi/agent/skills/<skillName>/` (global) or `<projectDir>/.pi/skills/<skillName>/`
   * (project). Pi resolves paths at load time so a symlink would work, but
   * CAAMP prefers a recursive copy to avoid cross-filesystem symlink issues.
   *
   * @param sourcePath - Absolute path to the skill directory to install.
   * @param skillName - Target skill name (becomes the directory name on disk).
   * @param scope - Install target scope.
   */
  installSkill(sourcePath: string, skillName: string, scope: HarnessScope): Promise<void>;

  /**
   * Remove a skill previously installed via this harness.
   *
   * @remarks
   * Missing skills are tolerated silently so callers can use this as an
   * idempotent "ensure absent" operation.
   *
   * @param skillName - Skill name to remove.
   * @param scope - Install target scope.
   */
  removeSkill(skillName: string, scope: HarnessScope): Promise<void>;

  /**
   * List skills installed in this harness's skill directory for a scope.
   *
   * @remarks
   * Returns the skill directory names (not absolute paths). Missing scope
   * directories return an empty array rather than throwing.
   *
   * @param scope - Scope to inspect.
   * @returns Array of skill directory names.
   */
  listSkills(scope: HarnessScope): Promise<string[]>;

  /**
   * Inject content into the harness's instruction file using a marker-based
   * idempotent block.
   *
   * @remarks
   * For Pi the target file is `~/.pi/agent/AGENTS.md` (global) or
   * `<projectDir>/AGENTS.md` at the project root (not under `.pi/`). The
   * injection uses `<!-- CAAMP:START -->` / `<!-- CAAMP:END -->` markers so
   * subsequent calls replace the block in place.
   *
   * @param content - The content to inject inside the marker block.
   * @param scope - Instruction file scope.
   */
  injectInstructions(content: string, scope: HarnessScope): Promise<void>;

  /**
   * Remove the CAAMP injection block from the harness's instruction file.
   *
   * @remarks
   * The surrounding file content is preserved. Missing files are tolerated.
   *
   * @param scope - Instruction file scope.
   */
  removeInstructions(scope: HarnessScope): Promise<void>;

  /**
   * Spawn a subagent under this harness's control.
   *
   * @remarks
   * For Pi: invokes `child_process.spawn` with the provider's configured
   * `capabilities.spawn.spawnCommand`, appending the task prompt as a
   * trailing positional argument. The returned handle lets the caller
   * await completion ({@link SubagentHandle.exitPromise}), terminate the
   * child via the SIGTERM-then-SIGKILL cleanup sequence
   * ({@link SubagentHandle.terminate}), and inspect recent stderr for
   * post-mortem diagnostics ({@link SubagentHandle.recentStderr}).
   *
   * Per ADR-035 §D6, this is the **only** canonical subagent spawn path
   * in CLEO. New callers MUST go through the harness instead of calling
   * `child_process.spawn` directly so session attribution, streaming,
   * and cleanup remain uniform.
   *
   * Optional — harnesses that cannot spawn other agents should omit this
   * method. Callers MUST feature-check before invoking.
   *
   * @param task - Subagent task specification.
   * @param opts - Per-call streaming and cleanup overrides.
   * @returns A live subagent handle.
   */
  spawnSubagent?(task: SubagentTask, opts?: SubagentSpawnOptions): Promise<SubagentHandle>;

  /**
   * Configure which models are available in the harness's model picker.
   *
   * @remarks
   * For Pi: writes the provided glob list to `settings.json:enabledModels`.
   *
   * Optional — harnesses without a model picker should omit this method.
   *
   * @param modelPatterns - Glob patterns enumerating enabled models.
   * @param scope - Settings scope.
   */
  configureModels?(modelPatterns: string[], scope: HarnessScope): Promise<void>;

  /**
   * Read the harness's current settings as an opaque object.
   *
   * @remarks
   * The shape is harness-specific; callers that care about fields must know
   * the concrete harness's schema. Missing files resolve to an empty object.
   *
   * @param scope - Settings scope.
   * @returns Opaque settings blob.
   */
  readSettings(scope: HarnessScope): Promise<unknown>;

  /**
   * Deep-merge a patch into the harness's settings and persist the result.
   *
   * @remarks
   * The patch is merged, not replaced, so unrelated fields survive. The
   * shape is harness-specific.
   *
   * @param patch - Partial settings object to merge.
   * @param scope - Settings scope.
   */
  writeSettings(patch: Record<string, unknown>, scope: HarnessScope): Promise<void>;

  // ── Wave-1 three-tier verbs (ADR-035 §D1) ────────────────────────────

  /**
   * Install a Pi extension TypeScript file from a local source path into
   * the given tier.
   *
   * @remarks
   * Per ADR-035 §D1 and the spec hook for T263, install verbs:
   * - Validate that the source is a `.ts` file with an `export default`.
   * - Copy (not symlink) the file into the target tier's extensions dir.
   * - Error by default when the target already exists; the caller may
   *   pass `opts.force = true` to enable overwrite.
   *
   * Optional on the interface because only first-class harnesses with a
   * native extension mechanism support this verb.
   *
   * @param sourcePath - Absolute path to the source `.ts` file on disk.
   * @param name - Extension name (used as the target file basename).
   * @param tier - Target tier (`project`/`user`/`global`).
   * @param projectDir - Project directory (required when `tier='project'`).
   * @param opts - Install options (see {@link HarnessInstallOptions}).
   */
  installExtension?(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }>;

  /**
   * Remove a Pi extension by name from the given tier.
   *
   * @remarks
   * Missing files are tolerated silently so the verb is usable as an
   * idempotent "ensure absent" operation.
   *
   * @param name - Extension name (basename without `.ts`).
   * @param tier - Target tier to remove from.
   * @param projectDir - Project directory (required when `tier='project'`).
   * @returns `true` when a file was removed, `false` when none existed.
   */
  removeExtension?(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean>;

  /**
   * List Pi extensions across all tiers, precedence-ordered.
   *
   * @remarks
   * Entries are returned in precedence order (project → user → global).
   * Higher-precedence tiers shadow lower-precedence entries with the
   * same name; the returned {@link ExtensionEntry.shadowed} flag
   * indicates shadowed copies so the caller can surface cross-tier name
   * collisions per ADR-035 §D1.
   *
   * @param projectDir - Project directory for the `project` tier. When
   *   omitted the `project` tier is skipped rather than failing.
   */
  listExtensions?(projectDir?: string): Promise<ExtensionEntry[]>;

  /**
   * List Pi sessions from the user-tier sessions directory.
   *
   * @remarks
   * Per ADR-035 §D2, MUST read only line 1 of each `*.jsonl` file. The
   * result is sorted by `mtimeMs` descending so the most recent
   * sessions appear first.
   *
   * @param opts - Options controlling which directories to scan.
   */
  listSessions?(opts?: { includeSubagents?: boolean }): Promise<SessionSummary[]>;

  /**
   * Load a Pi session's full body by id.
   *
   * @remarks
   * Reads the entire file as-is. The caller is responsible for
   * formatting / filtering; the harness only guarantees that the
   * returned `entries` are the raw JSONL lines in file order.
   *
   * @param id - Session id as recorded in the line-1 header.
   */
  showSession?(id: string): Promise<SessionDocument>;

  /**
   * List every model known to Pi — both custom (`models.json`) and
   * enabled selections (`settings.json:enabledModels`).
   *
   * @remarks
   * Per ADR-035 §D3, this is a read-only union with per-entry flags.
   * Mutation verbs (`add`, `remove`, `enable`, `disable`, `default`)
   * are separate methods to preserve the dual-file authority model.
   *
   * @param scope - Legacy two-tier scope (global/project) that
   *   determines which `models.json` and `settings.json` files to read.
   */
  listModels?(scope: HarnessScope): Promise<ModelListEntry[]>;

  /**
   * Read `models.json` for the given scope.
   *
   * @remarks
   * Missing files resolve to `{ providers: {} }`. Malformed JSON also
   * resolves to the empty config rather than throwing, matching
   * {@link Harness.readSettings}'s tolerant contract.
   */
  readModelsConfig?(scope: HarnessScope): Promise<PiModelsConfig>;

  /**
   * Write `models.json` for the given scope atomically.
   *
   * @remarks
   * The full config is written, not merged. Callers should read, patch,
   * then write. Uses an atomic tmp-then-rename sequence so a crash
   * mid-write cannot corrupt the file.
   */
  writeModelsConfig?(config: PiModelsConfig, scope: HarnessScope): Promise<void>;

  /**
   * Install a Pi prompt from a source directory into the given tier.
   *
   * @remarks
   * Per ADR-035 §D1 and the spec hook for T266, the source is a
   * directory containing `prompt.md` plus optional metadata. The
   * directory is copied recursively into the target tier. Conflict
   * handling mirrors {@link installExtension}.
   */
  installPrompt?(
    sourceDir: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }>;

  /** List Pi prompts across all tiers. */
  listPrompts?(projectDir?: string): Promise<PromptEntry[]>;

  /** Remove a Pi prompt by name from the given tier. */
  removePrompt?(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean>;

  /**
   * Install a Pi theme from a source file into the given tier.
   *
   * @remarks
   * Per ADR-035 §D1 and the spec hook for T267. The source may be a
   * `.ts` TypeScript theme module or a `.json` theme file; the file
   * extension is preserved so Pi picks the right loader.
   */
  installTheme?(
    sourceFile: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }>;

  /** List Pi themes across all tiers. */
  listThemes?(projectDir?: string): Promise<ThemeEntry[]>;

  /** Remove a Pi theme by name from the given tier. */
  removeTheme?(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean>;

  /**
   * Install a CANT profile (`.cant` file) into the given tier.
   *
   * @remarks
   * Per ADR-035 §D5 (CANT single engine), CANT profiles are first-class
   * Pi assets consumed by the canonical `cant-bridge.ts` extension via
   * `/cant:load <file>` at runtime. This verb copies a source `.cant`
   * file into the requested tier so the bridge can discover it.
   *
   * Implementations MUST validate the source via cant-core's 42-rule
   * engine before copying — invalid `.cant` files are rejected. The
   * conflict-on-write rule from §D1 cross-cutting concerns applies:
   * existing targets cause an error unless `opts.force` is set.
   *
   * Optional on the interface because only first-class harnesses with a
   * native CANT bridge support this verb.
   *
   * @param sourcePath - Absolute path to the source `.cant` file on disk.
   * @param name - Profile name (used as the target file basename).
   * @param tier - Target tier (`project`/`user`/`global`).
   * @param projectDir - Project directory (required when `tier='project'`).
   * @param opts - Install options (see {@link HarnessInstallOptions}).
   */
  installCantProfile?(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier; counts: CantProfileCounts }>;

  /**
   * Remove a CANT profile by name from the given tier.
   *
   * @remarks
   * Missing files are tolerated silently so the verb is usable as an
   * idempotent "ensure absent" operation.
   *
   * @param name - Profile name (basename without `.cant`).
   * @param tier - Target tier to remove from.
   * @param projectDir - Project directory (required when `tier='project'`).
   * @returns `true` when a file was removed, `false` when none existed.
   */
  removeCantProfile?(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean>;

  /**
   * List CANT profiles across all tiers, precedence-ordered.
   *
   * @remarks
   * Walks every tier in {@link HarnessTier} precedence order
   * (project → user → global) and parses each `.cant` file to extract
   * its section counts. Higher-precedence tiers shadow lower-precedence
   * entries with the same name; the {@link CantProfileEntry.shadowedByHigherTier}
   * flag indicates shadowed copies so callers can warn about
   * cross-tier name collisions per ADR-035 §D1.
   *
   * @param projectDir - Project directory for the `project` tier. When
   *   omitted the `project` tier is skipped rather than failing.
   */
  listCantProfiles?(projectDir?: string): Promise<CantProfileEntry[]>;

  /**
   * Validate a `.cant` file via cant-core's 42-rule engine without
   * installing anything.
   *
   * @remarks
   * Pure helper used by `caamp pi cant validate <path>`. Reads the file,
   * parses it, runs the validator, and returns a structured
   * {@link ValidateCantProfileResult}. Never mutates state on disk.
   *
   * @param sourcePath - Absolute path to the `.cant` file on disk.
   */
  validateCantProfile?(sourcePath: string): Promise<ValidateCantProfileResult>;
}
