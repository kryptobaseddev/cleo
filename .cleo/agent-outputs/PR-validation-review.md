# PR Validation Review — Epic T5701 Core Extraction

**Branch**: `feature/T5701-core-extraction`
**Reviewer**: Code Quality Reviewer Agent
**Date**: 2026-03-17
**Verdict**: PASS (with advisory findings — no blockers)

---

## Summary

17 commits, 105 files changed, 9,545 insertions / 5,836 deletions. The epic successfully:
- Extracted business logic from dispatch/mcp layers into `src/core/` submodules
- Created three new engine wrappers (`nexus-engine.ts`, `tools-engine.ts`, orchestrate refactor)
- Converted 7 dispatch/lib and mcp/lib files to thin backward-compat re-export stubs
- Built a comprehensive 65-namespace barrel export at `src/core/index.ts`
- Extracted `packages/core/` as a standalone workspace package

All automated gates passed:
- `dev/check-core-purity.sh`: PASS — no upward imports from core → dispatch/mcp/cli
- `dev/check-underscore-import-hygiene.mjs`: PASS — all underscore imports wired and justified
- `npx tsc --noEmit`: PASS — zero type errors

---

## Step 1: Engine Thinness

### orchestrate-engine.ts (1,030 lines)

**Mixed result — most functions are thin, two are not.**

- `orchestrateStatus` (27 lines): THIN — loads tasks, calls `computeEpicStatus`/`computeOverallStatus` from core. OK.
- `orchestrateAnalyze` (45 lines): BORDERLINE — calls `analyzeEpic` + `analyzeDependencies` from core, but builds its own response shape inline. Acceptable.
- `orchestrateHandoff` (172 lines): NOT THIN — contains multi-step orchestration state machine with inline step tracking, retry logic, and idempotency key management. This is business logic, not routing. Acceptable given the coordinating nature across 3 sub-operations (context.inject → session.end → spawn), but it does not delegate to a core function.
- `orchestrateSpawnExecute` (123 lines): NOT THIN — contains adapter selection, provider capability checks, token resolution validation, CLEOSpawnContext construction, and spawn execution. This spans what would be 3-4 core functions. However, it delegates to `@cleocode/caamp` and `src/core/spawn/` for most primitives, so the logic is coordination rather than pure business logic.
- `orchestrateSpawnExecute` has `_tier?: 0 | 1 | 2` parameter that is **accepted but never used**. No justification comment is present. This is an advisory finding — the hygiene checker only scans import aliases, not function parameters.

**Finding (advisory)**: `orchestrate-engine.ts:445` — `_tier` parameter is accepted by `orchestrateSpawnExecute` but never referenced in the function body. This should either be removed or documented with a comment explaining it is reserved for future use.

### tools-engine.ts (909 lines)

Engine is THIN by function. All functions delegate to `@cleocode/caamp` (`installSkill`, `removeSkill`, `discoverSkill`, etc.) or `src/core/` (`AdapterManager`, `collectDiagnostics`, `getSyncStatus`).

`toolsSkillInstall` (60 lines) and `toolsSkillRefresh` (60 lines) contain provider iteration loops but these are coordination logic (fan-out to multiple providers), not extractable business logic. Each iteration body calls `installSkill` from core.

`_projectRoot` at line 527 (`toolsSkillRefresh`) is accepted but unused — same pattern as `_tier`. No justification comment. Advisory finding.

### nexus-engine.ts (666 lines)

**nexusDiscover** (129 lines) and **nexusSearch** (115 lines) contain significant business logic inline:
- `nexusDiscover`: keyword extraction, stop-word filtering, label overlap scoring, description similarity scoring — all implemented directly in the engine function with a private `extractKeywords()` helper.
- `nexusSearch`: regex pattern building and cross-project task matching.

This logic was moved FROM the old domain handler into the engine (per commit `2339aca0`), not from core. The engine is the new home of this logic — there is no `src/core/nexus/discover.ts` module. This is a **layering gap**: the discovery/search scoring algorithm should be in `src/core/nexus/` to comply with the shared-core principle.

**Finding (advisory)**: The nexus discovery and search scoring algorithms (`extractKeywords`, label overlap scoring, keyword similarity scoring in `nexusDiscover`; regex matching in `nexusSearch`) live in the engine layer, not in `src/core/nexus/`. A future task should extract these to `src/core/nexus/discover.ts`. This is not a blocker for this PR because the logic was pre-existing in the domain handler and was correctly moved to the engine — it is an improvement, not a regression.

---

## Step 2: Unused Imports

All underscore-prefixed import aliases in changed files are **correctly wired** and follow the dynamic-import wrapper pattern:

```typescript
// Pattern used in resume.ts, pipeline-manifest-sqlite.ts, release-manifest.ts:
async function getDb(cwd?: string) {
  const { getDb: _getDb } = await import('../../store/sqlite.js');
  // underscore-import: dynamic import wrapper to avoid top-level sqlite coupling
  return _getDb(cwd);
}
```

The hygiene checker confirmed all such aliases are used (appear more than once) and have justification tokens. **PASS.**

---

## Step 3: Underscore-Prefixed Variables

No `const _x`, `let _x`, or `var _x` declarations added in the diff. The two underscore parameters found are function parameters, not variable declarations:

- `src/dispatch/engines/orchestrate-engine.ts:445` — `_tier?: 0 | 1 | 2` (unused parameter, no comment)
- `src/dispatch/engines/tools-engine.ts:527` — `_projectRoot: string` (unused parameter, no comment)

