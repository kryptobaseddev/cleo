# ADR Backfill Walker Report — T1829

**Date**: 2026-05-05
**Mode**: APPLIED
**Task**: T1829
**Epic**: T1824

---

## Summary

| Category | Count |
|----------|-------|
| Inserted (or would-insert in dry-run) | 60 |
| Skipped — row already exists | 0 |
| Skipped — collision (HITL needed) | 4 |
| Skipped — error | 0 |
| Duplicate-pair supersession applied | 2 |

---

## Inserted Rows

- **ADR-003** (`ADR-003-mcp-engine-unification.md`)
  - Decision ID: `D001`
  - Inserted as D001 (adrNumber=3, state=accepted)
- **ADR-004** (`ADR-004-typescript-first-architecture.md`)
  - Decision ID: `D002`
  - Inserted as D002 (adrNumber=4, state=accepted)
- **ADR-005** (`ADR-005-migration-safety.md`)
  - Decision ID: `D003`
  - Inserted as D003 (adrNumber=5, state=accepted)
- **ADR-006** (`ADR-006-canonical-sqlite-storage.md`)
  - Decision ID: `D004`
  - Inserted as D004 (adrNumber=6, state=accepted)
- **ADR-007** (`ADR-007-domain-consolidation.md`)
  - Decision ID: `D005`
  - Inserted as D005 (adrNumber=7, state=accepted)
- **ADR-008** (`ADR-008-CLEO-CANONICAL-ARCHITECTURE.md`)
  - Decision ID: `D006`
  - Inserted as D006 (adrNumber=8, state=accepted)
- **ADR-009** (`ADR-009-BRAIN-cognitive-architecture.md`)
  - Decision ID: `D007`
  - Inserted as D007 (adrNumber=9, state=accepted)
- **ADR-010** (`ADR-010-node-sqlite-engine-choice.md`)
  - Decision ID: `D008`
  - Inserted as D008 (adrNumber=10, state=accepted)
- **ADR-011** (`ADR-011-project-configuration-architecture.md`)
  - Decision ID: `D009`
  - Inserted as D009 (adrNumber=11, state=accepted)
- **ADR-012** (`ADR-012-drizzle-kit-migration-system.md`)
  - Decision ID: `D010`
  - Inserted as D010 (adrNumber=12, state=accepted)
- **ADR-013** (`ADR-013-data-integrity-checkpoint-architecture.md`)
  - Decision ID: `D011`
  - Inserted as D011 (adrNumber=13, state=accepted)
- **ADR-014** (`ADR-014-rcasd-rename-and-protocol-validation.md`)
  - Decision ID: `D012`
  - Inserted as D012 (adrNumber=14, state=accepted)
- **ADR-015** (`ADR-015-multi-contributor-architecture.md`)
  - Decision ID: `D013`
  - Inserted as D013 (adrNumber=15, state=accepted)
- **ADR-016** (`ADR-016-installation-channels-and-dev-runtime-isolation.md`)
  - Decision ID: `D014`
  - Inserted as D014 (adrNumber=16, state=accepted)
- **ADR-017** (`ADR-017-verb-and-naming-standards.md`)
  - Decision ID: `D015`
  - Inserted as D015 (adrNumber=17, state=accepted)
- **ADR-018** (`ADR-018-unified-status-registry.md`)
  - Decision ID: `D016`
  - Inserted as D016 (adrNumber=18, state=accepted)
- **ADR-019** (`ADR-019-canonical-logging-architecture.md`)
  - Decision ID: `D017`
  - Inserted as D017 (adrNumber=19, state=superseded)
- **ADR-020** (`ADR-020-session-architecture-cleanup.md`)
  - Decision ID: `D018`
  - Inserted as D018 (adrNumber=20, state=accepted)
- **ADR-021** (`ADR-021-memory-domain-refactor.md`)
  - Decision ID: `D019`
  - Inserted as D019 (adrNumber=21, state=accepted)
- **ADR-022** (`ADR-022-task-completion-hardening.md`)
  - Decision ID: `D020`
  - Inserted as D020 (adrNumber=22, state=accepted)
- **ADR-023** (`ADR-023-protocol-validation-dispatch.md`)
  - Decision ID: `D021`
  - Inserted as D021 (adrNumber=23, state=accepted)
- **ADR-024** (`ADR-024-multi-store-canonical-logging.md`)
  - Decision ID: `D022`
  - Inserted as D022 (adrNumber=24, state=accepted)
- **ADR-025** (`ADR-025-warp-protocol-chains.md`)
  - Decision ID: `D023`
  - Inserted as D023 (adrNumber=25, state=accepted)
- **ADR-026** (`ADR-026-release-system-consolidation.md`)
  - Decision ID: `D024`
  - Inserted as D024 (adrNumber=26, state=accepted)
