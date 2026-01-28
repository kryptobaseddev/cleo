# cleo release - Release Management

Manage releases for roadmap tracking. Track planned, active, and shipped releases with associated tasks and changelog generation.

## Synopsis

```bash
cleo release <subcommand> [options]
```

## Subcommands

### create

Create a new planned release.

```bash
cleo release create <version> [--target-date DATE] [--tasks ID,ID,...] [--notes "text"]
```

**Options:**
- `<version>` - Semantic version (e.g., v0.65.0)
- `--target-date DATE` - Target release date (YYYY-MM-DD)
- `--tasks ID,ID,...` - Initial task IDs to include
- `--notes "text"` - Release notes or description

**Examples:**
```bash
# Create release with target date
cleo release create v0.65.0 --target-date 2026-02-01

# Create with initial tasks
cleo release create v0.66.0 --tasks T2058,T2089 --notes "Schema updates"

# Create as part of dogfooding workflow
cleo release create v0.74.0 --target-date 2026-02-01 --notes "Unified Release System"
```

### plan

Add tasks to an existing release.

```bash
cleo release plan <version> --tasks ID,ID,...
```

**Options:**
- `<version>` - Release version to modify
- `--tasks ID,ID,...` - Task IDs to add

**Examples:**
```bash
# Add tasks to release
cleo release plan v0.65.0 --tasks T2059,T2060,T2061

# Remove tasks from release
cleo release plan v0.65.0 --remove T2060

# Add and remove in single command
cleo release plan v0.65.0 --tasks T2062,T2063 --remove T2060
```

### ship

Mark a release as shipped with integrated VERSION management, git tagging, and changelog generation.

```bash
cleo release ship <version> [OPTIONS]
```

**Options:**
- `<version>` - Release version to ship
- `--notes "text"` - Final release notes
- `--bump-version` - Bump VERSION file via dev/bump-version.sh
- `--create-tag` - Create git tag for the release
- `--push` - Push git tag to remote (requires --create-tag)
- `--write-changelog` - Generate changelog via scripts/generate-changelog.sh
- `--output FILE` - Output file for changelog (default: CHANGELOG.md)
- `--skip-validation` - Skip validation gates (not recommended)
- `--dry-run` - Preview actions without making changes

**Validation Gates** (checked before shipping):
- All tests pass (./tests/run-all-tests.sh)
- Schema validation (cleo validate)
- VERSION file consistency
- Changelog updated (if --write-changelog used)

**Example - Full Release Workflow:**
```bash
# Complete release with all automation
cleo release ship v0.65.0 --bump-version --create-tag --write-changelog

# Ship and push to remote
cleo release ship v0.65.0 --bump-version --create-tag --push

# Manual workflow with notes
cleo release ship v0.65.0 --notes "Schema 2.8.0 with metadata fields"
```

**Actions Performed:**
1. **VERSION Bump** (if --bump-version): Calls dev/bump-version.sh to update VERSION file, README badge, and templates
2. **Changelog Generation** (if --write-changelog): Calls scripts/generate-changelog.sh to append release notes
3. **Validation**: Runs all validation gates (skippable with --skip-validation)
4. **Git Tag** (if --create-tag): Creates annotated git tag with release metadata
5. **Push Tag** (if --push): Pushes tag to remote repository
6. **Status Update**: Sets release status to "released" and records releasedAt timestamp

### list

List all releases.

```bash
cleo release list [--status STATUS]
```

**Options:**
- `--status STATUS` - Filter by status (planned, active, released)

**Output:**
```json
{
  "releases": [
    {
      "version": "v0.65.0",
      "status": "released",
      "taskCount": 19,
      "releasedAt": "2026-01-23T07:37:27Z"
    }
  ]
}
```

### show

Show details for a specific release.

```bash
cleo release show <version>
```

**Example:**
```bash
cleo release show v0.65.0
```

**Output:**
```json
{
  "release": {
    "version": "v0.65.0",
    "status": "released",
    "targetDate": "2026-02-01",
    "releasedAt": "2026-01-23T07:37:27Z",
    "tasks": ["T2058", "T2059", "T2060"],
    "notes": "Schema 2.8.0 release"
  }
}
```

### changelog

Generate changelog from release tasks.

```bash
cleo release changelog <version> [--format FORMAT]
```

**Options:**
- `<version>` - Release version
- `--format FORMAT` - Output format (markdown, json)

**Example:**
```bash
cleo release changelog v0.65.0
```

**Output (markdown):**
```markdown
## [v0.65.0] - 2026-01-23

### Features
- Add updatedAt field to todo.schema.json (T2059)
- Add relates array field for non-blocking relationships (T2060)

### Bug Fixes
- No bug fixes

### Other Changes
- Create lib/task-mutate.sh centralized mutation library (T2067)
```

## Release Lifecycle

```
planned → active → released
```

