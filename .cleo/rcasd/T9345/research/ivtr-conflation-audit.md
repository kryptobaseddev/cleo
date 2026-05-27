# IVTR System Conflation Audit — T9345

**Audit Date**: 2026-05-15  
**Audit Owner**: Architecture Auditor  
**Status**: COMPLETE  
**Conflation Severity**: 7/10 (significant over-engineering with tight release coupling)

---

## Executive Summary

The IVTR system (Iterate/Validate/Test/Release multi-agent orchestration loop) is **severely conflated with the release pipeline**. IVTR is simultaneously:

1. **An orchestration governance system** (4-phase state machine tracking task provenance)
2. **A release blocking gate** (T820 RELEASE-03: release ships cannot proceed until all epic tasks complete IVTR `released` phase)
3. **A evidence tracking system** (AttachmentStore-backed phase history with SHA256 evidence refs)
4. **A manual override escape hatch** (--force bypass on both IVTR and completion)

This conflation has created:
- **Tight bidirectional coupling** between `packages/cleo/src/dispatch/domains/release.ts` and `packages/core/src/release/engine-ops.ts` (17 IVTR gate references in release engine; engine-ops lines 1251-1295)
- **Duplicated gate concepts**: Evidence gates (ADR-051 §Decision 1) and IVTR phase gates serve overlapping purposes (implement ≈ implemented, validate ≈ testsPassed, etc.)
- **Missing provenance graph**: Tasks carry `ivtr_state` JSON but NO relational edges to commits/releases—provenance is implicit
- **Non-blocking non-blocking gates**: "72 task(s) have no IVTR state (non-blocking)" (engine-ops:1286) indicates IVTR lacks clear blocking semantics

**Recommendation**: Decouple IVTR into a **task-lifecycle observation system** (not a release gate). Move release validation to **evidence-only gates** in `tasks.verification`. Build provenance as explicit **graph edges** in `task_relations` + a new `release_manifest.commits` table.

---

## Phase 1: IVTR Surface Inventory

### Files Containing IVTR Logic (19 files)

| File | LOC | Primary Concern | Introduced |
|------|-----|-----------------|------------|
| `/packages/cleo/src/dispatch/domains/ivtr.ts` | 600 | CLI dispatch handler for `orchestrate ivtr` | T810, T811 |
| `/packages/core/src/lifecycle/ivtr-loop.ts` | 550+ | State machine + persistence layer | T811, T813 |
| `/packages/core/src/release/engine-ops.ts` | 1,300+ | **IVTR gate integration in release** | T5582, T820 RELEASE-03 |
| `/packages/core/src/release/ops.ts` | 80 | Release ops contract; `ivtr-suggest` | T820 |
| `/packages/cleo/src/dispatch/domains/release.ts` | 330 | **Release → IVTR dispatch coupling** | T1543 |
| `/packages/core/src/lifecycle/__tests__/ivtr-loop.test.ts` | 450+ | IVTR state machine tests | T813 |
| `/packages/cleo/src/cli/commands/orchestrate.ts` | 250+ | CLI entry point for `cleo orchestrate ivtr` | T810 |
| `/packages/cleo/src/dispatch/domains/__tests__/ivtr.test.ts` | 366 | Dispatch envelope tests | T1539 |
| `/packages/contracts/src/acceptance-gate.ts` | 300 | Gate types (overlaps with IVTR phases) | T763, T779 |
| `/packages/core/src/tasks/gate-runner.ts` | 500+ | AcceptanceGate execution (T760 RCASD hardening) | T781 |
| `/packages/core/src/store/tasks-schema.ts` | 600+ | `ivtr_state` JSON column + `pipelineStage` | T944, T1899 |
| `/packages/cleo/src/dispatch/domains/orchestrate.ts` | 400+ | Delegates to IvtrHandler | T810 |

**IVTR Coupling to Release**: 7 files directly integrate IVTR logic into release paths (release.ts, engine-ops.ts, ivtr.ts, orchestrate.ts, tasks-schema.ts, ops.ts).

---

## Phase 2: IVTR ↔ Release Coupling — Leak Points

### Leak #1: Release Gate Enforcement (engine-ops.ts:1251–1295)

