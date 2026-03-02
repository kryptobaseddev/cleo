---
id: ADR
title: Architecture Decision Record Protocol
version: 1.0.0
status: active
type: conditional
audience: [llm-agent, orchestrator]
tags: [adr, architecture, decisions]
skillRef: ct-spec-writer
lastUpdated: 2026-02-24
enforcement: advisory
---

# Architecture Decision Record (ADR) Protocol

**Provenance**: @task T4798 (ADR-006 Implementation)
**Version**: 1.1.0
**Type**: Conditional Protocol
**Stage**: RCADSD - A (ADR)
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Decision Recording | "decision", "adr", "architecture decision" | Formalizing a consensus verdict |
| Stage Transition | "after consensus", "begin adr" | Pipeline progression from consensus |
| Formalization | "lock in decision", "formalize choice", "decide" | Approving a consensus outcome |
| Architectural Shift | "pivot", "new architecture", "supersede" | Modifying technical direction |
| Record Creation | "create adr", "write adr", "record decision" | Explicit decision documentation |

**Explicit Override**: `--protocol adr` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| ADR-001 | MUST be generated from an accepted Consensus report verdict. |
| ADR-002 | MUST include a `consensus_manifest_id` linking to its originating consensus. |
| ADR-003 | MUST require explicit HITL (Human-in-the-Loop) approval to transition from `proposed` to `accepted`. |
| ADR-004 | MUST include Context, Options Evaluated, Decision, Rationale, and Consequences sections. |
| ADR-005 | MUST trigger downstream invalidation: if superseded, all downstream Specifications, Decompositions, and Implementations MUST be flagged for review. |
| ADR-006 | MUST be stored in the canonical `decisions` SQLite table via Drizzle ORM. |
| ADR-007 | MUST set `agent_type: "decision"` in manifest entry. |
| ADR-008 | MUST block the Specification stage until the ADR status is `accepted`. |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| ADR-010 | SHOULD document the exact data structures or schema changes required by the decision. |
| ADR-011 | SHOULD explicitly list which existing ADRs (if any) are superseded, with rationale. |
| ADR-012 | SHOULD flag known technical debt introduced by the decision. |
| ADR-013 | SHOULD document rejected alternatives with rationale for rejection. |

### MAY

| Requirement | Description |
|-------------|-------------|
| ADR-020 | MAY include diagrams (Mermaid) illustrating the architectural shift. |
| ADR-021 | MAY link to external prior art or research documents. |
| ADR-022 | MAY reference related ADRs that are not superseded but are contextually relevant. |

---

## Output Format

### Decision Status Lifecycle

```
proposed -> accepted -> superseded
                    \-> deprecated
```

| Status | Definition | Transition From | Requires |
|--------|------------|-----------------|----------|
| `proposed` | Drafted pending HITL review | (initial) | Consensus report link |
| `accepted` | Approved via HITL review | `proposed` | Human approval |
| `superseded` | Replaced by a newer decision | `accepted` | New ADR ID |
| `deprecated` | No longer applicable, not replaced | `accepted` | Deprecation reason |

### Frontmatter (Markdown Representation)

While the canonical record lives in SQLite, the markdown artifact MUST contain this frontmatter:

```yaml
---
id: ADR-XXX
title: "{Decision Title}"
status: proposed | accepted | superseded | deprecated
date: YYYY-MM-DD
consensus_manifest_id: {Manifest ID of the consensus verdict}
supersedes: [ADR-YYY]
superseded_by: [ADR-ZZZ]
---
```

### Document Structure

```markdown
# ADR-XXX: {Decision Title}

## 1. Context and Problem Statement
{What is the issue that is motivating this decision or change?}

## 2. Options Evaluated
{Derived from the Research and Consensus stages. List the options that were considered.}
* Option 1: {Description}
* Option 2: {Description}

## 3. Decision
{The exact, unambiguous technical decision.}

## 4. Rationale
{Why was this option chosen? Reference the consensus debate.}

## 5. Consequences
### Positive
* {Benefit}
### Negative
* {Trade-off}

## 6. Downstream Impact (Traceability)
{List the systems, specs, or decomposition epics that must be updated because of this decision.}
```

### File Output

