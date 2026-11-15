---
covers:
  - .github/workflows/release-prepare.yml
  - packages/core/src/release/preflight-skip.ts
---
# Merge Runbook

> **Owner:** Saga T10431 · **Tasks:** T13480, T14101, T14122, T14143

How a PR reaches `main` in this repository, how a merged PR closes its tasks,
and how the release bump-PR is merged. There is **no GitHub Merge Queue**: this
is a personal-account repository, where GraphQL `repository.mergeQueue` is
`null` (T13480 · #1268). `ci.yml` and a few other workflows still declare
`merge_group:`; nothing fires it.

---

## How a PR merges

1. **Branch.** Work on `feat/T####-<slug>` or `task/T####-<slug>` (agents: in
   their CLEO worktree). Never push to `main`.
2. **Open a ready PR to `main`.** Its body names the tasks it delivers, one
   line per task (ADR-099):
   - `Closes: T#### AC1,AC2` completes the task once the merged PRs that name
     it cover every criterion.
   - `Refs: T#### AC1` binds those criteria and leaves the task open (partial
     delivery). A bare `Refs: T####` with no criteria is malformed.

   `pr-task-lines.yml` flags a PR whose body names no task or whose lines are
   malformed. It is a flag, not a merge gate (exempt: `release/*`, bot authors,
   the `no-task` label).
3. **Required checks.** Branch protection on `main` requires `CI` and
   `Contracts Dep Lint`, with `strict: false` (owner decision D11250, T14589).
   `Contracts Dep Lint` runs on every CI run (the `contracts-dep-lint` job in
   `ci.yml` has no `if:` or `needs:`), so requiring it cannot strand a PR. A PR
   merges once both checks are green on its own head, without re-running after
   every other merge. Main-push CI catches a
   break that only the combination of two PRs causes. Setup commands:
   [`branch-protection-setup.md`](./branch-protection-setup.md).
4. **Independent review.** A reviewer who is not an author of the task records
   a verdict per criterion on the PR's current head:

   ```bash
   cleo review packet <pr> --task T####            # the diff and criteria, PR prose withheld
   cleo review verdict <pr> --task T#### --ac AC1 --met --reason "..." --packet <packetSha256>
   cleo review check <pr> --task T####             # exits 1 while any criterion lacks a met verdict
   ```

   A new push moves the head, and verdicts on the old head no longer count.
5. **Pre-merge status.** The store owner's sweep sets the `cleo/merge-close`
   commit status on each open PR's head: green when every named criterion is
   known and has a met verdict on that head (and, for `Closes:`, every
   criterion is bound), otherwise red with the reason (for example
   `T#### AC4: no verdict on head <sha>`). It is not a required check; it shows
   before merge whether the merge will close anything. Check the same thing
   locally with `cleo done --from-merge <pr> --dry-run`.
6. **Merge** serially once `CI` and `Contracts Dep Lint` are green on the PR
   head. A repo admin can merge without them (`enforce_admins: false`,
   T12152): that is the owner's escape hatch, used for the release bump-PR below and otherwise only as an audited
   break-glass step (log it in `.cleo/audit/force-bypass.jsonl` with PR,
   reason, operator and time).

## How a merged PR closes its tasks (merge sweep, T14101)

- On merge, `merge-close.yml` runs `cleo done --from-merge <pr> --receipt
  --comment`: it judges the PR without a task store and posts a receipt comment
  (the tasks named, and whether the required checks were green on the exact
  head). CI never writes to a task store.
- The store owner's machine applies the receipt (`sweepMergedClosures` in
  `packages/core/src/tasks/merge-close.ts`): from the daemon loop, lazily from
  `cleo briefing`, `next`, `current`, `show` and `release`, or by hand with
  `cleo done --from-merge <pr>` (or `all`). It re-derives everything from `gh`
  and records through the same path as `cleo done --pr`, so `pr:`, `ci:` and
  reviewer-bound `satisfies:` evidence land without an agent step.
- Each applied line writes one `merge_close` audit row keyed by PR, merge
  commit and task, so a rerun records nothing twice. A PR merged with red `CI`,
  no task lines, malformed lines or missing verdicts closes nothing, and its
  receipt says why.

