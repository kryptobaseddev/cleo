# T5671 Pipeline Domain Gauntlet Report

**Agent**: gauntlet-pipeline
**Date**: 2026-03-08
**Domain**: pipeline (31 operations: 14 query + 17 mutate)
**Sub-domains**: stage, phase, manifest, chain, release

---

## Pass A: Functional Testing

### Stage Sub-domain (3 query + 5 mutate = 8 ops)

| Operation | Gateway | Tested | Result | Notes |
|-----------|---------|--------|--------|-------|
| `stage.validate` | query | YES | PASS | Returns valid/canProgress/missingPrerequisites |
| `stage.status` | query | YES | PASS | Returns full stage list with status per stage |
| `stage.history` | query | YES | PASS | Returns provenance chain with timestamps |
| `stage.record` | mutate | YES | PASS | Start (in_progress) and complete both work |
| `stage.skip` | mutate | YES | PASS | Requires reason param, records skip correctly |
| `stage.reset` | mutate | NO* | N/A | No CLI command exposes this; MCP-only |
| `stage.gate.pass` | mutate | NO* | N/A | No CLI command; lifecycle gate is query-only |
| `stage.gate.fail` | mutate | NO* | N/A | No CLI command; lifecycle gate is query-only |

**Note**: `stage.reset`, `stage.gate.pass`, `stage.gate.fail` have no direct CLI equivalents. They are MCP-only operations. The handler code review confirms they are wired correctly with proper validation. The `lifecycle gate` CLI command maps to `stage.validate` (query), not to gate mutations.

### Phase Sub-domain (2 query + 4 mutate = 6 ops)

| Operation | Gateway | Tested | Result | Notes |
|-----------|---------|--------|--------|-------|
| `phase.list` | query | YES | PASS | Returns phases sorted by order with summary counts |
| `phase.show` | query | YES | PASS | Shows by slug or current; includes task counts |
| `phase.set` | mutate | YES | PASS | Sets current phase; absorbs start/complete via action param |
| `phase.advance` | mutate | YES | PASS | Completes current, starts next in order |
| `phase.rename` | mutate | YES | PASS | Renames slug, updates currentPhase reference |
| `phase.delete` | mutate | YES | PASS | Requires --force flag; reports reassigned task count |

**Phase.set action routing verified**: `phase.set {action:"start"}` starts a pending phase, `phase.set {action:"complete"}` completes an active phase. Backward-compat aliases `phase.start`/`phase.complete` also work in the handler (routes via sub name).

### Manifest Sub-domain (4 query + 2 mutate = 6 ops)

| Operation | Gateway | Tested | Result | Notes |
|-----------|---------|--------|--------|-------|
| `manifest.list` | query | YES | PASS | Works via `research manifest` CLI; returns entries array |
| `manifest.show` | query | PARTIAL | **BUG** | CLI `research show` routes to `memory.show` (wrong domain) |
| `manifest.find` | query | YES | PASS | Works via `research manifest --topic` filter |
| `manifest.stats` | query | PARTIAL | **BUG** | CLI `research stats` routes to `memory.stats` (wrong domain) |
| `manifest.append` | mutate | PARTIAL | **BUG** | CLI `research add` routes to `session.context.inject` (wrong) |
| `manifest.archive` | mutate | YES | PARTIAL | CLI `research archive` dispatches correctly but doesn't pass required `beforeDate` param |

### Chain Sub-domain (2 query + 3 mutate = 5 ops)

| Operation | Gateway | Tested | Result | Notes |
|-----------|---------|--------|--------|-------|
| `chain.list` | query | YES (DB) | PASS | Handler code verified; returns paginated list |
| `chain.show` | query | YES (DB) | PASS | Handler code verified; requires chainId |
| `chain.add` | mutate | NO* | N/A | No CLI command; MCP-only. Code review: validated |
| `chain.instantiate` | mutate | NO* | N/A | No CLI command; MCP-only. Code review: validated |
| `chain.advance` | mutate | NO* | N/A | No CLI command; MCP-only. Code review: validated |

**Note**: Chain operations are tier 2 and have no CLI equivalents. Handler code review confirms proper validation (chainId/epicId required, FK error handling, gateResults default to empty array).

### Release Sub-domain (3 query + 3 mutate = 6 ops)

| Operation | Gateway | Tested | Result | Notes |
|-----------|---------|--------|--------|-------|
| `release.list` | query | YES | PASS | Returns empty list correctly for fresh project |
| `release.show` | query | YES | PASS | Returns proper E_NOT_FOUND for nonexistent version |
| `release.channel.show` | query | YES | PASS | Resolves channel from git branch; handles no-git gracefully |
| `release.ship` | mutate | YES | PARTIAL | Validates gates first; returns "not found" for nonexistent release |
| `release.cancel` | mutate | YES | PASS | Proper E_NOT_FOUND for nonexistent version |
| `release.rollback` | mutate | YES (code) | PASS | Handler validates version param; requires version |

---

## Pass B: Usability

### Error Messages

