---
name: ct-release-orchestrator
description: "Orchestrates CLEO releases. Default (T14102): cleo release cut {version} tags the newest main commit with green CI, and release.yml writes the CHANGELOG from changesets, publishes, and opens an auto-merging CHANGELOG + version PR; cleo release reconcile records provenance. The SPEC-T9345 4-verb pipeline (cleo release plan, cleo release open, PR + tag) stays one release as a fallback (T14114). The deprecated cleo release ship monolith was deleted in T10103 — do not invoke it. Use ship-e2e-smoke to validate the full pipeline end-to-end (dry-run by default). The full verb-to-state map is in docs/release/verb-matrix.md. Use when shipping a new version, validating the release pipeline end-to-end, or promoting a completed epic to released status."
protocol: release
adrRefs:
  - ADR-053
  - ADR-063
  - ADR-065
metadata:
  version: 3.3.0
  tier: on-demand
  install: harness
  covers:
    - packages/core/src/validation/protocols/cant/release.cant
    - packages/core/src/validation/protocols/protocols-markdown/release.md
    - packages/cleo/src/cli/commands/release.ts
    - packages/core/src/release/cut.ts
  loomStage: release
  lastReviewed: 2026-10-28
  stability: stable
---

# Release Orchestrator

## Overview

Independent opt-in canaries use `--channel canary` with a numbered
`vYYYY.MM.N-canary.N` version. The OIDC workflow publishes this version only
to `canary`, verifies registry convergence and soaks the installed package.
It never continues to `latest`. Stable promotion is a separate normal release;
use `--hooks-v1-promotion` on the stable promotion plan; ordinary releases and
hotfixes are exempt. The promotion gate runs before GitHub Release creation.
That plan also makes `scripts/mark-hotfix-release.mjs` stamp
`cleo.releasedFeatures: ["hooks-v1"]` into `@cleocode/core`, which opens the
hooks-v1 runtime gate on the stable build (T13557); stable candidates without it
prove the runtime inert. hooks-v1 was promoted in v2026.10.17 and is released
in source since T13776 (`UNRELEASED_HOOK_FEATURES` is empty), so later releases
need neither the flag nor the stamp.
`cleo release plan` refuses a stable plan whose source opens that gate since the
previous tag (`hooks-v1` leaving the set, a changed `hooksV1Released`, a deleted
gate) with `E_HOOKS_V1_PROMOTION_REQUIRED`, unless it is the promotion or passes
`--hooks-v1-waiver "<reason>"`, which the plan and `.cleo/audit/hooks-v1-waiver.jsonl`
record (T13555). A release right after the promotion (its committed plan sets
`hooksV1Promotion`) is exempt, so the post-promotion removal needs no waiver.
The unified-hooks pilot must first supply hosted VidaPeps CI, read-only database
verification and live harness evidence bound to the exact canary source digest.
Source changes require fresh pilot evidence. Do not move npm tags manually.

Owns the canonical 4-verb release pipeline established by SPEC-T9345 and finalised when T9540 deleted the legacy `start` / `verify` / `publish` verbs (and the 12-step `releaseShip` monolith) plus T10103 deleted the deprecated `ship` shim. The current verb surface is documented in `docs/release/verb-matrix.md` — that file is the SSoT for verb-to-state mapping. This skill is the agent-facing entry point and references the matrix instead of redefining it.

## Core Principle

> Each verb owns exactly one state transition. No verb performs more than one mutation. Multi-step orchestration uses `ship-e2e-smoke` (validator) — never compose the verbs into a custom script. The one sanctioned end-to-end runner is `scripts/release-run.mjs` (below).

