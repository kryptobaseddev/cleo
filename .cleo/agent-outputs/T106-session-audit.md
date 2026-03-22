# T106: Session & MultiSession Config Field Audit

**Date**: 2026-03-22
**Epic**: T101 (Enforcement Gates & Drizzle SSoT Audit)
**Auditor**: CLEO subagent (Sonnet 4.6)

---

## Scope

All config fields under `session` and `multiSession` sections across:
- `packages/core/schemas/config.schema.json` — JSON schema (source of truth for what users can set)
- `packages/contracts/src/config.ts` — TypeScript interfaces (`SessionConfig`, no `MultiSessionConfig`)
- `packages/core/src/config.ts` — Defaults, ENV_MAP, strictness presets
- Runtime consumption in `packages/core/src/` and `packages/cleo/src/`
- Templates: `packages/core/templates/config.template.json` and `global-config.template.json`

---

## Critical Finding: Two Parallel Session Schemas

There are **two completely separate sets of session fields**:

| Set | Location | Field names | Used by |
|-----|----------|-------------|---------|
| **Schema-level** | `config.schema.json` `session` block | `requireSession`, `requireSessionNote`, `requireNotesOnComplete`, `warnOnNoFocus`, `allowNestedSessions`, `allowParallelAgents`, `autoStartSession`, `autoDiscoveryOnStart`, `sessionTimeoutHours`, `enforcement`, `maxConcurrent` | template only; NOT read at runtime |
| **Contracts-level** | `contracts/src/config.ts` `SessionConfig` | `autoStart`, `requireNotes`, `multiSession` | ENV_MAP + strictness presets; still NOT runtime-consumed |

These two sets have no overlap. The contracts interface `SessionConfig` is the TypeScript type for `CleoConfig.session`, meaning `config.session` in runtime returns `{ autoStart, requireNotes, multiSession }` — but NONE of those fields are ever read by runtime code to gate behavior.

---

## Session Fields — Schema Level (config.schema.json)

| # | Field | Type | Default | ENV var | Template | Runtime Consumer | Status |
|---|-------|------|---------|---------|----------|-----------------|--------|
| 1 | `session.requireSession` | boolean | true | none | project ✓ | none | VAPORWARE |
| 2 | `session.requireSessionNote` | boolean | true | none | project ✓ | none | VAPORWARE |
| 3 | `session.requireNotesOnComplete` | boolean | true | none | project ✓ | none | VAPORWARE |
| 4 | `session.warnOnNoFocus` | boolean | true | none | project ✓ | none | VAPORWARE |
| 5 | `session.allowNestedSessions` | boolean | true | none | project ✓ | none | VAPORWARE |
| 6 | `session.allowParallelAgents` | boolean | true | none | project ✓ | none | VAPORWARE |
| 7 | `session.autoStartSession` | boolean | true | none | project ✓ | none | VAPORWARE |
| 8 | `session.autoDiscoveryOnStart` | boolean | true | none | project ✓ | none | VAPORWARE |
| 9 | `session.sessionTimeoutHours` | integer (1-168) | 72 | none | project ✓ | none | VAPORWARE |
| 10 | `session.enforcement` | enum (strict/warn/advisory/none/off) | strict | none | none | `session-enforcement.ts:54` — read via `readConfigValueSync` | LIVE |
| 11 | `session.maxConcurrent` | integer (1-100) | 10 | none | none | none | VAPORWARE |

### Notes on schema-level `session.enforcement` (LIVE)

`session-enforcement.ts` reads `session.enforcement` as a **legacy fallback** after checking `enforcement.session.requiredForMutate`. The primary enforcement path is through `enforcement.session.requiredForMutate` (boolean). If that is not false, it falls back to `session.enforcement` as a mode string. This field is actually wired — but it is secondary to `enforcement.session.requiredForMutate`.

---

## Session Fields — Contracts Level (SessionConfig interface in CleoConfig.session)

These are the TypeScript `SessionConfig` fields. The contracts interface defines these three fields. They appear in `config.ts` defaults, ENV_MAP, and strictness presets — but are never read by runtime code to gate actual behavior.

