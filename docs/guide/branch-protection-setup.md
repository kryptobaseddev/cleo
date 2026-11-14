# Branch Protection Setup

This document contains the `gh` API commands to configure GitHub branch protection
for the `main` branch. Run these once after a fresh repository setup or when updating
protection rules.

## Prerequisites

```bash
# Verify gh CLI is authenticated
gh auth status

# Confirm default branch
gh repo view --json defaultBranchRef
# Expected: {"defaultBranchRef":{"name":"main"}}
```

## Apply Protection Rules

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks[strict]=false \
  -f required_status_checks[contexts][]=CI \
  -f "required_status_checks[contexts][]=Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

### What this enforces

| Rule | Setting | Effect |
|------|---------|--------|
| `required_status_checks[strict]` | `false` | A PR merges once its own `CI` is green (owner decision 2026-09-29; main-push CI catches combination breaks) |
| `CI` check required | required context | All tests + build + every arch gate must pass (the `ci` aggregate gate in `ci.yml`; since T13263 it also needs the arch gates and the other lint workflows, called from ci.yml) |
| `Contracts Dep Lint` required | required context | Package boundary lint must pass |
| `enforce_admins` | `false` | Admins can merge emergency patches; audited via `.cleo/audit/force-bypass.jsonl` |
| `required_approving_review_count` | `0` | Bots can merge (cleo release ship uses `gh pr merge`) |
| `restrictions` | `null` | No push restrictions beyond status checks |

### Required Status Checks — the merge-bar contract (T11955 · DHQ-072)

Each GitHub Actions **job** surfaces as its own top-level status check. A
multi-job workflow therefore needs ONE of two things to be safe at the merge
bar: either every job individually listed above (brittle), or a single
**all-green aggregate gate job** that `needs:` every sibling and fails if any
sibling failed/was cancelled. We use the aggregate approach so the required-
checks list above stays a small, stable set of **one context per gating
workflow**:

| Required context | Workflow | Aggregate job (`if: always()`, `needs:` all siblings) |
|------------------|----------|-------------------------------------------------------|
| `CI` | `.github/workflows/ci.yml` | `ci` — needs every ci.yml job, including the calls to `arch-boundary-check.yml` (`arch-gates`) and the other gating lint workflows (T13263) |
| `Contracts Dep Lint` | required context reported by the live branch-protection API | `ci.yml` also carries a `contracts-dep-lint` job for parity |

