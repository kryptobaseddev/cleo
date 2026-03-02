# PROJECT-LIFECYCLE-SPEC

**Status**: DRAFT
**Version**: 1.0.0
**Created**: 2026-03-02
**Updated**: 2026-03-02
**Epic**: T4454
**Tasks**: T4467, T4785, T4798, T4800, T4801, T4805

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## 1. Overview

### 1.1 Purpose

The Project Lifecycle System provides structured, gate-enforced progression for epics and large work items in CLEO. It implements the RCASD-IVTR pipeline model: a 9-stage lifecycle that guides work from initial research through final release, with prerequisite enforcement, gate checks, evidence recording, and cross-session resume capabilities.

### 1.2 Design Goals

- **Prevent premature execution**: Gate enforcement blocks implementation before research and specification are complete.
- **Maintain audit trails**: Every stage transition, gate check, and evidence attachment is recorded in SQLite.
- **Support cross-session continuity**: Agents resuming work across sessions can discover and continue in-progress pipelines.
- **Accommodate flexibility**: Stages MAY be skipped (where defined as skippable), enforcement modes are configurable, and forced transitions are available for rework scenarios.

### 1.3 Authority

This specification is **AUTHORITATIVE** for:

- RCASD-IVTR stage definitions, ordering, and prerequisites
- Pipeline initialization patterns (greenfield/brownfield/grayfield)
- Gate enforcement architecture and HITL integration
- Lifecycle SQLite schema documentation
- Exit codes 80-84 (lifecycle enforcement)

This specification **DEFERS TO**:

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) for protocol-level validation functions and exit codes 60-67
- [CLEO-OPERATIONS-REFERENCE.md](CLEO-OPERATIONS-REFERENCE.md) for the canonical MCP operation matrix
- [CLEO-STRATEGIC-ROADMAP-SPEC.md](CLEO-STRATEGIC-ROADMAP-SPEC.md) for strategic context and phase gating

---

## 2. RCASD-IVTR Lifecycle Model

### 2.1 Stage Overview

The pipeline consists of 9 ordered stages grouped into 5 categories. The canonical stage names are defined in `src/core/lifecycle/stages.ts` and MUST match the SQLite CHECK constraint on `lifecycle_stages.stage_name`.

| Order | Stage Name             | Display Name           | Category   | Skippable |
|-------|------------------------|------------------------|------------|-----------|
| 1     | `research`             | Research               | planning   | No        |
| 2     | `consensus`            | Consensus              | decision   | Yes       |
| 3     | `architecture_decision`| Architecture Decision  | decision   | Yes       |
| 4     | `specification`        | Specification          | planning   | No        |
| 5     | `decomposition`        | Decomposition          | planning   | No        |
| 6     | `implementation`       | Implementation         | execution  | No        |
| 7     | `validation`           | Validation             | validation | No        |
| 8     | `testing`              | Testing                | validation | No        |
| 9     | `release`              | Release                | delivery   | Yes       |

A 10th value, `contribution`, exists in the schema as a cross-cutting stage for attribution and provenance recording. It is NOT part of the pipeline execution order.

### 2.2 Category Groupings

Stages are grouped into categories for filtering and reporting:

- **Planning** (`planning`): research, specification, decomposition
- **Decision** (`decision`): consensus, architecture_decision
- **Execution** (`execution`): implementation
- **Validation** (`validation`): validation, testing
- **Delivery** (`delivery`): release

### 2.3 Stage Definitions

#### 2.3.1 Research (Stage 1)

**Purpose**: Information gathering, exploration, and knowledge acquisition.

- **Prerequisites**: None (entry point).
- **Required Gates**: `prerequisites-met`
- **Expected Artifacts**: research-report, findings-document
- **Completion Criteria**: Research output file exists in `.cleo/agent-outputs/`, key findings documented, no code changes produced.

#### 2.3.2 Consensus (Stage 2)

**Purpose**: Multi-agent decision making and validation of research findings.

