# Version Management

> Single source of truth pattern for app and schema versioning

## Overview

cleo uses a **dual-track versioning system** to independently manage application features and data structure:

- **APP VERSION**: Feature releases following semantic versioning (e.g., 0.15.0)
  - Tracks user-facing changes, new commands, CLI improvements
  - Stored in single `VERSION` file at project root
  - Propagated to all documentation and badges

- **SCHEMA VERSION**: Data structure versioning (e.g., 2.2.0)
  - Tracks changes to JSON file formats (todo.json, config.json, etc.)
  - Defined in `lib/migrate.sh` constants
  - Decoupled from app version - changes only when data structure changes

**Why separate versions?**
- App features can evolve without changing data format
- Schema changes require migrations, app features don't
- Clear signal when user data needs migration vs. simple upgrade

## Version Sources

### App Version

**Primary Location**: `VERSION` file (single source of truth)

```
/mnt/projects/cleo/VERSION
```

**Content Format**: Semver (X.Y.Z) with trailing newline
```
0.15.0
```

**Modified By**: `dev/bump-version.sh` (automated)

**Consumed By**:
- `lib/version.sh` - Provides `get_version()` and `$CLEO_VERSION`
- All scripts via `source lib/version.sh`
- Installation process (`install.sh`)
- Documentation generation

**Update Flow**:
```
bump-version.sh → VERSION file → lib/version.sh → All scripts
```

### Schema Versions

**Primary Location**: `lib/migrate.sh` (constants section)

```bash
# Current schema versions (single source of truth)
SCHEMA_VERSION_TODO="2.3.0"
SCHEMA_VERSION_CONFIG="2.1.0"
SCHEMA_VERSION_ARCHIVE="2.1.0"
SCHEMA_VERSION_LOG="2.1.0"
```

**Modified By**: Manual edit when adding migration function

**Migration Pattern**:
1. Increment schema version constant
2. Add migration function `migrate_<old>_to_<new>()`
3. Register migration in `run_migrations()`
4. Update schema file in `schemas/`

**Independent Evolution**:
- Schema 2.2.0 can exist with App v0.13.0, v0.14.0, or v0.15.0
- Schema remains 2.2.0 through multiple app releases until data format changes

## Version Flow Diagram

```
┌─────────────┐
│ VERSION     │ (0.15.0)
│ (root file) │
└──────┬──────┘
       │
       ├──────────────────────────────────────┐
       │                                      │
       v                                      v
┌──────────────┐                      ┌─────────────┐
│ lib/version. │ get_version()        │ bump-version│
│ sh           │──────────────┐       │ .sh         │
└──────────────┘              │       └─────────────┘
       │                      │              │
       v                      v              │
┌──────────────┐       ┌─────────────┐      │
│ All Scripts  │       │ $CLAUDE_    │      │
│              │       │ TODO_VERSION│      │
└──────────────┘       └─────────────┘      │
                                             │
                    ┌────────────────────────┘
                    │
                    v
         ┌──────────────────────────┐
         │ Updates (atomic):        │
         │  - README.md badge       │
         │  - CLAUDE-INJECTION.md   │
         │  - VERSION file          │
         └──────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Schema Versions (Independent Track)                     │
│                                                          │
│ lib/migrate.sh constants → Migration functions          │
│                          → Schema files (schemas/)       │
│                          → check_compatibility()         │
└─────────────────────────────────────────────────────────┘
```

## Commands

### validate-version.sh

Validate version consistency across all project files.

**Usage**:
```bash
# Check for version drift
./dev/validate-version.sh

# Auto-fix version drift
./dev/validate-version.sh --fix

# Show help
./dev/validate-version.sh --help
```

**What It Checks**:
1. `VERSION` file (source of truth) - valid semver format
2. `README.md` badge - matches VERSION
3. `templates/CLAUDE-INJECTION.md` version tag - matches VERSION
4. `CLAUDE.md` injection tag (if present) - matches VERSION

**Output (synchronized)**:
```
Version Consistency Check
==========================

→ Checking VERSION file...
✓ VERSION file: 0.15.0 (valid semver)

→ Checking project files...
✓ README.md: 0.15.0
✓ templates/CLAUDE-INJECTION.md: 0.15.0
✓ CLAUDE.md: 0.15.0

All versions synchronized to 0.15.0
```

