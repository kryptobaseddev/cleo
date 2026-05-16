# Test Matrix — T9345 Release Pipeline v2

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Task** | T9345 (IVTR Release System Overhaul) |
| **Author** | cleo-prime (system architect) |
| **Companion artifacts** | `SPEC-T9345-release-pipeline-v2.md`, `migration-plan-T9345.md` |

---

## Executive Summary

This test matrix proves that the SPEC-T9345 v2 release pipeline works correctly across the three required project archetypes (npm monorepo with workspaces, single npm library, single Rust crate) and the stretch archetype (single Python pkg). It defines four fixture projects, twelve test scenarios, a GitHub Actions matrix configuration for running scenarios against archetypes, and an owner sign-off checklist for declaring T9345 complete.

Each scenario maps to one or more of the ten production failure modes catalogued in `failure-forensics-10-modes.md` and asserts that the new architecture prevents OR narrows that failure. The matrix is structured so that a green scenario row for an archetype constitutes evidence that the SPEC's acceptance criteria AC-1 through AC-10 hold for that archetype.

The matrix's "pass" definition is quantitative: a pipeline-pass for archetype A requires scenarios S1-S12 to all be green for A's fixture, with no flakes (3 consecutive runs green). The owner sign-off checklist enumerates the specific artifacts the owner inspects before declaring T9345 complete: green CI matrix output, populated provenance tables, ≤5 minute happy-path wall-time, zero orphan commits in shipped releases, and the four operator verbs visible in `cleo release --help`.

Fixture locations live under `packages/cleo/test/fixtures/release-test-<archetype>/` so they share the existing CLEO test infrastructure. Each fixture is realistic — not a toy — with a populated `.cleo/release-config.json`, a representative `.cleo/project-context.json`, plausible task data, and the expected tool resolutions per ADR-061. Scenarios that mutate state run in ephemeral worktrees provisioned via CLEO's existing test harness; the fixtures themselves are immutable test artifacts.

---

## 1. Archetypes — Four Fixtures

The matrix targets three required archetypes plus one stretch archetype. Each fixture lives under `packages/cleo/test/fixtures/` and ships with the minimum viable project structure for the release pipeline to exercise.

### 1.1 A1 — Monorepo with workspaces (cleocode itself)

| Property | Value |
|---|---|
| **Fixture path** | `packages/cleo/test/fixtures/release-test-monorepo/` (mirrors cleocode at a smaller scale: 4 packages) |
| **Stack** | pnpm + biome + vitest + esbuild + TypeScript strict |
| **Workspace manifest** | `pnpm-workspace.yaml` listing `packages/*` |
| **Packages** | `@release-test/core`, `@release-test/cli`, `@release-test/contracts`, `@release-test/utils` |
| **Version scheme** | calver (`v2026.YYYY.MM.NN`) |
| **`.cleo/release-config.json`** | `{ scheme: 'calver', branchModel: 'feat-to-main', prRequired: true, releaseBranchPrefix: 'release/' }` |
| **`.cleo/project-context.json`** | `primaryType: 'node'`, `testing.command: 'pnpm run test'`, `build.command: 'pnpm run build'`, `monorepo: true` |
| **Expected ADR-061 tool resolutions** | `test: pnpm run test`, `build: pnpm run build`, `lint: pnpm biome ci .`, `typecheck: pnpm run typecheck`, `audit: pnpm audit`, `security-scan: pnpm dlx audit-ci` |
| **Expected platform matrix entries** | `[linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64]` × `[@release-test/core, @release-test/cli, @release-test/contracts, @release-test/utils]` |
| **Real-world counterpart** | cleocode (22 packages, this fixture is the reduced model) |

### 1.2 A2 — Single npm library

| Property | Value |
|---|---|
| **Fixture path** | `packages/cleo/test/fixtures/release-test-npm-lib/` |
| **Stack** | npm + tsc + vitest + TypeScript strict (no biome) |
| **Workspace manifest** | (none — single root package.json) |
| **Packages** | `@example/my-lib` (single) |
| **Version scheme** | semver (`vX.Y.Z`) |
| **`.cleo/release-config.json`** | `{ scheme: 'semver', branchModel: 'feat-to-main', prRequired: true, releaseBranchPrefix: 'release/' }` |
| **`.cleo/project-context.json`** | `primaryType: 'node'`, `testing.command: 'npm test'`, `build.command: 'npm run build'`, `monorepo: false` |
| **Expected ADR-061 tool resolutions** | `test: npm test`, `build: npm run build`, `lint: npm run lint`, `typecheck: npx tsc --noEmit`, `audit: npm audit`, `security-scan: npm audit --audit-level=high` |
| **Expected platform matrix entries** | `[any]` × `[@example/my-lib]` (no native bindings → single matrix slot) |
| **Real-world counterpart** | Hermes-style single-package npm library |

