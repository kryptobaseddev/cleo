# ADR-003: MCP Engine Unification

**Date**: 2026-02-16
**Status**: accepted
**Accepted**: 2026-02-16
**Related Tasks**: T4628, T4554
**Summary**: Eliminates CLEO's dual-engine architecture by unifying all MCP operations to delegate to src/core/ shared logic. The standalone mcp-server/ package was merged into src/mcp/, removing ~3,000 lines of duplicated engine code.
**Keywords**: mcp, engine, unification, shared-core, dual-engine, refactor
**Topics**: admin, orchestrate, tools

## Context

CLEO's MCP server originated as a separate package (`mcp-server/`) with its own engine layer (`mcp-server/src/engine/`) that reimplemented task CRUD, session management, validation, and research operations independently from the CLI's shared core (`src/core/`). This created a dual-engine architecture where the same logical operations had two independent TypeScript implementations with divergent behavior.

The architecture validation report (T4565/T4566) documented this split:

- **CLI layer**: 100% compliant with the shared-core pattern. Every CLI command imports from `src/core/` and delegates business logic there.
- **MCP layer**: 0% compliant with `src/core/`. MCP domains routed to either `mcp-server/src/engine/*.ts` (native mode) or shelled out to the Bash CLI via `../lib/executor.js` (CLI mode).

Specific duplications included independent implementations of task show/list/find, session start/end/status, research link/manifest operations, and validation logic. The MCP engine's `task-engine.ts`, `session-engine.ts`, and `research-engine.ts` each reimplemented logic already present in `src/core/tasks/`, `src/core/sessions/`, and `src/core/research/`.

## Decision

Consolidate all MCP operations into native TypeScript implementations within `src/mcp/engine/` that share the same `src/core/` and `src/store/` layers used by the CLI. Eliminate the CLI subprocess execution path entirely. The MCP engine files (`task-engine.ts`, `session-engine.ts`, `system-engine.ts`, etc.) now serve as thin adapters that translate MCP tool call parameters into `src/core/` function calls and format responses for the MCP protocol.

The consolidated architecture:

```
src/cli/commands/*.ts  -->  src/core/*  -->  src/store/*
                                ^
src/mcp/domains/*.ts   -->  src/mcp/engine/*.ts  -->  src/core/*  -->  src/store/*
```

Both interfaces now share a single execution path through `src/core/`.

## Consequences

### Positive

- Single source of truth for all business logic in `src/core/`
- Bug fixes and feature additions apply to both CLI and MCP simultaneously
- Zero Bash subprocess dependencies for MCP operations
- Consistent validation, error handling, and exit code semantics across interfaces
- Type-safe end-to-end from MCP tool schema to core function to store operation

### Negative

- MCP engine files still exist as an adapter layer (not eliminated, just simplified)
- Some MCP-specific formatting logic remains in engine files (translating core results to MCP response shapes)
- Migration from the old `mcp-server/` package required careful testing of all 37+ operations

### Neutral

- The old `mcp-server/` directory has been removed. `src/mcp/` is the sole MCP implementation
- MCP domain files (`src/mcp/domains/*.ts`) remain as the routing layer between MCP tool definitions and engine adapters

## References

- Architecture validation report: `claudedocs/agent-outputs/T4565-T4566-architecture-validation-report.md`
- MCP engine: `src/mcp/engine/`
- MCP domains: `src/mcp/domains/`
- Shared core: `src/core/`
- CLI commands: `src/cli/commands/`

---

## Post-Implementation Amendment (2026-02-27, ADR-020)

### Session Engine Unification Complete

The MCP session engine file `src/mcp/engine/session-engine.ts` (~1,060 lines) has been **deleted** in commit `ffe49957`. This file was the last significant duplicate engine that reimplemented session lifecycle logic independently from `src/core/sessions/`.

The dispatch layer engine `src/dispatch/engines/session-engine.ts` is now the **sole** session engine. It follows the pattern established by this ADR: a thin wrapper that delegates all business logic to `src/core/sessions/*` functions (handoff, briefing, cleanup, drift, stats, suspend, switch, history, show) and wraps results in `EngineResult` envelopes.

The data flow for session operations is now:

```
src/dispatch/domains/session.ts  -->  src/dispatch/engines/session-engine.ts  -->  src/core/sessions/*  -->  src/store/*
```

This completes the ADR-003 mandate for session engine unification. No MCP engine files contain session-specific business logic. The `src/mcp/engine/` directory may still contain other engine files (task, system, etc.) pending their own migration, but the session domain is fully consolidated.
