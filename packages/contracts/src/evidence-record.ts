/**
 * EvidenceRecord discriminated union — typed proof artifacts produced by IVTR agents.
 *
 * Each variant represents a specific kind of evidence that an IVTR-phase agent
 * (implement, validate, test) can emit. All variants share a common set of
 * provenance fields (`agentIdentity`, `attachmentSha256`, `ranAt`, `durationMs`)
 * so that evidence rows can be queried, correlated, and archived uniformly.
 *
 * Five kinds are defined:
 * - `impl-diff`         — a code change produced by an implement-phase agent
 * - `validate-spec-check` — a spec-requirements check by a validate-phase agent
 * - `test-output`       — the output of a test command run by a test-phase agent
 * - `lint-report`       — a static-analysis run (biome, tsc, etc.)
 * - `command-output`    — a generic CLI command invocation with exit code
 *
 * @epic T810
 * @task T816
 * @see {@link EvidenceRecordKind} for all discriminant values
 */

// ─── Variants ────────────────────────────────────────────────────────────────

/**
 * Evidence that an implement-phase agent produced a code diff.
 *
 * `filesChanged` lists the relative paths of every modified file.
 * `attachmentSha256` is the SHA-256 hex digest of the serialised diff attachment.
 */
export interface ImplDiffRecord {
  kind: 'impl-diff';
  /** RCASD lifecycle phase that produced this record. */
  phase: 'implement';
  /** Identity string of the agent that ran this action (e.g. `"T816-worker"`). */
  agentIdentity: string;
  /** SHA-256 hex digest (64 chars) of the attached diff blob. */
  attachmentSha256: string;
  /** Relative paths of every file the diff touches. */
  filesChanged: string[];
  /** Net lines added across all changed files. */
  linesAdded: number;
  /** Net lines removed across all changed files. */
  linesRemoved: number;
  /** ISO 8601 timestamp at which the diff was captured. */
  ranAt: string;
  /** Wall-clock duration of the implement action in milliseconds. */
  durationMs: number;
}

/**
 * Evidence that a validate-phase agent checked one or more REQ-IDs against
 * the implementation and recorded a pass/fail verdict.
 */
export interface ValidateSpecCheckRecord {
  kind: 'validate-spec-check';
  /** RCASD lifecycle phase that produced this record. */
  phase: 'validate';
  /** Identity string of the agent that ran this action. */
  agentIdentity: string;
  /** SHA-256 hex digest (64 chars) of the spec-check report attachment. */
  attachmentSha256: string;
  /** REQ-IDs checked in this run (e.g. `["IVTR-01", "IVTR-02"]`). */
  reqIdsChecked: string[];
  /** `true` when all checked REQ-IDs passed; `false` if any failed. */
  passed: boolean;
  /** Human-readable summary of results per REQ-ID. */
  details: string;
  /** ISO 8601 timestamp at which the check ran. */
  ranAt: string;
  /** Wall-clock duration of the validation check in milliseconds. */
  durationMs: number;
}

/**
 * Evidence that a test-phase agent ran a test command and recorded counts.
 */
export interface TestOutputRecord {
  kind: 'test-output';
  /** RCASD lifecycle phase that produced this record. */
  phase: 'test';
  /** Identity string of the agent that ran this action. */
  agentIdentity: string;
  /** SHA-256 hex digest (64 chars) of the test-output attachment. */
  attachmentSha256: string;
  /** The full test command that was executed (e.g. `"pnpm --filter @cleocode/contracts run test"`). */
  command: string;
  /** Exit code returned by the test command. */
  exitCode: number;
  /** Number of individual test cases that passed. */
  testsPassed: number;
  /** Number of individual test cases that failed. */
  testsFailed: number;
  /** ISO 8601 timestamp at which the test command started. */
  ranAt: string;
  /** Wall-clock duration of the full test run in milliseconds. */
  durationMs: number;
}

/**
 * Evidence that a lint / static-analysis tool was run.
 *
 * The `phase` field is `'implement' | 'test'` because lint is commonly run
 * after a code change (implement) or as part of a test suite (test).
 */
export interface LintReportRecord {
  kind: 'lint-report';
  /** RCASD lifecycle phase that produced this record. */
  phase: 'implement' | 'test';
  /** Identity string of the agent that ran this action. */
  agentIdentity: string;
  /** SHA-256 hex digest (64 chars) of the lint-output attachment. */
  attachmentSha256: string;
  /** Name of the lint tool that was invoked (e.g. `"biome"`, `"tsc"`). */
  tool: string;
  /** `true` when the lint run produced zero errors. */
  passed: boolean;
  /** Number of warnings emitted (may be > 0 even when `passed` is `true`). */
  warnings: number;
  /** Number of errors emitted. Non-zero means `passed` is `false`. */
  errors: number;
  /** ISO 8601 timestamp at which the lint tool was invoked. */
  ranAt: string;
  /** Wall-clock duration of the lint run in milliseconds. */
  durationMs: number;
}

/**
 * Evidence that an agent ran an arbitrary CLI command and recorded its exit code.
 *
 * Use this as the catch-all when none of the other variants fit.
 */
export interface CommandOutputRecord {
  kind: 'command-output';
  /** RCASD lifecycle phase that produced this record. */
  phase: 'implement' | 'validate' | 'test';
  /** Identity string of the agent that ran this action. */
  agentIdentity: string;
  /** SHA-256 hex digest (64 chars) of the command-output attachment. */
  attachmentSha256: string;
  /** The CLI command that was executed. */
  cmd: string;
  /** Exit code returned by the command. */
  exitCode: number;
  /** ISO 8601 timestamp at which the command was invoked. */
  ranAt: string;
  /** Wall-clock duration of the command in milliseconds. */
  durationMs: number;
}

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * A typed evidence record produced by an IVTR-phase agent.
 *
 * The `kind` discriminant selects the variant. All variants carry
 * `agentIdentity`, `attachmentSha256`, `ranAt`, and `durationMs` for
 * uniform provenance tracking.
 *
 * @example
 * ```ts
 * const rec: EvidenceRecord = {
 *   kind: 'test-output',
 *   phase: 'test',
 *   agentIdentity: 'T816-worker',
 *   attachmentSha256: 'a'.repeat(64),
 *   command: 'pnpm --filter @cleocode/contracts run test',
 *   exitCode: 0,
 *   testsPassed: 10,
 *   testsFailed: 0,
 *   ranAt: '2026-04-16T00:00:00.000Z',
 *   durationMs: 1234,
 * };
 * ```
 */
export type EvidenceRecord =
  | ImplDiffRecord
  | ValidateSpecCheckRecord
  | TestOutputRecord
  | LintReportRecord
  | CommandOutputRecord;

/** All valid `kind` discriminants for {@link EvidenceRecord}. */
export type EvidenceRecordKind = EvidenceRecord['kind'];
