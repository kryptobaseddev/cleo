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
| `CI` check required | required context | All tests + build must pass |
| `Lockfile Check` required | required context | `pnpm install --frozen-lockfile` must pass (ADR-ORC-011) |
| `Contracts Dep Lint` required | required context | Package boundary lint must pass |
| `enforce_admins` | `false` | Admins can merge emergency patches; audited via `.cleo/audit/force-bypass.jsonl` |
| `required_approving_review_count` | `0` | Bots can merge (cleo release ship uses `gh pr merge`) |
| `restrictions` | `null` | No push restrictions beyond status checks |

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

The required check names must match exactly what GitHub Actions reports.
Verify by running a PR and checking `gh pr checks <pr-number>`:

```bash
gh pr checks <pr-number>
```

Common check names for this repo:

- `CI` — `.github/workflows/ci.yml` (tests + build)
- `Lockfile Check` — `.github/workflows/lockfile-check.yml`
- `Contracts Dep Lint` — `.github/workflows/contracts-dep-lint.yml` (if present)

If check names differ, update the `required_status_checks[contexts][]` values above
to match the actual names reported by `gh pr checks`.

## References

- ADR-065 — PR-Required Release Flow
- `docs/RELEASING.md` — Full release checklist
- `AGENTS.md` — Release & Branching conventions
