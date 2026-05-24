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

## Lifecycle states

The release pipeline tracks state on a `releases` row keyed by version.
Valid `status` values (in lifecycle order):

| Order | `releases.status`   | Set by                                                          | Meaning |
|------:|---------------------|-----------------------------------------------------------------|---------|
|  0    | _(no row)_          | —                                                               | Version has never been planned |
|  1    | `planned`           | `cleo release plan`                                             | Plan envelope written; no git mutation, no workflow dispatch |
|  2    | `pr-opened`         | `cleo release open` → `release-prepare.yml`                     | Release branch cut, version bump + CHANGELOG committed, PR opened |
|  3    | `pr-merged`         | `release-publish.yml` (PR-merge trigger)                        | PR merged to `main`; lockfile + CHANGELOG live on `main` |
|  4    | `tag-pushed`        | `auto-tag-on-release-merge.yml` (T10104) **or** `release-publish.yml` | `v<version>` annotated tag created and pushed to `origin` |
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
| `plan <ver> --epic`     | _(none)_ → `planned`      | _(none — read-mostly)_             | `releases` UPSERT (`status=planned`)                  | Writes `.cleo/release/<ver>.plan.json`; auto-writes `## [<ver>]` to `CHANGELOG.md` unless `--no-changelog` | Owner of "always-write CHANGELOG" gap is **T10105**. |
| `open <ver>`            | `planned` → `pr-opened`   | `release-prepare.yml`              | `releases` UPDATE (`status=pr-opened`)                | `gh workflow run release-prepare.yml` (passes version + plan path)            | Owner of the `gh` schema mismatch gap is **T10105**. |
| `pr-status <ver>`       | _(read-only query)_       | _(none)_                           | _(none)_                                              | Calls `gh pr checks <num>` for the PR opened on `release/v<ver>`              | Polling helper — useful while `release-prepare.yml` is in-flight. |
| _(GH workflow)_         | `pr-opened` → `pr-merged` | `release-publish.yml` (on PR merge)| _(none — DB unchanged)_                               | Validates merged PR, fetches changelog                                       | Inventory owned by **T10102**. |
| _(GH workflow)_         | `pr-merged` → `tag-pushed`| `auto-tag-on-release-merge.yml`    | _(none)_                                              | `git tag v<ver> && git push --tags`                                          | Workflow added by **T10104**. |
| `reconcile <ver>`       | `tag-pushed` → `published`| _(none — invoked by `release-publish.yml`)_ | `commits`, `task_commits`, `commit_files`, `pull_requests`, `pr_commits`, `pr_tasks`, `releases`, `release_commits`, `release_changes`, `release_artifacts`, `brain_release_links` (11 tables) | Reads `gh api` + `git log`; no git mutations                                | Idempotent; single SQLite transaction. |
| `rollback <ver>`        | `*` → `rolled-back`       | _(none)_                           | `releases` UPDATE (`status=rolled-back`)              | Metadata-only — DOES NOT delete the git tag or revert commits                | "Soft" rollback. |
| `rollback-full <ver>`   | `*` → `rolled-back`       | _(none)_                           | `releases` UPDATE + row delete                        | Deletes `v<ver>` git tag locally + on `origin`; reverts the release commit    | "Hard" rollback (T820 RELEASE-05). |
| `cancel <ver>`          | `planned` or `pr-opened` → `cancelled` | _(none)_                | `releases` row delete                                 | Closes the open PR (if any) and removes the plan file                        | Only valid pre-merge. |
| `list`                  | _(read-only query)_       | _(none)_                           | _(none)_                                              | Reads `releases` table                                                       | — |
| `show <ver>`            | _(read-only query)_       | _(none)_                           | _(none)_                                              | Reads `releases` + provenance tables                                         | — |
| `channel`               | _(read-only query)_       | _(none)_                           | _(none)_                                              | Inspects current git branch to infer release channel                         | `latest` / `beta` / `alpha`. |
| `ship-e2e-smoke <ver>`  | _(validator — no DB writes)_ | _(none directly — invokes `plan` + `open` then polls)_ | _(none directly)_                                | Dry-run by default. With `--execute`: runs `plan` + `open`, then polls `gh pr` + `git ls-remote --tags` + `npm view` | Added by **T10103**. One-shot end-to-end validator. |
| `validate-changelog <ver>` | _(validator — no DB writes)_ | _(none)_                       | _(none)_                                              | Reads `CHANGELOG.md`; asserts canonical `## [<ver>]` header (ADR-028 §2.5)   | Added by **T9937** (Saga T9862). Replaces the brittle `grep -qF "## [VERSION]"` step in `release.yml`. |

## What was removed (DO NOT use)

These verbs no longer exist. Update any docs, scripts, or hot-keys that
still reference them.

| Removed verb                  | Removed in | Replacement                                                              |
|-------------------------------|-----------:|--------------------------------------------------------------------------|
| `cleo release ship`           |   T10103   | `cleo release plan <ver> --epic <id>` then `cleo release open <ver>`     |
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

## Smoke walker — `cleo release ship-e2e-smoke`

The smoke is dry-run by default. It walks every step of the release
lifecycle and reports per-step status + duration so the operator can
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
2. `open` — `cleo release open <ver>` (dispatches `release-prepare.yml`)
3. `wait-for-pr` — polls `gh pr list --head release/<ver> --state merged`
4. `wait-for-tag` — polls `git ls-remote --tags origin <ver>`
5. `verify-npm-published` — polls `npm view @cleocode/cleo@<ver-stripped> dist.tarball`

A failed step halts the walker. The envelope still reports every prior
step and the highest lifecycle state reached, so the operator can
resume from the failure point.

## Related docs

- `docs/release/branch-protection-setup.md` — GitHub branch protection setup
- `docs/release/dep-pruning.md` — Dependency pruning before publish
- `docs/release/pre-push-reconcile-gate.md` — Pre-push reconcile guard
- `AGENTS.md` "Release & Branching" — Operator-facing release flow
- `.cleo/adrs/ADR-065-release-pipeline.md` — Design ADR
- `.cleo/specs/SPEC-T9345-release-pipeline-v2.md` — Detailed spec
- `packages/skills/skills/ct-release-orchestrator/SKILL.md` — Agent-facing release skill
