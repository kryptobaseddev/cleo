# Release Protocol

**Provenance**: @task T3155, @epic T3147
**Version**: 2.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Version | "release", "version", "v1.x.x" | Version management |
| Publish | "publish", "deploy", "ship" | Distribution |
| Changelog | "changelog", "release notes" | Documentation |
| Tag | "tag", "milestone", "GA" | Version marking |

**Explicit Override**: `--protocol release` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| RLSE-001 | MUST follow semantic versioning (semver) |
| RLSE-002 | MUST update changelog with all changes |
| RLSE-003 | MUST pass all validation gates before release |
| RLSE-004 | MUST tag release in version control |
| RLSE-005 | MUST document breaking changes with migration path |
| RLSE-006 | MUST verify version consistency across files |
| RLSE-007 | MUST set `agent_type: "documentation"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| RLSE-010 | SHOULD include upgrade instructions |
| RLSE-011 | SHOULD verify documentation is current |
| RLSE-012 | SHOULD test installation process |
| RLSE-013 | SHOULD create backup before release |
| RLSE-014 | SHOULD run test suite for major/minor releases (use `--run-tests`) |
| RLSE-015 | SHOULD verify tests pass before tagging (opt-in to avoid timeout) |

### MAY

| Requirement | Description |
|-------------|-------------|
| RLSE-020 | MAY include performance benchmarks |
| RLSE-021 | MAY announce on communication channels |
| RLSE-022 | MAY batch minor fixes into single release |

---

## Release Schema

Releases are stored as an array in `todo.json` under `project.releases`:

```json
{
  "releaseDefinition": {
    "required": ["version", "status", "createdAt"],
    "properties": {
      "version": { "type": "string", "pattern": "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.-]+)?$" },
      "status": { "enum": ["planned", "released"] },
      "name": { "type": ["string", "null"], "maxLength": 100 },
      "description": { "type": ["string", "null"], "maxLength": 500 },
      "tasks": { "type": "array", "items": { "pattern": "^T\\d{3,}$" } },
      "createdAt": { "format": "date-time" },
      "targetDate": { "format": "date" },
      "releasedAt": { "format": "date-time" },
      "gitTag": { "type": ["string", "null"] },
      "changelog": { "type": ["string", "null"] },
      "notes": { "type": "array", "items": { "maxLength": 500 } }
    }
  }
}
```

## State Machine

```
create → planned → released (immutable)
```

| Transition | Trigger | Condition |
|------------|---------|-----------|
| (none) → planned | `cleo release create <version>` | User action |
| planned → released | `cleo release ship <version>` | All validation gates pass |

Once `released`, the entry is **immutable** -- no task additions, no metadata changes.

## Task Discovery (6-Filter Pipeline)

During `cleo release ship`, tasks are auto-discovered via `populate_release_tasks()`:

| Filter | Purpose |
|--------|---------|
| 1. `completedAt` | Must have completion timestamp |
| 2. Date window | Completed between previous and current release |
| 3. `status == "done"` | Must be done (not pending/active/blocked) |
| 4. `type != "epic"` | Excludes organizational epics |
| 5. Label match | Has version label, `changelog`, or `release` label |
| 6. Version exclusivity | Tasks with explicit version labels aren't claimed by other releases |

Tasks are also included if explicitly assigned via `cleo release plan --tasks T001,T002`.

## Error Codes (50-59)

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 50 | `E_RELEASE_NOT_FOUND` | Release version not found | `cleo release list` |
| 51 | `E_RELEASE_EXISTS` | Version already exists | Use different version |
| 52 | `E_RELEASE_LOCKED` | Released = immutable | Create hotfix version |
| 53 | `E_INVALID_VERSION` | Bad semver format | Use `v{major}.{minor}.{patch}` |
| 54 | `E_VALIDATION_FAILED` | Schema validation failed | `cleo validate --fix` |
| 55 | `E_VERSION_BUMP_FAILED` | bump-version.sh failed | Check VERSION file |
| 56 | `E_TAG_CREATION_FAILED` | Git tag failed | Check git status, existing tags |
| 57 | `E_CHANGELOG_GENERATION_FAILED` | Changelog failed | Check lib/changelog.sh |
| 58 | `E_INVALID_TRANSITION` | Bad state transition | Check release status |
| 59 | `E_TASKS_INCOMPLETE` | Incomplete tasks | Complete or remove from release |

## CLI Commands (8 subcommands)

```bash
cleo release create <version> [--name --target-date --tasks]
cleo release plan <version> [--tasks --remove --notes]
cleo release ship <version> [--bump-version --create-tag --push --no-changelog --dry-run]
cleo release list [--status --format]
cleo release show <version> [--format]
cleo release changelog <version>
cleo release validate <task-id>
cleo release init-ci [--platform --force]
```

---

## Output Format

### Semantic Versioning

| Version Part | When to Increment | Example |
|--------------|-------------------|---------|
| Major (X.0.0) | Breaking changes | 1.0.0 → 2.0.0 |
| Minor (X.Y.0) | New features, backward compatible | 1.0.0 → 1.1.0 |
| Patch (X.Y.Z) | Bug fixes, backward compatible | 1.0.0 → 1.0.1 |

### Changelog Format

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security fixes

## [X.Y.Z] - YYYY-MM-DD

### Added
- {Feature description} (T####)

### Fixed
- {Bug fix description} (T####)

### Changed
- {Change description} (T####)

### Breaking Changes
- {Breaking change with migration path}
```

