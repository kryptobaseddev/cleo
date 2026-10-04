# Merge Queue Runbook

> **Status:** Live · **Owner:** Saga T10431 · **Task:** T10446  
> **Last updated:** 2026-10-03

This document is the operator-facing runbook for GitHub Merge Queue on the
`cleocode` repository. It covers setup, day-to-day commands, the zero-admin-merge
policy, troubleshooting, and FAQ.

---

## Setup

### Prerequisites

- Repository admin access (or ask an owner).
- `gh` CLI authenticated (`gh auth status`).
- Default branch is `main`.

### How `merge_group` triggers work

When a PR is added to the merge queue, GitHub creates a temporary merge branch
(`gh-readonly-queue/<target>/<pr>-<sha>`) and pushes it. This push fires the
`merge_group` event. Any workflow whose `on:` block includes `merge_group:` will
run against that temporary branch. The queue waits for all required checks to
pass before fast-forwarding the target branch.

Key points:
- `merge_group` is a distinct event from `pull_request` or `push`.
- Workflows that do **not** declare `merge_group:` will not run in the queue.
- If a required status check is listed in branch protection but its workflow
  lacks `merge_group:`, the PR will stall forever.

### Which workflows have `merge_group:`

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

The following 6 workflows do **not** need `merge_group:` because they are
triggered by non-PR events:

| Workflow | Trigger | Why no `merge_group:` |
|---|---|---|
| `release-prepare.yml` | `workflow_dispatch` | Manual dispatch only |
| `release.yml` | `push: tags:` + `workflow_dispatch` | Tag push or manual |
| `release-promote.yml` | `workflow_dispatch` | Manual dispatch only; moves npm `latest` (T13144) |
| `freshness-sentinel.yml` | `schedule` + `workflow_dispatch` | Cron / manual |
| `skills-council.yml` | `schedule` + `workflow_dispatch` | Cron / manual |
| `skills-grade.yml` | `schedule` + `workflow_dispatch` | Cron / manual |

If a new PR-gated workflow is added, it **must** include `merge_group:` or
merge queue will skip its checks and the PR will stall.

### Enable merge queue on the repository

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

### Verify branch protection works with merge queue

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

---

## The bump-PR opens with zero checks (T12094 — fixed)

**Symptom.** `release-prepare` completes, the bump-PR exists, and it has *no*
checks at all. Branch protection on `main` requires the `CI` context, so the PR
can never become mergeable and `cleo release pr-status` reports nothing to poll.

**Cause.** GitHub deliberately does not trigger workflows for events caused by
`GITHUB_TOKEN` — a guard against recursive runs. `release-prepare` pushes the
release branch and runs `gh pr create` with exactly that token, so neither the
`push` nor the `pull_request` event starts anything. v2026.8.3 and v2026.8.4 both
needed a human to push a throwaway commit to the branch purely to wake CI up.

**Fix.** `ci.yml` gained a `workflow_dispatch` trigger, and `release-prepare` now
dispatches it for the release branch immediately after opening the PR:

```yaml
- name: Trigger CI for the bump-PR
  run: gh workflow run ci.yml --ref "$BRANCH"
```

An explicit dispatch is exempt from the recursion guard. The resulting check runs
attach to the branch-tip SHA — which *is* the PR head commit — so branch
protection is satisfied without human intervention.

One subtlety worth keeping in mind if you edit `ci.yml`: `dorny/paths-filter`
infers its comparison point from the event (base branch for `pull_request`,
previous commit for `push`). A `workflow_dispatch` run has neither, so the filter
is given an explicit `base` of the default branch for that event only. Without it
every path filter reports `false`, every job skips, and the aggregate `CI` job
passes **vacuously** — a green check that tested nothing.

**If it still opens with no checks**, dispatch by hand and file a follow-up:

```bash
gh workflow run ci.yml --ref release/v2026.X.Y
```

## Merging the bump-PR: admin-merge once its dispatched CI is green (approved)

**Why a human step remains.** There is no GitHub App for this repository, so
every event on the bump-PR is `GITHUB_TOKEN`-created. Its `pull_request` runs
come back `action_required` (queued pending approval) and never run on their
own. The `CI` check that DOES run is the `workflow_dispatch` run that
`release-prepare` starts on the release branch (see above); its check runs
attach to the PR head SHA. Waiting for the `pull_request` runs, or approving
them one by one, adds nothing that run has not already proven.

