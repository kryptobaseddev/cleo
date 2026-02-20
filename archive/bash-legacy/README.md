# CLEO Bash Legacy Code (DEPRECATED)

**Archived**: 2026-02-20
**Reason**: Complete migration to TypeScript (src/)

This directory contains the deprecated Bash-based implementation preserved for reference only.

## Contents

- `scripts/` — 79 Bash CLI scripts (the original `cleo` commands)
- `lib/` — 12 library subdirectories with 106+ Bash modules
- `tests/` — BATS test suite (unit, edge-cases, migration, functional)

## Status

**DEPRECATED**: No longer maintained. All business logic has been migrated to TypeScript.

## Do Not Use

Use the TypeScript implementation instead:

```bash
# TypeScript CLI (current)
cleo add "Task"
cleo list
cleo show T123

# MCP (primary interface for agents)
cleo_query { domain: "tasks", operation: "show", params: { taskId: "T123" } }
```

## Migration Reference

- Cross-walk analysis: `archive/migration/cross-walk-analysis.md`
- Migration summary: `archive/migration/MIGRATION-SUMMARY.md`
- Action plan: `archive/migration/ACTION-PLAN.md`

## Architecture

The TypeScript system that replaced this code:

```
src/core/          — Shared business logic (canonical)
src/cli/commands/  — CLI handlers (thin wrappers around core)
src/mcp/domains/   — MCP domain handlers (thin wrappers around core)
src/mcp/engine/    — MCP-to-core adapters
src/store/         — Data access layer
```