### 1.3 A3 — Single Rust crate

| Property | Value |
|---|---|
| **Fixture path** | `packages/cleo/test/fixtures/release-test-rust-crate/` |
| **Stack** | cargo + clippy + rustfmt + cargo-test |
| **Workspace manifest** | (none — single root Cargo.toml) |
| **Packages** | `my-crate` (single) |
| **Version scheme** | semver |
| **`.cleo/release-config.json`** | `{ scheme: 'semver', branchModel: 'feat-to-main', prRequired: true, releaseBranchPrefix: 'release/' }` |
| **`.cleo/project-context.json`** | `primaryType: 'rust'`, `testing.command: 'cargo test --all-features'`, `build.command: 'cargo build --release'` |
| **Expected ADR-061 tool resolutions** | `test: cargo test --all-features`, `build: cargo build --release`, `lint: cargo clippy --all-targets -- -D warnings`, `typecheck: cargo check --all-targets`, `audit: cargo audit`, `security-scan: cargo audit` |
| **Expected platform matrix entries** | `[linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64]` × `[my-crate]` (cross-compile for binary crates; library crates collapse to `[any]`) |
| **Real-world counterpart** | A pure-Rust CLI tool published to crates.io |

### 1.4 A4 — Single Python pkg (stretch)

| Property | Value |
|---|---|
| **Fixture path** | `packages/cleo/test/fixtures/release-test-python-pkg/` |
| **Stack** | pyproject.toml + ruff + mypy + pytest |
| **Workspace manifest** | (none) |
| **Packages** | `my-pkg` (single) |
| **Version scheme** | semver |
| **`.cleo/release-config.json`** | `{ scheme: 'semver', branchModel: 'feat-to-main', prRequired: true, releaseBranchPrefix: 'release/' }` |
| **`.cleo/project-context.json`** | `primaryType: 'python'`, `testing.command: 'pytest'`, `build.command: 'python -m build'` |
| **Expected ADR-061 tool resolutions** | `test: pytest`, `build: python -m build`, `lint: ruff check .`, `typecheck: mypy .`, `audit: pip-audit`, `security-scan: bandit -r .` |
| **Expected platform matrix entries** | `[any]` × `[my-pkg]` (pure-Python; sdist + wheel) |
| **Real-world counterpart** | A reference Python library published to PyPI |

### 1.5 Cross-archetype invariants

All four fixtures share these properties:
- `.git/` directory initialized with at least one prior tagged release (`v0.0.1` or `v2026.5.0`) so backfill and prev-tag walks have something to chew on.
- At least 3 tasks in a populated `.cleo/tasks.db` linked to recent commits via `T####` tokens.
- At least 1 BRAIN observation per fixture so `brain_release_links` can be populated.
- A `.cleo/audit/` directory writable so the audit log can append.

---

## 2. Test Scenarios

Twelve scenarios, each anchored to one or more failure modes from `failure-forensics-10-modes.md`. Every scenario has: a name, archetype targets, pre-conditions, execution steps, success criteria, and failure-mode coverage.

### S1 — Happy-path release (no failures injected)