| # | Field | Type | Default | ENV var | Preset | Runtime Consumer | Status |
|---|-------|------|---------|---------|--------|-----------------|--------|
| 12 | `session.autoStart` | boolean | false | `CLEO_SESSION_AUTO_START` | strict/standard/minimal: false | none | VAPORWARE |
| 13 | `session.requireNotes` | boolean | false | `CLEO_SESSION_REQUIRE_NOTES` | strict: true, others: false | none | VAPORWARE |
| 14 | `session.multiSession` | boolean | false | none | strict: false, others: true | none | VAPORWARE |

### Note on `autoStart` name collision

The identifier `autoStart` appears in `session-engine.ts`, `sessions/index.ts`, `cli/commands/session.ts`, and `tasks/analyze.ts` — but these are **CLI/API call parameters** (e.g., `--auto-start` flag on session start command, or "auto-begin the recommended task"). They have nothing to do with reading `config.session.autoStart`. No code path reads `config.session.autoStart` to alter behavior.

---

## MultiSession Fields — Schema Level (config.schema.json)

| # | Field | Type | Default | ENV var | Template (project) | Template (global) | Runtime Consumer | Status |
|---|-------|------|---------|---------|------------------|--------------------|-----------------|--------|
| 15 | `multiSession.enabled` | boolean | true | none | project ✓ | global ✓ | none | VAPORWARE |
| 16 | `multiSession.maxConcurrentSessions` | integer (1-10) | 5 | none | project ✓ | global ✓ | none | VAPORWARE |
| 17 | `multiSession.maxActiveTasksPerScope` | integer (1-3) | 1 | none | project ✓ | global ✓ | none | VAPORWARE |
| 18 | `multiSession.scopeValidation` | enum (strict/warn/none) | strict | none | project ✓ | global ✓ | none | VAPORWARE |
| 19 | `multiSession.allowNestedScopes` | boolean | true | none | project ✓ | global ✓ | none | VAPORWARE |
| 20 | `multiSession.allowScopeOverlap` | boolean | false | none | project ✓ | global ✓ | none | VAPORWARE |
| 21 | `multiSession.requireScopeOnStart` | boolean | true | none | none | none | none | VAPORWARE |
| 22 | `multiSession.sessionTimeoutHours` | integer (1-168) | 72 | none | none | none | none | VAPORWARE |
| 23 | `multiSession.autoSuspendOnTimeout` | boolean | true | none | none | none | none | VAPORWARE |
| 24 | `multiSession.historyRetentionDays` | integer (1-365) | 30 | none | none | none | none | VAPORWARE |
| 25 | `multiSession.autoResumeLastSession` | boolean | false | none | none | none | none | VAPORWARE |
| 26 | `multiSession.trackSessionStats` | boolean | true | none | none | none | none | VAPORWARE |
| 27 | `multiSession.backupOnSessionEvents` | boolean | true | none | none | none | none | VAPORWARE |

---

## Enforcement Fields (Related — Wired)

These fields are in the `enforcement` block but directly govern session enforcement:

| Field | Type | Default | Runtime Consumer | Status |
|-------|------|---------|-----------------|--------|
| `enforcement.session.requiredForMutate` | boolean | true | `session-enforcement.ts:46-51` — primary session gate | LIVE |

---

## Summary Table

| Category | Total | LIVE | VAPORWARE | WIRED-BUT-DEAD |
|----------|-------|------|-----------|----------------|
| `session.*` (schema) | 11 | 1 (`enforcement`) | 10 | 0 |
| `session.*` (contracts) | 3 | 0 | 3 | 0 |
| `multiSession.*` | 13 | 0 | 13 | 0 |
| **Total** | **27** | **1** | **26** | **0** |

---

## Vaporware List

All 26 vaporware fields. None of these are read by any runtime code path to affect behavior:

