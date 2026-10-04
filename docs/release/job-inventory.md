---
title: CI Job Inventory + PR/main Parity Matrix (T10106 + T10274)
task: T10106
followups: [T10274]
saga: T10099
generated: 2026-05-23
last-updated: 2026-05-23
---

# CI Job Inventory + PR/main Parity Matrix (T10106 + T10274)

> **T10274 update (2026-05-23)** — Parity divergences D2, D3, D4, and D9 noted in this
> document have been fixed: dead `develop` branch filter dropped from
> `arch-boundary-check.yml`, `ci.yml`, `dual-implementation-lint.yml`;
> bare `pull_request:` triggers in `identity-pollution-check.yml` and
> `lockfile-check.yml` now carry an explicit `branches: [main]` filter;
> and `release-pipeline-matrix.yml`'s `release-pipeline` label gate
> (with `types: [labeled, synchronize]`) has been removed in favor of
> path-only triggers.

Exhaustive matrix of every GitHub Actions workflow in `.github/workflows/`, the jobs each defines, the events that trigger them, and whether each job runs on **PR-to-main** vs **push-to-main** vs **tag-push**.

This document is the authoritative reference for cross-checking PR CI green-state against required main-branch checks. It is regenerated whenever workflows are added or trigger filters change.

## Legend

| Trigger | Symbol | Meaning |
|---|---|---|
| Pull request to `main` | `PR` | Runs when a PR is opened/synced against `main` |
| Push to `main` | `PUSH` | Runs on every push to the `main` branch (post-merge) |
| Tag push (`v*`) | `TAG` | Runs when a `v<calver>` tag is pushed |
| Cron schedule | `CRON` | Runs on a time-based schedule |
| Manual dispatch | `MANUAL` | Operator-only via `gh workflow run` |
| Other (`pull_request: closed`, `label`, etc.) | `OTHER` | Conditional/event-typed |

A check-mark `Y` means **the job's workflow triggers fire for that event AND any `paths:` / `if:` filter would allow this PR/push to run it**. `N` means the trigger is absent (the job will not fire on that event regardless of contents). `paths-y` means the workflow runs on that event only when path filters match.

## Workflow Inventory (17 workflows, 50 jobs)

