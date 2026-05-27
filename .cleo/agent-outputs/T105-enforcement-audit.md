# T105: Enforcement + Verification + Lifecycle Config Fields Audit

**Date**: 2026-03-22
**Task**: T105 (parent: T101 — Enforcement Gates & Drizzle SSoT Audit)
**Status**: complete
**Agent**: claude-sonnet-4-6

---

## Scope

Audit all fields under:
- `enforcement.*` (13 fields across 7 sub-objects)
- `verification.*` (8 fields)
- `lifecycle.*` (1 field: `lifecycle.mode`)

Sources examined:
- `packages/core/schemas/config.schema.json`
- `packages/contracts/src/config.ts` (TypeScript interface)
- `packages/core/src/config.ts` (DEFAULTS + ENV_MAP + STRICTNESS_PRESETS)
- `packages/core/src/tasks/enforcement.ts`
- `packages/core/src/tasks/add.ts`
- `packages/core/src/tasks/complete.ts`
- `packages/core/src/tasks/epic-enforcement.ts`
- `packages/core/src/sessions/session-enforcement.ts`
- `packages/cleo/src/mcp/lib/config.ts` + `defaults.ts`
- `packages/core/templates/config.template.json`
- `packages/core/templates/global-config.template.json`

---

## Field Status Table

### enforcement.*

| Field | Schema Default | Contract? | Read By Code | Behavioral Effect | Status |
|-------|---------------|-----------|-------------|-------------------|--------|
| `enforcement.size.requireOnCreate` | `false` | No | NONE | N/A | VAPORWARE |
| `enforcement.size.warnMissing` | `true` | No | NONE | N/A | VAPORWARE |
| `enforcement.size.defaultValue` | `null` | No | NONE | N/A | VAPORWARE |
| `enforcement.acceptance.mode` | `"block"` | No | `enforcement.ts`, `complete.ts` | Gates creation/completion on AC | LIVE |
| `enforcement.acceptance.requiredForPriorities` | `["critical","high","medium","low"]` | No | `enforcement.ts`, `complete.ts` | Filters which priorities enforce AC | LIVE |
| `enforcement.acceptance.minimumCriteria` | `3` | No | `enforcement.ts` | Sets min count for AC validation | LIVE |
| `enforcement.session.requiredForMutate` | `true` | No | `session-enforcement.ts` | Enables/disables session requirement gate | LIVE |
| `enforcement.pipeline.bindTasksToStage` | `true` | No | NONE | N/A | VAPORWARE |
| `enforcement.files.autoExtract` | `true` | No | NONE | N/A | VAPORWARE |
| `enforcement.files.patterns` | `["*.ts", ...]` | No | NONE | N/A | VAPORWARE |
| `enforcement.relates.autoExtract` | `true` | No | NONE | N/A | VAPORWARE |
| `enforcement.relates.bidirectional` | `false` | No | NONE | N/A | VAPORWARE |
| `enforcement.verification.autoSetImplemented` | `true` | No | NONE | N/A | VAPORWARE |

**enforcement.* summary: 4 LIVE, 9 VAPORWARE**

---

### verification.*

| Field | Schema Default | Contract? | Read By Code | Behavioral Effect | Status |
|-------|---------------|-----------|-------------|-------------------|--------|
| `verification.enabled` | `true` | No | `add.ts` (L738), `complete.ts` (L71) | Gates verification init on create; gates completion check | LIVE |
| `verification.requiredForTypes` | `["epic","task","subtask"]` | No | NONE | N/A | VAPORWARE |
| `verification.autoInitialize` | `true` | No | NONE (add.ts reads `verification.enabled` directly) | N/A | WIRED-BUT-DEAD |
| `verification.maxRounds` | `5` | No | `complete.ts` (L73, L189-194) | Blocks completion when round > maxRounds | LIVE |
| `verification.requiredGates` | `["implemented","testsPassed","qaPassed","securityPassed","documented"]` | No | `complete.ts` (L72, L199-213) | Defines which gates must pass before completion | LIVE |
| `verification.autoSetImplementedOnComplete` | `true` | No | NONE | N/A | VAPORWARE |
| `verification.requireForParentAutoComplete` | `true` | No | NONE | N/A | VAPORWARE |
| `verification.allowManualOverride` | `true` | No | NONE (no --skip-verification flag exists) | N/A | VAPORWARE |

