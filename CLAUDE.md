<!-- CLEO:START v0.58.5 -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations. Full docs: `~/.cleo/docs/TODO_Task_Management.md`

**Multi-Agent Support (v0.50.0+)**: This content is automatically injected into CLAUDE.md, AGENTS.md, and GEMINI.md via registry-based auto-discovery. Update all files: `ct init --update-docs` or `ct upgrade`.

### CRITICAL: Error Handling
**NEVER ignore exit codes. Failed commands mean tasks were NOT created/updated.**

**After EVERY command, check:**
1. Exit code `0` = success, `1-22` = error, `100+` = special (not error)
2. JSON field `"success": false` = operation failed
3. **Execute `error.fix`** - Copy-paste-ready command to resolve the error
4. **Or choose from `error.alternatives`** - Array of {action, command} options
5. Check `error.context` for structured error data

**Common Errors and Fixes:**
| Exit | Code | Meaning | Fix |
|:----:|------|---------|-----|
| 6 | `E_VALIDATION_*` | Validation failed | Check field lengths, escape `$` in notes |
| 10 | `E_PARENT_NOT_FOUND` | Parent doesn't exist | Verify with `ct exists <parent-id>` |
| 11 | `E_DEPTH_EXCEEDED` | Max depth (3) exceeded | Use shallower hierarchy (epic→task→subtask max) |
| 12 | `E_SIBLING_LIMIT` | Too many siblings (7) | Move task to different parent |
| 4 | `E_NOT_FOUND` | Task doesn't exist | Use `ct find` or `ct list` to verify |

**Recoverable errors (retry with backoff):** 7, 20, 21, 22
**Special codes (not errors):** 100 = no data, 101 = already exists, 102 = no change needed

**Shell escaping for notes:** Always escape `$` as `\$` in notes to prevent shell interpolation:
```bash
ct update T001 --notes "Price: \$395"  # Correct
ct update T001 --notes "Price: $395"   # WRONG - $395 interpreted as variable
```

### Data Integrity (RFC 2119)

**MUST** use `cleo` commands for all state modifications.
**MUST NOT** edit `.cleo/*.json` files directly.
**MUST** check exit codes after every command (see Error Handling above).

**Rationale**: Direct file edits bypass validation, create stale data in multi-writer environments.

### Best Practices (Efficiency)

**Task Discovery** (MUST follow for context efficiency):
```bash
ct find "query"              # ✅ Fuzzy search (99% less context than list)
ct find --id 1234            # ✅ Find by task ID prefix (returns multiple)
ct show T1234                # ✅ Full details for specific task
ct list --parent T001        # ✅ Direct children only
ct analyze --parent T001     # ✅ ALL descendants (recursive)
```

**Discovery vs Retrieval** (CRITICAL):
| Command | Returns | Fields | Use Case |
|---------|---------|--------|----------|
| `find --id 142` | Multiple matches (T1420-T1429) | Minimal (id, title, status) | Search: "Which tasks?" |
| `show T1429` | Single task | Full (description, notes, hierarchy) | Details: "Tell me everything" |

**Why `find` > `list`**:
- `list` includes full notes arrays (potentially huge)
- `find` returns minimal fields only
- **MUST** use `find` for discovery, `show` for details

**Other Patterns**:
- **Native filters**: Use `--status`, `--label`, `--phase`, `--parent` (faster than jq)
- **Command discovery**: `ct commands -r critical` shows essential commands
- **Session lifecycle**: Start sessions before work, end when complete
- **JSON auto-detection**: Piped output is JSON (no `--format` flag needed)

### Essential Commands
```bash
ct list                    # View tasks (JSON when piped)
ct find "query"            # Fuzzy search (99% less context)
ct find --id 142           # ID search (multiple matches)
ct show T1234              # Full task details
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
ct analyze                 # Task triage (JSON default)
ct analyze --auto-focus    # Auto-set focus to top task
ct delete <id> --reason "..."  # Cancel/soft-delete task
ct uncancel <id>           # Restore cancelled task
ct context                 # Check context window usage
ct context check           # Exit code for scripting (0=OK, 50+=warning)
```

