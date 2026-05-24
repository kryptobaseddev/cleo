/**
 * Invariant-registry walker for `cleo doctor --audit-invariants` (T10340).
 *
 * Iterates the central `INVARIANTS_REGISTRY` from `@cleocode/contracts`
 * (assembled by Saga T10326 R1-R5 — ADR-073 I1-I8 + ADR-070 ORC-001..014 +
 * ADR-056 D1-D6) and produces one {@link InvariantAuditEntry} per registered
 * invariant. Entries whose `runtimeGate` resolves to a "scan current DB"
 * audit adapter (today: ADR-073 sagas via `auditSagaHierarchy`) execute
 * the adapter and forward violations into the entry. Entries whose
 * runtime gates are spawn-bound, session-bound, or release-tag-bound (the
 * majority of ADR-070 ORC codes + ADR-056 D5) report `not-applicable`
 * with the gate location so operators can see the gap end-to-end. Entries
 * with `runtimeGate: null` report `documented` so the gap analysis (how
 * many invariants ARE registry-only) is visible in `--json` output.
 *
 * Design:
 *   - **Read-only.** Performs zero writes against `.cleo/tasks.db`.
 *   - **Adapter-pluggable.** New per-ADR adapters land via the
 *     `ADAPTERS` map below; the walker code is invariant-shape-agnostic.
 *   - **DRY.** The same `auditRegistryEntry` primitive feeds both the
 *     `--audit-invariants` registry walk AND the focused `--audit-sagas`
 *     alias (which filters to ADR-073 only).
 *
 * @task T10340 — R6: cleo doctor --audit-invariants
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @see packages/contracts/src/invariants/index.ts — registry SSoT
 * @see packages/core/src/doctor/saga-audit.ts — ADR-073 adapter (consumed)
 */

import type {
  InvariantAuditEntry,
  InvariantAuditResult,
  InvariantAuditStatus,
  InvariantAuditViolation,
  InvariantSeverity,
  RegisteredInvariant,
  SagaAuditViolation,
} from '@cleocode/contracts';
import { INVARIANTS_REGISTRY } from '@cleocode/contracts';
import { auditSagaHierarchy } from './saga-audit.js';

/**
 * Per-ADR adapter shape.
 *
 * Adapters translate a registry entry into one of the four
 * {@link InvariantAuditStatus} outcomes. Each adapter is keyed on the
 * `${adr}.${code}` registry key in the {@link ADAPTERS} map below.
 *
 * @internal
 */
interface InvariantAuditAdapter {
  /**
   * Run the adapter against the project's current state.
   *
   * Returns `null` when the adapter cannot run in this context (e.g.
   * ADR-056 D5 needs a release tag — irrelevant to a `cleo doctor` call).
   * Returns a populated `{status, violations, note}` triple otherwise.
   */
  readonly check: (projectRoot: string) => Promise<{
    status: InvariantAuditStatus;
    violations: InvariantAuditViolation[];
    note: string;
  } | null>;
}

/**
 * Module-level cache so a single `auditInvariantRegistry` call shares the
 * saga audit across all three ADR-073 entries (I5, I7, depth) without
 * re-querying the DB three times.
 *
 * Reset on every call to `auditInvariantRegistry` so test isolation holds.
 *
 * @internal
 */
interface SagaAuditCache {
  result: Awaited<ReturnType<typeof auditSagaHierarchy>> | null;
}

/**
 * Convert a {@link SagaAuditViolation} into the
 * {@link InvariantAuditViolation} shape carried by `InvariantAuditEntry`.
 *
 * The saga audit reports `kind: 'I5' | 'I7' | 'depth' | 'auto-close-drift'`;
 * the registry audit emits the canonical `${adr}.${code}` key instead.
 *
 * @internal
 */
function sagaViolationToInvariantViolation(
  violation: SagaAuditViolation,
  invariantKey: string,
): InvariantAuditViolation {
  return {
    invariantKey,
    offendingId: violation.offendingId,
    message: violation.message,
    repairCommand: violation.repairCommand,
  };
}

/**
 * Build the saga audit adapter shared by ADR-073 I5 / I7 / depth-related
 * entries. The adapter reuses {@link auditSagaHierarchy} (already
 * production-hardened by T10119) and filters its violations to those
 * matching a specific saga-audit `kind`.
 *
 * @internal
 */