**The dispatched run is the reduced, version-only run (T13141).** The bump
commit changes only `"version"` lines in `package.json` files (and, when
present, `CHANGELOG.md` and `.changeset/` moves). The `changes` job runs
`scripts/ci-detect-version-only.mjs` on a `workflow_dispatch` run of a
`release/v*` branch too, diffing the branch against its merge-base with
`main`. When the diff has that shape, `version_only` is `true`. Unit tests,
builds, the packed artifact, install tests and the other heavy jobs then skip,
while lint, typecheck and the separate Lockfile Check workflow still run, so
the run takes minutes instead of ~22. Any other change on the branch, or a
failed fetch or merge-base, runs the full suite. To see which one ran, open the
run's `Detect Changes` job: the detector prints its verdict and the reason.

**Procedure (the orchestrator runs this, not the release workflow):**

```bash
PR=$(gh pr list --head release/v2026.X.Y --json number --jq '.[0].number')
HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)

# The dispatched CI run for EXACTLY the PR head SHA must be completed + success.
gh run list --workflow ci.yml --branch release/v2026.X.Y --event workflow_dispatch \
  --json headSha,status,conclusion,url --jq ".[] | select(.headSha == \"$HEAD\")"

# Only then:
gh pr merge "$PR" --admin --merge
```

Rules:

- Merge only when the dispatched `CI` run for the **current** head SHA is
  `completed` / `success`. That holds for the reduced version-only run exactly
  as for a full run: the `CI` aggregate is green only when every job that ran
  succeeded. A green run for an earlier head does not count; if the branch
  moved, re-dispatch (`gh workflow run ci.yml --ref release/v2026.X.Y`) and
  wait.
- `--merge` (a merge commit), not squash: the tag is cut from `main` after the
  merge and must contain the bump commit as prepared.
- This is the ONE sanctioned use of `--admin` under the Zero-Admin-Merge Policy
  below (owner-approved; `enforce_admins: false` is the intended escape hatch,
  T12152). Record it in `.cleo/audit/force-bypass.jsonl` like any other bypass,
  with reason `release bump-PR: dispatched CI green on <sha>`.
- `cleo release open` does not watch or merge the bump-PR (it dispatches
  `release-prepare` and returns), so this step is documented rather than
  automated.

## Preflight test skips and native binary reuse

Two mechanisms keep the release off the slow path when nothing new would be
learned. Both are recorded where an operator can see them.

- **Preflight test skips.** `cleo release open` checks main's HEAD SHA with
  `gh` (each call bounded to 15s). If the `ci.yml` push run for that exact SHA
  is green AND its Linux `Unit Tests` shards all ran and succeeded (a green
  docs-only push skips them, and does not qualify) it dispatches
  `release-prepare` with `skip-tests=true`; if every
  macOS job of the nightly (or push) run for that SHA is green it adds
  `skip-macos-tests=true`. The SHA goes along as `verified-sha`, and the
  workflow ignores every skip if it checked out a different commit, or if
  `verified-sha` is empty (a skip must name the commit it was verified on). The
  decision and its reason are in the "Preflight test decision" block of the
  run summary and in `cleo release open`'s result (`preflight`). Any `gh`
  error or unfinished run means the tests run. To force the full preflight,
  dispatch `release-prepare.yml` manually without the skip inputs.
- **Native binary reuse.** cant-napi (8 triples + WASI) and worktree-napi
  (4 triples) are stamped with a native SOURCE hash
  (`node scripts/native-source-hash.mjs cant|worktree`) instead of the commit
  SHA. A verified bundle is cached under that hash (`cant-napi-bundle-v1-<hash>`,
  `worktree-napi-bundle-v1-<hash>`); a release whose native source is unchanged
  restores it and skips the native builds. The publish job recomputes both
  hashes from the tagged commit and refuses any binary that lacks the stamp.
  To force a rebuild, delete the cache entry:
  `gh cache delete cant-napi-bundle-v1-<hash>`.

## Flaky tests: re-run once, file, quarantine (T13145)

Each unit shard runs vitest through `scripts/ci-flaky-quarantine.mjs`:

- When a test fails, its file is re-run once, without `--shard`. If it passes on the re-run, it is a
  **flake**: CI stays green, and the test is listed in the run summary and in the shard's
  `flaky-report-<os>-<shard>` artifact.
- A test that fails twice blocks. Three other cases block without a re-run:
  - more than 10 files fail (a broad failure, not a flake);
  - vitest reports an error outside any test (an `Unhandled Errors` section or an `Errors` summary
    line), even when another failure is a flake;
  - a crash or heap kill leaves no failing test in the JSON report.
- On `main` (push and nightly), the `Flaky Test Quarantine` job files each confirmed flake as an
  open issue labelled `flaky-quarantine`, or renews the existing issue. **The open issues filed by
  GitHub Actions are the quarantine**; an issue anyone else opens or labels does not count, and
  neither does a bot issue whose body someone else has edited or whose title no longer names the test
  its body state names (the state is what the quarantine reads, and it is editable). While a
  test's issue is open, a failure of it that also fails its re-run does not block CI, and it does not
  renew the quarantine either. A whole-file entry excuses only a whole-file failure.
