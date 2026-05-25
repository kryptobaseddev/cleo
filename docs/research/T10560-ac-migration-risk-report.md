# T10560 Acceptance Criteria Migration Risk Report

Generated: 2026-05-25T19:36:38Z

Scope: read-only audit of the active CLEO task database for acceptance criteria migration risks. The isolated worktree `.cleo/tasks.db` exists but is 0 bytes, so the audit source was the active project DB opened with sqlite `mode=ro`; no DB writes were made by the audit.

## Summary
- parents with children and text ACs reported: passed (count=363)
- parents with children and no ACs reported: passed (count=20)
- evidence_ac_bindings references audited: passed (count=4; orphan AC refs=0; unmatched lifecycle evidence atoms=4)

## Metrics
- task_count: 3570
- parent_count: 383
- structured_ac_count: 17919
- legacy_text_ac_tasks: 3372
- evidence_binding_count: 4
- evidence_orphan_ac_refs: 0
- evidence_atom_lifecycle_matches: 0
- evidence_atom_unmatched_lifecycle: 4

## Risk class 1: parents with children and legacy text ACs
These parent tasks still have non-empty `tasks.acceptance_json` while also owning children. They can be migration risks because parent-level textual ACs may need deterministic structured AC identity and should not be confused with child AC inheritance or rollup expectations.
Total reported: 363

| task | status | type | children | legacy text ACs | structured ACs | title |
|---|---|---|---:|---:|---:|---|
| T9261 | done | epic | 73 | 5 | 5 | T-LLM-CRED-CENTRALIZATION: Centralize CLEO LLM credentials registry + role-based routing + plugin provider system |
| T1042 | pending | epic | 43 | 6 | 6 | Cleo Nexus vs GitNexus: Far-Exceed Capability Analysis |
| T1150 | archived | epic | 37 | 13 | 13 | T-MSR: Migration System Remediation — end drizzle debt spiral across 5 DBs |
| T9118 | pending | epic | 30 | 9 | 9 | EPIC: CLEO surface audit + consolidation — providers/adapters/backends/agents/command-bloat |
| T9796 | done | epic | 23 | 7 | 7 | E-DOCS-CANON-LOCKDOWN: .cleo/canon.yml + cleo check canon docs CI gate — agents cannot write raw .md for canonical types |
| T1232 | pending | epic | 22 | 13 | 13 | PRE-WAVE: CLEO Agents Architecture Remediation for v2026.4.110 |
| T1586 | pending | epic | 22 | 11 | 11 | T-FOUNDATION-LOCKDOWN: project-agnostic anti-drift enforcement layer for CLEO harness |
| T1467 | pending | epic | 21 | 7 | 7 | T-THIN-WRAPPER complete CLI thin-wrapper migration |
| T1555 | pending | epic | 21 | 5 | 5 | EPIC: Audit-2026-04-28 follow-up remediation tasks |
| T1075 | archived | epic | 20 | 5 | 5 | T1075 PSYCHE Theory-of-Mind Layer (formerly Honcho Memory Integration) |
| T1855 | pending | epic | 20 | 10 | 10 | EPIC: CLEO opinionated guardrails — mandatory dependency enforcement, auto-suggest, dep-tree integrity validator, cross-epic dep linter |
| T1056 | archived | epic | 17 | 5 | 5 | Nexus P2: Living Brain Completion |
| T1566 | archived | epic | 17 | 8 | 8 | T-ENGINE-MIGRATION: Migrate 15,297 LOC of CLI engine logic to @cleocode/core (real T-THIN-WRAPPER) |
| T1929 | archived | epic | 16 | 11 | 11 | Agent System Canonicalization v2 — one canonical agent layout, end-to-end |
| T9098 | pending | epic | 16 | 8 | 8 | EPIC: Steal-from-graphify capability set + token-cheap LLM enrichment ladder — beat graphify on cost while matching/exceeding agent-token-reduction value |
| T1216 | archived | epic | 15 | 12 | 12 | Epic: Audit all false-completion suspects (12 full-NULL epics + 176 audit-column-gap tasks) |
| T1386 | archived | epic | 15 | 11 | 11 | PSYCHE LLM Layer Port — IMPLEMENTATION (port Honcho src/llm 3851 LOC; T1256 was retroactively closed, this is the actual port work) |
| T1892 | done | epic | 14 | 7 | 7 | BBTT — BRAIN/Briefing Trust & Truth: field contracts, dream-cycle revival, provenance, write-discipline |
| T9866 | done | epic | 14 | 4 | 4 | E-BUGS-DOCS-ARCH: Docs + architecture cleanup bugs |
| T10157 | done | epic | 13 | 15 | 15 | E12-DOCS-PROVENANCE-INTEGRITY: docs SSoT as a queryable + supersession-aware DB-backed graph — mirror brain_decisions pattern + eliminate adr-index.jsonl + surface llmtxt vector+graph in CLI |