---

## The bump-PR opens with zero checks (T12094 — fixed)

**Symptom.** `release-prepare` completes, the bump-PR exists, and it has *no*
checks at all. Branch protection on `main` requires the `CI` and
`Contracts Dep Lint` contexts, so the PR
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
- This is the ONE sanctioned use of `--admin` (owner-approved; `enforce_admins: false` is the intended escape hatch,
  T12152). Record it in `.cleo/audit/force-bypass.jsonl` like any other bypass,
  with reason `release bump-PR: dispatched CI green on <sha>`.
- `cleo release open` does not watch or merge the bump-PR (it dispatches
  `release-prepare` and returns). `scripts/release-run.mjs` automates this
  procedure end to end (T13825, next section).

## One release PR, scripted (T13825)

```bash
node scripts/release-run.mjs v2026.X.Y --epic T#### --notes-review review.json            # dry run
node scripts/release-run.mjs v2026.X.Y --epic T#### --notes-review review.json --execute
```

It runs these steps in order:

1. `cleo release plan`.
2. It checks the independent notes review. `review.json` is
   `{"reviewer", "notesSha256", "approved": true}`, written by someone other
   than `--operator` (default `git config user.name`) for the plan's exact
   `meta.releaseNotes`. Without it the run stops with exit 3 and prints the
   hash to review.
3. It creates `release/plan-<v>`: one commit on main's HEAD holding the plan and
   CHANGELOG.md, made through the GitHub API, so nothing is pushed to main.
4. `cleo release open <v> --ref release/plan-<v>`. release-prepare cuts
   `release/<v>` from the plan branch, so the bump PR carries the plan and the
   bump. There is no separate plan PR.
5. It waits for release-prepare, then for the dispatched `CI` run on the bump
   PR's exact head.
6. It asserts the PR is version-only against its merge-base
   (`ci-detect-version-only.mjs`, which accepts the plan file, T13824).
7. It merges with `gh pr merge --admin --merge --match-head-commit <head>` and
   appends the `.cleo/audit/force-bypass.jsonl` line.
8. It runs `git tag -a` on the merge commit and pushes the tag.

Preflight skips carry over to the plan branch only when it adds release-plan
files alone (`retargetPreflightSkips`). The workflow re-verifies the reused run
(T13823). A re-run resumes from the first step not yet done.

## Preflight test skips and native binary reuse

Two mechanisms keep the release off the slow path when nothing new would be
learned. Both are recorded where an operator can see them.

- **Preflight test skips.** `cleo release open` checks main's HEAD SHA with
  `gh` (each call bounded to 15s). If the `ci.yml` push run for that exact SHA
  is green AND its Linux `Unit Tests` shards all ran and succeeded (a green
  docs-only push skips them, and does not qualify) it dispatches
  `release-prepare` with `skip-tests=true`. `release-prepare` runs no macOS
  shards at all (T14104): macOS is validated on main by `macos-main.yml`
  (every push, nightly, on demand; a failure files a `macos-regression`
  issue) and on the owner's Mac by `node scripts/release-mac-smoke.mjs`
  before the tag. The SHA goes along as `verified-sha`, and the
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

## Release candidate gate: canary first, then latest (T13144, T13181)

A stable release reaches users only after its release candidate has been
installed from npm and checked. Everything runs inside `release.yml`, through
npm trusted publishing (OIDC). There is no npm token, no approval environment
and no dist-tag move anywhere.

For a tag `v2026.X.Y`, the Publish job:

1. publishes every package as `2026.X.Y-rc.ci.<run number>` under the `canary`
   dist-tag, from the tagged commit's build. pnpm pins each @cleocode
   dependency at the candidate's exact version, so the candidate is a coherent
   set;
2. proves the candidate installable from npm: `scripts/execute-payload.mjs`
   checks metadata, tarball and `dist-tags.canary` for every package (15 minute
   budget);
3. installs `@cleocode/cleo@2026.X.Y-rc.ci.<n>` from npm into a sandbox and runs
   the health checks (`scripts/release-canary-soak.mjs`: coherent @cleocode
   versions, `--version`, `init`, `session start`, a saga and epic write,
   `show`, `find`, `doctor`);
