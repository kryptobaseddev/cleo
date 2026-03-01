---
epic: T4857
stage: research
task: T4857
created: 2026-03-01
updated: 2026-03-01
---
# T4857: Archived RCSD Schema Deep Analysis — Research Document

**Task:** T4857 — Research: Analyze the 4 archived RCSD output schemas and their protocol relationships
**Parent:** T4855 — RCSD Schema Review & RCASD Rename Analysis
**Date:** 2026-02-25
**Status:** Complete

---

## Executive Summary

Four RCSD documentation-output schemas (plus two structural schemas and one HITL schema) were archived during the AJV-to-drizzle-zod migration (T4786) because they had zero runtime code references. This analysis maps each schema to its protocol file, examines what it validated, identifies what active code exists for similar validation, and assesses whether restoration is warranted.

**Key finding:** The archived schemas defined rich structured validation (confidence scores, voting matrices, evidence chains, citation tracking) that the current codebase partially replaces with simpler MANIFEST.jsonl-based validators in `src/core/validation/protocols/` and `src/core/orchestration/protocol-validators.ts`. The current validators check manifest entry fields but do NOT validate the full structured output documents.

---

## Schema 1: `rcsd-research-output.schema.json` (v1.0.0)

### What It Validated

A comprehensive JSON document produced by the Research protocol stage:

| Section | Required | Fields |
|---------|----------|--------|
| `_meta` | Yes | `researchId` (pattern: `res_[a-f0-9]{8}`), `taskId`, `shortName`, `createdAt`, optional `version`, `completedAt`, `duration` |
| `query` | Yes | `original` (10-500 chars), optional `expanded`, `domains`, `exclusions`, `context` |
| `status` | Yes | Enum: `pending`, `in_progress`, `completed`, `failed`, `partial` |
| `sources` | Yes | `searched` count, `used` count, `byTool` breakdown (tavily, context7, webFetch, reddit, codebase), `citations` array |
| `findings` | Yes | Array of findings with `id` (pattern: `find_[a-f0-9]{6}`), `claim`, `evidence[]`, `sourceCount`, `confidence` (0.0-1.0), `relevance`, `category`, `tags` |
| `themes` | No | Cross-finding themes with `strength` (strong/moderate/weak) |
| `contradictions` | No | Conflicting findings with `severity` and `requiresConsensus` flag |
| `gaps` | No | Knowledge gaps with `importance` and `blocksFindings` references |
| `actionableItems` | No | Recommendations with `priority`, `basedOn` finding refs, `effort` (small/medium/large) |
| `confidence` | No | Overall score (0.0-1.0) with factor breakdown: sourceQuality, sourceDiversity, evidenceStrength, consistency, recency |
| `rawData` | No | Raw tool responses for audit (tavilyResponses, context7Responses, extractedContent) |

**Total fields defined:** ~60+ across root and definitions
**Definitions:** `citation` (7 fields), `finding` (9 fields), `theme` (5 fields), `contradiction` (6 fields), `gap` (5 fields), `actionableItem` (6 fields)

### Protocol Relationship

**Protocol file:** `protocols/research.md` (id: RSCH, v1.0.1, status: active)
- The protocol defines trigger conditions (investigation, analysis, discovery, documentation)
- Protocol references RFC 2119 MUST/SHOULD/MAY requirements
- Protocol's `skillRef` points to `ct-research-agent`
- The schema was designed to validate the JSON output produced when following this protocol

### Current Runtime Validation

**Active validators:**
- `src/core/orchestration/protocol-validators.ts:45-55` — `PROTOCOL_TYPES` array includes `'research'`; validates manifest entries (not full research documents)
- `src/core/validation/manifest.ts` — validates MANIFEST.jsonl entry structure
- `src/core/skills/manifests/research.ts` — research-specific manifest entry fields
- `src/mcp/lib/protocol-enforcement.ts:22` — `ProtocolType.RESEARCH` maps to exit code 60

**What's validated now vs what the schema validated:**

| Aspect | Schema (archived) | Current Runtime |
|--------|-------------------|-----------------|
| Document structure | Full JSON document | Manifest entry only |
| Confidence scores | 0.0-1.0 numeric with factor breakdown | Not validated |
| Citations | Typed, ID-referenced, per-source | Not validated |
| Finding evidence chains | Citation-linked with weights | Not validated |
| Source tool tracking | Per-tool breakdown (tavily, context7, etc.) | Not validated |
| Themes/contradictions/gaps | Cross-referenced to findings | Not validated |
| Metadata (researchId, timestamps) | Strict patterns | Partial (timestamp checked) |