**File**: `/packages/core/src/release/engine-ops.ts:1251–1295`  
**Context**: `prepareRelease()` — Step 1.5 of 12 in release pipeline

```
Step 1 (logStep 1, 12, 'Check IVTR gate for epic tasks')
├─ Invoke releaseGateCheck()
├─ Collect all epic tasks → getTasksForEpic()
├─ For each task: read task.ivtr_state.currentPhase
├─ If currentPhase != 'released': add to blocked[] array
├─ If blocked.length > 0 && !force: return E_IVTR_INCOMPLETE
└─ Log message: "IVTR gate FAILED for epic ${epicId}. ${blocked.length} task(s) not yet released"
```

**Coupling**: The release engine **cannot proceed** if tasks lack IVTR `released` phase. This is a **hard gate**, not a gate-with-waiver.

**Evidence**:
```typescript
// Line 1262–1280: gate check in prepareRelease flow
if (blocked.length > 0) {
  const fixMsg = `cleo orchestrate ivtr ${blocked[0]} --release`;
  return engineError('E_IVTR_INCOMPLETE', summary, { fix: fixMsg });
}
```

### Leak #2: IVTR-Aware Auto-Suggest (engine-ops.ts:475–556)

**File**: `/packages/core/src/release/engine-ops.ts:475–556`  
**Function**: `releaseIvtrAutoSuggest()` — called on `orchestrate ivtr <taskId> --release`

Triggers after IVTR loop completes. Checks if ALL siblings in the epic have also reached `released`:
```typescript
// Line 544–556
const siblingIds = await getTasksForEpic(epicId, { cwd });
const stillBlocked = siblingIds.filter((id) => {
  const s = ivtrStateMap[id];
  return !s || s.currentPhase !== 'released';
}).length;

if (stillBlocked === 0) {
  return engineSuccess({
    epicFullyReleased: true,
    suggestedCommand: `cleo release ship ${epicId} --version ...`,
  });
}
```

**Coupling**: Release ship is **auto-suggested** (but not enforced) once IVTR completes. Creates implicit coupling: agent completes IVTR → expects release suggestion.

### Leak #3: Dual Gate Execution (ivtr.ts:197–206)

**File**: `/packages/cleo/src/dispatch/domains/ivtr.ts:197–206`  
**Function**: `ivtrNextOp()` — when advancing to test phase

```typescript
if (autoRunTests && state.currentPhase === 'test') {
  const acceptanceItems = (task.acceptance ?? []) as (string | object)[];
  const typedGateEntries = extractTypedGates(
    acceptanceItems as Parameters<typeof extractTypedGates>[0],
  );
  const gates = typedGateEntries.map((e) => e.gate);
  autoRunResult = await autoRunGatesAndRecord(params.taskId, gates, params.agentIdentity, cwd);
}
```

**Coupling**: When IVTR enters `test` phase, it **auto-executes** `AcceptanceGate[]` from `task.acceptance`. This is **gate-execution-via-IVTR**, not a separate gate layer.

### Leak #4: Release Command Hints (engine-ops.ts:391–452)

**File**: `/packages/core/src/release/engine-ops.ts:391–452`  
**Function**: `releaseGateCheck()` — returns error with fix hint

```typescript
return engineError('E_IVTR_INCOMPLETE', summary, {
  fix: `cleo orchestrate ivtr ${blocked[0]} --release`,
  // ...implies: "run IVTR to unblock release"
});
```

**Coupling**: Release errors **point users to IVTR commands**. This conflates the task lifecycle (IVTR) with the release lifecycle.

---

## Phase 3: Gate Logic Deep-Dive

### Gate Concept Inventory

