---
covers:
  - packages/cleo/src/cli/commands/release.ts
  - packages/core/src/release/open.ts
  - packages/core/src/release/cut.ts
  - packages/core/src/release/smoke-receipt.ts
---
# CLEO Release Verb Matrix

**Status:** Live · **Owner:** Saga T10099 SG-RELEASE-AUDIT-V2 · **Task:** T10103

This document is the single source of truth for the `cleo release *` verb
surface and the state transitions each verb owns. It exists because the
v2026.5.100 ship required four manual interventions that the verb matrix
was supposed to prevent — and nobody could tell which verb was supposed
to own which transition. Saga T10099 closes those gaps.

After T10103 + T10104 + T10105 land, every state transition in the
release lifecycle is owned by exactly **one** verb (or one CI workflow).
No overlaps, no gaps.

## Current entry point: `cut`

`cleo release cut <ver>` is the normal release path (T14102 / ADR-099).
It selects the newest first-parent commit of `origin/main` with passing required
push checks, or verifies the supplied `--sha`, and previews the notes, packages,
migrations and task status. Without `--yes` it creates no tag. A confirmed cut
requires release authorization, configured `release.agentCut` permission or
terminal confirmation, creates an annotated tag
through the GitHub API, and lets `release.yml` publish and prepare the subsequent
CHANGELOG/version PR. The plan/open flow below remains a fallback.

A real cut requires the invoking checkout to be at `origin/main`. Stable cuts
also require `cleo docs rot --strict` to be clean and a passing real-store smoke
receipt for the exact selected commit; prereleases report those two findings as
warnings. A lower release still running blocks the cut unless explicitly allowed
with `--allow-in-flight`.

### Stable `open` smoke gate (T14250)

The fallback `open` path also enforces the smoke gate for versions without a
prerelease suffix. Before committing the plan or dispatching the workflow, it
resolves the remote head of `--ref` or the default dispatch branch through
`gh api` and reads `.cleo/release-smoke/<sha12>/results.json` under the canonical
project root. The receipt must contain that full `sha` and `passed: true`.
An unresolved head, missing or unreadable receipt, SHA mismatch, or failed smoke
returns `E_RELEASE_SMOKE_MISSING` without dispatching. A receipt for another
commit and green CI alone do not satisfy this gate. Prerelease `open` skips it.
On an already `pr-opened` row, a queued, running or successful recorded run still
returns the existing idempotent result; a failed run must clear the gate again
before re-dispatch.

Run `node scripts/release-mac-smoke.mjs --sha <full-sha>` on the owner's Mac at
that commit, fix forward if it fails, and retry against the resulting passing
commit. This receipt check is shared by `open` and `cut` in
`packages/core/src/release/smoke-receipt.ts`.

## Fallback lifecycle states

The plan/open fallback tracks state on a `releases` row keyed by version.
Valid `status` values (in lifecycle order):

> **Which workflows exist (checked 2026-11-14, T14108).** `release-publish.yml`
> is a shipped consumer template (`packages/core/templates/workflows/release-publish.yml.tmpl`);
> this repository has no `.github/workflows/release-publish.yml`. Here the tag
> push runs `release.yml`, which builds, publishes and opens the CHANGELOG
> PR; no workflow runs `cleo release reconcile`. Rows below that name
> `release-publish.yml` describe a consumer project that installed the
> templates.

### When provenance is reconciled

Every full merge sweep (the daemon loop, the throttled lazy sweep agents'
commands start, and the sweep `cleo release` runs before deciding what ships)
calls `reconcileLatestRelease` (`packages/core/src/release/reconcile-latest.ts`,
from `packages/core/src/tasks/merge-close.ts`). It looks at ONE tag: the newest
stable `vX.Y.Z` tag (no suffix) merged into `origin/main`. It reconciles that
tag when its `releases` row is not already `reconciled` and its GitHub Release
exists; with no GitHub Release yet it does nothing and the next sweep retries.

Run `cleo release reconcile <ver>` by hand when:

