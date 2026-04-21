# T1096 — Research: Manifest Unification Specification

**Date**: 2026-04-21
**Task**: T1096
**Epic**: T1093 — MANIFEST/RCASD Architecture Unification
**Stage**: research
**Agent**: cleo-db-lead

---

## Key Findings

- ADR-027 retired `MANIFEST.jsonl` in favour of `pipeline_manifest` (SQLite, tasks.db) but left a §6.2 execution gap: no `cleo manifest` CLI, no RCASD ingestion, and compiled agent prompts still instruct `echo >> MANIFEST.jsonl`
- The inventory (T1094) documents 319 MANIFEST.jsonl lines, 182 rcasd markdown files across 36 task dirs, 390 loose agent-output markdown files, and only 1 pipeline_manifest row
- The drift map (T1095) identifies 8 P0 lines and ~45 P1 lines across 20+ files that continue to reference the retired MANIFEST.jsonl path or the non-existent `cleo manifest show` command
- `cleo manifest` as a top-level command does not exist; `cleo research manifest` queries MANIFEST.jsonl directly — it is the sole CLI alias and must be deprecated in favour of the new `cleo manifest *` surface
- The `pipeline_manifest` schema (ADR-027 §2.3) already has all columns needed to absorb rcasd/ and loose files; only ingestion logic and the CLI surface are missing
- `content_hash` SHA-256 deduplication is already specified in ADR-027 §8 / CLEO-MANIFEST-SCHEMA-SPEC.md §8 and MUST be used for all three ingestion paths
- The `cleo-subagent.cant` source already uses correct `pipeline.manifest.append` references; the compiled `cleo-subagent.md` drift is introduced at compile time

## Sources

- `/mnt/projects/cleocode/.cleo/agent-outputs/T1094-inventory.md` — inventory data
- `/mnt/projects/cleocode/.cleo/agent-outputs/T1095-drift-map.md` — drift analysis
- `/mnt/projects/cleocode/.cleo/adrs/ADR-027-manifest-sqlite-migration.md` — normative decision
- `/mnt/projects/cleocode/docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md` — schema and 14 ops
- `/mnt/projects/cleocode/docs/specs/CLEO-OPERATION-CONSTITUTION.md` — pipeline domain table
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/research.ts` — deprecation target
- `/mnt/projects/cleocode/packages/contracts/src/operations/research.ts` — operations contract

## Needs Follow-up

- T1097: `cleo manifest` CLI registration + `cleo research manifest` deprecation warning
- T1098: RCASD ingestion function implementation
- T1099: Loose md + JSONL migration + agent prompt drift fixes
- ADR-054 formal ratification (outlined in spec §8)
- `cleo complete <task>` gate `manifestAppended` enforcement (mentioned in ADR-054 §8.2 item 5 — may require separate task)
