# ADR-018: Unified Status Registry

**Date**: 2026-02-26
**Status**: accepted
**Amends**: ADR-006 (§4 Lifecycle Pipeline/Stage enums)
**Related ADRs**: ADR-006, ADR-009, ADR-014, ADR-017
**Related Tasks**: TBD
**Gate**: HITL
**Gate Status**: passed
**Summary**: Consolidates all status enumerations into a single source of truth at src/store/status-registry.ts. Eliminates scattered hardcoded strings for task, session, lifecycle pipeline/stage, ADR, gate, and manifest statuses.
**Keywords**: status, enum, registry, task-status, session-status, lifecycle, pipeline, stage
**Topics**: tasks, session, pipeline, storage, schema

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

CLEO had at least **8 separate status enum types** defined across the codebase with no canonical reference. Key problems:

**Duplicate constant names with different values**: `VALID_STATUSES` appeared in 5 separate files with 3 distinct value sets — any import of the wrong one caused silent validation bugs.

**Semantic drift**: `complete` (manifest) vs `completed` (lifecycle) vs `done` (task); `pending` (task/gate) vs `not_started` (lifecycle stage).

**No queryable registry**: Validating "is this a valid status for entity X?" required reading TypeScript source.

**No terminal-state documentation**: Nothing declared which statuses are end-states vs. transitional.

**Hardcoded display logic**: Status icons defined as ternary chains (`stageStatus === 'in_progress' ? '▶' : ...`) inside business logic files — no exhaustiveness guarantee, invisible to new status additions.

---

## 2. Decision

**ADR-018 establishes a Unified Status Registry** as the single source of truth for all status values and their display representations in CLEO.

The registry is implemented in two layers:

1. **TypeScript file** (`src/store/status-registry.ts`) — compile-time source of truth: status arrays, derived types, terminal-state sets, display icon maps
2. **SQLite table** (`status_registry`) — runtime-queryable, enables MCP-level introspection

All status constant definitions and all status icon definitions outside `src/store/status-registry.ts` MUST be removed and replaced with imports from that file.

---

## §1 Status Namespaces

Status values are organized into three namespaces based on semantic domain.

### §1.1 Workflow Namespace

Statuses for entities representing **work being performed**: tasks, sessions, lifecycle pipelines, lifecycle stages.

| Name | Applies To | Terminal? | Meaning |
|---|---|---|---|
| `pending` | task, gate | No | Created; queued; not yet started |
| `not_started` | lifecycle_stage | No | Stage exists but has not been entered. Distinct from `pending` to clarify pipeline entry semantics |
| `active` | task, session, pipeline | No | Being worked on at the top-level entity scope |
| `in_progress` | lifecycle_stage | No | Stage is currently executing. Distinct from `active` because stages are substeps within a pipeline |
| `blocked` | task, session, pipeline, lifecycle_stage | No | Cannot advance; waiting on dependency, decision, or external factor |
| `suspended` | session | No | Paused; may be resumed |
| `done` | task | Yes | Work complete. User-facing canonical for tasks (`ct done T1234`). MUST NOT be renamed |
| `completed` | pipeline, lifecycle_stage | Yes | Execution complete. Internal machinery — never surfaces in user-facing CLI |
| `failed` | pipeline, lifecycle_stage | Yes | Terminal failure during execution |
| `skipped` | lifecycle_stage | Yes | Stage intentionally bypassed |
| `cancelled` | task, pipeline | Yes | Abandoned; will not be completed (user-initiated) |
| `archived` | task | Yes | Removed from active view; historical record |
| `orphaned` | session | Yes | Session terminated without proper close |
| `aborted` | pipeline | Yes | Pipeline forcibly terminated by the system (error recovery, crash) |
| `ended` | session | Yes | Session ended normally |

**Note on `done` vs `completed`**: Kept separate intentionally. `done` is the user-facing verb; changing it breaks `ct done T1234`. `completed` is internal pipeline/stage machinery. Same semantic outcome, different abstraction layers.