- **Prerequisites**: `research`
- **Required Gates**: `research-complete`, `agreement-reached`
- **Expected Artifacts**: consensus-record, decision-log
- **Completion Criteria**: Voting matrix with 2+ options evaluated, weighted scoring applied, confidence scores recorded, threshold met.
- **Skippable**: Yes. Solo developer projects or unambiguous decisions MAY skip this stage with a documented reason.

#### 2.3.3 Architecture Decision (Stage 3)

**Purpose**: Architecture Decision Records documenting significant technical decisions.

- **Prerequisites**: `research`, `consensus`
- **Required Gates**: `decisions-documented`, `review-completed`
- **Expected Artifacts**: adr-document
- **Completion Criteria**: ADR file created in `docs/adrs/` or `.cleo/adrs/`, decision rationale documented with considered alternatives.
- **Skippable**: Yes. Minor changes or bug fixes that do not introduce architectural decisions MAY skip this stage.
- **Special Behavior**: When a pipeline advances FROM this stage, CLEO automatically scans for ADRs referencing the task and links them in the database.

#### 2.3.4 Specification (Stage 4)

**Purpose**: RFC-style documentation of requirements and design.

- **Prerequisites**: `research`, `consensus`, `architecture_decision`
- **Required Gates**: `spec-complete`, `spec-reviewed`
- **Expected Artifacts**: spec-document, api-spec, design-doc
- **Completion Criteria**: Specification file exists with RFC 2119 language, version field, authority section, and related specifications section.

#### 2.3.5 Decomposition (Stage 5)

**Purpose**: Task breakdown, splitting work into atomic, executable tasks.

- **Prerequisites**: `research`, `specification`
- **Required Gates**: `tasks-created`, `dependencies-mapped`
- **Expected Artifacts**: task-breakdown, dependency-graph
- **Completion Criteria**: Child tasks created with MECE coverage, dependency graph is acyclic, max depth 3 enforced.

#### 2.3.6 Implementation (Stage 6)

**Purpose**: Writing code and building features.

- **Prerequisites**: `research`, `specification`, `decomposition`
- **Required Gates**: `code-complete`, `lint-passing`
- **Expected Artifacts**: source-code, implementation-notes
- **Completion Criteria**: Code changes committed with `@task T####` provenance tags, linting passes.
- **Timeout**: None (varies by task size).

#### 2.3.7 Validation (Stage 7)

**Purpose**: Static analysis, type checking, and quality gates.

- **Prerequisites**: `implementation`
- **Required Gates**: `static-analysis-pass`, `type-check-pass`
- **Expected Artifacts**: verification-report
- **Completion Criteria**: `npx tsc --noEmit` passes, linters pass, no new warnings introduced.

#### 2.3.8 Testing (Stage 8)

**Purpose**: Running test suites and ensuring coverage.

- **Prerequisites**: `implementation`, `validation`
- **Required Gates**: `tests-pass`, `coverage-met`
- **Expected Artifacts**: test-results, coverage-report
- **Completion Criteria**: Vitest suite passes, coverage thresholds met, bug-fix tasks include reproducing tests.

#### 2.3.9 Release (Stage 9)

**Purpose**: Versioning, publishing, and deployment.

- **Prerequisites**: `implementation`, `validation`, `testing`
- **Required Gates**: `version-bumped`, `changelog-updated`, `artifacts-published`
- **Expected Artifacts**: version-tag, release-notes, published-package
- **Completion Criteria**: Version bumped (CalVer), changelog entry exists, git tag created, npm package published.
- **Skippable**: Yes. Internal-only changes or partial work MAY skip release.

### 2.4 Prerequisite Graph

```
research ──► consensus ──► architecture_decision ──► specification
   │                                                      │
   │              ┌───────────────────────────────────────┘
   │              ▼
   └──────► decomposition
                  │
   ┌──────────────┤
   │    ┌─────────┘
   ▼    ▼
research + specification + decomposition ──► implementation
                                                  │
                                                  ▼
                                             validation
                                                  │
                                  implementation + validation ──► testing
                                                                    │
                                  implementation + validation + testing ──► release
```

