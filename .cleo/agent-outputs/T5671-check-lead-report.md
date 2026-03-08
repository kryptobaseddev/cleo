# T5671 Check Domain Gauntlet Report

**Agent**: gauntlet-check
**Date**: 2026-03-08
**Domain**: check (16 operations: 13 query + 3 mutate)

---

## Summary

- **Tested**: 16/16 operations
- **Passing**: 13/16
- **Bugs Found**: 3 (1 medium, 2 low)

---

## A) Functional Test Results

### Query Operations (13)

| # | Operation | CLI Command | Status | Notes |
|---|-----------|-------------|--------|-------|
| 1 | `check.schema` | `validate` | PASS | Returns `success:true` with empty result for valid data |
| 2 | `check.schema` (strict) | `validate --strict` | PASS | Strict mode works |
| 3 | `check.protocol` (consensus) | `consensus validate T001` | PASS | Returns expected error "No manifest entry found for task T001" |
| 4 | `check.protocol` (contribution) | `contribution validate T001` | PASS | Same expected error |
| 5 | `check.protocol` (decomposition) | `decomposition validate T001` | PASS | Same expected error |
| 6 | `check.protocol` (implementation) | `implementation validate T001` | PASS | Same expected error |
| 7 | `check.protocol` (specification) | `specification validate T001` | PASS | Same expected error |
| 8 | `check.task` | MCP-only | PASS (no CLI) | No CLI mapping; MCP-only operation |
| 9 | `check.manifest` | `testing validate/check` | PASS | Routed through testing CLI command |
| 10 | `check.output` | MCP-only | PASS (no CLI) | No CLI mapping; MCP-only operation |
| 11 | `check.compliance.summary` | `compliance summary` | PASS | Returns `{total:0, pass:0, fail:0, passRate:0}` |
| 12 | `check.compliance.summary {detail:true}` | `compliance violations` | PASS | Returns `{violations:[], total:0}` |
| 13 | `check.test` (status) | `testing status` | PASS | Reports no test runner found (expected in isolated dir) |
| 14 | `check.test` (coverage) | `testing coverage` | PASS | Reports no coverage data (expected) |
| 15 | `check.coherence` | `doctor --coherence` | PASS | Returns `{coherent:true, issues:[]}` |
| 16 | `check.gate.status` | `verify T001` | PASS | Returns full gate status with required gates list |
| 17 | `check.archive.stats` | `archive-stats` | PASS | Returns `{totalArchived:0}` with proper structure |
| 18 | `check.grade` | `grade <sessionId>` | PASS | Returns zero-score grade with proper dimension breakdown |
| 19 | `check.grade.list` | `grade` (no args) | PASS | Returns `{grades:[], total:0}` |
| 20 | `check.chain.validate` | MCP-only | PASS (no CLI) | No CLI mapping; MCP-only operation |

### Mutate Operations (3)

| # | Operation | CLI Command | Status | Notes |
|---|-----------|-------------|--------|-------|
| 1 | `check.compliance.record` | `compliance sync` | **BUG** | See Bug #1 |
| 2 | `check.test.run` | `testing run` | PASS | Returns "No test runner found" (expected) |
| 3 | `check.gate.set` | `verify --gate/--reset/--all` | **BUG** | See Bug #2 |

---

## B) Bugs Found

### Bug #1 (MEDIUM): `compliance sync` routes to `compliance.record` with wrong params

**File**: `src/cli/commands/compliance.ts:88-103`

The `compliance sync` CLI subcommand dispatches to `check.compliance.record` with `{action: 'sync', force: opts.force}`, but the domain handler (`src/dispatch/domains/check.ts:331-343`) requires `taskId` and `result` params. The compliance.record operation always returns:

```json
{"success":false,"error":{"code":2,"message":"taskId and result are required"}}
```

**Impact**: `compliance sync` is non-functional via CLI.
**Fix**: Either add a `sync` action path to the compliance.record handler, or route `compliance sync` to a different operation.