**Note on `pipeline` vs `stage` active states**: `active` at the pipeline level means the pipeline as a whole is running. `in_progress` at the stage level means a specific stage within that pipeline is currently executing. These are parallel not competing.

### §1.2 Governance Namespace

Statuses for entities representing **decisions and approvals**: ADRs, gate results.

| Name | Applies To | Terminal? | Meaning |
|---|---|---|---|
| `proposed` | adr | No | Drafted; pending consensus review |
| `accepted` | adr | No | Approved via consensus or HITL. Not terminal — may later be superseded |
| `superseded` | adr | Yes | Replaced by a newer ADR |
| `deprecated` | adr | Yes | No longer applicable; not replaced |
| `pending` | gate | No | Gate not yet evaluated |
| `passed` | gate | Yes | Gate conditions satisfied |
| `failed` | gate | Yes | Gate conditions not met |
| `waived` | gate | Yes | Gate bypassed by deliberate decision |

### §1.3 Manifest Namespace

Statuses for **protocol output artifacts** from research, consensus, and orchestrator runs.

| Name | Terminal? | Meaning |
|---|---|---|
| `completed` | Yes | Output fully complete and validated. Replaced `complete` (old spelling) |
| `partial` | No | Output produced but incomplete; may be continued |
| `blocked` | No | Could not complete; requires intervention |
| `archived` | Yes | Output retained for historical record |

**Breaking rename**: `complete` → `completed`. Aligns with lifecycle/governance terminal state spelling. Enforced in §2.3.

---

## §2 TypeScript Implementation

### §2.1 Single Source File

All status definitions MUST live in `src/store/status-registry.ts`. No other file MAY define status enum arrays as constants — they MUST import from this file. There is no backward-compatibility layer; all import sites are updated in the same change.

```typescript
// src/store/status-registry.ts

// Status arrays
export const TASK_STATUSES = ['pending','active','blocked','done','cancelled','archived'] as const;
export const SESSION_STATUSES = ['active','ended','orphaned','suspended'] as const;
export const LIFECYCLE_PIPELINE_STATUSES = ['active','completed','blocked','failed','cancelled','aborted'] as const;
export const LIFECYCLE_STAGE_STATUSES = ['not_started','in_progress','blocked','completed','skipped','failed'] as const;
export const ADR_STATUSES = ['proposed','accepted','superseded','deprecated'] as const;
export const GATE_STATUSES = ['pending','passed','failed','waived'] as const;
export const MANIFEST_STATUSES = ['completed','partial','blocked','archived'] as const;

// Derived types
export type TaskStatus     = typeof TASK_STATUSES[number];
export type SessionStatus  = typeof SESSION_STATUSES[number];
export type PipelineStatus = typeof LIFECYCLE_PIPELINE_STATUSES[number];
export type StageStatus    = typeof LIFECYCLE_STAGE_STATUSES[number];
export type AdrStatus      = typeof ADR_STATUSES[number];
export type GateStatus     = typeof GATE_STATUSES[number];
export type ManifestStatus = typeof MANIFEST_STATUSES[number];

// Terminal state sets
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus>   = new Set(['done','cancelled','archived']);
export const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(['completed','skipped','failed']);

// Registry for runtime queryability
export type EntityType = 'task'|'session'|'lifecycle_pipeline'|'lifecycle_stage'|'adr'|'gate'|'manifest';
export const STATUS_REGISTRY: Record<EntityType, readonly string[]> = { ... };
export function isValidStatus(entityType: EntityType, value: string): boolean { ... }

// Display icon maps — see §2.4
export const STAGE_STATUS_ICONS: Record<StageStatus, string> = { ... };
export const TASK_STATUS_SYMBOLS_UNICODE: Record<TaskStatus, string> = { ... };
export const TASK_STATUS_SYMBOLS_ASCII: Record<TaskStatus, string> = { ... };
```

### §2.2 `src/store/schema.ts` — Consumer, Not Definer

`src/store/schema.ts` MUST import from `status-registry.ts` and pass the arrays directly to Drizzle column `{ enum: }` parameters. It MUST NOT define any status constant itself.

