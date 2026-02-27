<!-- CAAMP:START -->
@~/.cleo/templates/CLEO-INJECTION.md
@.cleo/project-context.json
<!-- CAAMP:END -->
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

## Architecture: MCP-First + Shared Core

CLEO uses a **shared-core** architecture where both MCP and CLI are thin wrappers around `src/core/`:

```
MCP Gateway (2 tools) ──► src/mcp/domains/ ──► src/mcp/engine/ ──► src/core/ ◄── src/cli/commands/
     cleo_query (93 ops)                                                              (80+ commands)
     cleo_mutate (71 ops)
```

- **MCP is PRIMARY**: 2 tools, 164 operations across 10 canonical domains (~1,800 tokens)
- **CLI is BACKUP**: 80+ commands for human use and fallback
- **src/core/ is CANONICAL**: All business logic lives here. Both MCP and CLI delegate to it.
- **Canonical operations reference**: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`
- **Verb standards**: `docs/specs/VERB-STANDARDS.md` (add, show, find, list, etc.)

## Project Structure & Module Organization

```
src/                # TypeScript source (primary codebase)
  src/cli/          #   CLI entry point (Commander.js) and command registrations
  src/cli/commands/ #   75 command handlers (parse args -> core -> format output)
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
claudedocs/         # Legacy internal research (migrated to .cleo/)
tests/              # Test suite (Vitest + legacy BATS)
dev/                # Development scripts (bump-version, benchmark, validation)
dev/migrations/     # Internal one-time migration scripts (NOT user commands)
scripts/            # Legacy Bash CLI (deprecated, pending removal)
lib/                # Legacy Bash helpers (deprecated, pending removal)
```

### Key Architecture Principles
- **MCP is the PRIMARY entry point**; CLI is the backup interface
- **src/core/** is the single source of truth for all business logic
- **Both CLI and MCP** delegate to `src/core/` (shared-core pattern, verified by T4565/T4566 audit)
- **src/cli/commands/** contains thin handlers: parse args -> call core -> format output
- **src/mcp/engine/** contains thin adapters: translate MCP params -> call core -> format response
- **Atomic file operations** are mandatory for all write operations
- **JSON Schema validation** runs on every data modification
- **Append-only logging** to audit log in `tasks.db` for audit trails
- **scripts/ and lib/** are deprecated Bash code pending removal (see ADR-004)

## Build, Test, and Development Commands

### Installation & Setup
```bash
npm install                          # Install dependencies
npm run build                        # Compile TypeScript to dist/
node dist/cli/index.js version       # Verify CLI
```

### TypeScript Build & Test (Primary)

```bash
# Type-check without emitting
npx tsc --noEmit

# Run Vitest test suite
npm test
npx vitest run
npx vitest run --coverage

# Watch mode
npm run dev          # Watch mode type-checking
npm run dev:watch    # Watch mode build
```

### Legacy Testing (BATS - deprecated, being migrated to Vitest)

```bash
# Run full legacy test suite
./tests/run-all-tests.sh

# Run specific BATS test file
bats tests/unit/add-task.bats

# Check test prerequisites
./install.sh --check-deps
git submodule update --init --recursive
```

### Database Schema Changes (CRITICAL — read before touching schema.ts)
```bash
# Standard path — drizzle-kit diffs schema.ts vs last snapshot:
npx drizzle-kit generate             # → creates migration.sql + snapshot.json

