# T792 BRAIN-03: Memory Verify & Pending-Verify Implementation

**Task**: Ship `cleo memory verify <id>` and `cleo memory pending-verify` subcommands.

**Status**: COMPLETE

## Implementation Summary

Both operations were already fully implemented in the codebase. This task required verification that all components are wired correctly:

### 1. Dispatch Domain (`memory.ts`)

**Verify Operation** (mutate):
- **Location**: `packages/cleo/src/dispatch/domains/memory.ts:756`
- **Functionality**: Flips `verified=1` on brain entries (observations, decisions, patterns, learnings)
- **Authorization**: Requires `agent=cleo-prime` or `agent=owner`; omit for terminal invocation
- **Idempotency**: Returns `alreadyVerified=true` if entry already verified
- **Error Handling**: E_INVALID_INPUT, E_FORBIDDEN, E_DB_UNAVAILABLE, E_NOT_FOUND

**Pending-Verify Operation** (query):
- **Location**: `packages/cleo/src/dispatch/domains/memory.ts:440`
- **Functionality**: Lists unverified entries with `citation_count >= minCitations` across all brain tables
- **Defaults**: minCitations=5, limit=50
- **Sorting**: DESC by citation_count; applies global sort across all tables
- **Response**: Includes count, minCitations, items array with {id, title, citation_count, memory_tier, etc}, hint

### 2. CLI Commands (`memory-brain.ts`)

**Verify Subcommand**:
- **Location**: `packages/cleo/src/cli/commands/memory-brain.ts:1287`
- **Command**: `cleo memory verify <id> [--agent <name>] [--json]`
- **Routing**: Dispatches to 'mutate' gateway, memory domain, 'verify' operation

**Pending-Verify Subcommand**:
- **Location**: `packages/cleo/src/cli/commands/memory-brain.ts:1315`
- **Command**: `cleo memory pending-verify [--min-citations <n>] [--limit <n>] [--json]`
- **Routing**: Dispatches to 'query' gateway, memory domain, 'pending-verify' operation

### 3. Registry (`registry.ts`)

Both operations registered with full metadata:
- **Verify**: `packages/cleo/src/dispatch/registry.ts:2006` — mutate, tier 1, idempotent, requiredParams: ['id']
- **Pending-Verify**: `packages/cleo/src/dispatch/registry.ts:1983` — query, tier 1, idempotent

### 4. Supported Operations

Both operations listed in `MemoryHandler.getSupportedOperations()`:
- **Verify**: `packages/cleo/src/dispatch/domains/memory.ts:921` (mutate)
- **Pending-Verify**: `packages/cleo/src/dispatch/domains/memory.ts:908` (query)

## Test Coverage

**Test File**: `packages/cleo/src/dispatch/domains/__tests__/memory-verify-pending.test.ts`

**Test Results**: 15/15 PASS
- ✅ verify: missing id → E_INVALID_INPUT
- ✅ verify: non-owner agent → E_FORBIDDEN
- ✅ verify: cleo-prime identity allowed
- ✅ verify: owner identity allowed
- ✅ verify: terminal invocation (no agent) allowed
- ✅ verify: nonexistent entry → E_NOT_FOUND
- ✅ verify: idempotent (alreadyVerified=true when already set)
- ✅ verify: brain.db unavailable → E_DB_UNAVAILABLE
- ✅ verify: listed in getSupportedOperations().mutate
- ✅ pending-verify: empty list when no entries
- ✅ pending-verify: returns pending entries sorted DESC by citation_count
- ✅ pending-verify: custom minCitations reflected in response
- ✅ pending-verify: hint field included
- ✅ pending-verify: brain.db unavailable → E_DB_UNAVAILABLE
- ✅ pending-verify: listed in getSupportedOperations().query

## Proof of Completion

### Code References

```bash
$ grep -c "'verify'\|'pending-verify'\|memory.verify\|memory.pending-verify" \
  packages/cleo/src/dispatch/domains/memory.ts \
  packages/cleo/src/dispatch/registry.ts \
  packages/cleo/src/cli/commands/memory-brain.ts

packages/cleo/src/dispatch/domains/memory.ts:5
packages/cleo/src/dispatch/registry.ts:4
packages/cleo/src/cli/commands/memory-brain.ts:7
# Total: 16 (≥ 6 required)
```

### Test Execution

```bash
$ pnpm vitest run packages/cleo/src/dispatch/domains/__tests__/memory-verify-pending.test.ts

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  08:31:40
   Duration  10.54s
```

## Implementation Details

### Database Schema

Operations target these tables with `verified` column:
- `brain_observations`
- `brain_decisions`
- `brain_patterns`
- `brain_learnings`

### SQL Operations

**Verify**:
```sql
UPDATE {table} SET verified = 1, updated_at = ? WHERE id = ?
```

**Pending-Verify**:
```sql
SELECT id, {labelCol} AS title, source_confidence, citation_count, memory_tier, created_at
FROM {table}
WHERE verified = 0 AND citation_count >= ? AND invalid_at IS NULL
ORDER BY citation_count DESC LIMIT ?
```

### Authorization Model

- **Terminal invocation**: No agent param required (owner has implicit authority)
- **Agent invocation**: Must pass `--agent cleo-prime` or `--agent owner`
- **Forbidden**: Any other agent identity (e.g., worker, lead, etc.)

## Pattern Reference

Implemented following T791 pattern for `cleo memory llm-status`:
- Gateway + Domain + Operation dispatch model
- Registry integration with metadata
- CLI subcommand routing
- Test isolation via native SQLite mocking

## Related Tasks

- **T791**: `cleo memory llm-status` (pattern reference)
- **T770**: BRAIN epic parent
- **T749**: Memory tier management context