```typescript
import { TASK_STATUSES, SESSION_STATUSES, LIFECYCLE_PIPELINE_STATUSES,
         LIFECYCLE_STAGE_STATUSES, ADR_STATUSES, GATE_STATUSES } from './status-registry.js';

// Drizzle columns accept readonly string[] directly:
status: text('status', { enum: TASK_STATUSES }).notNull().default('pending')
```

### §2.3 Definitions Deleted

All of the following MUST be deleted and replaced with imports from `status-registry.ts`:

| File | Delete | Replace With |
|---|---|---|
| `src/store/schema.ts` | Inline `TASK_STATUSES`, `SESSION_STATUSES`, `LIFECYCLE_PIPELINE_STATUSES`, `LIFECYCLE_STAGE_STATUSES` constant blocks | Import from `./status-registry.js` |
| `src/types/task.ts` | `type TaskStatus` (was missing `archived`) | `import type { TaskStatus }` from registry |
| `src/types/session.ts` | `type SessionStatus` (was missing `suspended`) | `import type { SessionStatus }` from registry |
| `src/types/operations/tasks.ts` | Local `TaskStatus` type | `import type { TaskStatus }` from registry |
| `src/types/operations/lifecycle.ts` | Local `StageStatus` type (had wrong values `pending`/`active`) | `import type { StageStatus }` from registry |
| `src/core/validation/engine.ts` | `VALID_STATUSES` alias, `TaskStatus` type, `VALID_PHASE_STATUSES` | Import `TASK_STATUSES`, `TaskStatus` from registry |
| `src/core/validation/index.ts` | `VALID_STATUSES` re-export | Export `TASK_STATUSES` instead |
| `src/mcp/lib/security.ts` | `VALID_STATUSES`, `VALID_MANIFEST_STATUSES`, `VALID_LIFECYCLE_STAGE_STATUSES`, `ALL_VALID_STATUSES` | Import from registry |
| `src/dispatch/lib/security.ts` | Same four exports | Same imports |
| `src/mcp/lib/gate-validators.ts` | Inline literal inside `VALIDATION_RULES` object | `VALID_STATUSES: TASK_STATUSES`, `VALID_MANIFEST_STATUSES: MANIFEST_STATUSES` (object properties, not bare exports) |
| `src/core/skills/orchestrator/validator.ts` | Local `VALID_STATUSES` Set | `MANIFEST_STATUS_SET = new Set(MANIFEST_STATUSES)` |
| `src/core/skills/manifests/research.ts` | Local `VALID_STATUSES` Set | `MANIFEST_STATUS_SET = new Set(MANIFEST_STATUSES)` |
| `src/core/validation/protocol-common.ts` | `VALID_STATUSES_MSG` | `MANIFEST_STATUSES.filter(s => s !== 'archived')` for message pattern |
| `src/store/schema.ts` ADR inline literals | `['proposed','accepted','superseded','deprecated']`, `['pending','passed','waived']` | `enum: ADR_STATUSES`, `enum: GATE_STATUSES` |
| `src/core/lifecycle/stages.ts` | Local `StageStatus` union (was locally defined) | `import type { StageStatus }` from registry, re-export for consumers |
| `src/core/lifecycle/pipeline.ts` | Local `PipelineStatus` type | `import type { PipelineStatus }` from registry |
| `src/core/lifecycle/resume.ts` | `ResumablePipeline.status` as local `'active' \| 'completed' \| 'aborted'` | `status: PipelineStatus` from registry |
| `src/cli/renderers/colors.ts` | `statusSymbol()` switch/case body (hardcoded, missing `archived`) | `TASK_STATUS_SYMBOLS_UNICODE[status]` / `TASK_STATUS_SYMBOLS_ASCII[status]` from registry |

### §2.4 Display Icons (canonical decision)

**All status-to-icon mappings MUST be defined in `src/store/status-registry.ts` as typed `Record<Status, string>` maps.**

**Defined maps:**