Prerequisites are defined in `STAGE_PREREQUISITES` (`src/core/lifecycle/stages.ts`). A stage MUST NOT be entered unless all its prerequisites have status `completed` or `skipped` (in strict mode). In advisory mode, missing prerequisites generate warnings but do not block progression.

### 2.5 Stage Status Values

Each stage tracks its own status independently. Valid values are defined in `LIFECYCLE_STAGE_STATUSES`:

| Status        | Description                                         |
|---------------|-----------------------------------------------------|
| `not_started` | Stage has not been entered yet                      |
| `in_progress` | Stage is actively being worked on                   |
| `blocked`     | Stage is paused, waiting on external resolution     |
| `completed`   | Stage finished successfully                         |
| `skipped`     | Stage was bypassed with a documented reason         |
| `failed`      | Stage encountered an unrecoverable error            |

Terminal statuses: `completed`, `skipped`, `failed`.

---

## 3. Pipeline Initialization Patterns

### 3.1 Greenfield Pattern

For new projects or epics with no prior work:

1. `initializePipeline(taskId)` creates a pipeline record with status `active`.
2. All 9 stages are created with status `not_started`.
3. The starting stage (default: `research`) is set to `in_progress`.
4. The pipeline `currentStageId` points to the starting stage.

This is the standard pattern for new epics that follow the full RCASD-IVTR lifecycle.

### 3.2 Brownfield Pattern

For existing projects joining the lifecycle system mid-stream:

1. `initializePipeline(taskId, { startStage: 'implementation' })` initializes with a later starting stage.
2. Stages prior to the starting stage SHOULD be marked as `skipped` with reason documenting the brownfield context.
3. The pipeline begins at the specified stage.

Use this pattern when adopting CLEO for an existing codebase where research, specification, and decomposition were performed informally before the lifecycle system was introduced.

### 3.3 Grayfield Pattern

For hybrid scenarios where some stages were completed externally:

1. Initialize the pipeline at `research` (standard).
2. Use `recordStageProgress()` to mark stages that were completed outside the system as `completed` with notes documenting the external evidence.
3. Use `skipStage()` for stages that are not applicable with a reason.
4. Resume normal lifecycle flow at the first truly active stage.

This pattern accommodates incremental adoption where some work predates the lifecycle system but future work should be tracked.

---

## 4. Two-Dimensional Work Model

### 4.1 Epics x Phases

The lifecycle system operates on a two-dimensional model:

- **Horizontal axis**: Epics (large work items, each with their own pipeline)
- **Vertical axis**: Lifecycle phases (the 9 RCASD-IVTR stages)

Each epic has an independent pipeline instance. Multiple epics MAY be at different stages simultaneously. The `listPipelines()` function provides a cross-epic view of all active pipelines.

### 4.2 Cross-Phase Dependencies

Within a single epic, stage prerequisites enforce ordering. Across epics, dependencies are managed through the task dependency system (`task_dependencies` table), not through the lifecycle system directly.

When an epic's implementation stage depends on another epic's specification stage, this SHOULD be modeled as:

1. A task dependency between the two epics' tasks.
2. The dependent epic's `implementation` stage will be `blocked` if its prerequisites are not met.
3. The task dependency system prevents the dependent task from being marked `active` until the blocking task's relevant stage is complete.

### 4.3 Pipeline Statistics

The `getPipelineStatistics()` function provides aggregate views:

- **Total pipelines**: Count of all lifecycle-tracked epics.
- **By status**: Distribution across `active`, `completed`, `blocked`, `failed`, `cancelled`, `aborted`.
- **By stage**: Distribution of current stages across all active pipelines.

---

## 5. Pipeline Gates and HITL

### 5.1 Gate Architecture

Gates are checkpoint validations that MUST pass before a stage can be completed or a transition can occur. Each stage defines `requiredGates` in its `StageDefinition`.

Gates are recorded in the `lifecycle_gate_results` table with three possible results:

| Result | Description                                      |
|--------|--------------------------------------------------|
| `pass` | Gate check succeeded, stage may proceed          |
| `fail` | Gate check failed, stage is blocked              |
| `warn` | Gate check raised concerns but does not block    |

