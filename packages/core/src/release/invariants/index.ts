/**
 * Release-time invariants registry — barrel export.
 *
 * Importing this module registers every shipped invariant as a side-effect.
 * Consumers (CLI, programmatic callers) only need:
 *
 * ```ts
 * import { runInvariants } from '@cleocode/core/release/invariants';
 * const report = await runInvariants(tag, { dryRun });
 * ```
 *
 * To add a new invariant, create the file under this directory and append a
 * `register…Invariant()` call below. The registry preserves insertion order
 * which doubles as render order in the CLI report.
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

// Side-effect: register the first customer on module load.
// Adding a new customer? Append another register…Invariant() call here.
registerArchiveReasonInvariant();