### Assessment

**Validation gap: LARGE.** The current system validates that a manifest entry exists and has correct fields, but does not validate the actual research output document. The rich evidence chain (findings → citations → sources) and confidence scoring are completely unvalidated.

**Recommendation:** The confidence scoring and citation tracking are the most valuable parts to potentially restore. The full document validation may be over-engineered for the current markdown-based workflow.

---

## Schema 2: `rcsd-consensus-report.schema.json` (v1.0.0)

### What It Validated

A JSON document produced by the Consensus protocol stage:

| Section | Required | Fields |
|---------|----------|--------|
| `_meta` | Yes | `reportId` (pattern: `cons_[a-f0-9]{8}`), `taskId`, `shortName`, `createdAt`, optional `version`, `completedAt`, `duration` |
| `researchRef` | Yes | `researchId`, `file`, optional `query`, `findingsCount` — links back to research output |
| `agents` | Yes | Array (minItems: 2) of agents with `id` (pattern: `agent_[a-z]+`), `role` (advocate/critic/synthesizer/domain_expert/technical_reviewer/skeptic), `weight` (0.1-2.0) |
| `claims` | Yes | Array of claim validations with `id`, `originalFindingId`, `claim`, `verdict` (PROVEN/REFUTED/CONTESTED/INSUFFICIENT), `votes[]`, `evidence`, `confidence`, `consensusStrength` |
| `synthesis` | Yes | `summary` (50-2000 chars), `confidence` (0.0-1.0), `consensusLevel` (HIGH_CONFIDENCE/MEDIUM_CONFIDENCE/LOW_CONFIDENCE/CONTESTED/INSUFFICIENT), `keyInsights[]`, `recommendations[]`, `unresolvedIssues[]` |
| `statistics` | Yes | `totalClaims`, `proven`, `refuted`, `contested`, `insufficient`, `averageConfidence`, `consensusRate`, `processingTime` |
| `auditTrail` | No | Chronological entries: started, agent_joined, claim_evaluated, vote_cast, consensus_reached, synthesis_complete, completed |

**Total fields defined:** ~80+ across root and definitions
**Definitions:** `agent` (5 fields), `claimValidation` (10 fields), `vote` (5 fields), `auditEntry` (5 fields)

### Protocol Relationship

**Protocol file:** `protocols/consensus.md` (id: CONS, v1.0.1, status: active)
- Protocol defines trigger conditions (decision making, agreement, conflict resolution, validation)
- Protocol's `skillRef` points to `ct-validator`
- The schema was designed to validate the structured consensus report — the voting matrix, agent weights, and verdict computation

### Current Runtime Validation

**Active validators:**
- `src/core/validation/protocols/consensus.ts` — `validateConsensusTask()` function
  - Checks CONS-007: `agent_type === 'analysis'` on manifest entry
  - Validates manifest entry exists
  - Does NOT validate voting matrix, agent weights, verdicts, or synthesis
- `src/mcp/lib/protocol-enforcement.ts:23` — `ProtocolType.CONSENSUS` maps to exit code 61
- `src/mcp/lib/protocol-rules.ts` — defines consensus protocol rules (lightweight)

**What's validated now vs what the schema validated:**

| Aspect | Schema (archived) | Current Runtime |
|--------|-------------------|-----------------|
| Voting matrix | Full multi-agent vote structure | Not validated |
| Agent roles/weights | Typed with weight multipliers | Not validated |
| Verdicts | PROVEN/REFUTED/CONTESTED/INSUFFICIENT | Not validated |
| Consensus level | HIGH/MEDIUM/LOW/CONTESTED/INSUFFICIENT | Not validated |
| Statistics | totalClaims, proven, refuted, averageConfidence | Not validated |
| Audit trail | Chronological event log | Not validated |
| Research linkage | researchId cross-reference | Not validated |
| Manifest entry | — | `agent_type` check only |

### Assessment

**Validation gap: VERY LARGE.** The consensus schema defined the most sophisticated validation of any RCSD schema — weighted multi-agent voting, verdict computation, and statistical tracking. Current validation only checks that a manifest entry has the correct `agent_type`.

**Recommendation:** The voting matrix and verdict structure are central to CLEO's multi-agent consensus model. If CLEO intends to support real multi-agent consensus (not just markdown reports), this validation SHOULD be restored in some form.

---

