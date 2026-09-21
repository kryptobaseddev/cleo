---
epic: T12244
stage: architecture_decision
task: T12244
related:
  - type: task
    id: T12244
  - type: research
    path: ../research/T12244-research.md
  - type: consensus
    path: ../consensus/T12244-consensus.md
created: 2026-09-18
updated: 2026-09-20
audience: maintainer
title: Shared knowledge and repair service boundaries
similarity-exempt: RCASD stage doc — each stage of one task's pipeline deliberately restates the prior stage's conclusions before advancing them, so sibling stages of the SAME task are expected to score high against each other. Every flagged pair here is T12244-vs-T12244; none crosses a task boundary. Collapsing them would destroy the stage record the pipeline exists to produce.
---
# Shared knowledge and repair service boundaries

## Preserve the shared service boundaries

This reconstruction dated 2026-09-20 records the architecture already described by the canonical implementation plan and the current repair requirements. It is not a new ADR or evidence of historical consensus.

| Responsibility | Existing package boundary |
| --- | --- |
| Shared evidence, coverage, operation and receipt types | `packages/contracts` |
| Domain rules, durable mutations, execution context and repair services | `packages/core` |
| Extraction, lexical resolution and graph indexing | `packages/nexus` |
| Command parsing and thin dispatch | `packages/cleo` |
| Provider runtime behavior and programmatic spawning | `packages/cleo-os` |
| Instruction and agent-manifest packaging | `packages/caamp` |

The design extends existing services. Nexus consumes an injected execution port rather than importing core. Shared source-root resolution preserves a stable parent project while representing each explicitly included repository and its revision. Independent repositories with identical filenames must not collapse into an ambiguous checkout identity.

## Separate precision, coverage, and authority

Coverage reports current, stale, partial, missing, or failed independently of impact risk. UNKNOWN means evidence is insufficient; NONE means no impact was detected within an assessed scope and still carries static-analysis limits. Compact output keeps mandatory truth fields before examples.

Declarations, calls, and property access share lexical binding rules. Nested callbacks and anonymous functions need source-span identities tied to the publication generation. Known local shadows must not resolve to global production names. Ambiguous, dynamic, and external references remain inspectable with spans, candidates, and reasons. Static extraction never proves every runtime call.

Authority uses explicit sourced replacement and historical relationships. Eligibility must be consistent across lexical, semantic, graph-expanded, and briefing retrieval. Relational records remain authoritative; optional semantic discovery cannot invent replacement authority or require another model account for foreground learning.

## Publication and recovery are distinct guarantees

Validate a staged graph and full source inventory before atomic publication. Recheck affected source and expected-generation preconditions at commit. Retain active and previous generations, plus generations referenced by recovery. A source change or rejected publication must preserve the prior graph.

Core repair operations use immutable proposals, captured actor/project/deadline/cancellation, idempotency, leases and same-transaction fencing. Receipts, journal checkpoints, and resource-level guarded rollback belong to the existing lifecycle. These are required contracts, not a claim that every consumer already enforces them. T12256 tracks remaining wiring and verification.

## Architecture sources

Canonical plan `trustworthy-knowledge-implementation`, SHA256 `17232a7dc2f80a7699090537e7b5fd3dbe617c53742a4a532a940abab3f7d65b`; current T12256 closure requirements; repository package-boundary rules; preserved original `t12244-original-architecture-pr1497-8dff356`. The original release-integrity handoff is retained unchanged and does not become architecture approval merely because it was merged locally.
