# T1007 Subtask Creation — Tier 3 Governed Execution Pipeline

**Date**: 2026-04-20
**Task**: T1007 (Tier 3 Subtask Creation Worker)
**Status**: complete

## Summary

21 subtasks created across T1009-T1012. Lifecycle advanced for all 4 parent tasks
(research started + completed, intermediate stages skipped, implementation started).
Wave 1 tasks (T1016, T1017, T1018) are confirmed ready to spawn.

---

## ID Mapping (Design → CLEO)

### T1009 — Agent-in-Container Sandbox Harness

| Design ID  | CLEO ID | Title |
|------------|---------|-------|
| T1009-S1   | T1016   | docker-compose.tier3.yml + sentient-agent Dockerfile |
| T1009-S2   | T1017   | seccomp profile for sentient-agent container |
| T1009-S3   | T1018   | llm-gateway sidecar (host-side HTTP proxy) |
| T1009-S4   | T1019   | kill-switch SIGTERM integration test |
| T1009-S5   | T1020   | host-side worktree creation helper |

### T1010 — Externally-Anchored Baseline + Signed Audit

| Design ID  | CLEO ID | Title |
|------------|---------|-------|
| T1010-S1   | T1021   | KMS adapter (CLEO_KMS_ADAPTER: env/file/vault/aws) |
| T1010-S2   | T1024   | baseline capture (daemon-side, pre-worktree) |
| T1010-S3   | T1022   | llmtxt/events schema + appendSentientEvent() |
| T1010-S4   | T1023   | metricsImproved gate + metrics-delta evidence atom |
| T1010-S5   | T1025   | verifyHashChain integration + chain-walker utility |
| T1010-S6   | T1026   | RFC 3161 daily anchor |

### T1011 — FF-Only Merge + Kill-Switch Re-Check

| Design ID  | CLEO ID | Title |
|------------|---------|-------|
| T1011-S1   | T1027   | 10-step kill-switch checker utility |
| T1011-S2   | T1028   | FF-only merge with abort-on-fail |
| T1011-S3   | T1029   | abort-to-clean-state protocol |
| T1011-S4   | T1030   | full merge ritual orchestrator |
| T1011-S5   | T1032   | merge ritual integration test (kill at step 6) |

### T1012 — cleo revert --from <receiptId>

| Design ID  | CLEO ID | Title |
|------------|---------|-------|
| T1012-S1   | T1036   | revert chain walker |
| T1012-S2   | T1038   | squashed revert executor |
| T1012-S3   | T1037   | global-pause + owner-signed resume |
| T1012-S4   | T1039   | cleo revert CLI command |
| T1012-S5   | T1040   | revert integration test |

---

## Dependency Graph (CLEO IDs)

```
T1016 (docker-compose + Dockerfile) ─────────────────────────────┐
T1017 (seccomp profile)                                           │
T1018 (llm-gateway)                                               │
T1019 (SIGTERM test) ← T1016, T1017                              │
T1020 (worktree helper) ← T1016                                   │
                                                                   ↓
T1021 (KMS adapter) ──────────────────────────────────────────────┐
T1022 (events schema) ────────────────────────────────────────────┤
T1023 (metricsImproved gate) ─────────────────────────────────────┤
T1024 (baseline capture) ← T1022, T1020                           │
T1025 (chain-walker) ← T1022                                      │
T1026 (RFC 3161 anchor) ← T1022                                   │
                                                                   ↓
T1027 (kill-check) ← T1022                                        │
T1028 (FF-only merge) ← T1022, T1023, T1020                       │
T1029 (abort protocol) ← T1016, T1020                             │
T1030 (experiment-runner) ← T1027, T1028, T1029                   │
T1032 (experiment test) ← T1030                                   │
                                                                   ↓
T1036 (revert walker) ← T1022, T1025                              │
T1037 (global-pause + resume) ← T1021                             │
T1038 (squashed revert executor) ← T1036                          │
T1039 (cleo revert CLI) ← T1036, T1038, T1037                     │
T1040 (revert integration test) ← T1039                           │
```

---

## Wave Plan (CLEO IDs)

| Wave | Tasks | Description |
|------|-------|-------------|
| Wave 1 | T1016, T1017, T1018 | Infrastructure — parallel, no deps |
| Wave 2 | T1019, T1020, T1021, T1022, T1023 | Parallel after Wave 1 |
| Wave 3 | T1024, T1025, T1026 | Chain foundation, needs Wave 2 |
| Wave 4 | T1027, T1028, T1029 | Merge ritual pieces, parallel after Wave 3 |
| Wave 5 | T1030, T1032 | Orchestrator + test, needs Wave 4 |
| Wave 6 | T1036, T1037, T1038 | Revert pieces, parallel after Wave 5 |
| Wave 7 | T1039, T1040 | CLI + integration test, needs Wave 6 |

---

## Lifecycle Advancement

All four parent tasks advanced:
- research: started → completed (evidence: DESIGN.md)
- consensus, architecture_decision, specification, decomposition: skipped
- implementation: started (in_progress)

T1009 pipelineStage: research → implementation
T1010 pipelineStage: research → implementation
T1011 pipelineStage: research → implementation
T1012 pipelineStage: research → implementation

---

## Wave 1 Ready IDs (confirmed via cleo orchestrate ready --epic T1009)

- **T1016** — docker-compose.tier3.yml + sentient-agent Dockerfile
- **T1017** — seccomp profile for sentient-agent container
- **T1018** — llm-gateway sidecar

These 3 can be spawned in parallel immediately.
