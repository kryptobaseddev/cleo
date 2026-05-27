# T107 — Audit: validation + hierarchy + cancellation config fields

**Date**: 2026-03-22
**Epic**: T101 (Enforcement Gates & Drizzle SSoT Audit)
**Status**: complete

---

## Scope

Fields audited across three config sections:
- `validation.*` — 13 fields (including nested sub-objects)
- `hierarchy.*` — 6 fields in schema, plus `requireAcceptanceCriteria` phantom
- `cancellation.*` — 5 fields

Total fields examined: 24 unique config leaf fields.

---

## Critical Finding: enforceAcceptance vs enforcement.acceptance.mode

### `validation.enforceAcceptance` (schema line 374, template line 63)

- **Schema**: `config.schema.json` defines it as a boolean, default `true`
- **Template**: `config.template.json` has `"enforceAcceptance": true` inside the `validation` block
- **Code consumption**: **ZERO** — no TypeScript code reads `validation.enforceAcceptance`
- **Actual enforcement**: `packages/core/src/tasks/enforcement.ts` reads `enforcement.acceptance.mode` via `getRawConfigValue`
- **Also**: `packages/core/src/tasks/complete.ts` reads `enforcement.acceptance.mode`

### `enforcement.acceptance.mode` (schema lines 2072-2079)

- **Schema**: defined as enum `'off' | 'warn' | 'block'`, default `'block'`
- **Template**: present in `config.template.json` under `enforcement.acceptance`
- **Code consumption**: LIVE — consumed by `enforcement.ts` and `complete.ts`
- **Verdict**: `enforcement.acceptance.mode` is the authoritative field. `validation.enforceAcceptance` is LEGACY and must be removed.

---

## validation.* Fields

| Field | Status | Evidence |
|-------|--------|----------|
| `validation.strictMode` | VAPORWARE | No TypeScript code reads `config.validation.strictMode`. Internal `strictMode` in `data-safety.ts`, `operation-verification-gates.ts`, and `protocol-enforcement.ts` is a constructor parameter, NOT sourced from config. |
| `validation.checksumEnabled` | VAPORWARE | No code reads this from config. |
| `validation.enforceAcceptance` | VAPORWARE (LEGACY) | Superseded by `enforcement.acceptance.mode`. Zero consumers. Remove immediately. |
| `validation.requireDescription` | VAPORWARE | No code reads this from config. |
| `validation.maxActiveTasks` | VAPORWARE | Schema doc itself says "Replaces global validation.maxActiveTasks" pointing to `multiSession.maxActiveTasksPerScope`. No code reads `config.validation.maxActiveTasks`. |
| `validation.validateDependencies` | WIRED-BUT-DEAD | `validateDependencies()` function is called unconditionally in `task-ops.ts:1129` and `validate-ops.ts:166` — it does NOT read a config flag. The config field is never consulted. |
| `validation.detectCircularDeps` | WIRED-BUT-DEAD | Same as above — `detectCircularDeps()` called unconditionally; config flag never read. |
| `validation.phaseValidation.enforcePhaseOrder` | VAPORWARE | Not read anywhere in code. |
| `validation.phaseValidation.phaseAdvanceThreshold` | VAPORWARE | Not read anywhere in code. |
| `validation.phaseValidation.blockOnCriticalTasks` | VAPORWARE | Not read anywhere in code. |
| `validation.phaseValidation.warnPhaseContext` | VAPORWARE | Not read anywhere in code. |
| `validation.claudedocs.enabled` | VAPORWARE | Not read anywhere in code. |
| `validation.claudedocs.strictMode` | VAPORWARE | Not read anywhere in code. |
| `validation.releaseGates` | DEPRECATED (schema-marked) | Already marked `x-deprecated: true` → `release.gates`. No further action needed beyond confirming it stays marked deprecated. |
| `validation.testing.*` | VAPORWARE | The `testing.*` sub-object fields (`enabled`, `framework`, `command`, `directory`, `requirePassingTests`, `runOnComplete`, `testFilePatterns`) are not read by any TypeScript code. The top-level `testing.*` section (duplicate of validation.testing) also has no consumers in production code. |

**Confirmed dead (removable)**: `strictMode`, `checksumEnabled`, `enforceAcceptance`, `requireDescription`, `maxActiveTasks`, entire `phaseValidation` sub-object, entire `claudedocs` sub-object, entire `testing` sub-object.

**Wired-but-dead (config flag is read but bypassed)**: `validateDependencies`, `detectCircularDeps` — the functions they name are called, but the flags are not consulted. The functions are always active regardless of config.

---

## hierarchy.* Fields

| Field | Status | Evidence |
|-------|--------|----------|
| `hierarchy.maxDepth` | LIVE | Read in `hierarchy-policy.ts:69`, `task-ops.ts:156`, env-mapped `CLEO_HIERARCHY_MAX_DEPTH` in `config.ts:79`. |
| `hierarchy.maxSiblings` | LIVE | Read in `hierarchy-policy.ts:72`, `task-ops.ts:157`, env-mapped. Referenced in compliance rules. |
| `hierarchy.countDoneInLimit` | LIVE | Read in `hierarchy-policy.ts:78`. |
| `hierarchy.maxActiveSiblings` | LIVE | Read in `hierarchy-policy.ts:75`, env-mapped. |
| `hierarchy.autoCompleteParent` | VAPORWARE | Not read by any TypeScript code (schema line 1040). |
| `hierarchy.autoCompleteMode` | VAPORWARE | Not read by any TypeScript code (schema line 1045). |
| `hierarchy.cascadeDelete` | WIRED-BUT-DEAD | In `CleoConfig` contract and DEFAULTS (`config.ts:36`), but `delete.ts` never reads this config value — cascade is controlled by the `--cascade` CLI flag only. |
| `hierarchy.enforcementProfile` | LIVE | Read in `hierarchy-policy.ts:55`, env-mapped `CLEO_HIERARCHY_ENFORCEMENT_PROFILE`. |