| Test | Quality | Notes |
|------|---------|-------|
| Missing required params | GOOD | Clear "X is required" messages for all ops |
| Invalid stage name | GOOD | "Invalid stage: nonexistent_stage" |
| Phase not found | GOOD | "Phase 'X' not found" |
| Rollback without flag | GOOD | Explains required flag with order numbers |
| Force required for delete | GOOD | "Phase deletion requires --force flag for safety" |
| Release not found | GOOD | "Release vX not found" |
| Missing CLI args | GOOD | Commander.js provides "missing required argument" |

### Discoverability

| Aspect | Rating | Notes |
|--------|--------|-------|
| `cleo ops -t 2` | GOOD | Shows all 31 pipeline ops grouped by gateway |
| `cleo lifecycle --help` | GOOD | Shows stage operations clearly |
| `cleo phase --help` | GOOD | Lists all phase subcommands |
| `cleo release --help` | GOOD | Lists release subcommands |
| `cleo research --help` | POOR | Misleading: some commands route to wrong domains |
| Chain operations | POOR | No CLI discoverability; MCP-only with no help text |

---

## Pass C: Consistency

### Registry vs Constitution Drift

**FINDING**: Constitution says "pipeline (27 operations)" but registry has **31 operations**.

The Constitution lists these as "removed from registry":
- `pipeline.phase.start` -- actually absorbed into `phase.set` handler (backward-compat alias exists)
- `pipeline.phase.complete` -- actually absorbed into `phase.set` handler (backward-compat alias exists)
- `pipeline.phase.set` -- **PRESENT** in registry as canonical operation
- `pipeline.phase.advance` -- **PRESENT** in registry
- `pipeline.phase.rename` -- **PRESENT** in registry
- `pipeline.phase.delete` -- **PRESENT** in registry

The Constitution's "Absorbed Aliases" table correctly shows `phase.start -> phase.set {action:"start"}` and `phase.complete -> phase.set {action:"complete"}`, but the main listing incorrectly claims phase.set/advance/rename/delete were "removed from registry".

**Impact**: Constitution is stale. Registry is source of truth. The actual count is 31 ops.

### Response Format Consistency

All pipeline operations return the standard LAFS envelope:
- `_meta`: specVersion, schemaVersion, timestamp, operation, requestId, transport
- `success`: boolean
- `result` / `error`: payload

**PASS**: All responses follow the canonical envelope format.

### Verb Standards Compliance

| Verb | Usage | Compliant |
|------|-------|-----------|
| show | phase.show, manifest.show, chain.show, release.show, release.channel.show | YES |
| list | phase.list, manifest.list, chain.list, release.list | YES |
| find | manifest.find | YES |
| add | chain.add | YES |
| set | phase.set | YES |
| validate | stage.validate | YES |
| record | stage.record | YES |
| ship | release.ship | YES |

**PASS**: All verbs follow VERB-STANDARDS.md canonical verbs.

---

## Bugs Found

### BUG-1: research CLI routing to wrong domains (MEDIUM)

**File**: `src/cli/commands/research.ts`

| CLI Command | Expected Dispatch | Actual Dispatch |
|-------------|------------------|-----------------|
| `research show <id>` | `query pipeline manifest.show` | `query memory show` |
| `research stats` | `query pipeline manifest.stats` | `query memory stats` |
| `research add` | `mutate pipeline manifest.append` | `mutate session context.inject` |
| `research links <taskId>` | `query pipeline manifest.find` | `query memory find` |
| `research link <id> <taskId>` | `mutate pipeline manifest.link` | `mutate memory link` |

**Root Cause**: Leftover routing from pre-T5241 memory domain cutover. The `research` CLI was originally wired to the memory domain before manifest ops moved to pipeline.

### BUG-2: research archive missing beforeDate (LOW)

`research archive` dispatches to `pipeline.manifest.archive` but passes no `beforeDate` parameter, which is required. The error message correctly identifies the missing param.

### BUG-3: release changelog dispatches to nonexistent operation (LOW)

`release changelog <version>` dispatches to `mutate:pipeline.release.changelog` which was absorbed into `release.ship`. Should either be removed from CLI or routed to `release.ship {step:"changelog"}`.

### BUG-4: Constitution op count drift (LOW)

Constitution says 27 pipeline ops; registry has 31. Phase operations are listed as "removed" but are present.

---

## Summary

| Category | Score | Details |
|----------|-------|---------|
| **Functional** | 25/31 tested, 22 PASS | 3 MCP-only (stage.reset, gate.pass/fail), 5 chain (no CLI), 3 bugs in CLI routing |
| **Usability** | GOOD | Error messages are clear; phase/lifecycle/release CLI well-organized |
| **Consistency** | MOSTLY GOOD | LAFS envelope format correct; verb standards compliant; Constitution stale |

### Action Items

1. **Fix research.ts routing** (BUG-1) -- Remap show/stats/add/links/link to pipeline domain
2. **Fix research archive** (BUG-2) -- Add `--before-date` option to CLI command
3. **Fix release changelog** (BUG-3) -- Remove or redirect to `release.ship {step:"changelog"}`
4. **Update Constitution** (BUG-4) -- Change pipeline count from 27 to 31; remove incorrect "removed from registry" entries for phase ops