function makeSagaAdapter(
  cache: SagaAuditCache,
  matchKind: 'I5' | 'I7' | 'depth' | 'auto-close-drift',
  invariantKey: string,
): InvariantAuditAdapter {
  return {
    check: async (projectRoot) => {
      if (cache.result === null) {
        cache.result = await auditSagaHierarchy(projectRoot);
      }
      const result = cache.result;
      const matchingViolations: SagaAuditViolation[] = [];
      for (const saga of result.sagas) {
        for (const v of saga.violations) {
          if (v.kind === matchKind) {
            matchingViolations.push(v);
          }
        }
      }
      const violations = matchingViolations.map((v) =>
        sagaViolationToInvariantViolation(v, invariantKey),
      );
      return {
        status: violations.length === 0 ? 'pass' : 'fail',
        violations,
        note:
          violations.length === 0
            ? `auditSagaHierarchy: 0 ${matchKind} violations across ${result.sagas.length} saga(s)`
            : `auditSagaHierarchy: ${violations.length} ${matchKind} violation(s) detected`,
      };
    },
  };
}

/**
 * Build a stable note explaining why a spawn-/session-bound runtime gate
 * is not applicable to the doctor walk.
 *
 * @internal
 */
function notApplicableNote(functionName: string, contextNote: string): string {
  return `runtimeGate '${functionName}' is ${contextNote} — no current-DB scan equivalent`;
}

/**
 * Resolve the adapter for a single registry entry. Returns `null` for
 * entries whose `runtimeGate` exists but lacks a current-DB-scan
 * interpretation; the walker classifies those as `'not-applicable'`.
 *
 * @internal
 */
function resolveAdapter(
  invariant: RegisteredInvariant,
  cache: SagaAuditCache,
): InvariantAuditAdapter | null {
  const key = `${invariant.adr}.${invariant.code}`;

  // ADR-073 saga adapters — I5, I7, and depth all reuse the cached
  // auditSagaHierarchy result. I3 is a saga-write-time gate (no current-
  // DB-scan equivalent today; surfaces as 'not-applicable').
  if (key === 'ADR-073.I5') return makeSagaAdapter(cache, 'I5', key);
  if (key === 'ADR-073.I7') return makeSagaAdapter(cache, 'I7', key);

  return null;
}

/**
 * Audit a single registry entry. Shared internally by the registry walk
 * (`auditInvariantRegistry`) AND by the focused `--audit-sagas` alias
 * (which calls back into the walk with an `adrFilter`).
 *
 * The function NEVER throws — adapter exceptions are caught and surfaced
 * as a single-violation `'fail'` entry so one misbehaving adapter cannot
 * abort the whole registry walk.
 *
 * @param invariant - The registry entry to audit.
 * @param projectRoot - Absolute path to the project root.
 * @param cache - Module-local cache shared across one walk.
 * @returns A populated {@link InvariantAuditEntry}.
 *
 * @internal
 */
async function auditRegistryEntry(
  invariant: RegisteredInvariant,
  projectRoot: string,
  cache: SagaAuditCache,
): Promise<InvariantAuditEntry> {
  const key = `${invariant.adr}.${invariant.code}`;
  const runtimeGateName = invariant.runtimeGate?.functionName ?? null;

  // 1) runtimeGate === null → documented (display/storage/process).
  if (invariant.runtimeGate === null) {
    return {
      invariantKey: key,
      adr: invariant.adr,
      code: invariant.code,
      name: invariant.name,
      severity: invariant.severity,
      status: 'documented',
      note: 'runtimeGate:null — invariant enforced by DB CHECK, convention, or CI lint',
      runtimeGate: null,
      violations: [],
    };
  }

  // 2) Adapter resolves → execute it.
  const adapter = resolveAdapter(invariant, cache);
  if (adapter !== null) {
    try {
      const outcome = await adapter.check(projectRoot);
      if (outcome === null) {
        return {
          invariantKey: key,
          adr: invariant.adr,
          code: invariant.code,
          name: invariant.name,
          severity: invariant.severity,
          status: 'not-applicable',
          note: 'adapter returned null — context unsupported',
          runtimeGate: runtimeGateName,
          violations: [],
        };
      }
      return {
        invariantKey: key,
        adr: invariant.adr,
        code: invariant.code,
        name: invariant.name,
        severity: invariant.severity,
        status: outcome.status,
        note: outcome.note,
        runtimeGate: runtimeGateName,
        violations: outcome.violations,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        invariantKey: key,
        adr: invariant.adr,
        code: invariant.code,
        name: invariant.name,
        severity: invariant.severity,
        status: 'fail',
        note: `adapter threw: ${message}`,
        runtimeGate: runtimeGateName,
        violations: [
          {
            invariantKey: key,
            offendingId: '<adapter>',
            message: `Adapter for ${key} threw: ${message}`,
            repairCommand: `cleo doctor --audit-invariants  # rerun to retry`,
          },
        ],
      };
    }
  }

  // 3) No adapter → classify by ADR origin.
  if (invariant.adr === 'ADR-073' && invariant.code === 'I3') {
    return {
      invariantKey: key,
      adr: invariant.adr,
      code: invariant.code,
      name: invariant.name,
      severity: invariant.severity,
      status: 'not-applicable',
      note: notApplicableNote(
        invariant.runtimeGate.functionName,
        'a saga-write-time gate (depends + parent inspection on the write path)',
      ),
      runtimeGate: runtimeGateName,
      violations: [],
    };
  }
  if (invariant.adr === 'ADR-056' && invariant.code === 'D5') {
    return {
      invariantKey: key,
      adr: invariant.adr,
      code: invariant.code,
      name: invariant.name,
      severity: invariant.severity,
      status: 'not-applicable',
      note: notApplicableNote(
        invariant.runtimeGate.functionName,
        'release-tag-bound (runs via `cleo verify --release <tag>`)',
      ),
      runtimeGate: runtimeGateName,
      violations: [],
    };
  }
  if (invariant.adr === 'ADR-056' && invariant.code === 'D4') {
    return {
      invariantKey: key,
      adr: invariant.adr,
      code: invariant.code,
      name: invariant.name,
      severity: invariant.severity,
      status: 'not-applicable',
      note: notApplicableNote(
        invariant.runtimeGate.functionName,
        'a write-path validator (assertArchiveReason runs on tasks.archive_reason writes)',
      ),
      runtimeGate: runtimeGateName,
      violations: [],
    };
  }
  if (invariant.adr === 'ADR-070') {
    // ORC-006 / ORC-012 / ORC-013 / ORC-014: spawn-/session-bound runtime gates.
    return {
      invariantKey: key,
      adr: invariant.adr,
      code: invariant.code,
      name: invariant.name,
      severity: invariant.severity,
      status: 'not-applicable',
      note: notApplicableNote(
        invariant.runtimeGate.functionName,
        'a spawn-/session-time gate (no current-DB-scan equivalent)',
      ),
      runtimeGate: runtimeGateName,
      violations: [],
    };
  }

  // 4) Fallback: registered runtime gate with no adapter mapping.
  return {
    invariantKey: key,
    adr: invariant.adr,
    code: invariant.code,
    name: invariant.name,
    severity: invariant.severity,
    status: 'not-applicable',
    note: notApplicableNote(invariant.runtimeGate.functionName, 'unmapped to a doctor adapter'),
    runtimeGate: runtimeGateName,
    violations: [],
  };
}

