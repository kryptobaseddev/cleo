# Changelog

All notable changes to the claude-todo system will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.32.4] - 2025-12-24

### Changed
- **Task Notes Max Length**: Increased from 500 to 5000 characters
  - Allows for more detailed implementation logs and context
  - Schema version bumped to 2.4.0 (backwards compatible)
  - Updated: `lib/validation.sh`, `schemas/todo.schema.json`, `lib/migrate.sh`
  - Updated compliance checks and documentation

## [0.32.2] - 2025-12-24

### Fixed
- **CLAUDE.md Injection Duplication Bug**: Fixed critical bug in `init.sh --update-claude-md`
  - Previous sed logic only removed first START/END block, leaving duplicates behind
  - Each update would append content, growing CLAUDE.md exponentially (1603 lines → 557 lines after fix)
  - Now uses awk to strip ALL injection blocks before prepending new template
  - Injection correctly placed at TOP of file (was appending to bottom)

- **JSON Escaping in Validate**: Fixed jq parse error in `validate.sh`
  - `add_detail()` function now properly escapes control characters using `jq -nc --arg`
  - Previously, unescaped newlines/tabs in messages caused "Invalid string: control characters" errors

### Changed
- `init.sh`: New injection always prepended (not appended) to CLAUDE.md
- `init.sh`: Regular init flow also prepends injection for consistency

## [0.32.1] - 2025-12-24

### Fixed
- **Init Command Safety Safeguards**: Prevent accidental data wipe on reinitialize
  - `--force` alone no longer wipes existing data (was incorrectly wiping all data files)
  - Now requires double confirmation: `--force --confirm-wipe` for destructive reinit
  - Creates safety backup of ALL data files before wipe (todo.json, todo-archive.json, todo-config.json, todo-log.json)
  - Clear warnings listing exactly which files would be wiped
  - Proper exit codes: 101 (already initialized), 2 (missing --confirm-wipe)
  - LLM-agent-first JSON error output with full context

### Added
- New error codes: `E_ALREADY_INITIALIZED`, `E_CONFIRMATION_REQUIRED`
- Source guard in `lib/error-json.sh` to prevent double-sourcing conflicts
- Safety backup metadata with `init_reinitialize` trigger type

### Documentation
- Updated `docs/commands/init.md` with new safeguard behavior and JSON examples
- Updated `docs/reference/exit-codes.md` with new error codes

## [0.32.0] - 2025-12-24