### hierarchy.requireAcceptanceCriteria (PHANTOM FIELD)

- Exists only in `config.ts` STRICTNESS_PRESETS (lines 351, 362, 372) — written to disk as a config key
- **NOT defined in `config.schema.json`** — the schema's `hierarchy` section has no `requireAcceptanceCriteria` property
- **NOT in `CleoConfig` interface** in `contracts/src/config.ts`
- **NOT read anywhere** in the codebase
- The field is written by `applyStrictnessPreset()` but never consumed
- **Verdict**: PHANTOM / DEAD WRITE. The strictness presets set a key that does nothing.
- **Action**: Remove from all three preset definitions in `config.ts`. The actual acceptance enforcement is handled by `enforcement.acceptance.mode` (which is correctly set separately from the presets via the `enforcement` block in templates).

---

## cancellation.* Fields

| Field | Status | Evidence |
|-------|--------|----------|
| `cancellation.cascadeConfirmThreshold` | WIRED-BUT-DEAD | `deletion-strategy.ts` parameter `cascadeThreshold` defaults to 10 hardcoded; the config field is never read to supply this value. Test environment sets `cancellation.requireReason false` (implying awareness), but no production code reads `cascadeConfirmThreshold` from config. |
| `cancellation.requireReason` | WIRED-BUT-DEAD | Test env sets it (`test-environment.ts:106`), but no production code in `cancel-ops.ts`, `task-ops.ts`, or any engine reads this from config. The schema description says "Require --reason flag" but no enforcement exists. |
| `cancellation.daysUntilArchive` | VAPORWARE | No code reads this from config. |
| `cancellation.allowCascade` | WIRED-BUT-DEAD | `deletion-strategy.ts` receives `allowCascade` as a function parameter with default `true`, but no caller passes the config value. The suggestion in the error message references this key, but it's never actually read. |
| `cancellation.defaultChildStrategy` | VAPORWARE | No code reads this from config. |

---

## Actions Taken

### 1. validation.enforceAcceptance removed from template and schema

`validation.enforceAcceptance` is a legacy boolean that predates the `enforcement.acceptance.mode` enum. The schema marks it as a regular field (not deprecated), the template still includes it, and it does nothing. Removed from schema and template.

### 2. validation.phaseValidation sub-object removed

The entire `phaseValidation` nested object (4 fields) is vaporware. Removed from schema and template.

### 3. validation.claudedocs sub-object removed

The entire `claudedocs` nested object (2 fields) is vaporware. Removed from schema and template.

### 4. validation.testing sub-object removed

The `validation.testing` nested object duplicates the top-level `testing` section. Neither is consumed. Removed from schema and template.

### 5. validation.strictMode, checksumEnabled, requireDescription, maxActiveTasks removed

Four plain booleans/integers with zero consumers. Removed from schema and template.

### 6. validation.validateDependencies and detectCircularDeps removed from template

These flags are WIRED-BUT-DEAD (functions run unconditionally). Removed from template to avoid false signal of configurability. Left schema fields with notes added as deprecated.

### 7. hierarchy.autoCompleteParent and autoCompleteMode removed from schema

Pure vaporware — not in contracts, not read anywhere. Removed.

### 8. hierarchy.requireAcceptanceCriteria removed from STRICTNESS_PRESETS

Dead write removed from all three presets in `config.ts`.

### 9. hierarchy.cascadeDelete kept

It is in the CleoConfig contract interface (`contracts/src/config.ts:41`) and in DEFAULTS. Removal would be a breaking contract change. Marked as wired-but-dead in audit but left for a follow-up contract cleanup task.

### 10. cancellation.* fields: schema updated with deprecation markers

All 5 cancellation fields are wired-but-dead or vaporware. The section is retained in the schema (removing it would be breaking for users who set these values) but all fields are annotated with deprecation. The template retains the section as-is because it is user-facing configuration.

---

## Summary Table

| Section | Total Fields | LIVE | WIRED-BUT-DEAD | VAPORWARE | Action |
|---------|-------------|------|----------------|-----------|--------|
| `validation.*` | 13 | 0 | 2 | 11 | Remove 11 from schema+template; note 2 as deprecated |
| `hierarchy.*` | 6 (schema) + 1 phantom | 4 | 1 | 1+1 phantom | Remove 2 phantom+vaporware; keep 4 live |
| `cancellation.*` | 5 | 0 | 3 | 2 | Annotate all as deprecated |

**AC satisfied**:
- `validation.enforceAcceptance` reconciled with `enforcement.acceptance.mode` — legacy removed
- All `hierarchy.*` fields consumed (4 live, 2 removed as dead, 1 phantom write removed from presets, 1 cascadeDelete noted for contract cleanup)
- Dead fields removed from schema and template