### Command Discovery
```bash
cleo commands -r critical    # Show critical commands (no jq needed)
```

### Session Protocol

**Sessions persist across Claude conversations.** Resume where you left off.

**Sessions coexist.** No need to suspend one to start another.

#### START (State Awareness)
```bash
ct session list              # Check existing sessions
ct list                      # See task state
ct dash                      # Project overview
ct session resume <id>       # Resume existing
# OR
ct session start --scope epic:T001 --auto-focus --name "Feature Work"
```

#### WORK (Operational)
```bash
ct focus show                # Your focus
ct next                      # Get task suggestion
ct add "Subtask" --depends T005  # Add related tasks
ct update T005 --notes "..."     # Add task notes
ct focus note "Working on X"     # Session-level note
ct complete T005             # Complete task
ct focus set T006            # Next task
```

#### END (Cleanup)
```bash
ct complete <task-id>        # Complete current work
ct archive                   # Clean up old done tasks
ct session end --note "Progress notes"
```

### Phase Tracking
```bash
ct phases                  # List phases with progress
ct phase set <slug>        # Set current project phase
ct phase show              # Show current phase
ct list --phase core       # Filter tasks by phase
```
### Phase Integration
- Tasks can be assigned to project phases
- Phases provide progress tracking and organization
- Use `cleo list --phase <slug>` to filter by phase

### Phase Discipline
**Check phase context before work:**
```bash
ct phase show              # Always verify current phase
ct list --phase $(ct phase show -q)  # Focus on current phase tasks
```

**Cross-phase work guidelines:**
- **Same phase preferred** - Work within current phase when possible
- **Intentional cross-phase** - Document rationale when working across phases
- **Phase-aware creation** - Set task phase during creation: `ct add "Task" --phase testing`

**Phase progression awareness:**
- Core phase: Feature development and main implementation
- Testing phase: Validation, testing, and quality assurance
- Polish phase: Refinement, documentation, and final touches
- Maintenance phase: Bug fixes and ongoing support

### Hierarchy Automation (v0.24.0+)
- **Auto-complete**: Parent completes when all children done (if enabled)
- **Orphan repair**: `ct validate --fix-orphans unlink`
- **Tree view**: `ct tree` or `ct list --tree` (equivalent). Subtree: `ct tree --parent T001`
- **Reparent**: `ct reparent T005 --to T001` (move to different parent)
- **Promote**: `ct promote T005` (remove parent, make root)
- **Populate hierarchy**: `ct populate-hierarchy` (infer parentId from naming conventions)

**Enable auto-complete:**
```bash
ct config set hierarchy.autoCompleteParent true
ct config set hierarchy.autoCompleteMode auto  # auto|suggest|off
```

**Move tasks in hierarchy:**
```bash
ct reparent T005 --to T001           # Move T005 under T001
ct reparent T005 --to ""             # Remove parent (make root)
ct promote T005                      # Same as reparent --to ""
```

**Detect and fix orphaned tasks:**
```bash
ct validate --check-orphans          # Check for orphans
ct validate --fix-orphans unlink     # Remove invalid parent references
ct validate --fix-orphans delete     # Delete orphaned tasks
```

### Context Monitoring
```bash
ct context                 # Show context usage (🟢 ok, 🟡 warning, 🔴 critical)
ct context check           # Silent check, exit codes for scripting
```
**Exit codes**: `0`=OK (<70%) | `50`=Warning (70-84%) | `51`=Caution (85-89%) | `52`=Critical (90-94%) | `53`=Emergency (95%+)

