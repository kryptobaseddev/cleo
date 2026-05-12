# T9037: P0 Hotfix — Universal-Tier Path Resolution Gap

**Status**: complete  
**Task**: T9037  
**Parent Epic**: T1929 (Phase 1: Agent System Canonicalization v2)  
**Release**: v2026.5.36  
**Commit**: 3bb9e5325

## Summary

Fixed `resolveDefaultUniversalBasePath()` in `packages/core/src/store/agent-resolver.ts` to use `require.resolve('@cleocode/agents/package.json')` as its primary resolution strategy, matching the approach in `resolveAgentTemplates()` and `resolveMetaAgentsDir()` (T1935).

## Root Cause

The old implementation used only `fileURLToPath(import.meta.url)` relative path climbing to locate `@cleocode/agents/cleo-subagent.cant`. In a globally-installed CLI, `import.meta.url` resolves relative to `node_modules/@cleocode/core/dist/store/`, and the five-level `..` climb does not reach `node_modules/@cleocode/agents/`. The require.resolve strategy (Phase 1) works identically in workspace and published-CLI mode because Node's module resolver follows the package graph.

## Fix

Two-phase resolution in `resolveDefaultUniversalBasePath()`:

1. **Phase 1 (primary)**: `_resolverRequire.resolve('@cleocode/agents/package.json')` → `dirname` → `cleo-subagent.cant` path  
2. **Phase 2 (fallback)**: Existing relative-path walk covering workspace `src/`, `dist/`, and installed layouts

`resolveDefaultUniversalBasePath()` is now exported for direct testability.

## Verification

- `V_AGENT_NOT_FOUND` is GONE from `cleo orchestrate spawn T1820 --json` output
- Error now shows `E_ATOMICITY_NO_SCOPE` (unrelated to agent resolution — task lacks file scope)
- 22 agent-resolver tests pass (2 new T9037 tests added)
- All quality gates: biome CI clean, typecheck clean, build clean

## Files Changed

- `packages/core/src/store/agent-resolver.ts` — fix + export `resolveDefaultUniversalBasePath()`
- `packages/core/src/store/__tests__/agent-resolver.test.ts` — 2 new T9037 parity tests
- `CHANGELOG.md` — v2026.5.36 entry
- 21 `package.json` files — version bump 2026.5.35 → 2026.5.36

## Key Findings

- The require.resolve primary strategy is now the canonical pattern for locating `@cleocode/agents` assets (confirmed in resolveAgentTemplates.ts, resolveMetaAgentsDir, and now resolveDefaultUniversalBasePath)
- Pre-existing test failures (18 tests in 7 files) are unrelated to this change and existed before it
- My fix actually resolved 2 additional pre-existing pipeline-e2e test failures