> T10104 added `auto-tag-on-release-merge.yml` (workflow #17) in PR #533, included below.

| # | Workflow file | Job (id) | Job name | PR→main | PUSH→main | TAG | CRON | MANUAL | Timeout | `# @task` |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | `auto-tag-on-release-merge.yml` | `auto-tag` | Tag merge commit | OTHER (`pull_request: closed` + title `release: ship v*`) | N | N | N | N | (none) | `# @task T10104` |
| 1 | `arch-boundary-check.yml` | `db-open-guard` | DB Open Guard (T10073) | Y | Y | N | N | N | 3m | inline (T10073) |
| 1 | `arch-boundary-check.yml` | `define-command-ssot` | Architectural Boundary Check (SG-ARCH-SOLID) | Y | Y | N | N | N | 2m | inline (T10072/T9837) |
| 2 | `boundary-registry-lint.yml` | `boundary-registry-lint` | Boundary Registry Lint | Y | Y | N | N | N | 5m | inline (T10198) |
| 3 | `ci.yml` | `changes` | Detect Changes | Y | Y | N | N | N | 2m | — |
| 3 | `ci.yml` | `biome` | Lint & Format | Y | Y | N | N | N | 2m | — |
| 3 | `ci.yml` | `worktree-location-lint` | Worktree Location Lint (T9809) | Y | Y | N | N | N | 2m | inline (T9809) |
| 3 | `ci.yml` | `agent-outputs-registration` | Agent-Outputs Registration Lint (T1617) | Y | Y | N | N | N | 2m | inline (T1617) |
| 3 | `ci.yml` | `ssot-lint` | Contracts/Core SSoT (ADR-057) | Y | Y | N | N | N | 2m | inline |
| 3 | `ci.yml` | `path-drift-lint` | Path Drift Lint (T9407) | Y | Y | N | N | N | 2m | inline (T9407) |
| 3 | `ci.yml` | `project-root-anti-pattern-lint` | Project Root Anti-Pattern Lint (T9584) | Y | Y | N | N | N | 2m | inline (T9584) |
| 3 | `ci.yml` | `paths-ssot-lint` | Paths SSoT Lint (T9802) | Y | Y | N | N | N | 2m | inline (T9802) |
| 3 | `ci.yml` | `raw-git-worktree-lint` | Raw Git Worktree Lint (T9984) | Y | Y | N | N | N | 2m | inline (T9984) |
| 3 | `ci.yml` | `saga-symbol-leakage-lint` | Saga Symbol Leakage Lint (T10120) | Y | Y | N | N | N | 2m | inline (T10120) |
| 3 | `ci.yml` | `json-stream-hygiene-lint` | JSON Stream Hygiene Lint (T9775) | Y | Y | N | N | N | 2m | inline (T9775) |
| 3 | `ci.yml` | `rust-vendor-parity-lint` | Rust Vendor Parity Lint (T10224) | Y | Y | N | N | N | 2m | inline (T10224) |
| 3 | `ci.yml` | `contracts-dep-lint` | Contracts Dep Lint | Y | Y | N | N | N | 2m | — |
| 3 | `ci.yml` | `contracts-fan-out-lint` | Contracts Fan-Out Lint (T10074) | Y | Y | N | N | N | 2m | inline (T10074) |
| 3 | `ci.yml` | `format-error-misuse-lint` | Format-Error Misuse Lint (T9789) | Y | Y | N | N | N | 2m | inline (T9789) |
| 3 | `ci.yml` | `deprecations-lint` | Deprecations Registry Lint (T9795) | Y | Y | N | N | N | 2m | inline (T9795) |
| 3 | `ci.yml` | `pragma-drift` | SQLite Pragma Drift Guard (T9025/T9190) | Y | Y | N | N | N | 5m | inline |
| 3 | `ci.yml` | `db-open-guard` | DB Open Chokepoint Guard (ADR-068 T9047) | Y | Y | N | N | N | 2m | inline |
| 3 | `ci.yml` | `core-first-lint` | CORE-First Architecture Lint (T9622) | Y | Y | N | N | N | 2m | inline |
| 3 | `ci.yml` | `ssot-exempt-lint` | SSoT-EXEMPT Lint (T10075/T9837) | Y | Y | N | N | N | 2m | inline |
| 3 | `ci.yml` | `cli-boundary-lint` | CLI Boundary Lint (T10076/T9837) | Y | Y | N | N | N | 2m | inline |
| 3 | `ci.yml` | `canon-drift` | Canon Drift Check | Y | Y | N | N | N | 5m | — |
| 3 | `ci.yml` | `canon-check` | Canon Drift Check (T9796) | Y | Y | N | N | N | 5m | inline (T9796) |
| 3 | `ci.yml` | `docs-drift` | Docs SSoT Drift Gate (T9645) | Y | Y | N | N | N | 5m | inline (T9645) |
| 3 | `ci.yml` | `migration-integrity` | Migration Integrity | Y | Y | N | N | N | 2m | — |
| 3 | `ci.yml` | `migration-lint` | Migration Lint | Y | Y | N | N | N | 5m | — |
| 3 | `ci.yml` | `drizzle-kit-check` | Drizzle Kit Schema Check | Y | Y | N | N | N | 5m | — |
| 3 | `ci.yml` | `typecheck` | Type Check | Y | Y | N | N | N | 10m | — |
| 3 | `ci.yml` | `unit-tests` | Unit Tests (matrix: os × shard) | Y | Y | N | N | N | 20m | — |
| 3 | `ci.yml` | `build-verify` | Build & Verify (matrix: os) | Y | Y | N | N | N | 10m | — |
| 3 | `ci.yml` | `validate-json` | Validate JSON Schemas | Y | Y | N | N | N | 5m | — |
| 3 | `ci.yml` | `install-test` | Install Test | Y | Y | N | N | N | 10m | — |
| 3 | `ci.yml` | `forge-ts-check` | Documentation Coverage (forge-ts) | Y | Y | N | N | N | 5m | — |
| 4 | `docs-reingest.yml` | `reingest` | Re-ingest published docs | OTHER (`pull_request: closed`) | N (uses PR-merge event) | N | N | N | 15m | inline (T9645) |
| 5 | `dual-implementation-lint.yml` | `dual-implementation-lint` | Dual Implementation Lint (T10199) | Y | Y | N | N | N | 5m | inline (T10199) |
| 6 | `freshness-sentinel.yml` | `check-dream-freshness` | Check BRAIN dream cycle health | N | N | N | Y (daily 06:00 UTC) | Y | 10m | — |
| 7 | `identity-pollution-check.yml` | `reject-polluted-identity` | Reject `Test <test@example.com>` | Y (T10274: now explicit `branches: [main]`) | Y | N | N | N | 2m | — |
| 8 | `lockfile-check.yml` | `lockfile-consistency` | Verify `pnpm-lock.yaml` consistency | Y (T10274: now explicit `branches: [main]`) | Y | N | N | N | (none) | — |
| 9 | `release-pipeline-matrix.yml` | `matrix-gate` | Build matrix | paths-y (T10274: label gate removed) | paths-y | N | N | N | 5m | — |
| 9 | `release-pipeline-matrix.yml` | `scenario` | matrix.scenario / matrix.archetype | paths-y (T10274: label gate removed) | paths-y | N | N | N | 15m | — |
| 9 | `release-pipeline-matrix.yml` | `summarize` | Matrix summary | paths-y (T10274: label gate removed) | paths-y | N | N | N | 3m | — |
| 10 | `release-prepare.yml` | `prepare` | Prepare Release Branch | N | N | N | N | Y | 15m | `# @task T9781` |
| 11 | `release.yml` | `release` | Build & Publish | N | N | Y (`v[0-9]+.[0-9]+.[0-9]+*`) | N | Y | (none) | — |
| 11 | `release.yml` | `execute-payload` | Post-Deploy Execution Payload | N | N | Y | N | Y | 10m | — |
| 12 | `skills-council.yml` | `council-top-n` | Council review of telemetry top-N skills | N | N | N | Y (Sun 06:00 UTC) | Y | 60m | inline (T9662) |
| 13 | `skills-depth-check.yml` | `depth-check` | progressive-disclosure-depth | paths-y | paths-y | N | N | N | 3m | inline (T9684) |
| 14 | `skills-grade.yml` | `grade-canonical-skills` | Grade all canonical skills | N | N | N | Y (Mon 07:00 UTC) | Y | 90m | inline (T9667) |
| 15 | `worktree-cleanup.yml` | `cleanup` | Destroy merged worktree | OTHER (`pull_request: closed`) | Y (added by T10106) | N | N | N | 5m | `# @task T9805`, `# @task T10106` |
| 16 | `worktree-napi-prebuild.yml` | `build` | matrix.triple | paths-y | paths-y, tag-y (`v*`) | Y (paths-y) | N | Y | (none) | — |

Notes:
- "PR→main" — after T10274, every workflow that uses a `pull_request:` trigger
  carries an explicit `branches: [main]` filter (or path-only triggers for the
  release-pipeline matrix). No bare `pull_request:` triggers remain.
- "inline" under `# @task` means the workflow's leading comment block references a task ID without using the `# @task` formal annotation. Workflows that use the formal `# @task <id>` header are explicitly noted.
- `unit-tests` and `build-verify` are matrices — actual job count depends on `os` × `shard` fan-out.

## Divergences (PR vs main)

### D1 — `worktree-cleanup.yml`: PR-only → fixed to also run on push:main

**Status: FIXED in this PR.**

**Before:** `on: pull_request: types: [closed]` — only runs when a PR closes; never runs on direct `push: main`.

**Problem:** Direct pushes to main (release branches, admin merges, force-pushes from emergency hotfixes) do not trigger worktree cleanup. The merged commit's branch name (`task/T####`) is still present on the remote, and the worktree lifecycle audit log misses entries for those merges.

**After:** Added `push: branches: [main]` trigger. The `if:` guard on the `cleanup` job now also accepts `github.event_name == 'push'` (skipping the `pull_request.merged` check on push events).

### D2 — `identity-pollution-check.yml`: bare `pull_request:` trigger — FIXED in T10274

**Status: FIXED in T10274.**

**Before:** `on: pull_request:` (bare) accepted PRs against any base branch (the gate cares about commit identity, not branch). Push filter was already `main`-only.

**After:** `on: pull_request: branches: [main]` — explicit alignment with the push trigger and the rest of the workflow inventory.

### D3 — `lockfile-check.yml`: bare `pull_request:` trigger — FIXED in T10274

**Status: FIXED in T10274.**

Same shape as D2. The trigger was `on: pull_request:` (bare); now `on: pull_request: branches: [main]`. Lockfile consistency is still checked on every PR, but the base-branch is explicit and consistent with the rest of the inventory.

### D4 — `arch-boundary-check.yml` + `ci.yml` + `dual-implementation-lint.yml`: dead `develop` branch filter — FIXED in T10274

**Status: FIXED in T10274.**

**Before:** These three workflows included `develop` in both `push` and `pull_request` branch filters.

**After:** `develop` removed from all three. The branch is not in use on this repo (only `main` exists as a long-lived branch), so the filter was dead. Removing it brings the workflows into line with the simplification trend in T10198+ (boundary-registry-lint) and T10199 (dual-implementation-lint's own README).

### D5 — `boundary-registry-lint.yml`: `main`-only (no `develop`) — intentional

Newer guard (T10198, 2026-05-22) intentionally omits `develop` since the branch is not in use. Consistent with the simplification trend in T10199+. **Intentional — documented here.**

### D6 — `docs-reingest.yml`: PR-merge-only by design

`on: pull_request: types: [closed]` with `if: merged == true` is the canonical pattern for post-merge sync. Re-ingest does not need to run on direct push because direct pushes to main (release branches) are rare and the next PR merge will re-sync. **Intentional — documented here.**

### D7 — `skills-depth-check.yml`: paths-filtered

`pull_request:` and `push: branches: [main]` both gated by `paths: packages/skills/**`. **Intentional — documented here.**

### D8 — `worktree-napi-prebuild.yml`: paths-filtered + tag-fan-out

Builds prebuilt napi binaries on PR (paths-y), push-main (paths-y), and tag (`v*`) events. Tag triggers exist to publish prebuilt binaries with releases. **Intentional — documented here.**

### D9 — `release-pipeline-matrix.yml`: `release-pipeline` label gate — REMOVED in T10274

**Status: FIXED in T10274.**

**Before:** `on: pull_request: types: [labeled, synchronize]` + an `if:` guard on the `matrix-gate` job (`contains(github.event.pull_request.labels.*.name, 'release-pipeline')`). The matrix only ran on a PR after a maintainer applied the `release-pipeline` label.

**After:** `on: pull_request: branches: [main], paths: [...]` — the trigger is path-only, matching the `push: main` trigger exactly. The `if:` label guard on `matrix-gate` is removed. The path filter alone (`packages/cleo/test/fixtures/release-test-**` + `packages/cleo/test/integration/release-pipeline/**`) keeps the heavy 32-job matrix off of unrelated PRs while ensuring every PR that touches the release-pipeline fixtures/scenarios runs the gate without depending on a maintainer remembering to apply a label.

**Why removed:** labels bypass too easily — a PR can ship without the matrix simply because no one noticed to add the label. The path filter is a deterministic admission control. Parity over convenience.

### D10 — `# @task` annotation header inconsistency

| Workflow | Has `# @task <id>` formal header? |
|---|---|
| `arch-boundary-check.yml` | N (inline comment only) |
| `auto-tag-on-release-merge.yml` | **Y** (`# @task T10104`) |
| `boundary-registry-lint.yml` | N |
| `ci.yml` | N |
| `docs-reingest.yml` | N |
| `dual-implementation-lint.yml` | N |
| `freshness-sentinel.yml` | N |
| `identity-pollution-check.yml` | N |
| `lockfile-check.yml` | N |
| `release-pipeline-matrix.yml` | N |
| `release-prepare.yml` | **Y** (`# @task T9781`) |
| `release.yml` | N |
| `skills-council.yml` | N |
| `skills-depth-check.yml` | N |
| `skills-grade.yml` | N |
| `worktree-cleanup.yml` | **Y** (`# @task T9805`, **+ `# @task T10106` added by this PR**) |
| `worktree-napi-prebuild.yml` | N |

**Status:** Per ADR-076 / Saga T9787, the `# @task` annotation is a known-fragile convention. This PR adds the annotation to `worktree-cleanup.yml` for the parity-fix change. The remaining 14 workflows already track ownership via inline comments referencing task IDs (e.g. `T10073`, `T9809`, `T9407`, …) and `git blame`. Standardizing to formal `# @task` headers across all workflows is non-blocking and is documented here as a follow-up.

## Branch Protection

**Finding: `main` is NOT protected at the GitHub level.**

Validation:

```bash
$ gh api repos/kryptobaseddev/cleo/branches/main/protection
{"message":"Branch not protected","status":"404"}

$ gh api repos/kryptobaseddev/cleo/rulesets
[]

$ gh api repos/kryptobaseddev/cleo/rules/branches/main
[]
```

`AGENTS.md` § Release & Branching (ADR-065) declares the required status checks the owner is *expected* to enable:

- `CI`
- `Lockfile Check`
- `Contracts Dep Lint`

But the GitHub Branches API + Rulesets API both return empty. The protection is currently **policy-only**, not enforced by the platform.

**Recommendation:** Owner should run the setup command from `docs/release/branch-protection-setup.md` to convert the policy into an enforced ruleset. Until then, all "required status checks" referenced in this inventory are effectively *advisory*.

### Cross-check: required status checks vs jobs that run on main

Assuming the owner enables the `AGENTS.md`-declared required set:

| Required check (planned) | Workflow / job | Runs on PR→main? | Runs on push→main? | Match? |
|---|---|---|---|---|
| `CI` | `ci.yml` (all 30+ jobs aggregated under workflow name `CI`) | Y | Y | OK |
| `Lockfile Check` | `lockfile-check.yml` / `lockfile-consistency` | Y | Y | OK |
| `Contracts Dep Lint` | `ci.yml` / `contracts-dep-lint` job (workflow name `CI`, job `Contracts Dep Lint`) | Y | Y | OK — but the check name "Contracts Dep Lint" maps to the **job name** inside the `CI` workflow, not a standalone workflow file. Verify the protection rule context string matches the job name exactly when enabled. |

No required-only-on-PR mismatches detected at this time.

## Workflow Trigger Patterns (consolidated — post-T10274)

| Pattern | Workflows |
|---|---|
| `push: [main]` + `pull_request: [main]` | `arch-boundary-check`, `ci`, `dual-implementation-lint`, `boundary-registry-lint`, `identity-pollution-check`, `lockfile-check` |
| `push: [main]` + `pull_request: [main]` (paths-filtered) | `release-pipeline-matrix` (T10274: label gate removed), `skills-depth-check`, `worktree-napi-prebuild` (+ tags) |
| `push: [main]` + `pull_request: closed` | `worktree-cleanup` |
| `pull_request: closed` only | `docs-reingest`, `auto-tag-on-release-merge` (title-filtered) |
| `workflow_dispatch` only | `release-prepare` |
| `push: tags: [v*]` + `workflow_dispatch` | `release` |
| `schedule` + `workflow_dispatch` | `freshness-sentinel`, `skills-council`, `skills-grade` |

After T10274 the inventory collapses to **7 trigger patterns** (down from 10). No
workflow uses a bare `pull_request:` trigger, no workflow uses the dead
`develop` branch filter, and no workflow gates its PR run on a label.

## Duplicate / Overlapping Jobs

### Two `db-open-guard` jobs

| Workflow | Job ID | Job name | Notes |
|---|---|---|---|
| `arch-boundary-check.yml` | `db-open-guard` | DB Open Guard (T10073) | Standalone workflow |
| `ci.yml` | `db-open-guard` | DB Open Chokepoint Guard (ADR-068 T9047) | Inside CI workflow |

**Status: Different scripts** — `arch-boundary-check.yml/db-open-guard` runs `lint-no-direct-db-open.mjs` against `--baseline` mode; `ci.yml/db-open-guard` runs the same script but covers a different scope (ADR-068 baseline). Council recommendation: rename one to avoid the job-name clash for branch-protection rule context strings (e.g. rename the ci.yml job to `db-open-chokepoint`). Filed as informational — NOT blocking.

### Two `canon-drift` jobs in `ci.yml`

| Job ID | Job name |
|---|---|
| `canon-drift` | Canon Drift Check |
| `canon-check` | Canon Drift Check (T9796) |

**Status: Sequential layered check** — first job runs the legacy canon registry lint, second runs T9796's per-DocKind enforcement (added by Saga T9787). Both intentional. Council recommendation: rename `canon-drift` → `canon-drift-legacy` to make the layering explicit. Filed as informational — NOT blocking.

### `boundary-registry-lint.yml` vs `dual-implementation-lint.yml`

Both consume `@cleocode/contracts/dist/boundary.js`. They check distinct invariants:

- `boundary-registry-lint` — registry-vs-filesystem parity (T10198)
- `dual-implementation-lint` — Rust+TS duplicate-implementation detection (T10199)

**Intentional — different invariants, intentionally separate workflows so failures are diagnosable independently.**

## Follow-ups (filed elsewhere)

- **T10102** — full 17-workflow inventory + dedup (this doc is the input).
- **Future** — convert AGENTS.md branch-protection policy into an enforced ruleset via the GitHub UI or API. Owner action.
- **Future** — standardize `# @task <id>` annotation headers across all 16 workflows. Non-blocking.
- **Future** — disambiguate the two `db-open-guard` job names so branch-protection rule context strings are unambiguous. Non-blocking.

## How this document is maintained

Regenerate this matrix whenever:

1. A workflow file is added, removed, or renamed in `.github/workflows/`.
2. A workflow's `on:` triggers, `paths:` filters, or `if:` conditions change.
3. Branch protection / rulesets are added, removed, or modified.

The inventory script lives at `scripts/build-ci-job-inventory.mjs` (future T10102 deliverable). Until that lands, regenerate by hand from the workflow YAMLs + `gh api repos/<owner>/<repo>/branches/<branch>/protection`.