```markdown
# ADR-XXX: {Decision Title}

**Task**: T####
**Epic**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: decision

---

## Summary

{2-3 sentence summary of the decision and its rationale}

## Decision

{The exact technical decision made}

## Key Consequences

| Impact | Description |
|--------|-------------|
| Positive | {Benefit 1} |
| Positive | {Benefit 2} |
| Negative | {Trade-off 1} |

## Supersession Chain

| ADR | Relationship | Status |
|-----|-------------|--------|
| ADR-YYY | Supersedes | superseded |
| ADR-ZZZ | Superseded by | (none yet) |
```

### Manifest Entry

@skills/_shared/manifest-operations.md

Use `cleo research add` to create the manifest entry:

```bash
cleo research add \
  --title "ADR: Decision Title" \
  --file "YYYY-MM-DD_adr-topic.md" \
  --topics "adr,decision,architecture" \
  --findings "Decision accepted,Option B selected,Supersedes ADR-YYY" \
  --status complete \
  --task T#### \
  --epic T#### \
  --actionable \
  --agent-type decision
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (start, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| research | Research provides evidence cited in the ADR context |
| consensus | Consensus produces the verdict that the ADR captures |
| specification | ADR acceptance gates the specification stage |
| decomposition | ADR governs which specification the decomposition implements |

### Pipeline Integration (RCADSD-ICR)

#### The HITL Gate

1. Agent drafts the ADR based on consensus verdict.
2. Status is set to `proposed`.
3. Pipeline pauses (`HANDOFF_REQUIRED` - exit code 65).
4. Human reviews the proposed ADR.
5. If approved, status transitions to `accepted`.
6. Only an `accepted` ADR unlocks the **Specification** stage.

#### Stage Sequencing

```
Consensus (completed)
    |
    v
ADR (proposed -> HITL -> accepted)
    |
    v
Specification (unblocked)
```

### HITL Escalation

| Condition | Action |
|-----------|--------|
| ADR drafted as `proposed` | Present to human for review and acceptance |
| Contested consensus verdict (no clear winner) | Flag in ADR context, request human tiebreak |
| Supersession of accepted ADR | Alert human: downstream artifacts need review |
| ADR contradicts existing accepted ADR | Require explicit supersession or rejection |

### Downstream Invalidation (Cascade)

If an `accepted` ADR is later marked as `superseded`:
1. The pipeline MUST identify all linked Specifications (via SQLite `decision_evidence` relations).
2. The pipeline MUST flag the linked Epic's Decomposition as `needs-review`.
3. Any active `implementation` or `contribution` stages relying on the superseded ADR MUST be suspended until the Specification and Decomposition stages have been reconciled with the new ADR.

---

## Example

**Task**: Record architecture decision for canonical SQLite storage

**Flow**:
1. Research (T4790) investigated storage strategies: JSON, JSONL, SQLite, hybrid
2. Consensus (T4797) reached: PROVEN verdict for SQLite-only with 90% confidence
3. ADR (T4798) captures the decision as ADR-006
4. HITL reviews and accepts ADR-006
5. Specification (T4776) formalizes the schema and migration requirements

**Manifest Entry Command**:
```bash
cleo research add \
  --title "ADR: Canonical SQLite Storage Architecture" \
  --file "2026-02-21_adr-006-sqlite-storage.md" \
  --topics "adr,architecture,sqlite,storage" \
  --findings "SQLite canonical for all operational data,JSON reserved for config only,Supersedes ADR-001 and ADR-002" \
  --status complete \
  --task T4798 \
  --epic T4772 \
  --actionable \
  --needs-followup T4776 \
  --agent-type decision
```

---

## Exit Codes

| Code | Name | When |
|------|------|------|
| 65 | `HANDOFF_REQUIRED` | ADR drafted as `proposed`, awaiting HITL acceptance |
| 84 | `PROVENANCE_REQUIRED` | Attempted to create an ADR without a linked Consensus report |
| 18 | `CASCADE_FAILED` | Downstream work blocked because the governing ADR was superseded |

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Creating ADR without consensus | Decisions lack evidence foundation (violates ADR-001) |
| Auto-accepting without HITL review | Bypasses human oversight gate (violates ADR-003) |
| Omitting downstream impact section | Future implementers unaware of cascade effects |
| Superseding without updating specs | Creates orphaned specifications referencing outdated decisions |
| Using ADR to define implementation requirements | That is the Specification's role; ADR captures the decision, not the how |
| Storing ADR only as markdown without SQLite record | Loses relational queries, lifecycle tracking, and evidence chain (violates ADR-006) |
| Skipping rejected alternatives | Loses institutional knowledge of why other options were ruled out |

---

*Protocol Version 1.1.0 - Architecture Decision Record Protocol*