## Schema 3: `rcsd-spec-frontmatter.schema.json` (v1.0.0)

### What It Validated

YAML frontmatter in specification documents (`*-SPEC.md`):

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Semver pattern (X.Y.Z) |
| `status` | Yes | Enum: DRAFT, APPROVED, ACTIVE, IMMUTABLE, DEPRECATED |
| `taskId` | Yes | Pattern: `T\d{3,}` |
| `shortName` | Yes | Pattern: `[a-z0-9-]{3,25}` |
| `domain` | Yes | Pattern: `[a-z][a-z0-9-]*` |
| `synopsis` | Yes | 20-200 chars |
| `created` | Yes | ISO date |
| `pipelineStage` | Yes | Enum: initialized, research, consensus, spec, decompose, complete |
| `title` | No | 10-100 chars |
| `updated` | No | ISO date |
| `author` | No | Agent identifier |
| `reviewers` | No | Array of reviewer IDs |
| `relatedFiles` | No | Typed references (research, consensus, impl-report, parent/child spec, schema, test, example) |
| `consensusVerdict` | No | Links to consensus output level |
| `consensusReportId` | No | Pattern: `cons_[a-f0-9]{8}` |
| `researchId` | No | Pattern: `res_[a-f0-9]{8}` |
| `dependsOn` / `supersedes` / `supersededBy` | No | Spec-to-spec dependency graph |
| `implementation` | No | Status, progress, reportFile, decomposedTasks |
| `validation` | No | schemaVersion, validatedAt, checksum |
| `rfc2119` | No | Boolean — whether spec uses RFC 2119 keywords |
| `confidenceScore` | No | 0.0-1.0 from consensus |

**Total fields defined:** ~25 root + `relatedFile` definition (4 fields)

### Protocol Relationship

**Protocol file:** `protocols/specification.md` (id: SPEC, v1.0.1, status: active)
- Protocol defines trigger conditions (design, contract, definition, protocol)
- Protocol's `skillRef` points to `ct-spec-writer`
- The schema validates the YAML frontmatter that spec writers MUST include in their output

### Current Runtime Validation

**Active validators:**
- `src/core/validation/protocols/specification.ts` — `validateSpecificationTask()` function
  - Checks SPEC-007: `agent_type === 'specification'` on manifest entry
  - Does NOT validate frontmatter content
- `src/mcp/lib/protocol-enforcement.ts:25` — `ProtocolType.SPECIFICATION` maps to exit code 62

**What's validated now vs what the schema validated:**

| Aspect | Schema (archived) | Current Runtime |
|--------|-------------------|-----------------|
| Frontmatter presence | Full YAML structure validated | Not validated |
| Version/status lifecycle | Semver + 5-state enum | Not validated |
| Pipeline provenance | Stage, consensusReportId, researchId links | Not validated |
| RFC 2119 flag | Boolean check | Not validated |
| Spec-to-spec dependencies | dependsOn/supersedes graph | Not validated |
| Implementation tracking | Status, progress, decomposedTasks | Not validated |

### Assessment

**Validation gap: MEDIUM.** Spec frontmatter is simpler than research/consensus schemas, but the pipeline provenance chain (research → consensus → spec) is broken without this validation. Specifications are the primary deliverable of the planning pipeline, so ensuring they have proper metadata is valuable.

**Recommendation:** Restore as a lightweight Zod schema. The frontmatter structure is simple enough that validation adds negligible overhead. The `pipelineStage` enum needs updating to include `architecture_decision`.

**Note:** The `pipelineStage` enum uses old 4-stage names (`initialized, research, consensus, spec, decompose, complete`) — would need to add `architecture_decision` for RCASD compatibility.

---

## Schema 4: `contribution.schema.json` (v2.0.0)

### What It Validated

Multi-agent contribution records implementing CONTRIB-001 through CONTRIB-015 RFC 2119 requirements:

