# Phase 2 Lead Manifest

**Session date**: 2026-05-08
**Lead model**: claude-sonnet-4-6
**Target release**: v2026.5.56

---

## Per-Task Summary

### T9054 — Drop vestigial multi-engine polymorphism in getAccessor / createDataAccessor

- **Status**: COMPLETED
- **Branch**: task/T9054
- **Final commit SHA**: e1dbabf353f2cf157d198e1b5bace77dbc04b797
- **Retries**: 0 phantom recoveries
- **Files changed**: 111 source files
- **Key changes**:
  - `createDataAccessor(_engine?, cwd?)` → `createDataAccessor(cwd?)` — engine param dropped
  - `getAccessor()` deprecated shim retained; `getTaskAccessor()` is canonical
  - SSoT-EXEMPT marker removed from createDataAccessor
  - Codemod script: `/tmp/migrate-getAccessor.sh` — migrated 341 call sites across 109 source files
  - 22 test files updated to mock both `getAccessor` (shim) and `getTaskAccessor` (canonical)

### T9047 — Establish DB ownership SSoT — openCleoDb chokepoint + umbrella DataAccessor (9 DBs)

- **Status**: COMPLETED
- **Branch**: task/T9047
- **Final commit SHA**: 64d194e05bcbedffb1be7ab858ce2b8aaf077824
- **Files changed**: 5
- **Key changes**:
  - `scripts/lint-no-raw-db-opens.mjs`: ADR-068 CI guard script
  - `.github/workflows/ci.yml`: `db-open-guard` job added (delta-aware, allowlists pending sweeps)
  - `packages/core/src/store/open-cleo-db.ts`: full invariant docs (ADR-068 §3, ADR-069)
  - `spawn-tier.test.ts`: fixed mock to include both `getAccessor` and `getTaskAccessor`

**openCleoDb API shape**:
```typescript
type CleoDbRole = 'tasks' | 'brain' | 'sessions' | 'signaldock' | 'conduit' | 'nexus' | 'llmtxt';
interface CleoDbHandle { db: unknown; role: CleoDbRole; close(): Promise<void>; }
async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle>
```

**CI guard regex**: `new DatabaseSync\s*\(`
**Allowlisted paths**: `packages/core/src/store/`, `packages/core/src/migration/`, `packages/core/src/conduit/`, specific one-shot files

### T9022 — Wire applyPerfPragmas into read-only DB opens

- **Status**: COMPLETED
- **Branch**: task/T9022
- **Final commit SHA**: 024f2c65e10088990f49a5656fca019e66e06bf7
- **Files changed**: 5
- **Sites migrated** (all `enableWal: false`):
  - `backup-pack.ts`: lines 250, 286 (readOnly) + line 349 (writer, full set)
  - `backup-unpack.ts`: line 502 (readOnly)
  - `atomic.ts`: line 188 (dynamic import pattern)
  - `migration/checksum.ts`: line 78 (dynamic import pattern)
  - `memory/claude-mem-migration.ts`: line 167 (readOnly)

### T9023 — Wire applyPerfPragmas into one-shot writer DB opens

- **Status**: COMPLETED
- **Branch**: task/T9023
- **Final commit SHA**: 66d304566984debcbfcc27429b429b736d6c3bff
- **Files changed**: 5
- **Sites migrated** (full pragma set unless noted):
  - `agent-registry-accessor.ts`: 2 sites — replaced inline `foreign_keys + journal_mode` calls
  - `cross-db-cleanup.ts`: 1 site — dynamic import pattern
  - `migrate-signaldock-to-conduit.ts`: 3 sites — legacy (readOnly), conduit (FK off), globalDb (FK off)
  - `upgrade.ts`: 2 sites — doctor report opens
  - `memory/graph-memory-bridge.ts`: 1 site — hot-path conduit open

### T9045 — Cross-package DB-open drift (brain/studio/cleo/llmtxt-blob-adapter)

- **Status**: COMPLETED
- **Branch**: task/T9045
- **Final commit SHA**: 1da25df9b
- **Files changed**: 8
- **Migrated packages**:
  - `packages/brain/src/db-connections.ts`: inline `applyBrainPragmas()` function (mirrors SSoT set; no core dep)
  - `packages/studio/src/lib/server/db/connections.ts`: imports from `@cleocode/core`; 5 sites
  - `packages/studio/src/lib/server/project-context.ts`: 2 nexus.db opens
  - `packages/studio/src/routes/api/search/+server.ts`: 1 nexus search open
  - `packages/cleo/src/cli/commands/agent.ts`: 3 sites via static `applyPerfPragmas` from `@cleocode/core/internal`
  - `packages/cleo/src/cli/commands/migrate-agents-v2.ts`: 1 site
  - `packages/core/src/store/llmtxt-blob-adapter.ts`: manifest.db open
  - `packages/core/src/internal.ts`: exports `applyPerfPragmas` for cleo/brain consumers

