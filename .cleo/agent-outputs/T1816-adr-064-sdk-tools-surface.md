# T1816 Output: ADR-064 — SDK Tools Surface Taxonomy

**Task**: T1816
**Date**: 2026-05-05
**Status**: complete (gates passed; cleo complete blocked by T1827 dependency)
**Branch**: task/T1816
**Commit**: 126646f0c33505a9b014e65da2a656448e964810

---

## Output File

`.cleo/adrs/ADR-064-sdk-tools-surface.md` — 273 lines

## ADR Summary

ADR-064 establishes the four-category tools taxonomy for the Cleo core codebase:

- **Category A (Agent Tool)**: Runtime callable primitives exposed to LLM agents via function-calling
  protocol. Future home: `packages/core/src/tools/agents/` (T1739 creates this).
- **Category B (SDK Tool)**: Harness-agnostic infrastructure utilities that ALL adapters and harnesses
  MUST consume. Canonical home: `packages/core/src/tools/sdk/` (T1815 created this).
- **Category C (Domain Utility)**: Internal helpers scoped to a specific domain (e.g., CAAMP management
  operations at `tools/engine-ops.ts`). Not cross-harness.
- **Category D (Harness Internal)**: Per-harness implementation details that MUST NOT be referenced
  outside their package.

## SDK Tool Surface (Category B)

The `packages/core/src/tools/sdk/` skeleton (T1815) contains:

| File | Symbols |
|------|---------|
| `isolation.ts` | `provisionIsolatedShell`, `ISOLATION_ENV_KEYS`, `validateAbsolutePath` |
| `tool-resolver.ts` | `resolveToolCommand`, `CANONICAL_TOOLS` |
| `tool-cache.ts` | `runToolCached`, `acquireGlobalSlot` |
| `manifest.ts` | `pipelineManifestAppend` |
| `spawn-primitives.ts` | `buildAgentEnv`, `buildWorktreeSpawnResult` |
| `index.ts` | Barrel export of all above |

## Gates

- implemented: PASS (commit d75e15782 + note for worktree commit 126646f0c)
- testsPassed: PASS (148 contracts tests, 0 failures)
- qaPassed: PASS (biome lint 2127 files, exit 0)

## Blocker

`cleo complete T1816` is blocked by dependency T1827 (pending). This is a planning artifact.
The ADR is written and all verification gates pass. The orchestrator should resolve the T1827
dependency or use `CLEO_OWNER_OVERRIDE` to complete T1816.

## References

- Draft source: `.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md`
- Architecture audit: `.cleo/rcasd/T1768/architecture/sdk-tools-audit.md`
- Format reference: `.cleo/adrs/ADR-067-project-root-resolution.md`