### 5.2 Gate Operations

- **Pass a gate**: `passGate(epicId, gateName, agent?, notes?)` records a passing result.
- **Fail a gate**: `failGate(epicId, gateName, reason?)` records a failure with reason.
- **Query gates**: `getLifecycleGates(epicId)` returns all gate results grouped by stage.

Gate results are immutable once recorded. A failed gate MAY be superseded by a subsequent passing result for the same gate name.

### 5.3 Enforcement Modes

The lifecycle system supports three enforcement modes, configured via `config.json` or the `LIFECYCLE_ENFORCEMENT_MODE` environment variable:

| Mode       | Behavior                                                      |
|------------|---------------------------------------------------------------|
| `strict`   | Missing prerequisites block stage entry. Default mode.        |
| `advisory` | Missing prerequisites generate warnings but allow progression.|
| `off`      | Gate checks are disabled entirely.                            |

The enforcement mode is read by `checkGate()` before every stage transition in the `startStage()` path.

### 5.4 Human-in-the-Loop (HITL) Gates

Certain gates require human review and cannot be automated. HITL gates follow this flow:

1. An agent requests entry to a gate-protected stage.
2. The system checks prerequisites via `checkStagePrerequisites()`.
3. If a HITL gate is required, the system records a `pending` gate result.
4. The human reviews the evidence and artifacts.
5. The human calls `passGate()` or `failGate()` to record the decision.
6. The agent may proceed once all required gates pass.

HITL gates are identified by convention in the gate name (e.g., `review-completed`, `spec-reviewed`). The system does not distinguish automated from manual gates at the schema level; the distinction is in the workflow.

### 5.5 Pre-Transition Gate Check

The `checkGate()` function performs the following before allowing a stage transition:

1. Read enforcement mode from config or environment.
2. If mode is `off`, return `allowed: true` immediately.
3. Call `checkStagePrerequisites()` to verify all prerequisite stages are `completed` or `skipped`.
4. If prerequisites are missing and mode is `strict`, return `allowed: false` with the list of missing prerequisites.
5. If prerequisites are missing and mode is `advisory`, return `allowed: true` with warnings.
6. If all prerequisites are met, return `allowed: true`.

---

## 6. Transition Rules

### 6.1 Forward Transitions

Linear forward progression between adjacent stages is always allowed without force:

```
research → consensus → architecture_decision → specification → decomposition →
implementation → validation → testing → release
```

### 6.2 Skip Transitions

Skipping stages is allowed with `force: true` when the skipped stages are marked as `skippable` in their definitions. Non-skippable stages require explicit force override.

Examples of allowed skip transitions:
- `research` → `specification` (skipping consensus and architecture_decision, both skippable)
- `specification` → `implementation` (skipping decomposition, requires force)

### 6.3 Backward Transitions

Backward transitions are allowed with `force: true` for rework scenarios:

- `implementation` → `specification` (rework required)
- `testing` → `implementation` (fix test failures)

### 6.4 Terminal Rule

Once a pipeline reaches `release` and is completed, no further transitions are allowed. The pipeline status changes to `completed`.

### 6.5 Stage Reset

In emergency situations, `resetStage()` resets a stage to `not_started`, clearing completion and skip timestamps. This is an administrative operation that SHOULD be used sparingly and logged.

---

## 7. SQLite Schema

All lifecycle data is stored in `tasks.db` alongside task data. The schema is defined in `src/store/schema.ts` using Drizzle ORM.

### 7.1 lifecycle_pipelines

Top-level pipeline record linking an epic task to its lifecycle state.

| Column           | Type   | Constraints                          | Description                              |
|------------------|--------|--------------------------------------|------------------------------------------|
| `id`             | TEXT   | PRIMARY KEY                          | Pipeline identifier (e.g., `pipeline-T4800`) |
| `task_id`        | TEXT   | NOT NULL, FK → tasks.id, CASCADE     | Epic task ID this pipeline tracks        |
| `status`         | TEXT   | NOT NULL, DEFAULT 'active'           | Pipeline status: `active`, `completed`, `blocked`, `failed`, `cancelled`, `aborted` |
| `current_stage_id` | TEXT | nullable                             | Current stage name (e.g., `implementation`) |
| `started_at`     | TEXT   | NOT NULL, DEFAULT datetime('now')    | When the pipeline was created            |
| `completed_at`   | TEXT   | nullable                             | When the pipeline completed or was cancelled |