### T9024 — Re-evaluate sqlite-native leaf-module invariant for sqlite-pragmas import

- **Status**: COMPLETED
- **Branch**: task/T9024
- **Final commit SHA**: b5d2f4ed1ae89cb43f0997d74791f42968099282
- **Files changed**: 1
- **Findings**:
  - `sqlite-pragmas.ts` has only `import type { DatabaseSync } from 'node:sqlite'` — zero CLEO deps
  - Type-only imports are erased at runtime; they don't appear in the live binding graph
  - Adding `import { applyPerfPragmas } from './sqlite-pragmas.js'` to `sqlite-native.ts` does NOT reintroduce the T1331 TDZ cycle
  - Experimentally confirmed: full Vitest suite (10,909 tests) passes — no TDZ errors
  - Inline pragma duplication removed from `openNativeDatabase` function
  - Invariant doc comment updated: narrowed from "no CLEO modules" to "no modules with live CLEO bindings in the TDZ cycle"
- **Outcome**: ADR not required (invariant clarified, not changed)

---

## Architecture Summary

### openCleoDb signature

```typescript
// packages/core/src/store/open-cleo-db.ts
export type CleoDbRole = 'tasks' | 'brain' | 'sessions' | 'signaldock' | 'conduit' | 'nexus' | 'llmtxt';

export interface CleoDbHandle {
  db: unknown;     // DatabaseSync (tasks, brain, sessions) or Drizzle (nexus)
  role: CleoDbRole;
  close(): Promise<void>;
}

export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle>
```

### DataAccessor umbrella (from T9050, already done)

The umbrella DataAccessor interface (`@cleocode/contracts`) covers the tasks domain. Sub-accessors (brain, conduit, nexus, etc.) are planned in T9051, T9063, T9064, T9065 (moved to T9021 parent for Phase 3/4 completion).

### getTaskAccessor migration

- Before: `getAccessor(cwd?)` (implied universal, 341 call sites)
- After: `getTaskAccessor(cwd?)` (explicit tasks-only scope)
- Deprecated shim `getAccessor` retained for one minor version
- CI graph no longer misclassifies `getTaskAccessor` as a universal key

---

## CI Guard Details

**Script**: `scripts/lint-no-raw-db-opens.mjs`
**Pattern**: `/new DatabaseSync\s*\(/`
**Allowlist** (pending sweep tasks):
- `packages/core/src/store/` — canonical open site
- `packages/core/src/migration/` — migration runner
- `packages/core/src/memory/claude-mem-migration.ts` — one-shot memory migration
- `packages/core/src/memory/graph-memory-bridge.ts` — T9023 sweep done
- `packages/core/src/conduit/` — conduit infrastructure
- `packages/core/src/upgrade.ts` — T9023 sweep done
- `packages/core/src/init.ts` — bootstrap before chokepoint available
- `packages/core/src/agents/seed-install.ts` — one-shot global install
- `packages/core/src/orchestration/classify.ts` — JSDoc examples only (not actual code)
- Test files (`__tests__/`, `.test.ts`, `.spec.ts`)
**Inline opt-out**: `// db-open-allowed`

---

## Test Surface

- 22 test files updated to mock both `getAccessor` (deprecated shim) and `getTaskAccessor` (canonical)
- `spawn-tier.test.ts`: factory function mock with both exports
- All session, task, memory, dispatch test files: import + mock setup updated
- Pre-existing failures: 3 tests in untracked `worktree-clean-base.test.ts` (unimplemented T9039 function)

---

## Build / Cargo

- TypeScript build: PASS
- Rust: Not touched by Phase 2
- Cargo check: N/A (no Rust changes)

---

## Release Artifacts

- **PR URL**: https://github.com/kryptobaseddev/cleo/pull/112
- **Release branch**: release/v2026.5.56
- **Target**: v2026.5.56 (Wave B shipped v2026.5.54 and v2026.5.55 in parallel)
- **Version bump**: 2026.5.50 → 2026.5.56 across 21 package.json files
- **CI run**: https://github.com/kryptobaseddev/cleo/actions (in progress at manifest time)

---

## Observations / Learnings

1. The `getAccessor` → `getTaskAccessor` rename required fixing 22 test mocks because Vitest module mocks need to export the exact function name that production code calls. A systematic codemod + Python-based import fixer covered all cases.

2. The `sqlite-pragmas.ts` type-only-import leaf is an important precedent: the T1331 TDZ guard is about LIVE VALUE BINDINGS, not imports per se. Documentation updated accordingly.

3. Cross-package DB opens (brain, cleo, studio) need careful handling when the target package doesn't depend on core — brain used an inline mirror function rather than adding a new dependency.

4. The `cleo release ship` command's commit fails when the release branch is created with files already committed (step 5 tries to stage CHANGELOG.md which has no delta). Worked around by manually bumping versions and committing with the release message format.
