# Architecture Decision Record (ADR) Protocol

**Provenance**: @task T4798 (ADR-006 Implementation)
**Version**: 1.0.0
**Type**: Canonical Stage Protocol
**Max Active**: 1 (Must be singular per epic/decision branch)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Stage Transition | "after consensus", "begin adr" | Pipeline progression |
| Formalization | "lock in decision", "formalize choice" | Approving a consensus |
| Architectural Shift | "pivot", "new architecture", "supersede" | Modifying technical direction |
| Record Creation | "create adr", "write adr" | Explicit documentation |

**Explicit Override**: `--protocol adr` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| ADR-001 | MUST be generated strictly from an accepted Consensus report. |
| ADR-002 | MUST include a `consensus_manifest_id` linking to its provenance. |
| ADR-003 | MUST require explicit HITL (Human-in-the-Loop) approval to move from `proposed` to `accepted`. |
| ADR-004 | MUST include Context, Options Evaluated, Decision, Rationale, and Consequences. |
| ADR-005 | MUST trigger downstream invalidation: If an ADR is superseded, all downstream Specifications, Decompositions, and Implementations MUST be flagged for review. |
| ADR-006 | MUST be stored in the canonical `architecture_decisions` SQLite table via Drizzle ORM. |
| ADR-007 | MUST set `agent_type: "decision"` in manifest. |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| ADR-010 | SHOULD document the exact data structures or schema changes required by the decision. |
| ADR-011 | SHOULD explicitly list which existing ADRs (if any) are superseded. |
| ADR-012 | SHOULD flag known technical debt introduced by the decision. |

### MAY

| Requirement | Description |
|-------------|-------------|
| ADR-020 | MAY include diagrams (Mermaid) illustrating the architectural shift. |
| ADR-021 | MAY link to external prior art or research documents. |

---

## Output Format

### Frontmatter (Markdown Representation)

While the canonical record lives in SQLite (`cleo.db`), the markdown artifact MUST contain this frontmatter:

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
{What is the issue that we're seeing that is motivating this decision or change?}

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

---

## Pipeline Integration (RC-ADR-SD -> IVTR)

### The HITL Gate

1. Agent drafts the ADR based on Consensus.
2. Status is set to `proposed`.
3. Pipeline pauses (`HANDOFF_REQUIRED` - 75).
4. Human reviews the proposed ADR.
5. If approved, status transitions to `accepted`.
6. Only an `accepted` ADR unlocks the **Specification** and **Decomposition** stages.

### Downstream Invalidation (Cascade)

If an `accepted` ADR is later marked as `superseded`:
1. The pipeline MUST immediately identify all linked Specifications (via `SPEC-005` or SQLite relations).
2. The pipeline MUST flag the linked Epic's Decomposition as `needs-review`.
3. Any active `implement` or `verify` stages relying on the superseded ADR MUST be suspended until the Specification and Decomposition stages have been reconciled with the new ADR.

---

## Exit Codes

- `HANDOFF_REQUIRED` (65) - ADR drafted, awaiting human approval (HITL).
- `PROVENANCE_REQUIRED` (84) - Attempted to create an ADR without a linked Consensus report.
- `CASCADE_FAILED` (18) - Downstream work blocked because the governing ADR was superseded.

---

*Protocol Version 1.0.0 - Architecture Decision Record Protocol*
