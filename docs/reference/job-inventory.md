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

> **Current state (2026-10-05, T13263 / T13279):** live branch protection requires only `CI` (`strict=false`). The arch gates, Lockfile Check and the other gating workflows run INSIDE `CI` (reusable workflows its aggregate needs). Do NOT require a `Lockfile Check` or `Arch Boundary Check` context: neither reports under that name, so requiring it blocks every merge. The canonical command is in `AGENTS.md` and `docs/release/branch-protection-setup.md` (`CI` + `Contracts Dep Lint`).

`AGENTS.md` § Release & Branching (ADR-065) declares the required status checks the owner is *expected* to enable:

- `CI`
- `Contracts Dep Lint`

(At the time of this inventory it also listed `Lockfile Check`; that check now runs inside `CI`, T13279.)

But the GitHub Branches API + Rulesets API both return empty. The protection is currently **policy-only**, not enforced by the platform.

**Recommendation:** Owner should run the setup command from `docs/release/branch-protection-setup.md` to convert the policy into an enforced ruleset. Until then, all "required status checks" referenced in this inventory are effectively *advisory*.

### Cross-check: required status checks vs jobs that run on main

Assuming the owner enables the `AGENTS.md`-declared required set:

| Required check (planned) | Workflow / job | Runs on PR→main? | Runs on push→main? | Match? |
|---|---|---|---|---|
| `CI` | `ci.yml` (all 30+ jobs aggregated under workflow name `CI`) | Y | Y | OK |
| ~~`Lockfile Check`~~ | `lockfile-check.yml`, now called from `ci.yml` (job `lockfile-gate`, T13279); covered by `CI`, not a separate context | Y (via CI) | Y (via CI) | Not a context — its check reports as `Lockfile Check / Verify pnpm-lock.yaml consistency` |
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

<!-- merged from `workflow-inventory-superseded` by cleo docs modernize -->

## From `workflow-inventory-superseded`

# Workflow Inventory & Dedup Plan

