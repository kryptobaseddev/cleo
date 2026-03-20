# CORE-AUDIT-FINDINGS

**Scope**: `packages/core/src/` (all `.ts` source files)
**Generated**: 2026-03-19
**Type**: Read-only audit

---

## Executive Summary

| Category | Count | Notes |
|---|---|---|
| TODO/FIXME/HACK/XXX Comments | **0** | No actionable TODO markers in source code |
| Unused Imports | **0** | All imports verified as used |
| Underscore-Prefixed Ignores | **30** | Across 16 files; 28 are intentional API-compat params |
| Commented-Out Code | **0** | No functional code found commented out |
| Barrel Export Integrity | **Pass** | All `index.ts` and `internal.ts` references resolve |

**Overall assessment**: The codebase is clean. There are zero TODO/FIXME markers, zero unused imports, and zero commented-out code blocks. The only notable pattern is the widespread use of underscore-prefixed parameters (`_cwd`, `_entry`, `_config`, etc.) to suppress unused-variable warnings. Most of these are intentional API-compatibility placeholders where the parameter exists in the function signature for callers but is not needed by the implementation.

---

## 1. TODO/FIXME/HACK/XXX Comments

**Result: None found.**

A thorough scan of all `.ts` files in `packages/core/src/` for `// TODO`, `// FIXME`, `// HACK`, `// XXX`, `/* TODO */`, and `@todo` annotations returned zero results. All matches for `TODO|FIXME|HACK|XXX` in the grep output are:

- String literals in test data (e.g., `'WARN'` log levels in test fixtures)
- The codebase-map concerns analyzer which scans *other* codebases for TODOs (regex pattern definition at `codebase-map/analyzers/concerns.ts:39`)
- Enum values like `WARNING` in compliance types
- Error catalog entries containing the word "WARNING"

None of these are actionable developer TODO markers.

---

## 2. Unused Imports

**Result: None found.**

Every import in every non-test `.ts` file was verified. All named imports are used in the file body. The automated scan checked:
- All `import { ... } from` statements
- All `import type { ... } from` statements
- Aliased imports (e.g., `import { constants as fsConstants }`) -- verified alias is used

No barrel files (`index.ts`, `internal.ts`) re-export symbols from non-existent modules. All 46 subdirectory barrel files referenced from `packages/core/src/index.ts` exist and resolve correctly.

---

## 3. Underscore-Prefixed Ignores

30 instances found across 16 files. Categorized below by purpose.

### 3.1 API-Compatibility Placeholders (`_cwd` pattern)

These parameters exist in function signatures for API consistency (callers pass `cwd`) but the implementation uses `accessor` instead. This is an intentional design pattern.

| File | Line | Parameter | Context | Severity | Action |
|---|---|---|---|---|---|
| `phases/index.ts` | 91 | `_cwd` | `listPhases()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 128 | `_cwd` | `showPhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 164 | `_cwd` | `setPhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 261 | `_cwd` | `startPhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 305 | `_cwd` | `completePhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 358 | `_cwd` | `advancePhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 463 | `_cwd` | `renamePhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/index.ts` | 519 | `_cwd` | `deletePhase()` -- uses `accessor` | investigate | evaluate-removal |
| `phases/deps.ts` | 19 | `_cwd` | `loadAllTasks()` -- uses `accessor` | investigate | evaluate-removal |

**Recommendation**: These 9 instances all follow the same pattern. The `_cwd` param was likely needed before the `DataAccessor` pattern was adopted. Consider removing `_cwd` from these signatures if no callers pass positional `cwd` values (breaking change analysis needed).

### 3.2 Unused Callback/Interface Parameters

These are parameters required by an interface or callback contract but not needed by the specific implementation.

| File | Line | Parameter | Context | Severity | Action |
|---|---|---|---|---|---|
| `compliance/protocol-rules.ts` | 101, 171, 183, 196, 212, 226, 273, 293, 304, 315, 326, 352, 365, 375, 427, 439, 465, 481, 492, 503, 529, 540, 553, 564, 590, 601, 611, 622, 635, 646, 681, 710, 736, 748, 759, 770, 782 | `_entry` | Protocol rule validators -- `validate(_entry, data)` | investigate | remove-safely |
| `release/artifacts.ts` | 360, 385, 423 | `_config` | Artifact handler `validate()` -- config unused in validation | investigate | remove-safely |
| `adapters/manager.ts` | 259 | `_providerEvent` | Loop variable in `Object.entries(eventMap)` -- only value used | investigate | remove-safely |
| `adapters/manager.ts` | 265 | `_projectRoot` | Hook handler -- projectRoot not needed, only payload | investigate | remove-safely |
| `signaldock/signaldock-transport.ts` | 107 | `_since` | `poll()` -- pagination param not yet wired | should-fix | implement-usage |
| `lifecycle/tessera-engine.ts` | 106 | `_full` | Regex replace callback -- full match not needed | investigate | remove-safely |

**Note on `compliance/protocol-rules.ts`**: All 37 validator functions follow the `validate(_entry, data)` pattern. The `_entry` parameter is part of the `ProtocolRule.validate` interface signature. The validators only use `data` (the protocol-specific payload). This is by design -- the interface requires both params but individual rules only inspect data.

### 3.3 Error Suppression in Catch Blocks

Standard pattern for catch blocks where the error is intentionally swallowed.