**The gap this closes:** before T11955, `arch-boundary-check.yml`'s 12 lint
jobs (including the LLM-chokepoint / no-hardcoded-models guard) had no
aggregate and none were required checks. A failing arch-boundary lint could
land on `main` green-looking — and admin-merge bypassed it entirely (#1037,
fixed #1044). T11955 added the `arch-boundary-check` aggregate, but nothing
ever required that context (live protection requires only `CI`), so on
2026-10-05 #1881 still showed `CI` green while two arch gates failed.
**T13263** closes it for good: `arch-boundary-check.yml` and the other
gating lint workflows (AI SDK Surface, Boundary Registry, Dual
Implementation, Dual-Scope Reads, Duplicate Test Filenames, Envelope
Compliance, Generated Artifact Drift, Identity Pollution) are reusable
workflows (`on: workflow_call`) called from `ci.yml`, and the `ci`
aggregate needs each calling job. Their checks now appear as
`<caller job> / <job>` (e.g. `Arch Gates / Arch Boundary Check`); do NOT add
the old `Arch Boundary Check` context to branch protection — it no longer
reports under that name and would block every merge.

**Regression lock:** `scripts/lint-merge-bar-aggregate.mjs` (CI job
`Merge-Bar Aggregate Gate Lint`) asserts that every PR-gating multi-job
workflow keeps a complete aggregate gate — failing if a future job is added
without being wired into its workflow's `needs:` list. When you add a job to
`ci.yml` or `arch-boundary-check.yml`, also add it to that workflow's
aggregate `needs:` list, or this lint (and thus the merge bar) will fail.
Since T13263 it also fails on any `pull_request` workflow that is neither a
required context, nor called from `ci.yml` (triggering only on
`workflow_call`, with no workflow-level `concurrency`), nor listed in its
`ADVISORY_WORKFLOWS` with a reason — so a new standalone gate cannot reopen
the gap. T13279 folded the rest: `Lockfile Check` (`lockfile-gate`), and
the path-scoped `cant-napi build`, `Worktree NAPI Prebuild Gate` (replacing
the job that polled the standalone prebuild run), `cleo-supervisor smoke`,
`Skills Depth Check` and `Release Pipeline Matrix`, which ci.yml runs only
when the `changes` job sees their paths (a skip is a pass). Only
`cleo-supervisor prebuild` stays standalone: it needs `contents: write` to
attach release assets on tag pushes, more than a ci.yml call can hold.
T13838 and T13840 then folded the sub-minute gate jobs into steps of four
jobs (`Repo Lints`, `Repo Lints (installed)`, `Arch Gates / Gates (node)`,
`Arch Gates / Gates (installed)`), including the nine single-job workflows
(Lockfile Check, AI SDK Surface, Boundary Registry, Dual Implementation,
Dual-Scope Reads, Duplicate Test Filenames, Envelope Compliance, Generated
Artifact Drift, Identity Pollution), whose workflow files are gone.
Do NOT require a `Lockfile Check` context either: no check ever reported
under that name (its job is `Verify pnpm-lock.yaml consistency`), so it
would block every merge; `CI` covers it.

## Verify Current Rules

```bash
gh api repos/:owner/:repo/branches/main/protection
```

## Remove Protection (emergency only)

```bash
gh api -X DELETE repos/:owner/:repo/branches/main/protection
```

Re-apply immediately after the emergency is resolved. Log the bypass in
`.cleo/audit/force-bypass.jsonl` with reason.

## CI Check Names

The workflow classes (shipped, dogfood-only, shared) and the trigger policy
are in the [consumer workflow and hook contract](../spec/consumer-workflow-hook-contract.md);
`.github/workflows/ci.yml` is the source for the jobs themselves.

The required check names must match exactly what GitHub Actions reports.
Verify by running a PR and checking `gh pr checks <pr-number>`:

```bash
gh pr checks <pr-number>
```

Common required check names for this repo:

- `CI` — `.github/workflows/ci.yml` (tests + build; `ci` aggregate job)
- `Arch Gates / Arch Boundary Check` — `.github/workflows/arch-boundary-check.yml`, called from `ci.yml` (job `arch-gates`); covered by `CI`, not a separate required context (T13263)
- Lockfile Check — a step of `ci.yml`'s `Repo Lints (installed)` job (T13840); covered by `CI`, not a context
- `Contracts Dep Lint` — installed required context currently reported by the live branch-protection API (`app_id=15368`); `ci.yml` also carries a repo-local `contracts-dep-lint` job for parity coverage.

If check names differ, update the `required_status_checks[contexts][]` values above
to match the actual names reported by `gh pr checks` and the branch-protection API.

## References

- ADR-065 — PR-Required Release Flow
- `docs/RELEASING.md` — Full release checklist
- `AGENTS.md` — Release & Branching conventions

<!-- merged from `main-branch-protection-evidence-superseded` by cleo docs modernize -->

## From `main-branch-protection-evidence-superseded`

# Main branch protection evidence

Task: T10491
Parent: T10468
Observed: 2026-05-25T03:08:25Z
Repository: `kryptobaseddev/cleo`
Default branch: `main`

## Current state command

```bash
gh repo view --json nameWithOwner,defaultBranchRef

gh api repos/:owner/:repo/branches/main/protection \
  --jq '{required_status_checks:.required_status_checks.contexts, checks:.required_status_checks.checks, strict:.required_status_checks.strict, enforce_admins:.enforce_admins.enabled, required_reviews:.required_pull_request_reviews.required_approving_review_count, restrictions:.restrictions, required_conversation_resolution:.required_conversation_resolution.enabled, required_linear_history:.required_linear_history.enabled, allow_force_pushes:.allow_force_pushes.enabled, allow_deletions:.allow_deletions.enabled}'
```

## Current state observed

> **Current state (2026-10-05, T13263 / T13279):** live branch protection requires only `CI` (`strict=false`). The arch gates, Lockfile Check and the other gating workflows run INSIDE `CI` (reusable workflows its aggregate needs). Do NOT require a `Lockfile Check` or `Arch Boundary Check` context: neither reports under that name, so requiring it blocks every merge. The canonical command is in `AGENTS.md` and `docs/release/branch-protection-setup.md` (`CI` + `Contracts Dep Lint`).

The JSON below is the **historical** observation of 2026-05-25 (T10491), kept as evidence of that date.

```json
{
  "nameWithOwner": "kryptobaseddev/cleo",
  "defaultBranchRef": { "name": "main" }
}
```

```json
{
  "allow_deletions": false,
  "allow_force_pushes": false,
  "checks": [
    { "app_id": null, "context": "CI" },
    { "app_id": null, "context": "Lockfile Check" },
    { "app_id": 15368, "context": "Contracts Dep Lint" }
  ],
  "enforce_admins": false,
  "required_conversation_resolution": false,
  "required_linear_history": false,
  "required_reviews": 0,
  "required_status_checks": ["CI", "Lockfile Check", "Contracts Dep Lint"],
  "restrictions": null,
  "strict": true
}
```

## Desired state

The desired state is documented in `docs/release/branch-protection-setup.md`:

- required status checks NOT strict (owner decision 2026-09-29)
- required contexts: `CI`, `Contracts Dep Lint` (live today: `CI` only)
- zero required approving reviews
- admin enforcement disabled
- no push restrictions
- force pushes disabled
- deletions disabled

## Safe apply command if the rule is absent or drifted

Run only as the repository owner/admin, and only when the intended change does not weaken protection:

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks[strict]=false \
  -f required_status_checks[contexts][]=CI \
  -f "required_status_checks[contexts][]=Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

## PR check evidence

Current PR evidence for the `Contracts Dep Lint` context:

```bash
gh pr view 765 --json number,title,state,mergedAt,headRefName,baseRefName,statusCheckRollup \
  --jq '{number,title,state,mergedAt,headRefName,baseRefName,checks:[.statusCheckRollup[] | select(.name=="Contracts Dep Lint") | {name:.name, status:.status, conclusion:.conclusion, workflowName:.workflowName}]}'
```

Observed on merged PR #765 (`task/T10491-hotfix-any-types` -> `main`): `Contracts Dep Lint` appears in workflow `CI`, status `COMPLETED`, conclusion `SUCCESS`.

## HITL / owner blocker status

No blocker remained at observation time: branch protection was already enabled and matched desired state. If future API output differs, stop and request owner/admin approval before applying the safe command above.

<!-- merged from `branch-protection-verification-superseded` by cleo docs modernize -->

## From `branch-protection-verification-superseded`

# T10447 branch protection verification

Saga: T10431
Task: T10447 — T10432-D: Owner HITL — enable branch protection + merge_queue_enabled=true
Repository: `kryptobaseddev/cleo`
Branch: `main`

## Verification commands

Run from the T10447 worktree on 2026-05-24:

```sh
gh api repos/kryptobaseddev/cleo/branches/main/protection --jq '{required_status_checks,required_pull_request_reviews,restrictions,enforce_admins,required_linear_history,allow_force_pushes,allow_deletions}'
gh api repos/kryptobaseddev/cleo --jq '{allow_auto_merge,default_branch,full_name}'
```

## Observed API state

The branch protection endpoint exposed and confirmed:

- `required_status_checks.strict=true`
- `required_status_checks.contexts=["CI","Lockfile Check","Contracts Dep Lint"]`
- `required_pull_request_reviews.required_approving_review_count=0`
- `restrictions=null`
- `enforce_admins.enabled=false`
- `required_linear_history.enabled=false`
- `allow_force_pushes.enabled=false`
- `allow_deletions.enabled=false`

The repository endpoint exposed and confirmed:

- `full_name="kryptobaseddev/cleo"`
- `default_branch="main"`
- `allow_auto_merge=false`

## Merge queue note

Do not infer merge queue state from these responses. The branch protection payload returned by the verification command did not expose a `merge_queue` or `merge_queue_enabled` key, and the repository payload above only exposed `allow_auto_merge=false` for this check. This note records the exact API surface observed rather than fabricating merge queue status.
