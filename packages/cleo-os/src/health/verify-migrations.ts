/**
 * CleoOS Startup Migration Verify — fail-fast DB drift check.
 *
 * Runs `cleo upgrade --diagnose --json` via subprocess (CLI boundary — no
 * direct imports from `@cleocode/core` or `@cleocode/cleo`). Classifies each
 * finding into one of three severity levels and returns an aggregate result
 * that the harness startup path uses to decide whether to block worker spawn.
 *
 * ## Classification Rules
 *
 * - **ok**: All DB findings are `status:"ok"`. Silent pass-through.
 * - **warn**: One or more findings are `status:"warning"`. These correspond to
 *   states the reconciler already auto-fixed (Scenarios 1-4 in the migration
 *   reconciler). Logged but not blocking.
 * - **fatal**: One or more findings are `status:"error"`, OR the `cleo`
 *   binary could not be invoked, OR the JSON response was unparseable. These
 *   represent states the reconciler could not resolve — typically a missing
 *   migration folder (T1166 ENOENT class) or a schema missing a required
 *   table. Worker spawn is blocked.
 *
 * ## Subprocess Boundary
 *
 * This module calls `cleo upgrade --diagnose --json` — the same check
 * exposed by `cleo upgrade --diagnose` — because it is the richest single
 * command that validates all five DBs and migration journals without starting
 * an interactive session. If `cleo admin migrations verify` is added in a
 * future sprint, the runner interface makes it trivial to swap.
 *
 * @see ADR-036 — CleoOS Database Topology
 * @see ADR-049 — CleoOS Sovereignty Invariants
 * @task T1185
 * @epic T1150
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity of a single DB finding returned by the diagnose command.
 *
 * @public
 */
export type DriftSeverity = 'ok' | 'warn' | 'fatal';

/**
 * A single DB drift report entry derived from a `cleo upgrade --diagnose`
 * finding.
 *
 * @public
 */
export interface DriftReport {
  /** The check name (e.g. `"tasks.db.journal"`, `"brain.db.tables"`). */
  check: string;
  /** Severity classification applied by the verifier. */
  severity: DriftSeverity;
  /** Human-readable detail from the diagnose output. */
  details: string;
  /** Remediation hint when severity is `"warn"` or `"fatal"`. */
  fix?: string;
}

/**
 * Aggregated result returned by {@link verifyMigrations}.
 *
 * @public
 */
export interface MigrationVerifyResult {
  /**
   * `true` when the harness may proceed to spawn workers.
   * `false` when at least one fatal drift was detected.
   */
  ok: boolean;
  /** Aggregate severity across all findings. */
  severity: DriftSeverity;
  /** Per-finding drift reports. Empty on a clean run. */
  drift: DriftReport[];
  /**
   * Whether `cleo admin migrations verify` was available.
   *
   * Currently always `false` — this verb does not exist yet. The verifier
   * falls back to `cleo upgrade --diagnose --json`. Set to `true` in a future
   * sprint once the dedicated verb lands.
   */
  usedDedicatedVerb: boolean;
}

// ---------------------------------------------------------------------------
// Runner interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Raw finding shape returned inside the `cleo upgrade --diagnose --json`
 * response body.
 *
 * @internal
 */
interface DiagnoseFinding {
  check: string;
  status: 'ok' | 'warning' | 'error';
  details: string;
  fix?: string;
}

/**
 * Shape of the JSON envelope returned by `cleo upgrade --diagnose --json`.
 *
 * @internal
 */
interface DiagnoseEnvelope {
  success: boolean;
  data?: {
    success?: boolean;
    findings?: DiagnoseFinding[];
    summary?: {
      ok: number;
      warnings: number;
      errors: number;
    };
  };
}

/**
 * Abstraction over the subprocess invocation so tests can inject a stub.
 *
 * @public
 */
export interface CliRunner {
  /**
   * Run `cleo upgrade --diagnose --json` and return the raw stdout.
   *
   * @throws When the subprocess exits non-zero or cannot be spawned.
   */
  runDiagnose(): Promise<string>;
}

/**
 * Default {@link CliRunner} that shells out to the real `cleo` binary.
 *
 * @public
 */
export class DefaultCliRunner implements CliRunner {
  /** @inheritdoc */
  async runDiagnose(): Promise<string> {
    const { stdout } = await execFileAsync('cleo', ['upgrade', '--diagnose', '--json'], {
      timeout: 15_000,
    });
    return stdout;
  }
}

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

/**
 * Map a raw `status` string from the diagnose output to a {@link DriftSeverity}.
 *
 * Uses conservative thresholds per the T1185 classification contract:
 * - `"ok"` → `ok`
 * - `"warning"` → `warn`  (reconciler already handled it; non-blocking)
 * - `"error"` → `fatal`   (reconciler could not resolve; block spawn)
 *
 * @param status - Raw status string from the diagnose finding.
 * @returns Classified severity.
 *
 * @internal
 */
function classifyStatus(status: DiagnoseFinding['status']): DriftSeverity {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'warning':
      return 'warn';
    case 'error':
      return 'fatal';
    default:
      // Treat unknown status values conservatively.
      return 'fatal';
  }
}

/**
 * Derive the aggregate severity across all drift reports.
 *
 * `fatal` dominates `warn` dominates `ok`.
 *
 * @param reports - Array of per-finding reports.
 * @returns Highest severity found, or `"ok"` when the array is empty.
 *
 * @internal
 */