**Single release PR (T13825, owner choice 2026-10-16).** `node scripts/release-run.mjs <ver> --epic <id> --notes-review <file> [--execute]` runs plan → independent notes review (`{"reviewer","notesSha256","approved":true}` by someone other than the operator, for the plan's exact `meta.releaseNotes`) → `release/plan-<ver>` (one commit, plan + CHANGELOG.md, on the default branch's HEAD, made through the GitHub API) → `cleo release open <ver> --ref release/plan-<ver>` → waits for release-prepare and the bump PR's dispatched `CI` on its exact head → version-only assert against the merge-base → `gh pr merge --admin --merge --match-head-commit` plus the `.cleo/audit/force-bypass.jsonl` line → explicit `git tag -a` on the merge commit and push. The bump PR carries the plan and the bump. Dry-run by default; every step resumes on re-run. `--ref` alone dispatches on any plan branch; preflight skips carry over only when it adds release-plan files alone.

## One-command release (default, T14102)

```bash
cleo release cut v2026.10.28 --dry-run --lead lead.md   # commit, notes, packages, migrations, task status
cleo release cut v2026.10.28 --lead lead.md             # tags the commit; release.yml does the rest
cleo release reconcile v2026.10.28                      # after publish: provenance
```

- **Commit:** the newest first-parent commit of `origin/main` whose `CI` check run concluded `success`; `--sha` pins one, which must itself be green. Nothing reruns the test suites: CI already passed that tree.
- **Notes:** the changesets added since the previous release tag, led by `--lead` (stored as the tag annotation). A changeset no merged PR brought in is refused (`E_RELEASE_UNMERGED_CHANGESET`); no green commit is `E_RELEASE_NO_GREEN_COMMIT`.
- **Docs rot (T14111):** the dry run shows `cleo docs rot` findings; a real cut refuses with `E_DOCS_ROT` before tagging while any stale, duplicate or orphaned doc remains.
- **Task status is reported, never gated.** Green CI on the sha is the gate; a pending task does not block the cut.
- **Tag:** an annotated `v<ver>` made through the GitHub API with your `gh` token, which starts `release.yml`. It runs `cleo release write-changelog`, publishes, and on a stable release opens `release/v<ver>`, a CHANGELOG + version PR that auto-merges on green and never blocks the release.

The plan/open pipeline below stays for one release as a fallback; T14114 deletes it.

## Canonical Pipeline

| Step | Verb / Workflow | Owns transition | Notes |
|-----:|------------------|------------------|-------|
| 1 | `cleo release plan <ver> --epic <id>` | _(none)_ → `planned` | Builds the Release Plan envelope; auto-writes `CHANGELOG.md` (T10105 closes the silent-skip gap). stdout is the one envelope, and the readiness report goes to stderr (T13322). A `--tasks` plan records `epicId: null`, and each task keeps its own `epicAncestor` (T13323) |
| 2 | `cleo release open <ver>` | `planned` → `pr-opened` | Dispatches `release-prepare.yml` with the plan's sha256 once the plan is verified on the default branch, plus the verified preflight skips; the workflow cuts the branch + opens the PR |
| 3 | _(GHA)_ `release-prepare.yml` → PR merge | `pr-opened` → `pr-merged` | Owned by CI; verify via `cleo release pr-status <ver>` |
| 4 | `git tag -a v<ver> -m "Release v<ver>" && git push origin v<ver>` | `pr-merged` → `tag-pushed` | Explicit tag after the release PR merges — `auto-tag-on-release-merge.yml` is retired (T10434, ADR-087); the tag push triggers `release.yml` |
| 5 | `cleo release reconcile <ver>` | `tag-pushed` → `published` | Backfills 11 provenance tables; idempotent |
| 6 | _(GHA)_ `release.yml` Publish: release candidate gate | `<ver>-rc.ci.<n>` on `canary` → `<ver>` on `latest` | Automatic, OIDC only, no token (T13181). The candidate must install from npm and pass the sandbox soak (`scripts/release-canary-soak.mjs`) before the release publishes to `latest`; a failed gate leaves users on the previous release, and a re-run of the failed job continues. No dist-tag is ever moved by hand: a bad release is fixed forward with the next patch. Runbook: `docs/release/merge-queue-runbook.md`, "Release candidate gate" |

Optional validators (read-only / dry-run):