- On the nightly run, an issue with no confirmed flake for 14 days is closed, and the test blocks
  again. A test that is broken rather than flaky therefore leaves quarantine within 14 days. Close an
  issue by hand once its flake is fixed. Duplicate issues for one test (two main runs filing it at
  once) are closed, keeping the oldest.
- Main's CI (push and nightly) fails while more than 10 tests are quarantined, so the quarantine
  cannot grow without tests being fixed. A pull request only warns about it, so one bad day on main
  does not block every PR.
- If the quarantine cannot be read (a `gh` error), it is treated as empty, so failures block.

## Canary soak and promotion (T13144)

A release no longer reaches users when it publishes. `release.yml` publishes
every stable version under the npm dist-tag `canary`; users install `latest`
(`npm i -g @cleocode/cleo`), and `latest` moves only through
`release-promote.yml`, after the canary has soaked and the owner approves.
Prereleases keep their own tags (`beta`, `dev`) and are never promoted.

Every @cleocode package pins its @cleocode dependencies to its own exact
version, so a `latest` install never mixes a canary package into the previous
release, and a half-finished move is still coherent.

**1. After the tag.** `release.yml` runs as before. Its installability verdict
checks `dist-tags.canary`. If the run could not prove installability in its
budget, the tracking issue and `release-installability-watch.yml` take over, as
before. Nothing is `continue-on-error`: a red verdict blocks the promotion.

The promotion reads the verdict only from what the release run **on the tag**
produced, which nobody can edit afterwards: its `Release Verdict` job must have
succeeded, or its `Publish` job succeeded and its own `postdeploy-<version>`
artifact says the verdict was `pending` at its deadline (published, no package
serving a wrong version). In the pending case the plan's live check of every
package decides. The tracking issue is never read: its body is editable. A run
on any other ref does not count, because it runs that ref's copy of the
workflow, and neither does a run whose commit is not the tag's (a branch can be
named like the tag). To re-run a failed release, re-run the tag run's failed jobs
(`gh run rerun <id> --failed`), or dispatch on the tag ref
(`gh workflow run release.yml --ref v2026.X.Y -f version=2026.X.Y`); a dispatch
from `main` does not count for promotion. The postdeploy artifact is kept 30
days, so a release whose verdict was only `pending` must be promoted (or
rolled back to) within that window.

**2. Soak.** Put the canary on real agents first, starting with this machine:

```bash
# Sandbox install + health checks (install, coherent @cleocode versions,
# --version, init, session, saga/epic write, show, find, doctor):
node scripts/release-canary-soak.mjs                    # resolves the current canary
node scripts/release-canary-soak.mjs --version 2026.X.Y --keep   # keep the sandbox to inspect

# Then run the canary on this machine's agents:
npm i -g @cleocode/cleo@canary
```

Use it for real work. When it holds up, promote it. When it does not, fix
forward: the next release replaces the canary, and `latest` never moved.

**3. Promote.** Dispatch the workflow with the version:

```bash
gh workflow run release-promote.yml --ref main -f version=2026.X.Y
```

The `plan` job (no secrets) checks that every package resolves at the version,
that every package's `canary` is the version, and that the installability
verdict is green, then runs the same sandbox soak on a fresh runner. Its job
summary is the plan the reviewer approves. The `promote` job then waits for
approval in the `npm-promote` environment. Once approved it re-checks the plan
(the approval may come hours later), runs
`npm dist-tag add @cleocode/<pkg>@<version> latest` for each package in publish
order (`@cleocode/cleo` last), and waits until `latest` resolves everywhere. A
failed move or an unconverged tag turns the run red and names the package;
re-run with the same version, and packages already moved are skipped.

**Promoting a hotfix.** Nothing extra. A release planned with
`cleo release plan … --hotfix` already carries `"cleo": { "hotfix": true }` in
its published manifest (release.yml writes it; T13184), and installed CLIs show
the stronger HOTFIX notice as soon as this promotion makes it `latest` (see
`docs/release/verb-matrix.md`).

Only the current canary can be promoted. If a newer release was published
before an older canary was promoted, promote the newer one. The exception is a
promotion already under way (some package that had an earlier version already
has `latest` at this one): a re-run finishes it without the canary check, so a
newer canary cannot strand `latest` half-moved.

