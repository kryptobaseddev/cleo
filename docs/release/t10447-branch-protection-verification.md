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