| Verb | Use |
|------|-----|
| `cleo release ship-e2e-smoke <ver> --epic <id>` | One-shot end-to-end smoke. Dry-run by default; `--execute` performs real mutations. T10103. |
| `cleo release pr-status <ver>` | Poll release PR CI checks while waiting |
| `cleo release list` / `show <ver>` | Read-only inspection |

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| RLSE-001 | Version MUST be CalVer (`YYYY.MM.patch`) per ADR-065 — never SemVer. | `cleo release plan` rejects non-CalVer; exit 53. |
| RLSE-002 | `CHANGELOG.md` MUST be updated before the tag — always-write is the default behaviour of `cleo release plan` (T9784 deleted the manual changelog verb). | Plan envelope refuses to advance to `pr-opened` if the changeset directory is unparseable (T10105). |
| RLSE-003 | All per-task evidence gates MUST be recorded via `cleo verify <task> --gate <g> --evidence …` BEFORE `cleo complete`. The legacy `cleo release verify` batch verb was deleted in T9540. | ADR-051 per-task evidence ritual. | <!-- cleo-cmd: negative-example: release verify -->
| RLSE-004 | The release MUST be tagged explicitly: by `cleo release cut` (API tag on the green sha), or on the fallback path with `git tag -a v<ver>` + `git push origin v<ver>` after the release PR merges. | Auto-tag was retired in T10434 / ADR-087: `GITHUB_TOKEN` tag pushes did not reliably trigger `release.yml`. |
| RLSE-005 | Direct pushes to `main` are prohibited. A cut release reaches main's CHANGELOG and versions through `release.yml`'s auto-merging `release/v<ver>` PR; the fallback path through the PR `release-prepare.yml` cuts. | ADR-065 + branch protection (see `docs/release/branch-protection-setup.md`). |
| RLSE-006 | Version MUST be consistent across all workspace targets resolved by `resolveVersionBumpTargets` (root package.json + every workspace package + Cargo workspace). | Version-bump preflight in `release-prepare.yml`. |
| RLSE-007 | Provenance reconcile MUST run within the release-publish workflow — never as a manual followup. | Invoked by `release-publish.yml`. |

## Integration

Use the explicit verbs. **Do not** invoke `cleo release ship` — it was deleted in T10103. <!-- cleo-cmd: negative-example: release ship -->

```bash
# 1. Plan — build the canonical Release Plan envelope.
cleo release plan v2026.6.0 --epic T10099

# 2. Open — dispatch release-prepare workflow. When the plan reached main
#    through a release-plan PR (branch protection), open it with
#    --no-commit-plan: the plan on main is verified (read from there if this
#    checkout lacks it) and dispatched by its sha256 (T13050).
cleo release open v2026.6.0 --no-commit-plan

# 3. (Optional) Poll PR + CI status while the workflow runs.
cleo release pr-status v2026.6.0

# 4. After the release PR merges, tag explicitly (auto-tag is retired).
git tag -a v2026.6.0 -m "Release v2026.6.0"
git push origin v2026.6.0

# 5. Reconcile — runs automatically inside release-publish.yml.
#    Run manually only if backfilling a historical release.
cleo release reconcile v2026.6.0
```

To validate the whole pipeline end-to-end without shipping a real release:

```bash
# Dry-run preview — no side effects.
cleo release ship-e2e-smoke v2026.6.0 --epic T10099

# Execute mode — runs plan + open, then polls for PR merge, tag push,
# and npm publish (default 30-min wall-clock budget).
cleo release ship-e2e-smoke v2026.6.0 --epic T10099 --execute
```

Exit codes (canonical):