/**
 * Walk the central invariants registry and audit every entry against the
 * project's current `.cleo/tasks.db` state.
 *
 * Read-only. Safe to invoke without any `--fix`-style flag.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Optional filters. Pass `{adrFilter: 'ADR-073'}` to
 *                  restrict the walk to one ADR (used by `--audit-sagas`).
 * @returns Aggregated {@link InvariantAuditResult}.
 *
 * @example
 * ```typescript
 * const audit = await auditInvariantRegistry(projectRoot);
 * if (audit.errorCount > 0) process.exitCode = 2;
 * for (const entry of audit.entries) {
 *   if (entry.status === 'fail') {
 *     for (const v of entry.violations) console.log(v.message);
 *   }
 * }
 * ```
 */
export async function auditInvariantRegistry(
  projectRoot: string,
  options: { adrFilter?: string } = {},
): Promise<InvariantAuditResult> {
  const adrFilter = options.adrFilter ?? null;
  const cache: SagaAuditCache = { result: null };

  // Snapshot + sort by (adr, code) for deterministic output.
  const allInvariants: RegisteredInvariant[] = [];
  for (const key of Object.keys(INVARIANTS_REGISTRY)) {
    const entry = INVARIANTS_REGISTRY[key];
    if (entry === undefined) continue;
    if (adrFilter !== null && entry.adr !== adrFilter) continue;
    allInvariants.push(entry);
  }
  allInvariants.sort((a, b) => {
    if (a.adr !== b.adr) return a.adr.localeCompare(b.adr);
    return a.code.localeCompare(b.code);
  });

  const entries: InvariantAuditEntry[] = [];
  for (const invariant of allInvariants) {
    const entry = await auditRegistryEntry(invariant, projectRoot, cache);
    entries.push(entry);
  }

  // Aggregate by status × severity.
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let notApplicableCount = 0;
  let documentedCount = 0;
  for (const entry of entries) {
    if (entry.status === 'fail') {
      const sev: InvariantSeverity = entry.severity;
      if (sev === 'error') errorCount += 1;
      else if (sev === 'warning') warningCount += 1;
      else infoCount += 1;
    } else if (entry.status === 'not-applicable') {
      notApplicableCount += 1;
    } else if (entry.status === 'documented') {
      documentedCount += 1;
    }
  }

  return {
    entries,
    totalCount: entries.length,
    errorCount,
    warningCount,
    infoCount,
    notApplicableCount,
    documentedCount,
    filteredByAdr: adrFilter,
  };
}