| Section | Required | Fields |
|---------|----------|--------|
| `_meta` | Yes | `contributionId` (pattern: `contrib_[a-f0-9]{8}`), `protocolVersion`, `createdAt`, `completedAt`, `agentId`, `checksum`, `consensusReady` |
| `sessionId` | Yes | Pattern: `session_YYYYMMDD_HHMMSS_6hex` |
| `epicId` | Yes | Task pattern |
| `taskId` | Yes | Task pattern |
| `markerLabel` | Yes | Discovery label (3-50 chars, kebab-case) |
| `researchOutputs` | Yes | Array of files with `filePath`, `type` (analysis/research/specification/synthesis/comparison/notes), `researchId`, timestamps |
| `decisions` | Yes | Array (minItems: 1) of decisions with `questionId` (pattern: `[A-Z]+-\d{3}`), `question`, `answer`, `confidence` (0.0-1.0), `rationale` (20-2000 chars), `evidence[]` (minItems: 1), `uncertaintyNote`, `alternatives[]` |
| `conflicts` | No | Array with `conflictId`, `severity` (low/medium/high/critical), `conflictType` (contradiction/partial-overlap/scope-difference/priority-difference/evidence-conflict), `thisSession` position, `otherSession` position, `resolution` voting |
| `baselineReference` | No | Cross-session reference for conflict comparison |
| `status` | No | Lifecycle: draft, complete, validated, merged |
| `validation` | No | CONTRIB-XXX requirement results with pass/fail per requirement |

**Total fields defined:** ~120+ across root and 8 definitions
**Definitions:** `researchOutput`, `evidence`, `decision`, `alternative`, `sessionPosition`, `resolutionVote`, `resolution`, `conflict`, `validationResult`
**Includes:** Two complete JSON examples (563 and 720 lines respectively)

### Protocol Relationship

**Protocol file:** `protocols/contribution.md` (id: CONT, v1.1.1, status: active, type: cross-cutting)
- Cross-cutting protocol — applies across ALL RCSD-IVTR stages
- Protocol's `skillRef` points to `ct-contribution`
- The schema implements the full CONTRIB-001 through CONTRIB-015 specification
- This is the most complex schema, designed for multi-agent coordination

### Current Runtime Validation

**Active validators:**
- `src/core/skills/manifests/contribution.ts` — contribution-specific manifest fields
- `src/core/orchestration/protocol-validators.ts:51` — `'contribution'` in `PROTOCOL_TYPES`, maps to exit code 65
- `src/mcp/lib/protocol-enforcement.ts:28` — `ProtocolType.CONTRIBUTION` maps to exit code 65

**What's validated now vs what the schema validated:**

| Aspect | Schema (archived) | Current Runtime |
|--------|-------------------|-----------------|
| Decision matrix | Full questionId/answer/confidence/evidence structure | Not validated |
| Conflict detection | Cross-session comparison with voting | Not validated |
| Evidence chains | File/section/quote/line references | Not validated |
| CONTRIB-001 to CONTRIB-015 | Individual requirement pass/fail | Not validated |
| Session cross-references | sessionId, baselineReference | Not validated |
| Resolution workflow | propose → vote → accept/reject | Not validated |

### Assessment

**Validation gap: VERY LARGE.** The contribution schema is the most sophisticated of all archived schemas — it defines the entire multi-agent consensus workflow including cross-session conflict detection, resolution voting, and requirement-level validation. Current validation is manifest-entry-level only.

**Recommendation:** This schema represents significant design work for multi-agent coordination. If CLEO's multi-agent features remain a priority, this should be the first schema to restore. However, the full schema may be overspecified for current usage patterns — a phased restoration (decisions + evidence first, then conflicts + resolution) would be pragmatic.

---

## Cross-Cutting Analysis

### Schema Complexity Ranking

| Schema | Root Fields | Definitions | Total Fields | Complexity |
|--------|-------------|-------------|--------------|------------|
| `contribution.schema.json` | 12 | 8 | ~120+ | Very High |
| `rcsd-consensus-report.schema.json` | 7 | 4 | ~80+ | High |
| `rcsd-research-output.schema.json` | 10 | 6 | ~60+ | High |
| `rcsd-spec-frontmatter.schema.json` | 19 | 1 | ~25 | Medium |

### Pipeline Data Flow (How Schemas Connected)

```
Research Protocol          Consensus Protocol        Specification Protocol
     ↓                          ↓                          ↓
research-output.json  →  consensus-report.json  →  *-SPEC.md (frontmatter)
  res_[id]                  cons_[id]                 taskId + shortName
  findings[]                researchRef.researchId    consensusReportId
  citations[]               claims[].originalFindingId researchId
  confidence                synthesis.consensusLevel   confidenceScore
                            agents[].votes[]           pipelineStage

                    Contribution (cross-cutting)
                            ↓
                    contribution.json
                      decisions[].evidence[]
                      conflicts[].resolution.votes[]
```

The schemas formed an interconnected validation chain — research outputs link to consensus reports via `researchId`, consensus reports link to specs via `consensusReportId`. This provenance chain is entirely unvalidated in the current codebase.

