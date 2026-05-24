# Merge Queue Runbook

> **Status:** Live · **Owner:** Saga T10431 · **Task:** T10446  
> **Last updated:** 2026-05-24

This document is the operator-facing runbook for GitHub Merge Queue on the
`cleocode` repository. It covers setup, day-to-day commands, troubleshooting,
and FAQ.

---

## 1. Setup

### 1.1 Prerequisites

- Repository admin access (or ask an owner).
- `gh` CLI authenticated (`gh auth status`).
- Default branch is `main`.

### 1.2 Enable merge queue on the repository

GitHub Merge Queue is enabled at the repository level via the web UI or API.

**Web UI (recommended):**
1. Go to **Settings → General → Pull Requests**.
2. Under **Merge button**, check **Allow merge queue**.
3. Choose **Build strategy**: **All checks required** (recommended) or
   **Only required checks**.
4. Set **Maximum pull requests to build**: `5` (default).
5. Set **Maximum pull requests to merge**: `5` (default).
6. Set **Minimum pull requests to merge**: `1` (default).
7. Set **Maximum build time for a pull request**: `60` minutes.
8. Save.

**API (automation / reproducibility):**

```bash
# Enable merge queue (requires admin token)
gh api -X PATCH repos/:owner/:repo \
  -f allow_merge_queue=true \
  -f merge_queue_build_strategy='all' \
  -f merge_queue_maximum_entries=5 \
  -f merge_queue_maximum_entries_to_merge=5 \
  -f merge_queue_minimum_entries_to_merge=1 \
  -f merge_queue_maximum_build_time=60
```

> **Note:** The `gh` CLI does not yet expose a first-class `merge queue enable`
> command. Use the web UI or the REST API above.

### 1.3 Verify branch protection works with merge queue

Merge queue requires branch protection rules (or a ruleset) that:
- Require status checks to pass before merging.
- Require pull request reviews (optional but recommended).

Run the protection setup from `docs/release/branch-protection-setup.md`:

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=CI \
  -f required_status_checks[contexts][]="Lockfile Check" \
  -f required_status_checks[contexts][]="Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

Then verify the queue is active:

```bash
gh api repos/:owner/:repo/branches/main/protection | jq '.required_pull_request_reviews, .required_status_checks'
```

### 1.4 Ensure workflows declare `merge_group:`

Every workflow that must run in the queue needs `merge_group:` in its `on:`
block. As of 2026-05-24, the following 12 PR-gated workflows declare it:

| Workflow | `merge_group:` present? |
|---|---|
| `arch-boundary-check.yml` | ✓ |
| `auto-tag-on-release-merge.yml` | ✓ |
| `boundary-registry-lint.yml` | ✓ |
| `ci.yml` | ✓ |
| `docs-reingest.yml` | ✓ |
| `dual-implementation-lint.yml` | ✓ |
| `identity-pollution-check.yml` | ✓ |
| `lockfile-check.yml` | ✓ |
| `release-pipeline-matrix.yml` | ✓ |
| `skills-depth-check.yml` | ✓ |
| `worktree-cleanup.yml` | ✓ |
| `worktree-napi-prebuild.yml` | ✓ |

The following 5 workflows do **not** need `merge_group:` because they are
triggered by non-PR events:

| Workflow | Trigger | Why no `merge_group:` |
|---|---|---|
| `release-prepare.yml` | `workflow_dispatch` | Manual dispatch only |
| `release.yml` | `push: tags:` + `workflow_dispatch` | Tag push or manual |
| `freshness-sentinel.yml` | `schedule` + `workflow_dispatch` | Cron / manual |
| `skills-council.yml` | `schedule` + `workflow_dispatch` | Cron / manual |
| `skills-grade.yml` | `schedule` + `workflow_dispatch` | Cron / manual |

If a new PR-gated workflow is added, it **must** include `merge_group:` or
merge queue will skip its checks and the PR will stall.

---

## 2. Operator Commands

### 2.1 Add a PR to the merge queue

**Web UI:**
1. Open the PR.
2. Click the dropdown next to the green **Merge** button.
3. Select **Merge when ready** (or **Add to merge queue**).
4. GitHub creates a temporary merge branch and runs CI.

**CLI (no native `gh merge-queue` command yet):**

Use the GitHub GraphQL API or the web UI. A helper alias:

```bash
# Add PR #<num> to merge queue (requires GraphQL token)
gh api graphql -f query='
  mutation($id: ID!) {
    enqueuePullRequest(input: {pullRequestId: $id}) {
      mergeQueueEntry {
        id
        state
      }
    }
  }
' -f id="$(gh pr view <num> --json id -q .id)"
```

### 2.2 Check queue status

```bash
# List PRs currently in the merge queue
gh api repos/:owner/:repo/pulls?state=open | \
  jq '.[] | select(.merge_queue_entry != null) | {number, title, merge_queue_entry: .merge_queue_entry.state}'
```

Or view the queue in the web UI:
- **Repository → Pull requests → Merge queue** (tab near the top).

### 2.3 Remove a PR from the queue

**Web UI:**
1. Open the PR.
2. Click **Remove from merge queue**.

**CLI:**

```bash
gh api graphql -f query='
  mutation($id: ID!) {
    dequeuePullRequest(input: {pullRequestId: $id}) {
      mergeQueueEntry {
        id
        state
      }
    }
  }
' -f id="$(gh pr view <num> --json id -q .id)"
```

### 2.4 View merge queue history

```bash
# Recent merge-group events (push to gh-readonly-queue/* branches)
gh api repos/:owner/:repo/events?per_page=30 | \
  jq '.[] | select(.type == "PushEvent") | select(.payload.ref | contains("gh-readonly-queue")) | {created_at, ref: .payload.ref, before, after}'
```