A package's first-ever publish gets `latest` from the registry regardless of
`--tag canary` (npm tags a package's first version `latest`). That only matters
when `publish_pkg` gains a new package, and it never counts as a promotion
under way.

**4. Roll back.** Run the same workflow with the previous version:

```bash
gh workflow run release-promote.yml --ref main -f version=<previous version>
```

A version older than the current `latest` is a rollback: the canary
requirement does not apply, but the version must still resolve, pass the soak
and have a green verdict. The old tarballs never left the registry, so nothing
is republished and `latest` flips back as soon as the owner approves. The job
title on the approval screen says `ROLLBACK`.

**One-time setup (owner).**

1. On npmjs.com, create a granular access token with read and write access to
   the `@cleocode` packages (Packages and scopes: Read and write, scope
   `@cleocode`). If the packages or account require two-factor authentication
   for writes, the token must be allowed to bypass it, or `npm dist-tag add`
   fails with `EOTP`. Trusted publishing (OIDC) cannot do this: it covers
   `npm publish` only. Granular write tokens expire; note the date.
2. In the repository settings, create the environment `npm-promote`:
   required reviewer: the owner; deployment branches: `main` only. Add the
   token as the environment secret `NPM_TOKEN`, not as a repository secret.
   No other workflow may reference that environment or that secret
   (`scripts/__tests__/release-promote.test.mjs` fails if one does).
3. When the token expires, the `promote` job stops before moving anything
   ("npm rejected the token"); replace the environment secret and re-run.

## Operator Commands

### Add a PR to the merge queue

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

### Check queue status

```bash
# List PRs currently in the merge queue
gh api repos/:owner/:repo/pulls?state=open | \
  jq '.[] | select(.merge_queue_entry != null) | {number, title, merge_queue_entry: .merge_queue_entry.state}'
```

Or view the queue in the web UI:
- **Repository → Pull requests → Merge queue** (tab near the top).

You can also use `cleo orchestrate status --merge-queue` (when available) to
see a project-local summary of queued PRs and their CI state.

### Remove a PR from the queue

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

### View merge queue history

```bash
# Recent merge-group events (push to gh-readonly-queue/* branches)
gh api repos/:owner/:repo/events?per_page=30 | \
  jq '.[] | select(.type == "PushEvent") | select(.payload.ref | contains("gh-readonly-queue")) | {created_at, ref: .payload.ref, before, after}'
```

### Check a specific merge-group CI run

Merge-group builds appear in the Actions tab with branch names like
`gh-readonly-queue/main/pr-123-<sha>`.

```bash
# List recent merge-group runs
gh run list --branch "gh-readonly-queue/main" --limit 10

# View a specific run
gh run view <run-id>
```

---

## Zero-Admin-Merge Policy

**All PRs must pass CI. No bypass.**

This repository operates under a strict zero-admin-merge policy:

1. **No human clicks "Merge"** — once a PR is approved and CI-green, the
   author (or any collaborator) adds it to the merge queue.
2. **The queue is the only path to `main`** — every commit on `main` has
   passed CI on the exact merge commit, not just the PR branch tip.
3. **Admin bypass is audited** — repository admins can technically bypass
   the queue via **Admin merge** or `gh pr merge --admin`, but this is
   reserved for true break-glass scenarios. Any bypass must be logged in
   `.cleo/audit/force-bypass.jsonl` with:
   - PR number
   - Reason
   - Operator identity
   - Timestamp

   The release bump-PR is the one standing, owner-approved exception: it is
   admin-merged once its dispatched CI is green on the head SHA (see
   "Merging the bump-PR" above).

Consequences of bypassing:
- Unreviewed or broken code can reach `main`.
- The "green PR + stale main" race condition is reintroduced.
- Release automation (auto-tag, worktree cleanup) may behave unexpectedly
  because it expects the `merge_group` lifecycle.

---

## Troubleshooting

### Queue blocked — CI never starts

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

### Stuck PRs — fails in queue but passes on the PR branch

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

### Flake diagnosis — "Required status check "X" was not reported"

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

### Merge queue disabled / missing from UI

**Symptom:** No "Merge when ready" button; only "Merge pull request".

**Cause:** Merge queue is not enabled in repository settings, or the
branch protection rules do not require status checks.

**Fix:**
1. Re-run the setup steps in the Setup section above.
2. Ensure at least one status check is required by protection rules.

### Auto-tag workflow (`auto-tag-on-release-merge.yml`) not firing

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

### Worktree cleanup not running after merge-queue merge

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

## FAQ

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

### Q8: What is `cleo orchestrate status --merge-queue`?

**A:** When implemented, this command surfaces a project-local summary of
queued PRs, their CI state, and estimated time-to-merge. Until then, use
the `gh api` and web UI commands documented in the Operator Commands section.

---

## References

- `AGENTS.md` — Release & Branching (ADR-065) section
- `docs/release/branch-protection-setup.md` — Branch protection API commands
- `docs/release/verb-matrix.md` — Release verb surface
- `docs/release/job-inventory.md` — CI job inventory (includes `merge_group:` audit)
- GitHub Docs: [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
