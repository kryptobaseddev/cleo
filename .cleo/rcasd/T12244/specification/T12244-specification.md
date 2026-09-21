---
epic: T12244
stage: specification
task: T12244
related:
  - type: task
    id: T12244
  - type: research
    path: ../research/T12244-research.md
  - type: consensus
    path: ../consensus/T12244-consensus.md
  - type: adr
    path: ../architecture/T12244-architecture-decision.md
created: 2026-09-18
updated: 2026-09-20
audience: maintainer
title: Behavioral acceptance requirements
similarity-exempt: RCASD stage doc — each stage of one task's pipeline deliberately restates the prior stage's conclusions before advancing them, so sibling stages of the SAME task are expected to score high against each other. Every flagged pair here is T12244-vs-T12244; none crosses a task boundary. Collapsing them would destroy the stage record the pipeline exists to produce.
---
# Behavioral acceptance requirements

## Goal

Acceptance requires verified behavior for every finding. This 2026-09-20 reconstruction expands T12244's recorded acceptance criteria into observable requirements from the approved closure work. It does not certify that those requirements are already met.

## Non-Goals

Do not infer deployment from a source commit, scientific authority from recovered documents, or authentic missing-record content from a plausible summary. No static analysis result guarantees complete runtime-call discovery. Successful command exit is not a substitute for the requested postcondition.

## Requirements

| Requirement | Independent acceptance oracle |
| --- | --- |
| Durable mutations | Fresh-process reads retain every accepted field, criteria, dependency and project owner. Injected failures between writes roll back all requested changes; concurrent creators retain distinct correct identities. Rejection exits unsuccessfully in every output mode. |
| Normalized inputs and truthful projections | Add, update, batch and saga share criteria normalization. Literal ambiguous delimiters remain intact. Every partial record names omissions; UTF-8 budgets retain mandatory truth or reject an impossible size. |
| Enumeration and matching | List, find, count, IDs and table share filters and distinguish matched from returned populations. Archive exclusion is explicit. Lexical matching is the default; fuzzy and semantic results identify their opt-in capability and match reason. |
| Contextual acceptance evidence | Bind each criterion to relevant changed artifacts and actual verification. Docs-only or unrelated PRs cannot prove a code fix; valid documentation/research evidence remains allowed. A blocked parent rollup must not undo a valid child completion. |
| Parser and graph truth | Large Unicode fixtures preserve identifiers and spans. Local mock shadows produce no false production edge. Nested callbacks have qualified identities. Ambiguous and dynamic references retain disposition evidence. |
| Freshness and safe publication | Detect edits, additions, renames, deletions and root/parser changes throughout the persisted inventory. Reject stale publication preconditions while preserving active and previous graph generations. |
| Repair execution | Test immutable proposal hashes, scoped idempotency, actual lease exclusion, stale-owner write fencing, cancellation, crash recovery, receipt persistence and resource-level rollback. Preserve unrelated edits and refuse conflicting affected-resource rollback. |
| Agent delivery | Actual installed Claude, Codex and Kimi workflows retrieve evidence, apply guarded repair, inspect receipts, reject stale proposals, verify and roll back. Missing accounts/interfaces remain unverified. |
| Release integrity | Required CI invokes the real gates with negative controls. Packed CLI and Studio execute correctly. Registry publication acceptance, content installability and requested dist-tag agreement remain separate observations. |

## Out-of-Scope

This documentation repair does not mutate Axiom, retag a release, change measured scientific results, or close provider certification. The owner waived npm human support submission; that waiver does not waive installability checks. Existing unrelated architecture debt is reported separately, never hidden by raising baselines.

## Verification sources

The original full task T12244 contains twelve criteria, including its six child outcomes. Its 2026-09-19 correction points to T12256 for unresolved acceptance. Current detailed findings and recovery procedures are in `trustworthy-knowledge-closure-ledger-20260919`; the consulted 309,610-byte snapshot has SHA256 `04ea6d87e43637eee57c757d488bc65abd74a34f33c3c5e7ea1a1869baaef9f5`. Preserve the original specification via `t12244-original-specification-pr1497-8dff356`.