### Added
- **Task Deletion System with Cancelled Status** (T700 EPIC): Complete soft-delete functionality
  - New `delete` command (`cancel` alias) for task cancellation with required `--reason`
  - Child handling strategies: `--children cascade|orphan|block` (default: block)
  - Cascade limit with `--limit N` (default: 10) for safety
  - Dry-run preview with `--dry-run` flag showing impact analysis
  - New `uncancel` command (`restore-cancelled` alias) to restore cancelled tasks
  - Cascade restore with `--cascade` flag for parent+children restoration
  - New `cancelled` status in task schema (v3.1.0)
  - Exit codes: `EXIT_HAS_CHILDREN` (16), `EXIT_TASK_COMPLETED` (17), `EXIT_CASCADE_FAILED` (18)
  - Focus auto-clear when deleting focused task
  - Archive integration with `cancellationDetails` object
  - Dependency cleanup on delete (removes from dependents' `depends` arrays)
  - Audit logging with `task_cancelled` and `task_restored_from_cancelled` actions
  - TodoWrite sync excludes cancelled tasks from injection

### New Files
- `scripts/delete.sh` - Delete command entry point
- `scripts/uncancel.sh` - Restore cancelled tasks command
- `lib/cancel-ops.sh` - Core cancellation operations
- `lib/deletion-strategy.sh` - Child handling strategy pattern
- `lib/delete-preview.sh` - Dry-run preview functionality
- `lib/archive-cancel.sh` - Archive integration for cancelled tasks
- `docs/commands/delete.md` - Delete command documentation
- `docs/commands/uncancel.md` - Uncancel command documentation

### Schema Updates
- `todo.schema.json` v3.1.0: Added `cancelled` status, `cancelledAt`, `cancellationReason` fields
- `archive.schema.json`: Added `cancelled` reason, `cancellationDetails` object, `statistics.cancelled`
- `config.schema.json`: Added `cancellation.*` settings (cascadeConfirmThreshold, requireReason, etc.)
- `error.schema.json`: Added deletion-related error codes

### Tests
- `tests/unit/delete.bats` (41 tests) - Delete command unit tests
- `tests/unit/uncancel.bats` (25 tests) - Uncancel command unit tests
- `tests/unit/cancel-ops.bats` (39 tests) - Core operations tests
- `tests/unit/delete-preview.bats` (26 tests) - Dry-run preview tests
- `tests/integration/delete-workflow.bats` (30 tests) - Full lifecycle tests

## [0.31.2] - 2025-12-23

### Added
- **LLM-Agent-First Spec v3.0 Compliance** (T481 EPIC): Complete compliance checker implementation
  - New compliance check modules: `input-validation.sh`, `idempotency.sh`, `dry-run-semantics.sh`
  - Command idempotency with `EXIT_NO_CHANGE` (102) exit code
  - Duplicate detection in `add` command (60s window)
  - Dry-run format compliance with `dryRun`/`wouldCreate` JSON fields

### Fixed
- **Input validation compliance**: Added `validation.sh` sourcing to `complete-task.sh`, `archive.sh`, `session.sh`

### Documentation
- New `docs/reference/exit-codes.md` - comprehensive exit codes and retry protocol reference
- Updated `docs/commands/add.md`, `update.md`, `complete.md` with idempotency sections
- Updated `LLM-AGENT-FIRST-IMPLEMENTATION-REPORT.md` to v5.0

### Tests
- New `tests/unit/compliance-checks.bats` (22 tests) - compliance check module tests
- New `tests/integration/idempotency.bats` (14 tests) - EXIT_NO_CHANGE behavior tests

## [0.31.1] - 2025-12-23

### Fixed
- **Archive-stats date filter** (T693): Fixed `--since` and `--until` combined filter
  - Date-only inputs (YYYY-MM-DD) now properly compare against ISO timestamps
  - Added `normalize_date_for_compare()` function to handle date normalization
  - `--since` dates append `T00:00:00Z` (start of day)
  - `--until` dates append `T23:59:59Z` (end of day)
  - Full ISO timestamps pass through unchanged

## [0.31.0] - 2025-12-22

### Added
- **Smart Archive System Enhancement** (T429 EPIC): Advanced archive analytics and filtering
  - `archive-stats` command with summary, by-phase, by-label, cycle-times, and trends reports
  - Date filtering with `--since` and `--until` options
  - Multiple output formats: JSON, text, CSV
  - Cycle time analytics with percentiles and distribution

## [0.30.3] - 2025-12-23

### Fixed
- **Tree Truncation Bug**: Fixed truncation not working in `--human` mode
  - Removed incorrect `FORMAT == "text"` check that bypassed truncation
  - Truncation now respects `$COLUMNS` for all non-`--wide` output
  - Only `--wide` flag disables truncation (as intended)

### Tests
- Expanded tree-alias.bats from 16 to 32 tests
  - Added T673 priority icon tests
  - Added T674 tree connector tests (├── └── │)
  - Added T675 truncation behavior tests
  - Added T676 --wide flag tests

## [0.30.2] - 2025-12-23

### Added
- **Enhanced Tree Rendering** (T672 EPIC): Improved `list --tree` output
  - Priority icons: 🔴 critical, 🟡 high, 🔵 medium, ⚪ low (ASCII fallback: !HML)
  - Proper tree connectors: ├── (middle child), └── (last child), │ (continuation)
  - Terminal-width-aware truncation (based on $COLUMNS)
  - `--wide` flag for full titles without truncation

### Documentation
- Updated `docs/commands/list.md` with tree rendering examples
- Added tree features reference with status/priority icons and connector explanation

### Tests
- Initial tree rendering tests in `tree-alias.bats`

## [0.30.1] - 2025-12-23

### Fixed
- **Pre-Cleo Migration Test Fixes** (T666 EPIC): Resolved all test failures before Cleo migration
  - Config version mismatch in `common_setup.bash`: 2.1.0 → 2.2.0 (matches SCHEMA_VERSION_CONFIG)
  - Dry-run test missing `--format json` flag in `hierarchy-workflow.bats`
  - Schema ID test updated to URL format: `https://claude-todo.dev/schemas/v1/todo.schema.json`
  - `migrate-backups.sh` output_error calls now consistently pass suggestion argument

### Tests
- All 11 child tasks of T666 EPIC complete
- migrate.bats: 24/24 passing
- hierarchy-workflow.bats: 29/29 passing
- migrate-backups.bats: 15/15 passing
- schema-validation.bats: 44/44 passing

## [0.30.0] - 2025-12-22

### Added
- **Manifest Backup Tracking** (T631): Automatic tracking of all backup operations
  - `_add_to_manifest()` records every backup creation with metadata
  - `_remove_from_manifest()` cleans up manifest on rotation/prune
  - Manifest stored in `.claude/backups/backup-manifest.json`
  - Tracks: backup type, timestamp, file checksums, retention policy
  - 19 new tests for manifest operations

- **Scheduled Backup System** (T632): Configurable automatic backups
  - `backup.scheduled.onArchive`: Auto-backup before archive operations (default: true)
  - `backup.scheduled.intervalMinutes`: Minimum time between auto-backups (default: 60)
  - `backup --auto`: Run scheduled backup if interval elapsed
  - `auto_backup_on_archive()`: Called automatically from archive.sh
  - `check_backup_interval()`: Respects configured interval
  - 12 new tests for scheduled backup behavior

- **Enhanced Backup Search** (T633): Advanced search capabilities
  - `--on DATE`: Find backups from exact date (e.g., `--on 2025-12-20`, `--on today`)
  - `--task-id ID`: Find backups containing specific task (e.g., `--task-id T045`)
  - `--contains PATTERN`: Alias for `--grep` content search
  - `--verbose`: Show matched content snippets in search results
  - `backup search` subcommand as alias for `backup find`
  - 6 new tests for search functionality

### Documentation
- Updated `docs/commands/backup.md` with Phase 3 features
- Updated `TODO_Task_Management.md` with new backup commands
- Added scheduled backup configuration examples
- Added manifest tracking section to backup documentation

### Tests
- 37 new tests for Phase 3 backup features (T631: 19, T632: 12, T633: 6)
- All 80 backup tests passing
- Full test suite: 1452 passed

## [0.29.3] - 2025-12-23

### Fixed
- **Missing safe_checksum_stdin Function**: Added `safe_checksum_stdin()` to `lib/platform-compat.sh`
  - Companion to `safe_checksum()` for checksumming piped data
  - Fixes manifest-related backup tests that were failing with "command not found"

- **Backup Config Detection**: Fixed `onArchive` config detection in `lib/backup.sh`
  - Changed from `// true` to explicit null check for correct boolean handling
  - Fixes case where `onArchive: false` was being treated as null → true

- **Archive Backup Function**: Updated `scripts/archive.sh` to use `auto_backup_on_archive()`
  - Respects `backup.scheduled.onArchive` config setting
  - Falls back to `create_archive_backup()` if auto function unavailable

### Tests
- Fixed manifest tests in `tests/unit/backup.bats` to use correct `BACKUP_DIR`
  - Added `_setup_manifest_test()` helper for proper Tier 2 directory setup
  - Fixes BACKUP_DIR confusion between Tier 1 (.backups) and Tier 2 (backups/)

## [0.29.2] - 2025-12-23

### Fixed
- **VERSION Unbound Variable** (T665): Fixed `update-task.sh` line 1191
  - Replaced `$VERSION` with `${CLAUDE_TODO_VERSION:-$(get_version)}`
  - Matches pattern used throughout codebase and in dry-run output
  - Bug caused "VERSION: unbound variable" error when adding notes

## [0.29.1] - 2025-12-23

### Added
- **Tree Alias Command** (T648): New `tree` alias for hierarchical task display
  - `ct tree` is equivalent to `ct list --tree`
  - Accepts all `list` filters: `--status`, `--priority`, `--type`, `--parent`
  - Example: `ct tree --parent T001` shows subtree rooted at T001
  - Example: `ct tree --type epic` shows only epics in tree format

- **Aliased Flags Support**: Enhanced dispatcher to handle command aliases with flags
  - `resolve_command()` now returns format `type:command:aliased_flags`
  - Supports aliases like `[tree]="list --tree"` that include flags
  - Extensible pattern for future aliases needing flag injection

### Fixed
- **Type Filter Validation** (T646): Added validation for `--type` filter value
  - Rejects invalid types with proper error message and exit code 2
  - Valid values: `epic`, `task`, `subtask`

- **Magic Exit Codes** (T646): Replaced hardcoded exit codes in `list-tasks.sh`
  - Dependency check: now uses `$EXIT_DEPENDENCY_ERROR` (5)
  - File not found: now uses `$EXIT_NOT_FOUND` (4)
  - Invalid input: now uses `$EXIT_INVALID_INPUT` (2)

- **Error Messages**: Improved error output with recovery suggestions
  - jq dependency error includes installation instructions
  - File not found includes `claude-todo init` suggestion

### Documentation
- Updated `docs/commands/hierarchy.md` with tree alias documentation
- Updated `docs/commands/COMMANDS-INDEX.json` with tree command entry
- Updated `templates/CLAUDE-INJECTION.md` with tree alias examples

### Tests
- New `tests/unit/tree-alias.bats`: Comprehensive tree alias test suite
  - Alias resolution tests
  - Flag passthrough tests (status, priority, type, parent)
  - JSON format tests
  - Output parity tests (tree vs list --tree)
  - Filter validation tests

## [0.29.0] - 2025-12-23

### Added
- **Backup Find Command**: New `backup find` subcommand for searching backups
  - `--since DATE`: Filter backups after date (ISO or relative: "7d", "1w")
  - `--until DATE`: Filter backups before date
  - `--type TYPE`: Filter by backup type (snapshot, safety, archive, migration)
  - `--name PATTERN`: Filter by name pattern (glob matching)
  - `--grep PATTERN`: Search backup content for pattern
  - `--limit N`: Limit results (default: 20)

- **Enhanced Backup Library**: Complete two-tier backup architecture in `lib/backup.sh`
  - Tier 1: Operational backups (atomic write safety) in `.backups/`
  - Tier 2: Recovery backups (point-in-time snapshots) in `.claude/backups/{type}/`
  - Backup types: `snapshot`, `safety`, `archive`, `migration`
  - Functions: `create_snapshot_backup()`, `create_safety_backup()`, `rotate_backups()`
  - Metadata tracking with checksums and retention policies

### Documentation
- New `docs/reference/disaster-recovery.md`: Comprehensive disaster recovery guide
- Updated backup command documentation with find subcommand
- Architecture documentation updated with two-tier backup design

## [0.28.1] - 2025-12-23

### Added
- **Tab Completion Release (T637 EPIC)**: Complete tab completion feature
  - `install.sh` now copies completion scripts to `~/.claude-todo/completions/`
  - Setup instructions displayed after installation
  - `docs/commands/tab-completion.md`: Comprehensive documentation (314 lines)
  - `docs/TODO_Task_Management.md`: Added Tab Completion section
  - `tests/unit/completion.bats`: 30 unit tests for completion scripts

### Fixed
- **Exit Code Documentation**: Updated COMMANDS-INDEX.json with missing exit codes
  - `add-task.sh`: Added codes 3 (FILE_ERROR), 4 (NOT_FOUND), 5 (DEPENDENCY_ERROR), 7 (LOCK_TIMEOUT)
  - `update-task.sh`: Added code 3 (FILE_ERROR)

- **detect_orphans() Compatibility**: Fixed JSON parsing in `lib/validation.sh`
  - `detect_orphans()` returns JSON array, validation.sh now properly parses it
  - Previously used space-separated iteration which was incompatible with JSON output

## [0.28.0] - 2025-12-23

### Added
- **Hierarchy Index Caching (T348)**: O(1) lookups for hierarchy operations
  - New cache files: `hierarchy.index.json`, `children.index.json`, `depth.index.json`
  - New functions in `lib/cache.sh`:
    - `cache_init_hierarchy()`: Initialize hierarchy cache
    - `cache_get_parent()`: O(1) parent lookup
    - `cache_get_children()`: O(1) children lookup
    - `cache_get_depth()`: O(1) depth lookup
    - `cache_get_child_count()`: O(1) child count
    - `cache_get_root_tasks()`, `cache_get_leaf_tasks()`, `cache_get_tasks_at_depth()`
    - `cache_hierarchy_stats()`: JSON statistics
  - Auto-rebuilds when todo.json changes (checksum-based staleness detection)
  - 11 unit tests in `tests/unit/cache-hierarchy.bats`

- **Tab Completion (T347)**: Bash and Zsh completion scripts
  - `completions/bash-completion.sh`: Full Bash completion support
  - `completions/zsh-completion.zsh`: Full Zsh completion support
  - Context-aware `--parent` completion (only suggests epic/task types, not subtasks)
  - Task ID completion with title hints
  - Phase, label, status, priority completion
  - All command options and subcommands

### Fixed
- **Tree Performance Bug**: Fixed "Argument list too long" error with large datasets
  - Changed `list-tasks.sh` to use temporary files + `--slurpfile` instead of CLI arguments
  - Prevents shell argument limit errors when tree JSON is large (500+ tasks)

### Documentation
- Updated `docs/commands/focus.md` with hierarchy context features
- Updated `docs/commands/next.md` with hierarchy-aware scoring documentation
  - Epic context bonus (+30)
  - Leaf task bonus (+10)
  - Sibling momentum bonus (+5)

## [0.27.0] - 2025-12-23

### Added
- **Hierarchy Automation System (T339 Phase 2 - Agent 2 Workstream)**
  - **Parent Auto-Complete (T340)**: Automatic parent task completion when all children are done
    - **Recursive Cascade**: Completing subtask → auto-completes task → auto-completes epic
    - **Configuration Control**: `hierarchy.autoCompleteParent` and `hierarchy.autoCompleteMode` settings
    - **Three Modes**: `auto` (silent), `suggest` (prompt user), `off` (disabled)
    - **Clean Output**: No debug contamination, proper JSON with `autoCompletedParents` array
    - **System Notes**: "[AUTO-COMPLETED] All child tasks completed" with timestamps
    - **Comprehensive Tests**: 6 unit tests covering all modes and edge cases
  
  - **Orphan Detection & Repair (T341)**: Detect and fix tasks with invalid parent references
    - **Detection**: `detect_orphans()` function finds tasks with non-existent parents
    - **Repair Modes**: `--fix-orphans unlink` (set parentId=null) or `--fix-orphans delete` (remove task)
    - **Integration**: Added `--check-orphans` and `--fix-orphans` flags to `validate.sh`
    - **Clean Output**: Detailed error messages showing orphaned tasks with parent IDs
    - **Comprehensive Tests**: 4 unit tests covering detection and repair scenarios
  
  - **Tree View Enhancement (T342)**: Enhanced hierarchical task display
    - **Integration**: Tree functionality integrated into `claude-todo list --tree`
    - **Visual Hierarchy**: Proper indentation showing parent-child relationships
    - **Status Indicators**: ✓/✗/○ symbols for task status in tree view
    - **Filters Support**: Works with all existing list filters (--status, --type, --parent, etc.)
    - **JSON Output**: Clean tree structure in JSON format for automation

### Fixed
- **Debug Code Cleanup**: Removed all debug statements from `complete-task.sh`
  - Removed hardcoded `AUTO_COMPLETE_PARENT="true"` 
  - Removed debug echo statements and JSON debug fields
  - Clean JSON output with no contamination

- **Checksum Integrity**: Fixed checksum reuse bug in parent auto-complete
  - Generates fresh checksums for parent task updates
  - Ensures data integrity during auto-completion operations

### Technical
- **SOLID/DRY Architecture**: Major refactor of `complete-task.sh` with function extraction
  - Extracted: `all_siblings_completed()`, `generate_completion_note()`, `prompt_parent_completion()`
  - Extracted: `complete_parent_task()`, `log_parent_completion()`, `cascade_parent_auto_complete()`
  - Used early returns and guard clauses instead of deep nested if statements
  - Maintained 100% backward compatibility while improving maintainability

- **Comprehensive Test Coverage**: 
  - **Unit Tests**: 82/82 hierarchy tests passing
  - **Integration Tests**: All automation features validated
  - **No Regressions**: All existing functionality preserved

- **Documentation Updates**:
  - Updated `templates/CLAUDE-INJECTION.md` with hierarchy automation features
  - Enhanced `docs/commands/hierarchy.md` with complete automation documentation
  - Added comprehensive examples and usage patterns

## [0.26.1] - 2025-12-23

### Fixed
- **Version Management Compliance** - Fixed version management violations across all scripts
  - **Centralized Version System**: All scripts now properly source `lib/version.sh` instead of manually reading VERSION file
  - **Scripts Fixed**: archive.sh, commands.sh, config.sh, find.sh, focus.sh, log.sh, phase.sh, session.sh, update-task.sh
  - **Version Consistency**: All scripts now use `${CLAUDE_TODO_VERSION:-$(get_version)}` for version references
  - **Removed Hardcoded Fallbacks**: Eliminated manual VERSION="X.Y.Z" fallbacks in favor of centralized version resolution
  - **Compliance**: All scripts now follow VERSION-MANAGEMENT.md specifications

## [0.26.0] - 2025-12-22

### Added
- **Hierarchy Automation Commands (T339 Phase 2)**
  - **`reparent` command**: Move tasks between parents with comprehensive validation
    - Syntax: `claude-todo reparent TXXX --to TYYY` or `claude-todo reparent TXXX --to ""`
    - Validations: Task existence, parent existence, parent type (not subtask), depth limits (3 levels), sibling limits, circular reference prevention
    - JSON output with before/after state tracking
    - Exit codes: 11 (task not found), 12 (parent not found), 13 (invalid parent type), 14 (circular reference)
  - **`promote` command**: Remove parent relationship to make task root-level
    - Syntax: `claude-todo promote TXXX [--no-type-update]`
    - Auto-updates subtask→task type by default
    - `--no-type-update` flag preserves original type
    - Equivalent to `reparent TXXX --to ""`
    - JSON output with type change tracking

- **Hierarchy Awareness Enhancements**
  - **`focus` command**: Enhanced show output with hierarchy context
    - Parent context: `Parent: T001 (Epic Title)`
    - Children summary: `Children: 2 done, 3 pending`
    - Breadcrumb path: `Path: T001 > T002 > T003`
    - JSON output includes hierarchy object with parent/children/breadcrumb
  - **`next` command**: Intelligent scoring with hierarchy factors
    - Same-epic bonus: +30 score for tasks in focused epic
    - Leaf task bonus: +10 for tasks with no children
    - Sibling momentum: +5 when >50% siblings are completed
    - Parent context displayed in suggestions
    - JSON output includes complete scoring breakdown

### Changed
- **Enhanced error handling** with hierarchy-specific exit codes in reparent.sh and promote.sh
- **Improved task suggestions** in next.sh with hierarchy-aware scoring algorithm
- **Rich context display** in focus.sh with parent/children/breadcrumb information

## [0.24.0] - 2025-12-20

### Added
- **Config System Integration (Epic T382)** - Complete config system now operational across all scripts
  - Priority resolution: CLI flags > Environment vars > Project config > Global config > Defaults
  - `lib/config.sh` integrated into 15+ scripts with fallback guards for safety

- **Session Config Settings** (`session.*`)
  - `warnOnNoFocus`: Warn if no task is focused at session start (default: true)
  - `requireSessionNote`: Require note when ending session (default: false)
  - `sessionTimeoutHours`: Hours before stale session warning (default: 8)
  - `autoStartSession`: Auto-start session on first command (default: true)

- **Default Values Config** (`defaults.*`)
  - `priority`: Default priority for new tasks (default: medium)
  - `status`: Default status for new tasks (default: pending)
  - Read by `add-task.sh` when flags not specified

- **Validation Config Settings** (`validation.*`)
  - `strictMode`: Treat warnings as errors (default: false)
  - `checksumEnabled`: Enable checksum verification (default: true)
  - `maxActiveTasks`: Maximum concurrent active tasks (default: 3)
  - `requireDescription`: Require description for all tasks (default: true)
  - `detectCircularDeps`: Detect circular dependencies (default: true)

- **Display Config Settings** (`display.*`)
  - `showArchiveCount`: Show archived count in list/dash footer (default: true)
  - `showLogSummary`: Show recent completions in dashboard (default: true)
  - `warnStaleDays`: Warn about tasks older than N days, 0 to disable (default: 7)
  - New "Stale Tasks" section in dashboard showing aging tasks

- **Hierarchy Automation Features (T339 Phase 2)**
  - **Parent Auto-Complete**: Automatically complete parent tasks when all children are done
    - Config: `hierarchy.autoCompleteParent` (default: false)
    - Modes: `hierarchy.autoCompleteMode` - auto|suggest|off (default: off)
    - Recursive cascade: Completing subtask → task → epic
    - System note added: "[AUTO-COMPLETED] All child tasks completed"
    - JSON output includes `autoCompletedParents` array
  - **Orphan Detection & Repair**: Detect tasks with invalid parent references
    - `validate --check-orphans`: Report orphaned tasks
    - `validate --fix-orphans unlink`: Set parentId to null
    - `validate --fix-orphans delete`: Delete orphaned tasks
  - **Tree Command Enhancement**: `list --tree` now fully functional
    - ASCII tree visualization with status icons
    - JSON hierarchical structure with nested children
    - Subtree filtering with `--children T###`
    - Status and priority filters work with tree view

- **CLI Config Settings** (`cli.*`)
  - `enableDebug`: Enable debug mode via config (default: false)
  - Aliases support loaded from config
  - Plugin configuration warnings

- **Backup Config Settings** (`backup.*`)
  - `enabled`: Global toggle for backup system (default: true)
  - `directory`: Backup storage location (default: .claude/backups)
  - `maxSnapshots`: Maximum snapshot backups to retain (default: 10)

- **Environment Variable Integration** - All config sections now support env var overrides
  - `CLAUDE_TODO_SESSION_*` for session settings
  - `CLAUDE_TODO_VALIDATION_*` for validation settings
  - `CLAUDE_TODO_DISPLAY_*` for display settings
  - `CLAUDE_TODO_BACKUP_*` for backup settings
  - Full mapping in `lib/config.sh`

### Changed
- **lib/config.sh** - Enhanced with include guard, fixed boolean false handling in jq
- **lib/validation.sh** - Added config-driven validation helper functions
- **lib/file-ops.sh** - Integrated backup config settings
- **scripts/session.sh** - Full session config integration
- **scripts/add-task.sh** - Uses defaults.* config for new task creation
- **scripts/validate.sh** - Respects validation.* config settings
- **scripts/backup.sh** - Config-driven backup behavior
- **scripts/restore.sh** - Config-aware restore operations
- **scripts/list-tasks.sh** - Archive count display respects config
- **scripts/dash.sh** - Archive, log summary, and stale tasks respect config
- **install.sh** - Config-driven debug mode and alias loading

### Fixed
- **SC2168 errors** - Removed `local` keyword outside functions in:
  - `scripts/add-task.sh:740`
  - `scripts/update-task.sh:750`
  - `scripts/validate.sh:349`
- **Boolean false config values** - jq now correctly handles false vs null

## [0.23.2] - 2025-12-20

### Added
- **`populate-hierarchy` command** - Populates `parentId` field based on conventions
  - Naming convention: Titles starting with `T###.` set parentId to that epic (e.g., "T328.1" → parentId: T328)
  - Depends on epic: If single dependency is an epic, sets it as parent
  - Supports `--dry-run` to preview changes before applying
  - LLM-Agent-First JSON output with summary and change details

### Fixed
- **`list --tree` now works** - Was documented but not implemented
  - JSON output: Adds `tree` field with hierarchical structure (children nested)
  - Human output (`--human`): Renders ASCII tree with status icons
  - Works with filters: `--type epic`, `--parent T001`, `--children T001`

### Changed
- **`deps tree` JSON output enhanced** - Now LLM-Agent-First compliant
  - Added `summary` with totalNodes, rootCount, leafCount
  - Added `rootNodes` and `leafNodes` arrays
  - Added `nodes` array with task metadata (id, title, status, type)
  - Maintains backward compatibility with existing `dependency_graph` and `dependent_graph`

## [0.23.1] - 2025-12-20

### Fixed
- **`show --include-archive`** - Now correctly searches `.archivedTasks[]` field in archive file
  - Previously only searched `.tasks[]`, causing "not found" errors for archived tasks

- **`find` command regex escaping** - Queries with special characters (spaces, brackets, etc.) no longer crash
  - Fixed malformed regex escape pattern causing jq parse errors
  - Added try/catch fallback for edge cases

### Changed
- **Archive documentation** - Comprehensive update to `docs/commands/archive.md`
  - Added missing flags: `--format`, `--json`, `--human`, `--quiet`
  - Added missing config options: `enabled`, `archiveOnSessionEnd`
  - Added JSON output structure and exit codes documentation

### Added
- **`docs/guides/archive-guide.md`** - New conceptual guide for archive system
  - Retention model explanation with diagrams
  - Integration points (session end, task completion)
  - Configuration recommendations by use case
  - Troubleshooting section

## [0.23.0] - 2025-12-20

### Added
- **`research` command** - Multi-source web research aggregation with MCP servers
  - Query mode: `claude-todo research "query"` - comprehensive topic research
  - Library mode: `claude-todo research --library NAME --topic X` - Context7 docs
  - Reddit mode: `claude-todo research --reddit "topic" --subreddit S` - community discussions
  - URL mode: `claude-todo research --url URL [URL...]` - extract specific URLs
  - Depth levels: `quick` (3-5), `standard` (8-12), `deep` (15-25 sources)
  - Task linking: `--link-task ID` for research-to-task association
  - Output: Creates `.claude/research/` with JSON + Markdown reports
  - Implements [Web Aggregation Pipeline Specification](docs/specs/WEB-AGGREGATION-PIPELINE-SPEC.md)

- **Research skill files** in `~/.claude/skills/research-aggregator/`
  - Complete MCP integration patterns for Tavily, Context7, Sequential-thinking
  - Reddit JSON API reference (no authentication required)
  - Fallback chains for graceful degradation
  - Mode-specific guides (query, url, reddit, library)

### Changed
- **install.sh** - Registered `research` command with `dig` alias
- **docs/INDEX.md** - Added research.md to command reference
- **docs/TODO_Task_Management.md** - Added Research & Discovery section

### Related Specifications
- [WEB-AGGREGATION-PIPELINE-SPEC.md](docs/specs/WEB-AGGREGATION-PIPELINE-SPEC.md) - Pipeline architecture
- [WEB-AGGREGATION-PIPELINE-IMPLEMENTATION-REPORT.md](docs/specs/WEB-AGGREGATION-PIPELINE-IMPLEMENTATION-REPORT.md) - Implementation tracking

## [0.22.0] - 2025-12-20

### Added
- **Configurable Hierarchy Sibling Limits (LLM-Agent-First)** - T527
  - New `hierarchy` config section in `todo-config.json`
  - `maxSiblings`: Default 20 (was hardcoded 7), 0 = unlimited
  - `maxDepth`: Default 3 (configurable but rarely changed)
  - `countDoneInLimit`: Default false (done tasks excluded from sibling count)
  - `maxActiveSiblings`: Default 8 (aligns with TodoWrite sync limit)
  - Config schema updated to v2.2.0 with migration

- **Metadata Updates on Completed Tasks** - T526
  - Done tasks now allow metadata-only updates: `--type`, `--parent`, `--size`, `--labels`
  - Work fields remain blocked: `--title`, `--description`, `--status`, `--priority`, `--notes`
  - Enables hierarchy restructuring without losing completion history

### Changed
- **HIERARCHY-ENHANCEMENT-SPEC.md** v1.3.0 - Updated Part 3.2 with LLM-Agent-First rationale
  - Original 7-sibling limit was based on Miller's 7±2 law (human cognitive limits)
  - LLM agents have 200K+ token context windows, not 4-5 item working memory
  - New design: organizational limits, not cognitive constraints

- **CONFIG-SYSTEM-SPEC.md** v1.1.0 - Added Appendix A.5 Hierarchy Section
  - Full documentation of hierarchy config options
  - LLM-Agent-First design rationale

- **lib/hierarchy.sh** - Config-aware sibling validation
  - `get_hierarchy_config()`, `get_max_siblings()`, `should_count_done_in_limit()`
  - `count_siblings()` now excludes done tasks by default
  - `count_active_siblings()` for context management
  - `validate_max_siblings()` uses configurable limits

- **Error messages** - Dynamic sibling limit display
  - `scripts/add-task.sh`, `scripts/update-task.sh` now show actual configured limit

### Fixed
- **T382 children** - Can now add more children to config epic (sibling limit raised)

### Migrations
- **Config schema 2.1.0 → 2.2.0**: Adds `hierarchy` section with defaults
  - Run `claude-todo migrate run` to update existing projects

## [0.21.2] - 2025-12-20

### Fixed
- **archive.sh ARG_MAX limit error** - Fixed "Argument list too long" error when archiving projects with many tasks
  - Changed `jq --argjson` to `jq --slurpfile` with process substitution at lines 387 and 456
  - Prevents shell ARG_MAX limit (~128KB-2MB) from blocking archive operations on large todo.json files
  - All `$tasks` references updated to `$tasks[0]` for slurpfile array wrapper handling

## [0.21.1] - 2025-12-20

### Fixed
- **File Locking Concurrency Fixes** - Completed T451 epic with 6 child tasks
  - `scripts/archive.sh` (T452): Now sources `lib/file-ops.sh`, all writes use `save_json()` with locking
  - `scripts/add-task.sh` (T453): `log_operation()` now uses `lock_file()`/`unlock_file()` + atomic write pattern
  - `scripts/complete-task.sh` (T454): Focus clearing now uses `save_json()` instead of inline jq
  - `lib/phase-tracking.sh` (T350): 4 functions converted from raw temp+mv to `save_json()`
  - `lib/migrate.sh` (T530): 8 migration functions converted to `save_json()` for atomic writes
  - `lib/logging.sh` + `scripts/log.sh` (T531): 4 logging functions converted to `save_json()`

- **Race Condition Prevention** - All JSON write operations now protected by flock(2)
  - Eliminates race conditions in concurrent task operations
  - 18+ write operations now use atomic file locking via `save_json()`

### Changed
- **FILE-LOCKING-IMPLEMENTATION-REPORT.md** - Updated to reflect 100% completion status

## [0.21.0] - 2025-12-19

### Added
- **`commands` command** - LLM-Agent-First command discovery and query tool
  - JSON output by default (non-TTY), `--human` for text
  - Native filters: `--category` (write|read|sync|maintenance), `--relevance` (critical|high|medium|low)
  - Single command lookup: `ct commands add` returns full command metadata
  - `--workflows` flag: Returns pre-defined agent workflow sequences
  - `--lookup` flag: Intent-to-command quick lookup mapping
  - No jq required for command discovery - use native flags instead

- **`COMMANDS-INDEX.json`** - Machine-readable command registry
  - 33 commands with full metadata (script, flags, exit codes, relevance)
  - Agent workflows (sessionStart, taskSelection, validation, sessionEnd)
  - Quick lookup table (intent → command mapping)
  - Schema-validated via `schemas/commands-index.schema.json`

### Changed
- **LLM-AGENT-FIRST-SPEC.md** updated to v3.1 (33 commands)
- **docs/INDEX.md** - Added COMMANDS-INDEX.json reference

### Removed
- **`.serena/memories/suggested_commands.md`** - Obsolete, promoted anti-patterns (direct JSON file access)

## [0.20.1] - 2025-12-19

### Changed
- **LLM-Agent-First Documentation Overhaul**
  - Updated `docs/TODO_Task_Management.md` - Replaced "JSON Output Parsing" with "LLM-Agent-First Output" section
  - Updated `templates/CLAUDE-INJECTION.md` - Added `find` command, new "LLM-Agent-First Design" section
  - Updated `docs/commands/list.md` - Added auto-detection note, "prefer native filters" guidance
  - Updated `docs/commands/find.md` - Clarified auto-detection in JSON output sections

- **validate.sh JSON output enhanced**
  - Now includes full `details` array with all validation check results
  - Each check includes: check name, status (ok/error/warning), message
  - `_meta.version` now shows app version (0.20.1), not schema version
  - Added `schemaVersion` field to JSON output for schema version (2.2.0)

### Fixed
- **Agent jq quoting issues** - Documentation now explicitly warns to use single quotes for jq expressions
- **Unnecessary --format json flags** - Docs now teach that JSON is auto-detected when piped (non-TTY)
- **Context bloat patterns** - Docs now recommend `find` over `list` for task discovery (99% context reduction)
- **validate.sh version confusion** - `_meta.version` was incorrectly showing schema version instead of app version

## [0.20.0] - 2025-12-19

### Added
- **Task Hierarchy System** - Epic → Task → Subtask organization (Schema v2.3.0)
  - Three-level hierarchy with enforced constraints (max depth: 3, max siblings: 7)
  - New task fields: `type` (epic|task|subtask), `parentId`, `size` (small|medium|large)
  - Type inference: automatically determines task type based on parent
  - Hierarchy validation in `lib/hierarchy.sh` (14KB, 500+ lines)

- **add-task.sh hierarchy flags**
  - `--type epic|task|subtask` - Explicit task type classification
  - `--parent T###` - Set parent task for hierarchy relationship
  - `--size small|medium|large` - Scope-based sizing (NOT time estimates)
  - Validation: Epic cannot have parent, subtask requires parent

- **list-tasks.sh hierarchy filters**
  - `--tree` - Hierarchical tree view with ASCII art indentation
  - `--type epic|task|subtask` - Filter by task type
  - `--children T###` - Show direct children of a task
  - `--parent T###` - Alias for --children filter

- **show.sh hierarchy context** - Displays parent info, children count, and depth

- **Migration v2.2.0 → v2.3.0** - Automatic migration with dual separator support
  - Label-based type inference (`epic-*` → epic, `subtask-*` → subtask)
  - Adds type, parentId, size fields with sensible defaults

- **Hierarchy exit codes** (10-15) for structured error handling
  - `EXIT_PARENT_NOT_FOUND` (10), `EXIT_DEPTH_EXCEEDED` (11)
  - `EXIT_SIBLING_LIMIT` (12), `EXIT_INVALID_PARENT_TYPE` (13)
  - `EXIT_CIRCULAR_REFERENCE` (14), `EXIT_ORPHAN_DETECTED` (15)

- **Test coverage** - 96 new hierarchy tests
  - `tests/unit/hierarchy.bats` - 67 unit tests
  - `tests/integration/hierarchy-workflow.bats` - 29 integration tests

- **Documentation** - `docs/commands/hierarchy.md` (383 lines)
  - Complete usage guide with examples
  - Migration instructions and troubleshooting

### Changed
- **Test fixtures updated** - All fixtures now use schema v2.3.0 with hierarchy fields
- **docs/reference/migration-guide.md** - Updated current schema to v2.3.0

### Fixed
- **lib/hierarchy.sh** - Added readonly guards to prevent variable collision on re-source
- **add-task.sh** - Added validation for epic/subtask type constraints

## [0.19.3] - 2025-12-19

### Added
- **TODOWRITE-SYNC-SPEC.md** - Formal specification for TodoWrite bidirectional sync
  - RFC 2119 compliant requirements document
  - 8 parts covering schema mapping, session workflow, injection, extraction
  - Follows SPEC-BIBLE-GUIDELINES.md standards
- **TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md** - Tracks implementation progress
  - v1 core features: 85% complete
  - v2 enhancements documented for future work
- **docs/INDEX.md** - Added TodoWrite sync spec to Specifications section

### Fixed
- **TodoWrite sync logging** - Fixed log_info/log_warn to output to stderr instead of stdout
  - Prevents log messages from mixing with function return values
  - Fixes jq parse errors in extract-todowrite.sh
  - Applied to inject-todowrite.sh, extract-todowrite.sh, sync-todowrite.sh
- **activeForm prefix patterns** - Fixed verb conjugation for prefix patterns
  - Titles starting with `BUG:`, `FEAT:`, `T123:`, `OPTIONAL:` now use "Working on:" fallback
  - Prevents incorrect output like "Bug:ing" or "T328.10:ing"
  - Added non-verb detection for common task title nouns
- **todowrite-sync.bats tests** - Updated tests for new JSON envelope format
  - Changed `.todos[]` to `.injected.todos[]` for inject output parsing
  - All 23 TodoWrite sync tests now passing

### Changed
- **T239 Epic closed** - TodoWrite Bidirectional Sync Integration complete (v1)
- **T291 closed** - phase-sync.bats fixtures verified (3-phase structure kept for test simplicity)
- **T315 closed** - activeForm verb conjugation bug fixed

## [0.19.2] - 2025-12-18

### Added
- **find command** - Search tasks by ID, title, description, or fuzzy matching
  - `claude-todo find <query>` - Fuzzy search across task titles and descriptions
  - `--id` flag - Search by task ID prefix (e.g., `--id 37` finds T370, T371...)
  - `--exact` flag - Exact match mode for precision searching
  - `--field` flag - Search specific fields (title, description, labels, all)
  - `--status` flag - Filter results by task status
  - `--format json` - LLM-Agent-First compliant JSON output
  - `--verbose` / `--quiet` modes for output control
  - Exit codes: 0 (matches), 2 (invalid input), 100 (no matches)
  - 99.7% context reduction vs full task list (355KB → 1KB typical)
- **search alias** - Alias for find command (`claude-todo search`)
- **BATS test suite** - 75 comprehensive tests for find command
- **Documentation** - `docs/commands/find.md` with full usage guide

## [0.19.1] - 2025-12-18

### Fixed
- **Post-release validation fixes** - Additional envelope compliance gaps found via parallel subagent testing:
  - `focus.sh` cmd_show: Added missing `format` field to `_meta`
  - `next.sh`: Added missing `success` boolean field
  - `dash.sh`: Added missing `success` boolean field after `_meta` block
  - `backup.sh`: Added missing `version` field to backup create `_meta`
  - `phase.sh`: Added VERSION loading and `version`/`format` to cmd_show `_meta`

### Changed
- **Compliance status**: 100% LLM-Agent-First envelope compliance (from 99.2%)
- **Implementation report**: Updated to v3.3 with post-release validation session

## [0.19.0] - 2025-12-18

### Added
- **LLM-Agent-First Full Compliance** - All 31 commands now fully compliant
  - **JSON envelope standardization**: All commands now include `$schema`, `_meta`, `success` fields
  - **focus.sh**: All subcommands (set, clear, note, next) now output proper JSON
    - `focus set` returns task details and previous focus
    - `focus clear` returns clear confirmation and previous focus
    - `focus note` returns confirmation with session note
    - `focus next` returns confirmation with next action
  - **config get**: Now returns full JSON envelope instead of minimal object
  - Global format parsing before subcommand dispatch in focus.sh

### Fixed
- **Missing `success` field** in JSON outputs:
  - `stats.sh`: Added `success: true` to JSON output
  - `validate.sh`: Added `success: true` to JSON output
  - `deps-command.sh`: Added `success: true` to all 3 modes (overview, task, tree)
  - `export.sh`: Added `success: true` to JSON output
  - `sync-todowrite.sh`: Added `success: true` to both status outputs
  - `next.sh`: Added `success: true` to JSON output
  - `dash.sh`: Added `success: true` after `_meta` block

- **Log output mixing with JSON**:
  - `focus.sh`: Phase change logs now suppressed in JSON mode
  - `export.sh`: Summary log now suppressed in JSON mode

- **Format flag parsing**:
  - `focus.sh`: Global format parsing before subcommand dispatch
  - Consistent `--format`, `--json`, `--human` flag support across all focus subcommands

- **Incomplete `_meta` envelope fields**:
  - `focus.sh` cmd_show: Added missing `format` field to `_meta`
  - `backup.sh`: Added missing `version` field to backup create `_meta`
  - `phase.sh`: Added VERSION loading and `version`/`format` to cmd_show `_meta`

### Changed
- **Compliance status**: 100% LLM-Agent-First envelope compliance (from ~83%)
  - All 31 commands have `$schema`, `_meta`, `success` in JSON output
  - All commands use `resolve_format()` for TTY-aware detection
  - All commands use `output_error()` for structured errors

## [0.18.1] - 2025-12-17

### Fixed
- **Schema validation**: Added `$schema` property to `config.schema.json`
  - Config files with `$schema` reference now pass validation
  - Fixes `ct config validate` failing with "Additional properties not allowed"

## [0.18.0] - 2025-12-17

### Added
- **Configuration Management System**
  - **`config` command** - Unified interface for viewing and modifying settings
    - `config show [PATH]` - Display configuration (all, section, or specific value)
    - `config set PATH VALUE` - Update configuration with validation
    - `config get PATH` - Get single value (scripting-friendly)
    - `config list` - List all keys with current values
    - `config reset [SECTION]` - Reset to defaults
    - `config edit` - Interactive numbered menu editor
    - `config validate` - Validate config against schema
  - **Global configuration support** (`~/.claude-todo/config.json`)
    - User preferences shared across all projects
    - CLI aliases, output settings, debug options
    - New schema: `schemas/global-config.schema.json`
  - **Configuration priority hierarchy**:
    1. CLI flags (highest priority)
    2. Environment variables (`CLAUDE_TODO_*`)
    3. Project config (`.claude/todo-config.json`)
    4. Global config (`~/.claude-todo/config.json`)
    5. Built-in defaults (lowest priority)
  - **Environment variable mapping** - Documented `CLAUDE_TODO_*` variables
    - `CLAUDE_TODO_FORMAT` → `output.defaultFormat`
    - `CLAUDE_TODO_OUTPUT_SHOW_COLOR` → `output.showColor`
    - See `docs/commands/config.md` for full list
  - **lib/config.sh** - Core configuration resolution library
    - `get_config_value()` - Priority-aware value retrieval
    - `set_config_value()` - Validated config updates
    - `get_effective_config()` - Merged config with all layers
  - **Interactive config editor** - Simple numbered menus for humans
    - Category selection (Output, Archive, Validation, etc.)
    - Type-aware input (boolean, enum, number)
    - Dry-run preview before save

- **Improved "Did you mean" suggestions**
  - Multi-strategy matching for unknown commands:
    - Substring match (original)
    - Prefix match (e.g., "fo" → "focus")
    - First letter match
    - Common commands fallback

### Changed
- **install.sh** - Added config command registration and global config initialization
- **Documentation updates**:
  - `docs/commands/config.md` - Comprehensive command documentation
  - `docs/reference/configuration.md` - Added Config Command section
  - `docs/QUICK-REFERENCE.md` - Added CONFIGURATION section
  - `docs/INDEX.md` - Added config command to Command Reference
  - `templates/CLAUDE-INJECTION.md` - Added config commands to essentials

## [0.17.0] - 2025-12-17

### Added
- **Task Hierarchy System (Phase 1)** - Epic → Task → Subtask relationships
  - **Schema v2.3.0**: New task fields `type`, `parentId`, `size`
    - `type`: Task classification (`epic`, `task`, `subtask`)
    - `parentId`: Parent task reference (e.g., `T001`)
    - `size`: Scope-based sizing (`small`, `medium`, `large`)
  - **lib/hierarchy.sh**: Core hierarchy validation library
    - `validate_parent_exists()`, `validate_max_depth()`, `validate_max_siblings()`
    - `validate_parent_type()`, `validate_no_circular_reference()`
    - `get_task_depth()`, `get_children()`, `get_descendants()`, `infer_task_type()`
  - **Hierarchy constraints**:
    - Maximum depth: 3 levels (epic → task → subtask)
    - Maximum siblings: 7 children per parent
    - Subtasks cannot have children
  - **CLI flags for `add` command**:
    - `--type TYPE` / `-t`: Task type (epic, task, subtask)
    - `--parent ID`: Parent task ID for hierarchy
    - `--size SIZE`: Scope-based size (small, medium, large)
  - **CLI flags for `list` command**:
    - `--type TYPE` / `-t`: Filter by task type
    - `--parent ID`: Filter by parent ID
    - `--children ID`: Show direct children of task
    - `--tree`: Hierarchical tree view
  - **Exit codes 10-15** for hierarchy errors:
    - 10: `EXIT_PARENT_NOT_FOUND` - Parent task ID doesn't exist
    - 11: `EXIT_DEPTH_EXCEEDED` - Exceeds max depth of 3 levels
    - 12: `EXIT_SIBLING_LIMIT` - Parent has max 7 children
    - 13: `EXIT_INVALID_PARENT_TYPE` - Subtask cannot be parent
    - 14: `EXIT_CIRCULAR_REFERENCE` - Task cannot be its own ancestor
    - 15: `EXIT_ORPHAN_DETECTED` - Parent no longer exists
  - **Error codes in lib/error-json.sh**: E_PARENT_NOT_FOUND, E_DEPTH_EXCEEDED,
    E_SIBLING_LIMIT, E_INVALID_PARENT_TYPE, E_CIRCULAR_REFERENCE, E_ORPHAN_DETECTED
  - **docs/migration/v2.3.0-migration-guide.md**: Comprehensive migration guide

- **LLM-Agent-First Improvements**
  - **TTY auto-detection**: Format automatically resolved based on output context
    - TTY output → text format (human-readable)
    - Pipe/redirect → JSON format (machine-readable)
    - Respects `CLAUDE_TODO_FORMAT` environment variable override
  - **Exit codes 20-22** for concurrency errors:
    - 20: `EXIT_CHECKSUM_MISMATCH`
    - 21: `EXIT_CONCURRENT_MODIFICATION`
    - 22: `EXIT_ID_COLLISION`

### Changed
- **Schema Version**: Bumped to 2.3.0
- **Migration**: `migrate_todo_to_2_3_0()` added to lib/migrate.sh
  - Converts `epic-*` labels to `type: "epic"`
  - Converts `subtask-*` labels to `type: "subtask"`
  - Adds `type`, `parentId`, `size` fields to all tasks
- **Documentation updates**:
  - `docs/commands/add.md`: Hierarchy options section
  - `docs/commands/list.md`: Hierarchy filters section
  - `docs/INDEX.md`: Updated hierarchy spec version, added v2.3.0 migration guide

## [0.16.0] - 2025-12-17

### Added
- **Unified version management automation**
  - `scripts/validate-version.sh`: Version drift detection with auto-fix
    - Validates VERSION file against README.md, CLAUDE-INJECTION.md, CLAUDE.md
    - `--fix` flag for automatic drift repair
    - POSIX-compliant (works on Linux and macOS)
    - Creates backups before modifications
    - Exit codes: 0=synced, 1=drift detected
  - `docs/reference/VERSION-MANAGEMENT.md`: Comprehensive versioning documentation
    - Dual-track versioning (app vs schema)
    - Release checklist and workflow
    - Troubleshooting guide

### Changed
- **Enhanced `scripts/bump-version.sh`**
  - Pre-bump validation: Checks VERSION file and current sync state
  - Post-bump validation: Verifies all files updated correctly
  - `--dry-run` flag: Preview changes without modifying files
  - `--verbose` flag: Detailed operation logging
  - `--no-validate` flag: Skip validation for automation
  - Automatic backup creation with cleanup on success
  - Rollback instructions on failure
- **Dynamic VERSION sourcing in 7 scripts** (no more hardcoded versions)
  - `scripts/labels.sh`: 0.8.0 → dynamic
  - `scripts/next.sh`: 0.8.0 → dynamic
  - `scripts/dash.sh`: 0.8.2 → dynamic
  - `scripts/history.sh`: 0.10.2 → dynamic
  - `scripts/analyze.sh`: 0.15.0 → dynamic
  - `scripts/deps-command.sh`: 0.8.2 → dynamic
  - `lib/cache.sh`: 1.0.0 → dynamic
- **Documentation updates**
  - `docs/INDEX.md`: Added VERSION-MANAGEMENT.md reference
  - `docs/DOCUMENTATION-MAINTENANCE.md`: Added version policy section
  - `docs/reference/migration-guide.md`: Fixed schema version 2.1.0 → 2.2.0

### Removed
- **`scripts/sync-version.sh`**: Functionality merged into `bump-version.sh`

## [0.15.0] - 2025-12-16

### Added
- **`analyze` command for intelligent task triage** (T327)
  - New command: `claude-todo analyze [--full|--json|--auto-focus]`
  - **Leverage scoring**: Calculates downstream impact of each task
    - Score = base priority + (cascade count × 10)
    - Identifies high-leverage tasks that unblock the most work
  - **Bottleneck detection**: Finds tasks blocking 2+ other tasks
    - Shows blocked task chains
    - Highlights critical bottlenecks
  - **Tier assignment**: Auto-groups tasks into action tiers
    - Tier 1: Critical bottlenecks and high-leverage tasks
    - Tier 2: High priority with dependencies
    - Tier 3: Medium priority and progress tasks
    - Tier 4: Low priority backlog
  - **Output formats**:
    - Brief mode (default): Token-efficient summary for LLM agents
    - Full mode (`--full`): Comprehensive report with all tiers
    - JSON mode (`--json`): Machine-readable for scripting
  - **Auto-focus** (`--auto-focus`): Automatically sets focus to top recommendation
  - `lib/analysis.sh`: Core algorithms for leverage, bottleneck, and tier calculations
  - `scripts/analyze.sh`: CLI command implementation
  - `docs/commands/analyze.md`: Comprehensive documentation

### Changed
- **Documentation updated for analyze command**
  - `CLAUDE.md`: Added analyze to Analysis Commands section
  - `docs/QUICK-REFERENCE.md`: Added analyze command examples
  - `templates/CLAUDE-INJECTION.md`: Added analyze to essential commands

## [0.14.0] - 2025-12-16

### Added
- **`migrate repair` command for schema compliance** (T302)
  - New command: `claude-todo migrate repair [--dry-run|--auto]`
  - Fixes existing projects with wrong phase structure
  - Ensures canonical 5-phase structure (setup→core→testing→polish→maintenance)
  - Preserves existing phase status/timestamps during repair
  - Idempotent: safe to run multiple times
  - Creates backup before any modifications
  - `lib/migrate.sh`: Added `get_canonical_phases()`, `compare_phases_structure()`,
    `get_repair_actions()`, `execute_repair()`, `repair_todo_schema()`
  - `scripts/migrate.sh`: Added `cmd_repair()` handler with `--dry-run` and `--auto` flags

- **Phase validation in `validate.sh`**
  - Multiple active phases detection with auto-fix
  - Invalid phase status validation (must be pending/active/completed)
  - currentPhase existence validation
  - Future timestamp detection in phases

### Changed
- **Test fixtures updated for 5-phase canonical structure**
  - `tests/golden/fixtures/todo.json`: Updated to v2.2.0 format with 5 phases
  - `tests/migration/test-2.2.0-migration.bats`: Updated assertions for 5 phases
  - `tests/edge-cases/phase-edge-cases.bats`: Updated fixtures and assertions
  - Regenerated all golden test output files

### Fixed
- **All phase-edge-cases tests now passing** (was 8 failing, now 0)
  - Fixed test assertions to match actual error messages
  - Fixed advance-with-gaps test to use `--skip-notes` flag
  - Added validation for invalid phase status values
  - Added validation for nonexistent currentPhase references
  - Added future timestamp detection

## [0.13.3] - 2025-12-16

### Changed
- **Migration now reads phases from template (dynamic, not hardcoded)**
  - `lib/migrate.sh`: Added `get_default_phases()` helper that reads from `templates/todo.template.json`
  - Migration no longer hardcodes phase structure - derives from template (single source of truth)
  - If template changes in future, migration will automatically use updated structure
  - Includes fallback for edge case where template is missing

## [0.13.2] - 2025-12-16

### Fixed
- **Migration creates wrong phase structure**
  - `lib/migrate.sh`: Was creating 4 phases (setup, core, polish, release)
  - Fix: Now creates canonical 5-phase structure matching template:
    1. setup - Setup & Foundation
    2. core - Core Development
    3. testing - Testing & Validation
    4. polish - Polish & Refinement
    5. maintenance - Maintenance & Support

## [0.13.1] - 2025-12-16

### Fixed
- **Critical: Migration v2.1.0 → v2.2.0 not running** (IFS bug)
  - `lib/migrate.sh`: `check_compatibility()` failed due to `IFS=':'` persisting from caller
  - Version parsing in `read` commands didn't split on spaces when IFS was modified
  - Fix: Explicitly set `IFS=' '` in read statements for version parsing
  - Migration now correctly detects v2.1.0 files and upgrades to v2.2.0

- **"Argument list too long" with large task counts**
  - `scripts/list-tasks.sh`: JSON output failed with 200+ tasks due to `--argjson` CLI limit
  - `scripts/history.sh`: Same issue with large datasets
  - Fix: Changed to stdin piping (`echo | jq`) and temp files (`--slurpfile`) instead of CLI args

- **Phase completion validation**
  - `lib/phase-tracking.sh`: `complete_phase()` now validates no incomplete tasks before allowing completion
  - `lib/phase-tracking.sh`: `advance_phase()` now skips completion step if phase already completed

- **Phase priority in next command**
  - `scripts/next.sh`: Increased phase bonus from +10 to +30 for better task prioritization

### Changed
- `docs/commands/next.md`: Updated phase bonus documentation (+10 → +30)
- `docs/commands/phase.md`: Added task validation requirement for phase completion

## [0.13.0] - 2025-12-16

### Added
- **Project-Level Phase Tracking System**
  - `project.phases` object in todo.json schema for defining project phases
  - `project.currentPhase` field to track active project phase
  - Phase lifecycle tracking with status (pending/active/done), startedAt, completedAt
  - Phase validation in add-task.sh and update-task.sh (validates against project.phases)
  - `--add-phase` flag to create phases on-demand
  - `phase` command for phase lifecycle management (show/set/start/complete/advance)
  - `phases` command for phase overview (list/show/stats)
  - Phase support in templates/todo.template.json

- **Library Enhancements**
  - `lib/phase-tracking.sh`: Core phase management functions
  - Phase validation in `lib/validation.sh`
  - Phase indexing in `lib/cache.sh`

- **Migration Support**
  - Schema migration to v2.2.0 in `scripts/migrate.sh`
  - Automatic conversion of legacy phase data structures
  - Backward compatibility with pre-2.2.0 task data

### Changed
- **Schema Version**: Bumped to 2.2.0
- **Template Structure**: todo.template.json now includes project.phases structure
- **Test Suites**: Updated phase-related tests to use project.phases path
  - Fixed add-task.bats phase setup (2 tests)
  - Fixed list-tasks.bats optional fields test
  - Fixed update-task.bats phase test
  - Fixed error-recovery.bats config handling

### Fixed
- Phase validation handles null/undefined project.phases gracefully
- add-task.sh and update-task.sh use `(.project.phases // {})` for safe jq operations

## [0.12.9] - 2025-12-15

### Added
- **Documentation Completeness Audit** (T226)
  - Created 12 missing command docs: `add.md`, `archive.md`, `complete.md`, `focus.md`, `init.md`, `list.md`, `migrate.md`, `migrate-backups.md`, `session.md`, `stats.md`, `update.md`, `validate.md`
  - Updated `docs/INDEX.md` with 25 total command references (was 12)
  - Added `history` and `migrate-backups` commands to `TODO_Task_Management.md`

### Fixed
- **Documentation accuracy**: Verified all 25 command docs against actual CLI behavior
  - `backup.md`: Removed non-existent `-d`, `-c` short flags
  - `log.md`: Added missing `list` and `show` subcommands
  - `init.md`: Corrected arguments (uses `[PROJECT_NAME]`, not `--dir`)
  - `list.md`: Fixed options table to match actual flags
  - `TODO_Task_Management.md`: Fixed `history` syntax (`--days 7` not `--period week`)

## [0.12.8] - 2025-12-15

### Added
- **`show` command**: Single task detail view (T225)
  - Full task details with all fields displayed
  - Dependency information (what this blocks, what blocks this)
  - `--history` flag to show task log entries
  - `--related` flag to show tasks with same labels
  - `--include-archive` to search archived tasks
  - JSON output support for scripting
  - Documentation: `docs/commands/show.md`

### Changed
- Updated CLAUDE-INJECTION.md template with `show` command
- Updated TODO_Task_Management.md with Task Inspection section

## [0.12.7] - 2025-12-15

### Added
- **`history` command**: Completion timeline and analytics (T224)
  - Daily completion counts with bar chart visualization
  - Phase distribution of completed tasks
  - Label breakdown of completions
  - Velocity metrics (average, peak tasks/day)
  - Options: `--days N`, `--since DATE`, `--until DATE`, `--format json`
  - Documentation: `docs/commands/history.md`

## [0.12.6] - 2025-12-15

### Added
- **`bump-version.sh`**: Single command to update version everywhere
  - Updates VERSION file, README badge, and CLAUDE-INJECTION.md template
  - Supports `patch`, `minor`, `major`, or explicit version
  - Usage: `./scripts/bump-version.sh patch`

### Changed
- Version management now uses single source of truth (VERSION file)
- README badge synced automatically via bump-version.sh

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