- `0` — success.
- `53` — version validation failed (e.g. not CalVer).
- `54` — release-prepare workflow gate failed.
- `56` — tag creation failed.
- `82` — `E_PLAN_NOT_FOUND` (plan envelope missing for the requested version).
- `83` — `E_IVTR_INCOMPLETE` (per-task IVTR loops not released).
- `88` — artifact publish failed.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Running `cleo release ship` | The verb was deleted in T10103 — the command will exit with `Unknown command`. | Use `cleo release plan` + `cleo release open`. | <!-- cleo-cmd: negative-example: release ship -->
| Manually invoking `gh workflow run release-prepare.yml` | Bypasses the plan envelope; `releases.status` stays at `planned`; a hand dispatch also drops the verified `skip-tests` / `verified-sha` inputs, so the whole Linux and macOS suites run again (v2026.10.3 lost ~45 min). | Always go through `cleo release open <ver>` (`--no-commit-plan` after a plan PR) — it tracks state in the `releases` table and forwards the preflight skips. |
| Tagging before the release PR merges, or `git push --tags` | Tags an unmerged commit, or pushes every local tag. | Tag the merged release commit and push that one tag: `git push origin v<ver>`. |
| Hand-editing `CHANGELOG.md` for the new version | Drift between the changeset directory and the changelog. | `cleo release plan` always auto-writes the section (T10105). Use `cleo changeset add` to author entries. |
| Pasting one verb into another's workflow file | Multi-step orchestration belongs in `ship-e2e-smoke`. | Use `cleo release ship-e2e-smoke … --execute` for end-to-end validation. |
| Running the pipeline on a dirty worktree | Release commit scoops up unrelated changes. | The clean-tree gate refuses to advance. |
| Skipping `cleo release reconcile` after a successful tag push | 11 provenance tables stay empty; canon drift. | `release-publish.yml` runs reconcile automatically — verify it ran via `cleo release show <ver>`. |

## Critical Rules Summary

1. The 4-verb pipeline — `plan`, `open`, `reconcile`, `rollback` — is the ONLY way to ship.
2. The deprecated `cleo release ship` shim was DELETED in T10103. Do not invoke it. <!-- cleo-cmd: negative-example: release ship -->
3. CalVer (`YYYY.MM.patch`) is the only valid version scheme.
4. `cleo release plan` always writes the CHANGELOG section unless `--no-changelog`.
5. The tag is created explicitly after the release PR merges; `auto-tag-on-release-merge.yml` is retired (T10434, ADR-087).
6. Provenance reconcile is invoked by `release-publish.yml`, not manually (unless backfilling).
7. Per-task evidence gates use `cleo verify --gate --evidence` per ADR-051 — not the deleted batch verb.
8. Use `cleo release ship-e2e-smoke` to validate the full pipeline before a real ship.
9. A stable release reaches `latest` only through release.yml's release candidate gate (T13181). If the gate fails, the release is not shipped to users: re-run the failed Publish job or fix forward; never move `latest` by hand (there is no npm token).

## CI Job Inventory

The authoritative reference for every job that runs in this repo's GitHub Actions pipeline — including which jobs run on PR-to-main vs push-to-main vs tag-push, branch-protection cross-check, and documented divergences — lives at:

- [docs/release/job-inventory.md](../../../../docs/release/job-inventory.md) (T10106 · Saga T10099)

Consult the inventory whenever:

1. A release verb fails CI and you need to know which gate is blocking.
2. Branch-protection required status checks need to be reconciled against actual workflow jobs.
3. A new workflow is added or an existing trigger changes — regenerate the matrix per the "How this document is maintained" section at the bottom of the inventory.

## See also / References

This skill binds to the **release** LOOM lifecycle stage. Governing ADRs:

- [ADR-053 — project-agnostic release pipeline](../../../../.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md) — language-agnostic version bump → changelog → tag flow.
- [ADR-063 — release pipeline](../../../../.cleo/adrs/ADR-063-release-pipeline.md) — original 12-step pipeline (historical; superseded by SPEC-T9345 §4).
- [ADR-065 — PR-required release flow](../../../../.cleo/adrs/ADR-065-pr-required-release-flow.md) — direct pushes to `main` are prohibited.

Live verb matrix: [docs/release/verb-matrix.md](../../../../docs/release/verb-matrix.md) — the single source of truth for verb-to-state mapping.

LOOM coverage matrix: [docs/skills/loom-coverage-matrix.md](../../../../docs/skills/loom-coverage-matrix.md).
