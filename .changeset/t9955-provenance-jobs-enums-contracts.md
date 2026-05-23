---
id: t9955-provenance-jobs-enums-contracts
tasks: [T9955]
kind: refactor
prs: []
summary: "Promote 17 provenance/job unions + 6 task-axis enum constants from core/store/tasks-schema.ts to @cleocode/contracts (Phase 0c · T9832)."
---

Phase 0c of [Saga SG-ARCH-SOLID (T9831)](../) · Epic
[E-CONTRACTS-FOUNDATION (T9832)](../). Unblocks T9834 E-CORE-DECOMP
tasks-schema.ts split (1190-LOC provenance block) by establishing
contracts homes for every cross-package type the schema file owns.

## Changes

### `packages/contracts/src/provenance.ts` (NEW)

Canonical home for 16 string-literal unions that describe edges and FSM
states in the CLEO provenance graph:

- **PR unions**: `PrState`, `PrLinkSource`, `PrLinkKind`
- **Commit unions**: `CommitConventionalType`, `CommitLinkKind`,
  `CommitLinkSource`, `CommitFileChangeType`
- **Release unions**: `ReleaseScheme`, `ReleaseChannel`, `ReleaseKind`,
  `ReleaseStatus`, `ReleaseChangeType`, `ReleaseImpact`,
  `ReleaseClassifiedBy`
- **Artifact + BRAIN-link unions**: `ReleaseArtifactType`,
  `BrainReleaseLinkType`

### `packages/contracts/src/jobs.ts` (NEW)

Canonical home for `BackgroundJobStatus` (T641 durable-job lifecycle FSM).

### `packages/contracts/src/enums.ts` (NEW)

Canonical home for 6 task-axis `as const` arrays: `TASK_KINDS`,
`TASK_SCOPES`, `TASK_SEVERITIES`, `TASK_SIZES`, `ARCHIVE_REASONS`,
`TASK_RELATION_TYPES`. `tasks-schema.ts` imports them back for Drizzle's
`text({ enum: ... })` row-type narrowing — zero schema change.

### `packages/contracts/src/__tests__/{provenance,jobs,enums}.test.ts` (NEW)

Structural-equivalence + value-set assertions that pin each promoted
contract at compile time (via `Equals<A, B>` conditional trick) and at
runtime (representative value lists). Any future drift on the
contracts side or the `tasks-schema.ts` Drizzle-narrowed side produces
a TS2322 or TS2344 at build time.

### `packages/contracts/src/index.ts`

Top-level re-exports for the 12 unique-named provenance unions, the
6 enum constants, and `BackgroundJobStatus`. The 4 colliding names
(`ReleaseChannel`, `ReleaseKind`, `ReleaseScheme`, `ReleaseStatus`)
re-export under `Provenance…`-qualified aliases to avoid shadowing the
existing `./release/plan.ts`, `./release/channel.ts`, and `./task.ts`
exports (which are different domains).

### `packages/contracts/package.json`

Adds 3 subpath exports: `./provenance`, `./jobs`, `./enums` (plus their
`.js` mirror entries).

### `packages/core/src/store/tasks-schema.ts`

- Imports `TASK_KINDS`, `TASK_SCOPES`, `TASK_SEVERITIES`, `TASK_SIZES`,
  `ARCHIVE_REASONS`, `TASK_RELATION_TYPES` from
  `@cleocode/contracts/enums` — the `text({ enum: X })` narrowing keeps
  producing byte-identical row types.
- Imports the 16 union types from `@cleocode/contracts/provenance` and
  `BackgroundJobStatus` from `@cleocode/contracts/jobs`.
- Re-exports every promoted name so the public surface stays identical
  for every `import * as schema from '../store/tasks-schema.js'` consumer
  (4 sites in `core/src/release/reconcile.ts`, the schema-parity tests
  in `core/src/store/__tests__/`, and `cleo/src/dispatch/lib/background-jobs.ts`).

### `vitest.config.ts` + `packages/{core,cleo}/vitest.config.ts`

Adds explicit subpath aliases for `@cleocode/contracts/{enums,jobs,provenance}`
so vitest dev-mode resolves the new modules to source instead of attempting
to read `index.ts/<subpath>` (the bare `@cleocode/contracts` alias
shortcuts the entire prefix). Subpath aliases MUST appear before the
bare alias to match longest-prefix-first.

## Why SG-ARCH-SOLID

Driven by 5 parallel architectural audits identifying ~14–17k LOC of
moveable/eliminable code across the monorepo. The 1190-LOC provenance
block in `tasks-schema.ts` was the largest remaining barrier to the
T9834 E-CORE-DECOMP god-module split. Phase 0c removes that barrier by
giving every cross-package type a contracts home — `text({ enum })`
keeps narrowing from the same `as const` arrays (now sourced from
contracts), so Drizzle's row types are unchanged and migration SQL is
byte-identical.

Verified at build + test time:

- `pnpm biome ci` clean on all touched files.
- `pnpm --filter @cleocode/contracts run test` → 312/312 green
  (includes new structural-equivalence + value-set tests).
- `pnpm run build` (full workspace) → green.
- `pnpm run typecheck` → green.
- 3 schema-parity tests (`commits-schema-parity`, `pr-schema-parity`,
  `releases-schema-parity`) → 90/90 green — confirms each promoted const
  array still matches the migration SQL byte-for-byte.
- All 303 release-pipeline tests in `packages/core/src/release/__tests__/`
  → green — confirms `schema.ReleaseChangeType`, `schema.ReleaseImpact`,
  `schema.PrLinkSource`, `schema.ReleaseArtifactType` namespace access
  via `import * as schema from '../store/tasks-schema.js'` still resolves.
