---
name: ct-adr-recorder
description: "Records Architecture Decision Records from accepted consensus verdicts. Use when promoting a consensus outcome to a formal ADR: drafts the document in the proposed-then-accepted HITL lifecycle, links to the originating consensus manifest, persists the decision to the canonical SQLite decisions table, and triggers downstream invalidation when an accepted ADR is later superseded. Triggers on phrases like 'write ADR', 'record architecture decision', 'formalize this decision', 'lock in the choice', 'create ADR-XXX', or when a consensus task reaches completed status and needs formalization."
protocol: architecture_decision
loomStage: architecture_decision
adrRefs:
  - ADR-053
  - ADR-070
---

# ADR Recorder

## Overview

Drafts, persists, and lifecycles Architecture Decision Records (ADRs) derived from accepted consensus verdicts. The skill owns the proposed-then-accepted HITL gate, writes the canonical markdown artifact, inserts the record into the SQLite `decisions` table via Drizzle, and orchestrates downstream invalidation whenever an accepted ADR is later superseded.

## Core Principle

> ADRs capture decisions from consensus verdicts, never from the author's own judgment.

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| ADR-001 | ADR MUST be generated from an accepted consensus report verdict. | `validateArchitectureDecisionProtocol` rejects entries without `consensus_manifest_id`; missing link deducts 25 from score. |
| ADR-002 | ADR MUST include a `consensus_manifest_id` field linking to the originating consensus. | Manifest entry field is required. |
| ADR-003 | ADR MUST require explicit HITL approval to transition from `proposed` to `accepted`. | `hitlReviewed: false` with `status: accepted` is rejected; exit code 65 (HANDOFF_REQUIRED). |
| ADR-004 | ADR MUST include Context, Options Evaluated, Decision, Rationale, and Consequences sections. | Regex check on the ADR body; missing section deducts 20 from score. |
| ADR-005 | Superseded ADRs MUST trigger downstream invalidation of linked Specifications, Decompositions, and Implementations. | `downstreamFlagged: false` on `status: superseded` fails validation; exit code 18 (CASCADE_FAILED). |
| ADR-006 | ADR MUST be persisted in the canonical `decisions` SQLite table via Drizzle ORM. | `persistedInDb: false` rejects the manifest entry. |
| ADR-007 | Manifest entry MUST set `agent_type: "decision"`. | Validator rejects any other value. |
| ADR-008 | ADR MUST block the Specification stage until status is `accepted`. | Lifecycle state machine refuses to advance past the ADR stage while status is `proposed`. |

## Status Lifecycle

```
proposed  --HITL review-->  accepted  --supersession-->  superseded
                               |
                               +------deprecation------>  deprecated
```

| Status | Transition From | Required Input | Effect |
|--------|-----------------|----------------|--------|
| `proposed` | (initial draft) | Consensus manifest id | Pipeline pauses; exit 65 HANDOFF_REQUIRED |
| `accepted` | `proposed` | Human review signal | Unblocks Specification stage |
| `superseded` | `accepted` | New ADR id | Fires downstream cascade (see references/cascade.md) |
| `deprecated` | `accepted` | Deprecation reason | Removed from canon without replacement |

The `proposed -> accepted` edge is the only HITL gate in the pipeline. A human reviewer MUST explicitly sign off; auto-promotion is forbidden.

## ADR Document Structure

Every ADR markdown artifact MUST carry frontmatter plus six canonical sections. Keep sections 1-5 concise; prose belongs in the downstream spec, not the ADR.

```markdown
---
id: ADR-0042
title: "Adopt Drizzle ORM v1 beta for all SQLite access"
status: proposed
date: 2026-04-06
consensus_manifest_id: CONS-2026-04-06-0017
supersedes: []
superseded_by: []
---

# ADR-0042: Adopt Drizzle ORM v1 beta for all SQLite access

## 1. Context and Problem Statement
Better-sqlite3 and raw drizzle 0.x diverge on schema introspection and block
forward migration of the `decisions` table.

## 2. Options Evaluated
* Option A: Stay on drizzle 0.29 and backport fixes.
* Option B: Move to drizzle 1.0.0-beta and accept API churn.
* Option C: Drop Drizzle, switch to Kysely.

## 3. Decision
Adopt drizzle-orm@1.0.0-beta project-wide; pin to a single beta tag.

## 4. Rationale
Derived from CONS-2026-04-06-0017 (verdict PROVEN, 0.82 confidence).
Option B preserves relational queries and unblocks the migration epic.

## 5. Consequences
### Positive
* Single ORM path; no downgrades.
### Negative
* API churn in each beta; pin required per release.

## 6. Downstream Impact (Traceability)
Flags specs T4776, T4781; decomposition epic T4772; live impl T4790.
```

A longer, realistic example with all six sections filled out lives in [references/examples.md](references/examples.md).

