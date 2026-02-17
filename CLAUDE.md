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
src/                # TypeScript source (primary codebase)
  src/cli/          #   CLI entry point (Commander.js) and command registrations
  src/cli/commands/ #   74 command handlers (parse args -> core -> format output)
  src/core/         #   Shared business logic (tasks, sessions, lifecycle, etc.)
  src/mcp/          #   MCP server (domains, engine adapters)
  src/mcp/domains/  #     MCP tool definitions and routing
  src/mcp/engine/   #     Adapters from MCP protocol to src/core/
  src/store/        #   Data access layer (JSON, atomic ops, backup, lock)
  src/types/        #   Shared TypeScript type definitions
  src/validation/   #   Schema validation and anti-hallucination checks
schemas/            # JSON Schema definitions for validation
docs/               # User-facing documentation
docs/adrs/          #   Architecture Decision Records
claudedocs/         # Internal research and specifications
tests/              # Test suite (Vitest + legacy BATS)
dev/                # Development scripts (bump-version, benchmark, validation)
dev/migrations/     # Internal one-time migration scripts (NOT user commands)
scripts/            # Legacy Bash CLI (deprecated, pending removal)
lib/                # Legacy Bash helpers (deprecated, pending removal)
```

### Key Architecture Principles
- **src/core/** is the single source of truth for all business logic
- **Both CLI and MCP** delegate to `src/core/` (shared-core pattern, verified by T4565/T4566 audit)
- **src/cli/commands/** contains thin handlers: parse args -> call core -> format output
- **src/mcp/engine/** contains thin adapters: translate MCP params -> call core -> format response
- **Atomic file operations** are mandatory for all write operations
- **JSON Schema validation** runs on every data modification
- **Append-only logging** to todo-log.jsonl for audit trails
- **scripts/ and lib/** are deprecated Bash code pending removal (see ADR-004)

## Build, Test, and Development Commands

### Installation & Setup
```bash
npm install                          # Install dependencies
npm run build                        # Compile TypeScript to dist/
node dist/cli/index.js version       # Verify CLI
```

### Validation & Testing
```bash
npx tsc --noEmit                     # Type-check without emitting
npm test                             # Run Vitest test suite
npx vitest run                       # Run tests (explicit)
npx vitest run --coverage            # Run tests with coverage
```

### Legacy Testing (BATS - being migrated to Vitest)
```bash
./tests/run-all-tests.sh             # Run legacy BATS test suite
bats tests/unit/*.bats               # Run specific BATS unit tests
```

### Development Tools
```bash
npm run dev                          # Watch mode type-checking
npm run dev:watch                    # Watch mode build
cleo release ship <ver> --bump-version  # Bump version via config-driven system
```

## Coding Style & Naming Conventions

### TypeScript Standards
- **Module format**: ESM (`import`/`export`, `"type": "module"` in package.json)
- **Strict mode**: `strict: true` in tsconfig.json
- **Indentation**: 2 spaces
- **Naming conventions**:
  - Functions/variables: `camelCase`
  - Types/interfaces: `PascalCase`
  - Constants: `UPPER_SNAKE_CASE`
  - File names: `kebab-case.ts`
- **Best practices**:
  - Explicit return types on exported functions
  - Use `node:` prefix for built-in modules (`import { readFileSync } from 'node:fs'`)
  - Prefer `.js` extensions in import paths (ESM resolution)
  - Use Commander.js for CLI argument parsing

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

### CLI Entry Points
- `src/cli/index.ts` - CLI entry point (Commander.js program)
- `src/cli/commands/add.ts` - Task creation
- `src/cli/commands/update.ts` - Task updates
- `src/cli/commands/complete.ts` - Task completion
- `src/cli/commands/session.ts` - Session management
- `src/cli/commands/focus.ts` - Focus management

### Core Business Logic
- `src/core/tasks/` - Task CRUD, hierarchy, dependencies
- `src/core/sessions/` - Session lifecycle, focus tracking
- `src/core/lifecycle/` - RCSD-IVTR lifecycle gates
- `src/core/release/` - Release management
- `src/core/config.ts` - Configuration management

### MCP Server
- `src/mcp/index.ts` - MCP server entry point
- `src/mcp/domains/` - MCP tool domain definitions
- `src/mcp/engine/` - Engine adapters (MCP params -> core calls)

### Store Layer
- `src/store/json.ts` - JSON file read/write
- `src/store/atomic.ts` - Atomic file operations
- `src/store/backup.ts` - Backup management
- `src/store/lock.ts` - File locking

### Schema Definitions
- `schemas/todo.schema.json` - Main task schema

## Backup System Architecture

The backup system implements a **two-tier design**:

### Tier 1: Operational Backups (Atomic Write Safety)
- **Location**: `src/store/atomic.ts`
- **Directory**: `.cleo/.backups/` (numbered: `todo.json.1`, `todo.json.2`, etc.)
- **Purpose**: Automatic rollback protection for every write operation
- **Trigger**: Automatic on atomic write operations
- **Retention**: Last 10 backups per file (configurable)

### Tier 2: Recovery Backups (Point-in-Time Snapshots)
- **Location**: `src/store/backup.ts`
- **Directory**: `.cleo/backups/{type}/`
- **Types**: `snapshot`, `safety`, `archive`, `migration`
- **Purpose**: User-initiated and pre-destructive operation backups
- **Trigger**: Manual (`backup` command) or automatic (before destructive ops)
- **Features**: Metadata, checksums, retention policies

## Validation & Error Handling

### Pre-Operation Checks
Before any task operation, validate:
1. ID uniqueness across all files
2. Status is valid enum value
3. Timestamps are not in future
4. Title and description both present and different
5. No duplicate task descriptions

### Error Recovery
- All operations log to `todo-log.jsonl` (append-only)
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

**Validation functions**: `src/validation/` and `src/core/compliance/`

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
Schema versions are read from JSON Schema files at runtime. The TypeScript migration system in `src/core/migration/` handles version detection and migration execution.

### Template Placeholders
Templates use dynamic placeholders replaced during initialization:
- `{{SCHEMA_VERSION_TODO}}` → current todo.json schema version
- `{{SCHEMA_VERSION_CONFIG}}` → current config.json schema version
- `{{SCHEMA_VERSION_ARCHIVE}}` → current archive.json schema version
- `{{SCHEMA_VERSION_LOG}}` → current log.json schema version

### Migration Conventions
Migrations are implemented in `src/core/migration/` as TypeScript functions. Legacy Bash migrations remain in `lib/migrate.sh` for backward compatibility.

**See:** [docs/MIGRATION-SYSTEM.md](docs/MIGRATION-SYSTEM.md) for complete architecture documentation