- **ADR-027** (`ADR-027-manifest-sqlite-migration.md`)
  - Decision ID: `D025`
  - Inserted as D025 (adrNumber=27, state=accepted)
- **ADR-028** (`ADR-028-changelog-generation-model.md`)
  - Decision ID: `D026`
  - Inserted as D026 (adrNumber=28, state=accepted)
- **ADR-029** (`ADR-029-contributor-project-dev-channel-detection.md`)
  - Decision ID: `D027`
  - Inserted as D027 (adrNumber=29, state=accepted)
- **ADR-030** (`ADR-030-operation-model-rationalization.md`)
  - Decision ID: `D028`
  - Inserted as D028 (adrNumber=30, state=accepted)
- **ADR-031** (`ADR-031-provider-adapter-architecture.md`)
  - Decision ID: `D029`
  - Inserted as D029 (adrNumber=31, state=accepted)
- **ADR-032** (`ADR-032-provider-agnostic-memory-bridge.md`)
  - Decision ID: `D030`
  - Inserted as D030 (adrNumber=32, state=accepted)
- **ADR-033** (`ADR-033-provider-adapter-architecture.md`)
  - Decision ID: `D031`
  - Inserted as D031 (adrNumber=33, state=superseded) — Duplicate of ADR-031 — marked superseded
  - Supersession: supersededBy ADR-031
- **ADR-034** (`ADR-034-provider-agnostic-memory-bridge.md`)
  - Decision ID: `D032`
  - Inserted as D032 (adrNumber=34, state=superseded) — Duplicate of ADR-032 — marked superseded
  - Supersession: supersededBy ADR-032
- **ADR-035** (`ADR-035-pi-v2-v3-harness.md`)
  - Decision ID: `D033`
  - Inserted as D033 (adrNumber=35, state=accepted)
- **ADR-036** (`ADR-036-cleoos-database-topology.md`)
  - Decision ID: `D034`
  - Inserted as D034 (adrNumber=36, state=accepted)
- **ADR-037** (`ADR-037-conduit-signaldock-separation.md`)
  - Decision ID: `D035`
  - Inserted as D035 (adrNumber=37, state=accepted)
- **ADR-038** (`ADR-038-backup-portability.md`)
  - Decision ID: `D036`
  - Inserted as D036 (adrNumber=38, state=accepted)
- **ADR-039** (`ADR-039-lafs-envelope-unification.md`)
  - Decision ID: `D037`
  - Inserted as D037 (adrNumber=39, state=accepted)
- **ADR-041** (`ADR-041-worktree-handle-spawn-contract.md`)
  - Decision ID: `D038`
  - Inserted as D038 (adrNumber=41, state=accepted)
- **ADR-042** (`ADR-042-cli-system-integrity-conduit-alignment.md`)
  - Decision ID: `D039`
  - Inserted as D039 (adrNumber=42, state=superseded)
- **ADR-043** (`ADR-043-native-citty-command-migration.md`)
  - Decision ID: `D040`
  - Inserted as D040 (adrNumber=43, state=proposed)
- **ADR-044** (`ADR-044-canon-reconciliation.md`)
  - Decision ID: `D041`
  - Inserted as D041 (adrNumber=44, state=proposed)
- **ADR-045** (`ADR-045-cleo-scaffolding-ssot.md`)
  - Decision ID: `D042`
  - Inserted as D042 (adrNumber=45, state=proposed)
- **ADR-046** (`ADR-046-stdp-phase-5-implementation.md`)
  - Decision ID: `D043`
  - Inserted as D043 (adrNumber=46, state=accepted)
- **ADR-047** (`ADR-047-autonomous-gc-and-disk-safety.md`)
  - Decision ID: `D044`
  - Inserted as D044 (adrNumber=47, state=accepted)
- **ADR-048** (`ADR-048-memory-extraction-pipeline.md`)
  - Decision ID: `D045`
  - Inserted as D045 (adrNumber=48, state=accepted)
- **ADR-049** (`ADR-049-harness-sovereignty.md`)
  - Decision ID: `D046`
  - Inserted as D046 (adrNumber=49, state=proposed)
- **ADR-050** (`ADR-050-cleoos-sovereign-harness.md`)
  - Decision ID: `D047`
  - Inserted as D047 (adrNumber=50, state=proposed)
- **ADR-051** (`ADR-051-programmatic-gate-integrity.md`)
  - Decision ID: `D048`
  - Inserted as D048 (adrNumber=51, state=accepted)
- **ADR-052** (`ADR-052-caamp-keeps-commander.md`)
  - Decision ID: `D049`
  - Inserted as D049 (adrNumber=52, state=accepted)
- **ADR-053** (`ADR-053-project-agnostic-release-pipeline.md`)
  - Decision ID: `D050`
  - Inserted as D050 (adrNumber=53, state=accepted)
