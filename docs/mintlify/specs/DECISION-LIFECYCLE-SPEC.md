# Decision Lifecycle Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2026-02-20
**Updated**: 2026-02-20

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174].

---

## Part 1: Purpose and Scope

### 1.1 Purpose

This specification defines the decision tracking system within CLEO's project lifecycle. It formalizes how architectural decisions are proposed, accepted, superseded, and deprecated as tracked artifacts with full evidence chains linking them to research, consensus, specification, and implementation.

### 1.2 Scope

This specification is **AUTHORITATIVE** for:
- The RCADSD-ICR pipeline stage ordering and gate enforcement
- Delineation rules between Consensus, ADR, Specification, and Decomposition stages
- SQLite schema for decision, lifecycle, and operational data tables
- Evidence chain INSERT sequences through pipeline stages
- Domain operations for decision management within the `pipeline` domain
- Migration path from JSONL to SQLite for operational data

This specification **DEFERS TO**:
- `DOMAIN-CONSOLIDATION-SPEC.md` for domain naming and operation routing
- `protocols/adr.md` for agent-facing protocol requirements and output format
- `protocols/consensus.md` for consensus verdict structure
- `protocols/specification.md` for specification document format
- ADR-006 for canonical SQLite storage architecture decisions

### 1.3 Non-Scope

- Implementation code (this is a specification, not a PR)
- BRAIN dimension operations (future phases)
- MCP gateway/capability-matrix restructuring (see `DOMAIN-CONSOLIDATION-SPEC.md`)
- ADR content authoring guidelines (see `protocols/adr.md`)

---

## Part 2: Pipeline Change (RCSD to RCADSD-ICR)

### 2.1 Current Pipeline

The current RCSD-IVTR pipeline has 7 stages:

```
SETUP PHASE (RCSD):
  Research -> Consensus -> Specification -> Decomposition

EXECUTION PHASE (IVTR):
  Implementation -> Verification -> Testing -> Release
```

Defined in `src/core/lifecycle/index.ts`:
```typescript
export const RCSD_STAGES = ['research', 'consensus', 'specification', 'decomposition'] as const;
export const EXECUTION_STAGES = ['implementation', 'contribution', 'release'] as const;
```

### 2.2 New Pipeline

The pipeline gains the `adr` stage between Consensus and Specification, producing the RCADSD-ICR pipeline with 8 stages:

```
SETUP PHASE (RCADSD):
  Research -> Consensus -> ADR -> Specification -> Decomposition

EXECUTION PHASE (ICR):
  Implementation -> Contribution -> Release
```

| Requirement | Description |
|-------------|-------------|
| PIPE-001 | The `RCSD_STAGES` array MUST be updated to `['research', 'consensus', 'adr', 'specification', 'decomposition']`. |
| PIPE-002 | The `RcsdStage` type union MUST include `'adr'`. |
| PIPE-003 | The `checkGate()` function MUST enforce that `adr` stage requires `consensus` to be `completed` or `skipped`. |
| PIPE-004 | The `checkGate()` function MUST enforce that `specification` stage requires `adr` to be `completed` or `skipped`. |
| PIPE-005 | The total stage count MUST be 8: 5 setup + 3 execution. |

### 2.3 Impact on Existing Gate Logic

The existing `checkGate()` in `src/core/lifecycle/index.ts` iterates all stages prior to the target and checks they are `completed` or `skipped`. Because the ADR stage is inserted at index 2 of the combined stages array, the existing gate logic automatically enforces the correct prerequisite ordering without additional branching. The only required change is updating the stage arrays and type definitions.

### 2.4 Stage Naming Convention

| Stage Name | Array Value | Display Name |
|------------|-------------|--------------|
| Research | `'research'` | Research |
| Consensus | `'consensus'` | Consensus |
| ADR | `'adr'` | Architecture Decision |
| Specification | `'specification'` | Specification |
| Decomposition | `'decomposition'` | Decomposition |
| Implementation | `'implementation'` | Implementation |
| Contribution | `'contribution'` | Contribution |
| Release | `'release'` | Release |