## Through SDK (preferred)

ADRs are first-class docs SSoT records — drafted via
`cleo docs add --type adr`, attached to the originating consensus task,
and numbered through the slug. This is the canonical write path; the
legacy "write to `docs/adr/ADR-NNNN.md` and commit" pattern is
deprecated below.

### Draft the ADR attached to its consensus task

```bash
cleo docs add T4798 docs/adr/ADR-0042.md \
  --type adr \
  --slug adr-0042-drizzle-v1-beta \
  --desc "ADR-0042: Adopt Drizzle ORM v1 beta for all SQLite access (status: proposed)" \
  --labels "adr,proposed"
```

- `--type adr` is the canonical taxonomy value. The closed set is
  `spec | adr | research | handoff | note | llm-readme`.
- `--slug` MUST follow `adr-<NNNN>-<short-topic>`. The numeric segment
  is the canonical ADR id; the topic segment makes the slug human
  readable. Collisions return `E_SLUG_RESERVED` with 3 alternatives
  (legacy `E_SLUG_TAKEN` aliased under `details.aliases` for one release —
  T10386).
- Near-duplicate slugs trigger `W_SLUG_SIMILAR` (T10361). The CLI
  surfaces the top match and hints `--allow-similar`. Use `--allow-similar`
  only when the new ADR genuinely forks from the existing one (e.g.
  versioned re-issue); every bypass is audited to
  `.cleo/audit/similar-bypass.jsonl`.
- Unknown flags fail fast with `E_UNKNOWN_FLAG` + did-you-mean
  suggestions (T10359) — `--lbls` becomes "did you mean --labels?".
- TODO(T10360 · E3.2 pending): when shipped, ADR drafts will accept
  `--title "<human title>"` and CLEO will auto-allocate the next
  `adr-NNN-<kebab-title>` via the E1 slug allocator. Until then,
  you MUST hand-pick the next free `NNNN` by inspecting
  `cleo docs list --type adr --project`. Example future call:
  ```bash
  # FUTURE — DO NOT USE until T10360 ships:
  # cleo docs add T4798 docs/drafts/draft.md --type adr \
  #   --title "Adopt Drizzle ORM v1 beta"
  ```
- The owner ID is the consensus task whose verdict drives the ADR
  (`T4798` above). This is how downstream supersession cascades find
  the chain — never attach an ADR to an arbitrary task.

### Persist the decision row alongside the doc blob

`cleo docs add --type adr` writes the document and the docs-side
manifest entry, but per Immutable Constraint ADR-006 the canonical
`decisions` table MUST also be populated via Drizzle. The two writes
are paired: doc blob first (SSoT-of-the-prose), then the relational
row (SSoT-of-the-decision). Skipping either is a validation failure.

### Publish the ADR to a git-tracked path

```bash
cleo docs publish --for T4798 --to docs/adr/ADR-0042.md
```

Atomic tmp-then-rename. The published file lands in the next commit;
the SSoT blob remains the canonical version-history root.

### Fetch the ADR back by slug (for HITL review + downstream supersession)

```bash
cleo docs fetch adr-0042-drizzle-v1-beta     # latest version
cleo docs versions --for T4798               # every SHA version
```

The HITL reviewer reads the proposed ADR via `cleo docs fetch` rather
than the on-disk file so the review anchors on the canonical SSoT
blob — drift between the published file and the blob is its own
review finding.

### List ADRs by type or status

```bash
cleo docs list --type adr --project          # every ADR in the project
cleo docs list --task T4798 --type adr       # ADRs attached to T4798
```

## Deprecated: Direct filesystem write

The legacy "write to `docs/adr/ADR-NNNN.md` and commit" pattern is
deprecated. The on-disk file drifts from the SSoT, the ADR has no
slug for the supersession cascade to retrieve it by, and the
consensus-task↔ADR linkage exists only as a frontmatter field
(`consensus_manifest_id`) rather than a relational owner edge.
Migrate to `cleo docs add --type adr --slug adr-<NNNN>-<topic>` for
every new ADR — and use `cleo docs sync --from docs/adr/ADR-NNNN.md
--for <taskId>` to back-fill existing on-disk ADRs into the SSoT.

## HITL Approval Gate

When a draft reaches `proposed`, the skill MUST:

1. Write the markdown artifact to disk.
2. Record the manifest entry with `status: proposed` and `agent_type: "decision"`.
3. Exit with code 65 (`HANDOFF_REQUIRED`).
4. Leave the pipeline paused until a human reviewer runs the approval path.

The agent MUST NOT:

- Promote a `proposed` ADR to `accepted` on its own.
- Retry the transition on a loop after exit 65.
- Edit the ADR body after exit 65 (any revision starts a new `proposed` cycle).

The human reviewer is expected to:

