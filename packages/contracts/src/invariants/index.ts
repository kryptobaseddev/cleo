/**
 * Central invariants registry — SSoT for system-wide invariants surfaced via
 * the SaGa T10326 SG-SUBSTRATE-RECONCILIATION programme (Epic T10327
 * E-INVARIANT-REGISTRY-SSOT, Task T10335 R1).
 *
 * Every registered invariant carries the metadata needed to:
 * 1. Reference its source ADR (e.g. `ADR-073` §1.2 for I1-I8).
 * 2. Locate the runtime guard that enforces it (when one exists).
 * 3. Bind the CI lint rule that protects it (when one exists).
 * 4. Cross-reference test files that exercise it.
 * 5. Render documentation via the downstream R8 auto-render pipeline.
 *
 * Downstream consumers:
 * - R2 (T10336): register ADR-070 ORC codes into this same registry.
 * - R4 (T10338): CI gate validates that every `severity:'error'` entry has
 *   a non-null `runtimeGate` AND a matching error-code in `errors.ts`.
 * - R5 (T10339): refactor `packages/core/src/release/invariants/registry.ts`
 *   to consume the central registry instead of carrying its own list.
 * - R6 (T10340): `cleo doctor --audit-invariants` walks the registry to
 *   produce a per-invariant audit report.
 * - R8 (T10342): auto-render docs page from the registry.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10335 — R1: registry + ADR-073 I1-I8
 * @see ADR-073-above-epic-naming.md §1.2
 */

import { ADR_056_INVARIANTS } from './adr-056-release.js';
import { ADR_073_INVARIANTS } from './adr-073-saga.js';

// Re-exported so consumers can import either the per-ADR list or the merged
// registry from one place.
export { ADR_056_INVARIANTS } from './adr-056-release.js';
export { ADR_073_INVARIANTS } from './adr-073-saga.js';

/**
 * Severity tier for a registered invariant.
 *
 * - `'error'` — runtime gate MUST exist; violation surfaces as LAFS error
 *   code (cross-checked by R4 CI gate).
 * - `'warning'` — orchestration/process concern; surfaces via doctor audit
 *   but does not throw at runtime.
 * - `'info'` — display or storage concern; enforced (if at all) by DB
 *   constraints or convention rather than a runtime function.
 */
export type InvariantSeverity = 'info' | 'warning' | 'error';

/**
 * Pointer to a runtime guard function that enforces an invariant.
 *
 * The `module` field is the package-relative import specifier
 * (e.g. `packages/core/src/sagas/enforcement.ts`). The `functionName` is the
 * exported identifier (e.g. `assertSagaInvariantI3`).
 *
 * R4 CI gate uses this triple to assert the guard actually exists and is
 * exported with the expected name. R6 doctor audit uses it to render
 * per-invariant enforcement provenance.
 */
export interface InvariantRuntimeGate {
  readonly module: string;
  readonly functionName: string;
}

/**
 * Pointer to a CI lint script that protects an invariant.
 *
 * The path is repo-rooted (e.g. `scripts/lint-saga-label-anti-pattern.mjs`).
 */
export interface InvariantLintRule {
  readonly lintScript: string;
}

/**
 * Pointer to a `cleo doctor` audit that surfaces invariant violations.
 *
 * The lintScript field mirrors the CI gate pointer — many invariants share
 * the same script between CI and doctor (e.g. saga-label anti-pattern).
 */
export interface InvariantDoctorAudit {
  readonly lintScript: string;
}

/**
 * A registered invariant — one entry per `(adr, code)` pair.
 *
 * The `adr` + `code` combination forms the registry key
 * (`${adr}.${code}`, e.g. `'ADR-073.I3'`). Lookups via `getInvariant`
 * and per-ADR enumeration via `getInvariantsByAdr` use this convention.
 *
 * @see ADR-073-above-epic-naming.md §1.2 — original I1-I8 source.
 */