**Output (drift detected)**:
```
Version Consistency Check
==========================

→ Checking VERSION file...
✓ VERSION file: 0.15.0 (valid semver)

→ Checking project files...
✗ README.md: 0.14.9 (drift detected, expected 0.15.0)
✓ templates/CLAUDE-INJECTION.md: 0.15.0
✓ CLAUDE.md: 0.15.0

Version drift detected!
Run with --fix to automatically synchronize versions
```

**Exit Codes**:
- `0` - All versions synchronized
- `1` - Version drift detected (or validation failed)

**Auto-Fix Mode**:
```bash
./dev/validate-version.sh --fix
```

Automatically syncs all files to match the VERSION file (source of truth).

### bump-version.sh

Single command to update app version everywhere with validation.

**Usage**:
```bash
# Explicit version
./dev/bump-version.sh 0.12.6

# Semver bump types
./dev/bump-version.sh patch   # 0.12.5 → 0.12.6
./dev/bump-version.sh minor   # 0.12.5 → 0.13.0
./dev/bump-version.sh major   # 0.12.5 → 1.0.0

# Options
./dev/bump-version.sh --dry-run patch    # Preview changes
./dev/bump-version.sh --verbose minor    # Detailed output
./dev/bump-version.sh --no-validate major  # Skip validation
```

**What It Updates** (automatically):
1. `VERSION` file (source of truth)
2. `README.md` version badge (`version-X.Y.Z-blue.svg`)
3. `templates/CLAUDE-INJECTION.md` version tag (`CLAUDE-TODO:START vX.Y.Z`)
4. `CLAUDE.md` injection tag (if present)

**New Features (v0.16.0+)**:
- Pre-bump validation of current version
- Post-bump validation of all updates
- Automatic backup creation (.bak files)
- Rollback on failure (keeps .bak files for recovery)
- Dry-run mode to preview changes
- Verbose mode for detailed progress

**Output**:
```
Bumping version: 0.15.0 → 0.16.0

✓ VERSION file
✓ README.md badge
✓ templates/CLAUDE-INJECTION.md
✓ CLAUDE.md injection tag

Post-bump validation:
✓ All versions synchronized to 0.16.0

✓ Version bumped to 0.16.0

Next steps:
  1. Update CHANGELOG.md with changes for v0.16.0
  2. git add -A && git commit -m 'chore: Bump to v0.16.0'
  3. ./install.sh --force
  4. git push origin main
```

**Options**:
- `--dry-run` - Show what would be changed without making changes
- `--no-validate` - Skip validation checks (for automation)
- `--verbose` - Show detailed progress including backups
- `-h, --help` - Show help message

**Validation**:
- Pre-bump: Checks VERSION file exists and has valid format
- Pre-bump: Warns about version drift in current state
- Post-bump: Runs `validate-version.sh` to verify all updates succeeded
- On failure: Preserves .bak files and provides rollback instructions

**Error Handling**:
```bash
# Invalid format
./dev/bump-version.sh 1.2
# ERROR: Invalid version format: 1.2 (expected X.Y.Z)

# Post-validation failure
# ERROR: Post-bump validation failed!
#
# Backup files (.bak) have been preserved for recovery.
# To rollback:
#   find . -name '*.bak' -exec bash -c 'mv "$1" "${1%.bak}"' _ {} \;
```

**Dry-Run Example**:
```bash
./dev/bump-version.sh --dry-run --verbose minor
```

Output:
```
→ Running pre-bump validation...
✓ VERSION file exists
✓ Current version is valid semver: 0.15.0

Bumping version: 0.15.0 → 0.16.0

⚠ DRY-RUN MODE: No changes will be made

→ Updating files...
✓ VERSION file (dry-run, no changes made)
✓ README.md badge (dry-run, no changes made)
✓ templates/CLAUDE-INJECTION.md (dry-run, no changes made)
✓ CLAUDE.md injection tag (dry-run, no changes made)

DRY-RUN: Would bump version to 0.16.0
```

### version Command

Get current installed version.

**Usage**:
```bash
cleo version
# Output: 0.15.0

cleo --version
# Output: 0.15.0
```

**Implementation**:
```bash
# Any script can get version via:
source "${SCRIPT_DIR}/../lib/version.sh"
echo "$CLEO_VERSION"
```

