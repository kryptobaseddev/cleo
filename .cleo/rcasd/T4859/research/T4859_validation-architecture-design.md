---
epic: T4859
stage: research
task: T4859
created: 2026-03-01
updated: 2026-03-01
---
# T4859: Protocol Output Validation Architecture — Design Document

**Task:** T4859 — Design: Protocol output validation flow — programmatic triggers and storage decision
**Parent:** T4855 — RCSD Schema Review & RCASD Rename Analysis
**Date:** 2026-02-25
**Status:** Complete
**Depends:** T4857 (schema analysis), T4858 (rename decisions)
**Input:** T4856 audit, T4857 schema analysis, T4858 rename decisions

---

## 1. Trigger Mechanism

### Options Evaluated

#### Option A: Gate at `ct complete` (RECOMMENDED)

**How it works:** When an agent calls `ct complete T1234`, the completion handler checks whether the task has a protocol label (research, consensus, specification, etc.). If so, it runs the protocol validator before allowing completion.

```
Agent work → writes output file → calls ct complete T1234
                                       ↓
                              Check task labels for protocol
                                       ↓
                              Run protocol validator
                                       ↓
                        Pass → complete task     Fail → exit code 60-67
```

**Pros:**
- Natural integration point — agents already call `ct complete`
- Blocking gate prevents incomplete outputs from being marked done
- Exit codes 60-67 already defined for protocol violations
- Existing `src/core/validation/protocols/` directory is scaffolded for this

**Cons:**
- Validation must be fast (blocks agent workflow)
- Requires protocol type to be detectable from task metadata

**UX:** Agent gets clear error with fix instructions on failure. No extra commands needed.

#### Option B: Post-hook on file write

**How it works:** A filesystem watcher or post-write hook triggers validation whenever a file is written to `claudedocs/agent-outputs/` or `.cleo/rcsd/`.

**Pros:** Catches validation issues immediately at write time.
**Cons:** Complex to implement (fs watchers are brittle), may fire on partial writes, no clear error channel back to agent. **Not recommended.**

#### Option C: Explicit validate command

**How it works:** Agent or user runs `ct validate --protocol research T1234` after completing work.

**Pros:** Explicit, opt-in, no surprises.
**Cons:** Easy to skip. Breaks the "pit of success" principle — validation should be automatic, not opt-in. Useful as a debug tool but not as the primary trigger. **Suitable as supplementary, not primary.**

#### Option D: At lifecycle stage transition

**How it works:** When pipeline advances from one stage to the next (e.g., research → consensus), validate that the previous stage's output meets requirements.

**Pros:** Natural for pipeline flow, catches gaps before downstream stages depend on outputs.
**Cons:** Stage transitions are already gated in `src/core/lifecycle/pipeline.ts`. Adding output validation here couples two concerns (stage readiness + output quality). **Could be a secondary check.**

### Decision: **Option A (ct complete gate) as primary, Option C (explicit command) as supplementary**

- Primary trigger: Protocol validation runs inside `ct complete` when task has a protocol label
- Supplementary: `ct validate --protocol <type> <taskId>` available for debugging/manual checks
- Stage transition check: Advisory warning (not blocking) when advancing stages without validated outputs

---

## 2. Storage Decision

### Options Evaluated

#### Option A: SQLite tables (drizzle-zod)

Store protocol output metadata in new Drizzle ORM tables.

```sql
-- Example schema (NOT a recommendation to create all of these)
protocol_outputs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  protocol TEXT,        -- 'research', 'consensus', etc.
  confidence REAL,      -- 0.0-1.0
  verdict TEXT,         -- 'PROVEN', 'REFUTED', etc.
  output_file TEXT,     -- path to full output
  validated_at TEXT,
  metadata JSON         -- flexible metadata blob
)
```

**Pros:** Queryable across sessions, aggregatable for metrics, aligns with T4800 SQLite migration.
**Cons:** Document-like data (findings arrays, evidence chains) maps poorly to relational tables. The rich nested structures from the archived schemas would need to be flattened or stored as JSON blobs — defeating the purpose of SQLite.

#### Option B: Validated file-based artifacts (RECOMMENDED)

Keep protocol outputs as files (markdown + JSON), but validate them with Zod schemas on write and record validation results in the existing `lifecycle_stages` SQLite table.

```
Output file: .cleo/rcsd/T1234/T1234_research.md (or .json)
                    ↓
            Zod validation at ct complete
                    ↓
            Record in lifecycle_stages:
              - stage_status: 'completed'
              - validated: true
              - confidence: 0.85
              - output_file: 'path/to/file'
```

**Pros:**
- Document-like data stays in files (natural format)
- Key metadata (confidence, verdict, validation status) recorded in SQLite for querying
- Aligns with existing `lifecycle_pipelines` / `lifecycle_stages` tables from T4800
- No new tables needed — extend existing schema with a few columns

**Cons:** Full document queries require reading files (but this is rare — usually you want metadata queries).

#### Option C: No structured storage

