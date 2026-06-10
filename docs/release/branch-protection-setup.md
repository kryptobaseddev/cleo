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
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=CI \
  -f "required_status_checks[contexts][]=Arch Boundary Check" \
  -f "required_status_checks[contexts][]=Lockfile Check" \
  -f "required_status_checks[contexts][]=Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

### What this enforces

| Rule | Setting | Effect |
|------|---------|--------|
| `required_status_checks[strict]` | `true` | Branch must be up-to-date with `main` before merge |
| `CI` check required | required context | All tests + build must pass (the `ci` aggregate gate in `ci.yml`) |
| `Arch Boundary Check` required | required context | All SG-ARCH-SOLID lints incl. the LLM-chokepoint / no-hardcoded-models guard (the `arch-boundary-check` aggregate gate) |
| `Lockfile Check` required | required context | `pnpm install --frozen-lockfile` must pass (ADR-ORC-011) |
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
| `CI` | `.github/workflows/ci.yml` | `ci` |
| `Arch Boundary Check` | `.github/workflows/arch-boundary-check.yml` | `arch-boundary-check` |
| `Lockfile Check` | `.github/workflows/lockfile-check.yml` | `lockfile-consistency` (single job — is its own check) |
| `Contracts Dep Lint` | required context reported by the live branch-protection API | `ci.yml` also carries a `contracts-dep-lint` job for parity |

**The gap this closes:** before T11955, `arch-boundary-check.yml`'s 12 lint
jobs (including the LLM-chokepoint / no-hardcoded-models guard) had no
aggregate and none were required checks. A failing arch-boundary lint could
land on `main` green-looking — and admin-merge bypassed it entirely (#1037,
fixed #1044). The `arch-boundary-check` aggregate gate now makes a single
required context cover all 12 arch gates.

**Regression lock:** `scripts/lint-merge-bar-aggregate.mjs` (CI job
`Merge-Bar Aggregate Gate Lint`) asserts that every PR-gating multi-job
workflow keeps a complete aggregate gate — failing if a future job is added
without being wired into its workflow's `needs:` list. When you add a job to
`ci.yml` or `arch-boundary-check.yml`, also add it to that workflow's
aggregate `needs:` list, or this lint (and thus the merge bar) will fail.

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

The PR/main/dev/tag/cron/dispatch parity matrix and the shipped-vs-dogfood
classification live in `docs/release/ci-hooks-parity-matrix.md`.

The required check names must match exactly what GitHub Actions reports.
Verify by running a PR and checking `gh pr checks <pr-number>`:

```bash
gh pr checks <pr-number>
```

Common required check names for this repo:

- `CI` — `.github/workflows/ci.yml` (tests + build; `ci` aggregate job)
- `Arch Boundary Check` — `.github/workflows/arch-boundary-check.yml` (all SG-ARCH-SOLID lints; `arch-boundary-check` aggregate job — T11955)
- `Lockfile Check` — `.github/workflows/lockfile-check.yml`
- `Contracts Dep Lint` — installed required context currently reported by the live branch-protection API (`app_id=15368`); `ci.yml` also carries a repo-local `contracts-dep-lint` job for parity coverage.

If check names differ, update the `required_status_checks[contexts][]` values above
to match the actual names reported by `gh pr checks` and the branch-protection API.

## References

- ADR-065 — PR-Required Release Flow
- `docs/RELEASING.md` — Full release checklist
- `AGENTS.md` — Release & Branching conventions
