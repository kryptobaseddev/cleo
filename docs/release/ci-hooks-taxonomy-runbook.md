# CI/hooks taxonomy runbook

Task: T10478
Parent: T10468
Observed: 2026-05-25T03:08:25Z
Repository: `kryptobaseddev/cleo`
Default branch: `main`

## Purpose

This runbook is the operational handoff for release orchestrators and CLEO consumers after the T10468 CI/hooks taxonomy reconciliation. It explains which CI and hook surfaces are shipped consumer behavior, which are cleocode dogfood-only owner workflows, which are shared product/repo signals, and how to safely verify or update branch protection without weakening `main`.

The source matrix is `docs/release/ci-hooks-parity-matrix.md`. The branch-protection command reference is `docs/release/branch-protection-setup.md`.

## Taxonomy

| Class | Definition | Examples | Operator rule |
| --- | --- | --- | --- |
| Shipped consumer tooling | Code or templates distributed to CLEO users, especially release workflow templates under `packages/core/templates/workflows/`. | `release-prepare.yml.tmpl`, `release-publish.yml.tmpl`, `release-fanout.yml.tmpl`, `release-rollback.yml.tmpl`. | Treat as product contract. Avoid cleocode-only paths, credentials, branch names, and assumptions unless they are templated or documented for consumers. |
| Cleocode dogfood-only repo workflow | GitHub Actions, schedules, and hygiene checks that protect this repository and the CLEO team operating model. | Architecture/boundary lints, worktree cleanup, freshness sentinel, skills council, skills grade. | May encode cleocode-specific policy. Do not document as required consumer setup. |
| Shared surface | A repo workflow or gate that dogfoods a shipped invariant or publishes shipped CLEO artifacts. | `Lockfile Check`, `Identity Pollution Check`, `Release`, `Release Prepare`, `Release Pipeline Matrix`, `Release Readiness`, worktree-napi prebuild. | Document both roles: the instance is repo-local, while the invariant/artifact path is product-relevant. |

## Trigger policy

1. PR and merge-queue gates are the normal quality path for changes targeting `main`.
2. Push-to-`main` workflows are repository backstops for merged changes and owner emergency paths; they are not a substitute for PR review/gates.
3. No current workflow targets a `dev` branch. Adding one requires explicit workflow filters and branch-protection updates.
4. Tag-triggered workflows are limited to release and prebuild publication paths.
5. Cron-triggered workflows are owner/dogfood-only.
6. `workflow_dispatch` is for explicit operator actions and re-runs; it must not be treated as automatic PR/main coverage.

## Release-orchestrator checklist

Before opening or merging release PRs:

1. Confirm repository identity and default branch:

   ```bash
   gh repo view --json nameWithOwner,defaultBranchRef
   ```

   Expected: `kryptobaseddev/cleo`, default branch `main`.

2. Confirm required status checks currently configured on `main`:

   ```bash
   gh api repos/:owner/:repo/branches/main/protection \
     --jq '{required_status_checks:.required_status_checks.contexts, checks:.required_status_checks.checks, strict:.required_status_checks.strict, enforce_admins:.enforce_admins.enabled, required_reviews:.required_pull_request_reviews.required_approving_review_count, restrictions:.restrictions, allow_force_pushes:.allow_force_pushes.enabled, allow_deletions:.allow_deletions.enabled}'
   ```

   Expected after T10491:

   ```json
   {
     "allow_deletions": false,
     "allow_force_pushes": false,
     "enforce_admins": false,
     "required_reviews": 0,
     "required_status_checks": ["CI", "Lockfile Check", "Contracts Dep Lint"],
     "restrictions": null,
     "strict": true
   }
   ```

3. If a required check is missing from a PR, compare exact GitHub-reported names before changing branch protection:

   ```bash
   gh pr checks <pr-number>
   ```

   Do not guess or rename contexts by file name. Branch protection matches status check context strings, not necessarily workflow filenames.

4. If branch protection is absent or drifted, stop unless you are the repo owner or have explicit owner approval. Use the exact command in `docs/release/branch-protection-setup.md`; do not delete or weaken protection as part of this runbook.

## Consumer guidance

Consumers should copy or generate only the shipped templates under `packages/core/templates/workflows/`. They should not copy cleocode-only workflows unless they intentionally want the same repository policy and have adapted paths, package manager commands, secrets, and check names to their own repository.

Minimum consumer-facing release templates:

- `release-prepare.yml.tmpl` — manual/CLI-dispatched release PR preparation.
- `release-publish.yml.tmpl` — publish after release preparation updates configured version paths on `main`, plus manual re-run.
- `release-fanout.yml.tmpl` — downstream fanout after GitHub Release publication.
- `release-rollback.yml.tmpl` — explicit operator rollback.

## Branch-protection desired state

`main` should require strict status checks and the contexts below:

- `CI`
- `Lockfile Check`
- `Contracts Dep Lint`

Additional expected settings:

- `required_status_checks.strict=true`
- `required_pull_request_reviews.required_approving_review_count=0`
- `enforce_admins=false`
- `restrictions=null`
- force pushes disabled
- deletions disabled

As of 2026-05-25T03:08:25Z, the live GitHub branch-protection API matches this desired state.

## Escalation / HITL stop rule

Stop and request owner/HITL approval if any of these are true:

- You need to create, update, or delete branch protection and are not authenticated as a repository owner/admin.
- The desired update would remove required checks, disable strict checks, enable force pushes, enable deletions, or otherwise weaken protection.
- GitHub reports a required context mismatch that cannot be proven with `gh pr checks <pr-number>` or the branch-protection API.
- A consumer asks whether to copy cleocode dogfood-only workflows as product requirements.

Record the current API output, the exact command you intended to run, and the reason for stopping.