Outputs stay as unvalidated markdown files. MANIFEST.jsonl tracks file existence only.

**Pros:** Zero work.
**Cons:** Loses all the validation value identified in T4857.

### Decision: **Option B (validated file-based with metadata in SQLite)**

Protocol output documents remain as files. Validation runs via Zod schemas. Key metadata (confidence score, verdict, validation pass/fail, output file path) is recorded in the `lifecycle_stages` table alongside stage transition data.

### Schema Extension to `lifecycle_stages`

Add these optional columns to the existing `lifecycle_stages` Drizzle schema:

```typescript
// In src/store/schema.ts — extend lifecycle_stages table
output_file: text('output_file'),       // Path to protocol output file
confidence: real('confidence'),          // 0.0-1.0 (from research/consensus)
verdict: text('verdict'),                // PROVEN/REFUTED/CONTESTED/INSUFFICIENT
validated: integer('validated', { mode: 'boolean' }).default(false),
validated_at: text('validated_at'),      // ISO timestamp
validation_score: real('validation_score'), // 0.0-1.0 composite
```

This extends the existing table rather than creating new tables, keeping the schema simple.

---

## 3. Schema Format

### Decision: **Standalone Zod schemas in `src/core/validation/protocols/`**

The existing `src/core/validation/protocols/` directory already has `consensus.ts` and `specification.ts` with placeholder validators. Extend these with proper Zod schemas.

### Schema Design: Hybrid (Option D from T4857)

Validate critical fields only — not the full archived JSON Schema structure:

#### Research Output Validation Schema

```typescript
// src/core/validation/protocols/research.ts
import { z } from 'zod';

export const ResearchOutputMeta = z.object({
  confidence: z.number().min(0).max(1),
  sourceCount: z.number().int().min(0),
  findingsCount: z.number().int().min(0),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'partial']),
  hasEvidence: z.boolean(),
});
```

#### Consensus Report Validation Schema

```typescript
// src/core/validation/protocols/consensus.ts (extend existing)
export const ConsensusOutputMeta = z.object({
  confidence: z.number().min(0).max(1),
  consensusLevel: z.enum([
    'HIGH_CONFIDENCE', 'MEDIUM_CONFIDENCE', 'LOW_CONFIDENCE',
    'CONTESTED', 'INSUFFICIENT'
  ]),
  agentCount: z.number().int().min(2),
  totalClaims: z.number().int().min(0),
  provenCount: z.number().int().min(0),
  refutedCount: z.number().int().min(0),
  researchId: z.string().regex(/^res_[a-f0-9]{8}$/).optional(),
});
```

#### Specification Frontmatter Validation Schema

```typescript
// src/core/validation/protocols/specification.ts (extend existing)
export const SpecFrontmatter = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(['DRAFT', 'APPROVED', 'ACTIVE', 'IMMUTABLE', 'DEPRECATED']),
  taskId: z.string().regex(/^T\d{3,}$/),
  shortName: z.string().regex(/^[a-z0-9-]{3,25}$/),
  domain: z.string().regex(/^[a-z][a-z0-9-]*$/),
  synopsis: z.string().min(20).max(200),
  rfc2119: z.boolean().optional(),
  pipelineStage: z.enum([
    'initialized', 'research', 'consensus', 'architecture_decision',
    'specification', 'decomposition', 'complete'
  ]),
  consensusReportId: z.string().regex(/^cons_[a-f0-9]{8}$/).optional(),
  researchId: z.string().regex(/^res_[a-f0-9]{8}$/).optional(),
});
```

#### Contribution Metadata Validation Schema

```typescript
// src/core/validation/protocols/contribution.ts (new)
export const ContributionMeta = z.object({
  contributionId: z.string().regex(/^contrib_[a-f0-9]{8}$/),
  agentId: z.string().min(1).max(50),
  sessionId: z.string().regex(/^session_\d{8}_\d{6}_[a-f0-9]{6}$/),
  decisionCount: z.number().int().min(1),
  conflictCount: z.number().int().min(0),
  hasEvidence: z.boolean(),
  status: z.enum(['draft', 'complete', 'validated', 'merged']),
});
```

### What's NOT validated (deferred)

- Individual finding evidence chains (too deeply nested)
- Per-citation reliability scores
- Voting matrix weights and calculations
- Audit trail event sequences
- Raw tool response data

These can be added later as `z.passthrough()` extensions if needed.

---

## 4. Integration with Protocol Files

### Decision: **Protocol files are agent instructions only — NOT machine-parseable for validation**

**Rationale:**
- The 13 protocol files in `protocols/` are markdown documents with YAML frontmatter
- They define RFC 2119 requirements in natural language for agent consumption
- Parsing markdown to extract validation rules is fragile and error-prone
- The Zod schemas in `src/core/validation/protocols/` are the machine-readable validation counterpart

### Relationship Model

```
protocols/research.md          ←→  src/core/validation/protocols/research.ts
(agent instructions)                (machine validation)
  ↓                                   ↓
Agent reads & follows            ct complete runs validator
  ↓                                   ↓
Produces output file             Validates output metadata
```

