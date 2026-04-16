/**
 * Acceptance gate discriminated union and result types.
 *
 * A machine-verifiable acceptance gate. Gates coexist with free-text criteria
 * in `Task.acceptance`; the runtime executes only gates and records results in
 * `task.verification.gateResults` and in the `lifecycle_gate_results` DB table.
 *
 * Six gate kinds are supported:
 * - `test`    — run a command and assert exit code / test-count
 * - `file`    — assert properties of a file on disk
 * - `command` — run any CLI command and assert exit code / stdout
 * - `lint`    — run a static-analysis tool and require a clean result
 * - `http`    — hit a URL and assert status + optional body
 * - `manual`  — explicit escape hatch requiring human/agent verdict
 *
 * @epic T760
 * @task T763
 * @task T779
 * @see {@link https://github.com/kryptobaseddev/cleo} T760 RCASD hardening
 */

// ─── Base ────────────────────────────────────────────────────────────────────

/** Fields every gate variant carries. */
export interface GateBase {
  /**
   * Optional REQ-ID (GSD-style: `TIMER-03`, `A11Y-04`). When present the
   * gate is addressable via `cleo req show <taskId> --id TIMER-03` and its
   * result is indexed in `lifecycle_gate_results.gate_name`.
   */
  req?: string;

  /**
   * Free-text description of what this gate is checking. Shown in
   * `cleo show` output and in failure messages. Required so agents and
   * humans can read the gate without executing it.
   */
  description: string;

  /**
   * When `true` a failure of this gate does not block completion — it is
   * recorded as `result: 'warn'` in `lifecycle_gate_results`.
   *
   * @defaultValue false
   */
  advisory?: boolean;

  /**
   * Gate timeout in milliseconds.
   *
   * @defaultValue 120_000
   */
  timeoutMs?: number;
}

// ─── Variants ────────────────────────────────────────────────────────────────

/**
 * Run a command; pass when exit code is 0 and when at least `minCount`
 * tests have run. Designed for test suites:
 * `{ kind: 'test', command: 'pnpm test', expect: 'pass' }`.
 */
export interface TestGate extends GateBase {
  kind: 'test';
  /** Shell command. Executed via `child_process.spawn`, no `shell: true`. */
  command: string;
  /** Arguments split explicitly (avoids shell-injection). */
  args?: string[];
  /**
   * - `"pass"`: exit code 0 AND stdout contains no `FAIL|failing|Error:` pattern.
   * - `"exit0"`: exit code 0 only (permissive mode).
   */
  expect: 'pass' | 'exit0';
  /** Minimum number of tests that must have run. */
  minCount?: number;
  /** Working directory relative to project root. Default `.`. */
  cwd?: string;
  /** Environment variable overrides. Keys must match `/^[A-Z_][A-Z0-9_]*$/`. */
  env?: Record<string, string>;
}

/**
 * Assert properties of a file on disk. Multiple assertions are AND-ed:
 * all must hold for the gate to pass.
 */
export interface FileGate extends GateBase {
  kind: 'file';
  /**
   * Absolute or project-root-relative path. Globs are not supported here
   * — use one gate per path.
   */
  path: string;
  assertions: FileAssertion[];
}

/**
 * A single assertion about a file on disk.
 *
 * All assertion variants in a `FileGate` must pass for the gate to pass.
 */
export type FileAssertion =
  | { type: 'exists' }
  | { type: 'absent' }
  | { type: 'nonEmpty' }
  | { type: 'maxBytes'; value: number }
  | { type: 'minBytes'; value: number }
  | { type: 'contains'; value: string }
  | {
      type: 'matches';
      /** Serialized `RegExp` source string. */
      regex: string;
      /** Optional `RegExp` flags, e.g. `"gim"`. */
      flags?: string;
    }
  | { type: 'sha256'; value: string };

/**
 * Run any CLI command and assert exit code and optional stdout match.
 * Escape hatch for anything `TestGate`/`LintGate`/`HttpGate` do not cover.
 */
export interface CommandGate extends GateBase {
  kind: 'command';
  cmd: string;
  args?: string[];
  /**
   * Expected exit code.
   *
   * @defaultValue 0
   */
  exitCode?: number;
  /** stdout must match this regex source. */
  stdoutMatches?: string;
  /** stderr must match this regex source. */
  stderrMatches?: string;
  /** Working directory relative to project root. */
  cwd?: string;
  /** Environment variable overrides. */
  env?: Record<string, string>;
}