### Validation Gates

| Gate | Check | Required | Notes |
|------|-------|----------|-------|
| Tests | All tests pass | SHOULD | Opt-in with `--run-tests` flag to avoid timeout |
| Lint | No lint errors | SHOULD | Project-dependent |
| Schema | All schemas valid | MUST | Always enforced |
| Version | Version bumped correctly | MUST | If `--bump-version` used |
| Changelog | Entry for new version | MUST | Unless `--no-changelog` |
| Docs | Documentation current | SHOULD | Manual verification |
| Install | Installation works | SHOULD | Manual verification |

### Release Checklist

```markdown
## Release Checklist: vX.Y.Z

### Pre-Release

- [ ] All features complete and merged
- [ ] Tests passing (recommended: ./tests/run-all-tests.sh)
- [ ] Version bumped (./dev/bump-version.sh X.Y.Z)
- [ ] Version consistency verified (./dev/validate-version.sh)
- [ ] Changelog updated
- [ ] Documentation current
- [ ] Breaking changes documented
- [ ] For major/minor: Run `cleo release ship --run-tests` to validate

### Release

- [ ] Create release commit
- [ ] Tag release (git tag vX.Y.Z)
- [ ] Push to remote (git push && git push --tags)
- [ ] Create GitHub release (if applicable)

### Post-Release

- [ ] Verify installation works
- [ ] Update any dependent projects
- [ ] Announce release (if applicable)
- [ ] Archive completed tasks (cleo archive)
```

### File Output

```markdown
# Release: vX.Y.Z

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: documentation

---

## Release Summary

{2-3 sentence summary of this release}

## Version Information

| Field | Value |
|-------|-------|
| Version | X.Y.Z |
| Previous | X.Y.W |
| Type | Major/Minor/Patch |
| Tag | vX.Y.Z |

## Changes in This Release

### Features

| Feature | Task | Description |
|---------|------|-------------|
| {Name} | T#### | {Description} |

### Bug Fixes

| Fix | Task | Description |
|-----|------|-------------|
| {Name} | T#### | {Description} |

### Breaking Changes

| Change | Migration |
|--------|-----------|
| {Change} | {How to migrate} |

## Validation Results

| Gate | Status | Notes |
|------|--------|-------|
| Tests | PASS | 142 tests, 0 failures |
| Lint | PASS | No warnings |
| Version | PASS | Consistent across files |
| Changelog | PASS | Entry present |

## Release Commands

```bash
# Tag and push
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main --tags

# Verify
git describe --tags
```

## Post-Release Tasks

- [ ] Verify GitHub release created
- [ ] Update documentation site
- [ ] Notify stakeholders
```

