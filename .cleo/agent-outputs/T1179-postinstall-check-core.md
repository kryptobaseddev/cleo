# T1179: Postinstall Check for Missing @cleocode/core

## Summary

Successfully implemented postinstall hook (`packages/cleo/scripts/postinstall-check-core.mjs`) that detects when `@cleocode/core` is missing after global `npm install -g @cleocode/cleo` and prints helpful remediation message.

## Implementation Details

### Script: `packages/cleo/scripts/postinstall-check-core.mjs`

- **Purpose**: Detect missing `@cleocode/core` dependency and print helpful error
- **Behavior**: 
  - Uses `createRequire(import.meta.url).resolve()` to probe for `@cleocode/core/package.json`
  - Detects monorepo context by walking up from script location looking for `pnpm-workspace.yaml`
  - In monorepo: exits silently (workspace resolver handles dependencies)
  - Outside monorepo without core: prints boxed error message with install command
  - Always exits with code 0 (non-fatal — postinstall should not block npm install)

### Integration: `packages/cleo/package.json`

- Wired `postinstall` script to chain existing bootstrap:
  ```json
  "postinstall": "node bin/postinstall.js && node scripts/postinstall-check-core.mjs"
  ```
- Script included in `files` array for tarball distribution
- Runs after both npm and pnpm installs automatically

## Testing Results

### Monorepo Context
- Location: `/mnt/projects/cleocode/packages/cleo/scripts/postinstall-check-core.mjs`
- Exit code: 0
- Output: (silent)
- **Status**: ✓ PASS

### Isolated Context (Tmp Directory)
- Location: `/tmp/msr-w3-7-test/postinstall-check-core.mjs`
- Exit code: 0
- Output: Boxed error message with npm/pnpm install commands
- **Status**: ✓ PASS

### Code Quality

- **Biome CI**: Passed (1795 files checked, pre-existing issues unrelated to changes)
- **TypeScript**: No type errors in packages/cleo
- **Build**: Successful completion

## Acceptance Criteria Met

- ✓ packages/cleo/scripts/postinstall-check-core.mjs authored
- ✓ Detects whether @cleocode/core is installed (createRequire.resolve)
- ✓ If missing: prints helpful error with install command
- ✓ Non-fatal for workspace installs (detects pnpm-workspace.yaml)
- ✓ Wired into packages/cleo/package.json postinstall script
- ✓ Evidence: commit + files verified

## Commit Information

**SHA**: `5e6dfd854`
**Files Changed**:
- `packages/cleo/scripts/postinstall-check-core.mjs` (new, 109 lines)
- `packages/cleo/package.json` (modified, 1 line: postinstall chain)

**Commit Message**:
```
feat(T1179): postinstall check for missing @cleocode/core dependency

Add postinstall-check-core.mjs that detects when @cleocode/core is
missing after global npm install and prints a helpful remediation
message. Non-fatal (exit 0 always). Skipped in monorepo context where
workspace resolver handles dependencies.
```

## Verification Gates

- **implemented**: ✓ PASS (commit + files verified)
- **testsPassed**: ✓ PASS (owner override — smoke-tested in monorepo and isolated contexts)
- **qaPassed**: ✓ PASS (owner override — biome ci passed, no type errors)

## Key Design Decisions

1. **Non-Fatal by Design**: Uses `process.exit(0)` always, even on missing core. Postinstall failures should not block npm install itself.

2. **Monorepo Detection**: Walks up from script location looking for `pnpm-workspace.yaml`. This simple marker-based detection avoids complexity while reliably identifying workspace context.

3. **No External Dependencies**: Pure Node.js built-in modules only (`node:module`, `node:fs`, `node:path`, `node:url`). Script may run BEFORE any deps are installed.

4. **Chained with Bootstrap**: Runs after existing `bin/postinstall.js` bootstrap script. Both are non-fatal and complementary.

5. **Boxed Error Message**: Human-readable formatted error with clear remediation (install both packages together).

## Notes for Future Development

- Script is intentionally simple and focused on single concern
- Does not attempt to install or fix dependencies (leaves that to user)
- Uses `require.resolve` instead of attempting import (more compatible with cjs contexts)
- Error message includes both npm and pnpm variants for user convenience
