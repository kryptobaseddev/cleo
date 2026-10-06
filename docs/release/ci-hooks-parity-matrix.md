# CI hooks parity matrix and branch-protection map

Task: T10475
Observed: 2026-05-25T03:08:25Z
Repository: `kryptobaseddev/cleo`
Default branch: `main`

## Question

What CI/hook surfaces run on PR, main, dev, tag, cron, and manual dispatch paths, and which of those surfaces are shipped CLEO consumer tooling, cleocode dogfood-only workflows, or shared product/repo surfaces?

## Sources

- `.github/workflows/*.yml`
- `packages/core/templates/workflows/*.yml.tmpl`
- `docs/release/branch-protection-setup.md`
- `AGENTS.md` release and branch-protection section
- `gh repo view --json nameWithOwner,defaultBranchRef`
- `gh api repos/:owner/:repo/branches/main/protection`

## Taxonomy used by T10468

| Class | Meaning | Owner expectation |
| --- | --- | --- |
| Shipped consumer tooling | Code/templates installed or exercised by CLEO users outside this repo, primarily `cleo release *` and workflow templates under `packages/core/templates/workflows/`. | Must avoid cleocode-only assumptions and must be documented/tested as product behavior. |
| Cleocode dogfood-only repo workflow | GitHub Actions, lints, schedules, and hygiene checks that protect this repository or the CLEO team operating model. | Can encode cleocode-specific policy, but must not be presented as a consumer contract. |
| Shared surface | A repo workflow or gate that dogfoods product invariants or publishes the CLEO artifact users consume. | Document both roles: the workflow instance is repo-local, while the invariant or artifact path is product-relevant. |

## Trigger parity summary

Legend: yes = configured trigger; path = configured but path-filtered; n/a = intentionally not a trigger for that surface; via CI = a reusable workflow called from `ci.yml`, so it runs on CI's triggers and the required `CI` aggregate needs it (T13263).

| Surface | File | Class | PR to main | Push to main | Dev branch | Tag | Cron | Manual dispatch | Merge queue | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CI | `.github/workflows/ci.yml` | Cleocode dogfood-only, with shared quality signal | yes | yes | no | no | no | no | yes | Broad repo gate; check name `CI` is branch-protection candidate. |
| Lockfile Check | `.github/workflows/lockfile-check.yml` | Shared | via CI | via CI | no | no | via CI | via CI | via CI | Consumer-relevant invariant for reproducible installs. Called from `ci.yml` (job `lockfile-gate`) since T13279; its check reports as `Lockfile Check / Verify pnpm-lock.yaml consistency`, covered by `CI`. |
| Arch Boundary Check | `.github/workflows/arch-boundary-check.yml` | Cleocode dogfood-only | via CI | via CI | no | no | via CI | via CI | via CI | Repo architecture guard; not a shipped template. Since T13263 a reusable workflow called from `ci.yml` (job `arch-gates`), so `CI` requires it. |
| Boundary Registry Lint | `.github/workflows/boundary-registry-lint.yml` | Cleocode dogfood-only | via CI | via CI | no | no | via CI | via CI | via CI | Registry hygiene gate for this monorepo. Called from `ci.yml` since T13263. |
| Dual Implementation Lint | `.github/workflows/dual-implementation-lint.yml` | Cleocode dogfood-only | via CI | via CI | no | no | via CI | via CI | via CI | Prevents duplicated implementation drift in this repo. Called from `ci.yml` since T13263. |
| Identity Pollution Check | `.github/workflows/identity-pollution-check.yml` | Shared | via CI | via CI | no | no | via CI | via CI | via CI | Protects shipped artifacts from cleocode identity leakage. Called from `ci.yml` since T13263. |
| Skills Depth Check | `.github/workflows/skills-depth-check.yml` | Shared | path | yes | no | no | no | no | yes | Validates packaged skill-depth invariants. |
| Worktree Cleanup | `.github/workflows/worktree-cleanup.yml` | Cleocode dogfood-only | yes | yes | no | no | no | no | yes | Cleans orphaned CLEO worktrees for this repository. |
| Docs Re-ingest | `.github/workflows/docs-reingest.yml` | Cleocode dogfood-only | closed PR only | no | no | no | no | no | yes | Runs after PR merge to refresh repo docs/search state. |
| Release Pipeline Matrix | `.github/workflows/release-pipeline-matrix.yml` | Shared | path | path | no | no | no | no | yes | Dogfood CI instance for shipped release-pipeline scenarios; 32 scenario matrix. |
| Release Readiness | `.github/workflows/release-readiness.yml` | Shared release dogfood | yes | no | no | no | no | no | yes | PR/merge-queue readiness gate for release PR state and release-note provenance. |
| worktree-napi prebuild | `.github/workflows/worktree-napi-prebuild.yml` | Shared | path | path | no | no (via `release.yml` `workflow_call`) | no | yes | yes | Builds/tests the native binaries bundled into `@cleocode/worktree`. Not tag-triggered: `release.yml` calls it (`workflow_call`) on `v*`, and it restores binaries cached by native source hash (warmed by main pushes). |
| Auto-Tag on Release Merge | `.github/workflows/auto-tag-on-release-merge.yml` | Shared release dogfood | closed PR only | no | no | no | no | no | yes | Tags merge commit after release PR merge; repo instance validates release invariant. |
| Release | `.github/workflows/release.yml` | Shared artifact publishing | no | no | no | yes (`v*`) | no | yes | no | Publishes shipped CLEO packages from tags; also has GitHub Release creation job. |
| Release Prepare | `.github/workflows/release-prepare.yml` | Shared release dogfood | no | no | no | no | no | yes | no | Repo-local instance of shipped release-prepare flow. |
| Freshness Sentinel | `.github/workflows/freshness-sentinel.yml` | Cleocode dogfood-only | no | no | no | no | yes (`0 6 * * *`) | yes | no | Scheduled repo freshness/hygiene check. |
| Skills Council | `.github/workflows/skills-council.yml` | Cleocode dogfood-only | no | no | no | no | yes (`0 6 * * 0`) | yes | no | Owner CI for canonical skills review. |
| Skills Grade | `.github/workflows/skills-grade.yml` | Cleocode dogfood-only | no | no | no | no | yes (`0 7 * * 1`) | yes | no | Owner CI for grading canonical skills. |

