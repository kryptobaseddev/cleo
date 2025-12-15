# Changelog

All notable changes to the claude-todo system will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.5] - 2025-12-15

### Fixed
- **Legacy injection detection**: `validate` now correctly detects unversioned `<!-- CLAUDE-TODO:START -->` tags as "legacy" instead of "no injection found"
- `validate --fix` upgrades legacy injections to versioned format

## [0.12.4] - 2025-12-15

### Added
- **`validate --fix` for CLAUDE.md**: Auto-updates outdated CLAUDE.md injections
- One-command fix: `validate --fix` now handles both `_meta.version` and CLAUDE.md

## [0.12.3] - 2025-12-15

### Added
- **CLAUDE.md injection check** in `validate` command (check #15)
- **`validate --fix` for `_meta.version`**: Auto-adds schema version if missing
- `_meta.version` field in todo.json template

### Fixed
- **autoArchiveOnComplete schema bug** (T212): Config field now accessible
  - Added `autoArchiveOnComplete` to `schemas/config.schema.json`
  - Fixed `complete-task.sh` to use camelCase config key
  - Updated `templates/config.template.json` with default value

### Changed
- Renamed "Anti-Hallucination Rules" to "Data Integrity Rules" in documentation (T210)
- Updated rationale to explain staleness prevention in multi-writer environments
- All consensus investigation claims resolved (T205-T214)

## [0.12.2] - 2025-12-15

### Added
- CLAUDE.md version check on session start
- `init --update-claude-md` for idempotent injection updates
- Versioned injection tags: `<!-- CLAUDE-TODO:START v0.12.2 -->`

## [0.12.1] - 2025-12-15

### Fixed
- Handle versioned CLAUDE-TODO:START tags in init update

## [0.12.0] - 2025-12-15

### Added
- **Log rotation integration** (T214): Orphaned rotation functions now integrated
  - `check_and_rotate_log()` called automatically on `session end`
  - `claude-todo log rotate` - manual rotation check
  - `claude-todo log rotate --force` - force rotation regardless of size
  - Uses `logging.retentionDays` from todo-config.json (default: 30 days)

### Changed
- **CLAUDE.md injection refactored**: Template-based instead of hardcoded
  - Reduced from ~80 lines to ~20 lines in injected content
  - Focus on `ct` alias commands for LLM agent use
  - Template stored at `~/.claude-todo/templates/CLAUDE-INJECTION.md`
  - Upgradable without modifying init.sh

### Documentation
- Comprehensive `exists` command documentation (661 lines)
  - `docs/commands/exists.md` with CI/CD patterns, script templates
  - Updated `docs/INDEX.md` command reference table
  - New "Task Validation & Scripting" section in TODO_Task_Management.md

## [0.11.0] - 2025-12-15

### Added
- **exists command**: Check if a task ID exists without listing all tasks (T213)
  - `claude-todo exists <task-id>` - Basic existence check
  - `--quiet` - No output, exit code only (for scripting)
  - `--verbose` - Show which file contains the task
  - `--include-archive` - Search archive file too
  - `--format json` - JSON output with metadata
  - Exit codes: 0=exists, 1=not found, 2=invalid ID, 3=file error
  - Eliminates DRY violation (existence checks duplicated across 4+ scripts)
  - Clean API for shell scripting and CI/CD integration

## [0.10.1] - 2025-12-13

### Fixed
- **Backup listing**: `claude-todo backup --list` now correctly displays backups from the new unified taxonomy structure (snapshot, safety, incremental, archive, migration directories)
- **Function collision**: Renamed `file-ops.sh` `rotate_backups()` to `_rotate_numbered_backups()` to avoid collision with `lib/backup.sh` `rotate_backups()`, fixing cosmetic "ERROR: Unknown backup type" messages during complete/archive operations

## [0.10.0] - 2025-12-13

### Added
- **lib/backup.sh**: Unified backup library with 10 public functions
  - `create_snapshot_backup()` - Full state before risky operations
  - `create_safety_backup()` - Automatic before all write operations
  - `create_incremental_backup()` - Changed files only
  - `create_archive_backup()` - Long-term storage
  - `create_migration_backup()` - Schema migrations (never auto-deleted)
  - `rotate_backups()`, `list_backups()`, `restore_backup()`, `get_backup_metadata()`, `prune_backups()`
  - Configuration via todo-config.json with sensible defaults (T161)

- **Backup type taxonomy**: Organized directory structure
  - `.claude/backups/{snapshot,safety,incremental,archive,migration}/`
  - Metadata.json for each backup with checksums, timestamps, trigger info
  - Templates and .gitkeep files for new projects (T163)

- **migrate-backups command**: Legacy backup migration tool
  - `claude-todo migrate-backups --detect` - List and classify legacy backups
  - `claude-todo migrate-backups --dry-run` - Preview migration plan
  - `claude-todo migrate-backups --run` - Execute migration
  - `claude-todo migrate-backups --cleanup` - Remove old .backups directory
  - Classifies: snapshot, safety, archive, migration backup types
  - Preserves original timestamps and paths in metadata (T164)

- **Backup configuration schema**: Extended config.schema.json
  - `backup.enabled` (boolean, default: true)
  - `backup.directory` (string, default: ".claude/backups")
  - `backup.maxSnapshots` (integer, 0-100, default: 10)
  - `backup.maxSafetyBackups` (integer, 0-50, default: 5)
  - `backup.maxIncremental` (integer, 0-100, default: 10)
  - `backup.maxArchiveBackups` (integer, 0-20, default: 3)
  - `backup.safetyRetentionDays` (integer, 0-365, default: 7) (T165)

- **CI/CD integration documentation**: Comprehensive guide
  - GitHub Actions, GitLab CI, Jenkins, CircleCI examples
  - Test automation, artifact management, deployment patterns (T075)

- **Performance optimization**: 1000+ task dataset improvements
  - Caching layer for repeated operations
  - Optimized jq queries and file operations
  - Benchmark scripts for performance testing (T076)

### Changed
- **Script backup integration**: All write operations use lib/backup.sh
  - `complete-task.sh` - Safety backup before task completion
  - `archive.sh` - Archive backup before archiving tasks
  - `migrate.sh` - Migration backup before schema changes
  - `init.sh` - Creates backup directory structure
  - Fallback patterns for backward compatibility (T162)

### Documentation
- **docs/reference/configuration.md**: Comprehensive backup settings documentation
  - Field descriptions, value ranges, retention policies
  - Configuration examples (conservative, aggressive, performance)
  - Environment variable mappings
- **docs/ci-cd-integration.md**: New CI/CD integration guide
- **docs/PERFORMANCE.md**: Performance optimization documentation

### Tasks Completed
- T161: Create unified lib/backup.sh library
- T162: Integrate scripts with unified backup library
- T163: Implement backup type taxonomy and directory structure
- T164: Add legacy backup migration command
- T165: Extend config schema for backup settings
- T075: Add CI/CD integration documentation and examples
- T076: Optimize performance for 1000+ task datasets

## [0.9.9] - 2025-12-13

### Fixed
- **init.sh**: Support running from source directory without global installation
  - Falls back to `$SCRIPT_DIR/../templates` when `~/.claude-todo` doesn't exist
  - Fixes CI test failures for init-related tests
- **init.sh**: Correct checksum calculation to match validate.sh
  - Changed `echo -n '[]'` to `echo '[]'` for consistent newline handling

### Documentation
- **JSON output parsing**: Added examples to prevent incorrect jq usage
  - Added `.tasks[]` examples to TODO_Task_Management.md
  - Added JSON parsing section to CLAUDE.todo.md template
  - Clarifies that JSON output is wrapped: `{ "_meta": {...}, "tasks": [...] }`

## [0.9.8] - 2025-12-13

### Added
- **--add-phase flag**: Create new phases on-the-fly when adding or updating tasks
  - `claude-todo add "Task" --phase new-phase --add-phase` creates phase automatically
  - Auto-generates human-readable name from slug (e.g., "test-phase" → "Test Phase")
  - Assigns next available order number
  - Works in both `add` and `update` commands (T177)

### Changed
- **Title validation error message**: Now shows actual character count
  - Before: `Title too long (max 120 characters)`
  - After: `Title too long (145/120 characters)`
  - Helps users understand exactly how much to trim (T175)
- **Phase validation errors**: Now list valid phases when invalid phase used
  - Error format: `Phase 'foo' not found. Valid phases: setup, core, polish. Use --add-phase to create new.`
  - Handles edge case when no phases are defined (T177)

### Documentation
- **Complete command**: Documented `--notes` and `--skip-notes` requirements
  - Updated command help text with clear examples
  - Updated QUICK-REFERENCE.md with complete options table
  - Updated TODO_Task_Management.md with session protocol examples (T176)

### Tasks Completed
- T175: Show character count in title length validation error
- T176: Document --notes/--skip-notes requirement for complete command
- T177: Improve phase validation errors with valid options and add-phase flag

## [0.9.7] - 2025-12-13

### Added
- **lib/dependency-check.sh**: Centralized dependency validation module
  - Individual check functions for all required tools (jq, bash, sha256sum, tar, flock, numfmt, date, find)
  - Platform-aware install hints for Linux (apt/dnf/yum/pacman), macOS (brew), and Windows
  - `validate_all_dependencies()` master function with `--quiet` and `--strict` options
  - `quick_dependency_check()` for runtime validation
  - Cross-platform fallbacks (sha256sum→shasum, numfmt→gnumfmt)
- **install.sh --check-deps**: Check system dependencies without installing
- **install.sh --install-deps**: Attempt automatic dependency installation via system package manager
- **Pre-install validation**: Installation now validates all dependencies before proceeding

### Changed
- **install.sh**: Integrated comprehensive dependency checking before installation (T166)
  - Validates critical deps (jq, bash 4+) and required deps (sha256sum, tar, flock, date, find)
  - Shows platform-specific install commands for missing dependencies
  - Cross-platform checksum generation (sha256sum or shasum -a 256)
- **lib/platform-compat.sh**: Added bash version validation (T168)
  - New `check_bash_version()` function requiring bash 4.0+
  - New `get_bash_version_info()` helper
  - Enhanced `check_required_tools()` with bash version validation
- **scripts/export.sh**: Added jq dependency check with install hints (T167)
- **scripts/migrate.sh**: Added jq dependency check with install hints (T167)
- **Shebang consistency**: Standardized to `#!/usr/bin/env bash` across all scripts

### Tasks Completed
- T166: Master dependency check in install.sh
- T167: jq check in export.sh and migrate.sh
- T168: Bash version check in platform-compat.sh
- T169: Auto-installer option (--install-deps)
- T170: sha256sum/shasum cross-platform check
- T171: tar availability check
- T172: flock check with macOS hint
- T173: numfmt/gnumfmt cross-platform check
- T174: date/find POSIX tools check

## [0.9.6] - 2025-12-13

### Fixed
- **T132: Task ID Collision**: Implemented atomic ID generation with flock
  - Prevents race conditions when multiple processes add tasks concurrently
  - Lock acquired before ID generation, held through task write
  - 30-second timeout with proper cleanup on exit/error
- **T144: Validate Checksum Recovery**: Fixed error counting logic
  - `validate --fix` no longer increments error count when fix succeeds
  - Correct exit code (0) after successful checksum repair
- **T146: File Locking Concurrency**: Fixed lock_file function
  - Immediate exit on flock timeout instead of retrying all FDs
  - Proper distinction between "can't open FD" vs "lock held by other process"
- **T160: Schema Validation**: Added missing validation checks
  - Schema version compatibility check (major version 2.x required)
  - Required field validation (id, title, status, priority, createdAt)

### Changed
- **CI Workflow**: Added bats-core installation for GitHub Actions
  - Tests now run correctly in CI environment
  - Helper libraries bundled in tests/libs/

### Tests Fixed
- **T145**: Orphaned dependency cleanup (verified already working)
- **T147**: Stats command test assertions (case sensitivity, variable scope)
- **T159**: Integration workflow tests (15/15 passing)
  - Fixed pipefail interaction in circular dependency validation
  - Fixed archive flag (--force → --all) for test scenarios
  - Fixed focus field name (.currentTaskId → .currentTask)
- **edge-cases.bats**: Fixed archive flag for orphaned dependency tests
- **error-recovery.bats**: Fixed archive flag for dependency cleanup tests

### Tasks Completed
- T132: P0 - Fix task ID collision under concurrent operations
- T144: Fix validate checksum recovery test
- T145: Fix orphaned dependency cleanup tests
- T146: Fix file locking concurrency tests
- T147: Fix stats command tests
- T159: Fix integration workflow tests
- T160: Fix schema validation tests

## [0.9.5] - 2025-12-13

### Fixed
- **complete-task.sh Backup Rotation**: Added automatic rotation for safety backups
  - Previously created unlimited backup files (100+ files, 3.3MB bloat)
  - Now maintains max 10 backups with mtime-based rotation
  - Cross-platform support (GNU find + macOS stat fallback)
- **file-ops.sh Path Calculation Bug**: Fixed BACKUP_DIR path concatenation
  - Changed from `.claude/.backups` (absolute) to `.backups` (relative)
  - Fixes nested directory creation (`.claude/.claude/.backups/`)
  - Backups now correctly go to `.claude/.backups/`
- **safe_find Edge Cases**: Implemented mtime-based sorting for backup operations
  - New `safe_find_sorted_by_mtime()` function in platform-compat.sh
  - Works with any filename format (timestamps, numbered, mixed)
  - Replaces fragile filename parsing (`sort -t. -k2 -n`)
  - Cross-platform (GNU find -printf, BSD stat fallback)

### Added
- **docs/commands/restore.md**: Comprehensive restore command documentation (937 lines)
  - Full command reference with all options
  - Step-by-step restore procedures
  - Recovery scenarios and troubleshooting
  - Best practices and workflow examples
- **safe_find_sorted_by_mtime()**: Platform-compatible backup file sorting function
  - Added to lib/platform-compat.sh
  - Sorts files by modification time (oldest first)
  - Enables correct rotation and restore operations

### Changed
- **docs/QUICK-REFERENCE.md**: Added restore command examples
- **docs/INDEX.md**: Added restore.md to command documentation list
- **file-ops.sh**: Updated rotate_backups(), restore_backup(), list_backups() to use mtime sorting

## [0.9.4] - 2025-12-13

### Changed
- **TODO_Task_Management.md**: Comprehensive update for LLM instructions
  - Added all Analysis & Planning commands (dash, next, phases, labels, deps, blockers)
  - Added all Maintenance commands (backup, restore, migrate)
  - Added focus clear/next subcommands
  - Added session status subcommand
  - Added list --phase filter and all output formats
  - Updated aliases (tags, overview)
  - Updated error recovery with restore and migrate solutions
  - This file is copied to `~/.claude/` during installation for LLM context

## [0.9.3] - 2025-12-13

### Fixed
- **CLI Help**: Added `phases` to hardcoded help command list
  - `phases` was in CMD_MAP but missing from `show_main_help()` display loop
  - `claude-todo help` now shows phases command

## [0.9.2] - 2025-12-13

### Fixed
- **CLI Wrapper**: Added missing `phases` command to CLI routing
  - `phases.sh` script existed but was not registered in `install.sh` CMD_MAP
  - `claude-todo phases` now works correctly

## [0.9.1] - 2025-12-13

### Fixed
- **Documentation Accuracy**: Achieved 100% documentation accuracy across all priority levels
  - **P0 Critical** (3 issues): Removed phantom features (CSV/TSV in list, validate_anti_hallucination), implemented migrate.sh --force
  - **P1 High** (7 issues): Created missing docs (phases.md, export.md, backup.md), documented cache.sh and analysis.sh libraries
  - **P2 Medium** (5 commands): Fixed complete-task.sh, focus.sh, labels.sh, blockers-command.sh, deps-command.sh documentation
  - **P3 Low** (68 functions): Fully documented output-format.sh, logging.sh, file-ops.sh, validation.sh libraries
- **Code Fixes**:
  - `scripts/migrate.sh`: Implemented --force flag (was documented but not parsed)
  - `scripts/focus.sh`: Fixed task ID format (T001 not task_timestamp), removed .content fallback

### Changed
- **docs/QUICK-REFERENCE.md**: Added comprehensive library documentation for 65+ functions
- **docs/commands/**: Created phases.md, export.md, backup.md with full command references
- **docs/INDEX.md**: Updated with all new command documentation references

### Added
- **claudedocs/FINAL-DOCUMENTATION-STATUS.md**: Complete documentation accuracy report

## [0.9.0] - 2025-12-12

### Added
- **phases.sh**: New command for phase management
  - `claude-todo phases list` - Display all phases with progress bars
  - `claude-todo phases show <phase>` - Show tasks in specific phase
  - `claude-todo phases stats` - Detailed phase statistics
- **Index Caching**: O(1) label and phase lookups via cache.sh library
- **Critical Path Analysis**: analysis.sh library for dependency analysis
- **Golden Tests**: Comprehensive test fixtures for all commands

### Changed
- **Performance**: Significant improvements via caching layer
- **Dashboard**: Enhanced dash command with phase integration

## [0.8.3] - 2025-12-12

### Fixed
- **Atomic Archive Operations**: Implemented proper atomic operations with dependency cleanup
- **Archive Consistency**: Fixed race conditions in archive operations

## [0.8.2] - 2025-12-12

### Fixed
- **NO_COLOR Support**: Proper handling of NO_COLOR environment variable
- **Format Validation**: Consistent format validation across all commands
- **Short Flags**: Fixed short flag parsing inconsistencies

## [0.8.1] - 2025-12-12

### Fixed
- **Critical Bug Fixes**: NO_COLOR handling, short flags, consistency improvements

## [0.7.1] - 2025-12-12

### Fixed
- **Documentation Links**: Fixed all broken cross-references throughout documentation
  - Root README.md: Fixed 3 broken links to installation.md and migration-guide.md
  - All docs now correctly reference `reference/` directory structure
- **Final Documentation Structure**: Finalized structure with 19 files
  - `architecture/`: ARCHITECTURE.md, DATA-FLOWS.md, SCHEMAS.md
  - `integration/`: CLAUDE-CODE.md, WORKFLOWS.md
  - `reference/`: installation.md, configuration.md, command-reference.md, troubleshooting.md, migration-guide.md
  - `getting-started/`: quick-start.md
  - `guides/`: filtering-guide.md

### Changed
- **SCHEMAS.md**: Added CLI configuration section (aliases, plugins, debug)
- **DOCS-MIGRATION-GUIDE.md**: Marked as internal/temporary document
- **INDEX.md**: Added TODO_Task_Management.md to user guides

## [0.7.0] - 2025-12-12

### Changed
- **BREAKING: Documentation Restructured** - Complete documentation reorganization for improved maintainability
  - Created `docs/getting-started/` directory with `installation.md`, `quick-start.md`
  - Created `docs/guides/` directory with `command-reference.md`, `workflow-patterns.md`, `filtering-guide.md`, `configuration.md`
  - Created `docs/reference/` directory with `schema-reference.md`, `troubleshooting.md`
  - Consolidated `SYSTEM-DESIGN-SUMMARY.md` into `ARCHITECTURE.md` (single source of truth)
  - Reduced `usage.md` from 1,939 to 599 lines (69% reduction)
  - Added `docs/README.md` as documentation navigation hub
  - See `docs/DOCS-MIGRATION-GUIDE.md` for path changes

### Added
- **docs/guides/command-reference.md**: Comprehensive CLI command documentation (~843 lines)
- **docs/guides/workflow-patterns.md**: Session management, task lifecycle, recipes (~807 lines)
- **docs/guides/filtering-guide.md**: Advanced filtering and query techniques (~704 lines)
- **docs/getting-started/quick-start.md**: 5-minute getting started guide (~312 lines)
- **docs/README.md**: Documentation index and navigation hub
- **docs/DOCS-MIGRATION-GUIDE.md**: Migration guide for users with existing bookmarks

### Removed
- **docs/SYSTEM-DESIGN-SUMMARY.md**: Content merged into ARCHITECTURE.md

### Fixed
- **install.sh**: Updated to copy new docs subdirectory structure (guides/, getting-started/, reference/)
- All internal documentation cross-references updated for new paths

## [0.6.1] - 2025-12-12

### Added
- **PLUGINS.md**: Comprehensive plugin architecture and development documentation
  - Plugin structure, metadata format, and examples
  - Future roadmap (4 phases) for plugin system evolution
  - Integration with configuration system

### Changed
- **Label Pattern Fix**: Extended label regex to allow periods for version tags
  - Pattern: `^[a-z][a-z0-9.-]*$` (was `^[a-z][a-z0-9-]*$`)
  - Labels like `v0.6.0`, `v1.2.3` now supported
  - Updated in: `todo.schema.json`, `add-task.sh`, `update-task.sh`, `schema-reference.md`
- **Documentation Index**: Added PLUGINS.md to docs/INDEX.md navigation

## [0.6.0] - 2025-12-12

### Added
- **CLI Command Aliases**: Built-in aliases for common commands
  - `ls` → `list`, `done` → `complete`, `new` → `add`
  - `edit` → `update`, `rm` → `archive`, `check` → `validate`
  - Configurable via `cli.aliases` in config
- **Plugin System Foundation**: Auto-discovery plugin architecture
  - Global plugins: `~/.claude-todo/plugins/`
  - Project plugins: `./.claude/plugins/`
  - Plugin metadata format with `###PLUGIN` blocks
- **Debug Validation Mode**: CLI diagnostics and integrity checking
  - `claude-todo --validate` or `claude-todo --debug`
  - `claude-todo --list-commands` to show all commands
  - `CLAUDE_TODO_DEBUG=1` environment variable
- **Script Checksums**: Integrity verification for installed scripts
  - Generates `checksums.sha256` during installation
  - Verifies in debug mode to detect modifications
- **Config Schema Extension**: New `cli` section for CLI settings
  - `cli.aliases` - Command alias mappings
  - `cli.plugins` - Plugin discovery settings
  - `cli.debug` - Debug and validation settings

### Changed
- **CLI Wrapper**: Enhanced v2 wrapper with alias resolution and plugin discovery
- **Help Output**: Now displays aliases and discovered plugins
- **Install Script**: Creates plugins directory and checksums

## [0.5.0] - 2025-12-12

### Added
- **Task Management Documentation**: `TODO_Task_Management.md`
  - Concise CLI usage instructions for context injection
  - Installed to `~/.claude/TODO_Task_Management.md`
  - Auto-appends `@TODO_Task_Management.md` to `~/.claude/CLAUDE.md`
- **CLAUDE.md Injection Enhancement**: Added missing commands
  - `update` command with options
  - `export --format todowrite` command
  - Common options examples

### Changed
- **Install Script**: Copies docs to `~/.claude/` (not symlink)
- **Init Script**: Updated CLAUDE.md injection template

## [0.4.0] - 2025-12-09

### Added
- **update-task.sh**: New command to update existing task fields
  - Scalar fields: `--title`, `--status`, `--priority`, `--description`, `--phase`, `--blocked-by`
  - Array fields with append-by-default: `--labels`, `--files`, `--acceptance`, `--depends`, `--notes`
  - Replace mode: `--set-labels`, `--set-files`, `--set-acceptance`, `--set-depends`
  - Clear mode: `--clear-labels`, `--clear-files`, `--clear-acceptance`, `--clear-depends`
- **CLI routing**: Added `update` command to main CLI wrapper
- **Documentation**: Full update-task.sh section in usage.md, CLAUDE.md, README.md

### Changed
- **install.sh**: Added update command to CMD_MAP and CMD_DESC arrays
- **Help output**: Update command now appears in `claude-todo help`

## [0.3.1] - 2025-12-06

### Changed
- **Checksum behavior**: Changed from blocking to detection-only (INFO log instead of ERROR + exit)
- **Multi-writer support**: CLI now works seamlessly with TodoWrite tool modifications
- **Documentation reorganization**: Moved ARCHITECTURE.md, SYSTEM-DESIGN-SUMMARY.md, MIGRATION-SYSTEM-SUMMARY.md to docs/
- **README.md**: Added badges, table of contents, improved structure for open source

### Fixed
- **complete-task.sh**: No longer fails when TodoWrite modifies todo.json
- **Cross-references**: Updated all internal doc links after file moves
- **Field naming**: Fixed snake_case to camelCase in docs (createdAt, completedAt)

### Updated
- **DATA-FLOW-DIAGRAMS.md**: Revised checksum flow diagram to reflect detection-only behavior
- **design-principles.md**: Added architectural decision for checksum behavior
- **INDEX.md**: Added missing docs (migration-guide.md, ENHANCEMENT-todowrite-integration.md)

## [0.3.0] - 2025-12-06

### Added
- **Checksum verification diagram**: Visual workflow in DATA-FLOW-DIAGRAMS.md
- **Log format versioning**: `formatVersion` field in log schema for future compatibility
- **Template documentation**: README.md documenting placeholder contract ({{PROJECT_NAME}}, {{TIMESTAMP}}, {{CHECKSUM}})
- **activeForm documentation**: Explained auto-derived field in design-principles.md

### Changed
- **archive.sh help**: Comprehensive explanation of --force vs --all behavior with examples
- **stats.sh help**: Added JSON output structure documentation
- **Performance targets**: Clarified as design goals, not verified benchmarks
- **Error messages**: Updated troubleshooting.md to match actual [ERROR] format
- **Archive metadata**: Fixed schema-reference.md (sessionId/cycleTimeDays are optional)
- **INDEX.md**: Added design-principles.md to Architecture section

### Verified
- Session protocol in WORKFLOW.md is fully implemented (session, focus, log commands)
- All 7 test suites passing
- CI/CD pipeline functional

## [0.2.6] - 2025-12-06

### Added
- **Date filtering**: `--since` and `--until` options for list-tasks.sh
- **Sorting**: `--sort` option (status, priority, createdAt, title) and `--reverse` flag
- **Test coverage**: New tests for session, focus, export, and migrate commands (7 total test suites)
- **CI/CD**: GitHub Actions workflow with test, lint, JSON validation, and install jobs
- **CONTRIBUTING.md**: Comprehensive contribution guidelines for open source

### Changed
- Documentation fully aligned with implemented features

## [0.2.5] - 2025-12-05

### Added
- CHANGELOG.md for version tracking

## [0.2.4] - 2025-12-06

### Changed
- Install script now auto-upgrades without prompts when newer version available
- Same version shows "already up to date" instead of prompting
- Downgrade requires confirmation (safety check)

### Fixed
- Readonly variable conflict in stats.sh (`LOG_FILE` → `STATS_LOG_FILE`)

## [0.2.3] - 2025-12-06

### Fixed
- Stats command failed due to readonly variable conflict with logging.sh

## [0.2.2] - 2025-12-06

### Added
- Platform compatibility layer (`lib/platform-compat.sh`)
  - Cross-platform support for Linux, macOS, Windows/WSL
  - Tool detection with helpful error messages
  - Cross-platform date/time, file operations, random generation
- Schema migration system (`lib/migrate.sh`, `scripts/migrate.sh`)
  - Safe version upgrades with automatic backup and rollback
  - Version checking integrated with validation
  - `claude-todo migrate status/check/run` commands
- `--force` flag to install.sh for non-interactive upgrades
- `migrate` command to CLI wrapper

### Fixed
- Documentation: archive.sh options (removed non-existent `--days`, `--verbose`)
- Documentation: complete-task.sh options (only `--skip-archive` exists)
- Documentation: config field names updated to camelCase throughout
- Documentation: log entry structure in QUICK-REFERENCE.md
- Documentation: PATH setup clarified in installation.md

## [0.2.1] - 2025-12-05

### Added
- TodoWrite integration for Claude Code
- `claude-todo export --format todowrite` command
- Grammar transformation library for activeForm generation
- Export to JSON and Markdown formats

## [0.2.0] - 2025-12-05

### Changed
- CLI works immediately after install (symlinks in ~/.local/bin)
- No shell restart required for Claude Code

### Fixed
- PATH configuration for immediate use

## [0.1.0] - 2025-12-05

### Added
- Initial release with centralized versioning
- Core task management (add, complete, list, archive)
- Session management (start, end, status)
- Focus tracking (set, clear, note)
- Validation with anti-hallucination checks
- Automatic backups
- Statistics and reporting

## [0.0.1] - 2025-12-05

### Added
- Initial project structure
- JSON schemas for todo, config, archive, log
- Basic CLI wrapper