1. Read the markdown and the linked consensus manifest.
2. Confirm that every option from the consensus verdict appears in section 2.
3. Sign off by moving the status to `accepted` through the CLI and re-running validation with `hitlReviewed: true`.

## Downstream Cascade (on supersession)

When an accepted ADR is later superseded, the skill MUST:

1. Query the `decision_evidence` relation for every specification, decomposition, and implementation that cited the old ADR.
2. Flag each linked artifact as `needs-review`.
3. Suspend any active implementation or contribution task tied to the old ADR.
4. Record the cascade in the new ADR's manifest entry.

A missing cascade fails validation with exit code 18 (`CASCADE_FAILED`). The full flow, including the `decision_evidence` query and the manifest fields to populate, is documented in [references/cascade.md](references/cascade.md).

## Integration

Validate every ADR manifest entry through `cleo check protocol`:

```bash
# Draft reaches proposed: runs inside the skill, before HITL hand-off.
cleo check protocol \
  --protocolType architecture-decision \
  --taskId T4798 \
  --status proposed \
  --persistedInDb true \
  --adrContent "$(cat docs/adr/ADR-0042.md)"

# HITL accepts the ADR: rerun with the review flag.
cleo check protocol \
  --protocolType architecture-decision \
  --taskId T4798 \
  --status accepted \
  --hitlReviewed true \
  --persistedInDb true

# Later supersession: include the cascade flag.
cleo check protocol \
  --protocolType architecture-decision \
  --taskId T4798 \
  --status superseded \
  --downstreamFlagged true
```

Exit code 0 = valid. Exit code 65 = `HANDOFF_REQUIRED`. Exit code 18 = `CASCADE_FAILED`. Exit code 84 = `PROVENANCE_REQUIRED` (attempted ADR without a linked consensus).

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Drafting an ADR without a consensus verdict | Violates ADR-001; decision lacks evidence base | Run the consensus skill first; copy the manifest id into the ADR frontmatter |
| Auto-promoting `proposed` to `accepted` | Bypasses the HITL gate (ADR-003) | Stop at exit 65 and wait for the human reviewer |
| Persisting only the markdown, skipping SQLite | Violates ADR-006; loses relational queries | Insert via the `architectureDecisions` Drizzle table before exiting the skill |
| Omitting the Downstream Impact section | Future implementers can't find cascade targets (ADR-005) | Populate section 6 with every touched spec/epic/impl |
| Using the ADR to list implementation requirements | Blurs the ADR/spec boundary | Keep the ADR decision-only; push requirements to the specification stage |
| Superseding without running the cascade | Violates ADR-005; breaks the evidence chain | Query `decision_evidence`, flag artifacts, record the cascade in the new ADR |
| Editing an accepted ADR in-place | Breaks immutability and audit trail | Create a new ADR that supersedes the old one |

## Critical Rules Summary

1. ADRs MUST be drafted from an accepted consensus verdict, with `consensus_manifest_id` populated.
2. The `proposed -> accepted` transition MUST pass through a HITL review; agents stop at exit 65.
3. The ADR body MUST contain all five canonical sections (Context, Options, Decision, Rationale, Consequences).
4. The decision MUST be inserted into the canonical `decisions` SQLite table via Drizzle.
5. The manifest entry MUST set `agent_type: "decision"` and reference the output markdown file.
6. Superseding an accepted ADR MUST trigger the downstream cascade over linked specs, decomps, and impls.
7. Agents MUST NOT retry the HITL handoff on a loop; wait for the human reviewer.
8. Always validate via `cleo check protocol --protocolType architecture-decision` before exiting.

## See also / References

This skill binds to the **architecture_decision** LOOM lifecycle stage (underscored canonical form — `cleo lifecycle` source of truth). Governing ADRs:

- [ADR-053 — playbook runtime](../../../../.cleo/adrs/ADR-053-playbook-runtime.md) — defines the lifecycle state machine; the ADR stage is one of its 10 nodes.
- [ADR-070 — three-tier orchestration](../../../../.cleo/adrs/ADR-070-three-tier-orchestration.md) — defines the Orchestrator HITL gate that owns the `proposed → accepted` ADR transition.

### Naming Note (T9672)

The stage's canonical name is **`architecture_decision`** (underscored) because the `cleo lifecycle` CLI emits it that way. Historically `packages/skills/skills/manifest.json` `dispatch_matrix.by_protocol` used the dashed form `architecture-decision` — T9672 reconciled that key to the underscored form. The dashed form is retained only as a keyword alias under `dispatch_matrix.by_keyword` so legacy dispatch paths continue to resolve. Frontmatter on this skill (`protocol: architecture_decision`, `loomStage: architecture_decision`) uses the underscored form.

LOOM coverage matrix: [docs/skills/loom-coverage-matrix.md](../../../../docs/skills/loom-coverage-matrix.md).