| Status | Description | Can Modify? |
|--------|-------------|-------------|
| `planned` | Release is planned, not yet started | Yes |
| `active` | Release is in active development | Yes |
| `released` | Release has been shipped | No (read-only) |

**State Transitions:**
- `planned → active`: Automatic when first task in release starts work
- `active → released`: Via `cleo release ship` command
- Released releases are **locked** and cannot be modified

## Dogfooding Workflow

CLEO uses its own release system to build and ship CLEO releases:

```bash
# 1. Create release
cleo release create v0.74.0 --target-date 2026-02-01

# 2. Plan release tasks
cleo release plan v0.74.0 --tasks T2536,T2537,T2538

# 3. Work on tasks (status automatically becomes 'active')
cleo focus set T2536
cleo complete T2536
# ... complete all release tasks

# 4. Ship the release (all-in-one)
cleo release ship v0.74.0 --bump-version --create-tag --write-changelog

# 5. Push to remote
git push origin main --tags
```

**Benefits:**
- Integrated VERSION management (no manual updates)
- Automatic changelog generation from task metadata
- Git tag creation with release notes
- Validation gates prevent incomplete releases
- Single command for complete release workflow

## VERSION Integration

The `--bump-version` flag integrates with CLEO's centralized VERSION management:

### How It Works

When you run `cleo release ship v0.74.0 --bump-version`:

1. **Calls dev/bump-version.sh** with the version number (e.g., `0.74.0`)
2. **Updates VERSION file** (source of truth for all version references)
3. **Syncs version across project**:
   - README.md badge
   - templates/*.md files
   - All version-dependent documentation
4. **Validates consistency** before completing the ship operation

### Manual Alternative

If you prefer manual VERSION management:

```bash
# Manually bump version first
./dev/bump-version.sh 0.74.0

# Then ship without --bump-version
cleo release ship v0.74.0 --create-tag --write-changelog
```

### VERSION Validation

Before shipping, CLEO validates:
- VERSION file exists and is readable
- Version format is valid semantic versioning
- No uncommitted changes to VERSION-dependent files (when using --bump-version)

## Changelog Generation

The `--write-changelog` flag generates changelog from release tasks:

### How It Works

1. **Calls scripts/generate-changelog.sh** to extract task metadata
2. **Categorizes tasks** by type and labels:
   - Features: Tasks with `feature-*` labels
   - Bug Fixes: Tasks with `bug` or `fix` labels
   - Other Changes: Remaining tasks
3. **Formats as Markdown** with task IDs and titles
4. **Appends to CHANGELOG.md** (or custom file with --output)

### Example Output

```markdown
## [v0.74.0] - 2026-01-27

### Features
- Unified release system with VERSION integration (T2536)
- Automatic changelog generation from tasks (T2538)

### Bug Fixes
- Fix version sync in templates (T2560)

### Other Changes
- Update release documentation (T2546)
```

## Schema

Releases are stored in `todo.json` under `project.releases`:

```json
{
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "status": "released",
        "targetDate": "2026-02-01",
        "releasedAt": "2026-01-23T07:37:27Z",
        "tasks": ["T2058", "T2059"],
        "notes": "Release notes here"
      }
    ]
  }
}
```

## Exit Codes

Release management uses exit codes 50-59 for release-specific operations:

| Code | Error Code | Meaning | Recovery |
|------|------------|---------|----------|
| 0 | - | Success | - |
| 50 | `E_RELEASE_NOT_FOUND` | Release not found | Create release first: `cleo release create <version>` |
| 51 | `E_RELEASE_EXISTS` | Release already exists | Use different version or update existing release |
| 52 | `E_RELEASE_LOCKED` | Release is locked (already shipped) | Cannot modify released releases |
| 53 | `E_INVALID_VERSION` | Invalid version format | Use semantic version format: v0.74.0 |
| 54 | `E_VALIDATION_FAILED` | Schema validation failed | Run `cleo validate --fix` |
| 55 | `E_VERSION_BUMP_FAILED` | VERSION bump failed | Check VERSION file, ensure dev/bump-version.sh exists |
| 56 | `E_TAG_CREATION_FAILED` | Git tag creation failed | Check if tag exists: `git tag -l <version>` |
| 57 | `E_CHANGELOG_GENERATION_FAILED` | Changelog generation failed | Check scripts/generate-changelog.sh output |
| 58 | `E_INVALID_TRANSITION` | Invalid state transition | Verify release status and workflow |
| 59 | `E_TASKS_INCOMPLETE` | Release has incomplete tasks | Complete tasks or remove from release |

**Exit Code Ranges:**
- 0-22: Task operations
- 30-39: Session operations
- 50-59: Release management
- 70-79: Research operations

## See Also

- [CHANGELOG.md](../../CHANGELOG.md) - Project changelog
- [Migration Guide](../migration/v2.8.0-migration-guide.md) - Schema 2.8.0 migration
- [Schema Documentation](../schema/) - Field definitions
