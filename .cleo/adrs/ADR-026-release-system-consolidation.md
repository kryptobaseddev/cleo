# ADR-026: Release System Consolidation

**Status**: Accepted
**Date**: 2026-03-06
**Task**: T5577
**Epic**: T5576
**Related ADRs**: ADR-006, ADR-007, ADR-016

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

The release system had accumulated two layers of dead code alongside the active pipeline:

1. **`src/core/release/index.ts`** — 420-line module exposing `prepareRelease`, `commitRelease`, `shipRelease`, etc. Only two files import it: `src/index.ts` (barrel re-export only) and `src/cli/commands/release.ts`. The CLI command routes entirely via `dispatchFromCli` and never calls the functions in `index.ts` directly. The module is effectively unreachable at runtime.

2. **`src/core/release/provenance.ts`** — Implements SLSA-style provenance generation. Zero callers exist in the codebase. Completely orphaned.

Additionally, release commits were created with `--no-verify` in `src/core/release/index.ts:420` to bypass the commit-msg hook requirement for task ID references (`T####`). This is a protocol violation: it bypasses audit trail enforcement and produces commits that fail hook validation for all other contributors.

The active release system is `src/core/release/release-manifest.ts` (manifest CRUD, 10 functions) and `src/core/release/release-engine.ts` (state machine). These are wired to the pipeline domain via `src/dispatch/engines/`. The dead code in `index.ts` and `provenance.ts` creates confusion about which module is the real entry point.

Provenance data (commitSha, gitTag, npmDistTag) is already stored in `releases.json` via `release-manifest.ts`. A separate SLSA provenance module is not needed.

---

## 2. Decision

### 2.1 Dead Code Removal

1. **`src/core/release/index.ts` MUST be deleted.** The barrel in `src/index.ts` MUST remove its re-export. `src/cli/commands/release.ts` already routes via `dispatchFromCli` and requires no changes.

2. **`src/core/release/provenance.ts` MUST be deleted.** No callers exist and no replacement is needed; provenance is tracked via `release_manifests` table columns (see §2.3).

### 2.2 Commit Hook Bypass Elimination

Release commits MUST use a format that the commit-msg hook auto-bypasses without `--no-verify`:

- **Format**: `release: ship vX.Y.Z (T{EPIC_ID})`
- **Hook bypass list**: `.cleo/templates/git-hooks/commit-msg` MUST add `chore(release):` and `release:` prefixes to the auto-bypass list alongside the existing bypass patterns.

This eliminates the need for `--no-verify` on any release commit. All release commits remain in the audit trail.

### 2.3 Provenance via release_manifests Table

Provenance is tracked as columns on the `release_manifests` table in `tasks.db` (see ADR-027 for the full SQLite migration):

| Column | Type | Description |
|--------|------|-------------|
| `commitSha` | text | Git commit SHA at ship time |
| `gitTag` | text | Git tag (e.g., `v2026.3.15`) |
| `npmDistTag` | text | npm dist-tag (`latest`, `beta`, `dev`) |
| `publishedAt` | text | ISO-8601 timestamp of npm publish |

No separate SLSA module is introduced. Exit codes 90–94 (provenance range) remain defined but are not used by the active system until a future ADR explicitly adopts SLSA attestation.

### 2.4 Domain Placement

Release operations MUST remain in the **pipeline domain**. ADR-007 is not amended. The pipeline domain already contains `release.prepare`, `release.ship`, `release.gates.run`, `release.commit`, and `release.changelog` under `src/dispatch/engines/pipeline-release-engine.ts`.

No new domain is created for release operations.

### 2.5 Sole Active Release System

After deletion of `index.ts` and `provenance.ts`, the canonical release system consists of exactly two modules:

- `src/core/release/release-manifest.ts` — manifest CRUD (creates/updates `release_manifests` rows)
- `src/core/release/release-engine.ts` — state machine driving the 5-step ship flow

All other files under `src/core/release/` are helpers called by these two modules.

---

## 3. Consequences

### Positive

- Unambiguous entry point: `release-manifest.ts` + `release-engine.ts` are the release system
- `--no-verify` eliminated; every release commit is hook-compliant and auditable
- Provenance stored in SQLite alongside other release metadata — single query surface
- Reduced module surface area: two dead files removed, zero feature regression

### Negative

- Deletion of `index.ts` is a breaking change for any external code importing from `src/core/release/index.ts`. No known external consumers exist; internal audit confirmed zero live callers.

### Neutral

- `src/index.ts` barrel loses the `release` re-export; public API surface is unchanged because no published consumers used this path
- Exit codes 90–94 remain defined for future provenance work

---

## 4. Migration Path

1. Delete `src/core/release/index.ts`
2. Delete `src/core/release/provenance.ts`
3. Remove re-export from `src/index.ts`
4. Update `.cleo/templates/git-hooks/commit-msg` to bypass `chore(release):` and `release:` prefixes
5. Update `src/core/release/release-engine.ts` to use the hook-compliant commit format `release: ship vX.Y.Z (T{EPIC_ID})` without `--no-verify`
6. Run full test suite to confirm no regressions

---

## 5. References

- ADR-006: SQLite as Single Source of Truth
- ADR-007: Domain Consolidation (pipeline domain unchanged)
- ADR-016: Installation Channels and Release Pipeline (§8.3 workflow architecture)
- ADR-027: Manifest SQLite Migration (releases.json → release_manifests table)
- T5576: LOOM Release Pipeline Remediation (epic)
- T5577: Release System Consolidation documentation task
- `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`

---

**END OF ADR-026**
