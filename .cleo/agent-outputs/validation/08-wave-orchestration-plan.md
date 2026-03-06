# Validation Remediation Wave Orchestration Plan

## Scope Basis

- Inputs used: `00-validation-protocol.md` through `05-hygiene-audit.md` (no `06`/`07` present).
- Objective: remediate all `FAIL` and `PARTIAL PASS` findings, then re-validate all original claims in `T5374-T5412` under protocol rules from `00-validation-protocol.md`.
- Constraint: strict decomposition, token-safe execution, no implementation in this plan.

## Global Orchestration Rules (Token Safety + Handoffs)

- Hard token cap per agent: **185,000 tokens** (agent must stop before exceeding).
- Mandatory handoff trigger: **150,000 tokens consumed** (or earlier at natural checkpoint).
- Handoff package required at 150k trigger:
  - `status.md` with completed/in-progress/blocked items
  - `evidence-index.json` with file refs + command refs + verdict deltas
  - `resume.md` with exact next 3 actions and open risks
- No wave can start unless prior wave gate is marked `PASS` by Wave Lead and QA Reviewer.
- Any `S1` discrepancy (per protocol Section 5) halts downstream waves until resolved.

## Cross-Wave Artifact Contract (All Agents)

- Every agent must produce one artifact file under `.cleo/agent-outputs/validation/wave-<N>/` named `<agent-id>.md`.
- Required sections (in order):
  - `Mission`
  - `Inputs`
  - `Actions Taken`
  - `Evidence` (file paths + command outputs)
  - `Claim Verdict Deltas` (claim ID, old verdict, new verdict)
  - `Risks/Blockers`
  - `Handoff State` (token count + whether 150k trigger fired)
- Evidence rule: each claim change must include at least one code/file reference and one executable check reference unless explicitly static-only.

## Wave Plan

## Wave 0 - Intake, Freeze, and Decomposition

- Team structure:
  - `W0-L1` (Wave Lead): creates frozen claim ledger for `T5374-T5412`.
  - `W0-D1` (Dependency Analyst): maps prerequisites and cross-workstream coupling.
  - `W0-T1` (Token Steward): creates budget tracker and handoff checkpoints.
- Per-agent token budget:
  - `W0-L1`: 90k (handoff at 150k rule still applies)
  - `W0-D1`: 80k
  - `W0-T1`: 60k
- Artifact contract:
  - `W0-L1`: `claim-ledger.md` (all claims, current verdict, target verdict, dependency flags)
  - `W0-D1`: `dependency-map.md` (blocking graph, remediation order)
  - `W0-T1`: `token-control-matrix.md` (agent budgets, rollover policy, 150k trigger checklist)
- Verification gate `G0` (must pass before Wave 1):
  - Claim list completeness: all `T5374-T5412` present.
  - Dependency map includes all known `FAIL`/`PARTIAL PASS` findings from reports `03` and `04`.
  - Token tracker approved by lead + QA reviewer.

## Wave 1 - Blocker Remediation Design (Highest Severity)

- Goal: eliminate `FAIL` findings and MCP dispatch/gateway mismatches first.
- Team structure:
  - `W1-B1` (Memory Gateway Specialist): addresses Workstream B MCP wiring gap (`B3`).
  - `W1-C1` (Warp Gateway Specialist): addresses `T5405` missing operations.
  - `W1-DOC1` (Spec Consistency Specialist): addresses operation count drift (`B14` docs mismatch).
  - `W1-L1` (Wave Lead): integrates design decisions and conflict resolution.
- Per-agent token budget:
  - `W1-B1`: 170k
  - `W1-C1`: 170k
  - `W1-DOC1`: 120k
  - `W1-L1`: 110k
- Artifact contract:
  - `W1-B1`: `memory-gateway-remediation-spec.md` (ops matrix parity design + acceptance checks)
  - `W1-C1`: `warp-gateway-remediation-spec.md` (missing op inventory + routing design)
  - `W1-DOC1`: `operation-count-source-of-truth-plan.md` (canonical source + doc sync map)
  - `W1-L1`: `wave1-integration-decision-log.md` (final implementation-ready decomposition)
- Verification gate `G1`:
  - All previous `FAIL` items have remediation specs with explicit acceptance criteria.
  - Each spec maps to concrete claims/tasks (at minimum: `T5385`, `T5397`, `T5405`).
  - No unresolved architecture conflict between gateway, dispatch, and docs source-of-truth.

## Wave 2 - Partial Claim Remediation Design (C/D + Residual B)

- Goal: close all `PARTIAL PASS` gaps from Warp/Tessera and remaining spec/testing deltas.
- Team structure:
  - `W2-C2` (Chain Semantics Specialist): `T5399`, `T5402`, `T5403` partials.
  - `W2-D2` (Tessera Semantics Specialist): `T5409`, `T5410`, `T5412` partials.
  - `W2-B2` (Memory Coverage Specialist): residual B test-coverage asymmetry and bridge-level validation plan.
  - `W2-L1` (Wave Lead): cross-claim consistency review.
- Per-agent token budget:
  - `W2-C2`: 170k
  - `W2-D2`: 170k
  - `W2-B2`: 140k
  - `W2-L1`: 110k