**session (schema-level)**
1. `session.requireSession` — user-settable in template but nothing reads it
2. `session.requireSessionNote` — tests set it to false via `config set` but no code enforces it
3. `session.requireNotesOnComplete` — same, tests set it but no enforcement code reads it
4. `session.warnOnNoFocus` — no code reads and acts on it
5. `session.allowNestedSessions` — `startSession()` in `sessions/index.ts` blocks scope conflicts without consulting this flag
6. `session.allowParallelAgents` — no code reads it
7. `session.autoStartSession` — no code reads it (the `autoStart` CLI flag is different)
8. `session.autoDiscoveryOnStart` — no code reads it
9. `session.sessionTimeoutHours` — `gcSessions()` uses a hardcoded `24` hour default passed as a parameter; does not read config
10. `session.maxConcurrent` — no code reads it; `startSession()` has no concurrent session cap

**session (contracts-level)**
11. `session.autoStart` — no code reads `config.session.autoStart` to conditionally gate or trigger behavior
12. `session.requireNotes` — ENV_MAP has `CLEO_SESSION_REQUIRE_NOTES` but no runtime code ever reads the resolved config value
13. `session.multiSession` — scaffold writes it; migration checks `meta.multiSessionEnabled`; nothing reads the live config value

**multiSession (all 13 fields)**
14. `multiSession.enabled`
15. `multiSession.maxConcurrentSessions`
16. `multiSession.maxActiveTasksPerScope`
17. `multiSession.scopeValidation`
18. `multiSession.allowNestedScopes`
19. `multiSession.allowScopeOverlap`
20. `multiSession.requireScopeOnStart`
21. `multiSession.sessionTimeoutHours`
22. `multiSession.autoSuspendOnTimeout`
23. `multiSession.historyRetentionDays`
24. `multiSession.autoResumeLastSession`
25. `multiSession.trackSessionStats`
26. `multiSession.backupOnSessionEvents`

---

## Template Coverage Analysis

### project `config.template.json` — `session` block

Present: `requireSession`, `requireSessionNote`, `requireNotesOnComplete`, `warnOnNoFocus`, `allowNestedSessions`, `allowParallelAgents`, `autoStartSession`, `autoDiscoveryOnStart`, `sessionTimeoutHours`

Missing from template: `enforcement`, `maxConcurrent`

Missing from schema entirely (but in template): nothing

Note: The template includes 9 schema fields but omits the 2 schema fields that actually have any runtime story (`enforcement` which is LIVE, and `maxConcurrent` which is vaporware).

### project `config.template.json` — `multiSession` block

Present: `enabled`, `maxConcurrentSessions`, `maxActiveTasksPerScope`, `scopeValidation`, `allowNestedScopes`, `allowScopeOverlap`

Missing from template: `requireScopeOnStart`, `sessionTimeoutHours`, `autoSuspendOnTimeout`, `historyRetentionDays`, `autoResumeLastSession`, `trackSessionStats`, `backupOnSessionEvents` (7 of 13)

### global `global-config.template.json` — `session` block

Missing entirely. The global template has no `session` block.

### global `global-config.template.json` — `multiSession` block

Same 6 fields as project template: `enabled`, `maxConcurrentSessions`, `maxActiveTasksPerScope`, `scopeValidation`, `allowNestedScopes`, `allowScopeOverlap`. Missing same 7.

---

## Root Cause Analysis

### Two diverging session config schemas

The `contracts/src/config.ts` `SessionConfig` interface (`autoStart`, `requireNotes`, `multiSession`) was created early for the V2 migration. The `config.schema.json` later grew a much richer `session` block with 11 different fields. These two sets have never been reconciled.

The TypeScript `CleoConfig` type uses `SessionConfig` as the type for `config.session`. This means the type system exposes `config.session.autoStart` etc., but the JSON schema allows `session.requireSession` etc. They are incompatible representations of the same config key.

### Session enforcement has two disconnected pathways

The actual session gate in `session-enforcement.ts` reads:
1. `enforcement.session.requiredForMutate` (primary, boolean)
2. `session.enforcement` (secondary fallback, mode string)

Neither `session.requireSession` (schema template) nor `contracts.SessionConfig` fields are used by the enforcement code. The `session.enforcement` schema field IS wired (LIVE), but it is in neither template.

### MultiSession is entirely hollow