| Property | Value |
|---|---|
| **Name** | S1 happy-path |
| **Archetypes** | A1, A2, A3, A4 |
| **Pre-conditions** | Fixture cloned; tasks.db pre-populated with 3 tasks under epic `T-test-S1`; all evidence atoms valid; clean working tree |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S1`; (2) `cleo release open vNEXT`; (3) wait for `release-prepare.yml`; (4) simulate PR merge on the test branch; (5) wait for `release-publish.yml`; (6) `cleo release reconcile vNEXT`; (7) `cleo provenance verify vNEXT` |
| **Success criteria** | All 7 steps exit 0. `releases.status` advances `planned → pr-opened → pr-merged → published → reconciled`. Provenance tables populated. Total wall-time ≤5 minutes (AC-1). |
| **Failure-mode coverage** | (none — establishes baseline that the happy path works) |
| **Test asset** | `packages/cleo/test/integration/release-v2-happy-path.test.ts` |

### S2 — Wedged git commit recovery (forensics F1)

| Property | Value |
|---|---|
| **Name** | S2 wedged-git-recovery |
| **Archetypes** | A1 (sufficient — proves the mechanism) |
| **Pre-conditions** | Fixture as S1; a sidecar process that holds `.git/index.lock` for 90 seconds is started concurrently with the release-prepare workflow |
| **Execution steps** | (1) Start a Python sidecar: `touch .git/index.lock && sleep 90`; (2) `cleo release plan vNEXT --epic T-test-S2`; (3) `cleo release open vNEXT`; (4) observe `release-prepare.yml` step "Commit version bump" timing out per GHA `timeout-minutes`; (5) sidecar exits; (6) re-run the workflow via `gh workflow run`; (7) verify the commit succeeds the second time |
| **Success criteria** | The first workflow run fails cleanly at the locked-commit step with `timeout-minutes` exceeded; the job log emits `Recovery: cleo release plan <v> --epic <id>; cleo release open <v>` per SPEC R-209; the second run succeeds. No local CLEO CLI process hangs (verified by `ps -ef | grep cleo` returning no orphans after the workflow exits). |
| **Failure-mode coverage** | F1 (wedged commit, no timeout) — STRUCTURALLY ELIMINATED by SPEC R-204, R-209 |
| **Test asset** | `packages/cleo/test/integration/release-v2-wedged-git.test.ts` (uses GHA `act` for local simulation) |

### S3 — Epic completeness scope confined (forensics F2)

| Property | Value |
|---|---|
| **Name** | S3 epic-scope-confined |
| **Archetypes** | A1 (multi-epic data needed) |
| **Pre-conditions** | Fixture's tasks.db contains TWO unrelated epics: `T-test-S3-target` (the release target, 3 children all done) and `T-test-S3-noise` (an unrelated epic with 1 incomplete child); both epics' children have `T####` commit tokens in the prev-tag → HEAD range |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S3-target`; (2) inspect the plan file's `epicAncestor` field for each task; (3) `cleo release open vNEXT`; (4) trigger `release-prepare.yml` |
| **Success criteria** | The plan file's tasks[] contain ONLY children of `T-test-S3-target`; no task under `T-test-S3-noise` appears. Epic-completeness check passes (the unrelated epic's incomplete child is NOT flagged). Bump-PR opens cleanly. |
| **Failure-mode coverage** | F2 (epic completeness scope leak) — STRUCTURALLY ELIMINATED by SPEC R-021, R-303 |
| **Test asset** | `packages/cleo/test/integration/release-v2-epic-scope.test.ts` |

### S4 — Gate runners actually execute (forensics F3, F4)

| Property | Value |
|---|---|
| **Name** | S4 real-gate-runners |
| **Archetypes** | A1, A2, A3 |
| **Pre-conditions** | Fixture's tasks.db has a task whose `testsPassed` evidence atom points at a vitest JSON containing 100 passed / 0 failed; a second task whose evidence is `tool:test` resolving via ADR-061 |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S4`; (2) inspect `plan.gates[]` — every gate MUST have `status='passed'` and `lastVerifiedAt` populated; (3) deliberately corrupt one task's `test-run` JSON to have `failures>0`; (4) re-run `cleo release plan` — MUST fail with `E_EVIDENCE_INSUFFICIENT` |
| **Success criteria** | Step 2: all 5 canonical gates resolved via ADR-061 (tool exit codes observed, NOT theater). Step 4: plan rejected with structured error citing the failing task ID. The `defaultRunGate` no-op stub does NOT exist anywhere in the v2 codebase. |
| **Failure-mode coverage** | F3 (gate runners not wired), F4 (IVTR non-blocking gate) — STRUCTURALLY ELIMINATED by SPEC R-310 through R-316 |
| **Test asset** | `packages/cleo/test/integration/release-v2-real-gates.test.ts` |

### S5 — Tag lands on merge SHA (forensics F6)

| Property | Value |
|---|---|
| **Name** | S5 tag-canonical-sha |
| **Archetypes** | A1, A2, A3 |
| **Pre-conditions** | A test bump-PR is opened against the fixture's `main` branch; the PR is set to auto-merge with `--merge` strategy |
| **Execution steps** | (1) `cleo release plan vNEXT`; (2) `cleo release open vNEXT`; (3) wait for PR auto-merge; (4) wait for `release-publish.yml` to tag; (5) `git rev-list -n 1 vNEXT` and `gh pr view <pr-num> --json mergeCommit`; (6) compare |
| **Success criteria** | The SHA `git rev-list -n 1 vNEXT` exactly matches `gh pr view --json mergeCommit.oid`. No race window observable; the tag step in `release-publish.yml` polls `gh pr view --json state,mergeCommit` BEFORE issuing the tag per SPEC R-229. |
| **Failure-mode coverage** | F6 (tag at wrong SHA) — STRUCTURALLY ELIMINATED by SPEC R-229 |
| **Test asset** | `packages/cleo/test/integration/release-v2-tag-sha.test.ts` |

### S6 — Hotfix path bypasses unrelated epic completeness (forensics F2 + new MTTR target)

