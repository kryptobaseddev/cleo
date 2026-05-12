# T1937: Playbook Tier Resolver

**Status**: complete
**Task**: T1937 — Playbook tier resolver: implement resolvePlaybook() symmetric to resolveAgent() — project/global/packaged tiers
**Parent**: T1929 (Phase 1: Agent System Canonicalization v2)
**ADR**: ADR-068 Decision 4
**Commits**: 93585bc39, ee982924d, fdc11c940

## Deliverables

### 1. New resolver module

`packages/core/src/playbooks/playbook-resolver.ts`

- `resolvePlaybook(name, options)` — 3-tier cascade: project ⊳ global ⊳ packaged
- `listPlaybooks(options)` — walk all 3 tiers, dedupe by name (project wins)
- `PlaybookNotFoundError` — typed error with `code`, `exitCode`, `triedPaths`
- `PlaybookTier`, `ResolvedPlaybook`, `ResolvePlaybookOptions` interfaces

Tier locations:
- project: `<projectRoot>/.cleo/playbooks/<name>.cantbook`
- global: `getCleoHome() + /playbooks/<name>.cantbook` (via `@cleocode/paths`)
- packaged: `@cleocode/playbooks/starter/<name>.cantbook` (path-climbing auto-detect)

### 2. Tests (19 passing)

`packages/core/src/playbooks/__tests__/playbook-resolver.test.ts`

- Each tier individually
- Tier shadowing: project > global > packaged for same name
- `preferTier` option moves tier to head of order
- Fallthrough when dirs are empty or absent
- `PlaybookNotFoundError` with all tried paths
- `listPlaybooks()` dedupe + tier provenance
- Smoke tests: real rcasd/ivtr/release starter playbooks discoverable

### 3. Core exports

- `packages/core/src/playbooks/index.ts` — resolver symbols exported from namespace
- `packages/core/src/index.ts` — direct top-level exports for CLI consumers
- `packages/core/src/playbooks/ops.ts` — `catalog` op added to `playbookCoreOps`
- `packages/contracts/src/operations/playbook.ts` — `PlaybookCatalogParams/Result` types

### 4. CLI wiring

`packages/cleo/src/dispatch/domains/playbook.ts`

- `loadPlaybookByName()` now async, delegates to `resolvePlaybook()` when `playbookBaseDirs` override not set (backward-compatible with existing tests)
- `catalog` query op added: lists available `.cantbook` definitions with tier provenance
- `getSupportedOperations()` updated to include `catalog`
- `PlaybookRuntimeOverrides` extended with `packagedStarterDir`, `globalPlaybooksDir`, `projectRoot`

### 5. Quality gates

- biome: 0 errors, 6 pre-existing warnings (nexus, not in new files)
- typecheck: clean
- Tests: 772 files, 12766 passed, 18 skipped, 35 todo — zero new failures

## Key findings

1. `resolvePlaybook()` is a pure function (no global state, same inputs → same outputs) mirroring `agent-resolver.ts` conventions.
2. `PlaybookNotFoundError` uses `triedPaths[]` instead of `triedTiers[]` because the filesystem path is the actionable diagnostic (no DB involved, unlike agent resolver).
3. The `catalog` op is named distinctly from the existing `list` op to avoid collision: `list` = playbook runs (DB), `catalog` = playbook definitions (filesystem).
4. Inheritance (`extends:` keyword) is OUT OF SCOPE per ADR-068 — deferred to T1950 Phase 2.
