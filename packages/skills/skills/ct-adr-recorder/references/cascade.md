# Downstream Cascade Flow

When an `accepted` ADR is superseded, the cascade skill MUST reach every artifact that cites the old decision and flag it for review. This is the mechanism enforced by ADR-005.

## Cascade Trigger

The cascade fires on exactly one transition:

```
accepted --> superseded
```

No other transition (deprecation, rewrite, revision) runs the cascade. Deprecation marks the ADR stale without replacing it and does not invalidate downstream work.

## Query Model

The canonical source of linkage is the `decision_evidence` relation in the SQLite schema. Every downstream artifact that relied on an ADR MUST have inserted a row at the time it was created.

```sql
SELECT artifact_type, artifact_id, cited_section, cited_at
FROM decision_evidence
WHERE decision_id = :old_adr_id
  AND superseded_at IS NULL;
```

| Column | Meaning |
|--------|---------|
| `artifact_type` | `specification` / `decomposition` / `implementation` / `contribution` |
| `artifact_id` | Task id (`T####`) or spec id |
| `cited_section` | Which section of the ADR the artifact depended on |
| `cited_at` | Timestamp of the link |
| `superseded_at` | Set by the cascade when this row is flagged |

## Cascade Steps

1. **Query**: Run the query above. If the result set is empty, record `cascadeTargets: []` in the new ADR and continue — no downstream work exists.
2. **Classify**: Group rows by `artifact_type`. Specifications and decompositions get flagged `needs-review`. Implementations and contributions get suspended if currently active.
3. **Flag**: For each target, write the `needs-review` status to the task record and log the cascade manifest id.
4. **Suspend**: Any `active` implementation task MUST move to `blocked` with blocker `adr-superseded`. Active contribution records MUST attach a `contested` note citing the new ADR.
5. **Update** `decision_evidence`: Set `superseded_at = now()` on every flagged row.
6. **Record** in the new ADR's manifest entry:

```json
{
  "agent_type": "decision",
  "status": "accepted",
  "consensus_manifest_id": "CONS-2026-04-10-0021",
  "supersedes": ["ADR-0042"],
  "cascadeTargets": [
    {"artifact_type": "specification", "artifact_id": "T4776", "action": "flagged"},
    {"artifact_type": "implementation", "artifact_id": "T4790", "action": "suspended"}
  ]
}
```

## Cascade Failures

Exit code 18 (`CASCADE_FAILED`) fires when any of the following occur:

| Failure | Remediation |
|---------|-------------|
| Query returns rows but `cascadeTargets` is empty in the manifest | Populate `cascadeTargets` and rerun validation |
| A downstream task refuses the status transition | Inspect task state; resolve manually before retrying |
| `decision_evidence.superseded_at` could not be written | Check Drizzle transaction; do not split into partial writes |
| The new ADR does not list the old ADR in `supersedes[]` | Add the reference and rerun |

The cascade is a single atomic step from the lifecycle's point of view: either every downstream artifact is flagged or the supersession is rejected. Partial cascades are never acceptable.

## Suspension and Resume

A suspended implementation task stays blocked until:

1. The spec that cited the old ADR is updated against the new ADR.
2. The decomposition epic is re-planned.
3. The implementation is re-attached to the new ADR via a fresh `decision_evidence` row.
4. A human reviewer signs off the unblock.

The skill does not auto-resume suspended work. That is deliberately out of scope — reconciliation is the Specification and Decomposition stages' job.

## Relation to the HITL Gate

The supersession path does not go through the HITL gate at the `superseded` transition. HITL review happened once, when the new ADR was promoted from `proposed` to `accepted`. That review MUST have examined the cascade plan; the cascade itself is mechanical and runs without a second human pause.