/**
 * Run a static-analysis tool and require a clean result.
 * Wraps common cases with known exit codes so agents do not re-invent them.
 */
export interface LintGate extends GateBase {
  kind: 'lint';
  /** Linting tool to invoke. */
  tool: 'biome' | 'eslint' | 'tsc' | 'prettier' | 'rustc' | 'clippy';
  /**
   * Tool arguments. Defaults: biome→`['check', '.']`, eslint→`['.']`,
   * tsc→`['--noEmit']`.
   */
  args?: string[];
  /**
   * - `"clean"`: zero findings.
   * - `"noErrors"`: tolerates warnings but not errors.
   */
  expect: 'clean' | 'noErrors';
  /** Working directory relative to project root. */
  cwd?: string;
}

/**
 * Hit a URL and assert HTTP status and optional body match. For tasks that
 * ship a webapp or API. The runner starts a server only if `startCommand`
 * is set and tears it down after the probe.
 */
export interface HttpGate extends GateBase {
  kind: 'http';
  url: string;
  /** HTTP method for the probe request. Default `"GET"`. */
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
  /** Expected HTTP status code. */
  status: number;
  /** Response body must match this regex source. */
  bodyMatches?: string;
  /** Request headers to include. */
  headers?: Record<string, string>;
  /** Pre-probe command to start a server. Runs in background; killed after probe. */
  startCommand?: string;
  /**
   * Milliseconds to wait after starting before probing.
   *
   * @defaultValue 2000
   */
  startupDelayMs?: number;
}

/**
 * Explicit escape hatch: a gate the runtime CANNOT verify automatically.
 * Requires a human or a different agent to record a verdict before
 * `cleo complete` will accept it.
 *
 * This is the ONLY gate variant that preserves today's free-text behaviour.
 * Use for subjective criteria: "copy reads well", "visual design matches mockup".
 */
export interface ManualGate extends GateBase {
  kind: 'manual';
  /** Question or prompt shown to the human or agent performing verification. */
  prompt: string;
  /**
   * Valid verdicts the reviewer may record.
   *
   * @defaultValue ['pass', 'fail']
   */
  verdicts?: ('pass' | 'fail' | 'warn')[];
}

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * A machine-verifiable acceptance gate attached to a task.
 *
 * All variants share the {@link GateBase} fields (`req`, `description`,
 * `advisory`, `timeoutMs`). The `kind` discriminant selects the variant.
 *
 * @example
 * ```ts
 * const gate: AcceptanceGate = {
 *   kind: 'test',
 *   command: 'pnpm test',
 *   expect: 'pass',
 *   minCount: 3,
 *   description: '≥3 tests must pass',
 * };
 * ```
 */
export type AcceptanceGate = TestGate | FileGate | CommandGate | LintGate | HttpGate | ManualGate;

/** All valid `kind` discriminants for `AcceptanceGate`. */
export type AcceptanceGateKind = AcceptanceGate['kind'];

// ─── Result ──────────────────────────────────────────────────────────────────

/**
 * Result of running one acceptance gate.
 *
 * Persisted to `lifecycle_gate_results` and summarised in
 * `task.verification.gateResults`.
 *
 * NOTE: Named `AcceptanceGateResult` (not `GateResult`) to avoid collision
 * with the existing {@link GateResult} from `./warp-chain.js` which describes
 * WarpChain LOOM-gate evaluation outcomes.
 */
export interface AcceptanceGateResult {
  /** Zero-based index in the task's acceptance array. */
  index: number;
  /** REQ-ID if the gate had one, else `undefined`. */
  req?: string;
  /** Gate variant. */
  kind: AcceptanceGateKind;
  /** Outcome of the gate execution. */
  result: 'pass' | 'fail' | 'warn' | 'skipped' | 'error';
  /** Wall-clock duration of the gate execution in milliseconds. */
  durationMs: number;
  /** Truncated stdout/stderr or file snippet shown in failure messages. */
  evidence?: string;
  /** Error message when `result` is `"error"` (the gate runner itself crashed). */
  errorMessage?: string;
  /** ISO 8601 timestamp at which the gate ran. */
  checkedAt: string;
  /** Agent identifier or `"human"` that ran or attested the gate. */
  checkedBy: string;
}
