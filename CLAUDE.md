<!-- CLEO:START -->
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

### Metrics & Value Tracking (T2833)

CLEO tracks its own value through real metrics. Enable OpenTelemetry for token tracking.

#### Enabling Real Token Tracking

To capture actual token usage from Claude Code:

```bash
# One-time setup: Add to your shell profile
echo 'source /path/to/project/.cleo/setup-otel.sh' >> ~/.bashrc
# OR for zsh:
echo 'source /path/to/project/.cleo/setup-otel.sh' >> ~/.zshrc

# Then restart your shell or source it now
source .cleo/setup-otel.sh
```

The setup script configures these environment variables:
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="file://${HOME}/.cleo/metrics/otel/"
```

**What Claude Code Captures** (when OpenTelemetry is enabled):
- `claude_code.token.usage` - Aggregated token counts per session
- `claude_code.api_request` - Per-request details (input tokens, output tokens, cache tokens)

**What CLEO Measures**:
- **Token savings**: Manifest reads vs full file reads (measured via compliance tracking)
- **Validation impact**: Protocol violations caught before completion
- **Skill composition**: Multi-skill progressive loading efficiency

**Data Quality Notes**:

**Historical Data (pre-2026-01-30)**: Legacy testing artifacts using commit-hash identifiers.
These entries have estimated validation scores and cannot be backfilled to real validation.

**Current Data (2026-01-30+)**: Real task-based validation using manifest entries.
All new compliance entries use actual protocol validators.

To check data quality:
```bash
# View compliance summary with validation breakdown
cleo compliance value

# Check real vs estimated validation percentage
cleo compliance value --json | jq '.validation.real_percentage'

# View only real validation entries (filter legacy)
jq 'select(.linkedTask != null and (.linkedTask | startswith("T")))' .cleo/metrics/COMPLIANCE.jsonl
```

**Specification**: See `docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` for complete documentation.

### Documentation Standards
@docs/CLEO-DOCUMENTATION-SOP.md

## Project Structure & Module Organization

```
scripts/          # CLI command entrypoints (user-facing commands ONLY)
lib/              # Shared Bash helpers organized into semantic subdirectories
  lib/core/       #   Foundation: exit codes, error handling, logging, config, paths
  lib/validation/ #   Schema validation, protocol enforcement, compliance, doctor
  lib/session/    #   Session lifecycle, context monitoring, lock detection
  lib/tasks/      #   Task mutations, dependency graphs, hierarchy, lifecycle
  lib/skills/     #   Skill discovery/dispatch, agent registry, orchestrator
  lib/data/       #   Atomic writes, file ops, backup, cache, migration, nexus
  lib/ui/         #   CLI flags, command registry, injection system, changelog
  lib/metrics/    #   Token estimation, metrics aggregation, OpenTelemetry
  lib/release/    #   Release lifecycle, artifacts, CI, provenance
  lib/rcsd/       #   RCSD pipeline stages
schemas/          # JSON Schema definitions for validation
templates/        # Starter templates for new projects
tests/            # BATS test suite with unit/, integration/, golden/, fixtures/
docs/             # User-facing documentation
claudedocs/       # Internal research and specifications
archive/          # Historical data and early designs
dev/              # Development scripts (bump-version, benchmark, validation)
dev/migrations/   # Internal one-time migration scripts (NOT user commands)
```

### Key Architecture Principles
- **Scripts/** contains ONLY user-facing commands (checked by drift detection)
- **Dev/migrations/** contains internal one-time scripts (NOT user commands)
- **Lib/** contains shared functions in 9 semantic subdirectories (see `lib/README.md`)
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
- `scripts/add.sh` - Task creation
- `scripts/update.sh` - Task updates
- `scripts/complete.sh` - Task completion
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

### Protocol Enforcement

**Exit codes 60-67**: Protocol violations

CLEO enforces protocol compliance for agent-generated outputs:

| Code | Protocol | Description |
|------|----------|-------------|
| 60 | Research | Missing key_findings or code modifications |
| 61 | Consensus | Invalid voting matrix or confidence scores |
| 62 | Specification | Missing RFC 2119 keywords or version |
| 63 | Decomposition | Too many siblings or unclear descriptions |
| 64 | Implementation | Missing @task tags on new functions |
| 65 | Contribution | Missing @task/@contribution tags |
| 66 | Release | Invalid semver or missing changelog |
| 67 | Generic | Unknown protocol or generic violation |

**Validation functions**: `lib/protocol-validation.sh`

**Guides**:
- Protocol enforcement: `docs/guides/protocol-enforcement.md`
- Troubleshooting: `docs/guides/troubleshooting.md` (Protocol Violations section)

**Commit enforcement**: All commits must reference a task ID `(T####)`
- Hook location: `.cleo/templates/git-hooks/commit-msg`
- Install: `cp .cleo/templates/git-hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg`
- Bypass: `git commit --no-verify` (logged to `.cleo/bypass-log.json`)

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