4. only if both pass, publishes `2026.X.Y` under `latest` from the same commit.

Steps 2 and 3 are blocking: a failure stops the job before `latest` is touched,
and users keep the previous release. The Post-Deploy and Release Verdict jobs
then verify `2026.X.Y` under `latest` as before. Prereleases (`-beta`, `-dev`)
skip the candidate and publish to their own tags directly.

**Re-runs.** The candidate's number is the run number, so re-running failed
jobs of the same run reuses the same candidate and skips every package already
published. A registry that has not finished propagating the candidate inside
the 15 minute budget (it has happened for `@cleocode/cleo`) fails step 2; re-run
the failed job later and it continues from there. A re-run after `2026.X.Y`
itself published skips the candidate.

**Try a candidate yourself.** `npm i -g @cleocode/cleo@canary` installs the
newest candidate; `node scripts/release-canary-soak.mjs` (or `--version
2026.X.Y-rc.ci.<n>`) runs the same health checks in a sandbox.

**Rolling back.** Without a token, `latest` cannot be moved by hand. A bad
release is fixed forward: revert or fix on main and ship the next patch version,
which goes through the same candidate gate. A package's first-ever publish gets
`latest` from the registry regardless of `--tag canary` (npm tags a package's
first version `latest`): when a package is added to `publish_pkg`, its first
candidate is that package's `latest` until the final phase publishes the release,
so never add a new package in a hotfix. The automatic candidate is
`-rc.ci.<run number>`, so it cannot collide with a hand-cut `-rc.N` prerelease tag
(which publishes to `beta`).

**Hotfixes.** Plan the release with `cleo release plan … --hotfix`. release.yml
writes `"cleo": { "hotfix": true }` into `@cleocode/cleo`'s package.json from
the committed plan (T13184), so the `latest` publish carries the flag, and
installed CLIs show the stronger HOTFIX notice once it is `latest` (see
[`verb-matrix.md`](../reference/verb-matrix.md)). Nothing else is needed.

## Troubleshooting

### `cleo/merge-close` is red on a green PR

Read its description: a missing, unmet or stale verdict, an unknown task or
criterion, or a malformed line. Fix the body (`gh pr edit <pr> --body-file
...`) or get a verdict on the current head, then re-check with
`cleo done --from-merge <pr> --dry-run`. After a push, verdicts must be
recorded again on the new head.

### PR `CI` tested an old `main`

A PR run tests the merge ref GitHub built when the run started. A rerun or a
close-and-reopen keeps that ref; updating the branch (`gh pr update-branch` or
a rebase and push) builds a fresh one. Read the checkout step to see which
`main` was tested.

### A unit shard is red but every test passed

The flaky-quarantine budget (more than 10 quarantined tests) fails main's CI;
see "Flaky tests" above. Fix one flake, close its issue, then rerun.

### Merged, but the task stayed open

Run `cleo done --from-merge <pr> --dry-run`. Typical causes: a `Refs:` line
(partial by design), a criterion with no met verdict on the merged head, red
`CI` on that head, or criteria still unbound by any merged PR. A PR merged
before the sweep existed is closed with `cleo done <id> --plan`, then
`cleo verify` and `cleo complete`.

### Worktree not removed after merge

`worktree-cleanup.yml` runs on `pull_request: closed` with `merged == true` and
on pushes to `main`, and runs `cleo worktree destroy <taskId>` for each task id it finds. Check its run log. Every removal goes through `disposeWorktree`, which keeps a worktree that holds anything not proven safe to delete.

---

## References

- `AGENTS.md` — Release & Branching (ADR-065 · ADR-087) section
- [`branch-protection-setup.md`](./branch-protection-setup.md) — branch protection API commands
- [`verb-matrix.md`](../reference/verb-matrix.md) — release verb surface
- [`pr-cadence.md`](../spec/pr-cadence.md) — task-to-PR-to-release traceability (ADR-099)
- `packages/core/src/tasks/merge-close.ts` — sweep, receipt and pre-merge status