- the version is a prerelease (`-canary.N`, `-beta`, `-rc`, …): the sweep only
  reconciles stable tags;
- the version is an older stable tag: once a newer stable tag exists, the sweep
  never looks at it;
- the sweep's attempt failed: the sweep reports `action: failed` with the reason
  and keeps the row unreconciled;
- you need it now, without waiting for a sweep. A targeted sweep
  (`cleo done --from-merge <pr>`) and a dry run never reconcile.

| Order | `releases.status`   | Set by                                                          | Meaning |
|------:|---------------------|-----------------------------------------------------------------|---------|
|  0    | _(no row)_          | —                                                               | Version has never been planned |
|  1    | `planned`           | `cleo release plan`                                             | Plan envelope written; no git mutation, no workflow dispatch |
|  2    | `pr-opened`         | `cleo release open` → `release-prepare.yml`                     | Release branch cut, version bump + CHANGELOG committed, PR opened |
|  3    | `pr-merged`         | `release-publish.yml` (PR-merge trigger)                        | PR merged to `main`; lockfile + CHANGELOG live on `main` |
|  4    | `tag-pushed`        | **the operator, explicitly** (`git tag -a v<version> && git push origin v<version>`) | `v<version>` annotated tag created and pushed to `origin`. `auto-tag-on-release-merge.yml` was **retired** by T10434 / ADR-087: it tagged with `GITHUB_TOKEN`, and pushes made by that token do not reliably trigger the downstream `release.yml`, so the release silently never published. Pushing the tag by hand is the supported path (or `workflow_dispatch` on `release.yml` against a tag that already exists). |
|  5    | `published`         | `cleo release reconcile`                                        | 11 provenance tables backfilled; npm publish confirmed |
|  *    | `rolled-back`       | `cleo release rollback` / `rollback-full`                       | Metadata-only or full git-tag rollback |
|  *    | `cancelled`         | `cleo release cancel`                                           | Pre-merge cancellation (only valid from `planned` or `pr-opened`) |

## Verb-to-transition map

Each row names exactly one verb. The "Owns transition" column shows the
single state transition the verb is responsible for advancing. The
"Side-effects" column lists every mutation the verb makes outside the
in-memory plan envelope.

