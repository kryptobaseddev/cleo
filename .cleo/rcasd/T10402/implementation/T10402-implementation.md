---
epic: T10402
stage: implementation
task: T10402
related:
  - type: saga
    id: T10402
  - type: research
    path: ../research/T10402-research.md
  - type: spec
    path: ../specification/T10402-specification.md
  - type: decomposition
    path: ../decomposition/T10402-decomposition.md
created: 2026-05-27
updated: 2026-05-27
---

# Implementation (T10402) — SG-COCKPIT-HARNESS

## Status

| Task | Title | Status | Assignee | Notes |
|------|-------|--------|----------|-------|
| 1 | COCKPIT-SCAFFOLD | pending | — | — |
| 2 | IPC-LAYER | pending | — | Blocked on daemon mock |
| 3 | LAYOUT-FRAMEWORK | pending | — | — |
| 4 | HUD-PANEL | pending | — | — |
| 5 | PIPELINE-PANEL | pending | — | — |
| 6 | ORCHESTRATOR-PANEL | pending | — | — |
| 7 | ISOLATION-ZONE | pending | — | Gated by T10420 D8 (rmux) |
| 8 | IPC-INTEGRATION | pending | — | Blocked on T10401 daemon |
| 9 | E2E-INTEGRATION | pending | — | Blocked on Task 8 |
| 10 | BOUNDARY-LAFS-EXT | pending | — | — |

## Blockers

- **T10420 D8 (RMUX)**: Task 7 multiplexer strategy depends on council decision
- **T10401 Daemon**: Tasks 8-9 require a running `cleo daemon serve` for real integration
- **T10400 SDK API**: Operation schemas must be finalized before Cockpit can consume them
- **Task 2 mock daemon**: Until T10401 ships, Cockpit dev needs a mock daemon returning canned LAFS envelopes

## Notes

- Wave 1 tasks (1-3) can begin immediately; they depend only on the Cargo workspace
- Wave 2 tasks (4-7) can be developed against a mock daemon before T10401 ships
- Wave 3-4 tasks (8-9) require T10401 daemon
- Task 10 is a minor cross-cutting change that should ship early (no blockers)