| Property | Value |
|---|---|
| **Name** | S6 hotfix-bypass |
| **Archetypes** | A1 (most complex case) |
| **Pre-conditions** | Most recent release was `v2026.6.0` (shipped <24h ago). Tasks.db contains an unrelated incomplete epic `T-test-S6-noise` AND a P0 hotfix task `T-test-S6-hotfix` (kind=bug, severity=P0). |
| **Execution steps** | (1) `cleo release plan v2026.6.0.2 --epic T-test-S6-hotfix --hotfix`; (2) inspect `plan.releaseKind='hotfix'` and `plan.resolvedVersion='v2026.6.0.2'`; (3) `cleo release open v2026.6.0.2`; (4) measure total wall-time from step 1 to `cleo provenance verify v2026.6.0.2` passing |
| **Success criteria** | The hotfix plan does NOT enumerate any children of `T-test-S6-noise`. The version suffix `.2` is computed correctly per SPEC R-400. Wall-time ≤60 minutes including a 5-minute human PR review SLA simulation (AC-3). `release_changes` row for the hotfix task has `change_type='hotfix'`. |
| **Failure-mode coverage** | F2 (epic scope) revisited at hotfix scale; SPEC §10 R-400 through R-405 |
| **Test asset** | `packages/cleo/test/integration/release-v2-hotfix.test.ts` |

### S7 — Resume after CI failure mid-flight (forensics F8)

| Property | Value |
|---|---|
| **Name** | S7 resume-mid-flight |
| **Archetypes** | A1 |
| **Pre-conditions** | A bump-PR is open; `release-prepare.yml` preflight is intentionally rigged to fail on the first run (e.g. a flaky test) |
| **Execution steps** | (1) `cleo release plan vNEXT`; (2) `cleo release open vNEXT`; (3) preflight fails; (4) operator inspects `gh run view <run-id>` and the recovery hint in the job log; (5) operator removes the flake; (6) `gh workflow run release-prepare.yml --field version=vNEXT` (re-dispatch); (7) preflight passes; (8) bump-PR updates correctly |
| **Success criteria** | Re-dispatching is idempotent per SPEC R-009. The plan file is unchanged between steps 2 and 7. The bump-PR's HEAD advances correctly without duplicate commits. |
| **Failure-mode coverage** | F8 (release start no-op) — STRUCTURALLY ELIMINATED by plan-file-as-state per SPEC R-030 |
| **Test asset** | `packages/cleo/test/integration/release-v2-resume.test.ts` |

### S8 — Provenance graph populated (audit Q4 closure)

| Property | Value |
|---|---|
| **Name** | S8 provenance-graph-populated |
| **Archetypes** | A1, A2, A3, A4 |
| **Pre-conditions** | A release has just shipped through the new path; `releases.status='reconciled'` |
| **Execution steps** | (1) `cleo release graph vNEXT --format mermaid`; (2) validate the Mermaid output against the schema in `provenance-graph-design.md` §6.3; (3) run the 8 canonical SQL queries from provenance design §5 (Q1-Q8); (4) verify each query returns expected rows |
| **Success criteria** | Mermaid output renders cleanly via `mmdc` (mermaid-cli). All 8 queries execute in ≤50ms each at fixture scale. `cleo release orphans vNEXT` returns an empty list (AC-2). Counts match: `releases_view.change_count` equals the count of `release_changes` rows for the release. |
| **Failure-mode coverage** | (new capability — audit Q4 closure) |
| **Test asset** | `packages/cleo/test/integration/release-v2-provenance-graph.test.ts` |

### S9 — Orphan-commit detection (release-prepare warning)

