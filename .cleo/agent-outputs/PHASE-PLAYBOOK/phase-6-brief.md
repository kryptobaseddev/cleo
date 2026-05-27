# PHASE 6 BRIEF — High-Leverage Features

**Phase tracker:** T9237 (parent: T9232 MASTER)
**Team name:** `phase-6-nexus-cluster`
**You are:** `phase6-lead`
**Goal:** Land T1844 (Nexus edges — blocks 28 tasks), T9144 Nexus Restructure (W1-W6), T1135 (observability), T1136 (provenance), T1137 (worker runaway prevention).

## Why this phase

After foundation (Phase 4) is solid, time to ship the highest-leverage individual tasks:

1. **T1844** — Nexus edge completeness. Top leverage bottleneck (28 blocked tasks). Currently 0 emission for DEFINES/ACCESSES/METHOD_OVERRIDES/METHOD_IMPLEMENTS. Unblocking this opens the whole Nexus restructure.
2. **T9144 + 6 W-children** — MASTER EPIC: Nexus Restructure (T9145 W1 contracts, T9146 W2 LAFS meta._nexus, T9147 W3 CLI surgical split, T9148 W4 help+INJECTION, T9149 W5 project identity canonicalization, T9150 W6 DB topology split).
3. **T1135** — Observability event bus. Orchestrator can finally see streaming output from spawned workers. (Without this, you can't observe your own team!)
4. **T1136** — Commit-to-task-ID provenance. Every commit MUST trace to a Task. GitHub-issue-style attribution.
5. **T1137** — Worker runaway prevention + scope boundary enforcement.

## Sequence

**Wave A (parallel × 5):**
- T1844 (Nexus edge emission impl) — `phase6-edges` worker. **Highest priority — start first.**
- T9145 W1 (Contracts foundation: NexusOperationDescriptor + NEXUS_SCOPE_MAP + ConfidenceProvenance) — `phase6-w1-contracts` worker. Pure additive contracts work.
- T1135 (Observability event bus) — `phase6-observability` worker. Independent.
- T1136 (Provenance commit-to-task-ID) — `phase6-provenance` worker. Independent.
- T1137 (Worker runaway prevention) — `phase6-lifecycle` worker. Independent.

**Wave B (after Wave A — T9145 must be done):**
- T9146 W2 (LAFS meta._nexus extension) — depends on T9145
- T9147 W3 (CLI surgical split: cleo graph top-level + narrowed cleo nexus + alias shims) — depends on T9146
- T9148 W4 (Help renderer + INJECTION canonical + ct-cleo collapse) — depends on T9146

**Wave C (parallel after T9147):**
- T9149 W5 (Project identity canonicalization + pollution cleanup)
- T9150 W6 (Release 2 DB topology split: nexus-registry.db + nexus-graph)

## Done criteria

- T1844 emits non-zero DEFINES/ACCESSES/METHOD_OVERRIDES/METHOD_IMPLEMENTS edges for typescript fixtures
- `cleo graph` top-level CLI exists with project-scoped ops
- `cleo nexus` narrowed to cross-project + global-infra
- LAFS `meta._nexus` populated on all Nexus operations
- Orchestrator sees streaming output from spawned workers (T1135 verified)
- A commit without a Task ID is REJECTED (T1136 verified, may be opt-in via git hook initially)
- Worker exceeding scope boundary triggers an alert/halt (T1137 verified)
- Phase tracker T9237 complete (all 5 deps done; T1844 closes; T9144 closes with its W-children)
- `cleo deps validate VALID`, `cleo check coherence passed`
- BRAIN observation + `phase-6-completion-report.md`
- SendMessage Orchestrator `[Lead] complete: phase-6`

## Risk callouts

- T1844 may surface latent bugs in tree-sitter extractor — those become new tasks, not blockers.
- T9147 CLI surgical split is HIGH RISK: every Nexus call site needs updated alias shims. Stress-test before merging.
- T1136 commit-without-Task-ID rejection is breaking — discuss with orchestrator before making it a hard gate. Start as a warning, then promote.

## Critical rules

- Nexus changes MUST keep T1042's nexus.db schema backward compatible (or ship a forward migration).
- Help renderer changes (T9148) must keep token budget ≤720 per Delta plan.
- Run `cleo nexus rebuild` or equivalent after edge emission changes to populate the dev fixture.
