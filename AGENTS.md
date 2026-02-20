<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
# Agent Documentation

For comprehensive repository guidelines, see @CLAUDE.md for project overview, architecture principles, critical rules, and detailed workflow expectations.

## Architecture: MCP-First + Shared Core

CLEO uses a **shared-core** architecture where both MCP and CLI are thin wrappers around `src/core/`:

```
MCP Gateway (2 tools) ──► src/mcp/domains/ ──► src/mcp/engine/ ──► src/core/ ◄── src/cli/commands/
     cleo_query (75 ops)                                                              (80+ commands)
     cleo_mutate (65 ops)
```

- **MCP is PRIMARY**: 2 tools, 140 operations across 11 domains (~1,800 tokens)
- **CLI is BACKUP**: 80+ commands for human use and fallback
- **src/core/ is CANONICAL**: All business logic lives here. Both MCP and CLI delegate to it.
- **Canonical operations reference**: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`
- **Verb standards**: `docs/specs/VERB-STANDARDS.md` (add, show, find, list, etc.)

## Build, Test, and Development Commands

### TypeScript Build & Test (Primary)

```bash
# Install dependencies
npm install

# Type-check without emitting
npx tsc --noEmit

# Build TypeScript to dist/
npm run build

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

### **CRITICAL: No Time Estimates**
**NEVER** estimate hours, days, or duration. Describe scope, complexity, and dependencies using relative sizing (small/medium/large) instead.

### **CRITICAL: CLI-Only Data Operations**
Never edit `.cleo/*.json` files directly. Always use CLI commands:
- `cleo add` not editing todo.json
- `cleo update` not manual JSON edits
- `cleo complete` not marking done in file

### **CRITICAL: Task Reference Format**
All commits must reference a task ID: `(T####)`
Example: `feat: add new validation (T1234)`

### **CRITICAL: Verb Standards**
All new operations MUST use canonical verbs per `docs/specs/VERB-STANDARDS.md`:
- `add` (not create), `show` (not get), `find` (not search/query)
- `restore` (not unarchive/reopen/uncancel), `start`/`stop` (not focus.set/focus.clear)

## Error Handling

**Exit Code Ranges:**
- `0` - Success
- `1-59` - General errors
- `60-67` - Protocol violations (research, consensus, spec, etc.)
- `68-70` - Validation/testing violations
- `75-79` - Lifecycle gate errors
- `80-84` - Verification gate codes
- `85-99` - Nexus codes
- `100+` - Special conditions (not errors)

**Error Response Pattern (TypeScript)**:
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

## Agent-Specific Notes

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