`PIPELINE_STATUS_ICONS: Record<PipelineStatus, string>`
| Status | Icon | Meaning |
|---|---|---|
| `active` | ▶ | Pipeline is running |
| `completed` | ✓ | All stages done |
| `blocked` | ⏸ | Cannot advance |
| `failed` | ✗ | Terminal failure |
| `cancelled` | ⊘ | User-initiated abandonment |
| `aborted` | ⏹ | System-forced termination |

Rationale: A `Record<StageStatus, string>` forces the compiler to flag the map as incomplete whenever a new `StageStatus` is added to the registry. A ternary chain or `switch` over string literals silently falls through — the compiler has no way to know all cases are covered.

```typescript
// ✗ Forbidden — ternary chain, silent fallthrough, no exhaustiveness
const icon = s === 'in_progress' ? '▶' : s === 'blocked' ? '⏸' : '⏹';

// ✓ Required — typed Record, compiler enforces every status has an entry
const icon = STAGE_STATUS_ICONS[s] ?? STAGE_STATUS_ICONS.not_started;
```

`STAGE_STATUS_ICONS: Record<StageStatus, string>`
| Status | Icon | Meaning |
|---|---|---|
| `not_started` | ⏹ | Not yet entered |
| `in_progress` | ▶ | Actively running |
| `blocked` | ⏸ | Paused / waiting |
| `completed` | ✓ | Finished successfully |
| `skipped` | ⏭ | Intentionally bypassed |
| `failed` | ✗ | Terminal failure |

`TASK_STATUS_SYMBOLS_UNICODE: Record<TaskStatus, string>` — for Unicode-capable terminals

| Status | Icon |
|---|---|
| `pending` | ○ |
| `active` | ◉ |
| `blocked` | ⊗ |
| `done` | ✓ |
| `cancelled` | ✗ |
| `archived` | ▣ |

`TASK_STATUS_SYMBOLS_ASCII: Record<TaskStatus, string>` — ASCII fallback (CI, non-UTF locales)

| Status | Symbol |
|---|---|
| `pending` | `-` |
| `active` | `*` |
| `blocked` | `x` |
| `done` | `+` |
| `cancelled` | `~` |
| `archived` | `#` |

**Rule**: Any new entity type that requires terminal rendering MUST add its icon map to `status-registry.ts` alongside its status array, in the same commit. Icon maps are not optional decoration — they are part of the status definition.

**DB icon column**: Not added to `status_registry` table in this ADR. Icons are a presentation concern and are fully covered by the TypeScript maps above. If future agents need to query icons at runtime via MCP, a follow-up migration can add `icon TEXT` to `status_registry`.

---

## §3 Database Schema

### §3.1 Status Registry Table

```sql
CREATE TABLE status_registry (
  name         TEXT NOT NULL,
  entity_type  TEXT NOT NULL CHECK(entity_type IN (
                 'task', 'session', 'lifecycle_pipeline', 'lifecycle_stage',
                 'adr', 'gate', 'manifest'
               )),
  namespace    TEXT NOT NULL CHECK(namespace IN ('workflow', 'governance', 'manifest')),
  description  TEXT NOT NULL,
  is_terminal  INTEGER NOT NULL DEFAULT 0 CHECK(is_terminal IN (0, 1)),
  PRIMARY KEY (name, entity_type)
);
```

**Seed-only, read-only at runtime.** Application code MUST NOT mutate this table after initial migration. Its purpose is introspection — agents can query it without reading TypeScript source.

**`cancelled` vs `aborted` for pipelines**: Both are terminal. `cancelled` is user-initiated (a deliberate decision to abandon the pipeline — call `cancelPipeline()`). `aborted` is system-forced (error recovery, crash, or external termination). The DB CHECK constraint on `lifecycle_pipelines.status` includes both values (see migration `20260227100000_add-cancelled-pipeline-status`).

### §3.2 MCP Query Surface

The `admin` domain MUST expose:

```
admin.status.list                        → all registry entries
admin.status.list { entity_type }        → statuses for one entity type
admin.status.list { namespace }          → statuses for one namespace
admin.status.list { is_terminal: true }  → terminal states only
```

---

## §4 Corrections to ADR-006 §4

ADR-006 §4 documents stale schema values. This ADR supersedes those specific enum lists:

| Entity | ADR-006 §4 (stale) | ADR-018 §1 (canonical) |
|---|---|---|
| `lifecycle_pipelines.status` | `active, completed, suspended, failed` | `active, completed, blocked, failed, cancelled, aborted` |
| `lifecycle_stages.status` | `pending, in_progress, completed, blocked, skipped` | `not_started, in_progress, blocked, completed, skipped, failed` |

ADR-006 §§1–3 and §§5+ remain authoritative. Only the enum value lists in §4 are superseded.

---

## §5 Implementation Findings

Issues discovered during implementation that are now codified as binding rules:

### §5.1 `VALID_PHASE_STATUSES` removed

`src/core/validation/engine.ts` defined `VALID_PHASE_STATUSES = ['pending', 'active', 'completed']`. This was a subset of session/task statuses with no distinct identity. It is deleted entirely — callers that need phase status validation must use `SESSION_STATUSES` or the relevant entity-specific constant.

### §5.2 `StageStatus` had wrong values in lifecycle files

`src/core/lifecycle/resume.ts` used a local `DbStageStatus` mapped from `'active' | 'pending'` — both invalid stage status values (the DB only accepts `'in_progress'` and `'not_started'`). TypeScript surfaced 5 runtime bugs the moment the type was corrected to use the registry's `StageStatus`. These were latent DB write failures.

### §5.3 `TaskStatus` was missing `'archived'` in multiple type files

`src/types/task.ts`, `src/types/operations/tasks.ts`, `src/core/validation/engine.ts` all defined `TaskStatus` without `'archived'`. This meant `validateStatus('archived')` would throw even though the DB column accepts it. Fixed by importing `TaskStatus` from registry everywhere.

### §5.4 Schema-parity guardrail

`src/store/__tests__/lifecycle-schema-parity.test.ts` verifies that the latest lifecycle DB migration contains all current `LIFECYCLE_PIPELINE_STATUSES` and `LIFECYCLE_STAGE_STATUSES` values. Any change to those arrays in the registry MUST be accompanied by a new migration that updates the `CHECK` constraint, or the test will fail. This test is the enforcement mechanism — do not bypass it.

### §5.5 Ternary chains over status strings are prohibited

Any comparison of the form `status === 'x' ? iconA : status === 'y' ? iconB : fallback` for display purposes is prohibited. Use the appropriate `Record<Status, string>` map from `status-registry.ts`. The compiler enforces exhaustiveness; ternary chains do not.

---

## 3. Authority Hierarchy

```
ADR-018 (this doc)
    ↓ implemented in
src/store/status-registry.ts       → single definition point for:
                                     status arrays, derived types,
                                     terminal sets, display icon maps
    ↓ imported by (status arrays + types)
src/store/schema.ts                → Drizzle column { enum: } params
src/types/task.ts                  → TaskStatus
src/types/session.ts               → SessionStatus
src/types/operations/tasks.ts      → TaskStatus
src/types/operations/lifecycle.ts  → StageStatus
src/core/lifecycle/stages.ts       → StageStatus (re-exported)
src/core/lifecycle/pipeline.ts     → PipelineStatus
src/core/lifecycle/resume.ts       → PipelineStatus, StageStatus
src/core/validation/engine.ts      → TASK_STATUSES, TaskStatus
src/mcp/lib/security.ts            → TASK_STATUSES, MANIFEST_STATUSES
src/dispatch/lib/security.ts       → TASK_STATUSES, MANIFEST_STATUSES
src/mcp/lib/gate-validators.ts     → TASK_STATUSES, MANIFEST_STATUSES
src/core/skills/*/validator.ts     → MANIFEST_STATUSES
    ↓ imported by (display icons)
src/cli/renderers/colors.ts        → TASK_STATUS_SYMBOLS_UNICODE/ASCII
src/core/lifecycle/resume.ts       → STAGE_STATUS_ICONS
    ↓ seeded into
SQLite: status_registry table      → runtime queryability
    ↓ surfaced by
admin.status.list MCP operation    → agent introspection
```