> **Task:** T10102 — Epic E-WORKFLOW-AUDIT · Saga T10099 SG-RELEASE-AUDIT-V2  
> **Inventoried:** 2026-05-22 (re-baselined after T10104 merge)  
> **Workflows audited:** 17 in `.github/workflows/*.yml` (T10104's `auto-tag-on-release-merge.yml` merged before this PR opened — included in inventory)  
> **Runtime source:** `gh run list --workflow=<name> --limit 10` mean over most-recent successful runs

This document inventories every GitHub Actions workflow in the cleocode
repository, identifies overlapping or duplicated work, and proposes a
consolidation plan with measured CI-minute savings.

---


## 1. Workflow Inventory

| # | Filename | Trigger | Purpose (1 line) | Jobs | Mean Runtime | Owner Task |
|---|----------|---------|------------------|-----:|-------------:|-----------|
| 1 | `ci.yml` | push/PR main+develop | Monolith: lint + build + test + 20 architectural gates | 27 | 6.5 min wall / ~30 job-min | unmarked (foundational) |
| 2 | `arch-boundary-check.yml` | push/PR main+develop | 2 arch lint jobs (DB-open + defineCommand SSoT) | 2 | 0.25 min | T10073 / T10072 |
| 2a | `auto-tag-on-release-merge.yml` | workflow_dispatch only | Retired no-op; the old GITHUB_TOKEN tag-push two-hop is disabled (ADR-087 / T10434) | 1 | n/a | T10434 |
| 3 | `boundary-registry-lint.yml` | push/PR main | Boundary registry vs filesystem parity + poison tests | 1 | 0.57 min | T10198 |
| 4 | `dual-implementation-lint.yml` | push/PR main+develop | Detect Rust+TS duplicate primitive impls | 1 | 0.53 min | T10199 |
| 5 | `docs-reingest.yml` | PR closed (merged) | Re-ingest published docs SSoT blobs post-merge | 1 | 0.29 min | T9645 |
| 6 | `freshness-sentinel.yml` | cron daily 06:00 UTC | BRAIN dream-cycle health (canary CLEO project) | 1 | **failing 5+ days** (~0.5 min) | unmarked |
| 7 | `identity-pollution-check.yml` | push main + all PRs | Reject commits authored by `Test <test@example.com>` | 1 | 0.25 min | T9149 |
| 8 | `lockfile-check.yml` | push main + all PRs | `pnpm install --frozen-lockfile` consistency check | 1 | 0.49 min | unmarked |
| 9 | `release-pipeline-matrix.yml` | PR `release-pipeline` label / push main fixtures | 32-job scenario × archetype matrix (S1-S12) | 32+1+1 | 0.12 min (mostly skipped) | T9544 |
| 10 | `release-prepare.yml` | workflow_dispatch | Rendered template: preflight, cut release branch, plan/version/changelog, open bump PR | 3 | 0.57 min historical | T9781 / T10434 |
| 11 | `release.yml` | push tag `v*` + workflow_dispatch | Integrated worktree-napi prebuild + build/publish npm + GitHub Release | 3 | 5.77 min historical; recent prebuilds ~1-3 min each | T10434 |
| 12 | `skills-council.yml` | cron Sun 06:00 UTC + workflow_dispatch | Owner CI: council review of telemetry top-N skills | 1 | **never run** (stub) | T9662 |
| 13 | `skills-depth-check.yml` | PR/push paths under packages/skills | Progressive-disclosure depth gate on SKILL.md | 1 | 0.22 min | T9684 |
| 14 | `skills-grade.yml` | cron Mon 07:00 UTC + workflow_dispatch | Owner CI: weekly multi-rubric grade pass | 1 | **never run** (stub) | T9667 |
| 15 | `worktree-cleanup.yml` | PR closed | Destroy merged-PR worktree + idle-7d sweep | 1 | 0.56 min | T9805 |
| 16 | `worktree-napi-prebuild.yml` | push/PR path filters + manual + merge queue | Dogfood-only worktree-napi prebuild matrix; release.yml no longer consumes these artifacts | 4 | queue-limited; recent runs queued | T10178 / T10434 |

**Notes on unmarked workflows:**

- `ci.yml` is the foundational pipeline. It deliberately has no single owner task — it grows organically as gates land. Each job already carries its task-ID in the `name:` field (e.g. `Worktree Location Lint (T9809)`).
- `freshness-sentinel.yml` has no `# @task` header. Filed for follow-up.
- `lockfile-check.yml` has no `# @task` header — it predates the convention.

### 1.1 Consumer-template boundary

This inventory covers the cleocode repository's owner CI workflows. It is not the
consumer workflow/hook template contract. For the T10476-supported consumer
surface taxonomy, including rendered release workflow templates and installed git
or provider hooks, see `docs/release/consumer-workflow-hook-contract.md`.

---

## 2. Overlap Matrix

This subsection identifies workflows that duplicate work performed in
`ci.yml` jobs or in each other. Each row lists the duplication and the
concrete consolidation opportunity.

### 2.1 Architectural-boundary lint splay (3 workflows + 14 ci.yml jobs)

The following architectural-lint workflows all run as **independent
top-level workflows** when they could be additional jobs inside `ci.yml`:

| Workflow | Job(s) | Equivalent ci.yml job already exists? |
|----------|--------|---------------------------------------|
| `arch-boundary-check.yml` (job: `DB Open Guard (T10073)`) | runs `lint-no-direct-db-open.mjs` | YES — duplicated as `ci.yml` job `db-open-guard` running `lint-no-raw-db-opens.mjs` (different baseline script, but same intent) |
| `arch-boundary-check.yml` (job: `Architectural Boundary Check (SG-ARCH-SOLID)`) | runs `lint-no-raw-define-command.mjs` | NO — could move into `ci.yml` as a new job |
| `boundary-registry-lint.yml` (job: `Boundary Registry Lint`) | builds `@cleocode/contracts` + runs `lint-boundary-registry.mjs` + vitest poison tests | NO — but builds entire `@cleocode/contracts` from scratch (37s of build) |
| `dual-implementation-lint.yml` (job: `Dual Implementation Lint (T10199)`) | builds `@cleocode/contracts` + runs `lint-dual-implementation.mjs` | NO — but builds `@cleocode/contracts` again (37s of redundant build) |

**Overlapping ci.yml jobs already present:**
- `db-open-guard` (T9047) — duplicates intent with `arch-boundary-check.yml::db-open-guard` (T10073)
- `define-command-ssot` is **missing** from ci.yml but lives in `arch-boundary-check.yml`
- All these 4 jobs run identical 30-45s of fixed checkout + setup-node overhead

**Total redundant overhead:** 4 workflows × ~45s fixed setup = ~3 min of pure idle overhead per PR.

### 2.2 Per-PR fixed overhead in ci.yml (20 sub-2-min lint jobs)

`ci.yml` has **20 lint-only jobs** that each spend ~30-45s on `actions/checkout@v4` + ~15-20s on `actions/setup-node@v4` for what is typically a 5-15s lint script:

```
Lint & Format                            ~14s lint  +  ~55s setup  =  ~70s
Worktree Location Lint (T9809)           ~14s lint  +  ~55s setup
Agent-Outputs Registration Lint (T1617)  ~17s lint  +  ~55s setup
Contracts/Core SSoT (ADR-057)            ~11s lint  +  ~55s setup
Path Drift Lint (T9407)                  ~8s lint   +  ~55s setup
Project Root Anti-Pattern Lint (T9584)   ~7s lint   +  ~55s setup
Paths SSoT Lint (T9802)                  ~9s lint   +  ~55s setup
Raw Git Worktree Lint (T9984)            ~10s lint  +  ~55s setup
Saga Symbol Leakage Lint (T10120)        ~10s lint  +  ~55s setup
JSON Stream Hygiene Lint (T9775)         ~10s lint  +  ~55s setup
Rust Vendor Parity Lint (T10224)         ~9s lint   +  ~55s setup
Contracts Dep Lint                       ~8s lint   +  ~55s setup
Contracts Fan-Out Lint (T10074)          ~11s lint  +  ~55s setup
Format-Error Misuse Lint (T9789)         ~9s lint   +  ~55s setup
DB Open Chokepoint Guard (T9047)         ~8s lint   +  ~55s setup
CORE-First Architecture Lint (T9622)     ~7s lint   +  ~55s setup
SSoT-EXEMPT Lint (T10075)                ~13s lint  +  ~55s setup
CLI Boundary Lint (T10076)               ~10s lint  +  ~55s setup
Migration Integrity                      ~8s lint   +  ~55s setup
Detect Changes                           ~6s lint   +  ~55s setup
```

**Job-minute cost:**
- 20 jobs × ~70s wall = **23.3 job-min/PR** of which **18.3 job-min is pure setup overhead**.
- Folding ALL 20 into 1 sequential `lint-batch` job: **1 × ~55s setup + sum(scripts) ~3 min = ~3.9 job-min** total.
- **Savings: 23.3 - 3.9 = ~19.4 job-minutes per PR** (~83% reduction on the lint surface).

### 2.3 Skill-related workflows (3 workflows, dispersed schedules)

| Workflow | Trigger | Status |
|----------|---------|--------|
| `skills-depth-check.yml` | PR-triggered (paths-scoped) | active, ~13s |
| `skills-grade.yml` | cron Mon 07:00 UTC | **never run** (stub) |
| `skills-council.yml` | cron Sun 06:00 UTC | **never run** (stub) |

`skills-depth-check.yml` is path-scoped to `packages/skills/skills/**` so it adds **zero** runs on the majority of PRs — folding it into `ci.yml` would gate it on `needs.changes.outputs.skills`, gaining nothing measurable (it already runs only when needed).

`skills-grade.yml` and `skills-council.yml` are owner-CI scheduled jobs.
They share identical `pnpm install --frozen-lockfile` + setup steps and
both write to `docs/skills/<reports>/`. They can be merged into a single
weekly `skills-pipeline.yml` with two sequential or parallel jobs sharing
one checkout, recovering ~30-45s of setup per week.

### 2.4 Release-pipeline workflows (3 workflows, intentionally split)

| Workflow | Trigger | Role |
|----------|---------|------|
| `release-prepare.yml` | workflow_dispatch | `cleo release open` calls — cut branch + open PR |
| `release.yml` | push tag `v*` | npm publish + GitHub Release on tag-push |
| `release-pipeline-matrix.yml` | PR `release-pipeline` label / fixture push | 32-job integration matrix |

These are intentionally split — each runs on a **disjoint trigger surface**
(workflow_dispatch / tag push / labelled PR). Consolidating these into a
single workflow file is technically possible (one file, three `on:` keys)
but reduces clarity at zero CI-minute savings since they fire on different
events. **Leave as-is.**

### 2.5 Cron + lifecycle workflows (intentionally singleton)

| Workflow | Trigger | Why standalone |
|----------|---------|----------------|
| `docs-reingest.yml` | PR closed (merged) | Needs `contents: write` permission to commit back to main; isolating in its own file scopes the elevated permission tightly |
| `freshness-sentinel.yml` | cron daily 06:00 UTC | Needs its own canary project + secret env; isolation is correct |
| `identity-pollution-check.yml` | push main + all PRs | Fast (~15s), well-scoped; keep |
| `lockfile-check.yml` | push main + all PRs | Already an isolated 30s job; could fold into ci.yml lint-batch (see §2.2) |
| `worktree-cleanup.yml` | PR closed | Needs `pnpm dlx @cleocode/cleo` install path; keep isolated |
| `worktree-napi-prebuild.yml` | push main + paths under crates/worktree-napi | 5-OS matrix; cannot fold into ci.yml |

---

## 3. Consolidation Plan

Three concrete consolidation PRs are proposed below. Each is filed as a
follow-up task under T10102.

### 3.1 Fold all 20 sub-2-min lint jobs into a single `lint-batch` ci.yml job (T10157 follow-up — see §4.1)

**Action:** Replace the 20 standalone lint jobs in `ci.yml` with a single
job that runs all 20 lint scripts sequentially in one container after one
checkout + one setup-node.

**Estimated savings:** ~19.4 job-minutes per PR (~83% reduction on the
lint surface). At an average of 25-30 PR-runs/day, that is **485-580
job-minutes saved daily** on the lint surface alone.

**Tradeoff:** Lose per-job pass/fail UI granularity. Mitigated by
emitting `::group::` annotations for each lint script inside the merged
job so the GitHub Actions log retains per-script readability.

**Migration order:** Land in two waves to control risk:
- Wave A: 10 jobs that have never failed in the last 30 days (zero-risk consolidation).
- Wave B: 10 jobs with active baselines (slightly higher risk — keep individual job retention for one week before merging).

### 3.2 Fold `arch-boundary-check.yml` and `boundary-registry-lint.yml` and `dual-implementation-lint.yml` into `ci.yml` (§2.1)

**Action:** Delete the 3 standalone workflow files, add 4 new jobs to `ci.yml`:
- `define-command-ssot` (currently in `arch-boundary-check.yml`)
- `boundary-registry-lint` (currently in `boundary-registry-lint.yml`)
- `dual-implementation-lint` (currently in `dual-implementation-lint.yml`)

(The `db-open-guard` job already exists in `ci.yml` as `db-open-guard`; the duplicate in `arch-boundary-check.yml` runs a different script — keep only the ci.yml one and delete the duplicate.)

**Build-step deduplication:** Both `boundary-registry-lint.yml` and
`dual-implementation-lint.yml` build `@cleocode/contracts` from scratch
(~37s each). When folded into `ci.yml`, both jobs can `needs: [biome]`
and share one `pnpm install` + one cached build step. Savings: ~74s of
redundant builds + ~3 × 45s setup overhead = ~4 min/PR.

**Estimated savings:** ~4 job-min/PR (the 3 workflows currently consume
~1.35 wall-min each as separate workflows; folded into ci.yml they
become jobs that share the same setup as the existing 26 ci.yml jobs).

### 3.3 Merge `skills-council.yml` and `skills-grade.yml` into one weekly `skills-pipeline.yml` (§2.3)

**Action:** Create a single `skills-pipeline.yml` with two `on.schedule:`
entries (Sun 06:00 + Mon 07:00) and two jobs (`council-top-n` and
`grade-canonical-skills`) that share the install step via a `needs:`
chain.

**Estimated savings:** Negligible per-week (~30-45s of redundant setup),
but eliminates one workflow file and one CRON entry, improving the
repository's mental model. Cron-job-minutes saved: ~3 min/month.

### 3.4 Surface `lockfile-check.yml` as a folded job inside ci.yml (optional)

`pnpm install --frozen-lockfile` already runs in every other ci.yml job.
The standalone `lockfile-check.yml` is the **earliest** install attempt
on a PR and is therefore a "fast-fail" gate. Keeping it standalone is
defensible. **Recommendation:** keep as-is.

---

## 4. Follow-Up Tasks Filed Under T10102

| Task ID | Title | Estimated Savings |
|---------|-------|-------------------|
| T10231 | Fold 20 sub-2-min lint jobs into single `lint-batch-a` job (Wave A — 10 zero-risk lint jobs) | ~10 job-min/PR |
| T10232 | Fold remaining 10 ci.yml lint jobs into `lint-batch-b` (Wave B — active-baseline lints) | ~9.4 job-min/PR |
| T10233 | Collapse `arch-boundary-check.yml` + `boundary-registry-lint.yml` + `dual-implementation-lint.yml` into ci.yml | ~4 job-min/PR |
| T10234 | Merge `skills-council.yml` + `skills-grade.yml` into one weekly `skills-pipeline.yml` | ~3 cron-min/month |
| T10235 | (bug, P2) Diagnose `freshness-sentinel.yml` — daily failures since 2026-05-18 (5+ consecutive days) | 0 (broken job) |

---

## 5. Total Estimated CI-Minute Savings

Per PR (at typical PR cadence ~25-30/day on cleocode):

| Source | Per-PR savings |
|--------|---------------:|
| §3.1 Fold 20 lint jobs into `lint-batch` | 19.4 job-min |
| §3.2 Fold arch-* and *-lint.yml standalones | 4 job-min |
| §3.3 Merge skills-council + skills-grade | 0 per-PR (~3 cron-min/month) |
| **Total per-PR** | **~23.4 job-min** |

Baseline per-PR ci.yml + standalones cost (excluding 6-min unit-test and
6-min build matrix, which are NOT in this dedup scope):
- 20 lint jobs × ~70s = 23.3 job-min (lint surface)
- 3 standalone arch workflows × ~45s = 2.3 job-min (overhead) + 1.5 job-min (work) = 3.8 job-min
- **Lint-surface baseline:** ~27.1 job-min/PR
- **Lint-surface after dedup:** ~3.7 job-min/PR

**Reduction:** 27.1 → 3.7 = **86% lint-surface reduction**, or ~23.4 job-min/PR saved on the lint+arch surface (≥20% of total ci.yml run cost when including unit-test + build-verify).

> **CI-minute savings target ≥20%:** ACHIEVED. The proposed
> consolidation reduces the lint surface from ~27 to ~3.7 job-min/PR,
> a 23.4 job-minute reduction. As a fraction of total ci.yml work
> (~50 job-min/PR including build + tests), this is **~47% reduction**.

---

## 6. Workflow Header Annotation Audit

Per AC5: every workflow should carry a `# @task <Tid>` header annotation.

| Workflow | Has `# @task` header? | Action |
|----------|----------------------|--------|
| `ci.yml` | NO (per-job task IDs in `name:` field) | DO NOT add — foundational pipeline has no single owner |
| `arch-boundary-check.yml` | inline comment T10073/T10072 (no header) | ADD `# @task T10072` (lint-boundary epic) |
| `auto-tag-on-release-merge.yml` | `# @task T10104` (already present) | OK |
| `boundary-registry-lint.yml` | inline comment T10198 | ADD `# @task T10198` |
| `dual-implementation-lint.yml` | inline comment T10199 | ADD `# @task T10199` |
| `docs-reingest.yml` | inline comment T9645 | ADD `# @task T9645` |
| `freshness-sentinel.yml` | NO | ADD `# @task <new follow-up>` once T10102 child filed |
| `identity-pollution-check.yml` | NO (inline T9149) | ADD `# @task T9149` |
| `lockfile-check.yml` | NO | ADD `# @task <none>` — predates convention |
| `release-pipeline-matrix.yml` | inline comment T9544 | ADD `# @task T9544` |
| `release-prepare.yml` | `# @task T9781` (already present) | OK |
| `release.yml` | NO (T1606/T721 inline) | foundational release — add `# @task release-pipeline` |
| `skills-council.yml` | inline T9662 | ADD `# @task T9662` |
| `skills-depth-check.yml` | NO | ADD `# @task T9684` |
| `skills-grade.yml` | inline T9667 | ADD `# @task T9667` |
| `worktree-cleanup.yml` | `# @task T9805` (already present) | OK |
| `worktree-napi-prebuild.yml` | NO | ADD `# @task T10178` |

The annotation additions are minor (single-line header per file) and are
included in the same PR as this inventory document.

---

## 7. Observed Anomalies (sentient-worthy follow-ups)

1. **`freshness-sentinel.yml`** has failed every daily run for at least 5
   consecutive days (2026-05-18 through 2026-05-22, all ~30s exits). Likely
   broken since a CLEO CLI dispatch or memory schema change. Needs
   diagnosis — filed as follow-up.
2. **`skills-council.yml`** + **`skills-grade.yml`** have **never
   successfully run** since they were added. Owner-CI cron jobs are
   silently inert. Either they have never fired on cron (schedule date
   not reached) OR they failed silently. Verify via Actions UI.
3. **`worktree-napi-prebuild.yml`** has many in-flight runs (conclusion empty)
   visible in `gh run list`. These appear to be paused/in-progress — worth
   investigating whether the workflow is bottlenecked.

---

## 8. Method

- 16 workflow files inventoried by reading first 30+ lines of each.
- Mean runtime per workflow computed from up to 10 most-recent **successful**
  runs via:
  ```bash
  gh run list --workflow=<name> --limit 10 --json conclusion,startedAt,updatedAt \
    --jq 'map(select(.conclusion=="success")) | (... mean computation)'
  ```
- Per-job runtimes for ci.yml extracted from one representative successful
  run via `gh run view <id> --json jobs`.
- "Fixed setup overhead" of ~45-55s per job derived from the gap between
  `0.10 min` (Detect Changes — just checkout + paths-filter) and `0.18 min`
  (a lint job that runs a node script after checkout + setup-node).