**Automatic alerts**: When a CLEO session is active, context alerts automatically appear on stderr after task operations (`complete`, `add`, `focus set`, session lifecycle). Alerts use visual box format and only trigger on threshold crossings. Configure with `ct config set contextAlerts.*`. See `docs/commands/context.md` for details.

### Research Subagent Integration (v0.53.0+)
```bash
ct research init                  # Initialize research outputs directory
ct research list                  # List research entries from manifest
ct research list --status complete --limit 10  # Filter entries
ct research show <id>             # Show research entry details
ct research show <id> --full      # Include full file content
ct research inject                # Output subagent injection template
ct research inject --clipboard    # Copy to clipboard
ct research link T001 <research-id>  # Link research to task
```

**Subagent Workflow**:
1. Use `ct research inject` to get the protocol injection block
2. Inject into subagent prompts via Task tool
3. Subagents write to `claudedocs/research-outputs/` + append to `MANIFEST.jsonl`
4. Query via `ct research list/show` instead of reading full files (context-efficient)

### Export/Import (Cross-Project)
```bash
# Export tasks to another project
ct export-tasks T001 --output task.json            # Export single task
ct export-tasks T001 --subtree --output epic.json  # Export epic with children

# Import tasks from another project
ct import-tasks task.json                          # Import into current project
ct import-tasks task.json --dry-run                # Preview import
ct import-tasks task.json --parent T050            # Import as children of T050
```
<!-- CLEO:END -->
# Repository Guidelines

## Project Overview

**CLEO** is the task management protocol for solo developers and their AI coding agents. Built specifically for Claude Code with LLM-agent-first design principles.

### Core Mission
- **Anti-hallucination validation**: Every operation is validated before execution
- **Context persistence**: State is maintained across sessions with immutable audit trails
- **Structured output**: JSON by default, with human-readable formatting opt-in
- **Atomic operations**: All writes use temp file → validate → backup → rename pattern

### Critical Philosophy
**NO TIME ESTIMATES** - This system explicitly prohibits estimating hours, days, or duration for any task. Instead, describe scope, complexity, and dependencies using relative sizing (small/medium/large) when needed.

### Documentation Standards
@docs/CLEO-DOCUMENTATION-SOP.md

## Project Structure & Module Organization

```
scripts/          # CLI command entrypoints (user-facing operational scripts)
lib/              # Shared Bash helpers (validation, logging, file ops, config)
schemas/          # JSON Schema definitions for validation
templates/        # Starter templates for new projects
tests/            # BATS test suite with unit/, integration/, golden/, fixtures/
docs/             # User-facing documentation
claudedocs/       # Internal research and specifications
archive/          # Historical data and early designs
dev/              # Development scripts (bump-version, benchmark, validation)
```

