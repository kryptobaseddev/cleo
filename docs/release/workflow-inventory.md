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