**Indexes**: `idx_lifecycle_pipelines_task_id` (task_id), `idx_lifecycle_pipelines_status` (status)

### 7.2 lifecycle_stages

Individual stage records within a pipeline. One row per stage per pipeline.

| Column                | Type    | Constraints                          | Description                              |
|-----------------------|---------|--------------------------------------|------------------------------------------|
| `id`                  | TEXT    | PRIMARY KEY                          | Stage identifier (e.g., `stage-T4800-research`) |
| `pipeline_id`         | TEXT    | NOT NULL, FK → lifecycle_pipelines.id, CASCADE | Parent pipeline |
| `stage_name`          | TEXT    | NOT NULL, CHECK constraint           | One of the 10 canonical stage names      |
| `status`              | TEXT    | NOT NULL, DEFAULT 'not_started'      | Stage status: `not_started`, `in_progress`, `blocked`, `completed`, `skipped`, `failed` |
| `sequence`            | INTEGER | NOT NULL                             | Execution order (1-9 for pipeline stages) |
| `started_at`          | TEXT    | nullable                             | When stage work began                    |
| `completed_at`        | TEXT    | nullable                             | When stage was marked completed          |
| `blocked_at`          | TEXT    | nullable                             | When stage was blocked                   |
| `block_reason`        | TEXT    | nullable                             | Why the stage is blocked                 |
| `skipped_at`          | TEXT    | nullable                             | When stage was skipped                   |
| `skip_reason`         | TEXT    | nullable                             | Documented reason for skipping           |
| `notes_json`          | TEXT    | DEFAULT '[]'                         | JSON array of stage notes                |
| `metadata_json`       | TEXT    | DEFAULT '{}'                         | JSON object for stage-specific metadata  |
| `output_file`         | TEXT    | nullable                             | Path to stage output artifact            |
| `created_by`          | TEXT    | nullable                             | Agent that created the stage record      |
| `validated_by`        | TEXT    | nullable                             | Agent that validated the stage           |
| `validated_at`        | TEXT    | nullable                             | When validation occurred                 |
| `validation_status`   | TEXT    | CHECK constraint                     | One of: `pending`, `in_review`, `approved`, `rejected`, `needs_revision` |
| `provenance_chain_json` | TEXT  | nullable                             | JSON provenance chain linking stage to artifacts |

**Indexes**: `idx_lifecycle_stages_pipeline_id` (pipeline_id), `idx_lifecycle_stages_stage_name` (stage_name), `idx_lifecycle_stages_status` (status)

### 7.3 lifecycle_gate_results

Records of gate check outcomes for each stage.

| Column       | Type | Constraints                              | Description                              |
|--------------|------|------------------------------------------|------------------------------------------|
| `id`         | TEXT | PRIMARY KEY                              | Gate result identifier                   |
| `stage_id`   | TEXT | NOT NULL, FK → lifecycle_stages.id, CASCADE | Stage this gate belongs to             |
| `gate_name`  | TEXT | NOT NULL                                 | Name of the gate (e.g., `tests-pass`)    |
| `result`     | TEXT | NOT NULL, CHECK constraint               | One of: `pass`, `fail`, `warn`           |
| `checked_at` | TEXT | NOT NULL, DEFAULT datetime('now')        | When the gate was checked                |
| `checked_by` | TEXT | NOT NULL                                 | Agent or user who performed the check    |
| `details`    | TEXT | nullable                                 | Additional details about the check       |
| `reason`     | TEXT | nullable                                 | Reason for failure (if result is `fail`) |

**Indexes**: `idx_lifecycle_gate_results_stage_id` (stage_id)