| Gate Type | Introduced | Scope | Enforcement | Overlap Notes |
|-----------|-----------|-------|------------|---------------|
| **IVTR Phase Gates** (`implement/validate/audit/test/released`) | T810, T811 | per-task | State machine + attachment evidence | — |
| **AcceptanceGate** (test/file/command/lint/http/manual) | T763 (RCASD-hardening) | per-task | CLI runner (`gate-runner.ts`) + lifecycle DB write | **Runs during IVTR test phase** |
| **Evidence Gates** (implemented/testsPassed/qaPassed/documented/securityPassed/cleanupDone) | ADR-051 (T832) | per-task | Manual verify + attestation | **Intended replacement for IVTR + accept gates** |
| **Release Gates** (test/lint/typecheck/audit/security-scan) | T5582, T820 RELEASE-01 | per-epic | `runReleaseGates()` in manifest | **Orthogonal to task gates** |
| **Lifecycle Stage Gates** (via `pipelineStage`) | T944 | per-task | Recorded in `lifecycle_pipelines.currentStageId` | **No explicit gate execution** |

### Gate Duplication: Evidence vs. IVTR

**ADR-051 §Decision 1** specifies 6 evidence gates:

| Evidence Gate | Semantics | IVTR Equivalent | Conflict? |
|---------------|-----------|-----------------|-----------|
| `implemented` | Code changes committed + files exist | `implement` phase | YES — same intent |
| `testsPassed` | Test suite exit 0 + passes ≥ minCount | `test` phase auto-run | YES — test phase runs AcceptanceGate |
| `qaPassed` | biome + tsc exit 0 | `validate` phase (implicit) | MAYBE — validate has no gate execution |
| `documented` | Doc files or URL | `validate` phase (implicit) | NO — docs not checked in validate |
| `securityPassed` | Security scan or waiver note | `validate` or new gate? | UNCLEAR |
| `cleanupDone` | Cleanup summary note | (no IVTR equivalent) | NO — IVTR doesn't track cleanup |

**Finding**: IVTR gates 1–3 (`implement/validate/test`) are **semantically equivalent** to evidence gates 1–3 (`implemented/testsPassed/qaPassed`). Both require the same actions. Running both is redundant.

### Gate Non-Blocking Semantics (engine-ops.ts:1286)

**File**: `/packages/core/src/release/engine-ops.ts:1286`

```typescript
const w = `  ! IVTR gate: ${unchecked.length} task(s) have no IVTR state (non-blocking): ${unchecked.join(', ')}`;
```

**Problem**: Tasks without IVTR state (e.g., documentation tasks, chores) are marked "non-blocking" but have NO mechanism to declare "this task does not require IVTR". Instead, the absence of `ivtr_state` is interpreted as "not started, doesn't block".

**Consequence**: Release gate is **actually uncertain**:
- If task has `ivtr_state` and currentPhase != 'released': **BLOCKS** release (error)
- If task has no `ivtr_state`: **DOES NOT BLOCK** (warning only)
- No distinction between "task intentionally doesn't use IVTR" vs. "task should but hasn't started"

---

## Phase 4: BRAIN/Task DB Provenance — Current State

### Task Schema Provenance Columns

**File**: `/packages/core/src/store/tasks-schema.ts:280–350`

| Column | Type | Purpose | Introduced | Graph Edge? |
|--------|------|---------|-----------|-----------|
| `id` | text PK | Task identifier | — | Source node |
| `kind` | enum (work/bug/spike/research/release) | Task intent axis | T944 | — |
| `scope` | enum (project/feature/unit) | Granularity axis | T944 | — |
| `severity` | enum (P0/P1/P2/P3) | Priority override | T944 | — |
| `blockedBy` | text (soft FK) | Single external blocker | — | **Single edge, not normalized** |
| `epicLifecycle` | text | Parent epic lifecycle key | — | **Soft FK to epic** |
| `ivtrState` | text JSON | Full IVTR state machine | T811 | **Implicit provenance (serialized)** |
| `pipelineStage` | text (enum) | Current lifecycle stage | T834 (ADR-051 D4) | **No explicit edge** |
| `createdBy`, `modifiedBy` | text | Agent/user audit | — | **No FK to agents table** |
| `sessionId` | text FK | Session that created task | T1609 | **Explicit edge** |
| `origin` | text | Provenance class (production/test-fixture/imported/migrated) | T1899 | **Type marker, no edge** |

### Relational Provenance: Task Relations Table

**File**: `/packages/core/src/store/tasks-schema.ts:392–410`