| Property | Value |
|---|---|
| **Name** | S9 orphan-commit-detection |
| **Archetypes** | A1 (cleanest demonstration) |
| **Pre-conditions** | The fixture has a commit on `main` (between previous tag and HEAD) whose subject does NOT contain any `T####` token — i.e. an orphan |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S9`; (2) inspect `plan.preflightSummary.orphanCommits[]` — MUST contain the orphan SHA; (3) `cleo release open vNEXT`; (4) `release-prepare.yml`'s preflight emits a non-blocking warning |
| **Success criteria** | The orphan commit appears in the plan's preflight summary; the workflow does NOT fail (orphans are warnings, not errors); `cleo release orphans vNEXT` post-reconcile lists the commit. Operators can audit drift. |
| **Failure-mode coverage** | (new capability — provenance Q5) |
| **Test asset** | `packages/cleo/test/integration/release-v2-orphans.test.ts` |

### S10 — Rollback creates a clean revert PR (forensics F8 + new rollback)

| Property | Value |
|---|---|
| **Name** | S10 rollback-clean |
| **Archetypes** | A1, A2 |
| **Pre-conditions** | A release `vNEXT` has just shipped and `releases.status='reconciled'`; a P0 bug `T-test-S10-bug` is filed against it |
| **Execution steps** | (1) `cleo release rollback vNEXT --full --reason "S10 dry-run rollback test"`; (2) wait for `release-rollback.yml` to open the revert PR; (3) inspect the revert PR's diff (MUST cleanly revert the bump commit); (4) merge the revert PR; (5) verify the tag is deleted; (6) verify `releases.status='rolled_back'` and `release_changes` has a new `change_type='revert'` row |
| **Success criteria** | The revert PR opens against `main` (NOT a direct push). The PR title matches `Revert release vNEXT: S10 dry-run rollback test`. After merge: `gh release view vNEXT` returns 404; `npm view @release-test/cli@<version>` reports `deprecated: 'Rolled back: …'` (for A1/A2 archetypes). |
| **Failure-mode coverage** | (new capability — clean rollback path; eliminates the manual `git tag -d && git push origin :refs/tags/<tag>` ritual) |
| **Test asset** | `packages/cleo/test/integration/release-v2-rollback.test.ts` |

### S11 — Project-agnostic: single npm lib ships (A2)

| Property | Value |
|---|---|
| **Name** | S11 archetype-npm-lib |
| **Archetypes** | A2 |
| **Pre-conditions** | A2 fixture cloned; no `pnpm-workspace.yaml`; only one `package.json`; npm + tsc + vitest stack |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S11`; (2) inspect `plan.platformMatrix` — MUST contain a single `platform=any` entry; (3) `cleo release open vNEXT`; (4) workflow runs (single platform smoke); (5) publish to a local npm test registry (`verdaccio`); (6) reconcile; (7) verify `release_artifacts` row has `artifact_type='npm'` and a single matrix entry |
| **Success criteria** | The same code path that ships A1 (monorepo) ships A2 (single lib) with NO conditional branches in the verbs themselves. Per SPEC R-360, archetype detection lives in `.cleo/project-context.json` + filesystem markers, not in verb logic. The pipeline does NOT spawn `pnpm`-specific commands for A2. |
| **Failure-mode coverage** | F3 + ADR-053 portability regression — STRUCTURALLY ELIMINATED |
| **Test asset** | `packages/cleo/test/integration/release-v2-archetype-npm-lib.test.ts` |

### S12 — Project-agnostic: rust crate ships (A3)

| Property | Value |
|---|---|
| **Name** | S12 archetype-rust-crate |
| **Archetypes** | A3 |
| **Pre-conditions** | A3 fixture cloned; cargo + clippy + rustfmt + cargo-test stack; a local crates.io mirror (sparse registry) for the publish target |
| **Execution steps** | (1) `cleo release plan vNEXT --epic T-test-S12`; (2) inspect resolved tools — MUST be `cargo test`, `cargo build`, `cargo clippy`, `cargo audit`; (3) `cleo release open vNEXT`; (4) `release-prepare.yml`'s preflight runs the cargo toolchain (NOT pnpm); (5) `release-publish.yml`'s publish-and-tag job runs `cargo publish --token <test-token>` against the sparse mirror; (6) reconcile; (7) verify `release_artifacts.artifact_type='cargo'` |
| **Success criteria** | The pipeline produces a cargo crate artifact with NO npm/pnpm references in the workflow logs. Cross-compile artifacts (linux-x64/arm64, macos-x64/arm64, windows-x64) are produced via `cargo build --target <triple>` for binary crates; library crates collapse to a single `[any]` matrix. |
| **Failure-mode coverage** | F3 + ADR-053 portability regression — STRUCTURALLY ELIMINATED |
| **Test asset** | `packages/cleo/test/integration/release-v2-archetype-rust-crate.test.ts` |

---

## 3. CI Matrix Configuration

The matrix runs every scenario against every applicable archetype per the scenario's "Archetypes" column. The configuration uses GitHub Actions' matrix expansion plus a per-scenario `include` block to skip non-applicable archetypes.