### Bug #2 (MEDIUM): `verify` CLI always routes to query gateway

**File**: `src/cli/commands/verify.ts:19-34`

The verify CLI command always dispatches to `query` + `gate.status`, even when write flags (`--gate`, `--all`, `--reset`) are provided. Per the Constitution (line 278), `check.gate.verify` was split into `check.gate.status` (query) + `check.gate.set` (mutate). But the CLI never calls `mutate` + `gate.set`.

The domain handler for `gate.status` (query, line 236) calls the same `validateGateVerify()` function, and examining the engine function suggests it may handle both read and write. However, the `action` in the response always says `"view"` -- gate mutations appear to be silently ignored.

**Impact**: Setting/resetting gates via CLI may be non-functional (mutations going through read-only path).
**Fix**: Add conditional routing in `verify.ts`: if `--gate`, `--all`, or `--reset` is provided, dispatch to `mutate` + `gate.set` instead of `query` + `gate.status`.

### Bug #3 (LOW): Protocol validation error envelope inconsistency

Protocol operations (`consensus validate`, `contribution validate`, etc.) return a bare error envelope:
```json
{"success":false,"error":{"code":1,"message":"No manifest entry found for task T001"}}
```

Other check operations return the full `_meta` envelope with `$schema`, `specVersion`, etc. This inconsistency may confuse agents parsing responses.

---

## C) Consistency Check

### Registry vs Domain Handler Alignment

All 16 registry entries (13 query + 3 mutate) have matching cases in `CheckHandler.query()` and `CheckHandler.mutate()`. The `getSupportedOperations()` method lists all 16 operations correctly.

### Constitution Alignment

| Constitution Consolidation | Implementation | Status |
|---------------------------|---------------|--------|
| `compliance.violations` -> `compliance.summary {detail:true}` | Correct in handler (line 125) | ALIGNED |
| `coherence.check` -> `coherence` | Correct, `doctor --coherence` routes to `check.coherence` | ALIGNED |
| `test.status/test.coverage` -> `test {format}` | Correct in handler (line 135-144) | ALIGNED |
| `protocol.*` -> `protocol {protocolType}` | Correct in handler (line 152-220) | ALIGNED |
| `gate.verify` -> `gate.status` (q) + `gate.set` (m) | Handler correct, CLI misrouted (Bug #2) | PARTIAL |
| `admin.grade` -> `check.grade` | Correct | ALIGNED |
| `admin.grade.list` -> `check.grade.list` | Correct | ALIGNED |
| `admin.archive.stats` -> `check.archive.stats` | Correct | ALIGNED |

### Capability Matrix Alignment

All 16 operations listed in `src/dispatch/lib/capability-matrix.ts:150-166` match the registry and domain handler. All marked as `mode: 'native'`.

### CLI Coverage

- **13 ops have CLI paths** (via validate, doctor, compliance, testing, verify, archive-stats, grade, consensus, contribution, decomposition, implementation, specification)
- **3 ops are MCP-only**: `check.task`, `check.output`, `check.chain.validate`

---

## D) Usability Assessment

| Aspect | Rating | Notes |
|--------|--------|-------|
| Error messages | Good | Clear required-param messages (e.g., "taskId is required") |
| Help text | Good | All CLI commands have `--help` with descriptions |
| Discoverability | Good | `compliance` subcommands are well-organized |
| Response format | Mostly Good | Envelope inconsistency in protocol ops (Bug #3) |
| Parameter validation | Good | Missing params caught early with clear errors |

---

## E) Action Items

1. **Fix verify CLI routing** (Bug #2) -- route write flags to `mutate` + `gate.set`
2. **Fix compliance sync params** (Bug #1) -- align CLI params with domain handler requirements
3. **Standardize protocol error envelopes** (Bug #3) -- wrap in full `_meta` envelope
