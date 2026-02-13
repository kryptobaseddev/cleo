# Release Protocol

**Provenance**: @task T3155, @epic T3147
**Version**: 2.2.0
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

## State Machine

```
create → planned → active → released (immutable)
```

| Transition | Trigger | Condition |
|------------|---------|-----------|
| (none) → planned | `cleo release create <version>` | User action |
| planned → active | `cleo release ship <version>` (automatic) | Ship begins execution |
| active → released | `cleo release ship <version>` (automatic) | All steps complete |

The `active` state is automatic and transitional -- it is set internally during `ship` execution. Agents interact with `create` (→ planned) and `ship` (→ released). The `plan` command works on releases in `planned` or `active` status. Once `released`, the entry is **immutable** -- no task additions, no metadata changes.

---

## Release Schema

Releases are stored as an array in `todo.json` under `project.releases`:

```json
{
  "releaseDefinition": {
    "required": ["version", "status", "createdAt"],
    "properties": {
      "version": { "type": "string", "pattern": "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.-]+)?$" },
      "status": { "enum": ["planned", "active", "released"] },
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

---

## CLI Commands (8 subcommands)

### `create`

Create a new planned release.

```bash
cleo release create <version> [--target-date DATE] [--tasks T001,T002] [--notes "text"]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target-date` | DATE (YYYY-MM-DD) | null | Target release date |
| `--tasks` | string (comma-separated) | [] | Tasks to include |
| `--notes` | string | null | Release notes |

**Exit codes**: 0 (success), 51 (`E_RELEASE_EXISTS`), 53 (`E_INVALID_VERSION`)

**Behavior**: Creates a new release entry with status `planned`. Validates version is valid semver and doesn't already exist. Tasks are stored as an array; target date and notes are optional metadata.

---

### `plan`

Add or remove tasks from a release.

```bash
cleo release plan <version> [--tasks T001,T002] [--remove T003] [--notes "text"]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tasks` | string (comma-separated) | — | Tasks to add (appends, deduplicates) |
| `--remove` | string | — | Task to remove |
| `--notes` | string | — | Update release notes |

**Exit codes**: 0 (success), 50 (`E_RELEASE_NOT_FOUND`), 52 (`E_RELEASE_LOCKED`)

**Behavior**: Modifies an existing release in `planned` or `active` status. The `--tasks` flag appends to existing tasks and deduplicates automatically. Calling `plan --tasks T001` then `plan --tasks T002` results in both tasks being included. Released entries are immutable and reject modification.

---

### `ship`

Mark a release as released. This is the primary release workflow command.

```bash
cleo release ship <version> [FLAGS]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--bump-version` | boolean | false | Bump VERSION file via `dev/bump-version.sh` |
| `--create-tag` | boolean | false | Create annotated git tag |
| `--force-tag` | boolean | false | Overwrite existing git tag (requires `--create-tag`) |
| `--push` | boolean | false | Push commits and tag to remote |
| `--no-changelog` | boolean | false | Skip changelog generation |
| `--no-commit` | boolean | false | Skip git commit (update files only) |
| `--run-tests` | boolean | false | Run test suite during validation (opt-in, slow) |
| `--skip-validation` | boolean | false | Skip all validation gates (emergency releases) |
| `--dry-run` | boolean | false | Preview what would happen without making changes |
| `--preview` | boolean | false | Preview tasks and guards without shipping |
| `--force` | boolean | false | Override epic completeness blocking and tag conflicts |
| `--notes` | string | "" | Release notes |
| `--output` | string | CHANGELOG.md | Changelog output file |

**Exit codes**: 0 (success), 50 (`E_RELEASE_NOT_FOUND`), 52 (`E_RELEASE_LOCKED`), 54 (`E_VALIDATION_FAILED`), 55 (`E_VERSION_BUMP_FAILED`), 56 (`E_TAG_CREATION_FAILED`), 57 (`E_CHANGELOG_GENERATION_FAILED`), 58 (`E_TAG_EXISTS`), 59 (`E_TASKS_INCOMPLETE`)

**Ship Workflow** (10 steps):

```
 1. Auto-populate release tasks (date window + label matching from todo.json)
 1.5. Run release guards (epic completeness check, double-listing check)
 2. Bump version (if --bump-version)
 3. Ensure [Unreleased] section exists in CHANGELOG.md (creates if missing)
 4. Generate changelog from task metadata via lib/changelog.sh (unless --no-changelog)
 5. Validate changelog content is not empty (unless --no-changelog)
 6. Append to CHANGELOG.md + generate platform-specific outputs (if configured)
 7. Run validation gates (tests opt-in, schema, version, changelog)
 8. Create release commit staging VERSION, README, CHANGELOG.md, platform docs, todo.json (unless --no-commit)
 9. Create annotated tag with changelog/commit/description fallback (if --create-tag)
