---
name: ct-consensus-voter
description: "Runs structured multi-agent voting for decision tasks with confidence scores, conflict detection, and HITL escalation when the threshold is not met. Use when two or more agents must vote on options: architecture choices, tool selection, policy decisions, when a task carries agent_type:analysis, or on phrases like 'reach consensus', 'vote on options', 'resolve the debate', 'pick the best approach'. Produces a voting matrix JSON, enforces the 0.5 threshold, flags ties within 0.1 confidence as contested and escalates to human tiebreak."
---

# Consensus Voter

## Overview

Runs a structured vote across two or more agents on a decision question, records confidence and rationale per option, and emits a voting matrix that the rest of the pipeline can read. The skill enforces a configurable consensus threshold, detects contested verdicts, and escalates to HITL when evidence is insufficient.

## Core Principle

> Consensus requires evidence, rationale, and a threshold. Without all three, escalate.

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| CONS-001 | Vote MUST use the structured voting matrix format. | `validateConsensusProtocol` rejects entries with fewer than 2 options. |
| CONS-002 | Every position MUST carry a rationale string. | Missing rationale rejects the entry. |
| CONS-003 | Every confidence score MUST lie in `[0.0, 1.0]`. | Out-of-range scores fail validation. |
| CONS-004 | Every position MUST cite at least one evidence record. | Bare votes are rejected; evidence is non-optional. |
| CONS-005 | Conflicts MUST be flagged with a severity level (`critical` / `high` / `medium` / `low`). | A conflict without severity is a protocol violation. |
| CONS-006 | The vote MUST escalate to HITL when the top option's confidence is below the threshold (default 0.5). | Exit code 65 (`HANDOFF_REQUIRED`). |
| CONS-007 | Manifest entry MUST set `agent_type: "analysis"`. | Validator rejects any other value. |

## Voting Matrix Schema

Every consensus run produces a single JSON document that matches this shape:

```json
{
  "questionId": "CONS-0042",
  "question": "Which ORM should the monorepo standardize on?",
  "options": [
    {
      "name": "drizzle-v1-beta",
      "confidence": 0.82,
      "rationale": "defineRelations unblocks the cascade query",
      "evidence": [
        { "file": "drizzle-release-notes.md", "section": "v1.0.0-beta", "type": "doc" },
        { "file": "packages/core/src/orchestration/protocol-validators.ts", "section": "validateArchitectureDecisionProtocol", "type": "code" }
      ]
    },
    {
      "name": "kysely",
      "confidence": 0.41,
      "rationale": "cleaner long-term abstraction but invalidates migrations",
      "evidence": [
        { "file": "kysely-docs.md", "section": "migrations", "type": "doc" }
      ]
    }
  ],
  "threshold": 0.5,
  "verdict": "PROVEN",
  "actualConsensus": 0.82,
  "conflicts": []
}
```

The full schema, including rarer verdicts and conflict records, is in [references/matrix-examples.md](references/matrix-examples.md).

## Scoring Rules

| Rule | Description |
|------|-------------|
| **Score range** | `confidence ∈ [0.0, 1.0]`; out-of-range scores are rejected. |
| **Threshold** | Default 0.5. Can be overridden per task; MUST be recorded in the matrix. |
| **Top option** | The option with the highest confidence; ties break by rationale length (deterministic). |
| **Pass condition** | Top option confidence > threshold **and** no conflict has `severity: critical`. |
| **Fail condition** | Top option confidence ≤ threshold, OR a critical conflict is present. |

## Verdicts

| Verdict | Condition | Action |
|---------|-----------|--------|
| `PROVEN` | Top option ≥ threshold + reproducible evidence | Write manifest, exit 0, hand off to ct-adr-recorder |
| `REFUTED` | Counter-evidence invalidates the top option | Write manifest, exit 0, do not promote to ADR |
| `CONTESTED` | Top two options within 0.1 confidence | Flag as contested, exit 65 (HITL tiebreak) |
| `INSUFFICIENT_EVIDENCE` | No option reaches the threshold, OR fewer than 2 options have evidence | Exit 65, request additional research |

## Conflict Detection

A conflict exists when two options have confidence within 0.1 of each other *and* their rationales are mutually exclusive. The skill MUST record conflicts in the matrix:

```json
{
  "conflicts": [
    {
      "conflictId": "c-0042-01",
      "severity": "high",
      "conflictType": "contradiction",
      "positions": [
        { "option": "drizzle-v1-beta", "confidence": 0.82 },
        { "option": "kysely", "confidence": 0.79 }
      ],
      "resolution": { "status": "pending", "resolutionType": "escalate" }
    }
  ]
}
```

Conflicts with `severity: critical` always escalate, regardless of top-option confidence. Severity is assigned by the skill based on the blast radius of each option (e.g., reversible tool choice = `low`; irreversible schema migration = `high`; security-impacting = `critical`).

## HITL Escalation

The skill MUST escalate when:

1. Top option confidence < threshold.
2. Any conflict has `severity: critical`.
3. Top two options differ by less than 0.1 (contested).
4. Fewer than 2 options have evidence records.

On escalation:

1. Write the matrix to disk with `verdict: CONTESTED` or `verdict: INSUFFICIENT_EVIDENCE`.
2. Record the manifest entry with `agent_type: "analysis"` and `verdict` populated.
3. Exit with code 65 (`HANDOFF_REQUIRED`).
4. Do not attempt to re-run the vote in the same session.

## Integration

Validate the matrix through `cleo check protocol`:

```bash
cleo check protocol \
  --protocolType consensus \
  --votingMatrixFile ./.cleo/rcasd/T4797/consensus/T4797-consensus.json \
  --taskId T4797
```

Exit code 0 = matrix is valid and verdict is `PROVEN` or `REFUTED`. Exit code 65 = `HANDOFF_REQUIRED` (contested or insufficient evidence). Exit code 61 = `E_PROTOCOL_CONSENSUS` (matrix shape is invalid).

This skill typically hands off to ct-adr-recorder on a `PROVEN` verdict so the decision can be formalized.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Binary votes without confidence scores | Loses nuance (violates CONS-003) | Every position carries a score in `[0.0, 1.0]` |
| Positions without evidence | Bare opinions cannot produce consensus (violates CONS-004) | Every position cites at least one file/section/type |
| Accepting unanimous consensus uncritically | May indicate groupthink | The skill MUST still record rationale and check for hidden assumptions |
| Skipping minority positions | Loses valid concerns | Record every option the agents considered, including rejected ones |
| Premature escalation | Wastes human attention | Only escalate on the four listed conditions, not on every low-confidence vote |
| Treating the threshold as advisory | Breaks CONS-006 | The threshold is a hard gate; below it, escalate |
| Reusing a matrix across questions | Pollutes evidence chains | Each question gets its own `questionId` and its own matrix file |

## Critical Rules Summary

1. Every vote MUST produce a voting matrix with at least 2 options.
2. Every option MUST carry `confidence`, `rationale`, and at least one evidence record.
3. The threshold is a hard gate; below it, escalate to HITL with exit 65.
4. Conflicts within 0.1 confidence MUST be flagged as `CONTESTED`.
5. Critical-severity conflicts always escalate, regardless of top-option confidence.
6. Manifest entry MUST set `agent_type: "analysis"` and include the verdict.
7. On PROVEN, hand off to ct-adr-recorder; on CONTESTED or INSUFFICIENT_EVIDENCE, hand off to HITL.
8. Always validate via `cleo check protocol --protocolType consensus`.
