# ADR-053: Project-Agnostic Release Pipeline (T820)

**Status**: Accepted  
**Date**: 2026-04-17  
**Author**: CLEO Worker (T820 impl)  
**Task**: T820 and children T821-T827

---

## Context

Prior to T820, `cleo release ship` was hardcoded to the cleocode monorepo:
- `loadReleaseConfig` read exclusively from `.cleo/config.json` using dotted paths (`release.versioning.scheme`, etc.)
- No `.cleo/release-config.json` existed as a first-class project-level override
- `releaseRollbackFull` was a stub that only flipped the DB record, ignoring git tags and commits
- `releaseChangelogSince` delegated to `releaseChangelog` without any git log parsing
- IVTR state was never checked before allowing `cleo release ship` to proceed
- No downstream project fixture existed to prove project-agnosticism

Six releases in a row (v2026.4.66-71) were shipped by bypassing `cleo release ship` entirely via raw `git tag + GitHub Actions`, confirming the tool was unusable for real projects.

---

## Decision

### RELEASE-01: `.cleo/release-config.json` as canonical config source

`loadReleaseConfig(cwd)` now reads from `.cleo/release-config.json` first (flat JSON), falling back to `.cleo/config.json` nested keys for legacy compatibility. The flat config supports:

```json
{
  "versionScheme": "semver",
  "tagPrefix": "v",
  "gitWorkflow": "pr",
  "registries": ["npm"],
  "buildArtifactPaths": ["dist/"],
  "skipBuildArtifactGate": false,
  "artifactType": "npm-package",
  "security": { "enableProvenance": true, "slsaLevel": 3, "requireSignedCommits": false }
}
```

`getPushMode(config)` now prioritizes `config.gitWorkflow` over the legacy `config.push.mode`.

`validateReleaseConfig` gained two new checks:
- Rejects invalid `gitWorkflow` values (only `'direct' | 'pr' | 'auto'` allowed)
- Warns (not errors) on unknown registry identifiers

### RELEASE-02: Auto-CHANGELOG from git log

`releaseChangelogSince(sinceTag)` now runs `git log <sinceTag>..HEAD` with a parseable format, extracts task IDs (`T\d+`) and epic IDs (`Epic T\d+`) from each commit message, groups commits by epic, and renders a structured markdown changelog. Returns `sinceTag`, `commitCount`, `epicCount`, `changelog`, and per-commit metadata.

### RELEASE-03: IVTR gate enforcement

`releaseShip` gained a new Step 1.5 (after release gate checks) that:
1. Loads all non-epic child tasks of the release epic
2. Calls `getIvtrState(taskId)` for each
3. Blocks ship if any task has `currentPhase !== 'released'`
4. Shows the full list of blocking task IDs with the fix command
5. Unchecked tasks (no IVTR state) produce a warning, not a block
6. `--force` bypasses with a loud console.warn owner warning

### RELEASE-04: PR-first mode

`getPushMode` prioritizes `gitWorkflow: 'pr'` from `release-config.json`. The `releaseShip` pipeline already uses `getPushMode` to branch between direct push and `createPullRequest`. This ADR wires the `gitWorkflow` field as the primary control. `--force` flag added to `release.ship` dispatch.

### RELEASE-05: Real rollback

`releaseRollbackFull` now performs:
1. `git push origin --delete <tag>` (best-effort, skips if tag not on remote)
2. `git tag -d <tag>` (local)
3. `git log --grep "release: ship v<version>"` + `git revert --no-edit <sha>`
4. `rollbackRelease(version)` — flip DB record to `rolled_back`
5. Optional `npm deprecate <pkg>@<version>` when `--unpublish` is true and `registries` includes `npm`

### RELEASE-06: Downstream fixture

`packages/cleo/test/fixtures/release-test-project/` is a minimal project with:
- `package.json` (no cleocode-specific entries)
- `.cleo/release-config.json` using `versionScheme: "semver"`, `artifactType: "source-only"`, `skipBuildArtifactGate: true`

The fixture proves zero hardcoded monorepo assumptions and validates via `loadReleaseConfig` + `validateReleaseConfig`.

### RELEASE-07: IVTR pipeline wire

`ivtr.release` success response gained a `nextStep` field pointing to `cleo release ship <version> --epic <epicId>`, making the handoff explicit in CLI output after all IVTR phases pass.

---

## Consequences

### Positive

- Any downstream project can drop a `.cleo/release-config.json` and get a fully functional `cleo release ship`
- IVTR gate enforcement prevents shipping tasks that haven't passed I+V+T review
- Real rollback is safe to invoke after a bad release tag
- CHANGELOG generation from git log works for projects that don't use CLEO tasks for every commit
- PR-first workflow is now first-class rather than requiring branch protection detection

### Negative / Trade-offs

- `--force` bypasses IVTR gate entirely — this is intentional but risky
- Rollback's `git revert` creates a new commit; it does not rewrite history. Projects on main with no revert policy may prefer `--force` reset instead.
- `releaseChangelogSince` requires a valid tag to exist in git history; new projects without any tags will fail gracefully with `E_NOT_FOUND`.

---

## Alternatives Considered

- **Single config file**: Merge all release config into `.cleo/config.json` under `release.*`. Rejected — it creates a "mega config" that's hard to override per-project without touching the global config. A dedicated `release-config.json` is more discoverable.
- **IVTR gate as warning only**: Considered not blocking on IVTR state mismatch. Rejected — the whole point of RELEASE-03 is accountability. `--force` exists for the escape hatch.
- **Real git history rewrite on rollback**: Using `git reset --hard` instead of `git revert`. Rejected — history rewrite on shared branches requires `--force` push which is dangerous and disabled by CI.
