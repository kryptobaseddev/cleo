# Dogfood friction systemic triage — 2026-05-25

Source inputs:
- `cleo docs fetch cleo-canonical-north-star --json` verified attachment `1e10dec4-b95d-48fa-bb4c-4038abde6f26` / SHA `1d81886ba17aa980988c7ead0072d1cb32701919ce4d88b6cad60a2192d77e77`.
- `/mnt/projects/cleocode/temp/CleoCode-Agent-Issues.txt`.
- `cleo saga list`, `cleo tree`, and targeted `cleo find` checks against existing work.

## Goal

Convert the dogfood issue list from local friction notes into systemic harness improvements aligned to the canonical North Star, without creating a competing mega-saga or duplicating existing saga ownership.

## Steps

1. Verify the North Star attachment/SHA and read the dogfood issue file.
2. Classify each friction item by systemic failure mode.
3. Map each class to existing sagas/epics/tasks where possible.
4. Decompose accepted empty work where clear ownership already exists.
5. Add narrow missing observability/preflight tasks only where the current saga mesh lacks coverage.

## Owners

- Strategic map / North Star anchor: T10400.
- Merge train, spawn hygiene, release infra: T10431.
- Docs CLI simplification: T10516.
- Harness runtime: T10401.
- Agent tool registry: T10418.
- Release product/provenance: T9758.

## Executive finding

The issue list is not a bag of local bugs. It exposes six systemic harness bottlenecks:

1. Spawn/worktree reliability is still the sharpest agent-throughput bottleneck.
   - Symptoms: spawn timeout, partial worktrees, global install missing `worktree-napi`, worker dirty/unpushed stalls, manual worktree provisioning consuming 15–20 minutes per saga.
   - Existing work: T10431 / T10435, T10078, T10325, T10178.
   - Gap: observability should classify `running but idle`, `dirty but unpushed`, `PR open but no checks`, and `partial worktree locked` without the orchestrator spelunking directories.

2. Release/publish is a socio-technical bottleneck, not merely YAML.
   - Symptoms: queued runs, macOS runner starvation, OIDC per-package publish failures, stranded tags, npm EINTEGRITY, changelog/tag drift.
   - Existing work: T10431 / T10434 / T10436, T9758, T9761.
   - Gap: release readiness must verify artifact availability and registry consistency, not just local changelog/lint state.

3. Docs SSoT is directionally correct but over-complex for agents.
   - Symptoms: 24 subcommands, no intuitive replace path, split storage views, update/publish SHA mismatch, slug suffix invisibility, older blob selected by publish.
   - Existing work: T10516 created but had no child members at triage time.
   - Action taken in this triage: decompose T10516 into executable member epics.

4. Evidence/override gates are correct in principle but operationally too expensive under swarm load.
   - Symptoms: override cap already far above nominal cap, `pr:` evidence blocked by CI cancellation/race, DB/evidence lock contention.
   - Existing work: T9505, T9496, T10437.
   - Gap: the system should distinguish unsafe bypass from already-green administrative closeout, and should expose lock contention as first-class telemetry.

5. Lint baselines are encoding unstable coordinates instead of stable intent.
   - Symptoms: stdout/format/boundary baselines drift on line shifts; every formatting/import change causes baseline churn.
   - Existing work: T9927/T9928/T10232 related, but no clear content-marker migration task was found.
   - Recommendation: file or attach to the lint-batch effort a specific content-addressed baseline migration.

6. Agent-facing guidance and CLI hints must be regression-tested against the real CLI surface.
   - Symptoms: `cleo orchestrate spawn` error hint advertised flags that did not exist; `cleo memory observe --type decision` did not create decision rows; `docs add --replace` was expected but absent.
   - Existing work: T10430 fixed one instance; T10516 should cover docs; ct-cleo/ct-orchestrator should surface `decision-store` and not encourage ledger blobs.

## North Star alignment

The North Star already routes the biggest structural work correctly:
- T10401 owns daemon/IPC harness runtime.
- T10402 owns cockpit/operator TUI.
- T10418 owns agent tool registry.
- T10431 owns merge train / spawn hygiene / release infra.
- T10516 owns docs CLI simplification.

Therefore the right move is NOT to create a competing mega-saga. The optimization loop should:
1. Attach dogfood friction to existing sagas where ownership is clear.
2. Decompose empty sagas that are already accepted, especially T10516.
3. Add narrow missing tasks to observability/preflight epics rather than creating another planning layer.
4. Use BRAIN decisions for durable architectural decisions; keep North Star docs as navigable maps, not decision ledgers.

## Actions taken by this triage

- Verified canonical North Star attachment and SHA.
- Read and classified the issue file.
- Checked existing sagas/epics/tasks to avoid duplicating known work.
- Decomposed T10516 into member epics covering command surface, version/owner SSoT, storage coherence, agent decision routing, and regression harness.
- Added missing T10437 observability tasks for stalled worktrees and DB/evidence lock contention.

## Recommended next wave

1. Execute T10447 owner HITL if branch protection/merge queue is ready.
2. Execute T10435 A/B/C to close spawn timeout partial-state recovery.
3. Start T10516 Wave 0 after verifying docs update/publish current behavior with failing tests.
4. Add a content-addressed lint baseline task under the active lint epic if T10232 is the correct parent.
5. Patch ct-cleo / ct-orchestrator docs so decision-store is the default for decisions and ledger blobs are explicitly discouraged.
