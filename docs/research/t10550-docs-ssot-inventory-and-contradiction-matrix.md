---
task: T10550
parent: T10539
saga: T10538 (SG-PM-CORE-V2)
type: research
status: complete
evidence: docs/research/t10550-docs-ssot-inventory-evidence.json
---

# T10550 Docs SSoT Inventory and Contradiction Matrix

## Scope and method

This is the W0 research/spec inventory for SG-PM-CORE-V2. It uses ADR-088 (`docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`) as the target doctrine and enumerates current ADR/spec/help/skill/walkthrough references to saga, group/groups, acceptance criteria/AC, and PM-Core V2 terms.

Machine-readable line-level evidence is in `docs/research/t10550-docs-ssot-inventory-evidence.json`. The evidence file lists every matched file, every matched line number, the matched term family, and the line text used for this matrix.

Coverage summary:

- scanned zones: `docs/adr`, `docs/spec`, `docs/specs`, `docs/guides`, `docs/skills`, `docs/generated/SKILL-monorepo`, `.cleo/adrs`, `.cleo/specs`, `.claude/skills`, `packages/skills/skills`, `packages/caamp/docs/generated/SKILL-caamp`, `packages/core/src/admin`, `packages/cleo/src/cli`
- files with references: 285
- line-level references: 1594
- file counts by family: saga=129, group=143, acceptanceCriteria=96, pmCoreV2=1

## Canonical doctrine owners

| Doctrine | Canonical owner for SG-PM-CORE-V2 | Current owner/status | Rule for downstream docs |
|---|---|---|---|
| Saga storage identity | ADR-088 / PM-Core V2 target | ADR-073 and ADR-083 describe legacy/current migration state | Target is `tasks.type = 'saga'`; legacy `type='epic' AND label='saga'` text must be marked transitional or superseded. |
| Containment edge | ADR-088 / PM-Core V2 target | ADR-073 legacy charter reserves `groups` for saga membership and excludes saga from parent depth | Target is `tasks.parent_id` for containment only, including saga/epic/task/subtask hierarchy; relation-based membership cannot drive rollups or completion. |
| Non-containment relations | ADR-088 / PM-Core V2 target | ADR-073 treats `task_relations.type='groups'` as the saga-to-epic link | `task_relations` is non-containment only: dependencies, ordering, cross-reference, evidence, supersession, duplicate, provenance. |
| Completion criteria | ADR-088 / PM-Core V2 target | ADR-066 and gate specs require acceptance text/evidence but do not define typed child criteria | Target is `task_acceptance_criteria.kind in ('text','child_task','evidence_bound')`; parent closure should bind direct child tasks with `child_task` criteria. |
| Docs SSoT routing | ADR-076 | Accepted docs-canon authority | Canonical docs continue through `cleo docs add/fetch/publish`; raw edits to legacy canonical homes are amendment work, not W0 inventory work. |
| CLI/API task authority | CLEO API authority + code contracts, amended by ADR-088 | `docs/specs/CLEO-TASKS-API-SPEC.md` currently omits saga and names older relation surfaces | Amend specs after PM-Core V2 contracts land; code contracts remain final executable authority when prose conflicts. |
| Agent/skill behavior | Skill package docs, amended to cite ADR-088 | ct-cleo/ct-orchestrator/ct-epic-architect still teach groups-based sagas in places | Skills should cite ADR-088 for PM-Core V2 target and ADR-073 only for historical/legacy migration notes. |

## Contradiction matrix