| Verb (`cleo release …`) | Owns transition           | Workflow it dispatches            | DB writes                                            | Side-effects                                                                 | Notes |
|-------------------------|---------------------------|------------------------------------|-------------------------------------------------------|------------------------------------------------------------------------------|-------|
| `cut <ver>` | Green default-branch commit → release tag | Tag creation triggers `release.yml` | Merge sweep and release-authorization bookkeeping; no plan row required | Previews by default; `--yes` creates the annotated tag, records the cut audit and runs merged-work cleanup | Normal path. Stable releases require clean docs rot and an exact-SHA passing smoke; required CI is rechecked immediately before tagging. |
| `write-changelog <ver>` | Tag changesets → CHANGELOG section | _(none; invoked by `release.yml`)_ | _(none)_ | Writes the missing version section in `CHANGELOG.md`, led by the tag annotation | Existing sections are left alone. `--ref` selects the release commit. |
| `verify-tag <ver>` | _(read-only validator)_ | _(none; invoked by `release.yml`)_ | _(none)_ | Verifies the tag is a green first-parent commit of the default branch | Refuses publication of a tag without the required passing push checks. |
| `authorize` | _(release permission, no lifecycle transition)_ | _(none)_ | Owner decision and signed grant/revocation records | Owner-only grant/revoke uses TTY authentication; `--list` reads grants | Scoped, expiring authorization permits a non-interactive `cut --yes`; it does not waive release gates. |
| `plan <ver> --epic` / `--saga` / `--tasks` | _(none)_ → `planned`      | _(none — read-mostly)_             | `releases` UPSERT (`status=planned`)                  | Writes `.cleo/release/<ver>.plan.json`; auto-writes `## [<ver>]` to `CHANGELOG.md` unless `--no-changelog` | Use `--tasks T9961,T9962` for cross-Epic release windows where one release intentionally spans multiple parent Epics (T10088). Owner of "always-write CHANGELOG" gap is **T10105**. A version that already shipped (`tagged`, `pushed`, `published`, `reconciled`) is refused, and the upsert never moves a row in an absorbing status (`RELEASE_ABSORBING_STATUSES`) back to `planned` even when a peer ships it mid-plan (T12943). |
| `open <ver>`            | `planned` → `pr-opened`   | `release-prepare.yml`              | `releases` UPDATE (`status=pr-opened`)                | **Commits the plan file** (`git add -f` past the `.cleo/` ignore), verifies it is present on the branch `workflow_dispatch` will check out, then `gh workflow run release-prepare.yml` with `version`, the scope, and `plan-blob-sha256`. | **The plan MUST be committed and pushed, and that is now the default (T12309).** The workflow's other branch regenerates the plan by running `cleo release plan --tasks|--epic` *on the runner* — and `.cleo/cleo.db` is untracked by design (ADR-013 §9), so a fresh checkout has no tasks and it exits `E_NOT_FOUND`, at `Prepare bump-PR`, after a full green preflight. `--no-commit-plan` opts out and is only correct when the plan is already on that branch. A `dispatch-preconditions` job now rejects the impossible combination in seconds rather than after ~20 minutes. **`--ref release/plan-<ver>` (T13825):** dispatch on the plan branch instead of the default branch, so ONE release PR carries the plan, CHANGELOG and version bump; implies `--no-commit-plan`. **Preflight reuse (T13140 · T13823):** `open` forwards `skip-tests` only with `reused-ci-run=<id>` and `verified-sha`, after finding a green main `ci.yml` push run for HEAD or a test-equivalent ancestor (release-plan files only); it waits up to 10 minutes for a queued run, and `release-prepare` re-reads that run before skipping the Linux shards. **Re-dispatch (T14077):** on a `pr-opened` row, a recorded run that failed, was cancelled, timed out or failed to start is dispatched again; a queued, running or green run stays idempotent (`priorRun` reports which). Owner of the `gh` schema mismatch gap is **T10105**. |
| `pr-status <ver>`       | _(read-only query)_       | _(none)_                           | _(none)_                                              | Calls `gh pr checks <num>` for the PR opened on `release/v<ver>`              | Polling helper — useful while `release-prepare.yml` is in-flight. |
| _(GH workflow)_         | `pr-opened` → `pr-merged` | `release-publish.yml` (on PR merge)| _(none — DB unchanged)_                               | Validates merged PR, fetches changelog                                       | Inventory owned by **T10102**. |
| _(operator)_            | `pr-merged` → `tag-pushed`| _(none — the tag push triggers `release.yml`)_ | _(none)_                          | `git tag -a v<ver> -m "Release v<ver>" && git push origin v<ver>`             | **Explicit since T10434 / ADR-087.** The old `auto-tag-on-release-merge.yml` is retired — see the lifecycle table above for why a `GITHUB_TOKEN` tag push does not start `release.yml`. |
| `reconcile <ver>`       | `tag-pushed` → `published`| _(none — invoked by `release-publish.yml`)_ | `commits`, `task_commits`, `commit_files`, `pull_requests`, `pr_commits`, `pr_tasks`, `releases`, `release_commits`, `release_changes`, `release_artifacts`, `brain_release_links` (11 tables) | Reads `gh api` + `git log`; no git mutations                                | Idempotent; single SQLite transaction. **Tag-driven path (DHQ-080 · T11977):** when no `.cleo/release/<ver>.plan.json` exists but the git tag is present, reconcile synthesises a minimal plan at runtime from CHANGELOG.md + merged PRs + git log. The synthesised plan carries `meta.origin = 'tag-reconcile-synthesized'` (distinguishable from honest plans). Use `--dry-run` to inspect the derivation without writing to DB. |
| `rollback <ver>`        | `*` → `rolled-back`       | _(none)_                           | `releases` UPDATE (`status=rolled-back`)              | Metadata-only — DOES NOT delete the git tag or revert commits                | "Soft" rollback. |
| `rollback-full <ver>`   | `*` → `rolled-back`       | _(none)_                           | `releases` UPDATE + row delete                        | Deletes `v<ver>` git tag locally + on `origin`; reverts the release commit    | "Hard" rollback (T820 RELEASE-05). |
| `cancel <ver>`          | `planned` or `pr-opened` → `cancelled` | _(none)_                | `releases` row delete                                 | Closes the open PR (if any) and removes the plan file                        | Only valid pre-merge. |
| `list`                  | _(read-only query)_       | _(none)_                           | _(none)_                                              | Reads `releases` table                                                       | — |
| `show <ver>`            | _(read-only query)_       | _(none)_                           | _(none)_                                              | Reads `releases` + provenance tables                                         | — |
| `channel`               | _(read-only query)_       | _(none)_                           | _(none)_                                              | Inspects current git branch to infer release channel                         | `latest` / `beta` / `alpha`. |
| `ship-e2e-smoke <ver>`  | _(validator — no DB writes)_ | _(none directly — invokes `plan` + `open` then polls)_ | _(none directly)_                                | Dry-run by default. With `--execute`: runs `plan` + `open`, then polls `gh pr` + `git ls-remote --tags` + `npm view` | Added by **T10103**. One-shot end-to-end validator. |
| `validate-changelog <ver>` | _(validator — no DB writes)_ | _(none)_                       | _(none)_                                              | Reads `CHANGELOG.md`; asserts canonical `## [<ver>]` header (ADR-028 §2.5)   | Added by **T9937** (Saga T9862). Replaces the brittle `grep -qF "## [VERSION]"` step in `release.yml`. |