All 13 `multiSession.*` config fields are vaporware. The multi-session runtime (`sessions/index.ts`, `session-enforcement.ts`, `session-engine.ts`) operates through hardcoded logic:
- `startSession()` blocks duplicate scope sessions unconditionally (no `scopeValidation` config read)
- `gcSessions()` uses a hardcoded default of 24 hours (no `sessionTimeoutHours` read)
- No concurrent session cap is enforced (no `maxConcurrentSessions` read)
- No scope overlap detection (no `allowScopeOverlap` read)

---

## Recommendations

### Priority 1 — Wire or remove (session enforcement)

1. **`session.requireSession`**: Redundant with `enforcement.session.requiredForMutate`. Remove it or map `session.requireSession` → `enforcement.session.requiredForMutate` in the config engine. The template currently sets `requireSession: true` which creates false confidence that enforcement is driven by this field.

2. **`session.requireNotes` / `session.requireNotesOnComplete` / `session.requireSessionNote`**: These three overlapping fields all intend to require notes at session end or task completion. None is wired. If this behavior is wanted, pick one field and wire it in `endSession()` and `tasks/complete.ts`. Remove the others.

3. **`session.enforcement`**: Already LIVE as a fallback. Add it to both templates.

### Priority 2 — Consolidate the two session schemas

4. **Reconcile `contracts/SessionConfig` with `config.schema.json` session block.** The contracts interface should match the schema. Either:
   - Expand `SessionConfig` to include the schema fields and deprecate the old three fields, or
   - Remove the schema fields that exist only in the template and have no contracts type

5. **Remove `session.autoStart` from contracts `SessionConfig`**: This field is set in strictness presets but never read. The `--auto-start` CLI flag serves a different purpose (auto-begin a task). Keeping the config field creates confusion.

6. **Remove `session.multiSession` from contracts `SessionConfig`**: The JSON schema has a whole `multiSession` block. Having a `session.multiSession` boolean that duplicates `multiSession.enabled` is confusing.

### Priority 3 — MultiSession: wire or remove

7. **Wire `multiSession.enabled`** as the gate in `startSession()` / `session-engine.ts` to allow/block multiple concurrent sessions. Currently `startSession()` has no concept of this flag.

8. **Wire `multiSession.maxConcurrentSessions`** in `startSession()` — count active sessions and block if limit exceeded.

9. **Wire `multiSession.scopeValidation`** in `validateTaskInScope()` — currently hardcoded to strict/warn based on `getEnforcementMode()`.

10. **Wire `multiSession.sessionTimeoutHours`** in `gcSessions()` — currently uses a hardcoded parameter default of 24.

11. **Remove or mark future** the remaining 7 `multiSession.*` fields (`requireScopeOnStart`, `autoSuspendOnTimeout`, `historyRetentionDays`, `autoResumeLastSession`, `trackSessionStats`, `backupOnSessionEvents`, `allowNestedScopes`, `allowScopeOverlap`) if there is no near-term plan to implement them. Document them as `x-status: planned` in the schema.

### Priority 4 — Template completeness

12. **Add `session.enforcement`** to both templates (currently missing but LIVE).
13. **Remove `session.requireSession`** from project template (vaporware, misleads users into thinking enforcement is driven by this field).
14. **Remove 9 vaporware session fields** from project template until they are wired, or add `// placeholder, not yet wired` comments in the schema.

---

## Files Audited

- `/mnt/projects/cleocode/packages/core/schemas/config.schema.json` — JSON schema
- `/mnt/projects/cleocode/packages/contracts/src/config.ts` — TypeScript interfaces
- `/mnt/projects/cleocode/packages/core/src/config.ts` — Defaults, ENV_MAP, presets
- `/mnt/projects/cleocode/packages/core/src/sessions/session-enforcement.ts` — Enforcement logic
- `/mnt/projects/cleocode/packages/core/src/sessions/index.ts` — Core session operations
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/session-engine.ts` — Session engine
- `/mnt/projects/cleocode/packages/core/templates/config.template.json` — Project template
- `/mnt/projects/cleocode/packages/core/templates/global-config.template.json` — Global template
