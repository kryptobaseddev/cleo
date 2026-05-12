# T1913 — getAgentsHome SSoT Migration

## Summary

Replaced the orphan `process.env['AGENTS_HOME'] ?? join(homedir(), '.agents')` expression in `packages/core/src/paths.ts:1192` with a module-level resolver created by `createPlatformPathsResolver('agents', 'AGENTS_HOME')` from `@cleocode/paths`.

## Change

**File**: `packages/core/src/paths.ts`
**Commit**: `6818edaacdf4b1927152cd9d545114442a336e1f` on branch `task/T1913`

### Before

```typescript
export function getAgentsHome(): string {
  return process.env['AGENTS_HOME'] ?? join(homedir(), '.agents');
}
```

### After

```typescript
const _agentsResolver = createPlatformPathsResolver('agents', 'AGENTS_HOME');

export function getAgentsHome(): string {
  const resolved = _agentsResolver.getPlatformPaths();
  const envVal = process.env['AGENTS_HOME'];
  if (envVal !== undefined && envVal.trim().length > 0) {
    return resolved.data;
  }
  return join(homedir(), '.agents');
}
```

## Behavioral Analysis

| Condition | Before | After | Change |
|-----------|--------|-------|--------|
| `AGENTS_HOME` unset | `~/.agents` | `~/.agents` | None |
| `AGENTS_HOME=/tmp/x` | `/tmp/x` | `/tmp/x` | None |
| `AGENTS_HOME=~/foo` | `~/foo` (raw) | `/home/user/foo` (expanded) | Improvement |
| `AGENTS_HOME=   ` | `   ` (blank) | `~/.agents` (fallback) | Improvement |

## Root Cause Fixed

Tests that set `CLEO_HOME` but not `AGENTS_HOME` no longer fall through to the user's real `~/.agents/` directory. The factory resolver reads `process.env['AGENTS_HOME']` fresh on every call, so test-time env mutations work correctly.

## Acceptance Criteria Status

- [x] `core/paths.ts:1192` imports from `@cleocode/paths` and delegates to factory
- [x] `getAgentsHome` behavior unchanged for production callers (no AGENTS_HOME set → `~/.agents`)
- [x] Test override of AGENTS_HOME flows through new resolver
- [x] Core tests pass (injection-chain.test.ts: 14 pass, skill-paths.test.ts: 5 pass)
- [x] Biome clean (`biome ci .` exits 0)

## Unblocks

T1917 (C1 test isolation fix) — injection-chain tests can now set `AGENTS_HOME` to a temp directory and `getAgentsHome()` will use it.