### 7.4 lifecycle_evidence

Evidence artifacts linked to stages for provenance tracking.

| Column        | Type | Constraints                              | Description                              |
|---------------|------|------------------------------------------|------------------------------------------|
| `id`          | TEXT | PRIMARY KEY                              | Evidence identifier                      |
| `stage_id`    | TEXT | NOT NULL, FK → lifecycle_stages.id, CASCADE | Stage this evidence belongs to         |
| `uri`         | TEXT | NOT NULL                                 | URI to the evidence (file path or URL)   |
| `type`        | TEXT | NOT NULL, CHECK constraint               | One of: `file`, `url`, `manifest`        |
| `recorded_at` | TEXT | NOT NULL, DEFAULT datetime('now')        | When the evidence was recorded           |
| `recorded_by` | TEXT | nullable                                 | Agent or user who recorded it            |
| `description` | TEXT | nullable                                 | Human-readable description               |

**Indexes**: `idx_lifecycle_evidence_stage_id` (stage_id)

### 7.5 lifecycle_transitions

Audit trail of stage transitions for a pipeline.

| Column            | Type | Constraints                              | Description                              |
|-------------------|------|------------------------------------------|------------------------------------------|
| `id`              | TEXT | PRIMARY KEY                              | Transition identifier                    |
| `pipeline_id`     | TEXT | NOT NULL, FK → lifecycle_pipelines.id, CASCADE | Pipeline this transition belongs to   |
| `from_stage_id`   | TEXT | NOT NULL                                 | Stage transitioning from                 |
| `to_stage_id`     | TEXT | NOT NULL                                 | Stage transitioning to                   |
| `transition_type` | TEXT | NOT NULL, DEFAULT 'automatic'            | One of: `automatic`, `manual`, `forced`  |
| `created_at`      | TEXT | NOT NULL, DEFAULT datetime('now')        | When the transition occurred             |

**Indexes**: `idx_lifecycle_transitions_pipeline_id` (pipeline_id)

---

## 8. API and CLI Integration

### 8.1 MCP Operations (pipeline domain)

The lifecycle system is exposed through the `pipeline` domain in the MCP gateway. Legacy `lifecycle` domain aliases are supported for backward compatibility.

#### Query Operations (5)

| Operation            | Description                    | Parameters                    |
|----------------------|--------------------------------|-------------------------------|
| `stage.validate`     | Check stage prerequisites      | `taskId`, `targetStage`       |
| `stage.status`       | Current lifecycle state        | `taskId` or `epicId`          |
| `stage.history`      | Stage transition history       | `taskId`                      |
| `stage.gates`        | All gate statuses for an epic  | `taskId`                      |
| `stage.prerequisites`| Required prior stages          | `targetStage`                 |

#### Mutate Operations (5 lifecycle + 7 release)

| Operation            | Description                    | Parameters                    |
|----------------------|--------------------------------|-------------------------------|
| `stage.record`       | Record stage completion        | `taskId`, `stage`, `status`   |
| `stage.skip`         | Skip optional stage            | `taskId`, `stage`, `reason`   |
| `stage.reset`        | Reset stage (emergency)        | `taskId`, `stage`, `reason`   |
| `stage.gate.pass`    | Mark gate as passed            | `taskId`, `gateName`, `agent` |
| `stage.gate.fail`    | Mark gate as failed            | `taskId`, `gateName`, `reason`|
| `release.prepare`    | Prepare release                | `version`, `type`             |
| `release.changelog`  | Generate changelog             | `version`                     |
| `release.commit`     | Create release commit          | `version`                     |
| `release.tag`        | Create git tag                 | `version`                     |
| `release.push`       | Push to remote                 | `version`                     |
| `release.gates.run`  | Run release gates              | `gates?`                      |
| `release.rollback`   | Rollback release               | `version`, `reason`           |

### 8.2 CLI Commands

