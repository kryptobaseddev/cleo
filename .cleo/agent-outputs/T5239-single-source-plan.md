# T5239: Single Source of Truth — Operations Architecture Plan

## Problem Statement

Operations are currently defined in THREE independent places:

1. **`src/dispatch/registry.ts`** — `OPERATIONS` array (185 `OperationDef` entries with full metadata)
2. **`src/mcp/gateways/query.ts`** — `QUERY_OPERATIONS` dict (domain -> operation-name-list)
3. **`src/mcp/gateways/mutate.ts`** — `MUTATE_OPERATIONS` dict (domain -> operation-name-list)

The gateway files maintain their own independent copies of the operation lists, including both canonical domain entries AND legacy alias domain entries. This causes **drift** — operations added to the registry can be missed in the gateways (19+ operations were recently found missing from exactly this drift).

A sync test (`registry-gateway-sync.test.ts`) exists that catches drift, but it only checks canonical domains. The real fix is to eliminate the duplication.

## Current Architecture

### Registry (`src/dispatch/registry.ts`)

- `OPERATIONS: OperationDef[]` — flat array of 185 entries
- Each entry has: `gateway`, `domain` (canonical only), `operation`, `description`, `tier`, `idempotent`, `sessionRequired`, `requiredParams`, optional `params`
- Helper functions: `resolve()`, `getByDomain()`, `getByGateway()`, `getByTier()`, `getActiveDomains()`, `getCounts()`
- **Only uses canonical domains** (10): tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sharing

### Gateways (`query.ts` / `mutate.ts`)

- `QUERY_OPERATIONS` / `MUTATE_OPERATIONS`: `Record<string, string[]>` — domain -> list of operation names
- Contains **both canonical and legacy** domain entries (17 query domains, 18 mutate domains)
- Legacy aliases: research, lifecycle, validate, release, system, issues, skills, providers
- Used by:
  - `validateQueryParams()` / `validateMutateParams()` — validates domain + operation exist
  - `registerQueryTool()` / `registerMutateTool()` — builds MCP tool schema with `enum` of domain names
  - Helper functions: `getQueryOperationCount()`, `isQueryOperation()`, `getQueryDomains()`, `getQueryOperations()` (and mutate equivalents)
  - Parameter-specific validation functions (e.g., `validateTasksParams()`)

### MCP Adapter (`src/dispatch/adapters/mcp.ts`)

- `resolveDomainAlias()` — maps legacy domain names to canonical domains with operation prefix rewriting:
  - `research` -> `memory` (operations unchanged)
  - `validate` -> `check` (operations unchanged)
  - `lifecycle` -> `pipeline` (operations prefixed with `stage.`)
  - `release` -> `pipeline` (operations prefixed with `release.`)
  - `skills` -> `tools` (operations prefixed with `skill.`)
  - `providers` -> `tools` (operations prefixed with `provider.`)
  - `issues`/`issue` -> `tools` (operations prefixed with `issue.`)
  - `system` -> `admin` (operations unchanged)

### MCP Server (`src/mcp/index.ts`)

- Calls `registerQueryTool()` and `registerMutateTool()` for the `ListToolsRequestSchema` handler
- Routes all `CallToolRequestSchema` requests through `handleMcpToolCall()` in the MCP adapter

## Proposed Architecture

### 1. Add Derivation Functions to `src/dispatch/registry.ts`

Add new functions that derive the gateway operation matrices from the `OPERATIONS` array:

```typescript
/**
 * Legacy domain alias mapping.
 *
 * Maps legacy MCP domain names to their canonical domain + operation prefix.
 * Used to generate backward-compatible gateway operation matrices.
 *
 * When a legacy domain has a prefix, the canonical operation name is expected
 * to start with that prefix (e.g., `skill.list` in canonical `tools` domain
 * maps to `list` in legacy `skills` domain).
 */
export const LEGACY_DOMAIN_ALIASES: Record<string, { canonical: CanonicalDomain; prefix: string }> = {
  research:  { canonical: 'memory',   prefix: '' },
  validate:  { canonical: 'check',    prefix: '' },
  lifecycle: { canonical: 'pipeline', prefix: 'stage.' },
  release:   { canonical: 'pipeline', prefix: 'release.' },
  system:    { canonical: 'admin',    prefix: '' },
  skills:    { canonical: 'tools',    prefix: 'skill.' },
  providers: { canonical: 'tools',    prefix: 'provider.' },
  issues:    { canonical: 'tools',    prefix: 'issue.' },
};

/**
 * Derive a gateway operation matrix from the registry.
 *
 * Returns `Record<string, string[]>` containing:
 * - All 10 canonical domains with their operations
 * - All legacy alias domains with reverse-mapped operation names
 *
 * This is the SINGLE derivation point — gateways should use this instead
 * of maintaining independent operation lists.
 */
export function deriveGatewayMatrix(gateway: Gateway): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};

  // Step 1: Populate canonical domains from the OPERATIONS array
  for (const op of OPERATIONS) {
    if (op.gateway !== gateway) continue;
    if (!matrix[op.domain]) matrix[op.domain] = [];
    matrix[op.domain].push(op.operation);
  }

  // Step 2: Populate legacy alias domains by reverse-mapping
  for (const [alias, { canonical, prefix }] of Object.entries(LEGACY_DOMAIN_ALIASES)) {
    const canonicalOps = matrix[canonical];
    if (!canonicalOps) continue;

    const legacyOps: string[] = [];
    for (const op of canonicalOps) {
      if (prefix) {
        // Only include operations that start with the prefix
        if (op.startsWith(prefix)) {
          legacyOps.push(op.slice(prefix.length));
        }
      } else {
        // No prefix — all operations map directly
        legacyOps.push(op);
      }
    }
    if (legacyOps.length > 0) {
      matrix[alias] = legacyOps;
    }
  }

  return matrix;
}

/**
 * Get all accepted domain names for a gateway (canonical + legacy aliases).
 */
export function getGatewayDomains(gateway: Gateway): string[] {
  return Object.keys(deriveGatewayMatrix(gateway));
}
```

### 2. Modify Gateway Files to Derive from Registry

**`src/mcp/gateways/query.ts`**:

```typescript
import { deriveGatewayMatrix, LEGACY_DOMAIN_ALIASES } from '../../dispatch/registry.js';

// DERIVED from registry — single source of truth
export const QUERY_OPERATIONS: Record<string, string[]> = deriveGatewayMatrix('query');
```

Delete the entire hand-maintained `QUERY_OPERATIONS` object literal (lines 91-297). Replace with one line.

**`src/mcp/gateways/mutate.ts`**:

```typescript
import { deriveGatewayMatrix, LEGACY_DOMAIN_ALIASES } from '../../dispatch/registry.js';

// DERIVED from registry — single source of truth
export const MUTATE_OPERATIONS: Record<string, string[]> = deriveGatewayMatrix('mutate');
```

Delete the entire hand-maintained `MUTATE_OPERATIONS` object literal (lines 91-277). Replace with one line.

### 3. Backward-Compatible Operation Aliases

Some legacy domains have operations that don't follow the prefix convention. These need explicit handling:

- `admin.config.get` — alias for `admin.config.show` (already handled by `resolveOperationAlias` in the MCP adapter)
- `tools.issue.create.*` — aliases for `tools.issue.add.*` (already handled by `resolveOperationAlias` in the MCP adapter)

For the gateway operation matrix, these backward-compat aliases must ALSO appear so that validation passes. Two approaches:

**Option A (Recommended)**: Add an optional `aliases` field to `OperationDef`:
```typescript
export interface OperationDef {
  // ... existing fields ...
  /** Backward-compatible operation aliases (e.g., 'config.get' for 'config.show'). */
  aliases?: string[];
}
```

Then `deriveGatewayMatrix()` includes both the canonical name and all aliases in the matrix.

**Option B**: Keep aliases as explicit entries in the `OPERATIONS` array with a `deprecated: true` flag. More verbose but self-documenting.

**Recommendation**: Option A is cleaner. The `resolveOperationAlias()` function in the MCP adapter already handles runtime translation. The `aliases` field just ensures validation doesn't reject the alias names at the gateway level.

### 4. How Legacy Alias Mapping Works

The `LEGACY_DOMAIN_ALIASES` map defined in the registry replaces the implicit knowledge currently split between:
- The gateway files (which manually duplicate operations under alias domains)
- The MCP adapter's `resolveDomainAlias()` function

The MCP adapter's `resolveDomainAlias()` function should be **refactored to use `LEGACY_DOMAIN_ALIASES`** from the registry instead of its own hardcoded switch statement:

```typescript
import { LEGACY_DOMAIN_ALIASES } from '../registry.js';

function resolveDomainAlias(domain: string, operation: string): { domain: string; operation: string } {
  const alias = LEGACY_DOMAIN_ALIASES[domain];
  if (!alias) return { domain, operation };
  return {
    domain: alias.canonical,
    operation: alias.prefix ? `${alias.prefix}${operation}` : operation,
  };
}
```