`release-prepare` runs no macOS test shards, and `open` sends no macOS skip
(T14104): macOS is validated on main by `macos-main.yml` and on the owner's
Mac by `node scripts/release-mac-smoke.mjs --sha <full-sha>`. Since T14250, a
stable `open` requires the matching passing receipt before dispatch, and a
stable `cut` requires it before tagging.

## npm dist-tags and the CHANGELOG gate (`release.yml`)

`release.yml` picks the npm dist-tag from the version suffix:

| Version | Dist-tag | Notes |
|---|---|---|
| `X.Y.Z-canary.N` | `canary` | A `-canary` suffix without a number is refused. |
| `X.Y.Z-alpha…`, `X.Y.Z-dev…` | `dev` | |
| `X.Y.Z-beta…`, `X.Y.Z-rc…` | `beta` | |
| `X.Y.Z` (stable) | `latest` | First publishes `X.Y.Z-rc.ci.<run number>` to `canary`, proves it installs from npm and runs the sandbox soak, then publishes `X.Y.Z` to `latest` from the same commit (T13181). Both go through OIDC; no npm token. |

Before the GitHub Release is built, `release.yml` runs two CHANGELOG steps in
order: `cleo release write-changelog <ver>` writes the version section from the
changesets added since the previous tag (a tag from `cut` carries none;
T14102), then `cleo release validate-changelog <ver>` asserts the canonical
`## [<ver>]` header (T9937, ADR-028 §2.5). A plan-PR release already has the
section, and `write-changelog` leaves it alone.

## SPEC-T9345 status (sections 4 and 5, checked 2026-11-14)

`spec-t9345-release-pipeline-v2` is superseded by this document. Of its
normative sections, checked against the code:

- **Verbs (§4.2-4.5):** `plan`, `open`, `reconcile` and `rollback` exist as the
  fallback, with more scope options than the spec (`--saga`, `--tasks`,
  `--channel canary`, `--no-changelog`, `--skip-readiness` on `plan`; `--ref`,
  `--commit-plan` on `open`). `plan` refuses `E_DIRTY_TREE`, `E_EPIC_NOT_FOUND`,
  `E_EPIC_EMPTY` and `E_CHANNEL_MISMATCH`. `--dry-run` previews without writing;
  the spec's `CLEO_DRY_RUN=1` environment switch is not read.