---

## Part 3: Artifact Delineation

### 3.1 The Delineation Problem

Four adjacent pipeline stages (Consensus, ADR, Specification, Decomposition) produce overlapping artifacts. Without clear boundaries, agents conflate decision records with specifications or decomposition plans.

### 3.2 Delineation Rules

| Stage | Question Answered | Artifact Produced | Lifecycle | Primary Audience |
|-------|-------------------|-------------------|-----------|------------------|
| **Consensus** | "What do we think?" | Verdict with voting matrix and confidence scores | One-shot report (no status transitions) | Agents performing analysis |
| **ADR** | "What did we decide and why?" | Decision record with context, rationale, consequences | `proposed` -> `accepted` -> `superseded` / `deprecated` | Project stakeholders (long-term record) |
| **Specification** | "How must it work?" | RFC 2119 requirements with conformance criteria | `DRAFT` -> `ACTIVE` -> `DEPRECATED` / `SUPERSEDED` | Implementers |
| **Decomposition** | "What tasks?" | Task hierarchy with dependency waves | Tasks created in task system | Orchestrator |

### 3.3 Flow Rules

| Requirement | Description |
|-------------|-------------|
| DELIN-001 | Consensus MUST produce a verdict. The verdict MUST NOT include implementation requirements (that is Specification's role). |
| DELIN-002 | The ADR stage MUST capture a consensus verdict as a tracked decision record. |
| DELIN-003 | An ADR MUST require HITL acceptance before its status transitions from `proposed` to `accepted`. |
| DELIN-004 | Only after ADR acceptance (status = `accepted`) MAY the Specification stage begin formalizing implementation requirements. |
| DELIN-005 | A Specification MUST reference the accepted ADR that authorizes its requirements. |
| DELIN-006 | Decomposition MUST NOT begin until the governing Specification has status `ACTIVE` or the specification stage is explicitly skipped. |
| DELIN-007 | Each stage SHOULD produce exactly one primary artifact. Multiple sub-artifacts MAY exist but MUST link to the primary. |

### 3.4 Delineation Examples

**Consensus produces**: "We evaluated options A, B, C. Option B has 85% weighted confidence across 3 agents. Verdict: PROVEN."

**ADR captures**: "We decided to use Option B (from consensus report T1234). Context: we needed X. Rationale: B gives us Y. Consequences: positive — Z; negative — W."

**Specification formalizes**: "Per ADR-007, the system MUST implement Option B with these 12 requirements: REQ-001 through REQ-012. Conformance: all MUST requirements pass."

**Decomposition creates**: "Per SPEC-007, implementation requires 4 tasks: T100 (schema), T101 (core logic), T102 (MCP adapter), T103 (tests)."

---

## Part 4: SQLite Schema

All tables use drizzle-orm definitions consistent with existing patterns in `src/store/schema.ts`: text timestamps via `sql\`(datetime('now'))\``, JSON-serialized arrays in text columns, and `idx_` prefixed index names.

### 4.1 Decision Tables (3 tables)

#### `decisions` — ADR records with lifecycle status

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,                    -- e.g., 'ADR-007'
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed', 'accepted', 'superseded', 'deprecated')),
  epic_id TEXT,                           -- Epic this decision belongs to
  consensus_manifest_id TEXT,             -- Links to originating consensus report
  supersedes_id TEXT REFERENCES decisions(id),
  superseded_by_id TEXT REFERENCES decisions(id),
  content TEXT NOT NULL,                  -- Full markdown content of the ADR
  context TEXT,                           -- Problem statement / context section
  rationale TEXT,                         -- Why this option was chosen
  consequences_json TEXT DEFAULT '{}',    -- {"positive": [...], "negative": [...]}
  accepted_by TEXT,                       -- HITL user who accepted (null if proposed)
  accepted_at TEXT,                       -- When HITL accepted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decisions_epic_id ON decisions(epic_id);
```

#### `decision_evidence` — Links decisions to research/consensus documents and tasks

```sql
CREATE TABLE decision_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL
    CHECK(evidence_type IN ('research', 'consensus', 'specification', 'task', 'external')),
  reference_id TEXT NOT NULL,             -- Manifest ID, task ID, or URL
  reference_title TEXT,                   -- Human-readable label
  relationship TEXT NOT NULL DEFAULT 'supports'
    CHECK(relationship IN ('supports', 'contradicts', 'supersedes', 'implements', 'validates')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decision_evidence_decision ON decision_evidence(decision_id);
CREATE INDEX idx_decision_evidence_ref ON decision_evidence(reference_id);
```

#### `task_decisions` — Junction table: which tasks implement/validate which decisions

```sql
CREATE TABLE task_decisions (
  task_id TEXT NOT NULL,                  -- References tasks(id)
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'implements'
    CHECK(relationship IN ('implements', 'validates', 'blocked_by', 'reviews')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, decision_id, relationship)
);

CREATE INDEX idx_task_decisions_decision ON task_decisions(decision_id);
```

### 4.2 Lifecycle Tables (5 tables)

These tables replace the per-epic `.cleo/rcsd/{epicId}/_manifest.json` files with a relational model.

#### `lifecycle_pipelines` — Epic-level pipeline state

```sql
CREATE TABLE lifecycle_pipelines (
  id TEXT PRIMARY KEY,                    -- Generated ID (e.g., 'pipe-a1b2c3')
  epic_id TEXT NOT NULL,                  -- Epic task ID this pipeline tracks
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'completed', 'suspended', 'failed')),
  current_stage TEXT,                     -- Current active stage name
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX idx_pipelines_epic ON lifecycle_pipelines(epic_id);
CREATE INDEX idx_pipelines_status ON lifecycle_pipelines(status);
```

#### `lifecycle_stages` — Per-stage status for each pipeline

```sql
CREATE TABLE lifecycle_stages (
  id TEXT PRIMARY KEY,                    -- Generated ID (e.g., 'stg-a1b2c3')
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL
    CHECK(stage_name IN (
      'research', 'consensus', 'adr', 'specification', 'decomposition',
      'implementation', 'contribution', 'release'
    )),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started', 'in_progress', 'completed', 'skipped')),
  started_at TEXT,
  completed_at TEXT,
  artifacts_json TEXT DEFAULT '[]',       -- JSON array of artifact paths/IDs
  agent_id TEXT,                          -- Session/agent that worked this stage
  UNIQUE(pipeline_id, stage_name)
);

CREATE INDEX idx_stages_pipeline ON lifecycle_stages(pipeline_id);
CREATE INDEX idx_stages_status ON lifecycle_stages(status);
```

#### `lifecycle_transitions` — Stage transition audit trail

```sql
CREATE TABLE lifecycle_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  from_stage TEXT,                        -- NULL for initial entry
  to_stage TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,                            -- Why the transition occurred
  triggered_by TEXT,                      -- Agent/user who triggered it
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transitions_pipeline ON lifecycle_transitions(pipeline_id);
```

#### `lifecycle_gate_results` — Gate check pass/fail history

```sql
CREATE TABLE lifecycle_gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,               -- Target stage being gated
  gate_status TEXT NOT NULL
    CHECK(gate_status IN ('pass', 'fail', 'warn')),
  enforcement_mode TEXT NOT NULL
    CHECK(enforcement_mode IN ('strict', 'advisory', 'off')),
  missing_prerequisites_json TEXT DEFAULT '[]',  -- JSON array of missing stage names
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gate_results_pipeline ON lifecycle_gate_results(pipeline_id);
```

#### `lifecycle_evidence` — Links stages to documents/decisions/tasks

```sql
CREATE TABLE lifecycle_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  evidence_type TEXT NOT NULL
    CHECK(evidence_type IN ('input', 'output', 'decision', 'task', 'artifact')),
  reference_id TEXT NOT NULL,             -- Manifest entry ID, decision ID, task ID
  reference_title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_lifecycle_evidence_pipeline ON lifecycle_evidence(pipeline_id);
CREATE INDEX idx_lifecycle_evidence_stage ON lifecycle_evidence(stage_name);
```

### 4.3 Operational Data Tables (4 tables)

These tables replace JSONL files with structured SQLite storage per ADR-006.

#### `document_manifest` — Replaces `MANIFEST.jsonl`

```sql
CREATE TABLE document_manifest (
  id TEXT PRIMARY KEY,                    -- e.g., 'T1234-research-slug'
  file_path TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK(status IN ('complete', 'partial', 'blocked')),
  agent_type TEXT NOT NULL,               -- 'research', 'analysis', 'specification', 'decision', etc.
  epic_id TEXT,
  task_id TEXT,
  topics_json TEXT DEFAULT '[]',          -- JSON array of topic strings
  key_findings_json TEXT DEFAULT '[]',    -- JSON array of finding strings
  actionable INTEGER DEFAULT 0,           -- Boolean: 0 or 1
  needs_followup_json TEXT DEFAULT '[]',  -- JSON array of task IDs
  linked_tasks_json TEXT DEFAULT '[]',    -- JSON array of task IDs
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_manifest_task ON document_manifest(task_id);
CREATE INDEX idx_manifest_epic ON document_manifest(epic_id);
CREATE INDEX idx_manifest_agent_type ON document_manifest(agent_type);
CREATE INDEX idx_manifest_status ON document_manifest(status);
```

#### `audit_logs` — Replaces `todo-log.jsonl` and `decisions.jsonl`

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,               -- 'task_created', 'task_completed', 'decision_recorded', etc.
  entity_type TEXT NOT NULL,              -- 'task', 'session', 'decision', 'pipeline', etc.
  entity_id TEXT NOT NULL,                -- ID of the affected entity
  session_id TEXT,
  agent TEXT,
  details_json TEXT DEFAULT '{}',         -- Event-specific payload
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_session ON audit_logs(session_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
```

#### `compliance` — Replaces `COMPLIANCE.jsonl`

```sql
CREATE TABLE compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,                -- Task ID (e.g., 'T1234')
  source_type TEXT NOT NULL DEFAULT 'subagent',
  compliance_pass_rate REAL,              -- 0.0 - 1.0
  rule_adherence_score REAL,              -- 0.0 - 1.0
  violation_count INTEGER DEFAULT 0,
  violation_severity TEXT DEFAULT 'none'
    CHECK(violation_severity IN ('none', 'warning', 'error')),
  manifest_integrity TEXT DEFAULT 'valid'
    CHECK(manifest_integrity IN ('valid', 'violations_found')),
  agent_type TEXT,
  validation_score INTEGER,               -- 0 - 100
  violations_json TEXT DEFAULT '[]',      -- JSON array of violation objects
  context_json TEXT DEFAULT '{}',         -- Additional context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_compliance_source ON compliance(source_id);
CREATE INDEX idx_compliance_created ON compliance(created_at);
```

#### `token_usage` — Replaces `TOKEN_USAGE.jsonl`

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL
    CHECK(event_type IN ('manifest_read', 'full_file_read', 'skill_inject', 'prompt_build')),
  estimated_tokens INTEGER NOT NULL,
  source TEXT,
  task_id TEXT,
  session_id TEXT,
  context_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_token_usage_event ON token_usage(event_type);
CREATE INDEX idx_token_usage_session ON token_usage(session_id);
CREATE INDEX idx_token_usage_created ON token_usage(created_at);
```

### 4.4 Schema Requirements

| Requirement | Description |
|-------------|-------------|
| SCHEMA-001 | All tables MUST be defined as drizzle-orm table definitions in `src/store/schema.ts`. |
| SCHEMA-002 | All timestamps MUST use text columns with `DEFAULT (datetime('now'))` for consistency with existing tables. |
| SCHEMA-003 | Complex/array fields MUST use JSON-serialized text columns with `_json` suffix naming. |
| SCHEMA-004 | All indexes MUST follow the `idx_{table}_{column}` naming convention. |
| SCHEMA-005 | Foreign keys MUST use `ON DELETE CASCADE` for child records of pipelines and decisions. |
| SCHEMA-006 | The `decisions` table MUST enforce the status enum: `proposed`, `accepted`, `superseded`, `deprecated`. |
| SCHEMA-007 | The `lifecycle_stages` table MUST include the `adr` value in its `stage_name` CHECK constraint. |
| SCHEMA-008 | The schema version in `schema_meta` MUST be incremented when these tables are added. |

---

## Part 5: Evidence Chain

### 5.1 Artifact Flow Through Stages

This section defines the complete INSERT sequence as a decision moves through the pipeline. Each stage produces database records that link to prior stages, creating a traceable evidence chain.

### 5.2 Research Stage

```
1. Agent produces research output file
2. INSERT into document_manifest:
     id = 'T1234-research-topic'
     agent_type = 'research'
     status = 'complete'
3. INSERT into lifecycle_evidence:
     stage_name = 'research'
     evidence_type = 'output'
     reference_id = manifest entry ID
4. UPDATE lifecycle_stages:
     stage_name = 'research'
     status = 'completed'
```

### 5.3 Consensus Stage

```
1. Agent produces consensus report with voting matrix
2. INSERT into document_manifest:
     id = 'T1234-consensus-topic'
     agent_type = 'analysis'
     status = 'complete'
3. INSERT into decisions:
     status = 'proposed'
     consensus_manifest_id = manifest entry ID from step 2
4. INSERT into decision_evidence:
     evidence_type = 'consensus'
     reference_id = manifest entry ID
     relationship = 'supports'
5. Link to research documents:
   INSERT into decision_evidence:
     evidence_type = 'research'
     reference_id = research manifest entry ID
     relationship = 'supports'
6. UPDATE lifecycle_stages:
     stage_name = 'consensus'
     status = 'completed'
```

### 5.4 ADR Stage

```
1. HITL reviews proposed decision record
2. If approved:
   UPDATE decisions:
     status = 'accepted'
     accepted_by = user identifier
     accepted_at = current timestamp
3. INSERT into audit_logs:
     event_type = 'decision_recorded'
     entity_type = 'decision'
     entity_id = decision ID
4. UPDATE lifecycle_stages:
     stage_name = 'adr'
     status = 'completed'
5. INSERT into lifecycle_evidence:
     stage_name = 'adr'
     evidence_type = 'decision'
     reference_id = decision ID
6. If superseding an older decision:
   UPDATE decisions (old):
     status = 'superseded'
     superseded_by_id = new decision ID
   UPDATE decisions (new):
     supersedes_id = old decision ID
```

### 5.5 Specification Stage

```
1. Agent produces specification document referencing accepted ADR
2. INSERT into document_manifest:
     id = 'T1234-spec-topic'
     agent_type = 'specification'
     status = 'complete'
3. INSERT into decision_evidence:
     decision_id = accepted ADR ID
     evidence_type = 'specification'
     reference_id = spec manifest entry ID
     relationship = 'implements'
4. INSERT into lifecycle_evidence:
     stage_name = 'specification'
     evidence_type = 'output'
     reference_id = spec manifest entry ID
5. UPDATE lifecycle_stages:
     stage_name = 'specification'
     status = 'completed'
```

### 5.6 Decomposition Stage

```
1. Orchestrator creates tasks from specification
2. For each task created:
   INSERT into task_decisions:
     task_id = new task ID
     decision_id = governing ADR ID
     relationship = 'implements'
3. INSERT into lifecycle_evidence:
     stage_name = 'decomposition'
     evidence_type = 'task'
     reference_id = task ID
4. UPDATE lifecycle_stages:
     stage_name = 'decomposition'
     status = 'completed'
```

### 5.7 Evidence Chain Requirements

| Requirement | Description |
|-------------|-------------|
| EVID-001 | Every `decisions` row MUST have at least one `decision_evidence` row with `evidence_type = 'consensus'`. |
| EVID-002 | Every accepted decision MUST have a corresponding `audit_logs` entry with `event_type = 'decision_recorded'`. |
| EVID-003 | Every lifecycle stage transition MUST produce a `lifecycle_transitions` row. |
| EVID-004 | Every gate check (pass or fail) MUST produce a `lifecycle_gate_results` row. |
| EVID-005 | Supersession MUST update both the old and new decision records atomically (single transaction). |
| EVID-006 | Every task created during decomposition SHOULD have a `task_decisions` junction linking it to the governing ADR. |

---

## Part 6: Domain Operations

### 6.1 Pipeline Domain — Decision Operations

These operations are added to the `pipeline` domain (per `DOMAIN-CONSOLIDATION-SPEC.md`) under the `decision` namespace prefix.

#### Query Operations

| Operation | Type | Parameters | Description |
|-----------|------|------------|-------------|
| `pipeline.decision.list` | query | `epicId?: string`, `status?: string` | List decisions, optionally filtered by epic and/or status. |
| `pipeline.decision.show` | query | `decisionId: string` | Full decision details including evidence chain. |
| `pipeline.decision.evidence` | query | `decisionId: string` | Evidence trail for a decision: linked research, consensus, specs, tasks. |

#### Mutate Operations

| Operation | Type | Parameters | Description |
|-----------|------|------------|-------------|
| `pipeline.decision.propose` | mutate | `title: string`, `content: string`, `epicId: string`, `consensusManifestId: string` | Create a proposed decision from consensus output. Status starts as `proposed`. |
| `pipeline.decision.accept` | mutate | `decisionId: string`, `acceptedBy?: string` | HITL accepts a decision. Transitions status from `proposed` to `accepted`. Gates the specification stage. |
| `pipeline.decision.supersede` | mutate | `decisionId: string`, `supersededById: string` | Mark decision as superseded by a newer one. Updates both records atomically. |
| `pipeline.decision.deprecate` | mutate | `decisionId: string`, `reason?: string` | Deprecate a decision that is no longer applicable. |

### 6.2 Operation Requirements

| Requirement | Description |
|-------------|-------------|
| OPS-001 | `pipeline.decision.propose` MUST validate that `consensusManifestId` references an existing manifest entry with `agent_type = 'analysis'`. |
| OPS-002 | `pipeline.decision.accept` MUST reject transitions from any status other than `proposed`. |
| OPS-003 | `pipeline.decision.accept` MUST create an `audit_logs` entry with `event_type = 'decision_recorded'`. |
| OPS-004 | `pipeline.decision.supersede` MUST update both the old and new decision records in a single transaction. |
| OPS-005 | `pipeline.decision.supersede` SHOULD trigger downstream invalidation: flag linked specifications for review. |
| OPS-006 | `pipeline.decision.list` MUST support filtering by `epicId` and `status`. |
| OPS-007 | `pipeline.decision.show` MUST return the decision record with all linked evidence entries. |

### 6.3 Integration with Existing Pipeline Operations

The decision operations complement the existing `pipeline.stage.*` operations:

```
pipeline.stage.record('adr')     -- Records that the ADR stage is complete
pipeline.decision.propose(...)   -- Creates the actual decision artifact
pipeline.decision.accept(...)    -- HITL gate: unlocks specification stage
```

The `pipeline.stage.record('adr')` and `pipeline.decision.accept()` operations are linked but distinct: `stage.record` tracks pipeline state, while `decision.accept` tracks the artifact lifecycle. Both MUST be completed before the specification stage gate passes.

---

## Part 7: Migration Path (JSONL to SQLite)

### 7.1 Overview

Per ADR-006, all operational data MUST move from JSONL files to SQLite tables. This migration follows the existing pattern established in `src/store/migration-sqlite.ts`: read source file, parse each line, insert into table, validate row counts, keep originals as backup.

### 7.2 Migration Sources

| Source File | Target Table | Notes |
|-------------|-------------|-------|
| `.cleo/research/MANIFEST.jsonl` | `document_manifest` | Map `id`, `file`, `title`, `date`, `status`, `agent_type`, `topics` -> `topics_json`, `key_findings` -> `key_findings_json`, `actionable`, `needs_followup` -> `needs_followup_json`, `linked_tasks` -> `linked_tasks_json` |
| `.cleo/todo-log.jsonl` | `audit_logs` | Map each log entry to `event_type`, `entity_type`, `entity_id`, `details_json` |
| `.cleo/audit/decisions.jsonl` | `audit_logs` | Map `DecisionRecord` entries to `audit_logs` with `event_type = 'decision_recorded'`, `entity_type = 'decision'` |
| `.cleo/metrics/COMPLIANCE.jsonl` | `compliance` | Map `source_id`, `compliance.*` fields, `_context.agent_type`, `_context.validation_score`, `_context.violations` |
| `.cleo/metrics/TOKEN_USAGE.jsonl` | `token_usage` | Direct field mapping |
| `.cleo/rcsd/{epicId}/_manifest.json` | `lifecycle_pipelines` + `lifecycle_stages` | One pipeline row per epic, one stage row per stage entry |

### 7.3 Migration Requirements

| Requirement | Description |
|-------------|-------------|
| MIG-001 | Migration MUST be idempotent: running it twice produces the same result. |
| MIG-002 | Migration MUST preserve original JSONL files as backups (rename to `.jsonl.bak`). |
| MIG-003 | Migration MUST validate row counts: inserted rows MUST equal parsed lines. |
| MIG-004 | Migration MUST skip malformed lines with a warning (not fail the entire migration). |
| MIG-005 | Migration MUST be triggered via `admin.migrate` operation or `cleo migrate` CLI command. |
| MIG-006 | Migration MUST update the schema version in `schema_meta` table. |
| MIG-007 | Migration SHOULD be reversible: backup files allow manual restoration. |

### 7.4 Migration Sequence

```
1. Check schema version (skip if already migrated)
2. Create new tables (IF NOT EXISTS)
3. For each JSONL source:
   a. Read file
   b. Parse each line as JSON
   c. Transform to target table schema
   d. INSERT into target table
   e. Validate: count(inserted) == count(parsed)
   f. Rename source to .jsonl.bak
4. For each RCSD manifest:
   a. Read JSON file
   b. Create lifecycle_pipelines row
   c. Create lifecycle_stages rows (one per stage)
   d. Rename source to .json.bak
5. Update schema_meta version
6. Save database to disk
```

---

## Part 8: Downstream Invalidation

### 8.1 Supersession Cascade

When an accepted decision is superseded by a newer decision, downstream artifacts MUST be reviewed. This prevents stale specifications and implementations from continuing to reference an outdated architectural decision.

### 8.2 Cascade Rules

| Requirement | Description |
|-------------|-------------|
| CASCADE-001 | When a decision transitions to `superseded`, the system MUST identify all `task_decisions` rows where `relationship = 'implements'`. |
| CASCADE-002 | Tasks linked to a superseded decision SHOULD be flagged with a note indicating the governing ADR was superseded. |
| CASCADE-003 | Specifications linked to a superseded decision (via `decision_evidence` with `evidence_type = 'specification'`) SHOULD be flagged for review. |
| CASCADE-004 | Active `implementation` or `contribution` stages in pipelines governed by the superseded decision SHOULD be suspended pending review. |
| CASCADE-005 | The cascade MUST NOT automatically delete or cancel downstream artifacts. It MUST only flag them for review. |

### 8.3 Exit Codes

| Exit Code | Name | When |
|-----------|------|------|
| 65 | `HANDOFF_REQUIRED` | ADR drafted as `proposed`, awaiting HITL acceptance |
| 84 | `PROVENANCE_REQUIRED` | Attempted to create ADR without linked consensus report |
| 18 | `CASCADE_FAILED` | Downstream work blocked because governing ADR was superseded |

---

## Part 9: Conformance Criteria

### 9.1 Pipeline Conformance

A conforming implementation MUST:
- Define exactly 8 lifecycle stages in the order specified by Part 2
- Enforce gate prerequisites for the `adr` stage (consensus completed/skipped)
- Enforce gate prerequisites for the `specification` stage (adr completed/skipped)
- Support all 4 decision statuses: `proposed`, `accepted`, `superseded`, `deprecated`
- Require HITL interaction for the `proposed` -> `accepted` transition

### 9.2 Schema Conformance

A conforming implementation MUST:
- Create all 12 tables defined in Part 4
- Enforce all CHECK constraints on status/type enum columns
- Maintain referential integrity via foreign keys with ON DELETE CASCADE
- Use the `idx_` naming convention for all indexes

### 9.3 Evidence Chain Conformance

A conforming implementation MUST:
- Produce a `decision_evidence` row linking every decision to its originating consensus
- Produce an `audit_logs` row for every decision acceptance
- Produce a `lifecycle_transitions` row for every stage transition
- Produce a `lifecycle_gate_results` row for every gate check

### 9.4 Operation Conformance

A conforming implementation MUST:
- Expose all 7 decision operations in the `pipeline` domain (3 query + 4 mutate)
- Reject `decision.accept` for decisions not in `proposed` status
- Perform atomic updates when superseding decisions (both old and new in one transaction)

---

## Part 10: Related Specifications

| Document | Relationship |
|----------|--------------|
| `DOMAIN-CONSOLIDATION-SPEC.md` | AUTHORITATIVE for domain naming and pipeline operation routing |
| `protocols/adr.md` | AUTHORITATIVE for agent-facing ADR protocol requirements and output format |
| `protocols/consensus.md` | AUTHORITATIVE for consensus verdict structure |
| `protocols/specification.md` | AUTHORITATIVE for specification document format |
| `CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` | Related: compliance and token usage tables supersede JSONL equivalents |
| `MCP-SERVER-SPECIFICATION.md` | Related: new pipeline.decision.* operations extend the MCP contract |
| ADR-006 | AUTHORITATIVE for canonical SQLite storage architecture |

---

## Appendix A: Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-20 | Initial specification |

---

## Appendix B: Complete Table Summary

| # | Table | Category | Replaces | Rows Expected |
|---|-------|----------|----------|---------------|
| 1 | `decisions` | Decision | `.cleo/adrs/*.md` (as tracking records) | Low (10s) |
| 2 | `decision_evidence` | Decision | (new — no prior equivalent) | Low-Medium |
| 3 | `task_decisions` | Decision | (new — no prior equivalent) | Medium |
| 4 | `lifecycle_pipelines` | Lifecycle | `.cleo/rcsd/{epicId}/_manifest.json` | Low (per epic) |
| 5 | `lifecycle_stages` | Lifecycle | `.cleo/rcsd/{epicId}/_manifest.json` | Low (8 per pipeline) |
| 6 | `lifecycle_transitions` | Lifecycle | (new — no prior equivalent) | Medium |
| 7 | `lifecycle_gate_results` | Lifecycle | (new — no prior equivalent) | Medium |
| 8 | `lifecycle_evidence` | Lifecycle | (new — no prior equivalent) | Medium |
| 9 | `document_manifest` | Operational | `MANIFEST.jsonl` | High (100s) |
| 10 | `audit_logs` | Operational | `todo-log.jsonl` + `decisions.jsonl` | High (1000s) |
| 11 | `compliance` | Operational | `COMPLIANCE.jsonl` | Medium (100s) |
| 12 | `token_usage` | Operational | `TOKEN_USAGE.jsonl` | High (1000s) |

---

*End of Specification*