### Key Architecture Principles
- **Scripts/** contains only user-facing operational commands
- **Lib/** contains all shared functions used by multiple scripts
- **Atomic file operations** are mandatory for all write operations
- **JSON Schema validation** runs on every data modification
- **Append-only logging** to todo-log.json for audit trails

## Build, Test, and Development Commands

### Installation & Setup
```bash
./install.sh --check-deps           # Verify Bash/jq prerequisites
./install.sh                        # Install symlinks for local development
git submodule update --init --recursive  # Pull BATS helper libraries
```

### Validation & Testing
```bash
cleo version                 # Verify CLI installation
cleo --validate              # Validate installation and data integrity
./tests/run-all-tests.sh            # Run full BATS test suite
bats tests/unit/*.bats              # Run specific unit tests
bats tests/integration/*.bats       # Run integration tests
bash -n scripts/*.sh lib/*.sh       # Quick syntax check on shell changes
```

### Development Tools
```bash
./dev/bump-version.sh               # Update version across files
./dev/validate-version.sh           # Verify version consistency
./dev/benchmark-performance.sh      # Performance testing
```

## Coding Style & Naming Conventions

### Shell Script Standards
- **Bash only**: `#!/usr/bin/env bash` shebang required
- **Error handling**: `set -euo pipefail` where appropriate
- **Indentation**: 4 spaces (no tabs)
- **Naming conventions**:
  - Functions/variables: `snake_case`
  - Constants: `UPPER_SNAKE_CASE`
- **Best practices**:
  - Always quote variable expansions
  - Prefer `[[ ... ]]` over `[ ... ]` for conditionals
  - Use `$()` for command substitution (not backticks)

### JSON Standards
- **Indentation**: 2 spaces
- **Keys**: camelCase
- **Formatting**: No trailing commas
- **Validation**: Must pass JSON Schema validation

## Critical Rules & Constraints

### **CRITICAL: Atomic Operations**
All write operations MUST follow this pattern:
1. Write to temporary file
2. Validate against JSON Schema
3. Create backup of original
4. Atomic rename to replace original

### **CRITICAL: Anti-Hallucination Requirements**
Every task MUST have:
- Both `title` AND `description` fields
- Different content for title and description
- Valid status from enum: `pending | active | blocked | done`
- Unique ID across todo.json AND todo-archive.json
- Timestamps not in the future
- No duplicate task descriptions

### **IMPORTANT: Time Estimates Prohibited**
**NEVER** estimate hours, days, or duration. Describe scope, complexity, and dependencies instead.

## Testing Guidelines

### Test Structure
- **Unit tests**: `tests/unit/` - Test individual functions
- **Integration tests**: `tests/integration/` - Test command workflows
- **Golden tests**: `tests/golden/` - Test output formatting
- **Fixtures**: `tests/fixtures/` - Test data setup

### Test Naming
- Files: `feature-name.bats`
- Tests: `@test "feature should expected_outcome"`

### Test Requirements
- New features require tests
- Bug fixes require tests that reproduce the issue
- Prefer fixtures for data setup
- Tests must pass before merging

## Commit & Pull Request Guidelines

### Commit Messages
Format: `<type>: <summary>`
- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`
- Scopes: `chore(docs):`, `fix(validation):`, etc.
- Keep summaries under 50 characters

### Branch Naming
- `feature/description`
- `fix/description`
- `docs/description`
- `test/description`
- `refactor/description`

### PR Requirements
- Clear description of changes
- Link to relevant issues
- All tests must pass (`./tests/run-all-tests.sh`)
- Follow existing code style

### Data Integrity
- **CLI only** - Never edit `.cleo/*.json` directly
- **Verify state** - Use `cleo list` before assuming
- **Session discipline** - Start/end sessions properly

## Key Files & Entry Points

### Core Scripts
- `scripts/add-task.sh` - Task creation
- `scripts/update-task.sh` - Task updates
- `scripts/complete-task.sh` - Task completion
- `scripts/phase.sh` - Phase management
- `scripts/phases.sh` - Phase listing

### Library Functions
- `lib/validation.sh` - JSON Schema validation
- `lib/file-ops.sh` - Atomic file operations
- `lib/logging.sh` - Audit trail logging
- `lib/phase-tracking.sh` - Phase management

### Schema Definitions
- `schemas/todo.schema.json` - Main task schema

## Backup System Architecture

The backup system implements a **two-tier design**:

### Tier 1: Operational Backups (Atomic Write Safety)
- **Location**: `lib/file-ops.sh`
- **Directory**: `.cleo/.backups/` (numbered: `todo.json.1`, `todo.json.2`, etc.)
- **Purpose**: Automatic rollback protection for every write operation
- **Trigger**: Automatic on `atomic_write()` / `save_json()`
- **Retention**: Last 10 backups per file (configurable)

### Tier 2: Recovery Backups (Point-in-Time Snapshots)
- **Location**: `lib/backup.sh`
- **Directory**: `.cleo/backups/{type}/`
- **Types**: `snapshot`, `safety`, `archive`, `migration`
- **Purpose**: User-initiated and pre-destructive operation backups
- **Trigger**: Manual (`backup` command) or automatic (before destructive ops)
- **Features**: Metadata, checksums, retention policies

### Key Functions
| Function | File | Purpose |
|----------|------|---------|
| `atomic_write()` | file-ops.sh | Tier 1 write with backup |
| `backup_file()` | file-ops.sh | Tier 1 numbered backup |
| `create_snapshot_backup()` | backup.sh | Tier 2 full snapshot |
| `create_safety_backup()` | backup.sh | Tier 2 pre-operation backup |
| `rotate_backups()` | backup.sh | Tier 2 retention enforcement |
| `list_typed_backups()` | backup.sh | Tier 2 backup listing |
| `restore_typed_backup()` | backup.sh | Tier 2 recovery |

## Validation & Error Handling

### Pre-Operation Checks
Before any task operation, validate:
1. ID uniqueness across all files
2. Status is valid enum value
3. Timestamps are not in future
4. Title and description both present and different
5. No duplicate task descriptions

### Error Recovery
- All operations log to `todo-log.json` (append-only)
- Backup files created during atomic operations
- Validation errors prevent operations
- Clear error messages for debugging

## Agent Notes

### When Using AI Agents
1. **Follow CLAUDE.md** - It defines repository-specific workflow expectations
2. **Respect atomic operations** - Never bypass the temp→validate→backup→rename pattern
3. **Maintain data integrity** - Always validate before and after operations
4. **Use proper testing** - Add tests for new features and bug fixes
5. **Follow commit conventions** - Use proper types and scopes
6. **No time estimates** - Focus on scope and complexity instead

### Common Pitfalls to Avoid
- Don't edit JSON files directly - use CLI commands only
- Don't skip validation steps - they're critical for data integrity
- Don't add time estimates - they're explicitly prohibited
- Don't forget atomic operations - all writes must be atomic

## Version Management

CLEO uses a **single source of truth** architecture for schema versions:

### Version Sources
- Schema versions are defined ONLY in `schemas/*.schema.json` files (single source of truth)
- Use `get_schema_version_from_file()` to read versions - NEVER hardcode
- Version field location: `._meta.schemaVersion` (canonical), `.version` (legacy fallback)
- Migration functions discovered dynamically via `discover_migration_versions()`
- No SCHEMA_VERSION_* constants - deleted in v0.48.x

### Reading Versions
```bash
source lib/migrate.sh

# Get current schema version for a file type
version=$(get_schema_version_from_file "todo")  # Returns "2.6.0"

# Discover available migrations
versions=$(discover_migration_versions "todo")  # Returns "2.2.0 2.3.0 2.4.0..."
```

### Template Placeholders
Templates use dynamic placeholders replaced during initialization:
- `{{SCHEMA_VERSION_TODO}}` → current todo.json schema version
- `{{SCHEMA_VERSION_CONFIG}}` → current config.json schema version
- `{{SCHEMA_VERSION_ARCHIVE}}` → current archive.json schema version
- `{{SCHEMA_VERSION_LOG}}` → current log.json schema version

### Migration Conventions
**Function naming:**
- Semver pattern: `migrate_<type>_to_<major>_<minor>_<patch>`
  - Example: `migrate_todo_to_2_6_0`
- Timestamp pattern (future): `migrate_<type>_<YYYYMMDDHHMMSS>_<description>`
  - Example: `migrate_todo_20260103120000_add_field`

**See:** [docs/MIGRATION-SYSTEM.md](docs/MIGRATION-SYSTEM.md) for complete architecture documentation

# Repository Guidelines

## Project Overview

**CLEO** is the task management protocol for solo developers and their AI coding agents. Built specifically for Claude Code with LLM-agent-first design principles.

### Core Mission
- **Anti-hallucination validation**: Every operation is validated before execution
- **Context persistence**: State is maintained across sessions with immutable audit trails 
- **Structured output**: JSON by default, with human-readable formatting opt-in
- **Atomic operations**: All writes use temp file → validate → backup → rename pattern

### Critical Philosophy
**NO TIME ESTIMATES** - This system explicitly prohibits estimating hours, days, or duration for any task. Instead, describe scope, complexity, and dependencies using relative sizing (small/medium/large) when needed.

## Project Structure & Module Organization

```
scripts/          # CLI command entrypoints (user-facing operational scripts)
lib/              # Shared Bash helpers (validation, logging, file ops, config)
schemas/          # JSON Schema definitions for validation
templates/        # Starter templates for new projects
tests/            # BATS test suite with unit/, integration/, golden/, fixtures/
docs/             # User-facing documentation
claudedocs/       # Internal research and specifications
archive/          # Historical data and early designs
dev/              # Development scripts (bump-version, benchmark, validation)
```

### Key Architecture Principles
- **Scripts/** contains only user-facing operational commands
- **Lib/** contains all shared functions used by multiple scripts
- **Atomic file operations** are mandatory for all write operations
- **JSON Schema validation** runs on every data modification
- **Append-only logging** to todo-log.json for audit trails

## Build, Test, and Development Commands

### Installation & Setup
```bash
./install.sh --check-deps           # Verify Bash/jq prerequisites
./install.sh                        # Install symlinks for local development
git submodule update --init --recursive  # Pull BATS helper libraries
```

### Validation & Testing
```bash
cleo version                 # Verify CLI installation
cleo --validate              # Validate installation and data integrity
./tests/run-all-tests.sh            # Run full BATS test suite
bats tests/unit/*.bats              # Run specific unit tests
bats tests/integration/*.bats       # Run integration tests
bash -n scripts/*.sh lib/*.sh       # Quick syntax check on shell changes
```

### Development Tools
```bash
./dev/bump-version.sh               # Update version across files
./dev/validate-version.sh           # Verify version consistency
./dev/benchmark-performance.sh      # Performance testing
```

## Coding Style & Naming Conventions

### Shell Script Standards
- **Bash only**: `#!/usr/bin/env bash` shebang required
- **Error handling**: `set -euo pipefail` where appropriate
- **Indentation**: 4 spaces (no tabs)
- **Naming conventions**:
  - Functions/variables: `snake_case`
  - Constants: `UPPER_SNAKE_CASE`
- **Best practices**:
  - Always quote variable expansions
  - Prefer `[[ ... ]]` over `[ ... ]` for conditionals
  - Use `$()` for command substitution (not backticks)

### JSON Standards
- **Indentation**: 2 spaces
- **Keys**: camelCase
- **Formatting**: No trailing commas
- **Validation**: Must pass JSON Schema validation

## Critical Rules & Constraints

### **CRITICAL: Atomic Operations**
All write operations MUST follow this pattern:
1. Write to temporary file
2. Validate against JSON Schema
3. Create backup of original
4. Atomic rename to replace original

### **CRITICAL: Anti-Hallucination Requirements**
Every task MUST have:
- Both `title` AND `description` fields
- Different content for title and description
- Valid status from enum: `pending | active | blocked | done`
- Unique ID across todo.json AND todo-archive.json
- Timestamps not in the future
- No duplicate task descriptions

### **IMPORTANT: Time Estimates Prohibited**
**NEVER** estimate hours, days, or duration. Describe scope, complexity, and dependencies instead.

## Testing Guidelines

### Test Structure
- **Unit tests**: `tests/unit/` - Test individual functions
- **Integration tests**: `tests/integration/` - Test command workflows
- **Golden tests**: `tests/golden/` - Test output formatting
- **Fixtures**: `tests/fixtures/` - Test data setup

### Test Naming
- Files: `feature-name.bats`
- Tests: `@test "feature should expected_outcome"`

### Test Requirements
- New features require tests
- Bug fixes require tests that reproduce the issue
- Prefer fixtures for data setup
- Tests must pass before merging

## Commit & Pull Request Guidelines

### Commit Messages
Format: `<type>: <summary>`
- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`
- Scopes: `chore(docs):`, `fix(validation):`, etc.
- Keep summaries under 50 characters

### Branch Naming
- `feature/description`
- `fix/description`
- `docs/description`
- `test/description`
- `refactor/description`

### PR Requirements
- Clear description of changes
- Link to relevant issues
- All tests must pass (`./tests/run-all-tests.sh`)
- Follow existing code style

### Data Integrity
- **CLI only** - Never edit `.cleo/*.json` directly
- **Verify state** - Use `cleo list` before assuming
- **Session discipline** - Start/end sessions properly

## Key Files & Entry Points

### Core Scripts
- `scripts/add-task.sh` - Task creation
- `scripts/update-task.sh` - Task updates
- `scripts/complete-task.sh` - Task completion
- `scripts/phase.sh` - Phase management
- `scripts/phases.sh` - Phase listing

### Library Functions
- `lib/validation.sh` - JSON Schema validation
- `lib/file-ops.sh` - Atomic file operations
- `lib/logging.sh` - Audit trail logging
- `lib/phase-tracking.sh` - Phase management

### Schema Definitions
- `schemas/todo.schema.json` - Main task schema

## Backup System Architecture

The backup system implements a **two-tier design**:

### Tier 1: Operational Backups (Atomic Write Safety)
- **Location**: `lib/file-ops.sh`
- **Directory**: `.cleo/.backups/` (numbered: `todo.json.1`, `todo.json.2`, etc.)
- **Purpose**: Automatic rollback protection for every write operation
- **Trigger**: Automatic on `atomic_write()` / `save_json()`
- **Retention**: Last 10 backups per file (configurable)

### Tier 2: Recovery Backups (Point-in-Time Snapshots)
- **Location**: `lib/backup.sh`
- **Directory**: `.cleo/backups/{type}/`
- **Types**: `snapshot`, `safety`, `archive`, `migration`
- **Purpose**: User-initiated and pre-destructive operation backups
- **Trigger**: Manual (`backup` command) or automatic (before destructive ops)
- **Features**: Metadata, checksums, retention policies

### Key Functions
| Function | File | Purpose |
|----------|------|---------|
| `atomic_write()` | file-ops.sh | Tier 1 write with backup |
| `backup_file()` | file-ops.sh | Tier 1 numbered backup |
| `create_snapshot_backup()` | backup.sh | Tier 2 full snapshot |
| `create_safety_backup()` | backup.sh | Tier 2 pre-operation backup |
| `rotate_backups()` | backup.sh | Tier 2 retention enforcement |
| `list_typed_backups()` | backup.sh | Tier 2 backup listing |
| `restore_typed_backup()` | backup.sh | Tier 2 recovery |

## Validation & Error Handling

### Pre-Operation Checks
Before any task operation, validate:
1. ID uniqueness across all files
2. Status is valid enum value
3. Timestamps are not in future
4. Title and description both present and different
5. No duplicate task descriptions

### Error Recovery
- All operations log to `todo-log.json` (append-only)
- Backup files created during atomic operations
- Validation errors prevent operations
- Clear error messages for debugging

## Agent Notes

### When Using AI Agents
1. **Follow CLAUDE.md** - It defines repository-specific workflow expectations
2. **Respect atomic operations** - Never bypass the temp→validate→backup→rename pattern
3. **Maintain data integrity** - Always validate before and after operations
4. **Use proper testing** - Add tests for new features and bug fixes
5. **Follow commit conventions** - Use proper types and scopes
6. **No time estimates** - Focus on scope and complexity instead

### Common Pitfalls to Avoid
- Don't edit JSON files directly - use CLI commands only
- Don't skip validation steps - they're critical for data integrity
- Don't add time estimates - they're explicitly prohibited
- Don't forget atomic operations - all writes must be atomic