- **Read verbs (§4.6):** only `cleo provenance backfill` and `cleo provenance
  verify` exist. `cleo release graph|diff|impact|authors|orphans` and the other
  `cleo provenance` reads were never built.
- **Error codes (§4.7):** exported constants in
  `packages/contracts/src/exit-codes.ts` that release modules emit:
  `E_PLAN_NOT_FOUND`, `E_WORKFLOW_NOT_FOUND`, `E_INVALID_STATE`,
  `E_GH_NOT_AUTHENTICATED`, `E_EPIC_NOT_FOUND`, `E_DIRTY_TREE`, `E_EPIC_EMPTY`,
  `E_CHANNEL_MISMATCH`. Emitted at runtime but with no exported constant:
  `E_TAG_NOT_FOUND`, `E_TAG_MISMATCH` and `E_PROVENANCE_FAILED`
  (`cleo release reconcile`, `release/reconcile.ts`) and `E_PROVENANCE_INCOMPLETE`
  (`cleo provenance verify`, `release/verify-provenance.ts`). Not emitted by any
  release verb: `E_TIMEOUT` (the spawn pipeline uses it, not release) and
  `E_INSUFFICIENT_SCOPE` (not used anywhere).
- **`release-prepare.yml` (§5.1):** `workflow_dispatch` only, with `version`
  and `plan-blob-sha256` (plus `epic`, `tasks`, `channel` and the preflight-reuse
  inputs) and concurrency `release-prepare-<version>` without cancel, as the
  spec requires. Its jobs are `dispatch-preconditions`, three split preflight
  jobs, `prepare` and `cleanup-on-failure`, not the spec's
  `preflight` → `prepare` → `notify`.
- **`release-publish.yml` (§5.2):** shipped as a consumer template only (see
  the note under the lifecycle states); this repository publishes from
  `release.yml` on the tag push.

The spec's remaining requirements (subprocess timeouts and kill paths, status
check names, failure artifacts) were not checked here.

## What was removed (DO NOT use)

These verbs no longer exist. Update any docs, scripts, or hot-keys that
still reference them.

| Removed verb                  | Removed in | Replacement                                                              |
|-------------------------------|-----------:|--------------------------------------------------------------------------|
| `cleo release ship`           |   T10103   | `cleo release cut <ver>`; plan/open remains the fallback     |
| `cleo release start`          |   T9540    | `cleo release plan` (Phase 1 of SPEC-T9345)                              |
| `cleo release verify`         |   T9540    | Per-task `cleo verify <task> --gate <g> --evidence …` (ADR-051)          |
| `cleo release publish`        |   T9540    | `release-publish.yml` GHA workflow (triggered by release-PR merge)       |
| `cleo release changelog <tag>`|   T9784    | `cleo changeset add` + `cleo release plan` (auto-writes CHANGELOG)       |

The deprecation shim for `ship` (a no-op forwarder added by T9538) was
held for three release cycles per SPEC-T9345 §12 R-420. T10103 deletes
the shim outright — the migration window is closed.

## Gap-closure ownership (Saga T10099)

The four manual interventions during v2026.5.100 mapped to four
specific gaps. Each gap is owned by exactly one sibling PR under this
saga:

| Manual intervention during v2026.5.100                                   | Root cause                                                | Closed by  |
|--------------------------------------------------------------------------|-----------------------------------------------------------|------------|
| Manual `gh workflow run release-prepare.yml`                             | `cleo release open` passed an unknown `--field` to `gh`   | **T10105** |
| Manual `git tag` + `git push --tags`                                     | No auto-tag workflow                                      | **T10104** |
| Manual `CHANGELOG.md` section append                                     | `cleo release plan` silent-skipped on changeset YAML errors | **T10105** |
| Manual `npm install -g` (pnpm i -g pointed at wrong store)               | No post-publish smoke that verifies install works         | **T10103** (this PR — via `ship-e2e-smoke`'s `verify-npm-published` step) |

Adjacent audits:
- **T10102** — 17-workflow inventory + dedup (catalogues every workflow
  the matrix above references).
- **T10106** — CI parity audit (verifies the GHA workflow surface
  matches the verb-matrix expectations job-by-job).

## Fallback smoke walker — `cleo release ship-e2e-smoke`

The smoke is dry-run by default. It walks every step of the release
fallback lifecycle and reports per-step status + duration so the operator can
diff a preview against a real run. Idempotent — re-runnable from any
failure point.

```bash
# Preview every step that WOULD run (no side effects)
cleo release ship-e2e-smoke v2026.6.0 --epic T10099

# Actually run the smoke — performs plan, open, then polls until tag
# + npm registry are live (default 30-min wall-clock budget)
cleo release ship-e2e-smoke v2026.6.0 --epic T10099 --execute

# Faster polling for CI/test environments
cleo release ship-e2e-smoke v2026.6.0 --epic T10099 --execute \
  --poll-interval-ms 1000 --total-timeout-ms 600000
```

Steps (in order):

1. `plan` — `cleo release plan <ver> --epic <id>` (writes `.cleo/release/<ver>.plan.json`)
2. `open` — `cleo release open <ver>` (commits the plan by default, verifies the remote copy, then dispatches `release-prepare.yml`).
   `open` does not push. The plan file must already reach `origin` before dispatch: the runner reads it from its own
   checkout, and it cannot rebuild one because the task store is untracked (T12309).
3. `wait-for-pr` — polls `gh pr list --head release/<ver> --state merged`
4. `wait-for-tag` — polls `git ls-remote --tags origin <ver>`
5. `verify-npm-published` — polls `npm view @cleocode/cleo@<ver-stripped> dist.tarball`

A failed step halts the walker. The envelope still reports every prior
step and the highest lifecycle state reached, so the operator can
resume from the failure point.

## Flagging a hotfix — release metadata (T13137 · T13184)

An installed CLI reads `@cleocode/cleo`'s dist-tags and the `latest` version's
registry manifest once a day (a detached background check; never on a
command's own path) and prints one stderr line when its channel tag (`latest`,
or `beta` for a beta/rc install) names a newer version. A release that fixes a
defect users must not keep running is planned as a hotfix:

```bash
cleo release plan v2026.X.Y --epic TXXXX --hotfix   # plan releaseKind: hotfix
```

release.yml's `Flag a hotfix release in the cleo manifest` step
(`scripts/mark-hotfix-release.mjs`) reads the committed plan and writes
`"cleo": { "hotfix": true }` into `@cleocode/cleo`'s package.json, so the flag
ships through the ordinary tokenless publish (npm Trusted Publishing cannot
move dist-tags, and nothing in the release path holds a token). No dist-tag
flags a hotfix, and there is no manual npm step.

Once the release publishes under `latest`, every installed CLI below it prints a
stronger HOTFIX notice (at most every 15 minutes) until it updates; installs
reach it within a day (their next check). The check remembers the highest
flagged version it has seen, so a later regular release does not hide a hotfix
an install is still missing. The flag only strengthens a notice that
`cleo self-update` can act on: it counts when it names a version above the
install and at or below the channel tag. A flag cannot be withdrawn after
publishing; the next release replaces it as `latest`. Users silence every
notice with `CLEO_NO_UPDATE_NOTICE=1`; CI runs never show one.

## Related docs

- [Branch protection setup](../guide/branch-protection-setup.md) — GitHub branch protection setup
- [Merge runbook](../guide/merge-runbook.md) — merging release and feature PRs
- [Pre-push reconcile gate](../spec/pre-push-reconcile-gate.md) — pre-push reconcile guard
- `AGENTS.md` "Release & Branching" — Operator-facing release flow
- [ADR-065](../adr/adr-065-pr-required-release-flow.md) — PR-required release flow
- [Consumer workflow and hook contract](../spec/consumer-workflow-hook-contract.md) — the shipped release workflow templates
- `packages/skills/skills/ct-release-orchestrator/SKILL.md` — Agent-facing release skill