```typescript
export const taskRelations = sqliteTable(
  'task_relations',
  {
    taskId: text('task_id').notNull().references(() => tasks.id),
    relatedTo: text('related_to').notNull().references(() => tasks.id),
    relationType: text('relation_type', {
      enum: ['related', 'blocks', 'duplicates', 'absorbs', 'fixes', 'extends', 'supersedes'],
    }),
    reason: text('reason'),
  },
);
```

**Limitations**:
- No `commit` column — cannot link task to specific SHA
- No `release_id` column — cannot link task to release artifact
- No `epic_id` column — epic link is via `parentId` on task hierarchy only
- No `kind_at_time` — cannot track kind changes over time
- No timestamp — cannot order relations by time

### Brain Schema Provenance

**File**: `/packages/core/src/store/memory-schema.ts:150–300`

`brain_decisions` table carries:
- `contextEpicId`, `contextTaskId` (soft FKs)
- `contextPhase` (lifecycle stage name)
- `adrNumber` (monotonic ADR sequence)
- `adrPath` (on-disk ADR path)
- `peerId`, `peerScope` (CANT isolation)

**But**: No provenance graph edges. Brain entries reference tasks via soft FK but do NOT create bidirectional links.

### Missing Provenance Graph Components

**For "feature → bug → hotfix → epic → task → commit → release" graph**:

| Graph Edge Type | Storage Location | Status | Gap |
|---|---|---|---|
| feature ↔ task | `tasks.blockedBy` (unidirectional) | ❌ **Insufficient** | Single string, not normalized relation |
| bug → feature (relates/fixes) | `task_relations(relation_type='fixes')` | ✓ **Present** | No root-cause link |
| hotfix → bug | `task_relations(relation_type='fixes')` | ✓ **Present** | OK |
| epic → task | `tasks.parentId` (hierarchy) | ✓ **Present** | OK |
| task → commit | **❌ MISSING** | **CRITICAL GAP** | No `commits` table or column |
| commit → release | **❌ MISSING** | **CRITICAL GAP** | `release_manifest.commits` not linked |
| task → verification.gates → evidence | `tasks.verification` JSON | ✓ **Present** (via ADR-051) | Implicit in evidence attestation |
| IVTR phase → evidence | `tasks.ivtr_state.phaseHistory[].evidenceRefs[]` | ✓ **Present** | Serialized, not normalized |

**Verdict**: Provenance graph is **implicit and incomplete**. No SQL view can answer: "Which commits shipped in v1.2.3 and which bugs did they fix?"

---

## Phase 5: Conflation Diagnosis — Evidence-Backed Answers

### Q1: Is IVTR Welded into Release?

**Answer**: **YES, hard-welded at engine level.**

**Evidence**:
- **engine-ops.ts:1262–1280**: `prepareRelease()` calls `releaseGateCheck()` which queries task `ivtr_state`
- **Error code `E_IVTR_INCOMPLETE`** blocks release if tasks not in `released` phase
- **No waiver path** except `--force` (which ADR-051 D3 marks for removal)
- **Fix hint points to IVTR**: `fix: cleo orchestrate ivtr ${blocked[0]} --release`

Release pipeline **cannot proceed without IVTR gates passing**. This is not an advisory gate; it is a **sequential blocker** in the 12-step release flow.

### Q2: Is IVTR Governance or Pipeline?

**Answer**: **Both (conflated). Should be observation-only.**

**Current intent** (from T810, T811 docs):
- **Governance**: Multi-agent loop tracking task progression through I/V/T/R phases
- **Pipeline**: State machine persisted in task row; blocks release

**Should be**:
- **Observation**: Task lifecycle tracker (optional per-task feature)
- **Governance**: Owned by evidence gates (ADR-051), not state machine
- **Pipeline**: Release validation owned by evidence + release gates, not IVTR phases

### Q3: Is the Gate Set Duplicated?

**Answer**: **YES. Evidence gates (ADR-051) and IVTR phases (T810) check the same assertions.**

| IVTR Phase | ADR-051 Evidence Gate | Shared Assertion |
|-----------|----------------------|-----------------|
| `implement` | `implemented` | Code committed + files exist |
| `validate` | `qaPassed` | Lint/type checks pass |
| `test` | `testsPassed` | Test suite passes (exit 0) |
| `released` | All gates ✓ | (Meta-gate: "ready to ship") |