## Risk class 2: parents with children and no ACs
These parent tasks own children but have neither legacy text ACs nor structured AC rows. They can be migration risks if parent/epic acceptance is expected for planning, rollup, or completion gates.
Total reported: 20

| task | status | type | children | legacy text ACs | structured ACs | title |
|---|---|---|---:|---:|---:|---|
| T001 | archived | None | 13 | 0 | 0 | Cancelled |
| T100 | archived | None | 4 | 0 | 0 | Task 100 |
| T003 | pending | None | 3 | 0 | 0 | Subtask |
| T1957 | archived | None | 3 | 0 | 0 | Auth API (imported-3) |
| T1961 | archived | None | 3 | 0 | 0 | Task (imported-3) |
| T1965 | archived | None | 3 | 0 | 0 | Task (imported-4) |
| T800 | archived | epic | 3 | 0 | 0 | Task T800 |
| T002 | archived | None | 2 | 0 | 0 | New done |
| T1337 | archived | epic | 2 | 0 | 0 | Epic: Auth (imported) |
| T1354 | archived | epic | 2 | 0 | 0 | Epic: Auth (imported-3) |
| T1364 | archived | None | 2 | 0 | 0 | Task (imported-2) |
| T1376 | archived | epic | 2 | 0 | 0 | Epic: Auth (imported-5) |
| T1969 | archived | None | 2 | 0 | 0 | Frontend auth (imported) |
| T201 | archived | None | 2 | 0 | 0 | Work task |
| T810 | archived | epic | 2 | 0 | 0 | Task T810 |
| T1332 | archived | None | 1 | 0 | 0 | Auth API (imported) |
| T1335 | archived | None | 1 | 0 | 0 | Task (imported) |
| T1361 | archived | None | 1 | 0 | 0 | Auth API (imported-2) |
| T1367 | archived | None | 1 | 0 | 0 | Test task (imported-2) |
| T603 | archived | epic | 1 | 0 | 0 | Epic |

## evidence_ac_bindings reference audit
The audit checked every `evidence_ac_bindings.ac_id` against `task_acceptance_criteria.id` and attempted to match `evidence_atom_id` against `lifecycle_evidence.id`.

- bindings audited: 4
- orphan AC references: 0
- lifecycle_evidence evidence_atom_id matches: 0
- unmatched lifecycle_evidence evidence_atom_id values: 4

| binding | ac_id | ac_task | ordinal | evidence_atom_id | binding_type | orphan_ac_ref | lifecycle_match |
|---|---|---|---:|---|---|---:|---|
| 676e8a33-907d-405e-a001-51bcfc88739b | 3401f81a-4931-4ee1-a5b7-7a9d23a3b1a8 | T10526 | 2 | pr:799 | direct | 0 | None |
| aba56dc7-8a41-454e-a4c7-6ac7a2fa5468 | 76a13b16-48ad-4bd8-8940-2727bcc05386 | T10526 | 3 | pr:799 | direct | 0 | None |
| c3e46df8-46c2-468e-9472-d61d0ede66d5 | dfe21168-926c-4dea-a3a3-4bf5e0b8ff50 | T10526 | 4 | pr:799 | direct | 0 | None |
| fbe6a0cc-d52e-4c93-b05a-4ebf8c2e003b | 62c0f341-067a-419d-bd8b-9d9294b35dac | T10526 | 1 | pr:799 | direct | 0 | None |

## Validation
Machine-readable evidence: `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T10560/.cleo/rcasd/T10560-ac-migration-risk-evidence.json`

Acceptance criteria status: passed. All three query classes executed and produced reportable counts; non-zero risk counts are findings, not validation failures.