### Migration Commands

Schema version operations (see [migration-guide.md](migration-guide.md) for details).

**Check Schema Status**:
```bash
cleo migrate status
# Shows current and target schema versions for all files
```

**Run Migrations**:
```bash
cleo migrate run
# Upgrades data files to latest schema versions
```

**Repair Schema Issues**:
```bash
cleo migrate repair --dry-run   # Preview fixes
cleo migrate repair --auto      # Apply fixes
```

## When to Bump Versions

### App Version Bumps

Follow [Semantic Versioning 2.0.0](https://semver.org/):

| Type | When to Use | Examples |
|------|-------------|----------|
| **MAJOR** (X.0.0) | Breaking changes to CLI interface or behavior | <ul><li>Remove command or flag</li><li>Change command behavior incompatibly</li><li>Require migration action</li></ul> |
| **MINOR** (0.X.0) | New features, commands, or backwards-compatible enhancements | <ul><li>Add new command (`analyze`, `phases`)</li><li>Add new flag (`--auto-focus`)</li><li>Enhance existing features</li></ul> |
| **PATCH** (0.0.X) | Bug fixes, documentation, internal improvements | <ul><li>Fix command output</li><li>Update docs</li><li>Refactor code</li></ul> |

**Recent Examples**:
- **v0.15.0** (minor): Added `analyze` command with leverage scoring
- **v0.14.0** (minor): Added `migrate repair` command
- **v0.13.3** (patch): Fixed migration phase structure bug

### Schema Version Bumps

**Only increment when data structure changes**.

| Schema | Bump When | Example |
|--------|-----------|---------|
| TODO | Add/remove/change task fields | Adding hierarchy fields (2.2.0 → 2.3.0) |
| CONFIG | Add/remove config options | Adding new validation rules |
| ARCHIVE | Change archive format | Modifying archived task structure |
| LOG | Change log entry format | Adding new event types |

**Schema Change Checklist**:
1. Increment constant in `lib/migrate.sh`
2. Write migration function
3. Update schema file in `schemas/`
4. Add tests in `tests/migration/`
5. Document in `CHANGELOG.md`

**Example (2.1.0 → 2.2.0)**:
```bash
# 1. Update constant
SCHEMA_VERSION_TODO="2.2.0"  # was 2.1.0

# 2. Add migration function
migrate_2.1.0_to_2.2.0() {
    local file="$1"
    # Add project.phases field
    jq '.project.phases = { ... }' "$file"
}

# 3. Register in run_migrations()
case "$current_version" in
    "2.1.0")
        migrate_2.1.0_to_2.2.0 "$file"
        ;;
esac
```

## Release Checklist

Use this checklist for every release:

### 1. Pre-Release

- [ ] All tests passing (`./tests/run-tests.sh`)
- [ ] Code changes reviewed and approved
- [ ] Documentation updated for new features
- [ ] Schema migrations tested (if applicable)

### 2. Version Bump

```bash
# Determine bump type (major/minor/patch)
./dev/bump-version.sh <type>

# Verify changes
git diff VERSION README.md templates/CLAUDE-INJECTION.md
```

### 3. CHANGELOG Update

Add entry to `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New features

### Changed
- Modifications

### Fixed
- Bug fixes
```

### 4. Commit and Tag

```bash
# Commit version bump and CHANGELOG
git add VERSION README.md templates/CLAUDE-INJECTION.md CHANGELOG.md
git commit -m "chore: Bump to vX.Y.Z"

# Optional: Tag release
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

### 5. Install and Test

```bash
# Install new version
./install.sh --force

# Verify installation
cleo version  # Should show X.Y.Z

# Smoke test
cd /tmp
mkdir test-project && cd test-project
cleo init
cleo add "Test task"
cleo list
```

### 6. Push

```bash
git push origin main
git push origin vX.Y.Z  # If tagged
```

### 7. Post-Release

- [ ] Update project installations: `cleo init --update-claude-md`
- [ ] Monitor for issues
- [ ] Update documentation site (if applicable)

## Anti-patterns

### DON'T: Hardcode Versions in Scripts

**Wrong**:
```bash
echo "cleo v0.15.0"  # Hardcoded, will become stale
```

**Correct**:
```bash
source "${SCRIPT_DIR}/../lib/version.sh"
echo "cleo v$CLEO_VERSION"
```

### DON'T: Edit VERSION File Manually

**Wrong**:
```bash
echo "0.15.0" > VERSION  # Manual edit
```

**Correct**:
```bash
./dev/bump-version.sh 0.15.0  # Updates everywhere
```

### DON'T: Couple Schema and App Versions

**Wrong**:
```bash
# Bumping app version from 0.15.0 to 0.16.0
# Incorrectly also bumping schema from 2.2.0 to 2.3.0
```

**Correct**:
```bash
# App version: 0.16.0 (new features)
# Schema version: 2.2.0 (unchanged - data format same)
```

Schema versions are independent. Only bump when data structure changes.

### DON'T: Skip CHANGELOG Updates

**Wrong**:
```bash
./dev/bump-version.sh minor
git commit -m "Bump version"  # No CHANGELOG entry
```

**Correct**:
```bash
./dev/bump-version.sh minor
# Edit CHANGELOG.md with changes
git add CHANGELOG.md VERSION README.md templates/CLAUDE-INJECTION.md
git commit -m "chore: Bump to v0.16.0"
```

### DON'T: Update README Badge Independently

**Wrong**:
```bash
# Manually editing README.md badge
sed -i 's/version-0.14.0-/version-0.15.0-/' README.md
```

**Correct**:
```bash
# bump-version.sh handles it automatically
./dev/bump-version.sh 0.15.0
```

## Troubleshooting

### Issue: Version Mismatch Between Files

**Symptom**: README shows v0.14.0 but `VERSION` file shows v0.15.0

**Cause**: Manual edits or partial update

**Diagnosis**:
```bash
# Check for version drift
./dev/validate-version.sh
```

**Fix (Option 1 - Auto-fix)**:
```bash
# Automatically sync all files to VERSION file
./dev/validate-version.sh --fix
```

**Fix (Option 2 - Re-bump)**:
```bash
# Re-run bump-version to sync everything
./dev/bump-version.sh $(cat VERSION)
```

### Issue: "unknown" Version Reported

**Symptom**: `cleo version` returns "unknown"

**Cause**: `VERSION` file not found or not readable

**Diagnosis**:
```bash
# Check if VERSION file exists
ls -la ~/.cleo/VERSION

# Check if version.sh can find it
source ~/.cleo/lib/version.sh
echo "$CLEO_VERSION"
```

**Fix**:
```bash
# Reinstall if VERSION missing
cd /path/to/cleo
./install.sh --force
```

### Issue: Old Version After Install

**Symptom**: `cleo version` shows old version after running `bump-version.sh`

**Cause**: Installed version not updated

**Fix**:
```bash
# Install new version
./install.sh --force

# Verify
cleo version
```

### Issue: Migration Not Running

**Symptom**: `migrate status` shows outdated schema but `migrate run` doesn't upgrade

**Cause**: Missing migration function or version comparison issue

**Diagnosis**:
```bash
# Check current schema version
cat ~/.cleo/<project>/.cleo/todo.json | jq '.schemaVersion'

# Check target version
grep SCHEMA_VERSION_TODO ~/.cleo/lib/migrate.sh
```

**Fix**:
```bash
# Run migration with verbose output
CLEO_DEBUG=1 cleo migrate run
```

### Issue: Schema Versions Out of Sync

**Symptom**: Different schema versions across files (todo.json vs config.json)

**Cause**: Partial migration or file corruption

**Fix**:
```bash
# Check all schema versions
cleo migrate status

# Run full migration
cleo migrate run

# Validate integrity
cleo validate
```

## Related Documentation

- [Installation Guide](installation.md) - Initial setup and install process
- [Migration Guide](migration-guide.md) - Schema migration details and procedures
- [CHANGELOG](../../CHANGELOG.md) - Release history and version changes
- [Configuration Reference](configuration.md) - Config file format and options
- [Troubleshooting Guide](troubleshooting.md) - Common issues and solutions

---

**Version Management Summary**:
- App version: Single `VERSION` file → All documentation
- Schema version: `lib/migrate.sh` constants → Migration functions
- Use `bump-version.sh` for app version updates
- Only bump schema version when data format changes
- Always update `CHANGELOG.md` with version bumps
- Test after every version change
