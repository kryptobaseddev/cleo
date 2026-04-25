/**
 * Registry-driven post-release invariants gate (ADR-056 D5).
 *
 * Defines the registration API + execution loop for release-time invariants.
 * This module is intentionally generic: it knows nothing about archiveReason,
 * schema-vs-CHECK drift, or any other specific check. Concrete invariants
 * register themselves on module load (side-effect imports in
 * `./index.ts`) and the CLI / `runInvariants(tag, options)` entry point
 * iterates over them.
 *
 * Council 2026-04-24 Expansionist sharpest point: ~50 LOC of registration
 * plumbing on top of T1411's already-scoped hook code retires the entire
 * class of drift bugs that ADR-054's six patches paid for ad-hoc.
 *
 * @task T1411
 * @epic T1407
 * @adr ADR-056 D5
 */

/**
 * Severity classifications for invariants.
 *
 * - `info`     — informational; never blocks reconcile.
 * - `warning`  — surfaced in the report; reconcile proceeds.
 * - `error`    — fatal; CLI should exit non-zero.
 */
export type InvariantSeverity = 'info' | 'warning' | 'error';

/**
 * Options passed to every registered invariant when {@link runInvariants}
 * iterates the registry.
 *
 * Concrete invariants MAY ignore fields they do not need.
 */
export interface InvariantRunOptions {
  /** Release tag being reconciled (e.g. `v2026.4.145`). */
  tag: string;
  /** Repository root used as `cwd` for git subprocess calls. */
  repoRoot: string;
  /** When `true`, invariants MUST NOT mutate state (DB writes, audit log writes). */
  dryRun: boolean;
  /** Optional working directory passed through to data accessors (test isolation). */
  cwd?: string;
}

/**
 * Per-invariant outcome appended to the aggregated {@link InvariantReport}.
 *
 * `details` is opaque JSON — invariants are free to populate it with their
 * own structured payload (counts, IDs, follow-up task references, etc.).
 */
export interface InvariantResult {
  /** Stable identifier of the invariant that produced this result. */
  id: string;
  /** Severity for this run; may differ from the registration default. */
  severity: InvariantSeverity;
  /** Human-readable summary (single line preferred). */
  message: string;
  /** Number of items this invariant processed (e.g. tasks, commits). */
  processed: number;
  /** Number of items the invariant successfully reconciled / fixed. */
  reconciled: number;
  /** Number of items left unreconciled (operator follow-up required). */
  unreconciled: number;
  /** Number of hard errors raised inside the invariant. */
  errors: number;
  /** Optional structured payload for downstream consumers. */
  details?: Record<string, unknown>;
}

/**
 * Aggregated report returned by {@link runInvariants}.
 *
 * Each individual {@link InvariantResult} is preserved verbatim; aggregate
 * counts are summed across all results so callers can render a one-line
 * summary without re-iterating.
 */
export interface InvariantReport {
  /** Tag this report covers. */
  tag: string;
  /** Aggregate `processed` count summed across all invariants. */
  processed: number;
  /** Aggregate `reconciled` count. */
  reconciled: number;
  /** Aggregate `unreconciled` count (operator follow-up cohort). */
  unreconciled: number;
  /** Aggregate `errors` count. */
  errors: number;
  /** Per-invariant results, in registration order. */
  results: InvariantResult[];
}

/**
 * Specification for a registered invariant.
 *
 * `check` is invoked once per `runInvariants(tag, …)` call; it MUST be
 * idempotent on dry-run inputs and idempotent-on-success on live inputs.
 */
export interface RegisteredInvariant {
  /** Stable identifier (kebab-case recommended). */
  id: string;
  /** One-line description for `--list` / report rendering. */
  description: string;
  /** Default severity when the invariant fires without specifying one. */
  severity: InvariantSeverity;
  /** Implementation that performs the check (and reconciliation, if applicable). */
  check: (options: InvariantRunOptions) => Promise<InvariantResult>;
}

/**
 * Module-local registry. Single global instance — invariants register on
 * module load via side-effect imports.
 */
const registry: Map<string, RegisteredInvariant> = new Map();

/**
 * Register an invariant with the post-release gate.
 *
 * Re-registration with the same `id` REPLACES the previous entry. This is
 * intentional: it allows tests to swap a noisy invariant for a stub without
 * touching the global registry order.
 *
 * @param spec - Invariant specification.
 */
export function registerInvariant(spec: RegisteredInvariant): void {
  registry.set(spec.id, spec);
}

/**
 * Return all currently-registered invariants in insertion order.
 *
 * Returns a snapshot array; mutations on the array do not affect the
 * underlying registry.
 */
export function getInvariants(): RegisteredInvariant[] {
  return Array.from(registry.values());
}

/**
 * Clear the registry. Intended for test isolation only.
 *
 * @internal
 */
export function clearInvariants(): void {
  registry.clear();
}

/**
 * Execute every registered invariant against the given release tag and
 * return an aggregated report.
 *
 * Errors thrown by an invariant `check` function are caught and converted
 * into an {@link InvariantResult} with `severity='error'` and `errors: 1`
 * so a single misbehaving invariant cannot prevent the rest of the gate
 * from running.
 *
 * @param tag - Release tag being reconciled.
 * @param options - Run options (dryRun, repoRoot, cwd).
 * @returns Aggregated {@link InvariantReport}.
 */
export async function runInvariants(
  tag: string,
  options: { dryRun?: boolean; repoRoot?: string; cwd?: string } = {},
): Promise<InvariantReport> {
  const repoRoot = options.repoRoot ?? options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? false;

  const runOpts: InvariantRunOptions = {
    tag,
    repoRoot,
    dryRun,
    cwd: options.cwd,
  };

  const results: InvariantResult[] = [];
  for (const invariant of registry.values()) {
    try {
      const result = await invariant.check(runOpts);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: invariant.id,
        severity: 'error',
        message: `invariant '${invariant.id}' threw: ${message}`,
        processed: 0,
        reconciled: 0,
        unreconciled: 0,
        errors: 1,
      });
    }
  }

  const aggregate = results.reduce(
    (acc, r) => ({
      processed: acc.processed + r.processed,
      reconciled: acc.reconciled + r.reconciled,
      unreconciled: acc.unreconciled + r.unreconciled,
      errors: acc.errors + r.errors,
    }),
    { processed: 0, reconciled: 0, unreconciled: 0, errors: 0 },
  );

  return {
    tag,
    ...aggregate,
    results,
  };
}
