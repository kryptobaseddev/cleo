---
name: ct-release-orchestrator
description: "Orchestrates the canonical 4-verb release pipeline introduced by SPEC-T9345: cleo release plan, then cleo release open, then PR + GHA tag workflow, then cleo release reconcile. The deprecated cleo release ship monolith was deleted in T10103 — do not invoke it. Use ship-e2e-smoke to validate the full pipeline end-to-end (dry-run by default). The full verb-to-state map is in docs/release/verb-matrix.md. Use when shipping a new version, validating the release pipeline end-to-end, or promoting a completed epic to released status."
protocol: release
loomStage: release
adrRefs:
  - ADR-053
  - ADR-063
  - ADR-065
metadata:
  version: 3.0.0
  lastReviewed: 2026-05-22
  stability: stable
---

# Release Orchestrator

## Overview

Owns the canonical 4-verb release pipeline established by SPEC-T9345 and finalised when T9540 deleted the legacy `start` / `verify` / `publish` verbs (and the 12-step `releaseShip` monolith) plus T10103 deleted the deprecated `ship` shim. The current verb surface is documented in `docs/release/verb-matrix.md` — that file is the SSoT for verb-to-state mapping. This skill is the agent-facing entry point and references the matrix instead of redefining it.

## Core Principle

> Each verb owns exactly one state transition. No verb performs more than one mutation. Multi-step orchestration uses `ship-e2e-smoke` (validator) — never compose the verbs into a custom script.

## Canonical Pipeline

| Step | Verb / Workflow | Owns transition | Notes |
|-----:|------------------|------------------|-------|
| 1 | `cleo release plan <ver> --epic <id>` | _(none)_ → `planned` | Builds the Release Plan envelope; auto-writes `CHANGELOG.md` (T10105 closes the silent-skip gap) |
| 2 | `cleo release open <ver>` | `planned` → `pr-opened` | Dispatches `release-prepare.yml`; the workflow cuts the branch + opens the PR |
| 3 | _(GHA)_ `release-prepare.yml` → PR merge | `pr-opened` → `pr-merged` | Owned by CI; verify via `cleo release pr-status <ver>` |
| 4 | _(GHA)_ `auto-tag-on-release-merge.yml` (T10104) | `pr-merged` → `tag-pushed` | Auto-tag on merge — no manual `git tag` needed |
| 5 | `cleo release reconcile <ver>` | `tag-pushed` → `published` | Backfills 11 provenance tables; idempotent |

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
| RLSE-003 | All per-task evidence gates MUST be recorded via `cleo verify <task> --gate <g> --evidence …` BEFORE `cleo complete`. The legacy `cleo release verify` batch verb was deleted in T9540. | ADR-051 per-task evidence ritual. |
| RLSE-004 | The release MUST be tagged via the auto-tag GHA workflow — not a manual `git tag`. | T10104 closes the auto-tag gap. |
| RLSE-005 | Direct pushes to `main` are prohibited. Every release ships via a PR cut by `release-prepare.yml`. | ADR-065 + branch protection (see `docs/release/branch-protection-setup.md`). |
| RLSE-006 | Version MUST be consistent across all workspace targets resolved by `resolveVersionBumpTargets` (root package.json + every workspace package + Cargo workspace). | Version-bump preflight in `release-prepare.yml`. |
| RLSE-007 | Provenance reconcile MUST run within the release-publish workflow — never as a manual followup. | Invoked by `release-publish.yml`. |

## Integration

Use the explicit two-verb invocation. **Do not** invoke `cleo release ship` — it was deleted in T10103.

```bash
# 1. Plan — build the canonical Release Plan envelope.
cleo release plan v2026.6.0 --epic T10099

# 2. Open — dispatch release-prepare workflow.
cleo release open v2026.6.0

# 3. (Optional) Poll PR + CI status while the workflow runs.
cleo release pr-status v2026.6.0

# 4. Reconcile — runs automatically inside release-publish.yml.
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
- `56` — tag creation failed (auto-tag workflow).
- `82` — `E_PLAN_NOT_FOUND` (plan envelope missing for the requested version).
- `83` — `E_IVTR_INCOMPLETE` (per-task IVTR loops not released).
- `88` — artifact publish failed.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Running `cleo release ship` | The verb was deleted in T10103 — the command will exit with `Unknown command`. | Use `cleo release plan` + `cleo release open`. |
| Manually invoking `gh workflow run release-prepare.yml` | Bypasses the plan envelope; `releases.status` stays at `planned`. | Always go through `cleo release open <ver>` — it tracks state in the `releases` table. |
| Manually `git tag v<ver> && git push --tags` | Bypasses the auto-tag workflow (T10104) and skips provenance backfill. | Let `auto-tag-on-release-merge.yml` create the tag on PR merge. |
| Hand-editing `CHANGELOG.md` for the new version | Drift between the changeset directory and the changelog. | `cleo release plan` always auto-writes the section (T10105). Use `cleo changeset add` to author entries. |
| Pasting one verb into another's workflow file | Multi-step orchestration belongs in `ship-e2e-smoke`. | Use `cleo release ship-e2e-smoke … --execute` for end-to-end validation. |
| Running the pipeline on a dirty worktree | Release commit scoops up unrelated changes. | The clean-tree gate refuses to advance. |
| Skipping `cleo release reconcile` after a successful tag push | 11 provenance tables stay empty; canon drift. | `release-publish.yml` runs reconcile automatically — verify it ran via `cleo release show <ver>`. |

## Critical Rules Summary

1. The 4-verb pipeline — `plan`, `open`, `reconcile`, `rollback` — is the ONLY way to ship.
2. The deprecated `cleo release ship` shim was DELETED in T10103. Do not invoke it.
3. CalVer (`YYYY.MM.patch`) is the only valid version scheme.
4. `cleo release plan` always writes the CHANGELOG section unless `--no-changelog`.
5. The tag is created by `auto-tag-on-release-merge.yml`, not by hand.
6. Provenance reconcile is invoked by `release-publish.yml`, not manually (unless backfilling).
7. Per-task evidence gates use `cleo verify --gate --evidence` per ADR-051 — not the deleted batch verb.
8. Use `cleo release ship-e2e-smoke` to validate the full pipeline before a real ship.

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
