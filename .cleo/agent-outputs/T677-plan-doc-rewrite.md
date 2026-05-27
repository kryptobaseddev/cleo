# T677 — Plan Doc Rewrite: brain-synaptic-visualization-research.md

**Task**: T677
**Type**: Lead (documentation reconciliation)
**Status**: complete
**Date**: 2026-04-15
**Session**: ses_20260415172452_9cf242
**Parent epic**: T627

---

## Executive Summary

Rewrote `docs/plans/brain-synaptic-visualization-research.md` from v3 to v4. Every phase entry and constant count was verified against tasks.db state, git log, and source files before writing. No speculative claims included.

---

## Diff Summary

### §0 Locked Decisions

- **Added D-BRAIN-VIZ-14** (route rename): `/living-brain` → `/brain`, `/nexus` → `/code`, done in T649 (v2026.4.58, SHA 384443b0). Was missing from §0 per T662 council finding.

### §1 Status Truth Table — Complete Rewrite

Previous status truth table had stale entries. Updated:

| Phase | Previous | True Status |
|---|---|---|
| 2a | 🟡 IN PROGRESS | ✅ DONE — T635, v2026.4.58 |
| 2b | 🔴 OPEN | ✅ DONE — T643, v2026.4.58 |
| 2c | 🔴 OPEN | ✅ DONE — T644, v2026.4.58; GPU real fix T685 |
| 3a | 🔴 OPEN | ✅ DONE — T645, v2026.4.58 |
| 3b | 🔴 OPEN | 🟡 PARTIAL — code_reference=2,669 rows; documents/modified_by/affects/mentions=0 |
| 5 STDP | 🔴 OPEN | 🟡 IN PROGRESS — T673 epic, 21 tasks, 4 waves, per stdp-wire-up-spec.md |
| 6 3D | 🔴 OPEN | 🟡 IN PROGRESS — packages installed, components in working tree (UNTRACKED) |
| 7 Polish | 🔴 OPEN | 🟡 PARTIAL — T674/T675/T676 done; snapshot/query bar open |

### §3 Substrate Map — Constant Counts Updated

Previous doc claimed "31 kinds" (NEXUS_NODE_KINDS) and "22 types" (NEXUS_RELATION_TYPES). These were stale.

Verified counts (2026-04-15):
- `BRAIN_EDGE_TYPES`: **16** (was 12 in some references — T645 added co_retrieved + code_reference + affects + mentions)
- `BRAIN_NODE_TYPES`: **12**
- `NEXUS_NODE_KINDS`: **33** (was 31 in plan doc)
- `NEXUS_RELATION_TYPES`: **21** (was 22 in plan doc)

### §4 Cross-Substrate Edge Reality — Live Row Counts Added

Previous §4.1 was aspirational/misleading. New version includes live row counts from T662 council audit (T662-council-1-architecture.md):
- `code_reference`: 2,669 rows (dominant bridge, NOT previously listed as primary in §4.1)
- `applies_to`: 120 rows (text-ref backfill, not decision→task writer)
- `co_retrieved`: 0 rows (BUG-2 in STDP epic prevents writes)
- `documents`, `modified_by`, `affects`, `mentions`: 0 rows each
- `nexus_relations` `documents`/`applies_to`: 0 rows (schema-defined but no writer)

### §5 Hebbian Section Updated

Corrected claim: previous doc said Hebbian strengthener "works" without noting that it has produced 0 output rows in the live database due to BUG-2 (`entry_ids` format mismatch). Added note that code is correct but output is 0 due to STDP epic's BUG-2.

### §6.1 Shipped State Diagram Updated

Added three-way renderer toggle (2D/GPU/3D), noted Graphology shared store (T668), added T663 stub-node loader (2,894 cross-substrate edges), SSE endpoint (T643), and correct canvas route (/brain not /living-brain).

### §7 Phase Plan — All Phases Updated

- Phase 2: marked DONE with task IDs and commit SHA
- Phase 3: split into 3a (DONE) and 3b (PARTIAL) with accurate data
- Phase 5 STDP: full 4-wave breakdown added, 3 root-cause bugs listed, synthesis cited
- Phase 6 3D: packages installed noted, components in working tree noted as UNTRACKED
- Phase 7: T674/T675/T676 marked done; remaining items still open

### §9 Task Reference List — Expanded

Added T635, T643, T644, T645, T649, T660, T663, T664, T673, T674, T675, T676, T685, T686, T687 with correct status and version references.

### §11 Factual Citation Index — NEW SECTION

Added complete citation table with 26 rows, each claim cited to tasks.db, git log, file path, or agent-output report.

---

## Key Finding: Phase 6 NOT in a Release

The orchestrator prompt stated "FOUNDATION SHIPPED v2026.4.60 (T666-T671)". Investigation reveals:
- T666–T671 are marked done in tasks.db
- Files exist in working tree (`LivingBrain3D.svelte`, `/brain/3d/`, `living-brain-graph.ts`)
- **These files are UNTRACKED** — not committed to git
- v2026.4.60 does not exist (latest release is v2026.4.59, current HEAD is dbe48a84)

The plan doc marks Phase 6 as "IN PROGRESS — packages installed, components in working tree (UNTRACKED)" rather than "FOUNDATION SHIPPED" to reflect accurate git state.

---

## Files Changed

- `docs/plans/brain-synaptic-visualization-research.md` — ONLY file changed (doc-only per task rules)

## Quality Gates

- No source code files modified — verified via scope of this task
- Doc is self-consistent; §11 citation index cross-references every factual claim
- Markdown renders properly (standard GitHub-flavored markdown, no exotic extensions used)