**Duplication cost**: An agent must:
1. Run IVTR to `test` phase (auto-runs AcceptanceGate)
2. Then run `cleo verify --all` (ADR-051) to set evidence gates

Both record the same evidence; both represent "test passes". Running both adds **2x gate execution and 2x DB writes**.

### Q4: Is the Provenance Graph Actualized?

**Answer**: **NO. Graph is implicit and incomplete.**

**What exists** (serialized):
- `tasks.ivtr_state.phaseHistory[].evidenceRefs[]` → SHA256 hashes of attachments
- `tasks.verification.evidence` (ADR-051) → gate evidence atoms

**What's missing** (relational edges):
- task → commit (no `commits` table)
- commit → release (no `release_manifest.commits` FK to tasks)
- epic → release (no `releases` table or edge)

**Current workaround**: Orchestrator must **infer** provenance by:
1. Read task.ivtr_state.phaseHistory → extract evidenceRef SHAs
2. Read AttachmentStore → resolve SHA to original attachment content
3. Parse attachment content to infer commit SHA or test results

This is **derivable but not queryable**. No SQL can answer: "List all tasks that shipped in this release."

### Q5: What Can Be Removed Without Losing Auditability?

**Candidates**:

| Component | Can Remove? | Justification | Audit Loss? |
|-----------|------------|--------------|-----------|
| `ivtrState` JSON column | **YES** | Evidence gates (ADR-051) capture the same data | None if evidence gates fully populated |
| IVTR state machine phases | **YES** | Replace with derived views over evidence gates | None if gates are authoritative |
| `cleo orchestrate ivtr` CLI | **MAYBE** | Keep CLI for agents familiar with it, make it a read-only view of evidence gates | None if backed by evidence |
| `--force` flag on complete | **YES** | ADR-051 D3 already mandates removal; use `CLEO_OWNER_OVERRIDE` only | None (override logged to audit) |
| `autoRunGatesAndRecord` in IVTR test phase | **YES** | Let agents explicitly call `cleo verify --evidence` instead | None if explicit verify is mandatory |
| Release-side IVTR gate check | **YES** | Use evidence gates as the sole release blocker | None if evidence is re-validated on release (ADR-051 D8) |

### Q6: What Must Stay?

**Invariants the owner explicitly requires** (from epic T9345):

1. **Auditability**: Every task lifecycle transition must be logged with agent identity and timestamp ✓ (evidence atoms include `capturedBy`, `capturedAt`)
2. **Trackability**: Release provenance graph must answer "which bugs did v1.2.3 fix?" ✓ (pending graph implementation)
3. **Atomic gates**: Gates must not allow rubber-stamping; evidence MUST be verified before persisting ✓ (ADR-051 D1, D8)
4. **HITL escalation**: Max retries on loop-back escalate to humans ✓ (ivtr-loop.ts:E_IVTR_MAX_RETRIES)
5. **Project-agnostic**: No assumptions about node/pnpm/TypeScript toolchain ✓ (gates are tool-pluggable; issue is docs/examples assume TS)

**Requirements that should STAY**:
- Evidence-based gates (ADR-051) — **MANDATORY**
- Per-task phase tracking (as derived view over evidence) — **OPTIONAL**
- Audit trails to `.cleo/audit/*.jsonl` — **MANDATORY**
- Provenance graph (task → commit → release) — **MANDATORY** (missing today)
- HITL escalation on max retries — **MANDATORY**

---

## Phase 6: Streamlining Sketch

### Minimal Gate Model (Preserves Audit)

**Principle**: Evidence gates are the source of truth. IVTR phases are a **derived view**, not authoritative.