**verification.* summary: 3 LIVE, 1 WIRED-BUT-DEAD, 4 VAPORWARE**

---

### lifecycle.*

| Field | Schema Default | Contract? | Read By Code | Behavioral Effect | Status |
|-------|---------------|-----------|-------------|-------------------|--------|
| `lifecycle.mode` | `"strict"` | Yes (`LifecycleConfig.mode`) | `epic-enforcement.ts` (L87), `complete.ts` (L74, L103-112, L205), `add.ts` (L448-452), `config.ts` ENV_MAP + STRICTNESS_PRESETS | Controls orphan prevention, epic creation gates, child stage ceiling, epic stage advancement, verification error exit code | LIVE |

**lifecycle.* summary: 1 LIVE**

---

## Note on `lifecycleEnforcement` (separate schema section)

The schema also contains a top-level `lifecycleEnforcement` object (distinct from `lifecycle`):
- `lifecycleEnforcement.mode` — loaded into MCP `MCPConfig` in `packages/cleo/src/mcp/lib/config.ts` but never consumed in any conditional logic or gate enforcement. The core enforcement reads `lifecycle.mode` (not `lifecycleEnforcement.mode`).
- This is a separate audit scope (not part of T105), but flagged here as it risks confusion.

---

## Vaporware Field List (to remove)

The following 13 fields are defined in `config.schema.json` and present in templates but are never read by any production code path. They should be removed from the schema and templates:

**enforcement sub-objects:**
1. `enforcement.size.requireOnCreate`
2. `enforcement.size.warnMissing`
3. `enforcement.size.defaultValue`
4. The entire `enforcement.size` sub-object (all 3 fields are dead)
5. `enforcement.pipeline.bindTasksToStage`
6. The entire `enforcement.pipeline` sub-object (sole field is dead)
7. `enforcement.files.autoExtract`
8. `enforcement.files.patterns`
9. The entire `enforcement.files` sub-object (all fields dead)
10. `enforcement.relates.autoExtract`
11. `enforcement.relates.bidirectional`
12. The entire `enforcement.relates` sub-object (all fields dead)
13. `enforcement.verification.autoSetImplemented`
14. The entire `enforcement.verification` sub-object (sole field is dead)

**verification fields:**
15. `verification.requiredForTypes`
16. `verification.autoSetImplementedOnComplete`
17. `verification.requireForParentAutoComplete`
18. `verification.allowManualOverride`

**Near-dead (WIRED-BUT-DEAD):**
19. `verification.autoInitialize` — The field name implies it controls initialization, but `add.ts` reads `verification.enabled` directly to decide whether to initialize. `autoInitialize` is never read. If the intent was to allow disabling initialization while keeping verification enabled, it needs to be wired. Currently, only `verification.enabled` controls init.

---

## Fields Missing from Templates

### config.template.json

The template includes `enforcement` with only:
- `enforcement.acceptance` (complete)
- `enforcement.session` (complete)
- `enforcement.pipeline` (present but dead)

Missing from template (but live in code):
- None — the 4 live `enforcement.*` fields are present in the template.

The template includes `verification` with all 8 fields — including the 4 VAPORWARE ones. The vaporware fields should be removed from the template when the schema is pruned.

### global-config.template.json

The global template includes both `enforcement` and `verification` with all fields. Same pruning applies.

---

## `CleoConfig` Contract vs Reality

The `packages/contracts/src/config.ts` `CleoConfig` interface does NOT include `enforcement`, `verification`, or the full `lifecycle.*` beyond what is in `LifecycleConfig`:

```typescript
export interface CleoConfig {
  version: string;
  output: OutputConfig;
  backup: BackupConfig;
  hierarchy: HierarchyConfig;
  session: SessionConfig;
  lifecycle: LifecycleConfig;   // Only .mode field
  logging: LoggingConfig;
  sharing: SharingConfig;
  signaldock?: SignalDockConfig;
}
```

**`enforcement` and `verification` are absent from `CleoConfig`.**