```yaml
# .github/workflows/release-v2-matrix.yml (proposed; T9345-CHILD-3 deliverable)
name: Release Pipeline v2 — Test Matrix

on:
  pull_request:
    paths:
      - 'packages/core/src/release/**'
      - 'packages/cleo/test/fixtures/release-test-**'
      - '.github/workflows/release-*.yml'
  workflow_dispatch:

jobs:
  matrix:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    strategy:
      fail-fast: false
      matrix:
        scenario:
          - S1
          - S2
          - S3
          - S4
          - S5
          - S6
          - S7
          - S8
          - S9
          - S10
          - S11
          - S12
        archetype:
          - A1
          - A2
          - A3
        include:
          # Stretch: S1/S4/S8 also run against A4 (python)
          - { scenario: S1, archetype: A4 }
          - { scenario: S4, archetype: A4 }
          - { scenario: S8, archetype: A4 }
        exclude:
          # Scenarios that don't apply to every archetype
          - { scenario: S2, archetype: A2 }
          - { scenario: S2, archetype: A3 }
          - { scenario: S3, archetype: A2 }
          - { scenario: S3, archetype: A3 }
          - { scenario: S6, archetype: A2 }
          - { scenario: S6, archetype: A3 }
          - { scenario: S7, archetype: A2 }
          - { scenario: S7, archetype: A3 }
          - { scenario: S9, archetype: A2 }
          - { scenario: S9, archetype: A3 }
          - { scenario: S11, archetype: A1 }
          - { scenario: S11, archetype: A3 }
          - { scenario: S12, archetype: A1 }
          - { scenario: S12, archetype: A2 }

    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: '22' }
      - uses: pnpm/action-setup@v4
        with: { version: '10' }
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        if: matrix.archetype == 'A3'
      - uses: actions/setup-python@v6
        if: matrix.archetype == 'A4'
        with: { python-version: '3.13' }

      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

      - name: Run scenario ${{ matrix.scenario }} against archetype ${{ matrix.archetype }}
        env:
          CLEO_FIXTURE_PATH: packages/cleo/test/fixtures/release-test-${{ matrix.archetype-name }}
          CLEO_TEST_REGISTRY: http://localhost:4873   # verdaccio for A1/A2/A4
        run: pnpm run test:scenario -- --scenario=${{ matrix.scenario }} --archetype=${{ matrix.archetype }}

  summary:
    needs: matrix
    runs-on: ubuntu-latest
    if: always()
    steps:
      - run: |
          echo "Matrix complete. Inspect individual jobs for per-scenario detail."
          # Aggregate green/red status; fail the summary job if any matrix slot failed.
```

### 3.1 Matrix coverage summary

- **Total matrix slots**: 3 archetypes × 12 scenarios − 14 excluded + 3 stretch (A4) = **25 jobs per matrix run**.
- **Estimated wall-time**: ≤15 minutes per slot in parallel = ~25 minutes wall-time per matrix run.
- **Required for PR merge**: a green matrix run is required for any PR touching the release pipeline (per branch protection rules).
- **Required for release-v2 acceptance**: 3 consecutive green matrix runs on `main` (no flakes) before declaring T9345 complete.

### 3.2 Local execution

Operators MAY run the matrix locally via:

```bash
# Single scenario, single archetype:
pnpm run test:scenario -- --scenario=S1 --archetype=A1

# All scenarios against one archetype:
pnpm run test:matrix -- --archetype=A2

# Full matrix:
pnpm run test:matrix
```

The local runner provisions ephemeral fixtures and tears them down on exit. No persistent state is left in the developer's git tree.

---

## 4. Pass/Fail Gate

The matrix's pass definition is quantitative and binary:

### 4.1 Per-archetype pass

For archetype A∈{A1,A2,A3}, "pass" means: every scenario in the matrix that applies to A is GREEN for three consecutive runs (no flakes).

A4 (stretch) is informational; A4 failures do NOT block T9345 completion but MUST be triaged.

### 4.2 Quantitative thresholds

| Metric | Source | Threshold | Reason |
|---|---|---|---|
| Happy-path wall-time | S1 across A1, A2, A3 | ≤ 5 minutes | AC-1 |
| Orphan commits | S8 + S9 across all archetypes | 0 in any shipped release | AC-2 |
| Hotfix MTTR | S6 (A1 only) | ≤ 60 minutes including review | AC-3 |
| Provenance verify | S8 across all archetypes | 100% pass | AC-7 |
| Tag SHA mismatch | S5 across all archetypes | 0 mismatches over 100 runs | AC-1 + F6 prevention |
| Build matrix coverage | S1/S5/S11/S12 | 5 platform tuples × archetype's package count | AC-4 + T1737 |
| Deprecation surface | (manual check post-Phase 6) | `cleo release --help` shows exactly 4 verbs at top | AC-6 |
| `--force` flag references | grep over `packages/cleo/src/cli/commands/release.ts` | 0 hits | AC-9 |
| IVTR-from-release references | gitnexus_query "task.ivtr_state" scope release | 0 hits | AC-10 |

### 4.3 Failure investigation protocol

When a matrix slot fails:

1. Inspect the GHA job log; download the artifact tarball from the workflow.
2. Reproduce locally: `pnpm run test:scenario -- --scenario=<id> --archetype=<id>`.
3. If the failure is flaky (not reproducible in 3 local runs), file a flaky-test bug and re-run the matrix.
4. If reproducible: bisect the recent PRs that touched release code; revert if necessary.
5. Update the scenario assertions if the failure indicates a specification ambiguity (file an ADR amendment).

---

## 5. Owner Sign-off Checklist

Before declaring T9345 complete, the owner MUST verify each of the following items. Each item maps to an acceptance criterion from SPEC §14.

### 5.1 Functional checklist

- [ ] **AC-1 verified**: Three consecutive happy-path releases (S1) shipped through the new pipeline with operator wall-time ≤5 minutes each. Operator time-tracking artifact at `.cleo/audit/release-usage.jsonl`.
- [ ] **AC-2 verified**: For the three most recent releases shipped via v2, `cleo release orphans <version>` returns an empty list. Output captured to `/tmp/orphans-vX.json`.
- [ ] **AC-3 verified**: At least one hotfix path exercised end-to-end (real or test); MTTR measured ≤1 hour from issue creation to reconcile completion.
- [ ] **AC-4 verified**: All three required archetypes (A1, A2, A3) pass the full matrix (S1-S12 applicable subset) in three consecutive runs. A4 (Python) passes at least S1, S4, S8 (stretch).
- [ ] **AC-5 verified**: Forensics failure modes F1, F2, F3, F4, F5, F6, F8, F9, F10 do NOT reproduce against the new pipeline. Each was injected at least once and the structural prevention observed. F7 (worker direct-push) is mitigated by branch protection + T9345-CHILD-7 worktree-policy artifact.
- [ ] **AC-6 verified**: `cleo release --help` output captured; shows exactly 4 verbs at the top (`plan`, `open`, `reconcile`, `rollback`); deprecated verbs listed under a "Deprecated" section with removal-release announcements.
- [ ] **AC-7 verified**: All 11 provenance tables populated for every reconcile invocation in the post-migration window. `cleo provenance verify <version>` returns pass for the three most recent releases.
- [ ] **AC-8 verified**: `actionlint` passes on all four workflow YAML files in CI. Latest CI run URL captured.
- [ ] **AC-9 verified**: `grep -r "\-\-force" packages/cleo/src/cli/commands/release.ts` returns no hits. `gitnexus_query "force" scope release` returns no hits referencing the legacy flag (only the historical deletion commit).
- [ ] **AC-10 verified**: `gitnexus_query "task.ivtr_state"` returns zero hits in `packages/core/src/release/*` (outside the deprecation shim doc).

### 5.2 Schema + data checklist

- [ ] All 9 migrations applied cleanly on the production `tasks.db`; backup taken before each phase.
- [ ] Historical `release_manifests` rows preserved (count unchanged pre- vs. post-migration).
- [ ] Backfill completed: ≥95% of historical `release_changes` rows have `provenance_quality='inferred'`; the remaining ≤5% are triaged.
- [ ] `releases_view` returns correct counts for the three most recent releases.

### 5.3 Documentation checklist

- [ ] `ct-orchestrator` skill documentation updated to reference the 4 new verbs.
- [ ] `AGENTS.md` Release & Branching section updated to describe `plan`/`open`/`reconcile`/`rollback`.
- [ ] `CLEO-RELEASE-PIPELINE-SPEC.md` (legacy) marked superseded; redirects readers to `SPEC-T9345-release-pipeline-v2.md`.
- [ ] `docs/release/branch-protection-setup.md` updated to include the new required status checks (`release-prepare/preflight`, `release-publish/build-matrix`, `release-publish/publish-and-tag`).
- [ ] CHANGELOG entries for v2026.7.0 and v2026.7.1 use the new auto-generated format AND include a "T9345 migration" highlight section.

### 5.4 Cleanup checklist

- [ ] `releaseShip` monolith deleted (`packages/core/src/release/engine-ops.ts:1105-1866`).
- [ ] Parallel 4-step pipeline deleted (`packages/core/src/release/pipeline.ts:releaseStart/Verify/Publish/Reconcile`).
- [ ] IVTR-from-release glue deleted (`engine-ops.ts:releaseGateCheck`, `releaseIvtrAutoSuggest`, `checkIvtrGates`).
- [ ] `defaultRunGate` stub deleted.
- [ ] Net code reduction ≥1500 LOC verified via `git diff --stat <pre-T9345-tag>..HEAD packages/core/src/release/`.

### 5.5 Final owner statement

When all items above are checked, the owner signs the T9345 completion record by:

1. Running `cleo verify T9345 --gate implemented --evidence "commit:<sha>;files:packages/core/src/release/plan.ts,packages/core/src/release/reconcile.ts,packages/core/src/release/open.ts;decision:ADR-073-ivtr-release-overhaul"`.
2. Running `cleo verify T9345 --gate testsPassed --evidence "tool:test"`.
3. Running `cleo verify T9345 --gate qaPassed --evidence "tool:lint;tool:typecheck"`.
4. Running `cleo verify T9345 --gate documented --evidence "files:.cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md,.cleo/rcasd/T9345/research/migration-plan-T9345.md,.cleo/rcasd/T9345/research/test-matrix-T9345.md,.cleo/adrs/ADR-073-ivtr-release-overhaul.md"`.
5. Running `cleo complete T9345`.

Per ADR-051, this records evidence atoms for the spec-deliverable phase. Subsequent child epics (T9491, T9492, T9493, T9494, T9495, T9496, T9497, T9498, T9499) each record their own evidence on completion.

---

## 6. Test harness implementation notes

This section is informative (not normative) but useful for T9345-CHILD-3 implementers.

### 6.1 Fixture provisioning

Fixtures live as static directories under `packages/cleo/test/fixtures/release-test-<archetype>/`. The test harness:

1. Copies the fixture to a temp directory.
2. Runs `git init && git add -A && git commit -m 'initial fixture'` to seed the git state.
3. Tags the initial commit (`v0.0.1` or `v2026.5.0`).
4. Adds 2-3 follow-up commits with `T####` tokens to simulate work between releases.
5. Runs the scenario.
6. Tears down the temp directory.

The harness uses CLEO's existing `temp-dir` test utility (`packages/core/src/__test-utils__/temp-dir.ts`) for isolation.

### 6.2 Workflow simulation locally

Workflows are tested locally via `act` (nektos/act). The test harness invokes `act` with the appropriate workflow file and event payload:

```bash
act workflow_dispatch -W .github/workflows/release-prepare.yml \
  --input version=v2026.7.0-test-1 \
  --input plan-blob-sha256=$(sha256sum /tmp/plan.json | cut -d' ' -f1) \
  --bind \
  --container-architecture linux/amd64
```

For matrix slots, `act` runs each platform tuple in sequence; full cross-platform validation requires the real GHA runner matrix.

### 6.3 Local registry mocks

- **npm**: verdaccio (`docker run -p 4873:4873 verdaccio/verdaccio`) for A1/A2.
- **cargo**: cargo-sparse-registry (local file:// URL) for A3.
- **PyPI**: pypiserver (`pip install pypiserver`) for A4.
- **GitHub Release**: a stub `gh release` mock that records calls but never publishes to a real registry.

### 6.4 Time tracking

The harness records:
- Each scenario's start/end timestamp.
- Each step's individual wall-time.
- Workflow run URLs.
- Final state of `releases.status` and provenance row counts.

Outputs are aggregated into `.cleo/test-results/release-v2-matrix-<run-id>.json` for retrospective analysis.

---

## 7. Mapping back to SPEC requirements

This section asserts that every scenario covers at least one normative SPEC requirement. The reverse direction (every SPEC requirement covered by ≥1 scenario) is verified separately as part of the T9345-CHILD-1 spec-acceptance gate.

| Scenario | SPEC requirements covered (sample) |
|---|---|
| S1 | R-001 (LAFS envelope), R-009 (idempotency), R-030-R-042 (plan), R-050-R-071 (open), R-080-R-113 (reconcile), R-150 (read verbs) |
| S2 | R-005 (timeout), R-006 (SIGKILL grace), R-204 (preflight timeout-minutes), R-209 (recovery hint) |
| S3 | R-021 (epic existence), R-303 (epic locked at plan time), R-401 (hotfix scope) |
| S4 | R-310 (require evidence), R-311 (resolver), R-312 (no double execution), R-313 (staleness) |
| S5 | R-229 (poll before tag), R-082 (tagName match) |
| S6 | R-400-R-405 (hotfix), R-022 (channel mismatch), AC-3 (MTTR) |
| S7 | R-009 (idempotency), R-030 (atomic write), R-302 (FSM monotonic) |
| S8 | R-091-R-097 (reconcile writes), R-345 (transactionality), R-151 (read verbs safe) |
| S9 | R-024 (preflight summary), R-091 (release_commits NOT EXISTS task_commits) |
| S10 | R-120-R-140 (rollback), R-254 (revert PR not direct push), R-256 (rollback reconcile) |
| S11 | R-360 (project-context override), R-361 (archetype detection), R-370 (platform matrix) |
| S12 | R-360, R-361, R-371 (single-platform collapse), provenance §7 (cargo polymorphism) |

---

*End of test matrix — T9345 wave-3 spec artifact.*