### Manifest Entry

@skills/_shared/manifest-operations.md

Use `cleo research add` to create the manifest entry:

```bash
cleo research add \
  --title "Release: vX.Y.Z" \
  --file "YYYY-MM-DD_release-vXYZ.md" \
  --topics "release,version,changelog" \
  --findings "Version X.Y.Z released,3 features added,2 bugs fixed" \
  --status complete \
  --task T#### \
  --not-actionable \
  --agent-type documentation
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| contribution | Contributions feed changelog |
| implementation | Implementation changes tracked |
| specification | Spec changes documented |

### Release Workflow (`cleo release ship`)

```
1. Auto-populate release tasks (date window + label matching from todo.json)
2. Bump version (if --bump-version)
3. Ensure [Unreleased] section exists in CHANGELOG.md (creates if missing)
4. Generate changelog from task metadata (categorized by labels)
5. Append to CHANGELOG.md (idempotent, Keep a Changelog format)
6. Generate platform-specific outputs (if configured in release.changelog.outputs)
   - Mintlify: CHANGELOG.md → docs/changelog/overview.mdx
   - Docusaurus: CHANGELOG.md → docs/changelog.md
   - Plain/GitHub: copy
   - Skipped if no platforms configured (default for fresh installs)
7. Run validation gates (tests opt-in, schema, version, changelog, custom)
8. Create release commit (stages VERSION, README, CHANGELOG.md, platform docs, todo.json)
9. Create annotated tag (if --create-tag)
10. Push to remote (if --push)
11. Update release status in todo.json
```

### Platform Changelog Configuration (v0.84.0+)

Platform-specific changelog generation is controlled by `.cleo/config.json`:

```json
{
  "release": {
    "changelog": {
      "outputs": [
        { "platform": "mintlify", "enabled": true, "path": "docs/changelog/overview.mdx" }
      ]
    }
  }
}
```

Supported platforms: `mintlify`, `docusaurus`, `github`, `gitbook`, `plain`, `custom`.
Default for fresh installs: no platforms configured (only CHANGELOG.md generated).
GitHub URLs in generated output are resolved dynamically from `git remote origin`.

### Tag Annotation Fallback (v0.83.0+)

When `--create-tag` is used, the tag annotation is populated from a fallback chain:

1. **CHANGELOG.md section** - extracted via `extract_changelog_section()`
2. **Git commit notes** - generated via `generate_changelog_from_commits()` from previous tag
3. **Release description** - from `release.notes` field in todo.json

This ensures tags always have meaningful content for GitHub Actions, even when `--no-changelog` skips CHANGELOG.md generation.

### CI/CD Integration

| Event | Workflow | Action |
|-------|----------|--------|
| Tag push `v*.*.*` | `release.yml` | Build tarball, generate release notes, create GitHub Release |
| CHANGELOG.md changed on main | `docs-update.yml` | Safety net: regenerate platform docs if missed by ship flow |
| docs/** changed on main | `mintlify-deploy.yml` | Validate Mintlify docs (deployment via Mintlify dashboard) |

---

## Example

**Task**: Release CLEO v0.70.0

**Manifest Entry Command**:
```bash
cleo research add \
  --title "Release: v0.70.0" \
  --file "2026-01-26_release-v0700.md" \
  --topics "release,v0.70.0,changelog" \
  --findings "Multi-agent support added,12 new commands,Full test coverage" \
  --status complete \
  --task T2350 \
  --epic T2308 \
  --not-actionable \
  --agent-type documentation
```

**Return Message**:
```
Release complete. See MANIFEST.jsonl for summary.
```

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Skipping version bump | Version confusion |
| Missing changelog entry | Lost history |
| Undocumented breaking changes | User frustration |
| No release tag | Cannot reference version |
| Incomplete checklist | Missed steps |
| Major releases without `--run-tests` | Quality risk for breaking changes |

---

*Protocol Version 2.0.0 - Canonical release reference (consolidated from RELEASE-MANAGEMENT.mdx)*
