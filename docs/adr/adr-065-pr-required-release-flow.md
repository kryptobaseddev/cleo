# ADR-065: PR-Required Release Flow

- **Status**: Accepted
- **Date**: 2026-05-07
- **Tasks**: T9093, T9094, T9095, T9096
- **Supersedes**: Manual push-to-main release steps in `docs/RELEASING.md` (pre-v2026.5.43)
- **Extends**: ADR-063 (Canonical Release Pipeline)

## Context

The v2026.5.x series exposed a recurring pattern: CI failures on `main` required emergency
patch releases (v2026.5.39 through v2026.5.42). Each patch was needed because the previous
release was cut directly from `main` without a review gate. Direct pushes to `main` meant:

- Broken state landed on the default branch immediately
- There was no window to catch issues before the tag was applied
- CHANGELOG entries accumulated across retries, causing duplicate sections
- The release tooling had no hook to enforce green CI before tagging

The existing ADR-063 pipeline (`cleo release start` → `verify` → `publish` → `reconcile`)
established the correct primitives but left `cleo release ship` as a direct-push shortcut
that bypassed the branch+PR model.

## Decision

All releases MUST be shipped through a `release/v<version>` branch + PR + green CI before
merging to `main` and tagging. This is enforced by `releaseShip()` in
`packages/core/src/release/engine-ops.ts`.

### 12-Step Pipeline (T9095)

`cleo release ship <version> --epic <epicId>` executes:

1. **Prepare** — validate version, resolve epic, write handle
2. **Quality gates** — lint, typecheck, tests via ADR-061 tool resolution
3. **IVTR loop check** — block if any child task has an incomplete IVTR
4. **Epic completeness** — all child tasks must have passed gates
5. **Double-listing guard** — reject if version already exists in CHANGELOG
6. **CHANGELOG generation** — filter tasks by `completedAt > previousVersion.pushedAt` (T9094)
7. **Biome lint pass** — CHANGELOG and version bump files pass format check
8. **Cut release branch** — `git checkout -b release/v<version>`
9. **Commit** — `chore(release): v<version>` with CHANGELOG + version bump
10. **Push + open PR** — `gh pr create` targeting `main` with generated body
11. **Wait for CI** — polls `gh pr checks` every 30s, 15-minute timeout
12. **Merge + tag + cleanup** — `gh pr merge --merge`, `git tag v<version>` on `main`, delete release branch

### New Command: `cleo release pr-status <version>`

Returns `PRCheckStatus[]` for all CI checks on the in-progress release PR.
Useful for monitoring or scripting CI wait logic externally.

### Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `release.branchModel` | `feat-to-main` | Branch strategy for releases |
| `release.prRequired` | `true` | Cannot be overridden to `false` |
| `release.releaseBranchPrefix` | `release/` | Prefix for auto-cut release branches |

`release.prRequired` has no override path. There is no `--no-pr` flag and no
`--direct` escape hatch. This is intentional.

### CHANGELOG Deduplication (T9094)

`prepareRelease()` filters candidate tasks using `completedAt > previousVersion.pushedAt`.
This prevents tasks completed in prior releases from appearing again when a patch release
is cut. Sections for v2026.5.39–v2026.5.42 were retroactively deduplicated when this
fix landed.

## Consequences

### Positive

- Broken-`main` category of bugs is eliminated: CI must be green before `main` advances
- CHANGELOG deduplication is enforced programmatically, not by convention
- SHA history is preserved via `--merge` (not squash/rebase) — git log traceability intact
- `cleo release pr-status` gives agents a hook to poll without needing gh CLI directly
- Compatible with ADR-055 (worktree-by-default): release branch is just another branch

### Negative / Trade-offs

- `gh` CLI must be authenticated — `gh auth status` is now a hard prerequisite for releasing
- Releases take longer: minimum CI runtime (~5–10 min) is added to the wall-clock time
- The 15-minute CI wait is a hard timeout; very slow CI pipelines will need `release.ciTimeoutMs` tuned

### Migration

- No existing API surface removed. `cleo release ship` behavior changed in-place.
- Operators using scripted `git push origin main && git tag ...` flows must migrate to
  `cleo release ship` or open PRs manually.

## References

- T9093 — Epic: Release pipeline overhaul
- T9094 — Changelog dedup + retroactive prune
- T9095 — Branch model config + PR-required release ship flow + pr-status command
- T9096 — Documentation sweep + branch protection + ship v2026.5.43 through new flow
- ADR-051 — Evidence-based gate ritual
- ADR-055 — Worktree-by-default
- ADR-062 — Worktree merge via --no-ff (not cherry-pick)
- ADR-063 — Canonical release pipeline