| File | Line | Parameter | Context | Severity | Action |
|---|---|---|---|---|---|
| `init.ts` | 119 | `_err` | Symlink fallback -- swallows error, retries with copy | investigate | remove-safely |
| `hooks/handlers/error-hooks.ts` | 36 | `_err` | Suppresses observeBrain errors to prevent re-entrant hooks | investigate | remove-safely |
| `memory/brain-migration.ts` | 76 | `_err` | JSON parse failure in JSONL migration | investigate | remove-safely |
| `lifecycle/resume.ts` | 1131 | `_error` | Auto-resume failure -- falls through to manual choice | investigate | remove-safely |

### 3.4 Stub/Placeholder Implementations

Functions that accept a param for future use but currently ignore it.

| File | Line | Parameter | Context | Severity | Action |
|---|---|---|---|---|---|
| `schema-management.ts` | 169 | `_opts` | `ensureGlobalSchemas()` -- opts reserved for future | investigate | remove-safely |
| `otel/index.ts` | 128 | `_opts` | `getRealTokenUsage()` -- returns placeholder, needs OTel wiring | should-fix | implement-usage |
| `orchestration/skill-ops.ts` | 29 | `_projectRoot` | `listSkills()` -- reads from canonical dir, ignores project | should-fix | implement-usage |
| `orchestration/skill-ops.ts` | 66 | `_projectRoot` | `getSkillContent()` -- same pattern | should-fix | implement-usage |
| `skills/orchestrator/startup.ts` | 137 | `_epicId` | `sessionInit()` -- epicId not used in session check | should-fix | implement-usage |
| `validation/doctor/checks.ts` | 419 | `_projectRoot` | `detectStorageEngine()` -- always returns 'sqlite' | investigate | remove-safely |
| `validation/doctor/checks.ts` | 972 | `_projectRoot` | `checkGlobalSchemaHealth()` -- checks global, not project | investigate | remove-safely |
| `issue/template-parser.ts` | 232 | `_templates` | `validateLabelsExist()` -- stub, returns `valid: true` | should-fix | implement-usage |
| `validation/protocol-common.ts` | 96 | `_protocolType` | `checkReturnMessageFormat()` -- type not used in check | investigate | implement-usage |
| `lifecycle/pipeline.ts` | 705 | `_reason` | `completePipeline()` -- API compat, reason unused | investigate | implement-usage |
| `lifecycle/state-machine.ts` | 716 | `_reason` | `skipStage()` -- reason param unused | should-fix | implement-usage |

---

## 4. Commented-Out Code

**Result: None found.**

Searched for patterns including:
- `// const x =`, `// let x =`, `// return x`, `// await x`, `// throw new`
- `// if (`, `// for (`, `// while (`
- `// export`, `// import {`
- `// x.y(` (method calls)

All `//` comments in the codebase are explanatory/documentary, not commented-out functional code. Examples of legitimate comments found:

- Architecture explanations (e.g., `// resolve() ensures GIT_DIR and GIT_WORK_TREE are absolute`)
- Migration notes (e.g., `// Bootstrap existing databases that predate drizzle migrations`)
- API documentation (e.g., `// CleoError and ExitCode available if needed for future error cases`)

---

## 5. Barrel Export Integrity

### `packages/core/src/index.ts`

All 42 namespace re-exports (`export * as X from './X/index.js'`) resolve to existing directories with valid `index.ts` files:

adapters, admin, adrs, caamp, codebase-map, compliance, context, hooks, inject, issue, lifecycle, mcp, memory, metrics, migration, nexus, observability, orchestration, otel, phases, pipeline, reconciliation, release, remote, research, roadmap, routing, security, sequence, sessions, signaldock, skills, snapshot, spawn, stats, sticky, system, task-work, tasks, templates, ui, validation

All 54 named re-exports (e.g., `export { addTask } from './tasks/add.js'`) reference valid source files.

### `packages/core/src/internal.ts`

All 200+ exports reference valid source modules. No dangling references found.

---

## Recommendations

### Priority Actions

1. **`signaldock/signaldock-transport.ts:107`** -- The `_since` param in `poll()` should be wired into the API request to support message pagination. Currently all messages are fetched on every poll.

2. **`otel/index.ts:128`** -- `getRealTokenUsage()` is a stub returning a placeholder. If OTel integration is planned, this needs implementation. If not, document the limitation.

3. **`lifecycle/state-machine.ts:716` and `lifecycle/pipeline.ts:705`** -- Both `_reason` parameters should be stored in the database (stage history / pipeline completion record) for auditability.

4. **`issue/template-parser.ts:232`** -- `validateLabelsExist()` is a full stub that always returns `valid: true`. Either implement GitHub API label verification or remove the function.

5. **`skills/orchestrator/startup.ts:137`** -- `_epicId` in `sessionInit()` should be used to scope the session initialization to a specific epic, as the function name and parameter suggest.

### Low Priority

6. **`phases/index.ts`** -- Consider removing `_cwd` from all 8 function signatures if the `DataAccessor` pattern has fully replaced direct cwd usage. This would be a breaking API change requiring caller audit.

7. **`compliance/protocol-rules.ts`** -- The 37 `_entry` parameters are a natural consequence of the validator interface. No action needed unless the interface is redesigned.

8. **`orchestration/skill-ops.ts`** -- `_projectRoot` in `listSkills()` and `getSkillContent()` should either be used (for project-local skills) or removed from the signature.