| ID | Surface(s) | Current/stale claim | ADR-088 target | Severity | Disposition plan |
|---|---|---|---|---|---|
| C1 | `.cleo/adrs/ADR-073-above-epic-naming.md`, injected protocol text, ct-cleo skills | Saga is currently encoded as `type='epic' AND label='saga'`, with `SG-` display prefix. | `type=saga` is canonical; label/display prefixes are noncanonical. | High | Amend ADR-073 with a prominent PM-Core V2 supersession note once migration task lands; update skills/protocol examples to say legacy only. |
| C2 | `.cleo/adrs/ADR-073-above-epic-naming.md`, saga CLI docs, skills | Sagas link member epics via `task_relations.type='groups'`; `cleo list --parent <saga>` returns empty. | `parent_id` is the containment edge; `task_relations` must not satisfy containment, child listing, rollup, or completion. | Critical | Supersede groups-as-membership doctrine for PM-Core V2; add migration note that groups may remain only as provenance/cross-reference. |
| C3 | `docs/specs/CLEO-TASKS-API-SPEC.md` | Task type list is `epic/task/subtask`; relation prose points to older dependencies/relation surfaces. | Saga/Epic/Task/Subtask are peer type discriminator values; secondary relations are explicit non-containment. | High | Amend task API spec after schema contract update; add ADR-088 authority pointer now in follow-up spec task. |
| C4 | `docs/generated/SKILL-monorepo/references/API-REFERENCE.md` and generated skill refs | Generated API references include stale operation/group text and must not be manually edited. | Generated docs should reflect PM-Core V2 after source contracts change. | Medium | Regenerate from contract/source after implementation; do not hand edit generated docs in T10550. |
| C5 | ct-epic-architect example walkthroughs and task creation examples | Acceptance criteria are free text attached to every task/epic, with examples focused on creation-time `--acceptance`. | Completion criteria are typed; parent criteria may bind direct child tasks deterministically. | Medium | Amend examples after `child_task` AC generator exists; keep `--acceptance` requirement but add typed criteria mapping. |
| C6 | Help renderer/admin help snapshots | Help surfaces categorize `saga` commands and grouped operations but do not encode PM-Core V2 semantics. | Help must not imply relation groups are hierarchy. | Low | Update help strings/snapshots only when CLI behavior changes; no current code edit required. |
| C7 | ADR/spec archive and old release/handoff docs | Historical docs mention saga/group/AC terms as records of shipped behavior. | ADR-088 governs target PM-Core V2 only, not historical claims. | Low | Do not delete historical docs; mark as archive or historical when touched. |

## Amendment/supersession/delete plan

1. Amend ADR-073 after the PM-Core V2 schema/contract migration: add `supersededBy: ADR-088 for PM-Core V2 target semantics` or an amendment block stating `groups` is legacy-only and `type=saga` + `parent_id` are target canonical semantics.
2. Amend `docs/specs/CLEO-TASKS-API-SPEC.md` to add `saga` to task types, replace dependency-only language with typed relation semantics, and cite ADR-088 as PM-Core V2 authority.
3. Amend protocol/skills docs (ct-cleo, ct-orchestrator, ct-epic-architect, ct-task-executor) to separate legacy CLEO task system guidance from PM-Core V2 target doctrine.
4. Regenerate generated API/skill docs after source contracts change; do not manually patch generated mirrors.
5. Preserve archive/release/handoff documents as historical artifacts; no deletion recommended from this inventory.
6. Delete only duplicated generated artifacts if a later docs-canon task proves they are stale mirrors with an authoritative replacement; T10550 found no safe delete target.

## Complete reference inventory by file

The table below lists every matched ADR/spec/help/skill/walkthrough file. The JSON evidence file lists every line reference within each file.