function aggregateSeverity(reports: DriftReport[]): DriftSeverity {
  let highest: DriftSeverity = 'ok';
  for (const r of reports) {
    if (r.severity === 'fatal') return 'fatal';
    if (r.severity === 'warn') highest = 'warn';
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse the raw stdout from `cleo upgrade --diagnose --json` into an array
 * of {@link DriftReport} entries.
 *
 * Returns a single `fatal` entry when parsing fails so callers always have a
 * consistent result shape to act on.
 *
 * @param raw - Raw stdout string from the subprocess.
 * @returns Parsed drift reports.
 *
 * @internal
 */
function parseDiagnoseOutput(raw: string): DriftReport[] {
  let envelope: DiagnoseEnvelope;
  try {
    envelope = JSON.parse(raw) as DiagnoseEnvelope;
  } catch {
    return [
      {
        check: 'parse',
        severity: 'fatal',
        details: 'Failed to parse cleo upgrade --diagnose --json output',
        fix: 'Run `cleo upgrade --diagnose` manually to inspect DB state',
      },
    ];
  }

  const findings = envelope.data?.findings;
  if (!Array.isArray(findings)) {
    return [
      {
        check: 'parse',
        severity: 'fatal',
        details: 'cleo upgrade --diagnose response missing findings array',
        fix: 'Run `cleo upgrade --diagnose` manually to inspect DB state',
      },
    ];
  }

  return findings
    .filter((f) => f.status !== 'ok')
    .map((f) => ({
      check: f.check,
      severity: classifyStatus(f.status),
      details: f.details,
      fix: f.fix,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the migration verify pre-check and return a structured result.
 *
 * Invokes `cleo upgrade --diagnose --json` via subprocess (CLI boundary).
 * Classifies every non-ok finding into `warn` or `fatal`. A single `fatal`
 * finding causes `ok: false` — the harness startup path must block spawn and
 * print remediation instructions before exiting.
 *
 * @param runner - Injectable {@link CliRunner}; defaults to
 *   {@link DefaultCliRunner} which shells out to the real `cleo` binary.
 * @returns Structured {@link MigrationVerifyResult}.
 *
 * @example
 * ```typescript
 * const result = await verifyMigrations();
 * if (!result.ok) {
 *   // print structured error + remediation, then exit
 * }
 * ```
 *
 * @public
 */
export async function verifyMigrations(
  runner: CliRunner = new DefaultCliRunner(),
): Promise<MigrationVerifyResult> {
  let rawOutput: string;

  try {
    rawOutput = await runner.runDiagnose();
  } catch (err) {
    // Subprocess spawn failure (ENOENT: cleo not on PATH, timeout, etc.).
    const detail = err instanceof Error ? err.message : String(err);
    const isEnoent =
      detail.includes('ENOENT') ||
      detail.includes('not found') ||
      detail.includes('command not found');

    const drift: DriftReport[] = [
      {
        check: 'cleo-binary',
        severity: 'fatal',
        details: isEnoent
          ? 'cleo binary not found on PATH — cannot verify DB migration state'
          : `cleo upgrade --diagnose failed: ${detail}`,
        fix: isEnoent
          ? 'Install cleo: npm install -g @cleocode/cleo-os'
          : 'Run `cleo upgrade --diagnose` manually; check exit code',
      },
    ];

    return { ok: false, severity: 'fatal', drift, usedDedicatedVerb: false };
  }

  const drift = parseDiagnoseOutput(rawOutput);
  const severity = aggregateSeverity(drift);

  return {
    ok: severity !== 'fatal',
    severity,
    drift,
    usedDedicatedVerb: false,
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers (used by cli.ts startup path)
// ---------------------------------------------------------------------------

/**
 * Format a {@link MigrationVerifyResult} as a human-readable fatal error
 * block for printing to stderr.
 *
 * Only called when `result.ok === false` (fatal drift detected).
 *
 * @param result - The failed verify result.
 * @returns Multi-line string ready for `process.stderr.write`.
 *
 * @public
 */
export function renderFatalDriftError(result: MigrationVerifyResult): string {
  const lines: string[] = [
    '',
    'CleoOS startup blocked — DB migration drift detected',
    '═══════════════════════════════════════════════════════════',
    '',
    'The following issues prevent safe worker spawn:',
    '',
  ];

  for (const d of result.drift) {
    if (d.severity === 'fatal') {
      lines.push(`  [FATAL] ${d.check}`);
      lines.push(`          ${d.details}`);
      if (d.fix !== undefined) {
        lines.push(`          Fix: ${d.fix}`);
      }
      lines.push('');
    }
  }

  lines.push('Remediation options:');
  lines.push('  1. Run `cleo upgrade` to apply pending migrations');
  lines.push('  2. Run `cleo upgrade --diagnose` for detailed DB inspection');
  lines.push('  3. If the project DB is corrupted: `cleo init --force` (WARNING: resets tasks.db)');
  lines.push('  4. For cloud-sync issues: `cleo init --provider signaldock`');
  lines.push('');
  lines.push('If this is a fresh clone, run `cleo init` to initialise the project database.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a {@link MigrationVerifyResult} as a human-readable warning block
 * for printing to stdout.
 *
 * Only called when `result.severity === "warn"` (reconciler already handled
 * the drift — non-blocking).
 *
 * @param result - The warn-severity verify result.
 * @returns Multi-line string ready for `process.stdout.write`.
 *
 * @public
 */
export function renderWarnDrift(result: MigrationVerifyResult): string {
  const lines: string[] = ['[cleo-os] DB migration notice (non-blocking):'];

  for (const d of result.drift) {
    if (d.severity === 'warn') {
      lines.push(`  - ${d.check}: ${d.details}`);
      if (d.fix !== undefined) {
        lines.push(`    Fix: ${d.fix}`);
      }
    }
  }

  lines.push('  Run `cleo upgrade` to resolve these warnings.');
  lines.push('');

  return lines.join('\n');
}
