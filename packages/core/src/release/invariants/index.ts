/**
 * Release-time invariants registry — barrel export.
 *
 * Importing this module registers nothing (T14391): a barrel that re-exports
 * it must not change a registry by being loaded. Register the shipped
 * invariants explicitly before running them — the CLI does so by loading
 * `@cleocode/core/registrations`:
 *
 * ```ts
 * import { registerReleaseInvariants, runInvariants } from '@cleocode/core/release/invariants';
 * registerReleaseInvariants();
 * const report = await runInvariants(tag, { dryRun });
 * ```
 *
 * To add a new invariant, create the file under this directory and append a
 * `register…Invariant()` call to {@link registerReleaseInvariants}. The
 * registry preserves insertion order which doubles as render order in the CLI
 * report.
 *
 * ---
 *
 * **Cross-reference to the central invariants registry (T10339 — R5):**
 *
 * This release-time registry is the EXECUTABLE subsystem catalogued by
 * ADR-056 D5 in the central invariants registry at
 * `@cleocode/contracts/invariants/adr-056-release.ts`. The central registry
 * holds metadata; this module holds the implementation that the metadata
 * `runtimeGate` field points to. See `./registry.ts` for the full
 * relationship rationale.
 *
 * @task T1411
 * @epic T1407
 * @adr ADR-056 D5
 * @see packages/contracts/src/invariants/adr-056-release.ts — central metadata
 */

export type { ReconcileAction, ReconcileAuditRow } from './archive-reason-invariant.js';
export {
  ARCHIVE_REASON_INVARIANT_ID,
  extractTaskIds,
  RECONCILE_AUDIT_FILE,
  registerArchiveReasonInvariant,
} from './archive-reason-invariant.js';
export type {
  InvariantReport,
  InvariantResult,
  InvariantRunOptions,
  InvariantSeverity,
  RegisteredInvariant,
  RegisteredReleaseInvariant,
} from './registry.js';
export {
  clearInvariants,
  getInvariants,
  getRegisteredAdr056Invariants,
  registerInvariant,
  runInvariants,
} from './registry.js';

import { registerArchiveReasonInvariant } from './archive-reason-invariant.js';

/**
 * Register every shipped release invariant. Idempotent: the registry is keyed
 * by invariant id, so a second call replaces each entry in place.
 *
 * Adding a new invariant? Append its `register…Invariant()` call here.
 *
 * @task T14391
 */
export function registerReleaseInvariants(): void {
  registerArchiveReasonInvariant();
}