export interface RegisteredInvariant {
  /** Source ADR identifier, e.g. `'ADR-073'`. */
  readonly adr: string;
  /** Invariant code within the ADR, e.g. `'I3'` or `'ORC-001'`. */
  readonly code: string;
  /** Short human-readable name, e.g. `'Tier promotion mandatory'`. */
  readonly name: string;
  /** Full description (one or two sentences, no markdown). */
  readonly description: string;
  /** Severity tier — drives R4 CI gate strictness. */
  readonly severity: InvariantSeverity;
  /**
   * Runtime guard function, or `null` when the invariant has no
   * runtime-checkable form (display/storage/process concerns).
   *
   * Every `severity:'error'` invariant MUST set a non-null
   * `runtimeGate` — enforced by the registry test suite (T10335 AC5)
   * and by the R4 CI gate (T10338).
   */
  readonly runtimeGate: InvariantRuntimeGate | null;
  /**
   * Optional CI lint rule reference. Distinct from `runtimeGate` —
   * `runtimeGate` runs in dispatch code, `lintRule` runs in CI.
   */
  readonly lintRule?: InvariantLintRule | null;
  /**
   * Optional `cleo doctor` audit reference. R6 consumes this field to
   * decide which invariants surface in `cleo doctor --audit-invariants`.
   */
  readonly doctorAudit?: InvariantDoctorAudit | null;
  /**
   * Paths of test files that exercise the invariant. Used by R8 to render
   * documentation pages with live test cross-references.
   */
  readonly tests: readonly string[];
  /**
   * Optional flag — set to `true` when the invariant is superseded but
   * preserved for historical/import-mapping reasons. Defaults to `false`.
   */
  readonly deprecated?: boolean;
}

/**
 * Compute the canonical registry key for an invariant.
 *
 * @internal
 */
function buildKey(invariant: RegisteredInvariant): string {
  return `${invariant.adr}.${invariant.code}`;
}

/**
 * Build the merged registry record from all per-ADR invariant modules.
 *
 * Future ADR modules (ADR-070 ORC codes via R2 T10336, etc.) append to
 * the spread list below. Each module exports a `readonly RegisteredInvariant[]`
 * — this index assembles them into a keyed record at module load time.
 *
 * @internal
 */
function buildRegistry(): Readonly<Record<string, RegisteredInvariant>> {
  const entries: RegisteredInvariant[] = [...ADR_073_INVARIANTS, ...ADR_056_INVARIANTS];
  const record: Record<string, RegisteredInvariant> = {};
  for (const entry of entries) {
    const key = buildKey(entry);
    if (record[key] !== undefined) {
      throw new Error(`Duplicate invariant key registered: ${key}`);
    }
    record[key] = entry;
  }
  return Object.freeze(record);
}

/**
 * Central invariants registry — keyed by `${adr}.${code}`.
 *
 * Treat as read-only at runtime. Mutating this record is a contract
 * violation; downstream consumers (R5 release-registry refactor, R6
 * doctor audit, R8 docs renderer) assume immutability.
 *
 * @example
 * ```ts
 * import { INVARIANTS_REGISTRY } from '@cleocode/contracts';
 * const i3 = INVARIANTS_REGISTRY['ADR-073.I3'];
 * if (i3?.runtimeGate) {
 *   console.log(`Guard: ${i3.runtimeGate.functionName}`);
 * }
 * ```
 */
export const INVARIANTS_REGISTRY: Readonly<Record<string, RegisteredInvariant>> = buildRegistry();

/**
 * Look up a single invariant by its `${adr}.${code}` key.
 *
 * @example
 * ```ts
 * const i3 = getInvariant('ADR-073.I3');
 * // → RegisteredInvariant for ADR-073 invariant I3
 * ```
 */
export function getInvariant(adrCode: string): RegisteredInvariant | undefined {
  return INVARIANTS_REGISTRY[adrCode];
}

/**
 * Return every invariant registered against a given ADR, in declaration order.
 *
 * @example
 * ```ts
 * const adr073 = getInvariantsByAdr('ADR-073');
 * // → array of I1..I8 entries
 * ```
 */
export function getInvariantsByAdr(adr: string): RegisteredInvariant[] {
  const result: RegisteredInvariant[] = [];
  for (const key of Object.keys(INVARIANTS_REGISTRY)) {
    const entry = INVARIANTS_REGISTRY[key];
    if (entry !== undefined && entry.adr === adr) {
      result.push(entry);
    }
  }
  return result;
}
