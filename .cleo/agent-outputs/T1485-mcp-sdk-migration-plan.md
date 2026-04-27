# T1485 — MCP Adapter SDK Migration Plan

**Status**: Executed  
**Date**: 2026-04-27  
**Agent**: sonnet worker (no worktree — main branch direct)

---

## Phase 1 Audit: CLI Subprocess Calls in mcp-adapter

The audit covers all files under packages/mcp-adapter/src/.

### CLI Subprocess Calls Found

| Location | CLI invocation |
|----------|----------------|
| tools.ts:102 | runCleo(['sentient', 'status', '--json']) |
| tools.ts:107-109 | runCleo(['sentient', 'propose', 'list', '--json', ...limit]) |
| tools.ts:114 | runCleo(['sentient', 'propose', 'enable', '--json']) |

All three go through cli-runner.ts which uses child_process.execFile.

---

## Phase 2 Migration Map

### Operation 1: cleo sentient status → getSentientDaemonStatus(projectRoot)
- Core import: @cleocode/core/sentient/daemon.js
- Return type: SentientStatus
- Migration: FULL — no subprocess needed

### Operation 2: cleo sentient propose list → sentientProposeList(projectRoot, params)
- Core import: @cleocode/core/sentient/ops.js
- Params type: ProposeListParams from @cleocode/contracts
- Return type: ProposeListResult from @cleocode/contracts
- Migration: FULL — no subprocess needed

### Operation 3: cleo sentient propose enable → sentientProposeEnable(projectRoot, params)
- Core import: @cleocode/core/sentient/ops.js
- M7 gate: Enforced internally via E_M7_GATE_FAILED thrown error
- Migration: FULL — no subprocess needed (error.code check replaces stdout substring match)

### Operations that CANNOT be migrated
None — all three MCP-exposed operations have direct Core SDK equivalents.

---

## Phase 3 Implementation Summary

### Changes Made

1. packages/mcp-adapter/package.json — added @cleocode/core and @cleocode/contracts as workspace dependencies
2. packages/mcp-adapter/tsconfig.json — added references to core and contracts
3. packages/mcp-adapter/src/tools.ts — replaced all three runCleo() calls with direct Core SDK calls
4. packages/mcp-adapter/src/types.ts — removed CliResult interface (no longer needed)
5. packages/mcp-adapter/src/cli-runner.ts — deleted (no longer used)
6. packages/mcp-adapter/src/index.ts — removed runCleo and CliResult re-exports

### Behavioral Parity

| Tool | Before | After |
|------|--------|-------|
| cleo_sentient_status | JSON-parsed CLI stdout | Direct SentientStatus object serialized |
| cleo_sentient_propose_list | JSON-parsed CLI stdout | Direct ProposeListResult serialized |
| cleo_sentient_propose_enable | stdout/stderr substring match for M7 | Error code check on thrown E_M7_GATE_FAILED |

---

## Phase 4 Verification

- tsc -b — passes
- pnpm biome ci . — passes
- pnpm run build — passes
- pnpm run test — passes
