# T5671 Gauntlet Report: Orchestrate Domain

**Agent**: gauntlet-ota
**Date**: 2026-03-08
**Version**: 2026.3.24

## Registry Operations (from ops --tier 2)

| Gateway | Operations |
|---------|-----------|
| query (9) | status, next, ready, analyze, context, waves, bootstrap, unblock.opportunities, tessera.list |
| mutate (7) | start, spawn, handoff, spawn.execute, validate, parallel, tessera.instantiate |
| **Total** | **16 operations** |

## A) Functional Testing

### CLI-Exposed Operations (7/16)

| Operation | CLI Command | Result | Notes |
|-----------|------------|--------|-------|
| orchestrate.analyze | `orchestrate analyze T002` | PASS | Returns waves, dependency graph, circular dep check |
| orchestrate.ready | `orchestrate ready T002` | PASS | Returns ready tasks with depends array |
| orchestrate.next | `orchestrate next T002` | PASS | Returns nextTask + alternatives + totalReady |
| orchestrate.context | `orchestrate context T002` | PASS | Returns token budget, limits, recommendation |
| orchestrate.spawn | `orchestrate spawn T003` | PASS | Returns spawnContext, protocolType, tokenResolution |
| orchestrate.start | `orchestrate start T002` | PASS | Returns initialized=true, summary, firstWave |
| orchestrate.validate | `orchestrate validate T003` | PASS | Returns ready=true, issues=[] |

### MCP-Only Operations (9/16 - no CLI subcommand)

| Operation | CLI Availability | Notes |
|-----------|-----------------|-------|
| orchestrate.status | NOT exposed | Not in `orchestrate --help` |
| orchestrate.waves | NOT exposed | Not in `orchestrate --help` |
| orchestrate.bootstrap | NOT exposed | Not in `orchestrate --help` |
| orchestrate.unblock.opportunities | NOT exposed | Not in `orchestrate --help` |
| orchestrate.handoff | NOT exposed | Mutate, MCP-only |
| orchestrate.spawn.execute | NOT exposed | Mutate, MCP-only |
| orchestrate.parallel | NOT exposed | Mutate, MCP-only |
| orchestrate.tessera.list | NOT exposed | Query, MCP-only |
| orchestrate.tessera.instantiate | NOT exposed | Mutate, MCP-only |

### Error Handling

| Scenario | Result | Error Message |
|----------|--------|---------------|
| Invalid task ID (TXYZ) | PASS | `"Invalid task ID format: TXYZ"` (code 6) |
| Missing required arg | PASS | Commander.js shows usage |

## B) Usability

- **Help discoverability**: `orchestrate --help` shows 7 of 16 ops clearly
- **Error messages**: Clear, structured JSON with error code and message
- **Output format**: Consistent envelope with `_meta.operation` = `orchestrate.*`
- **Human format**: Not tested (orchestrate ops are primarily agent-facing)

## C) Consistency

- **Operation names match Constitution**: YES - ops --tier 2 shows all 16 registered
- **Response format**: All responses use standard envelope (`success`, `result`, `_meta`)
- **CLI coverage gap**: 9 of 16 operations are MCP-only (56%). This is expected for orchestration which is primarily an MCP/agent workflow domain.

## Issues Found

| # | Severity | Description |
|---|----------|-------------|
| 1 | INFO | 9/16 ops MCP-only - expected for agent-first domain |
| 2 | LOW | `orchestrate.waves` listed in registry but not exposed as CLI subcommand despite being a useful visualization op |

## Summary

**PASS** - All 7 CLI-exposed operations work correctly. Error handling is proper. The MCP-only gap is by design (orchestration is agent-facing). Response envelopes are consistent.