| File | Families | Line refs |
|---|---:|---:|
| `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` | group | 1 |
| `.cleo/adrs/ADR-006-canonical-sqlite-storage.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-007-domain-consolidation.md` | acceptanceCriteria, group | 3 |
| `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md` | saga | 5 |
| `.cleo/adrs/ADR-022-task-completion-hardening.md` | acceptanceCriteria | 5 |
| `.cleo/adrs/ADR-028-changelog-generation-model.md` | group, saga | 5 |
| `.cleo/adrs/ADR-035-pi-v2-v3-harness.md` | acceptanceCriteria, group | 3 |
| `.cleo/adrs/ADR-037-conduit-signaldock-separation.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-039-lafs-envelope-unification.md` | saga | 10 |
| `.cleo/adrs/ADR-043-native-citty-command-migration.md` | group | 8 |
| `.cleo/adrs/ADR-045-cleo-scaffolding-ssot.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-046-stdp-phase-5-implementation.md` | acceptanceCriteria, group | 3 |
| `.cleo/adrs/ADR-047-autonomous-gc-and-disk-safety.md` | acceptanceCriteria, group | 3 |
| `.cleo/adrs/ADR-048-memory-extraction-pipeline.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-049-harness-sovereignty.md` | acceptanceCriteria | 2 |
| `.cleo/adrs/ADR-051-worktree-extension.md` | acceptanceCriteria, saga | 4 |
| `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` | group | 1 |
| `.cleo/adrs/ADR-054-manifest-unification.md` | group | 1 |
| `.cleo/adrs/ADR-054-migration-system-hybrid-path-a-plus.md` | acceptanceCriteria | 2 |
| `.cleo/adrs/ADR-066-task-taxonomy-consolidation.md` | acceptanceCriteria | 15 |
| `.cleo/adrs/ADR-068-cleo-database-charter.md` | saga | 13 |
| `.cleo/adrs/ADR-070-three-tier-orchestration.md` | acceptanceCriteria, group, saga | 6 |
| `.cleo/adrs/ADR-070-verifier-backed-ac-auditor-loop.md` | acceptanceCriteria | 4 |
| `.cleo/adrs/ADR-071-cleo-observability-event-bus.md` | acceptanceCriteria | 1 |
| `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md` | acceptanceCriteria | 8 |
| `.cleo/adrs/ADR-073-above-epic-naming.md` | acceptanceCriteria, group, saga | 77 |
| `.cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md` | saga | 5 |
| `.cleo/adrs/ADR-075-skills-federation-trust-ladder.md` | saga | 1 |
| `.cleo/adrs/ADR-078-docs-provenance.md` | saga | 6 |
| `.cleo/adrs/ADR-079-docs-sdk-boundary-contract.md` | acceptanceCriteria, saga | 6 |
| `.cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md` | acceptanceCriteria, group, saga | 29 |
| `.cleo/adrs/ADR-084-cleoos-sentient-harness.md` | saga | 1 |
| `.cleo/adrs/ADR-085-cross-db-invariants.md` | acceptanceCriteria, group, saga | 15 |
| `.cleo/adrs/ADR-086-cli-output-contract-e9.md` | acceptanceCriteria, saga | 8 |
| `.cleo/specs/T1929-canonical-agent-system-spec.md` | acceptanceCriteria | 3 |
| `docs/adr/068-amendment-3-1-worktree-cli-routing.md` | saga | 1 |
| `docs/adr/ADR-076-canonical-docs-ssot.md` | saga | 9 |
| `docs/adr/ADR-077-worktreeinclude-canonical-location.md` | saga | 2 |
| `docs/adr/ADR-078-boundary-registry.md` | acceptanceCriteria, saga | 14 |
| `docs/adr/ADR-086-nested-nexus-disposition.md` | saga | 7 |
| `docs/adr/ADR-087-worktree-ffi-topology.md` | saga | 3 |
| `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md` | acceptanceCriteria, group, pmCoreV2, saga | 26 |
| `docs/generated/SKILL-monorepo/references/API-REFERENCE.md` | acceptanceCriteria, group | 89 |
| `docs/generated/SKILL-monorepo/references/CONFIGURATION.md` | acceptanceCriteria, group | 16 |
| `docs/guides/CANT-REFERENCE.md` | group | 1 |
| `docs/guides/SUBAGENT-INJECTION-PIPELINE.md` | acceptanceCriteria | 1 |
| `docs/guides/task-system-hardening.md` | acceptanceCriteria | 18 |
| `docs/guides/TOKEN-REPLACEMENT-CONTRACT.md` | acceptanceCriteria | 2 |
| `docs/skills/loom-coverage-matrix.md` | saga | 1 |
| `docs/spec/worktree-lifecycle.md` | group, saga | 8 |
| `docs/specs/CANT-DSL-SPEC.md` | group | 1 |
| `docs/specs/CANT-EXECUTION-SEMANTICS.md` | group | 1 |
| `docs/specs/CLEO-DATA-INTEGRITY-SPEC.md` | acceptanceCriteria | 15 |
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | acceptanceCriteria | 2 |
| `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` | acceptanceCriteria, group | 6 |
| `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` | group | 1 |
| `docs/specs/cleo-scaffolding-ssot-spec.md` | acceptanceCriteria | 1 |
| `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` | acceptanceCriteria, group | 2 |
| `docs/specs/CLEO-TASKS-API-SPEC.md` | acceptanceCriteria | 1 |
| `docs/specs/CORE-PACKAGE-SPEC.md` | acceptanceCriteria | 3 |
| `docs/specs/memory-architecture-spec.md` | acceptanceCriteria | 1 |
| `docs/specs/stdp-wire-up-spec.md` | acceptanceCriteria, group | 8 |
| `docs/specs/T1096-manifest-unification-spec.md` | acceptanceCriteria, group | 3 |
| `docs/specs/T832-gate-integrity-spec.md` | acceptanceCriteria | 1 |
| `packages/caamp/docs/generated/SKILL-caamp/references/API-REFERENCE.md` | group | 34 |
| `packages/cleo/src/cli/__tests__/add-batch.test.ts` | acceptanceCriteria | 8 |
| `packages/cleo/src/cli/__tests__/check-canon-docs.test.ts` | group, saga | 2 |
| `packages/cleo/src/cli/__tests__/docs-error-envelopes.test.ts` | saga | 1 |
| `packages/cleo/src/cli/__tests__/docs-idempotency.test.ts` | acceptanceCriteria, saga | 8 |
| `packages/cleo/src/cli/__tests__/docs-import.test.ts` | saga | 1 |
| `packages/cleo/src/cli/__tests__/docs-publish-envelope.test.ts` | saga | 3 |
| `packages/cleo/src/cli/__tests__/docs-publish-pr.test.ts` | saga | 1 |
| `packages/cleo/src/cli/__tests__/docs-roundtrip-pr-merge.test.ts` | acceptanceCriteria, saga | 11 |
| `packages/cleo/src/cli/__tests__/docs-roundtrip.test.ts` | acceptanceCriteria, saga | 3 |
| `packages/cleo/src/cli/__tests__/focus.test.ts` | group, saga | 9 |
| `packages/cleo/src/cli/__tests__/help-renderer.test.ts` | group, saga | 32 |
| `packages/cleo/src/cli/__tests__/release-help.test.ts` | group, saga | 5 |
| `packages/cleo/src/cli/__tests__/saga-registry.test.ts` | acceptanceCriteria, saga | 65 |
| `packages/cleo/src/cli/__tests__/saga-T9787-multi-agent-race.test.ts` | saga | 3 |
| `packages/cleo/src/cli/__tests__/startup-migration.test.ts` | acceptanceCriteria, group, saga | 5 |
| `packages/cleo/src/cli/commands/__tests__/__snapshots__/schema.test.ts.snap` | acceptanceCriteria | 7 |
| `packages/cleo/src/cli/commands/__tests__/add-critical-depends.test.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/__tests__/add-help-crosslink.test.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/__tests__/add-update-severity-pipeline-validation.test.ts` | acceptanceCriteria, saga | 2 |
| `packages/cleo/src/cli/commands/__tests__/agent-remove-global.test.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/__tests__/auth-migrate.test.ts` | group | 1 |
| `packages/cleo/src/cli/commands/__tests__/backup-recover.test.ts` | group, saga | 5 |
| `packages/cleo/src/cli/commands/__tests__/backup-verify.test.ts` | saga | 2 |
| `packages/cleo/src/cli/commands/__tests__/conduit.test.ts` | group | 2 |
| `packages/cleo/src/cli/commands/__tests__/docs-add-similarity.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/docs-add-strict-args.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/docs-add-strict-body.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/docs-find-similar.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/docs-supersede.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/docs-update.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/doctor-db-substrate.test.ts` | acceptanceCriteria, saga | 8 |
| `packages/cleo/src/cli/commands/__tests__/doctor-legacy-backups.test.ts` | saga | 3 |
| `packages/cleo/src/cli/commands/__tests__/doctor-migrate-worktree-include.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/e3-integration.test.ts` | acceptanceCriteria | 4 |
| `packages/cleo/src/cli/commands/__tests__/field-flag.test.ts` | saga | 2 |
| `packages/cleo/src/cli/commands/__tests__/graph.test.ts` | group | 1 |
| `packages/cleo/src/cli/commands/__tests__/init-workflows-deprecation.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/memory-cli-new.test.ts` | group | 2 |
| `packages/cleo/src/cli/commands/__tests__/memory-clioutput.test.ts` | group | 3 |
| `packages/cleo/src/cli/commands/__tests__/nexus-cli-new.test.ts` | group | 3 |
| `packages/cleo/src/cli/commands/__tests__/nexus-group-alias.test.ts` | group | 12 |
| `packages/cleo/src/cli/commands/__tests__/output-mode.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/schema.test.ts` | acceptanceCriteria | 4 |
| `packages/cleo/src/cli/commands/__tests__/sentient-execute-action.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/setup-command.test.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/__tests__/summary-flag.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/__tests__/tasks-input-contract.test.ts` | acceptanceCriteria, saga | 3 |
| `packages/cleo/src/cli/commands/__tests__/worktree-docs-add.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/adapter.ts` | group | 3 |
| `packages/cleo/src/cli/commands/add-batch.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/add.ts` | acceptanceCriteria, group | 8 |
| `packages/cleo/src/cli/commands/admin.ts` | group | 2 |
| `packages/cleo/src/cli/commands/adr.ts` | group | 2 |
| `packages/cleo/src/cli/commands/agent-outputs.ts` | group | 1 |
| `packages/cleo/src/cli/commands/agent.ts` | acceptanceCriteria, group | 6 |
| `packages/cleo/src/cli/commands/audit.ts` | group | 2 |
| `packages/cleo/src/cli/commands/auth.ts` | group | 1 |
| `packages/cleo/src/cli/commands/auth/index.ts` | group | 1 |
| `packages/cleo/src/cli/commands/backfill.ts` | acceptanceCriteria | 2 |
| `packages/cleo/src/cli/commands/backup-recover.ts` | group, saga | 4 |
| `packages/cleo/src/cli/commands/backup-verify.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/backup.ts` | group | 1 |
| `packages/cleo/src/cli/commands/brain.ts` | group | 3 |
| `packages/cleo/src/cli/commands/caamp.ts` | group | 2 |
| `packages/cleo/src/cli/commands/cant.ts` | group | 2 |
| `packages/cleo/src/cli/commands/chain.ts` | group | 3 |
| `packages/cleo/src/cli/commands/changeset.ts` | group, saga | 4 |
| `packages/cleo/src/cli/commands/check.ts` | group, saga | 9 |
| `packages/cleo/src/cli/commands/complete.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/complexity.ts` | group | 1 |
| `packages/cleo/src/cli/commands/compliance.ts` | group | 2 |
| `packages/cleo/src/cli/commands/conduit.ts` | group | 3 |
| `packages/cleo/src/cli/commands/config.ts` | group, saga | 3 |
| `packages/cleo/src/cli/commands/config/__tests__/config-integration.test.ts` | saga | 2 |
| `packages/cleo/src/cli/commands/config/__tests__/config.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/config/drift-check.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/config/get.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/config/index.ts` | group, saga | 2 |
| `packages/cleo/src/cli/commands/config/set.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/config/show.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/config/validate.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/consensus.ts` | group | 2 |
| `packages/cleo/src/cli/commands/context.ts` | group | 2 |
| `packages/cleo/src/cli/commands/contribution.ts` | group | 2 |
| `packages/cleo/src/cli/commands/curator.ts` | group, saga | 4 |
| `packages/cleo/src/cli/commands/daemon.ts` | group | 3 |
| `packages/cleo/src/cli/commands/decomposition.ts` | group | 1 |
| `packages/cleo/src/cli/commands/deps.ts` | group, saga | 10 |
| `packages/cleo/src/cli/commands/diagnostics.ts` | group | 2 |
| `packages/cleo/src/cli/commands/docs.ts` | acceptanceCriteria, group, saga | 10 |
| `packages/cleo/src/cli/commands/docs/__tests__/graph.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/docs/graph.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/doctor-db-substrate.ts` | saga | 2 |
| `packages/cleo/src/cli/commands/doctor-legacy-backups.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/doctor-release-readiness.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/doctor.ts` | group, saga | 26 |
| `packages/cleo/src/cli/commands/event.ts` | group | 1 |
| `packages/cleo/src/cli/commands/federation.ts` | group, saga | 2 |
| `packages/cleo/src/cli/commands/find.ts` | group, saga | 4 |
| `packages/cleo/src/cli/commands/focus.ts` | saga | 4 |
| `packages/cleo/src/cli/commands/gc.ts` | group | 1 |
| `packages/cleo/src/cli/commands/graph.ts` | group | 1 |
| `packages/cleo/src/cli/commands/history.ts` | group | 1 |
| `packages/cleo/src/cli/commands/hygiene.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/init.ts` | saga | 3 |
| `packages/cleo/src/cli/commands/intelligence.ts` | group | 1 |
| `packages/cleo/src/cli/commands/issue.ts` | group | 2 |
| `packages/cleo/src/cli/commands/labels.ts` | group | 2 |
| `packages/cleo/src/cli/commands/lifecycle.ts` | group | 2 |
| `packages/cleo/src/cli/commands/llm.ts` | group | 1 |
| `packages/cleo/src/cli/commands/manifest.ts` | group | 2 |
| `packages/cleo/src/cli/commands/memory.ts` | group | 6 |
| `packages/cleo/src/cli/commands/migrate-claude-mem.ts` | group | 1 |
| `packages/cleo/src/cli/commands/nexus.ts` | group | 8 |
| `packages/cleo/src/cli/commands/orchestrate.ts` | group, saga | 8 |
| `packages/cleo/src/cli/commands/otel.ts` | group | 3 |
| `packages/cleo/src/cli/commands/phase.ts` | group | 3 |
| `packages/cleo/src/cli/commands/playbook.ts` | group | 2 |
| `packages/cleo/src/cli/commands/provenance.ts` | group | 3 |
| `packages/cleo/src/cli/commands/provider.ts` | group | 2 |
| `packages/cleo/src/cli/commands/reason.ts` | group | 2 |
| `packages/cleo/src/cli/commands/reconcile.ts` | group | 2 |
| `packages/cleo/src/cli/commands/relates.ts` | group | 2 |
| `packages/cleo/src/cli/commands/release.ts` | group, saga | 9 |
| `packages/cleo/src/cli/commands/release/ship-e2e-smoke.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/remote.ts` | group | 1 |
| `packages/cleo/src/cli/commands/reorder.ts` | group | 3 |
| `packages/cleo/src/cli/commands/req.ts` | acceptanceCriteria, group | 8 |
| `packages/cleo/src/cli/commands/research.ts` | group | 2 |
| `packages/cleo/src/cli/commands/restore.ts` | group | 2 |
| `packages/cleo/src/cli/commands/saga.ts` | acceptanceCriteria, group, saga | 68 |
| `packages/cleo/src/cli/commands/schema.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/sentient.ts` | group | 3 |
| `packages/cleo/src/cli/commands/sequence.ts` | group | 1 |
| `packages/cleo/src/cli/commands/session.ts` | group | 2 |
| `packages/cleo/src/cli/commands/show.ts` | acceptanceCriteria | 2 |
| `packages/cleo/src/cli/commands/skill.ts` | group, saga | 6 |
| `packages/cleo/src/cli/commands/skills.ts` | group | 2 |
| `packages/cleo/src/cli/commands/snapshot.ts` | group | 1 |
| `packages/cleo/src/cli/commands/sticky.ts` | group | 2 |
| `packages/cleo/src/cli/commands/sync.ts` | group | 2 |
| `packages/cleo/src/cli/commands/tasks.ts` | group | 1 |
| `packages/cleo/src/cli/commands/tasks/README.md` | group | 1 |
| `packages/cleo/src/cli/commands/telemetry.ts` | group, saga | 4 |
| `packages/cleo/src/cli/commands/templates.ts` | group, saga | 3 |
| `packages/cleo/src/cli/commands/templates/__tests__/templates-integration.test.ts` | saga | 2 |
| `packages/cleo/src/cli/commands/templates/__tests__/templates.test.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/diff.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/index.ts` | group, saga | 2 |
| `packages/cleo/src/cli/commands/templates/install.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/lib.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/list.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/show.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/upgrade.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/templates/validate.ts` | saga | 1 |
| `packages/cleo/src/cli/commands/testing.ts` | group | 2 |
| `packages/cleo/src/cli/commands/token.ts` | group | 2 |
| `packages/cleo/src/cli/commands/transcript.ts` | group | 2 |
| `packages/cleo/src/cli/commands/update.ts` | acceptanceCriteria, group | 8 |
| `packages/cleo/src/cli/commands/verify.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/commands/web.ts` | group | 1 |
| `packages/cleo/src/cli/commands/worktree.ts` | acceptanceCriteria, group, saga | 8 |
| `packages/cleo/src/cli/generated/command-manifest.ts` | acceptanceCriteria, group, saga | 8 |
| `packages/cleo/src/cli/help-renderer.ts` | group | 8 |
| `packages/cleo/src/cli/index.ts` | group | 1 |
| `packages/cleo/src/cli/lib/__tests__/collect-input.test.ts` | saga | 1 |
| `packages/cleo/src/cli/lib/__tests__/subcommand-guard.test.ts` | group | 1 |
| `packages/cleo/src/cli/lib/collect-input.ts` | saga | 1 |
| `packages/cleo/src/cli/lib/define-cli-command.ts` | saga | 4 |
| `packages/cleo/src/cli/lib/strict-args.ts` | saga | 1 |
| `packages/cleo/src/cli/lib/subcommand-guard.ts` | group | 2 |
| `packages/cleo/src/cli/projection-context.ts` | saga | 1 |
| `packages/cleo/src/cli/quiet-stderr.ts` | saga | 1 |
| `packages/cleo/src/cli/renderers/__tests__/cli-output-response-meta.test.ts` | acceptanceCriteria | 1 |
| `packages/cleo/src/cli/renderers/__tests__/generic-tree.test.ts` | acceptanceCriteria, group, saga | 24 |
| `packages/cleo/src/cli/renderers/__tests__/sg-display-preservation.test.ts` | group, saga | 29 |
| `packages/cleo/src/cli/renderers/generic-tree.ts` | group, saga | 18 |
| `packages/cleo/src/cli/renderers/index.ts` | saga | 3 |
| `packages/cleo/src/cli/renderers/output-mode.ts` | saga | 1 |
| `packages/cleo/src/cli/resolve-subcommand.ts` | group | 2 |
| `packages/core/src/admin/__tests__/__snapshots__/help-tier-snapshot.test.ts.snap` | group, saga | 41 |
| `packages/core/src/admin/__tests__/help-tier-snapshot.test.ts` | acceptanceCriteria, saga | 2 |
| `packages/core/src/admin/__tests__/help.test.ts` | group | 1 |
| `packages/core/src/admin/help.ts` | group | 1 |
| `packages/skills/skills/ct-adr-recorder/__tests__/skill-adr-recorder.test.ts` | saga | 2 |
| `packages/skills/skills/ct-adr-recorder/references/cascade.md` | group | 1 |
| `packages/skills/skills/ct-artifact-publisher/references/artifact-types.md` | group | 1 |
| `packages/skills/skills/ct-cleo/SKILL.md` | acceptanceCriteria, group, saga | 20 |
| `packages/skills/skills/ct-contribution/SKILL.md` | acceptanceCriteria, group, saga | 4 |
| `packages/skills/skills/ct-docs-review/__tests__/skill-docs-review.test.ts` | saga | 2 |
| `packages/skills/skills/ct-docs-write/__tests__/skill-docs-write.test.ts` | saga | 2 |
| `packages/skills/skills/ct-docs-write/references/audience-targeting.md` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-docs-write/references/markdown-patterns.md` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-docs-write/SKILL.md` | saga | 1 |
| `packages/skills/skills/ct-documentor/references/anti-patterns.md` | group | 1 |
| `packages/skills/skills/ct-documentor/SKILL.md` | acceptanceCriteria, saga | 28 |
| `packages/skills/skills/ct-epic-architect/references/bug-epic-example.md` | acceptanceCriteria | 18 |
| `packages/skills/skills/ct-epic-architect/references/commands.md` | acceptanceCriteria | 2 |
| `packages/skills/skills/ct-epic-architect/references/feature-epic-example.md` | acceptanceCriteria | 24 |
| `packages/skills/skills/ct-epic-architect/references/migration-epic-example.md` | acceptanceCriteria | 29 |
| `packages/skills/skills/ct-epic-architect/references/output-format.md` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-epic-architect/references/patterns.md` | acceptanceCriteria | 13 |
| `packages/skills/skills/ct-epic-architect/references/refactor-epic-example.md` | acceptanceCriteria | 46 |
| `packages/skills/skills/ct-epic-architect/references/research-epic-example.md` | acceptanceCriteria | 10 |
| `packages/skills/skills/ct-epic-architect/SKILL.md` | acceptanceCriteria, group, saga | 19 |
| `packages/skills/skills/ct-ivt-looper/SKILL.md` | acceptanceCriteria | 2 |
| `packages/skills/skills/ct-orchestrator/orchestrator-prompt.txt` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-orchestrator/SKILL.md` | acceptanceCriteria, group, saga | 13 |
| `packages/skills/skills/ct-release-orchestrator/SKILL.md` | saga | 1 |
| `packages/skills/skills/ct-skill-validator/references/validation-rules.md` | group | 1 |
| `packages/skills/skills/ct-spec-writer/__tests__/skill-spec-writer.test.ts` | saga | 2 |
| `packages/skills/skills/ct-spec-writer/references/spec-templates.md` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-spec-writer/references/traceability-matrix.md` | acceptanceCriteria | 2 |
| `packages/skills/skills/ct-spec-writer/SKILL.md` | group | 1 |
| `packages/skills/skills/ct-task-executor/references/acceptance-criteria-mapping.md` | acceptanceCriteria | 22 |
| `packages/skills/skills/ct-task-executor/references/common-failures.md` | acceptanceCriteria | 1 |
| `packages/skills/skills/ct-task-executor/references/implementation-patterns.md` | acceptanceCriteria | 4 |
| `packages/skills/skills/ct-task-executor/SKILL.md` | acceptanceCriteria | 13 |
| `packages/skills/skills/ct-validator/references/validation-modes.md` | group | 1 |