This ensures the alias mapping is defined in ONE place and consumed by both the gateway derivation AND the runtime resolution.

### 5. Special Case: `release` Legacy Domain (Mutate Only)

The `release` legacy domain only appears in `MUTATE_OPERATIONS`, not `QUERY_OPERATIONS`. The `deriveGatewayMatrix()` function handles this naturally — if no canonical operations match the prefix for a given gateway, the legacy domain simply won't appear in that gateway's matrix.

Similarly, some legacy domains might have additional operations in their gateway entries that don't exist in the canonical form (e.g., `system` domain in mutate has `inject.generate` but admin has it too). The prefix-based derivation handles this correctly since it's a direct canonical->legacy reverse mapping.

### 6. Parameter Validation Functions (No Change Needed)

The parameter validation functions in `mutate.ts` (`validateTasksParams`, `validateSessionParams`, etc.) are **not affected** by this change. They validate the _content_ of parameters, not which operations exist. They remain in the gateway file and continue to be called by `validateMutateParams()`.

The only change to `validateMutateParams()` and `validateQueryParams()` is that the operation matrix they check against (`MUTATE_OPERATIONS` / `QUERY_OPERATIONS`) is now derived rather than hand-maintained. The validation logic itself is unchanged.

### 7. `IDEMPOTENT_OPERATIONS` and `SESSION_REQUIRED_OPERATIONS` in mutate.ts

These are currently small hardcoded dicts in `mutate.ts`. They could be derived from the registry's `idempotent` and `sessionRequired` fields on `OperationDef`. However, this is a **separate concern** and can be addressed later. For the initial implementation, leave them as-is.

**Future improvement**: Delete these dicts and derive from registry:
```typescript
export function isIdempotentOperation(domain: string, operation: string): boolean {
  const def = resolve('mutate', domain, operation);
  return def?.def.idempotent ?? false;
}
```

## Backward Compatibility Concerns

### 1. Export Stability

`QUERY_OPERATIONS` and `MUTATE_OPERATIONS` must remain exported with the same names and types (`Record<string, string[]>`). The change is purely in how they're populated — from a hand-written literal to a derived call.

### 2. Domain Order in MCP Tool Schema

The `enum` list in the MCP tool schema (from `registerQueryTool()` / `registerMutateTool()`) will change order because `deriveGatewayMatrix()` iterates the `OPERATIONS` array in definition order for canonical domains, then appends legacy aliases. This is cosmetic — MCP clients don't depend on enum ordering.

### 3. Legacy Alias Coverage

The derived legacy alias domains must contain the same operations as the current hand-maintained lists. A migration test should verify this (see testing section).

### 4. Runtime Behavior

No runtime behavior changes. The MCP adapter already resolves legacy aliases to canonical domains before dispatching. The gateway validation already allows both canonical and legacy domains. The only change is that the validation matrices are computed rather than hand-written.

## Testing Strategy

### 1. Remove `registry-gateway-sync.test.ts`

This test exists solely to detect drift between the registry and gateways. After this change, drift is structurally impossible — the gateways derive from the registry. Delete this test.

### 2. Add `registry-derivation.test.ts`

New test file that validates the derivation logic:

```typescript
describe('deriveGatewayMatrix', () => {
  it('produces correct canonical domain entries', () => {
    const matrix = deriveGatewayMatrix('query');
    expect(matrix.tasks).toContain('show');
    expect(matrix.tasks).toContain('find');
    expect(matrix.session).toContain('status');
    // etc.
  });

  it('produces correct legacy alias entries', () => {
    const matrix = deriveGatewayMatrix('query');
    // research is an alias for memory (no prefix)
    expect(matrix.research).toEqual(matrix.memory);
    // skills is an alias for tools with skill. prefix stripped
    expect(matrix.skills).toContain('list');
    expect(matrix.skills).toContain('show');
    // lifecycle is an alias for pipeline with stage. prefix stripped
    expect(matrix.lifecycle).toContain('validate');
    expect(matrix.lifecycle).toContain('status');
  });

  it('legacy alias domains do not appear for gateways with no matching ops', () => {
    const queryMatrix = deriveGatewayMatrix('query');
    // release has no query operations (only mutate)
    expect(queryMatrix.release).toBeUndefined();
  });

  it('total canonical operation count matches OPERATIONS array', () => {
    const qMatrix = deriveGatewayMatrix('query');
    const mMatrix = deriveGatewayMatrix('mutate');
    const CANONICAL = new Set(['tasks', 'session', 'memory', 'check', 'pipeline',
      'orchestrate', 'tools', 'admin', 'nexus', 'sharing']);
    const qTotal = Object.entries(qMatrix)
      .filter(([d]) => CANONICAL.has(d))
      .reduce((sum, [, ops]) => sum + ops.length, 0);
    const mTotal = Object.entries(mMatrix)
      .filter(([d]) => CANONICAL.has(d))
      .reduce((sum, [, ops]) => sum + ops.length, 0);
    expect(qTotal + mTotal).toBe(OPERATIONS.length);
  });
});
```