### 2.5 Check a specific merge-group CI run

Merge-group builds appear in the Actions tab with branch names like
`gh-readonly-queue/main/pr-123-<sha>`.

```bash
# List recent merge-group runs
gh run list --branch "gh-readonly-queue/main" --limit 10

# View a specific run
gh run view <run-id>
```

---

## 3. Troubleshooting

### 3.1 PR stuck in queue — CI never starts

**Symptom:** PR shows "Waiting for checks to pass" indefinitely.

**Diagnosis:**
1. Check whether the temporary merge branch exists:
   ```bash
   git ls-remote origin 'refs/heads/gh-readonly-queue/*'
   ```
2. If the branch exists but no Actions run started, verify the workflow
   files declare `merge_group:`.
3. Check **Settings → Actions → General** — ensure Actions are enabled
   for merge-group events (they are by default).

**Fix:**
- If a workflow is missing `merge_group:`, add it and re-queue the PR.
- If the branch does not exist, remove and re-add the PR to the queue.

### 3.2 PR fails in queue but passes on the PR branch

**Symptom:** Green PR CI, red merge-group CI.

**Cause:** Merge queue tests the *merge commit* (`main` + PR), not the
PR branch tip. A conflicting change landed on `main` after the PR's last
rebase.

**Fix:**
1. Rebase the PR on latest `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   git push --force-with-lease
   ```
2. Re-add the PR to the queue.

### 3.3 "Required status check "X" was not reported"

**Symptom:** Merge queue complains that a required check is missing.

**Cause:** The branch protection rule lists a check name that does not
match the job name reported by GitHub Actions. This is common after
renaming a workflow job.

**Fix:**
1. Find the exact check name from a recent PR:
   ```bash
   gh pr checks <pr-number>
   ```
2. Update the branch protection rule to match the exact string:
   ```bash
   gh api -X PUT repos/:owner/:repo/branches/main/protection \
     -f required_status_checks[contexts][]="Exact Job Name"
   ```

### 3.4 Merge queue disabled / missing from UI

**Symptom:** No "Merge when ready" button; only "Merge pull request".

**Cause:** Merge queue is not enabled in repository settings, or the
branch protection rules do not require status checks.

**Fix:**
1. Re-run the setup steps in §1.2 and §1.3.
2. Ensure at least one status check is required by protection rules.

### 3.5 Auto-tag workflow (`auto-tag-on-release-merge.yml`) not firing

**Symptom:** Release PR merged, but no tag created.

**Diagnosis:**
1. Check whether the merge was performed by the merge queue or a manual
   merge. The workflow triggers on `pull_request: types: [closed]` with
   `merged == true`. Merge-queue merges *do* emit this event, but verify
   in the Actions tab.
2. Check the PR title matches `^release: ship v<version>`.

**Fix:**
- If the title is wrong, rename the PR and re-merge (or tag manually as
  a break-glass measure).
- If the workflow did not run, check `.github/workflows/auto-tag-on-release-merge.yml`
  for syntax errors.

### 3.6 Worktree cleanup not running after merge-queue merge

**Symptom:** Merged PR's worktree still exists.

**Cause:** `worktree-cleanup.yml` triggers on `pull_request: types: [closed]`
and `push: branches: [main]`. Merge-queue merges emit the `closed` event,
but the `merged` flag must be `true`.

**Fix:**
- Verify the workflow's `if:` guard:
  ```yaml
  if: ${{ (github.event_name == 'pull_request' && github.event.pull_request.merged == true) || github.event_name == 'push' }}
  ```
- If the guard is correct, check the Actions log for the specific run.

---

## 4. FAQ

### Q1: Do I need to rebase before adding to the merge queue?

**A:** No. The queue creates the merge commit automatically. However, if
your PR branch is far behind `main`, the queue build may fail due to
conflicts. Rebase proactively to reduce queue churn.

### Q2: Can I merge manually (bypass the queue)?

**A:** Admins can bypass, but this is audited. The zero-admin-merge policy
expects *all* merges to go through the queue. If you must bypass:
1. Use **Admin merge** (GitHub UI) or `gh pr merge --admin`.
2. Log the bypass reason in `.cleo/audit/force-bypass.jsonl`.

### Q3: Does merge queue work with release PRs?

**A:** Yes. Release PRs (title `release: ship vX.Y.Z`) are added to the
queue like any other PR. After the queue merges them, `auto-tag-on-release-merge.yml`
fires and creates the tag.

### Q4: What happens if two PRs conflict in the queue?

**A:** GitHub builds them sequentially. If PR #2's merge commit conflicts
with PR #1 (which just merged), PR #2 is kicked out of the queue and the
author is notified. Rebase and re-queue.

### Q5: How do I disable merge queue temporarily?

**A:** Repository admins can disable it in **Settings → General → Pull Requests**.
This is a break-glass measure — document the reason in the audit log and
re-enable as soon as possible.

### Q6: Why do some workflows have `merge_group:` and others don't?

**A:** Only workflows that need to run *before* a PR can merge need
`merge_group:`. Workflows triggered by tags, cron, or manual dispatch
never run in the queue context, so they omit the trigger.

### Q7: Can I see the temporary merge branch locally?

**A:** GitHub does not push `gh-readonly-queue/*` branches to the remote
by default (they are internal). You can inspect the merge commit after the
queue finishes via:

```bash
git fetch origin main
git log --oneline -5 origin/main
```

---

## 5. References

- `AGENTS.md` — Release & Branching (ADR-065) section
- `docs/release/branch-protection-setup.md` — Branch protection API commands
- `docs/release/verb-matrix.md` — Release verb surface
- `docs/release/job-inventory.md` — CI job inventory (includes `merge_group:` audit)
- GitHub Docs: [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