### What Active Code Exists

| File | What It Does | Gap |
|------|-------------|-----|
| `src/core/orchestration/protocol-validators.ts` | Defines `PROTOCOL_TYPES` (9 types), `ManifestEntryInput` interface, exit code mapping | Only validates manifest entries, not full documents |
| `src/core/validation/protocols/consensus.ts` | `validateConsensusTask()` — checks `agent_type` on manifest | Single field check vs 80+ field schema |
| `src/core/validation/protocols/specification.ts` | `validateSpecificationTask()` — checks `agent_type` on manifest | Single field check vs 25 field schema |
| `src/core/validation/manifest.ts` | MANIFEST.jsonl entry validation | Generic manifest structure only |
| `src/core/skills/manifests/research.ts` | Research manifest entry fields | Subset of research-output fields |
| `src/core/skills/manifests/contribution.ts` | Contribution manifest entry fields | Subset of contribution fields |
| `src/mcp/lib/protocol-enforcement.ts` | `ProtocolType` enum, exit code mapping | Routing only, no document validation |
| `src/mcp/lib/protocol-rules.ts` | Protocol rule definitions | Lightweight rule checks |

### Protocol Type Divergence

Three different type systems define protocol/stage types, and they don't align:

| Type System | Values | Missing from PIPELINE_STAGES |
|-------------|--------|------------------------------|
| `PIPELINE_STAGES` (stages.ts) | 9: research, consensus, architecture_decision, specification, decomposition, implementation, validation, testing, release | — (canonical) |
| `PROTOCOL_TYPES` (protocol-validators.ts) | 9: research, consensus, specification, decomposition, implementation, contribution, release, artifact-publish, provenance | architecture_decision, validation, testing |
| `SkillProtocolType` (skills/types.ts) | 9: research, consensus, specification, decomposition, implementation, contribution, release, artifact-publish, provenance | architecture_decision, validation, testing |
| `ProtocolType` enum (protocol-enforcement.ts) | 10: all pipeline stages + contribution | artifact-publish, provenance |

This divergence means:
- `architecture_decision` has a pipeline stage but no protocol type and no validator
- `validation` and `testing` have pipeline stages but no protocol types in protocol-validators.ts
- `artifact-publish` and `provenance` have protocol types but are not pipeline stages

---

## Recommendations for T4859 (Design Phase)

### Option A: Restore as Zod Schemas (file-based)

- Convert JSON Schema → Zod schemas in `src/core/validation/schemas/`
- Validate output files on write (gate at `ct complete`)
- Pros: familiar pattern, no DB migration needed, works with markdown + JSON outputs
- Cons: file-based validation doesn't support cross-document queries

### Option B: Restore as SQLite Columns (drizzle-zod)

- Add protocol output tables to SQLite schema
- Store structured metadata alongside pipeline state
- Pros: queryable, cross-session, aligns with T4800 SQLite migration
- Cons: document-like data (findings, evidence) maps poorly to relational tables

### Option C: Accept Markdown-Only (no restoration)

- Current manifest-entry validation is sufficient
- Rich structured output was aspirational, not battle-tested
- Pros: zero work, no new complexity
- Cons: loses provenance chain, confidence scores, evidence tracking

### Option D: Hybrid — Critical Fields Only

- Restore confidence scores, verdict enums, and provenance links as Zod validations
- Skip deep structures (individual citations, vote weights, evidence chains)
- Validate at `ct complete` as a protocol gate
- Pros: captures the most valuable validation with minimal complexity
- Cons: partial coverage may create false confidence

### Recommended: Option D (Hybrid)

The archived schemas were designed for a fully-structured JSON workflow that never materialized. The current markdown + MANIFEST.jsonl approach works but loses the provenance chain and confidence tracking. A hybrid approach that validates the key signal fields (confidence, verdict, provenance links) without the deep evidence structures strikes the right balance.

---

## Appendix: Schema File Sizes

| File | Lines | Size |
|------|-------|------|
| `contribution.schema.json` | 723 | ~22 KB |
| `rcsd-consensus-report.schema.json` | 492 | ~16 KB |
| `rcsd-research-output.schema.json` | 565 | ~18 KB |
| `rcsd-spec-frontmatter.schema.json` | 226 | ~7 KB |
| `rcsd-index.schema.json` | (structural) | — |
| `rcsd-manifest.schema.json` | (structural) | — |
| `rcsd-hitl-resolution.schema.json` | (structural) | — |