---

## 4. Rationale

### 4.1 Why not a single flat enum?

Forcing all statuses into one set would conflate unrelated domains. A task being `proposed` is not meaningful; an ADR being `done` is not meaningful. The namespace model preserves semantic precision while eliminating hidden duplication.

### 4.2 Why keep `done` vs `completed`?

`done` is a UX boundary: `ct done T1234` is the user-facing completion verb (canonical per ADR-017 §1). `completed` is internal pipeline/stage machinery. Same semantic outcome, different abstraction layers. Renaming `done` would be a breaking CLI change.

### 4.3 Why a DB table?

TypeScript `as const` arrays are compile-time only. An agent validating a status value via MCP at runtime has no access to TypeScript types. The `status_registry` table provides the same validation without TypeScript coupling.

### 4.4 Why `VALID_STATUSES` is abolished

The name appeared with three different value sets in five files. It is an ambiguous name that caused silent import bugs. All exports from `status-registry.ts` use specific, unambiguous names. The generic name `VALID_STATUSES` MUST NOT be used as a new export name anywhere in the codebase.

### 4.5 Why icons belong in the registry

Status icons are tightly coupled to status identity — every time a new status is added, its icon must be defined. Co-locating icons in the registry:
- Makes the registry the only file to update when a status is added
- Gives the compiler exhaustiveness enforcement via `Record<Status, string>`
- Prevents display bugs where new statuses silently fall to a wrong default

---

## 5. Consequences

### 5.1 Positive

- One file defines all valid status values, types, terminal states, and display icons
- Compiler enforces completeness of icon maps when new statuses are added
- `VALID_STATUSES` name collision eliminated
- `TaskStatus` now correctly includes `'archived'`
- `StageStatus` corrected from `'pending'/'active'` to `'not_started'/'in_progress'` — surfaced 5 latent runtime bugs
- `complete` → `completed` aligns manifest statuses with the rest of the system
- `colors.ts` now handles `'archived'` (was silently returning `'?'`)
- ADR-006 §4 ambiguity resolved

### 5.2 Breaking Changes

| Change | Impact |
|---|---|
| `complete` → `completed` in manifest statuses | Any `=== 'complete'` check on manifest entries must be updated |
| `VALID_STATUSES` export deleted from `engine.ts`, `security.ts` | Callers must import `TASK_STATUSES` or `MANIFEST_STATUSES` by name |
| `TaskStatus` gains `'archived'` | Exhaustive `switch` on `TaskStatus` must add `case 'archived'` |
| `ALL_VALID_STATUSES` deleted | Replaced by combining `TASK_STATUSES` and `MANIFEST_STATUSES` at call site |
| `VALID_PHASE_STATUSES` deleted | No replacement; callers were using it incorrectly |
| `StageStatus` values corrected | Code using `'active'` or `'pending'` as stage statuses was always wrong; TypeScript now catches it |

### 5.3 Implementation Sequence (completed)

1. ✅ Create `src/store/status-registry.ts` with all status arrays, types, terminal sets, and display icon maps
2. ✅ Update `src/store/schema.ts`: delete inline constant blocks, import from registry, pass to Drizzle columns
3. ✅ Update all 17 files listed in §2.3: delete local definitions, import from registry
4. ✅ Add `status_registry` DB migration (seeded, read-only at runtime)
5. ✅ Replace ternary chain in `resume.ts` with `STAGE_STATUS_ICONS` lookup
6. ✅ Replace switch/case in `colors.ts` with `TASK_STATUS_SYMBOLS_UNICODE/ASCII` maps; add `'archived'`
7. ⬜ Add `admin.status.list` MCP operation (follow-up task)
8. ⬜ Consider adding `icon TEXT` column to `status_registry` DB table if runtime icon queries become needed