| Command                          | Description                                      |
|----------------------------------|--------------------------------------------------|
| `cleo lifecycle status <taskId>` | Show current lifecycle state for an epic          |
| `cleo lifecycle history <taskId>`| Show stage transition history                     |
| `cleo lifecycle validate <taskId> <stage>` | Check prerequisites for a target stage |
| `cleo lifecycle gates <taskId>`  | Show all gate statuses                            |
| `cleo lifecycle record <taskId> <stage> <status>` | Record stage progress          |
| `cleo lifecycle skip <taskId> <stage> --reason <r>` | Skip a stage with reason     |
| `cleo lifecycle reset <taskId> <stage> --reason <r>` | Reset a stage (emergency)   |
| `cleo lifecycle list`            | List all pipelines with lifecycle data            |
| `cleo lifecycle resume <taskId>` | Resume a specific pipeline                        |
| `cleo verify --gate <name> --value pass\|fail` | Record gate result              |

### 8.3 Cross-Session Resume

The resume system (`src/core/lifecycle/resume.ts`) enables agents to discover and continue in-progress pipelines across session boundaries.

#### Resume Flow

1. **Discovery**: `findResumablePipelines()` queries active pipelines with their current stage status, joining against `tasks` for priority ordering.
2. **Context Loading**: `loadPipelineContext(taskId)` loads the full pipeline state including all stages, gate results, evidence, and recent transitions via SQL JOINs.
3. **Resume Execution**: `resumeStage(taskId, stage)` updates the target stage from `blocked`/`not_started` to `in_progress` and records the transition.
4. **Auto-Detection**: `autoResume()` scores all active pipelines by stage status and task priority, recommending the best candidate for resumption.

#### Session Integration

On session start, `checkSessionResume()` MAY be called to:

1. Find resumable pipelines matching the session scope.
2. If exactly one candidate exists and `autoResume: true`, automatically resume it.
3. If multiple candidates exist, present them for user choice.
4. Return a `SessionResumeCheckResult` indicating whether work was resumed or user action is needed.

#### Resume Priority Scoring

Candidates are scored based on:

- **Stage status**: `in_progress` (100) > `blocked` (70) > `not_started` (40) > `completed/skipped` (20)
- **Task priority multiplier**: `critical` (2.0x) > `high` (1.5x) > `medium` (1.0x) > `low` (0.8x)
- **Recency boost**: Stages started within the last 24 hours receive a 1.2x boost.

---

## 9. Exit Codes 80-84: Lifecycle Enforcement

The lifecycle system uses exit codes 80-84 for enforcement errors. These are distinct from protocol violation codes (60-67) and system errors (1-9).

| Exit Code | Constant                       | Description                                        |
|-----------|--------------------------------|----------------------------------------------------|
| 80        | `LIFECYCLE_GATE_FAILED`        | A required gate check failed. Prerequisites not met for the target stage. |
| 81        | `AUDIT_MISSING`                | A required audit trail entry is missing. The system cannot verify a stage transition occurred properly. |
| 82        | `CIRCULAR_VALIDATION`          | A circular validation dependency was detected in the prerequisite graph. |
| 83        | `LIFECYCLE_TRANSITION_INVALID` | An invalid lifecycle stage transition was attempted (e.g., completing an already-completed stage, or an unsupported stage progression). |
| 84        | `PROVENANCE_REQUIRED`          | Provenance metadata (output files, evidence links, or provenance chain) is required but missing for this operation. |

### 9.1 Error Handling

When a lifecycle exit code is raised:

1. The operation MUST NOT modify pipeline or stage state.
2. The error response MUST include the specific gate or prerequisite that failed.
3. The error response SHOULD include a `fix` field suggesting corrective action.
4. In advisory mode, codes 80 and 84 generate warnings instead of errors.

### 9.2 Error Response Pattern

```typescript
throw new CleoError(
  ExitCode.LIFECYCLE_GATE_FAILED,
  'SPAWN BLOCKED: Lifecycle prerequisites not met. Missing: specification, decomposition',
);

throw new CleoError(
  ExitCode.LIFECYCLE_TRANSITION_INVALID,
  "Cannot complete stage 'research' from status 'completed'",
);
```

---

## 10. Pipeline Status Values