# Exception path — change drizzle-kit cannot detect (e.g. CHECK constraint values):
npx drizzle-kit generate --custom --name "describe-the-change"
# → creates migration.sql (empty, you fill it in) + snapshot.json (generated, do not touch)
```

**Rules enforced by pre-commit hook:**
- Every `drizzle/*/migration.sql` MUST have a sibling `snapshot.json` in the same directory
- `snapshot.json` is generated automatically — never hand-write it
- A migration without a snapshot breaks the diff chain: the next `drizzle-kit generate` will produce incorrect output

**Never do:**
- Create a migration directory and write `migration.sql` by hand without running `drizzle-kit generate` or `drizzle-kit generate --custom` first
- Copy a `snapshot.json` from another migration and edit it
- Create a `snapshot.json` with `"ddl": []` or `"prevIds": []`

**When to use `--custom`:**
drizzle-kit v7 SQLite snapshots store column type (`text`) but not CHECK constraint values.
`{ enum: [...] }` on a SQLite column is TypeScript-only metadata — drizzle-kit cannot diff it.
Any migration that modifies a CHECK constraint (e.g. adding a status value) will return
"No schema changes" from plain `drizzle-kit generate`. Use `--custom` in that case.

**Workflow (standard):**
1. Edit `src/store/schema.ts`
2. Run `npx drizzle-kit generate` → inspect the generated SQL
3. If the generated SQL has already-applied statements (from a broken prior chain), trim those statements from `migration.sql` — **leave `snapshot.json` untouched**
4. Commit both files together

**Workflow (CHECK constraint / enum value change):**
1. Edit `src/store/schema.ts` and `src/store/status-registry.ts`
2. Run `npx drizzle-kit generate` — if it says "No schema changes", proceed to step 3
3. Run `npx drizzle-kit generate --custom --name "describe-the-change"`
4. Fill in the generated (empty) `migration.sql` with the table-rebuild SQL
5. Commit `migration.sql` + `snapshot.json` together

### Validation & Linting

```bash
# Validate CLEO installation and data integrity
cleo --validate

# Validate with auto-fix
cleo validate --fix

# Verify version consistency
./dev/validate-version.sh
```

### Development Tools

```bash
# Bump version via config-driven system
cleo release ship <version> --bump-version

# Performance testing
./dev/benchmark-performance.sh

# Backup operations
cleo backup
cleo backup --list
cleo restore <backup-id>
```

## Code Style Guidelines

### TypeScript Standards (Primary)

- **Module format**: ESM (`import`/`export`, `"type": "module"` in package.json)
- **Strict mode**: `strict: true` in tsconfig.json
- **Indentation**: 2 spaces
- **Naming**: `camelCase` functions/variables, `PascalCase` types, `UPPER_SNAKE_CASE` constants, `kebab-case.ts` filenames
- **Imports**: Use `node:` prefix for built-ins, `.js` extensions in import paths (ESM)
- **CLI commands**: Use Commander.js for argument parsing
- **Explicit return types** on exported functions

### JSON Standards

- **Indentation**: 2 spaces
- **Keys**: camelCase
- **Formatting**: No trailing commas
- **Validation**: Must pass JSON Schema validation

### Shell Script Standards (Legacy - deprecated)

Shell scripts in `scripts/` and `lib/` are deprecated Bash code pending removal.
New development MUST use TypeScript. See `src/cli/commands/` for examples.

### Test File Standards

**Vitest (Primary)**:
- Files: `*.test.ts` or `*.integration.test.ts`
- Location: co-located in `__tests__/` directories or `tests/`

**BATS (Legacy)**:
- Files: `feature-name.bats` (kebab-case)
- Tests: `@test "feature should expected_outcome"`

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
- Unique ID across active and archived tasks
- Timestamps not in the future
- No duplicate task descriptions

### **CRITICAL: No Time Estimates**
**NEVER** estimate hours, days, or duration. Describe scope, complexity, and dependencies using relative sizing (small/medium/large) instead.

### **CRITICAL: CLI-Only Data Operations**
Never edit `.cleo/` data files directly. Always use CLI commands:
- `cleo add` not editing tasks.db directly
- `cleo update` not manual database edits
- `cleo complete` not marking done in database

### **CRITICAL: Task Reference Format**
All commits must reference a task ID: `(T####)`
Example: `feat: add new validation (T1234)`

### **CRITICAL: Verb Standards**
All new operations MUST use canonical verbs per `docs/specs/VERB-STANDARDS.md`:
- `add` (not create), `show` (not get), `find` (not search/query)
- `restore` (not unarchive/reopen/uncancel), `start`/`stop` (not focus.set/focus.clear)

## Key Files & Entry Points

### MCP Server (Primary Entry Point)
- `src/mcp/index.ts` - MCP server entry point
- `src/mcp/gateways/query.ts` - 93 query operations (CANONICAL operation registry)
- `src/mcp/gateways/mutate.ts` - 71 mutate operations (CANONICAL operation registry)
- `src/mcp/domains/` - 10 domain handlers (tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sharing)
- `src/mcp/engine/` - Engine adapters (MCP params → core calls)
- `src/mcp/engine/capability-matrix.ts` - Native vs CLI routing matrix

### CLI Entry Points (Backup Interface)
- `src/cli/index.ts` - CLI entry point (Commander.js program)
- `src/cli/commands/add.ts` - Task creation
- `src/cli/commands/update.ts` - Task updates
- `src/cli/commands/complete.ts` - Task completion
- `src/cli/commands/start.ts` - Start working on a task
- `src/cli/commands/stop.ts` - Stop working on current task
- `src/cli/commands/current.ts` - Show currently active task
- `src/cli/commands/session.ts` - Session management

### Core Business Logic
- `src/core/tasks/` - Task CRUD, hierarchy, dependencies
- `src/core/task-work/` - Active task tracking (start/stop/current)
- `src/core/sessions/` - Session lifecycle
- `src/core/lifecycle/` - RCSD-IVTR lifecycle gates
- `src/core/orchestration/` - Multi-agent orchestration
- `src/core/research/` - Research manifest management
- `src/core/release/` - Release management
- `src/core/compliance/` - Protocol compliance
- `src/core/validation/` - Schema and anti-hallucination validation
- `src/core/config.ts` - Configuration management

### Store Layer
- `src/store/json.ts` - JSON file read/write
- `src/store/atomic.ts` - Atomic file operations
- `src/store/backup.ts` - Backup management
- `src/store/lock.ts` - File locking

### Canonical Specifications
- `docs/specs/CLEO-OPERATIONS-REFERENCE.md` - All 164 MCP operations mapped to CLI equivalents (supersedes COMMANDS-INDEX.json)
- `docs/specs/MCP-SERVER-SPECIFICATION.md` - MCP server contract (v1.2.0)
- `docs/specs/VERB-STANDARDS.md` - Canonical verb standards (add, show, find, etc.)
- `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` - Progressive disclosure and agent interaction patterns

### Schema Definitions
- `schemas/todo.schema.json` - Main task schema

## Backup System Architecture

The backup system implements a **two-tier design**:

### Tier 1: Operational Backups (Atomic Write Safety)
- **Location**: `src/store/atomic.ts`
- **Directory**: `.cleo/.backups/`
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
- All operations log to audit log in `tasks.db` (append-only)
- Backup files created during atomic operations
- Validation errors prevent operations
- Clear error messages for debugging

### Exit Code Ranges
- `0` - Success
- `1-59` - General errors
- `60-67` - Protocol violations (research, consensus, spec, etc.)
- `68-70` - Validation/testing violations
- `75-79` - Lifecycle gate errors
- `80-84` - Verification gate codes
- `85-99` - Nexus codes
- `100+` - Special conditions (not errors)

### Error Response Pattern (TypeScript)
```typescript
import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

if (!validationResult.success) {
  throw new CleoError(ExitCode.VALIDATION, 'Validation failed', {
    fix: 'Check input parameters',
    details: validationResult.errors,
  });
}
```

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

## Testing Guidelines

### Test Structure
- **Unit tests**: `tests/unit/` - Test individual functions
- **Integration tests**: `tests/integration/` - Test command workflows
- **Golden tests**: `tests/golden/` - Test output formatting
- **Fixtures**: `tests/fixtures/` - Test data setup

### Test Naming
- Vitest: `*.test.ts` or `*.integration.test.ts`
- BATS (legacy): `feature-name.bats` with `@test "feature should expected_outcome"`

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
- `{{SCHEMA_VERSION_TODO}}` → current tasks schema version (legacy placeholder name)
- `{{SCHEMA_VERSION_CONFIG}}` → current config.json schema version
- `{{SCHEMA_VERSION_ARCHIVE}}` → current archive schema version (legacy placeholder name)
- `{{SCHEMA_VERSION_LOG}}` → current log schema version (legacy placeholder name)

### Migration Conventions
Migrations are implemented in `src/core/migration/` as TypeScript functions. Legacy Bash migrations remain in `lib/migrate.sh` for backward compatibility.

**See:** [docs/MIGRATION-SYSTEM.md](docs/MIGRATION-SYSTEM.md) for complete architecture documentation

## Agent Notes

### When Using AI Agents
1. **MCP-first** - Use `cleo_query`/`cleo_mutate` for programmatic access, CLI for humans
2. **Respect atomic operations** - Never bypass the temp->validate->backup->rename pattern
3. **Maintain data integrity** - Always validate before and after operations
4. **Use proper testing** - Add Vitest tests for new features and bug fixes
5. **Follow commit conventions** - Use proper types and scopes with task IDs
6. **No time estimates** - Focus on scope and complexity instead
7. **Follow verb standards** - Use canonical verbs per VERB-STANDARDS.md

### Common Pitfalls to Avoid
- Don't edit JSON files directly - use CLI commands only
- Don't skip validation steps - they're critical for data integrity
- Don't add time estimates - they're explicitly prohibited
- Don't forget atomic operations - all writes must be atomic
- Don't skip testing - new features need tests
- Don't hardcode paths - use config discovery functions
- Don't use deprecated verbs (get, create, search, query) - use canonical verbs (show, add, find)
