# ADR-004: TypeScript-First Architecture

**Date**: 2026-02-16
**Status**: accepted
**Accepted**: 2026-02-16
**Related Tasks**: T4628, T4554
**Summary**: Migrates CLEO from 185+ Bash shell scripts (133,000 lines) to a TypeScript-first architecture. All new functionality is implemented in TypeScript under src/. Bash scripts in scripts/ and lib/ are deprecated and pending removal.
**Keywords**: typescript, bash, migration, architecture, shared-core, esm, commander
**Topics**: admin, tools, naming

## Context

CLEO originated as a Bash-native CLI tool with 185+ shell scripts across `scripts/` (67 CLI commands) and `lib/` (96 shared libraries), totaling over 133,000 lines of code. While Bash provided rapid prototyping and direct filesystem access, the codebase accumulated significant complexity:

- **96 library files** with 1,425 functions across 9 semantic subdirectories
- **Session management** in a single 3,098-line file (`lib/sessions.sh`)
- **Migration system** at 2,884 lines (`lib/migrate.sh`)
- **No type safety**: Runtime errors from unquoted variables, missing arguments, and implicit type coercion
- **Platform issues**: Bash 4+ features unavailable on macOS default shell, GNU vs BSD tool differences
- **Testing friction**: BATS test framework with submodule dependencies and shell-specific mocking limitations
- **MCP impedance mismatch**: MCP server (TypeScript) had to shell out to Bash CLI or reimplement logic natively

The strategic roadmap (T2973) identified incremental TypeScript migration as a key decision, starting with the MCP server and expanding based on validation. The V2 TypeScript System epic (T4454) executed this migration across four waves:

- **Wave 0**: Foundation (project structure, build system, store layer, core modules)
- **Wave 1**: CLI commands ported to TypeScript (74 commands registered via Commander.js)
- **Wave 2**: MCP engine operations converted to native TypeScript
- **Wave 3**: Remaining commands, test infrastructure, documentation updates

## Decision

Port the entire CLEO system from Bash to TypeScript with a shared-core architecture where both the CLI (`src/cli/`) and MCP server (`src/mcp/`) delegate to common business logic in `src/core/` and data access in `src/store/`.

The resulting module structure:

```
src/
  cli/           # CLI entry point and 74 command registrations (Commander.js)
    commands/    # Thin command handlers: parse args -> call core -> format output
  core/          # Shared business logic (tasks, sessions, task-work, lifecycle, etc.)
  mcp/           # MCP server with domain routing and engine adapters
    domains/     # MCP tool definitions and routing
    engine/      # Adapters from MCP protocol to src/core/ functions
  store/         # Data access layer (JSON read/write, atomic operations, backup)
  types/         # Shared TypeScript type definitions
  validation/    # Schema validation and anti-hallucination checks
```

Technology choices:

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js >= 20 | ESM support, stable, cross-platform |
| Build | esbuild (via `build.mjs`) | Fast compilation, ESM output |
| CLI framework | Commander.js | Mature, type-safe argument parsing |
| Test framework | Vitest | Fast, ESM-native, TypeScript-first |
| Package format | ESM (`"type": "module"`) | Modern standard, tree-shakeable |

## Consequences

### Positive

- **Type safety**: Compile-time error detection eliminates entire classes of runtime bugs (unquoted variables, missing arguments, wrong types)
- **Cross-platform**: Node.js runs identically on Linux, macOS, and Windows without GNU/BSD tool differences
- **Single runtime**: Both CLI and MCP server share one Node.js process, eliminating subprocess overhead
- **Shared-core architecture**: CLI at 100% compliance with `src/core/` delegation pattern (verified by T4565/T4566 audit)
- **Modern tooling**: Vitest for testing, esbuild for builds, TypeScript language server for IDE support
- **NPM distribution**: Standard `npm install` replaces custom `install.sh` with symlink management

### Negative

- **Legacy Bash code removed**: `scripts/` and `lib/` directories have been emptied. The Bash-to-TypeScript migration is complete. (Originally these directories held 67 and 96 files respectively.)
- **BATS test migration**: Existing BATS test suite (`tests/unit/*.bats`, `tests/integration/*.bats`) must be migrated to Vitest
- **Build step required**: TypeScript must be compiled before execution (`npm run build`), adding a development step that Bash did not require
- **Node.js dependency**: Users must have Node.js >= 20 installed, whereas Bash was available on all Unix systems by default

### Neutral

- JSON Schema validation files (`schemas/*.schema.json`) remain unchanged and are consumed by both old Bash and new TypeScript code
- Data files (`.cleo/todo.json`, `.cleo/config.json`, etc.) are format-compatible across both implementations
- The `cleo` CLI binary is now `dist/cli/index.js` (Node.js) instead of `scripts/cleo` (Bash dispatcher)
- The old `mcp-server/` directory has been removed; `src/mcp/` is the sole MCP implementation

## References

- V2 TypeScript System epic: T4454
- Strategic roadmap: `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md`
- Architecture validation: `claudedocs/agent-outputs/T4565-T4566-architecture-validation-report.md`
- CLI entry point: `src/cli/index.ts`
- Core modules: `src/core/`
- Store layer: `src/store/`
- Build configuration: `build.mjs`, `tsconfig.json`
- Package definition: `package.json`