- Artifact contract:
  - `W2-C2`: `chain-partial-gap-closure-plan.md` (missing claim elements + exact verification design)
  - `W2-D2`: `tessera-partial-gap-closure-plan.md`
  - `W2-B2`: `memory-coverage-closure-plan.md`
  - `W2-L1`: `wave2-consistency-report.md` (no contradictory acceptance criteria)
- Verification gate `G2`:
  - Every `PARTIAL PASS` claim has a closure path with measurable acceptance checks.
  - Test design covers missing claim elements called out in `04-workstream-cd-warp-tessera.md`.
  - Residual docs/hygiene implications captured and assigned.

## Wave 3 - Integration Readiness and Claim-to-Test Traceability

- Goal: ensure remediation packages are executable and traceable before QA execution.
- Team structure:
  - `W3-TM1` (Traceability Manager): creates claim-to-artifact and claim-to-test matrix.
  - `W3-R1` (Risk Officer): validates `S1/S2/S3` escalation coverage and stop conditions.
  - `W3-L1` (Wave Lead): readiness signoff.
- Per-agent token budget:
  - `W3-TM1`: 130k
  - `W3-R1`: 110k
  - `W3-L1`: 90k
- Artifact contract:
  - `W3-TM1`: `claim-test-traceability-matrix.md`
  - `W3-R1`: `escalation-readiness-checklist.md`
  - `W3-L1`: `wave3-readiness-signoff.md`
- Verification gate `G3`:
  - 1:1 mapping exists for each original claim -> remediation artifact -> verification command/check.
  - Escalation and halt criteria are explicitly testable.
  - Ready for independent QA wave.

## Wave 4 - Dedicated QA Wave (Independent Validation)

- Goal: independent QA validates remediation outcomes without relying on author assertions.
- Team structure:
  - `W4-QA1` (Hooks + Memory QA)
  - `W4-QA2` (Warp + Tessera QA)
  - `W4-QA3` (Docs + Hygiene QA)
  - `W4-QL` (QA Lead, independent from Waves 1-3 leads)
- Per-agent token budget:
  - `W4-QA1`: 175k
  - `W4-QA2`: 175k
  - `W4-QA3`: 130k
  - `W4-QL`: 120k
- Artifact contract:
  - `W4-QA1`: `qa-hooks-memory-verdicts.md`
  - `W4-QA2`: `qa-warp-tessera-verdicts.md`
  - `W4-QA3`: `qa-docs-hygiene-verdicts.md`
  - `W4-QL`: `qa-consolidated-verdicts.md` (authoritative QA gate record)
- Verification gate `G4`:
  - Independent evidence confirms each remediated claim outcome.
  - No open `FAIL`; any remaining `PARTIAL PASS` includes explicit defect record and re-entry plan.
  - QA Lead certifies reproducibility of all key checks.

## Wave 5 - Final Audit Wave (Full Re-validation of Original Claims)

- Goal: full end-state audit of all original claims from `00-validation-protocol.md` against frozen target revision.
- Team structure:
  - `W5-A1` (Protocol Auditor): reruns full claim matrix for `T5374-T5412`.
  - `W5-A2` (Evidence Auditor): validates completeness and authenticity of artifact trail across all waves.
  - `W5-A3` (Task-State Auditor): rechecks task-state consistency versus claim outcomes.
  - `W5-AL` (Audit Lead): final certification decision.
- Per-agent token budget:
  - `W5-A1`: 180k
  - `W5-A2`: 150k
  - `W5-A3`: 100k
  - `W5-AL`: 120k
- Artifact contract:
  - `W5-A1`: `final-protocol-revalidation-matrix.md`
  - `W5-A2`: `final-evidence-integrity-audit.md`
  - `W5-A3`: `final-task-state-audit.md`
  - `W5-AL`: `final-audit-certification.md` with one of: `certified`, `certified-with-exceptions`, `not-certified`
- Verification gate `G5` (program exit gate):
  - Full re-validation completed for every original claim in reports `00-05` scope.
  - Final verdict table includes `verified/partially verified/unverified` per claim with supporting evidence.
  - Any non-verified claim has a documented remediation backlog item and dependency impact.

## Token Budget Ledger (At-a-Glance)

| Wave | Agent Count | Max Budget/Agent | 150k Handoff Enforced | Notes |
|---|---:|---:|---|---|
| Wave 0 | 3 | 90k | Yes | Setup and decomposition only |
| Wave 1 | 4 | 170k | Yes | Blocker design first |
| Wave 2 | 4 | 170k | Yes | Partial-gap design closure |
| Wave 3 | 3 | 130k | Yes | Traceability + risk controls |
| Wave 4 (QA) | 4 | 175k | Yes | Independent validation |
| Wave 5 (Final Audit) | 4 | 180k | Yes | Full re-validation |

## Entry/Exit Criteria Summary

- Entry to any wave:
  - Prior gate is `PASS`.
  - Assigned artifacts from previous wave are present.
  - Agent budget + handoff monitor initialized.
- Exit from any wave:
  - All assigned agent artifacts complete and evidence-linked.
  - Gate checklist signed by Wave Lead + QA Reviewer.
  - Any blocker has escalation status and disposition.

## Non-Negotiables

- No code implementation inside this orchestration phase.
- No claim can be promoted to `verified` without executable evidence.
- No wave skipping: QA wave (Wave 4) and Final Audit wave (Wave 5) are mandatory.