- **ADR-054** (`ADR-054-manifest-unification.md`)
  - Decision ID: `D051`
  - Inserted as D051 (adrNumber=54, state=accepted)
- **ADR-055** (`ADR-055-agents-architecture-and-meta-agents.md`)
  - Decision ID: `D052`
  - Inserted as D052 (adrNumber=55, state=accepted)
- **ADR-056** (`ADR-056-db-ssot-and-release-completion-invariant.md`)
  - Decision ID: `D053`
  - Inserted as D053 (adrNumber=56, state=accepted)
- **ADR-057** (`ADR-057-contracts-core-ssot.md`)
  - Decision ID: `D054`
  - Inserted as D054 (adrNumber=57, state=accepted)
- **ADR-058** (`ADR-058-dispatch-type-inference.md`)
  - Decision ID: `D055`
  - Inserted as D055 (adrNumber=58, state=accepted)
- **ADR-059** (`ADR-059-override-pumps.md`)
  - Decision ID: `D056`
  - Inserted as D056 (adrNumber=59, state=accepted)
- **ADR-061** (`ADR-061-project-agnostic-verify-tools.md`)
  - Decision ID: `D057`
  - Inserted as D057 (adrNumber=61, state=accepted)
- **ADR-062** (`ADR-062-worktree-merge-not-cherry-pick.md`)
  - Decision ID: `D058`
  - Inserted as D058 (adrNumber=62, state=accepted)
- **ADR-063** (`ADR-063-release-pipeline.md`)
  - Decision ID: `D059`
  - Inserted as D059 (adrNumber=63, state=accepted)
- **ADR-067** (`ADR-067-project-root-resolution.md`)
  - Decision ID: `D060`
  - Inserted as D060 (adrNumber=67, state=accepted)

---

## Skipped — ADR Number Collisions (HITL Required)

These ADR numbers exist in BOTH `.cleo/adrs/` and `docs/adr/` with **different content**.
The `.cleo/adrs/` version is canonical. Owner must decide how to renumber the `docs/adr/` versions.

### ADR-051

- **File skipped**: `/home/keatonhoskins/.local/share/cleo/worktrees/4f2a513f66dcb422/T1829/docs/adr/ADR-051-override-patterns.md`
- **Reason**: ADR-051 collision: docs/adr/ version skipped. .cleo/adrs/ is canonical. HITL needed before merging.

### ADR-052

- **File skipped**: `/home/keatonhoskins/.local/share/cleo/worktrees/4f2a513f66dcb422/T1829/docs/adr/ADR-052-sdk-consolidation.md`
- **Reason**: ADR-052 collision: docs/adr/ version skipped. .cleo/adrs/ is canonical. HITL needed before merging.

### ADR-053

- **File skipped**: `/home/keatonhoskins/.local/share/cleo/worktrees/4f2a513f66dcb422/T1829/docs/adr/ADR-053-playbook-runtime.md`
- **Reason**: ADR-053 collision: docs/adr/ version skipped. .cleo/adrs/ is canonical. HITL needed before merging.

### ADR-054

- **File skipped**: `/home/keatonhoskins/.local/share/cleo/worktrees/4f2a513f66dcb422/T1829/docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md`
- **Reason**: ADR-054 collision: docs/adr/ version skipped. .cleo/adrs/ is canonical. HITL needed before merging.

**Action required**: File HITL request to owner for renumbering decision.

---

## Duplicate-Pair Supersession

The following ADRs were identified as exact duplicates within `.cleo/adrs/` and were
inserted with `confirmationState=superseded` and a `supersededBy` link to the canonical ADR.

- **ADR-033** → supersededBy ADR-031 (`ADR-033-provider-adapter-architecture.md`)
- **ADR-034** → supersededBy ADR-032 (`ADR-034-provider-agnostic-memory-bridge.md`)

---

## Collision Details

### ADR-051..054 Collision Pairs

| ADR Number | `.cleo/adrs/` file (canonical) | `docs/adr/` file (skipped) |
|------------|-------------------------------|----------------------------|
| ADR-051 | `ADR-051-programmatic-gate-integrity.md` | `ADR-051-override-patterns.md` |
| ADR-052 | `ADR-052-caamp-keeps-commander.md` | `ADR-052-sdk-consolidation.md` |
| ADR-053 | `ADR-053-project-agnostic-release-pipeline.md` | `ADR-053-playbook-runtime.md` |
| ADR-054 | `ADR-054-manifest-unification.md` | `ADR-054-migration-system-hybrid-path-a-plus.md` |

Owner must decide renumbering: e.g. `docs/adr/ADR-052-sdk-consolidation.md` → ADR-065.

---

*Generated by `packages/core/src/tools/adr-backfill-walker.ts` (T1829)*