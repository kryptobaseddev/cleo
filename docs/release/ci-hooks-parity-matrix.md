# CI hooks parity matrix and branch-protection map

Task: T10475
Observed: 2026-05-24T20:10:34Z
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

Legend: yes = configured trigger; path = configured but path-filtered; n/a = intentionally not a trigger for that surface.

| Surface | File | Class | PR to main | Push to main | Dev branch | Tag | Cron | Manual dispatch | Merge queue | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CI | `.github/workflows/ci.yml` | Cleocode dogfood-only, with shared quality signal | yes | yes | no | no | no | no | yes | Broad repo gate; check name `CI` is branch-protection candidate. |
| Lockfile Check | `.github/workflows/lockfile-check.yml` | Shared | yes | yes | no | no | no | no | yes | Consumer-relevant invariant for reproducible installs; check name `Lockfile Check`. |
| Arch Boundary Check | `.github/workflows/arch-boundary-check.yml` | Cleocode dogfood-only | yes | yes | no | no | no | no | yes | Repo architecture guard; not a shipped template. |
| Boundary Registry Lint | `.github/workflows/boundary-registry-lint.yml` | Cleocode dogfood-only | yes | yes | no | no | no | no | yes | Registry hygiene gate for this monorepo. |
| Dual Implementation Lint | `.github/workflows/dual-implementation-lint.yml` | Cleocode dogfood-only | yes | yes | no | no | no | no | yes | Prevents duplicated implementation drift in this repo. |
| Identity Pollution Check | `.github/workflows/identity-pollution-check.yml` | Shared | yes | yes | no | no | no | no | yes | Protects shipped artifacts from cleocode identity leakage. |
| Skills Depth Check | `.github/workflows/skills-depth-check.yml` | Shared | path | yes | no | no | no | no | yes | Validates packaged skill-depth invariants. |
| Worktree Cleanup | `.github/workflows/worktree-cleanup.yml` | Cleocode dogfood-only | yes | yes | no | no | no | no | yes | Cleans orphaned CLEO worktrees for this repository. |
| Docs Re-ingest | `.github/workflows/docs-reingest.yml` | Cleocode dogfood-only | closed PR only | no | no | no | no | no | yes | Runs after PR merge to refresh repo docs/search state. |
| Release Pipeline Matrix | `.github/workflows/release-pipeline-matrix.yml` | Shared | path | path | no | no | no | no | yes | Dogfood CI instance for shipped release-pipeline scenarios; 32 scenario matrix. |
| worktree-napi prebuild | `.github/workflows/worktree-napi-prebuild.yml` | Shared | path | path | no | yes (`v*`) | no | yes | yes | Builds/tests native prebuild artifacts for shipped `@cleocode/worktree-napi`. |
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
| Required status checks | `CI`, `Lockfile Check`, `Contracts Dep Lint` | Minimum merge gate for broad test/build, frozen lockfile, and package-boundary lint. |
| Strict required checks | `true` | PR branch must be up-to-date with `main` before merge. |
| Pull-request reviews | `required_approving_review_count=0` | Allows bot-driven release PR merges after checks pass. |
| Admin enforcement | `false` | Emergency owner bypass remains possible and must be audit-logged. |
| Restrictions | `null` | No additional actor/team push restrictions beyond status checks. |

### Observed GitHub protection state

Command run from this worktree:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh api repos/:owner/:repo/branches/main/protection --jq '{required_status_checks:.required_status_checks.contexts, strict:.required_status_checks.strict, enforce_admins:.enforce_admins.enabled, required_reviews:.required_pull_request_reviews.required_approving_review_count, restrictions:.restrictions}'
```

Observed result: repository `kryptobaseddev/cleo` default branch is `main`; GitHub returned `404 Branch not protected` for `main` at observation time.

### Check-name reconciliation

| Documented required context | Backing workflow/job status in this tree | Status |
| --- | --- | --- |
| `CI` | Workflow name in `.github/workflows/ci.yml` is `CI`; jobs include `typecheck`, `unit-tests`, `build-verify`, and many lints. | Present. |
| `Lockfile Check` | Workflow name in `.github/workflows/lockfile-check.yml` is `Lockfile Check`. | Present. |
| `Contracts Dep Lint` | No `.github/workflows/contracts-dep-lint.yml` exists; `ci.yml` contains job `contracts-dep-lint`. GitHub required contexts may surface as `CI / contracts-dep-lint` rather than bare `Contracts Dep Lint`. | Needs owner verification with `gh pr checks <pr>` before applying protection. |

## Findings

1. PR/main parity is broadly present for repo hygiene gates: most always-on dogfood workflows trigger on both `pull_request` to `main` and `push` to `main`, plus `merge_group` for merge-queue parity.
2. No workflow in this tree targets a `dev` branch. The documented branch model is currently main-centric; adding `dev` would require explicit branch filters and branch-protection updates.
3. Tag triggers are intentionally limited to product publishing/prebuild surfaces: `release.yml` and `worktree-napi-prebuild.yml` on `v*`.
4. Cron triggers are intentionally owner/dogfood-only: freshness sentinel, skills council, and skills grade.
5. Dispatch-only workflows are either shipped release operations (`release-prepare`, release template operations) or owner maintenance operations; dispatch is not a substitute for PR/main gates.
6. The current live GitHub `main` branch protection does not match the in-tree desired protection document because the branch is reported unprotected.
7. The required-context list in `docs/release/branch-protection-setup.md` needs reconciliation before enforcement: `Contracts Dep Lint` is documented, but the current tree exposes that as a `ci.yml` job rather than a same-named workflow file.