## Shipped consumer workflow-template map

These are product surfaces because consumers can receive or model them from CLEO templates under `packages/core/templates/workflows/`.

| Template | Trigger parity | Consumer contract |
| --- | --- | --- |
| `release-prepare.yml.tmpl` | `workflow_dispatch` only | Manual/CLI-dispatched release branch + PR opener. No PR/main/tag/cron trigger by design. |
| `release-publish.yml.tmpl` | push to `main` on version-file paths + `workflow_dispatch` | Publishes only release-prepare commits or explicit manual re-runs; no PR/dev/tag/cron trigger. |
| `release-fanout.yml.tmpl` | GitHub `release: published` | Downstream fanout starts only after a published GitHub Release, not draft creation. |
| `release-rollback.yml.tmpl` | `workflow_dispatch` only | Explicit operator rollback. No automatic PR/main/tag/cron trigger. |

## Branch-protection map

### Desired protection command in-tree

`docs/release/branch-protection-setup.md` and `AGENTS.md` currently document this desired `main` protection policy:

| Protection dimension | Desired value | Rationale |
| --- | --- | --- |
| Required status checks | `CI`, `Contracts Dep Lint` | Minimum merge gate: `CI` now includes the frozen-lockfile check and every gating workflow (T13263, T13279), plus the package-boundary lint. |
| Strict required checks | `false` | Owner decision 2026-09-29: a PR merges once its own `CI` is green; main-push CI catches combination breaks. |
| Pull-request reviews | `required_approving_review_count=0` | Allows bot-driven release PR merges after checks pass. |
| Admin enforcement | `false` | Emergency owner bypass remains possible and must be audit-logged. |
| Restrictions | `null` | No additional actor/team push restrictions beyond status checks. |

### Observed GitHub protection state

Command run from this worktree:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh api repos/:owner/:repo/branches/main/protection --jq '{required_status_checks:.required_status_checks.contexts, strict:.required_status_checks.strict, enforce_admins:.enforce_admins.enabled, required_reviews:.required_pull_request_reviews.required_approving_review_count, restrictions:.restrictions}'
```

> **Current state (2026-10-05, T13263 / T13279):** live branch protection requires only `CI` (`strict=false`). The arch gates, Lockfile Check and the other gating workflows run INSIDE `CI` (reusable workflows its aggregate needs). Do NOT require a `Lockfile Check` or `Arch Boundary Check` context: neither reports under that name, so requiring it blocks every merge. The canonical command is in `AGENTS.md` and `docs/release/branch-protection-setup.md` (`CI` + `Contracts Dep Lint`).

Historical observed result on 2026-05-25T03:08:25Z: repository `kryptobaseddev/cleo` default branch is `main`; GitHub reports `main` is protected with strict required status checks `CI`, `Lockfile Check`, and `Contracts Dep Lint`, zero required approving reviews, admin enforcement disabled, no push restrictions, force pushes disabled, and deletions disabled.

### Check-name reconciliation

| Documented required context | Backing workflow/job status in this tree | Status |
| --- | --- | --- |
| `CI` | Workflow name in `.github/workflows/ci.yml` is `CI`; jobs include `typecheck`, `unit-tests`, `build-verify`, and many lints. | Present. |
| ~~`Lockfile Check`~~ | The workflow is named `Lockfile Check`, but its check reports under its job name (`Verify pnpm-lock.yaml consistency`), and since T13279 it runs inside `CI` (`Lockfile Check / Verify pnpm-lock.yaml consistency`). | Not a context: covered by `CI`. Do not require it. |
| `Contracts Dep Lint` | No `.github/workflows/contracts-dep-lint.yml` exists; the live GitHub branch-protection API now reports `Contracts Dep Lint` as an installed required context (`app_id=15368`). `ci.yml` also contains job `contracts-dep-lint` as repo-local parity coverage. | Reconciled; keep the exact live context string unless future `gh pr checks <pr>` evidence proves the emitted check name changed. |

## Findings

1. PR/main parity is broadly present for repo hygiene gates: most always-on dogfood workflows trigger on both `pull_request` to `main` and `push` to `main`, plus `merge_group` for merge-queue parity.
2. No workflow in this tree targets a `dev` branch. The documented branch model is currently main-centric; adding `dev` would require explicit branch filters and branch-protection updates.
3. Tag triggers are intentionally limited to product publishing: only `release.yml` triggers on `v*`. The native builds (`worktree-napi-prebuild.yml`, `cant-napi-build.yml`) run inside the release through `workflow_call`, not on the tag themselves.
4. Cron triggers are intentionally owner/dogfood-only: freshness sentinel, skills council, and skills grade.
5. Dispatch-only workflows are either shipped release operations (`release-prepare`, release template operations) or owner maintenance operations; dispatch is not a substitute for PR/main gates.
6. The current live GitHub `main` branch protection now matches the in-tree desired protection document for required contexts, strictness, review count, admin enforcement, and push restrictions.
7. The required-context list in `docs/release/branch-protection-setup.md` is reconciled to live state: `Contracts Dep Lint` is a valid installed required context in branch protection even though the tree also carries a repo-local `ci.yml` job named `contracts-dep-lint`.