These are advisory — TypeScript's strict mode does not flag unused parameters by default (only `noUnusedLocals`/`noUnusedParameters` would catch these, and they pass tsc --noEmit). Both should have a brief comment explaining the intentional stub.

---

## Step 4: Barrel Export Completeness

`src/core/index.ts`: 303 lines, 84 export statements, 65 namespace re-exports. All critical new modules are present:

```
export * as admin from './admin/index.js';           ✓
export * as compliance from './compliance/index.js'; ✓
export * as orchestration from './orchestration/index.js'; ✓
export * as routing from './routing/index.js';       ✓
export * as security from './security/index.js';     ✓
export * as templates from './templates/index.js';   ✓
```

`packages/core/src/index.ts` is a single `export * from '../../../src/core/index.js'` re-export, correctly wired. Workspace registration in root `package.json` confirmed. **PASS.**

---

## Step 5: Domain Handlers Thinness

### `src/dispatch/domains/tools.ts` (718 lines)

Contains 43 conditional expression matches (`if`/`&&`/`||`). Review of the logic shows:
- All conditions are **routing logic**: `if (operation.startsWith('skill.'))`, `switch(sub)`, `if (!name)` input validation guards, `if (action === 'show')` sub-routing.
- No business logic. The response shaping in the `skill.catalog` case (manually building response objects) is boilerplate but not business logic.
- **PASS** — domain is a pure router.

### `src/dispatch/domains/nexus.ts` (399 lines)

Contains 15 conditional expression matches. All are `switch(operation)` routing and `if (!param)` input guards. **PASS** — domain is a pure router.

---

## Step 6: packages/core Wiring

- `packages/core/package.json`: correct workspace config, peer deps declared, ESM exports, Node 24+ requirement.
- `packages/core/tsconfig.json`: extends root tsconfig, `rootDir: src`, `outDir: dist`.
- `packages/core/src/index.ts`: single re-export from `src/core/index.js`.
- Root `package.json` workspace includes `"packages/core"`. **PASS.**

---

## Step 7: Circular Imports / TypeScript Errors

`npx tsc --noEmit` produced **zero errors**. No circular dependency warnings. **PASS.**

---

## Step 8: T5712 Dynamic Import Approach

Three files use dynamic import wrappers to decouple from direct sqlite imports:

| File | Pattern |
|------|---------|
| `src/core/lifecycle/resume.ts:42` | `const { getDb: _getDb } = await import('../../store/sqlite.js')` |
| `src/core/memory/pipeline-manifest-sqlite.ts:22,27` | `getDb` and `getNativeDb` wrappers |
| `src/core/release/release-manifest.ts:34` | `getDb` wrapper |

All three use the same safe pattern: wrap the dynamic import in a local async function, call the imported function immediately, return the result. There is no async import that is captured and held as a module reference. **PASS.**

---

## Step 9: Compliance/Protocol Middleware Wiring

Middleware correctly imports from `src/core/`:

| Middleware | Import |
|------------|--------|
| `protocol-enforcement.ts` | `ProtocolEnforcer` from `../../core/compliance/protocol-enforcement.js` |
| `verification-gates.ts` | `createVerificationGate` from `../../core/validation/operation-verification-gates.js` |
| `audit.ts` | `getLogger`, `getProjectInfoSync`, `AuditEntry`, `queryAudit` from core modules |

Backward-compat stubs in `src/mcp/lib/` and `src/dispatch/lib/` correctly re-export from their new core canonical locations. **PASS.**

---

## Step 10: Diff Stats

```
105 files changed, 9,545 insertions(+), 5,836 deletions(-)
```

Net +3,709 lines — expected given the barrel exports, engine wrappers, and new core modules added. The large deletions in `src/mcp/lib/` (gate-validators: -818, protocol-rules: -807, verification-gates: -670) and `src/dispatch/lib/security.ts` (-427) represent successful extraction.

---

## Findings Summary

### Blockers
None.

### Advisory (should fix before or after merge)

| ID | File | Line | Finding |
|----|------|------|---------|
| A1 | `src/dispatch/engines/orchestrate-engine.ts` | 445 | `_tier` parameter accepted but never used; no justification comment |
| A2 | `src/dispatch/engines/tools-engine.ts` | 527 | `_projectRoot` parameter accepted but never used; no justification comment |
| A3 | `src/dispatch/engines/nexus-engine.ts` | 277-403, 405-518 | `nexusDiscover` and `nexusSearch` business logic (keyword extraction, label scoring, regex matching) belongs in `src/core/nexus/discover.ts`, not in the engine layer |

### Known Technical Debt (pre-existing, not introduced by this PR)

| Item | Location | Note |
|------|----------|------|
| Known exception | `src/core/validation/param-utils.ts` | Imports from `src/dispatch/registry.js` and `src/dispatch/types.js` — tracked by purity gate exceptions list |
| `legacyCreateGate` alias | `src/dispatch/middleware/verification-gates.ts:1` | Aliased import naming suggests planned rename, not a bug |

---

## Final Verdict

**PASS**

The epic achieves its stated goals: business logic moved to `src/core/`, domain handlers are thin routers, engine layer is the intermediary, backward-compat re-exports maintained, barrel export complete, packages/core wired correctly, zero TypeScript errors, both CI gates pass. The three advisory findings are improvements but do not represent regressions or broken wiring.