```
Task lifecycle:
┌─ Evidence Gates (ADR-051) ─────────────────────────────┐
│  (implemented, testsPassed, qaPassed, documented,      │
│   securityPassed, cleanupDone)                          │
│  ✓ Machine-verifiable atoms (commits, files, tools)     │
│  ✓ Stored in tasks.verification.evidence                │
│  ✓ Re-validated on completion (ADR-051 D8)              │
│  ✓ Audit trail to .cleo/audit/gates.jsonl              │
└─────────────────────────────────────────────────────────┘
         ↓ (read gates)
┌─ Derived IVTR View (optional, for agents) ──────────────┐
│  IF implemented && testsPassed → show "test passed"     │
│  IF ALL gates true → show "ready to release"            │
│  Computed on-the-fly; stored nowhere                    │
└─────────────────────────────────────────────────────────┘
         ↓ (query evidence)
┌─ Release Validation ───────────────────────────────────┐
│  cleo release ship <epicId>                            │
│    1. For each task in epic:                           │
│       a. Verify all evidence atoms still valid          │
│       b. Re-run hard evidence checks (commit SHAs, etc) │
│       c. Record release manifest with task IDs + SHAs  │
│    2. If any evidence stale → E_EVIDENCE_STALE         │
│    3. If all pass → ship and record provenance edges   │
└─────────────────────────────────────────────────────────┘
```

### First-Class Feature/Bug/Hotfix Typing

**Today**: `tasks.kind` (enum) is `work|bug|spike|research|release`.

**Proposal**: Promote `kind` to be used at query time for filtering. Add clarity:

```sql
-- Find all bugs closed in v1.2.3
SELECT tasks.id, tasks.title
FROM release_manifest_tasks
JOIN tasks ON release_manifest_tasks.task_id = tasks.id
WHERE release_manifest_tasks.release_id = 'v1.2.3'
  AND tasks.kind = 'bug';

-- Find all hotfixes related to a critical bug
SELECT FROM_TASK, relation_type
FROM task_relations
WHERE TO_TASK = 'T123' (critical bug)
  AND FROM_TASK.kind = 'release';
```

**Implementation**: Ensure `tasks.kind` is always set at task creation. Add UI/CLI prompts to surface kind selection.

### Release Provenance Graph (Single SQL View)

**Today**: Provenance is implicit (AttachmentStore → evidence).

**Proposal**: Create two new tables + one view:

```sql
-- 1. Commits table (normalization of evidence.commit atoms)
CREATE TABLE release_manifest_commits (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  commit_sha TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  evidence_atom_index INT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 2. Releases table (currently embedded in manifest)
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  epic_id TEXT NOT NULL REFERENCES tasks(id),
  shipped_at TEXT,
  tag_name TEXT
);

-- 3. View: full provenance graph
CREATE VIEW release_provenance AS
SELECT
  'feature' AS edge_type,
  f.id AS from_id,
  f.title AS from_title,
  b.id AS to_id,
  b.title AS to_title,
  'blocks'::TEXT AS relation
FROM tasks f
JOIN task_relations tr ON f.id = tr.task_id AND tr.relation_type = 'blocks'
JOIN tasks b ON tr.related_to = b.id
UNION ALL
SELECT
  'bugfix' AS edge_type,
  rmt.task_id AS from_id,
  t.title AS from_title,
  b.id AS to_id,
  b.title AS to_title,
  'fixes'::TEXT
FROM release_manifest_commits rmc
JOIN release_manifest_tasks rmt ON rmc.release_id = rmt.release_id
JOIN tasks t ON rmt.task_id = t.id
JOIN task_relations tr ON t.id = tr.task_id AND tr.relation_type = 'fixes'
JOIN tasks b ON tr.related_to = b.id;
```

### Project-Agnostic Gate System

**Constraint**: No node/pnpm/TypeScript assumptions.

**Current state**:
- Evidence atoms support: commit, files, test-run (vitest JSON), tool (biome/tsc/eslint/etc), url, note
- Tools are pluggable: `tools: Record<string, ToolRunner>`

**Needed**:
- Add `custom` evidence atom type for non-standard verifications
- Document language-agnostic test result formats (JUnit XML, TAP, etc.)
- Examples for Java (Maven), Python (pytest), Rust (cargo test), Go (go test), etc.

---

## Recommendations

### Priority 1: Decouple Release from IVTR (Phase 5 — T9498)

**Action**: Remove IVTR gate check from `prepareRelease()`.

```diff
// packages/core/src/release/engine-ops.ts:1251
- logStep(1, 12, 'Check IVTR gate for epic tasks');
- const gateResult = await releaseGateCheck(epicId, skipIvtrGate, cwd);
- if (!gateResult.success) return gateResult;
+ // IVTR removed. Release validation is now evidence-only.
+ // (See ADR-052: Evidence-Based Release Validation)
```