### 3. Update Existing Gateway Tests

- `src/mcp/gateways/__tests__/query.test.ts` — update domain count expectations if they change (currently expects 17 query domains). The derived matrix might have slightly different counts if some legacy aliases had operations not present in the canonical domain (unlikely but possible).
- `src/mcp/gateways/__tests__/mutate.test.ts` — same treatment for mutate (currently expects 18 mutate domains).

### 4. Snapshot Test (Optional)

Add a snapshot test that captures the derived matrix output. This makes it easy to spot unintended changes when operations are added/removed from the registry.

## Implementation Steps (for Phase C agent)

1. **Add `LEGACY_DOMAIN_ALIASES` and `deriveGatewayMatrix()` to `src/dispatch/registry.ts`**
2. **Add optional `aliases?: string[]` field to `OperationDef` interface**
3. **Add alias entries to relevant operations** (e.g., `config.show` gets `aliases: ['config.get']`, `issue.add.bug` gets `aliases: ['issue.create.bug']`)
4. **Replace `QUERY_OPERATIONS` literal with `deriveGatewayMatrix('query')` call**
5. **Replace `MUTATE_OPERATIONS` literal with `deriveGatewayMatrix('mutate')` call**
6. **Refactor `resolveDomainAlias()` in MCP adapter to use `LEGACY_DOMAIN_ALIASES`**
7. **Delete `registry-gateway-sync.test.ts`**
8. **Add `registry-derivation.test.ts`**
9. **Update gateway test expectations** for domain counts
10. **Run full test suite** to verify no regressions

## Risk Assessment

- **Risk**: Low. This is a pure refactor — same runtime behavior, same exports, same types.
- **Scope**: Touches 4-5 files with structural changes. No business logic changes.
- **Rollback**: Easy — revert to hand-maintained literals.
- **Breaking changes**: None. All exports maintain the same names and types.

## Files Modified

| File | Change |
|------|--------|
| `src/dispatch/registry.ts` | Add `LEGACY_DOMAIN_ALIASES`, `deriveGatewayMatrix()`, `getGatewayDomains()`, `aliases` field |
| `src/dispatch/types.ts` | No changes needed (types are already correct) |
| `src/mcp/gateways/query.ts` | Replace `QUERY_OPERATIONS` literal with derived call |
| `src/mcp/gateways/mutate.ts` | Replace `MUTATE_OPERATIONS` literal with derived call |
| `src/dispatch/adapters/mcp.ts` | Refactor `resolveDomainAlias()` to use `LEGACY_DOMAIN_ALIASES` |
| `src/dispatch/__tests__/registry-gateway-sync.test.ts` | Delete (no longer needed) |
| `src/dispatch/__tests__/registry-derivation.test.ts` | New (validates derivation logic) |
| `src/mcp/gateways/__tests__/query.test.ts` | Update domain count expectations |
| `src/mcp/gateways/__tests__/mutate.test.ts` | Update domain count expectations |

## Open Questions

1. **Should `deriveGatewayMatrix()` be called once at module load (cached) or on every access?**
   Recommendation: Once at module load, assigned to `const`. The OPERATIONS array is static — it never changes at runtime.

2. **Should `LEGACY_DOMAIN_ALIASES` also drive the `QueryDomain` / `MutateDomain` TypeScript union types?**
   Recommendation: Yes, but this requires `as const` assertions and type derivation. Can be a follow-up.

3. **Should the `research` legacy alias include BRAIN operations (`brain.search`, `brain.timeline`, etc.)?**
   Currently the hand-maintained `research` alias in `query.ts` does NOT include the BRAIN operations. The derivation would include them since `research` maps to `memory` with no prefix. The implementation agent should verify this is acceptable — or add a filter mechanism.