This means:
- Code reads these fields via `getRawConfigValue()` (dot-path reads on raw JSON), not via the typed `CleoConfig` interface.
- There is no TypeScript type safety for these fields at the consumer level.
- The live fields (`enforcement.acceptance.*`, `enforcement.session.requiredForMutate`, `verification.enabled`, `verification.maxRounds`, `verification.requiredGates`) should be added to `CleoConfig` with proper types.

---

## lifecycle.mode Enforcement Paths

`lifecycle.mode` gates the following behaviors:

| Code Location | Effect |
|---------------|--------|
| `epic-enforcement.ts:87` (`getLifecycleMode`) | Reads `config.lifecycle.mode`; returns `'off'` in VITEST |
| `epic-enforcement.ts:validateEpicCreation` | `strict` → throw; `advisory` → warn; `off` → skip epic creation checks |
| `epic-enforcement.ts:validateChildStageCeiling` | `strict` → throw; `advisory` → warn; `off` → skip ceiling check |
| `epic-enforcement.ts:validateEpicStageAdvancement` | `strict` → throw; `advisory` → warn; `off` → skip gate |
| `add.ts:448-458` | `strict` → block orphan task creation (non-epic without parent) |
| `complete.ts:103-112,205` | `strict` → `LIFECYCLE_GATE_FAILED`; non-strict → `GATE_DEPENDENCY` exit code |
| `config.ts:CLEO_LIFECYCLE_MODE` env var | Maps `CLEO_LIFECYCLE_MODE` env var to `lifecycle.mode` |
| `config.ts:STRICTNESS_PRESETS` | `strict` preset → `lifecycle.mode: 'strict'`; `standard` → `advisory`; `minimal` → `off'` |

**lifecycle.mode is fully wired and controls all major enforcement paths.**

---

## Recommendations

### Priority 1: Remove Vaporware from Schema

Remove the 18 dead fields from `config.schema.json`. The `enforcement.size`, `enforcement.pipeline`, `enforcement.files`, `enforcement.relates`, and `enforcement.verification` sub-objects are entirely dead. Four `verification.*` fields are dead.

Remove the same fields from both template files.

### Priority 2: Add Live Fields to `CleoConfig` Contract

The live `enforcement.*` and `verification.*` fields are read from raw config via dot-path strings. Add them to the `CleoConfig` interface in `packages/contracts/src/config.ts`:

```typescript
export interface EnforcementAcceptanceConfig {
  mode: 'off' | 'warn' | 'block';
  requiredForPriorities: string[];
  minimumCriteria: number;
}

export interface EnforcementSessionConfig {
  requiredForMutate: boolean;
}

export interface EnforcementConfig {
  acceptance: EnforcementAcceptanceConfig;
  session: EnforcementSessionConfig;
}

export interface VerificationConfig {
  enabled: boolean;
  maxRounds: number;
  requiredGates: string[];
}
```

### Priority 3: Wire or Remove WIRED-BUT-DEAD Fields

`verification.autoInitialize` is in the schema and templates but `add.ts` ignores it, reading `verification.enabled` instead. Either:
- Wire it: `add.ts` should check both `verification.enabled && verification.autoInitialize` before calling `buildDefaultVerification`.
- Remove it: collapse to just `verification.enabled` controls both enabling AND auto-initialization.

### Priority 4: Implement or Remove Future-Intent Fields

The following fields describe features documented in schema comments but not yet implemented. They should either be implemented or removed:
- `verification.autoSetImplementedOnComplete` — schema says "automatically set gates.implemented = true when ct complete runs." The code does NOT do this. Either implement it (set `task.verification.gates.implemented = true` in `complete.ts`) or remove it.
- `verification.requireForParentAutoComplete` — schema says "require verification.passed = true for parent auto-complete." The `complete.ts` auto-complete logic (L261-276) does NOT check this. Either implement or remove.
- `verification.allowManualOverride` — schema says "allow --skip-verification flag on ct complete." No such CLI flag exists.

---

## Acceptance Criteria Verification

- [x] Every `enforcement.*` field traced to code
- [x] Every `verification.*` field traced to code
- [x] `lifecycle.mode` traced to all enforcement paths