Pipelines have their own status values defined in `LIFECYCLE_PIPELINE_STATUSES`:

| Status      | Description                                              |
|-------------|----------------------------------------------------------|
| `active`    | Pipeline is running, stages are being progressed         |
| `completed` | All required stages finished, pipeline is done           |
| `blocked`   | Pipeline cannot advance, waiting on external resolution  |
| `failed`    | Pipeline encountered an unrecoverable error              |
| `cancelled` | User-initiated cancellation (deliberate abandonment)     |
| `aborted`   | System-forced termination                                |

Terminal statuses: `completed`, `failed`, `cancelled`, `aborted`.

A `cancelled` pipeline cannot be resumed; a new pipeline MUST be created if work is to continue. The distinction between `cancelled` (user-initiated) and `aborted` (system-forced) supports audit trail analysis.

---

## 11. Provenance and Evidence

### 11.1 Stage Artifacts

Each stage MAY produce output artifacts tracked via the `output_file` column on `lifecycle_stages` and the `lifecycle_evidence` table. The `ensureStageArtifact()` function (from `src/core/lifecycle/stage-artifacts.ts`) resolves the expected output file path for a given stage.

### 11.2 Provenance Chain

The `provenance_chain_json` column on `lifecycle_stages` stores a JSON object linking the stage to its artifacts, recording source, timestamp, and related evidence. This chain is populated by `recordStageProgress()` and used by the provenance consolidation system (T5100).

### 11.3 Evidence Recording

Evidence is recorded via the `lifecycle_evidence` table with three types:

- **file**: Local file path to an artifact (e.g., `.cleo/agent-outputs/T4800-research.md`)
- **url**: External URL reference
- **manifest**: Link to a manifest entry in `manifest_entries` table

Evidence is linked to specific stages, enabling per-stage audit of what was produced and when.

---

## 12. References

### 12.1 Implementation Files

- `src/core/lifecycle/index.ts` - Main lifecycle API (stage operations, gate checks, status queries)
- `src/core/lifecycle/stages.ts` - Canonical stage definitions, prerequisites, transition rules
- `src/core/lifecycle/pipeline.ts` - Pipeline state machine (initialize, advance, complete, cancel)
- `src/core/lifecycle/resume.ts` - Cross-session resume flow
- `src/core/lifecycle/stage-artifacts.ts` - Stage artifact path resolution
- `src/core/lifecycle/evidence.ts` - Provenance linking
- `src/store/schema.ts` - Drizzle ORM schema definitions
- `src/store/status-registry.ts` - Canonical status values and type definitions
- `src/types/exit-codes.ts` - Exit code definitions (80-84)

### 12.2 Related Specifications

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) - Dual-layer enforcement architecture
- [CLEO-OPERATIONS-REFERENCE.md](CLEO-OPERATIONS-REFERENCE.md) - Full MCP operation matrix
- [CLEO-STRATEGIC-ROADMAP-SPEC.md](CLEO-STRATEGIC-ROADMAP-SPEC.md) - Strategic context and phase gating
- [MCP-SERVER-SPECIFICATION.md](MCP-SERVER-SPECIFICATION.md) - MCP server contract
- [MCP-AGENT-INTERACTION-SPEC.md](MCP-AGENT-INTERACTION-SPEC.md) - Agent interaction patterns
- [CLEO-BRAIN-SPECIFICATION.md](CLEO-BRAIN-SPECIFICATION.md) - BRAIN cognitive infrastructure
- [CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md](CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md) - Metrics and validation

### 12.3 Referenced By

This specification is referenced by:

- PROTOCOL-ENFORCEMENT-SPEC.md (Section 1.2, defers to this spec for RCSD pipeline integration)
- MCP-SERVER-SPECIFICATION.md (pipeline domain operations)
- MCP-AGENT-INTERACTION-SPEC.md (lifecycle-aware agent behavior)
- CLEO-STRATEGIC-ROADMAP-SPEC.md (RCASD lifecycle context)
- CLEO-BRAIN-SPECIFICATION.md (lifecycle data integration)
- CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md (lifecycle compliance tracking)