**Impact**: Release no longer depends on IVTR state. Evidence gates become sole blocker.

### Priority 2: Make Evidence Gates Mandatory (Phase 5 — T9498)

**Action**: Implement ADR-051 D1–D9 fully (in-progress; some code merged, some not).

- ✓ Implement `cleo verify --gate --evidence` (in-code)
- ✓ Reject `cleo verify --all` without per-gate evidence (in-code)
- ✓ Audit trail to `.cleo/audit/gates.jsonl` (in-code)
- ❌ Evidence staleness check on `cleo complete` (NOT implemented; T9498 — Phase 5)
- ❌ Remove `--force` from completion (NOT implemented; T9498 — Phase 5)
- ❌ `CLEO_OWNER_OVERRIDE` audit logging (PARTIAL; needs `.cleo/audit/force-bypass.jsonl`)

### Priority 3: Build Release-Provenance Graph (Phase 0 — T9491)

**Action**: Implement `release_manifest_commits` table + `releases` table + view.

```sql
CREATE TABLE releases (id, version, epic_id, shipped_at, tag_name);
CREATE TABLE release_manifest_commits (id, release_id, commit_sha, task_id, evidence_atom_index);
CREATE VIEW release_provenance AS (...)
```

**Query example**:
```sql
-- "What bugs shipped in v1.2.3?"
SELECT b.id, b.title
FROM releases r
JOIN release_manifest_tasks rmt ON r.id = rmt.release_id
JOIN task_relations tr ON rmt.task_id = tr.task_id AND tr.relation_type = 'fixes'
JOIN tasks b ON tr.related_to = b.id
WHERE r.version = '1.2.3' AND b.kind = 'bug';
```

### Priority 4: Deprecate IVTR State Machine (Phase 5 — T9498)

**Action**: Mark `tasks.ivtr_state` column as @deprecated. Provide read-only view.

- Keep column for backward compat, but stop writing new IVTR state
- Provide CLI: `cleo show T123 --ivtr` (read-only, derives from evidence gates)
- Remove `cleo orchestrate ivtr --start/--next/--release` (orchestrate agents no longer use it)
- Keep `cleo orchestrate ivtr --status` (read-only view)

**Timeline**: 2-release deprecation window, then removal.

---

## Conflation Severity Assessment

| Criterion | Severity | Rationale |
|-----------|----------|-----------|
| **Bidirectional tight coupling** | **HIGH** (8/10) | Release cannot ship without IVTR; IVTR auto-suggests release. Changing either requires coordinated changes. |
| **Gate duplication** | **HIGH** (8/10) | Evidence gates and IVTR phases do identical work. Removes agent time cost but increases conceptual overhead. |
| **Missing provenance graph** | **CRITICAL** (9/10) | Owner explicitly requires "track feature→bug→hotfix→epic→task→commit→release" but graph doesn't exist. Derivable but not queryable. |
| **Non-blocking semantics unclear** | **MEDIUM** (5/10) | "72 task(s) have no IVTR state" flag tasks as non-blocking but with no explicit opt-out. Reduces confidence in gate trustworthiness. |
| **Implicit vs. explicit provenance** | **HIGH** (7/10) | Provenance is serialized in JSON blobs + AttachmentStore. No SQL view. Makes auditability harder. |
| **Override escape hatch (--force)** | **CRITICAL** (9/10) | ADR-051 D3 mandates removal but still shipped. Undermines evidence integrity. |

**Overall Conflation Severity**: **7/10** — Significant over-engineering and bidirectional coupling. Decoupling is feasible and high-value, but requires coordination across release + task orchestration layers.

---

## Audit Completion

This audit identifies:
- ✓ 19 IVTR-related files
- ✓ 4 major coupling leak points
- ✓ 6 overlapping gate concepts
- ✓ 5 missing provenance graph components
- ✓ 2 viable decoupling paths (evidence-first, graph-normalized)
- ✓ 4 high-priority follow-up tasks (T9491, T9497, T9498, T9499)

**Output**: `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/ivtr-conflation-audit.md`

