# Charlie-3 — T1243: `cleo upgrade` agent_registry_sync action

**Status:** COMPLETE
**Date:** 2026-04-29
**Parent:** T1567 (Audit 2026-04-28)
**File touched:** `packages/core/src/upgrade.ts` (sole edit; CLI thin command unchanged)

## Problem

`cleo upgrade` ran 7 actions (storage migration, schema repair, gitignore,
agent-outputs migration, project-context, injection refresh, structural
maintenance) but never reconciled the **global `signaldock.db:agents` registry**
against the on-disk `.cant` files. Result: after a fresh `cleo upgrade`, the
registry could be stale relative to seed-agents on disk (D-001 orphan-files,
D-002 orphan-rows, D-003 sha256 drift, D-010 legacy JSON registry).

## Fix

Added an 8th action `agent_registry_sync` to `runUpgrade()` in
`packages/core/src/upgrade.ts`. **Reuses** existing helpers — no duplication:

- `buildDoctorReport(db, { projectRoot })` from `core/src/store/agent-doctor.ts`
- `reconcileDoctor(db, findings, { importLegacyJson: true })` (same module)
- `ensureGlobalSignaldockDb()` + `getGlobalSignaldockDbPath()`
  from `core/src/store/signaldock-sqlite.js`
- Direct `node:sqlite` `DatabaseSync` (same pattern as `agent.ts` doctor handler)

### Ordinal placement

Inserted **inside Step 8 (Structural maintenance)**, immediately after the
`cant_starter_bundle` deploy. Order matters — agents must be deployed to disk
first, then the registry can be reconciled against on-disk truth. Placed before
`global_identity` and `core_skills` writes so any downstream action can rely on
a clean registry.

### Idempotent + non-destructive

Default `reconcileDoctor` settings only auto-apply:

- **D-002** orphan-row deletes (rows pointing at missing files)
- **D-003** sha256 hash refreshes
- **D-010** legacy `~/.cleo/agent-registry.json` import (`importLegacyJson: true`)

D-001 (rehydrate-from-seed) and D-008 (path migration) remain **opt-in** and
are reported as `skipped` — users must run `cleo agent doctor --repair --import-legacy-json`
explicitly for those. Verified idempotent: second run produces identical output.

### Dry-run preview

Added a parallel preview branch (also reuses `buildDoctorReport`, read-only) so
`cleo upgrade --dry-run` reports the drift count before applying. Updated the
`structural_maintenance` preview line to mention "agent registry sync".

### Error handling

Wrapped in try/catch — registry sync failures emit `status: 'error'` with the
error message + a fix command (`cleo agent doctor --repair --import-legacy-json`)
but do **not** abort the upgrade (consistent with all other Step 8 best-effort
sub-actions).

## File diff summary

```
 packages/core/src/upgrade.ts | 104 ++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 103 insertions(+), 1 deletion(-)
```

Two insertions:
1. Line ~944 — applied branch (real run): `buildDoctorReport` + `reconcileDoctor`
2. Line ~1158 — preview branch (dry-run): `buildDoctorReport` only (read-only)

## Reused helpers

| Helper | Module | Role |
|--------|--------|------|
| `buildDoctorReport` | `core/src/store/agent-doctor.ts` | Read-only drift report |
| `reconcileDoctor` | `core/src/store/agent-doctor.ts` | Apply safe repairs |
| `ensureGlobalSignaldockDb` | `core/src/store/signaldock-sqlite.ts` | DB lifecycle |
| `getGlobalSignaldockDbPath` | `core/src/store/signaldock-sqlite.ts` | Path resolution |

**Zero duplication.** The reconcile logic in `cleo agent doctor` and `cleo upgrade`
now share the same code path — fixes/improvements to one benefit both.

## Manual test output

### `cleo upgrade --dry-run --json` (new action visible in actions array)

```json
{"action":"agent_registry_sync","status":"preview",
 "details":"Would reconcile 13 drift finding(s) (0 error / 13 warn / 0 info)
            — see 'cleo agent doctor' for detail"}
```

### `cleo upgrade --json` (real run, idempotent)

```json
{"action":"agent_registry_sync","status":"skipped",
 "details":"Findings: 0 error(s), 13 warning(s), 0 info;
            repaired: (none);
            skipped: D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001, D-001"}
```

13 D-001 findings = 13 .cant files in `.cleo/cant/agents/` not yet bound in
`signaldock.db:agents` for the project tier. Correctly skipped by default
(opt-in via `--rehydrate-from-seed` flag — owner decides when to bind).

Action `agent_registry_sync` now appears in **both** dry-run and real-run
action arrays as the 8th distinct named action.

## Build + tests

| Check | Result |
|-------|--------|
| `pnpm --filter @cleocode/core run build` | PASS (tsc clean) |
| `pnpm --filter @cleocode/cleo run build` | PASS (tsc + assert-shebang) |
| `vitest run src/__tests__/upgrade.test.ts` | PASS (15/15) |
| `vitest run src/store/__tests__/agent-doctor.test.ts` | PASS (6/6) |

The 9 unrelated failures in `database-topology-integration.test.ts` are
**pre-existing on `main`** (verified by `git stash` + re-run). Not caused by
this change.

## Constraints honored

- TypeScript strict — zero `any`, zero `unknown` shortcuts. Used proper
  `Awaited<ReturnType<...>>` and structural types from `@cleocode/contracts`
  (re-exported via `@cleocode/core/internal`).
- Edits in `packages/core/src/upgrade.ts` only (CLI `upgrade.ts` untouched —
  thin dispatch preserved per layering rule).
- No direct `@cleocode/contracts` imports in core upgrade — uses local
  `import './store/agent-doctor.js'` (already in core).
- Did not touch shared agent-install logic — no NOTE-FOR-CHARLIE-2 needed.

## Build + tests pass: YES
