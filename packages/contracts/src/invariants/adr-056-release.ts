/**
 * ADR-056 decisions D1-D6 registered against the central invariants
 * registry (`./index.ts`).
 *
 * The six decisions govern the per-domain SQLite SSoT topology + the
 * release-completion invariant (archiveReason enum + post-release gate).
 *
 *   - D1 — Database topology: keep per-domain split (no consolidation).
 *   - D2 — Naming convention `<domain>-schema.ts` + `<domain>-sqlite.ts`.
 *   - D3 — Migration runner SSoT under `migration-manager.ts`.
 *   - D4 — `archiveReason` 6-value enum with tombstone semantics.
 *   - D5 — Post-release reconciliation: registry-driven `cleo verify --release`.
 *   - D6 — Commit-message lint for release commits.
 *
 * D4 carries a runtime guard (the `assertArchiveReason` function in
 * `@cleocode/contracts` tasks/archive module) and surfaces as the
 * `E_ARCHIVE_REASON_TOMBSTONE` LAFS error code on tombstone-write attempts.
 * D5 carries a registry-driven runtime gate at
 * `packages/core/src/release/invariants/registry.ts` (the per-release
 * executable invariants subsystem this central entry catalogues). D1, D2,
 * D3, D6 are topology / convention / CI-hook decisions — they carry
 * `lintRule` or `runtimeGate:null` markers per the per-decision
 * enforcement surface, matching the ADR-073 pattern for I1, I2, I4, I6, I8.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10339 — R5: release-registry consumes central substrate
 * @see ADR-056-db-ssot-and-release-completion-invariant.md §Decision
 * @see packages/core/src/release/invariants/registry.ts — D5 executable subsystem
 */

import type { RegisteredInvariant } from './index.js';

/**
 * Module path that hosts the `assertArchiveReason` runtime guard.
 *
 * Held as a constant so the D4 entry shares one source-of-truth pointer —
 * touching the path once propagates to every guard ref.
 */
const ARCHIVE_REASON_MODULE = 'packages/contracts/src/tasks/archive.ts';

/**
 * Module path that hosts the release-invariants registry — the executable
 * subsystem catalogued by D5. The registry exposes `registerInvariant`,
 * `getInvariants`, and `runInvariants`; the archive-reason invariant is its
 * first customer.
 */
const RELEASE_INVARIANTS_REGISTRY_MODULE = 'packages/core/src/release/invariants/registry.ts';

/**
 * Repo-rooted path to the release commit-msg lint script (D6 enforcement).
 */
const RELEASE_COMMIT_MSG_HOOK = 'scripts/hooks/commit-msg-release-lint.mjs';

/**
 * ADR-056 invariants D1-D6 in declaration order.
 *
 * Severity mapping (see `RegisteredInvariant` JSDoc for tier semantics):
 * - D1, D2, D3, D6 → `info` (topology / convention / CI hook concerns).
 * - D4 → `error` (tombstone-write rejection — `E_ARCHIVE_REASON_TOMBSTONE`).
 * - D5 → `warning` (post-release gate produces follow-up tasks rather than
 *   throwing — failures are caught + recorded via the audit log).
 */
export const ADR_056_INVARIANTS: readonly RegisteredInvariant[] = Object.freeze([
  {
    adr: 'ADR-056',
    code: 'D1',
    name: 'Database topology: keep per-domain split',
    description:
      'CLEO retains the six per-domain SQLite databases (tasks, brain, conduit, nexus, signaldock, telemetry) documented in DATABASE-ERDS.md. Consolidation is rejected to preserve per-DB WAL throughput, per-DB rollback granularity, and avoid single-writer contention during multi-agent waves.',
    severity: 'info',
    // D1 is a topology decision; the absence of consolidation is its only
    // enforcement surface. No runtime guard, no lint script.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-056',
    code: 'D2',
    name: 'Store-layer naming convention',
    description:
      'New always-on store-layer domains MUST use the kebab-case pair `packages/core/src/store/<domain>-schema.ts` (Drizzle defs) + `packages/core/src/store/<domain>-sqlite.ts` (open/init/CRUD). Opt-in / isolated domains MAY use the folder variant `packages/core/src/<domain>/{schema,sqlite}.ts` (currently telemetry only).',
    severity: 'info',
    // D2 is a naming-convention decision; enforced by code review and the
    // ADR-073/ADR-056 doctor audit. No runtime guard.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-056',
    code: 'D3',
    name: 'Migration runner SSoT under migration-manager.ts',
    description:
      'All six SQLite databases MUST be initialized via `packages/core/src/migration/migration-manager.ts` (`migrateWithRetry()` + `reconcileJournal()`). Per-DB bespoke runners are prohibited for new domains. Rust Diesel migrations for cloud signaldock-storage MUST NOT touch the local SQLite signaldock.db at runtime.',
    severity: 'info',
    // D3 is enforced by the absence of bespoke runners — every domain's
    // `<domain>-sqlite.ts` open path delegates to migration-manager. No
    // single runtime guard; per-DB chokepoints are the enforcement surface.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-056',
    code: 'D4',
    name: 'archiveReason 6-value enum with tombstone semantics',
    description:
      "The tasks.archive_reason column is constrained to exactly six values (verified, reconciled, superseded, shadowed, cancelled, completed-unverified) via SQLite CHECK constraint AND Zod z.enum validation. Writing 'completed-unverified' from non-migration code MUST throw E_ARCHIVE_REASON_TOMBSTONE — the tombstone is reserved for the T1408 backfill migration only.",
    severity: 'error',
    runtimeGate: {
      module: ARCHIVE_REASON_MODULE,
      functionName: 'assertArchiveReason',
    },
    lintRule: null,
    doctorAudit: null,
    tests: ['packages/contracts/src/tasks/__tests__/archive.test.ts'],
  },
  {
    adr: 'ADR-056',
    code: 'D5',
    name: 'Post-release reconciliation: registry-driven cleo verify --release',
    description:
      'Post-release reconciliation flows through the executable invariants registry at packages/core/src/release/invariants/registry.ts. Customers register via registerInvariant() and the CLI runs every entry on `cleo verify --release <tag>`. First customer: archive-reason-invariant.ts (stamps verified tasks done; creates follow-up tasks for unverified references).',
    severity: 'warning',
    runtimeGate: {
      module: RELEASE_INVARIANTS_REGISTRY_MODULE,
      functionName: 'runInvariants',
    },
    lintRule: null,
    doctorAudit: null,
    tests: ['packages/core/src/release/invariants/__tests__/archive-reason-invariant.test.ts'],
  },
  {
    adr: 'ADR-056',
    code: 'D6',
    name: 'Commit-message lint for release commits',
    description:
      'Every commit whose subject matches `^(chore|feat)\\(release\\):` MUST contain at least one `T\\d+` task reference in the commit body. Enforced by scripts/hooks/commit-msg-release-lint.mjs (T1410). Bypass via CLEO_OWNER_OVERRIDE=1 with audited justification.',
    severity: 'info',
    // D6 is a CI-hook concern. The hook itself is the enforcement surface
    // — represented here via lintRule for cross-reference rendering.
    runtimeGate: null,
    lintRule: {
      lintScript: RELEASE_COMMIT_MSG_HOOK,
    },
    doctorAudit: null,
    tests: [],
  },
]);