10. Push to remote (if --push)
11. Update release status to "released" in todo.json with releasedAt timestamp
```

Steps 2-6 are conditional on flags. Step 1.5 runs always unless `release.guards.epicCompleteness` is `off`. The `--dry-run` flag previews all steps and task list without executing. The `--preview` flag shows only the task preview and guard results. Use `--force` to override epic completeness blocking.

**`changelog` vs `ship`**: The `changelog` subcommand generates and previews changelog content without modifying release state. The `ship` subcommand performs the full release workflow including changelog generation, git operations, and status transition.

---

### `changelog`

Generate changelog from release tasks without shipping.

```bash
cleo release changelog <version> [--output FILE]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output` | string | — | Write changelog to file |

**Exit codes**: 0 (success), 50 (`E_RELEASE_NOT_FOUND`), 53 (`E_INVALID_VERSION`)

**Behavior**: Generates changelog content from task metadata (title, description, labels) for the specified release. Outputs to stdout by default. Use `--output` to write to a file. Does not modify release status. Useful for previewing changelog before shipping.

---

### `list`

List all releases.

```bash
cleo release list [--status STATUS] [--format FORMAT]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--status` | string | — | Filter by status (planned, active, released) |
| `--format` | text\|json | auto | Output format |

**Exit codes**: 0 (success)

**Behavior**: Lists all releases with version, status, target date, task count, and released timestamp. Supports JSON and text output. Color-coded by status: yellow=planned, cyan=active, green=released.

---

### `show`

Show details of a specific release.

```bash
cleo release show <version> [--format FORMAT]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--format` | text\|json | auto | Output format |

**Exit codes**: 0 (success), 50 (`E_RELEASE_NOT_FOUND`), 53 (`E_INVALID_VERSION`)

**Behavior**: Displays full details for a release including version, status, dates, tasks, notes, git tag, and changelog content.

---

### `init-ci`

Initialize CI/CD workflow configuration for automated releases.

```bash
cleo release init-ci [--platform PLATFORM] [--force] [--dry-run]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--platform` | string | from config | CI platform: `github-actions`, `gitlab-ci`, `circleci` |
| `--force` | boolean | false | Overwrite existing CI config file |
| `--dry-run` | boolean | false | Preview without writing files |

**Exit codes**: 0 (success), 72 (`E_CI_INIT_FAILED`)

**Behavior**: Generates CI/CD workflow configuration files from templates in `lib/release-ci.sh`. Platform is auto-detected from config or specified via `--platform`. Use `--force` to overwrite existing configuration files.

---

### `validate`

Validate release protocol compliance for a task.

```bash
cleo release validate <task-id> [--strict] [--format FORMAT]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--strict` | boolean | false | Enable strict validation mode |
| `--format` | text\|json | auto | Output format |

**Exit codes**: 0 (valid), 4 (`E_NOT_FOUND` -- manifest or task not found), 66 (protocol violation in strict mode)

**Behavior**: Validates a task's manifest entry against the release protocol. Checks for required fields, correct `agent_type`, semver compliance, and changelog presence. The `--strict` flag enforces stricter checks (e.g., all SHOULD requirements become violations). Outputs validation score (0-100) and violation details.

---

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

---

<!-- @task T4436, @epic T4431 -->
## Release Guards (v0.95.0+)

Guards provide safety checks during `ship` without blocking by default.

### Epic Completeness

Checks whether all child tasks of an epic are included in the release. If epic T001 has 13 children but only 10 are shipping, the guard warns about the 3 missing tasks and their statuses.

**Configuration** (`release.guards.epicCompleteness` in `.cleo/config.json`):

| Mode | Behavior |
|------|----------|
| `warn` (default) | Log warnings about incomplete epics, continue shipping |
| `block` | Exit with code 59 (`E_TASKS_INCOMPLETE`). Override with `--force` |
| `off` | Skip epic completeness checks entirely |

```json
{
  "release": {
    "guards": {
      "epicCompleteness": "warn"
    }
  }
}
```

### Double-Listing Detection

Warns when a task appears in both the current release and a previously-shipped release. This is always a warning, never blocks. Catches accidental overlap from manual `--tasks` additions.

### Task Preview (`--preview`)

Preview which tasks would be included in a release without shipping:

```bash
cleo release ship v0.95.0 --preview
```

Shows:
- Auto-discovered tasks (from 6-filter pipeline)
- Manually planned tasks (from `plan --tasks`)
- Source classification: `auto`, `manual`, or `both`
- Epic completeness warnings
- Double-listing warnings

The `--dry-run` flag includes the same preview plus the step enumeration.

---

## Validation Gates

| Gate | Check | Required | Notes |
|------|-------|----------|-------|
| Tests | All tests pass | SHOULD | Opt-in with `--run-tests` flag to avoid timeout |
| Schema | All schemas valid | MUST | Always enforced via `cleo validate` |
| Version | Version bumped correctly | MUST | If `--bump-version` used |
| Changelog | Entry for new version | MUST | Unless `--no-changelog` |
| Docs | Documentation current | SHOULD | Manual verification |
| Install | Installation works | SHOULD | Manual verification |

Use `--skip-validation` to bypass all gates for emergency releases. Use `--run-tests` to opt into running the full test suite (slow, disabled by default to avoid ship timeout).

---

## Tag Annotation Fallback (v0.83.0+)

When `--create-tag` is used, the tag annotation is populated from a fallback chain:

1. **CHANGELOG.md section** -- extracted via `extract_changelog_section()`
2. **Git commit notes** -- generated via `generate_changelog_from_commits()` from previous tag
3. **Release description** -- from `release.notes` field in todo.json

This ensures tags always have meaningful content for GitHub Actions, even when `--no-changelog` skips CHANGELOG.md generation.

---

## Platform Changelog Configuration (v0.84.0+)

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

---

## CI/CD Integration

| Event | Workflow | Action |
|-------|----------|--------|
| Tag push `v*.*.*` | `release.yml` | Build tarball, generate release notes, create GitHub Release |
| Tag push `v*.*.*` | `npm-publish.yml` | Build, test, and publish `@cleocode/mcp-server` to npm |
| CHANGELOG.md changed on main | `docs-update.yml` | Safety net: regenerate platform docs if missed by ship flow |
| docs/** changed on main | `mintlify-deploy.yml` | Validate Mintlify docs (deployment via Mintlify dashboard) |

---

## MCP Server Publishing

The MCP server npm package (`@cleocode/mcp-server`) is automatically published when a release is shipped:

1. `cleo release ship` bumps VERSION file via `dev/bump-version.sh`
2. `dev/sync-mcp-version.sh` is called automatically to sync `mcp-server/package.json` version
3. Release commit includes the synced `mcp-server/package.json`
4. Git tag push triggers `.github/workflows/npm-publish.yml`
5. GitHub Action builds, tests, and publishes to npm

### Required Setup

- GitHub secret `NPM_TOKEN` must be configured with npm publish access
- npm package `@cleocode/mcp-server` must exist on the registry
- The `dev/sync-mcp-version.sh` script must be present in the repository

### Version Sync Details

The version sync is integrated into `dev/bump-version.sh` as step 6. It runs after all other version updates (VERSION file, README badge, template tags, plugin.json). If the sync script is missing or fails, the bump continues with a warning -- it does not block the release.

---

## Error Codes (50-59)

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 50 | `E_RELEASE_NOT_FOUND` | Release version not found | `cleo release list` |
| 51 | `E_RELEASE_EXISTS` | Version already exists | Use different version |
| 52 | `E_RELEASE_LOCKED` | Released = immutable | Create hotfix version |
| 53 | `E_INVALID_VERSION` | Bad semver format | Use `v{major}.{minor}.{patch}` |
| 54 | `E_VALIDATION_FAILED` | Validation gate failed | Fix validation errors |
| 55 | `E_VERSION_BUMP_FAILED` | bump-version.sh failed | Check VERSION file |
| 56 | `E_TAG_CREATION_FAILED` | Git tag/commit failed | Check git status, existing tags |
| 57 | `E_CHANGELOG_GENERATION_FAILED` | Changelog failed | Check lib/changelog.sh |
| 58 | `E_TAG_EXISTS` | Git tag already exists | Use `--force-tag` to overwrite |
| 59 | `E_TASKS_INCOMPLETE` | Epic completeness guard (block mode) | Complete remaining tasks, use `--force`, or set guard to `warn` |

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
| Ignoring epic completeness warnings | Shipping partial epics without review |
| Overusing --force | Bypasses guards that catch legitimate issues |

---

*Protocol Version 2.2.0 - Canonical release reference (consolidated from RELEASE-MANAGEMENT.mdx)*
