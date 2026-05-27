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

The live branch protection now matches the desired state documented in `docs/release/branch-protection-setup.md`:

- strict required status checks enabled
- required contexts: `CI`, `Lockfile Check`, `Contracts Dep Lint`
- zero required approving reviews
- admin enforcement disabled
- no push restrictions
- force pushes disabled
- deletions disabled

## Safe apply command if the rule is absent or drifted

Run only as the repository owner/admin, and only when the intended change does not weaken protection:

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

## PR check evidence

Current PR evidence for the `Contracts Dep Lint` context:

```bash
gh pr view 765 --json number,title,state,mergedAt,headRefName,baseRefName,statusCheckRollup \
  --jq '{number,title,state,mergedAt,headRefName,baseRefName,checks:[.statusCheckRollup[] | select(.name=="Contracts Dep Lint") | {name:.name, status:.status, conclusion:.conclusion, workflowName:.workflowName}]}'
```

Observed on merged PR #765 (`task/T10491-hotfix-any-types` -> `main`): `Contracts Dep Lint` appears in workflow `CI`, status `COMPLETED`, conclusion `SUCCESS`.

## HITL / owner blocker status

No blocker remained at observation time: branch protection was already enabled and matched desired state. If future API output differs, stop and request owner/admin approval before applying the safe command above.
