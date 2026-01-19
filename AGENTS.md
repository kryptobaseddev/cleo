<!-- CLEO:START v0.53.4 -->
@.cleo/templates/AGENT-INJECTION.md
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
- **CLI only** - Never edit `.claude/*.json` directly
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

## Backup System Operations

### Path Discovery
LLM agents MUST NOT hardcode backup paths. Use:
```bash
# Get backup directory from config
cleo config get backup.directory
# Default: .claude/backups/
```

### Creating Backups
```bash
# Manual snapshot (recommended before major changes)
cleo backup

# System creates safety backups automatically before:
# - validate --fix
# - restore
# - archive
# - complete
```

### Listing Backups
```bash
cleo backup --list           # All backups
cleo backup --list --type snapshot  # Filter by type
```

### Restoring Backups
```bash
# ALWAYS verify what you're restoring first
cleo backup --list

# Restore specific backup
cleo restore <backup-id>

# System creates safety backup before restore
```

### Error Recovery
If backup operations fail:
1. Check disk space: `df -h .claude/`
2. Check permissions: `ls -la .claude/backups/`
3. Run validation: `cleo validate --fix`
4. Check audit log: `cleo log --operation backup`

### Best Practices
- Create snapshot before multi-task operations
- Never delete backups directly - use retention policies
- Verify restore target before executing
- Migration backups are NEVER deleted automatically

## Agent Notes

### When Using AI Agents
1. **Follow AGENTS.md** - It defines repository-specific workflow expectations
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
- Don't skip testing - new features need tests