**Enforcement mapping (protocol → validator → exit code):**

| Protocol File | Validator File | Exit Code |
|---------------|----------------|-----------|
| `protocols/research.md` | `src/core/validation/protocols/research.ts` | 60 |
| `protocols/consensus.md` | `src/core/validation/protocols/consensus.ts` | 61 |
| `protocols/specification.md` | `src/core/validation/protocols/specification.ts` | 62 |
| `protocols/decomposition.md` | (manifest entry check) | 63 |
| `protocols/implementation.md` | (manifest entry check) | 64 |
| `protocols/contribution.md` | `src/core/validation/protocols/contribution.ts` | 65 |
| `protocols/release.md` | (manifest entry check) | 66 |
| `protocols/adr.md` | (no validator — new stage) | — |
| `protocols/validation.md` | (manifest entry check) | — |
| `protocols/testing.md` | (manifest entry check) | — |
| `protocols/artifact-publish.md` | (manifest entry check) | 67 |
| `protocols/provenance.md` | (manifest entry check) | 67 |

**Priority for Zod schema creation:** Research, Consensus, Specification, Contribution (the 4 that had archived schemas). Other protocols use manifest-entry-level validation only.

---

## 5. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Workflow                           │
│                                                             │
│  1. Agent receives task with protocol label                 │
│  2. Agent reads protocols/<type>.md for instructions        │
│  3. Agent produces output file(s)                           │
│  4. Agent calls ct complete <taskId>                        │
│                                                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              ct complete handler                            │
│              (src/core/tasks/complete.ts)                   │
│                                                             │
│  1. Check task labels for protocol type                     │
│  2. If protocol found → run protocol validator              │
│  3. Validator reads output file, extracts metadata          │
│  4. Validate metadata against Zod schema                    │
│                                                             │
│  ┌─── PASS ───┐              ┌─── FAIL ───┐                │
│  │             │              │             │                │
│  ▼             │              ▼             │                │
│  Record in     │        Return exit         │                │
│  lifecycle_    │        code 60-67          │                │
│  stages table  │        with violations     │                │
│                │                            │                │
└────────────────┴────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              SQLite: lifecycle_stages                        │
│                                                             │
│  epic_id | stage | status | output_file | confidence |      │
│  validated | validated_at | validation_score | verdict       │
│                                                             │
│  → Queryable via ct dash, ct lifecycle show                 │
│  → Aggregatable for compliance metrics                      │
│  → Cross-session access for pipeline progression            │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. New Files/Tables Needed

### New Files

| File | Purpose |
|------|---------|
| `src/core/validation/protocols/research.ts` | Extend with `ResearchOutputMeta` Zod schema |
| `src/core/validation/protocols/consensus.ts` | Extend with `ConsensusOutputMeta` Zod schema |
| `src/core/validation/protocols/specification.ts` | Extend with `SpecFrontmatter` Zod schema |
| `src/core/validation/protocols/contribution.ts` | New — `ContributionMeta` Zod schema |
| `src/core/validation/protocols/index.ts` | Protocol validator registry and dispatcher |

### Existing Files to Modify

| File | Change |
|------|--------|
| `src/core/tasks/complete.ts` | Add protocol validation gate before marking done |
| `src/store/schema.ts` | Add optional columns to `lifecycle_stages` table |
| `drizzle/` | New migration for schema extension |

### No New SQLite Tables

The `lifecycle_stages` table (from T4800) is extended with optional columns. No new tables are created.

---

## 7. Decision Summary

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Trigger mechanism | Gate at `ct complete` + supplementary `ct validate` command | Natural integration, blocking, exit codes ready |
| 2 | Storage | File-based outputs + metadata in `lifecycle_stages` SQLite | Documents stay as files; key metrics queryable in SQLite |
| 3 | Schema format | Standalone Zod in `src/core/validation/protocols/` | Extends existing scaffold, aligns with drizzle-zod stack |
| 4 | Protocol file integration | Agent instructions only, not machine-parseable | Markdown parsing is fragile; Zod schemas are the machine counterpart |
| 5 | Scope | Hybrid — critical fields only (confidence, verdict, provenance) | Full archived schema restoration is over-engineered for current workflow |
| 6 | Priority | Research → Consensus → Specification → Contribution | Matches complexity ranking and pipeline flow order |

---

## 8. Implementation Sequence (for T4879 decomposition)

1. **Create Zod schemas** — 4 protocol validators with critical-field-only approach
2. **Create protocol validator dispatcher** — routes task protocol label to correct validator
3. **Integrate into ct complete** — add validation gate
4. **Extend lifecycle_stages schema** — add optional metadata columns + migration
5. **Add supplementary ct validate command** — explicit manual validation
6. **Write tests** — protocol validation unit tests + integration tests
7. **Update protocol-enforcement.ts** — align `ProtocolType` enum with RCASD-IVTR stages
