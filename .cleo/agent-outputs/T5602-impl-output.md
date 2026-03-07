# T5602 Implementation Output: release.cancel

**Status**: COMPLETE
**Task**: T5602
**Agent**: Claude Sonnet 4.6

---

## Functions Added

| File | Function | Line |
|------|----------|------|
| `src/core/release/release-manifest.ts` | `cancelRelease()` (exported) | ~763 |
| `src/dispatch/engines/release-engine.ts` | `releaseCancel()` (exported) | ~254 |
| `src/dispatch/domains/pipeline.ts` | `case 'cancel':` in `mutateRelease()` | ~495 |
| `src/dispatch/lib/engine.ts` | re-export of `releaseCancel` | ~262 |
| `src/cli/commands/release.ts` | `release cancel <version>` subcommand | ~94 |
| `src/core/release/__tests__/cancel-release.test.ts` | 8 tests for `cancelRelease()` | new file |

---

## State Check Logic

```typescript
// In cancelRelease() — src/core/release/release-manifest.ts
const cancellableStates = ['draft', 'prepared'] as const;

if (!(cancellableStates as readonly string[]).includes(status)) {
  return {
    success: false,
    message: `Cannot cancel a release in '${status}' state. Use 'release rollback' instead.`,
    version: normalizedVersion,
  };
}
```

**Cancellable states**: `draft`, `prepared` — row is deleted from `release_manifests`.
**Non-cancellable states**: `committed`, `tagged`, `pushed`, `rolled_back` — returns failure with hint to use `release rollback`.

---

## cancelRelease() Return Type

```typescript
Promise<{ success: boolean; message: string; version: string }>
```

- On success: `{ success: true, message: "Release vX.Y.Z cancelled and removed", version: "vX.Y.Z" }`
- On not found: `{ success: false, message: "Release vX.Y.Z not found", version: "vX.Y.Z" }`
- On wrong state: `{ success: false, message: "Cannot cancel a release in '...' state. Use 'release rollback' instead.", version: "vX.Y.Z" }`
- On empty version: throws `Error('version is required')`

---

## MCP Operation

**Operation string**: `release.cancel`
**Gateway**: `mutate`
**Domain**: `pipeline`
**Required param**: `version` (string)

Example MCP call:
```json
{ "operation": "release.cancel", "params": { "version": "1.2.3" } }
```

---

## CLI Subcommand Syntax

```
cleo release cancel <version>
```

Example:
```bash
cleo release cancel 2026.3.17
cleo release cancel v2026.3.17
```

The `<version>` argument accepts either bare (`1.2.3`) or v-prefixed (`v1.2.3`) — normalized internally.

---

## Edge Cases Handled

1. **Version normalization**: Both `1.2.3` and `v1.2.3` resolve to `v1.2.3` internally.
2. **Empty version**: throws `Error('version is required')` (consistent with other manifest functions).
3. **Non-existent release**: returns `{ success: false, ... }` (not throw), with "not found" in message.
4. **Wrong-state releases**: returns `{ success: false, ... }` with the actual current state name in the message and a hint to use `release rollback` instead.
5. **Isolation**: DELETE uses `WHERE version = ?` — does not affect other releases.
6. **Engine layer**: `releaseCancel()` maps `success: false` outcomes to `engineError('E_NOT_FOUND', ...)` or `engineError('E_INVALID_STATE', ...)` so MCP clients get structured error codes.

---

## tsc Result

```
npx tsc --noEmit
(no output — 0 errors)
```

---

## Test Results

```
vitest run src/core/release/__tests__/cancel-release.test.ts
  ✓ cancel-release.test.ts (8 tests) 225ms

Full suite:
  Test Files: 277 passed (277)
  Tests:      4335 passed (4335)
  Duration:   134.89s
```

### Tests Written

1. Cancels and removes a prepared release — verifies row deleted from DB
2. Accepts version with leading `v` prefix
3. Returns failure for a non-existent release
4. Rejects a `committed` release with helpful message referencing `rollback`
5. Rejects a `pushed` release with helpful message
6. Rejects a `tagged` release with helpful message
7. Throws on empty version string
8. Does not delete other releases when cancelling one (isolation check)
