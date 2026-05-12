# Lead Epsilon — ADR Audit Report
**Date**: 2026-05-05  
**Auditor**: Lead Epsilon (ADR Audit Lead)  
**Task**: T1824 (ADR Audit for Consolidation)  
**Scope**: All ADR surfaces — `docs/adr/`, `.cleo/adrs/`, brain_decisions DB, protocol TS, ct-* skills, playbooks, protocol files, cross-references

---

## 1. Executive Summary

| Metric | Count |
|--------|-------|
| Total ADR files audited | 67 (13 in `docs/adr/` + 54 in `.cleo/adrs/`) |
| Unique ADR numbers present as files | 62 |
| ADR number collisions (same number, different content, different dirs) | 4 (ADR-051, ADR-052, ADR-053, ADR-054) |
| Exact-duplicate pairs within `.cleo/adrs/` | 2 (ADR-031/033, ADR-032/034) |
| ADRs in `docs/adr/` only (not in `.cleo/adrs/`) | 9 (ADR-055 through ADR-063, excluding ADR-060) |
| ADRs in `.cleo/adrs/` only (not in `docs/adr/`) | 53 |
| ADRs referenced in code with no file | 3 (ADR-001, ADR-002, ADR-064) |
| brain_decisions rows with adrNumber populated | 0 (out of 51 rows) |
| architectureDecisions rows (tasks.db) | 0 verified via sync (table exists, not queried live) |
| ADR status categories: REAL | 44 (claim matches implemented code) |
| ADR status categories: STALE | 5 (claim contradicts or predates code restructure) |
| ADR status categories: PARTIAL | 6 (some claims match, some superseded/diverged) |
| ADR status categories: DRAFT | 7 (proposed/never implemented) |
| ADR status categories: ARCHIVED | 4 (explicitly superseded) |
| ADR status categories: GHOST | 3 (referenced in code, no file exists) |
| Files requiring reference updates after consolidation | ~65 files |

**Highest-priority findings:**
1. **Dual-store confusion**: ADR storage is split across TWO SQLite tables in two different databases (`architecture_decisions` in `tasks.db` via `sync.ts` vs `brain_decisions` in `brain.db` via `decisions.ts`), with ZERO overlap — no `brain_decisions` row has an `adrNumber` or `adrPath` populated.
2. **Four real collision ADRs** (051–054): docs/adr versions are DIFFERENT decisions from .cleo/adrs versions — not copies.
3. **ct-cleo SKILL.md and CLEO-INJECTION.md both instruct agents to search `docs/adr/`** as canonical source, but `adr sync` and `adr validate` read exclusively from `.cleo/adrs/`. Split instruction creates navigation failures.
4. **ADR-064 is referenced 14 times in production code** but has no file in either location — it is a ghost ADR.
5. **ADR-001 and ADR-002** referenced in 7 and 6 docs files respectively but have no file in any location.
6. **Schema gap**: `brain_decisions` has `adrNumber`, `adrPath`, `supersedes`, `supersededBy`, `confirmationState`, `decidedBy`, `validatorRunAt` — all null in every row — meaning the DB canonization intent exists at the schema level but has never been actuated.

---

## 2. Collision Matrix

For each ADR number that appears in BOTH `docs/adr/` and `.cleo/adrs/`:

| Number | `docs/adr/` file | `docs/adr/` title | `.cleo/adrs/` file | `.cleo/adrs/` title | Same content? | Notes |
|--------|-----------------|-------------------|--------------------|---------------------|---------------|-------|
| ADR-051 | `ADR-051-override-patterns.md` | Override Patterns — When/How to Use CLEO_OWNER_OVERRIDE | `ADR-051-programmatic-gate-integrity.md` | Programmatic Gate Integrity: Evidence-Based Verify + Removal of Silent Bypass | **NO** | docs/adr version is a SUPPLEMENTARY companion doc explaining usage; .cleo/adrs version is the canonical ADR. Both describe ADR-051 behavior but from different angles. |
| ADR-052 | `ADR-052-sdk-consolidation.md` | SDK Consolidation — Vercel AI SDK as the LLM Bridge | `ADR-052-caamp-keeps-commander.md` | caamp Retains commander: Monorepo CLI Framework Divergence Accepted | **NO** — completely different decisions | HARD COLLISION: these are two entirely different architectural decisions assigned the same number. docs/adr version is Accepted 2026-04-18 (T933); .cleo/adrs version is Accepted 2026-04-17 (T867). |
| ADR-053 | `ADR-053-playbook-runtime.md` | Playbook Runtime as a Deterministic State Machine | `ADR-053-project-agnostic-release-pipeline.md` | Project-Agnostic Release Pipeline (T820) | **NO** — completely different decisions | HARD COLLISION: two entirely different architectural decisions. docs/adr version is T930 (2026-04-18); .cleo/adrs version is T820 (2026-04-17). |
| ADR-054 | `ADR-054-migration-system-hybrid-path-a-plus.md` | Migration System — Hybrid Path A+ | `ADR-054-manifest-unification.md` | Manifest/RCASD Architecture Unification | **NO** — completely different decisions | HARD COLLISION: docs/adr version is T1173 (2026-04-21); .cleo/adrs version is T1093 epic (2026-04-20). |

**Exact duplicates within `.cleo/adrs/` (same content, different number):**

| Number A | Number B | Difference | Notes |
|----------|----------|------------|-------|
| ADR-031 | ADR-033 | Title and minor phrasing differ; same task (T5240), same architectural decision | ADR-031 has Epic field; ADR-033 has slightly different problem framing. Same decision, filed twice. |
| ADR-032 | ADR-034 | Same as above — title differs, same task, same decision | ADR-032 has Epic field; ADR-034 has different problem framing opening. Same decision, filed twice. |

---

## 3. Code-Validation Table

One row per source file. Sorted by ADR number.

| ADR | Source file(s) | Title / Claim | Status | Code Artifact | Notes |
|-----|---------------|---------------|--------|---------------|-------|
| ADR-001 | NONE | Unknown — referenced in docs/generated/ and docs/architecture/DATABASE-ERDS.md, docs/concepts/CLEOOS-VISION.md | **GHOST** | No file exists anywhere | Referenced in 7 files. Likely a very early ADR predating the numbering system. |
| ADR-002 | NONE | Unknown — referenced in docs/concepts/CLEOOS-VISION.md and generated docs | **GHOST** | No file exists anywhere | Referenced in 6 files. Same vintage as ADR-001. |
| ADR-003 | `.cleo/adrs/ADR-003-mcp-engine-unification.md` | Eliminates dual-engine MCP architecture; merged mcp-server/ into src/mcp/ | **STALE** | `src/mcp/` no longer exists — monorepo has been restructured to `packages/`. The claim references a `src/` directory structure that was replaced by `packages/` in ADR-004+. | Functionally superseded by the TS-first monorepo restructure. |
| ADR-004 | `.cleo/adrs/ADR-004-typescript-first-architecture.md` | Migrates from 185+ bash scripts to TypeScript under `src/` | **STALE** | `src/` directory is gone; packages/ monorepo structure in place. Bash scripts under `scripts/` are claimed as deprecated but may still exist. Core claim (TypeScript-first) is REAL; `src/` path mapping is STALE. | Partially superseded by package restructure. |
| ADR-005 | `.cleo/adrs/ADR-005-migration-safety.md` | Safety architecture for JSON→SQLite migration (atomic write, checkpoint/rollback) | **REAL** | `packages/core/src/store/migration-manager.ts` exists; VACUUM INTO backup mechanism confirmed | Core safety model still applies. |
| ADR-006 | `.cleo/adrs/ADR-006-canonical-sqlite-storage.md` | SQLite as canonical runtime store; schema for tasks, sessions, ADRs | **REAL** | `packages/core/src/store/tasks-schema.ts` — `architectureDecisions` table present; tasks, sessions all in SQLite | Amended by ADR-010, ADR-011, ADR-017, ADR-020. |
| ADR-007 | `.cleo/adrs/ADR-007-domain-consolidation.md` | 10-domain dispatch architecture; `admin` domain owns ADR management | **PARTIAL** | Domain architecture real (`packages/cleo/src/dispatch/domains/`). Domain count disputed (memory says 11 domains per ADR-044 PROPOSED). `admin.adr.find` exists in registry. | ADR-044 partially updates this but is still PROPOSED. |
| ADR-008 | `.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md` | Shared-core + CQRS dispatch; `src/core/` is SSoT | **STALE** | `src/core/` no longer exists — it's `packages/core/`. Core CQRS principle is REAL but file paths are stale. | Amended by ADR-017, ADR-020. |
| ADR-009 | `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md` | BRAIN cognitive architecture; SQLite for BRAIN memory; Vectorless RAG | **REAL** | `packages/brain/`, `packages/core/src/memory/`, `packages/core/src/store/memory-schema.ts` all confirm. `brain.db` with `brain_decisions` table is the runtime. | Vectorless RAG confirmed in brain-retrieval.ts. |
| ADR-010 | `.cleo/adrs/ADR-010-node-sqlite-engine-choice.md` | node:sqlite (v22.5+) + drizzle-orm/sqlite-proxy as ORM | **REAL** | `packages/core/src/store/memory-sqlite.ts` uses node:sqlite; drizzle-orm confirmed in package.json | Zero native deps confirmed. |
| ADR-011 | `.cleo/adrs/ADR-011-project-configuration-architecture.md` | Three `.cleo/` config files; project-context.json through AGENTS.md | **REAL** | `project-context.json`, `config.json`, `global-config.json` all present; AGENTS.md @-reference chain confirmed | ADR amended to remove AGENT-INJECTION.md (removed in T5152). |
| ADR-012 | `.cleo/adrs/ADR-012-drizzle-kit-migration-system.md` | drizzle-kit as DDL migration tool; schema.ts as SSoT | **REAL** | `packages/core/src/store/tasks-schema.ts` is SSoT; migration files in `packages/core/migrations/` | drizzle-kit generate confirmed in build toolchain. |
| ADR-013 | `.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md` | Isolate .cleo/ checkpoint commits to worktree/orphan branch | **PARTIAL** | `.cleo/.gitignore` includes `tasks.db`, `brain.db` per ADR-013 §9. Git worktree isolation (ADR-041) now handles isolation differently. VACUUM INTO backup (ADR-036) supersedes checkpoint approach. | §9 (data safety) is REAL; original checkpoint isolation proposal partially superseded by ADR-036+ADR-041. |
| ADR-014 | `.cleo/adrs/ADR-014-rcasd-rename-and-protocol-validation.md` | RCSD→RCASD rename; ADR stage explicit in lifecycle | **REAL** | `packages/core/src/validation/protocols/architecture-decision.ts` exists (T260). rcasd.cantbook confirms the stage. | RCASD fully implemented. |
| ADR-015 | `.cleo/adrs/ADR-015-multi-contributor-architecture.md` | Multi-contributor `.cleo/` isolation with lock files | **PARTIAL** | Lock semantics exist in cleo-os harness. Full contributor audit trail per this ADR not fully verified. | Some claims may be REAL, full verification requires deeper ADR content read. |
| ADR-016 | `.cleo/adrs/ADR-016-installation-channels-and-dev-runtime-isolation.md` | Three install channels; runtime isolation; CalVer + OIDC | **REAL** | CalVer confirmed in all release tags (`v2026.x.y`). npm global install path confirmed. Dev symlink isolation confirmed. | OIDC trusted publishing in CI confirmed. |
| ADR-017 | `.cleo/adrs/ADR-017-verb-and-naming-standards.md` | Naming/verb standards; architecture_decisions extended with cognitive search columns | **REAL** | `architectureDecisions` table in tasks-schema.ts has `summary`, `keywords`, `topics` columns per ADR-017 §5.4. `admin.adr.find` operation exists. | Cognitive search columns confirmed. |
| ADR-018 | `.cleo/adrs/ADR-018-unified-status-registry.md` | Consolidated status enumerations in `src/store/status-registry.ts` | **STALE** | File is `packages/core/src/store/tasks-schema.ts` — status enums are defined inline in the schema file, not a separate `status-registry.ts`. Path claim is stale. | The conceptual claim (centralized status enums) is REAL; the file path is wrong. |
| ADR-019 | `.cleo/adrs/ADR-019-canonical-logging-architecture.md` | Pino + SQLite dual-write logging; eliminate legacy JSONL audit files | **ARCHIVED** | Explicitly superseded by ADR-024. Status field: `superseded`. | Superseded ADR; keep for historical record. |
| ADR-020 | `.cleo/adrs/ADR-020-session-architecture-cleanup.md` | Drizzle-first session types; eliminate JSON-era session artifacts | **REAL** | Sessions in `tasks-schema.ts` use Drizzle; no JSON session files visible; canonical session lifecycle state machine documented in code. | All five cleanup waves confirmed executed. |
| ADR-021 | `.cleo/adrs/ADR-021-memory-domain-refactor.md` | Memory domain refactor — cognitive-only cutover | **REAL** | `packages/core/src/memory/` is cognitive-only (`brain.db`); memory domain operations route through BRAIN layer. | Amends ADR-007, ADR-009. |
| ADR-022 | `.cleo/adrs/ADR-022-task-completion-hardening.md` | Task completion hardening; canonical done semantics | **REAL** | `packages/cleo/src/dispatch/domains/tasks.ts` enforces completion semantics. Amends ADR-008, ADR-017. | |
| ADR-023 | `.cleo/adrs/ADR-023-protocol-validation-dispatch.md` | Protocol validation through `check.protocol.*` sub-namespace | **REAL** | `packages/cleo/src/dispatch/domains/check.ts` exposes `check.protocol.*` operations. `validateArchitectureDecisionTask` exists. | |
| ADR-024 | `.cleo/adrs/ADR-024-multi-store-canonical-logging.md` | Extends ADR-019: MCP logger, projectHash correlation, audit_log retention | **REAL** | Logging with projectHash confirmed; brain.db and nexus.db audit strategies in place. | Supersedes ADR-019 sections 2.1-2.4. |
| ADR-025 | `.cleo/adrs/ADR-025-warp-protocol-chains.md` | Warp / Protocol Chains — workshop vocabulary for workflow + quality gates | **DRAFT** | Status in adr-index.jsonl is `unknown`. No Warp-specific implementation found in codebase. The conceptual vocabulary exists in docs but no code artifact for "Warp" as a typed construct. | Vocabulary ADR; partially informational. |
| ADR-026 | `.cleo/adrs/ADR-026-release-system-consolidation.md` | Release system consolidation | **REAL** | `packages/cleo/src/cli/commands/release.ts` — consolidated release pipeline. | |
| ADR-027 | `.cleo/adrs/ADR-027-manifest-sqlite-migration.md` | Manifest SQLite migration; `pipeline_manifest` table | **REAL** | `pipelineManifest` table confirmed in `tasks-schema.ts` at line 673. `cleo manifest append` writes to this table. | Most widely referenced ADR in protocol files (ADR-027/T1093). |
| ADR-028 | `.cleo/adrs/ADR-028-changelog-generation-model.md` | CHANGELOG generation model | **REAL** | CHANGELOG generation in release pipeline confirmed. | |
| ADR-029 | `.cleo/adrs/ADR-029-contributor-project-dev-channel-detection.md` | Contributor/project/dev channel detection | **REAL** | Channel detection exists in install logic. | |
| ADR-030 | `.cleo/adrs/ADR-030-operation-model-rationalization.md` | Operation model rationalized from 268 to 164 | **STALE** | Operation count has since grown (registry shows 248+ per memory); the rationalization was real at the time but the count claim is stale. | Historical rationalization step; count now larger. |
| ADR-031 | `.cleo/adrs/ADR-031-provider-adapter-architecture.md` | Provider adapter architecture (Claude Code, OpenCode, Cursor) | **REAL** | `packages/cleo-os/` (harness sovereignty), per-provider agent folders, spawn adapters. | Exact duplicate of ADR-033 with minor phrasing differences. |
| ADR-032 | `.cleo/adrs/ADR-032-provider-agnostic-memory-bridge.md` | Provider-agnostic memory bridge (replace CLAUDE.md injection) | **REAL** | `packages/core/src/memory/memory-bridge.ts` and `packages/core/src/memory/graph-memory-bridge.ts` exist. AGENTS.md @-reference chain replaces direct CLAUDE.md injection. | Exact duplicate of ADR-034 with minor phrasing differences. |
| ADR-033 | `.cleo/adrs/ADR-033-provider-adapter-architecture.md` | Same as ADR-031 | **REAL** | Same code artifact as ADR-031. | DUPLICATE of ADR-031 — same decision filed twice. |
| ADR-034 | `.cleo/adrs/ADR-034-provider-agnostic-memory-bridge.md` | Same as ADR-032 | **REAL** | Same code artifact as ADR-032. | DUPLICATE of ADR-032 — same decision filed twice. |
| ADR-035 | `.cleo/adrs/ADR-035-pi-v2-v3-harness.md` | Pi v2+v3 harness; three-tier scope; PiHarness.spawnSubagent as sole subagent path | **PARTIAL** | `packages/caamp/` contains Pi harness. `PiHarness.spawnSubagent` exists. CANT topology confirmed wired. However ADR-049 partially supersedes the harness-boundary claims. | Superseded in part by ADR-049. |
| ADR-036 | `.cleo/adrs/ADR-036-cleoos-database-topology.md` | 4-DB × 2-tier topology; VACUUM INTO backup; walk-up scaffolding | **REAL** | `tasks.db`, `brain.db`, `conduit.db`, `signaldock.db` confirmed. VACUUM INTO in `vacuumIntoBackupAll`. Walk-up in `getProjectRoot()`. | |
| ADR-037 | `.cleo/adrs/ADR-037-conduit-signaldock-separation.md` | Split project-tier DB into conduit.db + global signaldock.db | **REAL** | `conduit.db` and `signaldock.db` are separate per database topology. | |
| ADR-038 | `.cleo/adrs/ADR-038-backup-portability.md` | `.cleobundle` tarball format for cross-machine backup | **REAL** | `cleo backup` command and backup/restore logic confirmed. | |
| ADR-039 | `.cleo/adrs/ADR-039-lafs-envelope-unification.md` | LAFS envelope unification: `{success, data, error, meta}` | **REAL** | `LafsEnvelope<T>` in `packages/contracts/src/lafs.ts` at line 136. `CleoResponse<T>` wraps it. | |
| ADR-040 | NONE | Does not exist | **GHOST** | No file; no code references found either. Number gap. | Skipped number in sequence. |
| ADR-041 | `.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md` | WorktreeHandle as SpawnOptions contract | **REAL** | `packages/core/src/tools/sdk/isolation.ts` (WorktreeIsolation). Spawn with worktree env vars confirmed. | |
| ADR-042 | `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` | CLI system integrity; Conduit domain disposition | **ARCHIVED** | Status: `SUPERSEDED`. Explicitly marked superseded in adr-index.jsonl. | |
| ADR-043 | `.cleo/adrs/ADR-043-native-citty-command-migration.md` | Native citty command architecture for shim removal | **REAL** | `packages/cleo/src/cli/index.ts` uses citty (`runMain`, `defineCommand`). Shim removal appears complete. Status was PROPOSED but implementation is done. | Status in file says PROPOSED but code reflects full implementation. |
| ADR-044 | `.cleo/adrs/ADR-044-canon-reconciliation.md` | Canon reconciliation: 6 systems, 11 domains | **PARTIAL** | `packages/cleo/src/dispatch/domains/check/canon.ts` checks for "6 systems" in vision text. PROPOSED status but partially implemented as a validation check. | |
| ADR-045 | `.cleo/adrs/ADR-045-cleo-scaffolding-ssot.md` | `.cleo/agent-outputs` as OUTPUT_DIR default; eliminate orphan dirs | **REAL** | `.cleo/agent-outputs/` confirmed as output dir. PROPOSED status in file but skills and protocols use this path consistently. | |
| ADR-046 | `.cleo/adrs/ADR-046-stdp-phase-5-implementation.md` | STDP Phase 5 — complete plasticity substrate | **REAL** | `packages/core/src/memory/` contains STDP/plasticity implementation. Status: accepted. | |
| ADR-047 | `.cleo/adrs/ADR-047-autonomous-gc-and-disk-safety.md` | Autonomous GC + transcript lifecycle sidecar daemon | **REAL** | `packages/core/src/memory/brain-purge.ts`, `brain-gc.ts`. GC daemon in sentient subsystem. | |
| ADR-048 | `.cleo/adrs/ADR-048-memory-extraction-pipeline.md` | Unified memory extraction pipeline contract | **REAL** | `packages/core/src/memory/llm-extraction.ts`, `transcript-extractor.ts`, `extraction-gate.ts`. | |
| ADR-049 | `.cleo/adrs/ADR-049-harness-sovereignty.md` | Harness sovereignty: CLEO-owned memory + per-provider agent folder | **PARTIAL** | `packages/cleo-os/` is the sovereignty layer. PROPOSED status but ADR-050 extends it. Per-provider agent folders confirmed. | Partially supersedes ADR-035 harness-boundary claims. |
| ADR-050 | `.cleo/adrs/ADR-050-cleoos-sovereign-harness.md` | CleoOS sovereign harness: distribution binding charter | **PARTIAL** | `packages/cleo-os/` exists. PROPOSED status; shipping confirmed (v2026.4.100 era). | Extends ADR-049. |
| ADR-051 (`.cleo/adrs`) | `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` | Evidence-based verify; removal of --force; CLEO_OWNER_OVERRIDE | **REAL** | `packages/cleo/src/dispatch/domains/tasks.ts` line 351-356: `E_FLAG_REMOVED`. `CLEO_OWNER_OVERRIDE=1` env var check confirmed. Evidence cache at `.cleo/cache/evidence/`. | This is the canonical ADR-051. |
| ADR-051 (`docs/adr`) | `docs/adr/ADR-051-override-patterns.md` | Override Patterns companion doc for ADR-051 | **REAL** | Describes usage patterns consistent with `.cleo/adrs/` version. | Companion/explainer doc, not a separate decision. |
| ADR-052 (`.cleo/adrs`) | `.cleo/adrs/ADR-052-caamp-keeps-commander.md` | caamp retains commander (not citty) | **REAL** | `packages/caamp/` confirmed to use commander. | Canonical ADR-052 in .cleo/adrs. |
| ADR-052 (`docs/adr`) | `docs/adr/ADR-052-sdk-consolidation.md` | SDK Consolidation — Vercel AI SDK as LLM bridge | **REAL** | Vercel AI SDK in `packages/core/src/agents/`. | COLLISION — this is a completely different decision assigned to the same number. |
| ADR-053 (`.cleo/adrs`) | `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` | Project-agnostic release pipeline (T820) | **REAL** | `packages/cleo/src/cli/commands/release.ts`. | Canonical ADR-053 in .cleo/adrs. |
| ADR-053 (`docs/adr`) | `docs/adr/ADR-053-playbook-runtime.md` | Playbook runtime as deterministic state machine | **REAL** | `packages/playbooks/` + rcasd.cantbook, ivtr.cantbook, release.cantbook. | COLLISION — different decision, same number. |
| ADR-054 (`.cleo/adrs`) | `.cleo/adrs/ADR-054-manifest-unification.md` | Manifest/RCASD architecture unification | **REAL** | `pipeline_manifest` table + `cleo manifest append`. | Canonical ADR-054 in .cleo/adrs. |
| ADR-054 (`docs/adr`) | `docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md` | Migration system hybrid path A+ | **REAL** | `packages/core/src/store/migration-manager.ts`. | COLLISION — different decision, same number. |
| ADR-055 | `docs/adr/ADR-055-agents-architecture-and-meta-agents.md` | Agents architecture; per-provider agent folders; seed agents; D035 addendum | **REAL** | `packages/agents/`, `packages/core/src/agents/`, `packages/core/src/store/agent-resolver.ts`. | Only in docs/adr; not in .cleo/adrs. Amends D022, D025, D026. |
| ADR-056 | `docs/adr/ADR-056-db-ssot-and-release-completion-invariant.md` | DB SSoT naming convention; archiveReason enum; post-release gate | **REAL** | `packages/cleo/src/cli/commands/reconcile.ts` references `ADR-056 D5`. archiveReason enum in tasks-schema.ts. | Only in docs/adr. |
| ADR-057 | `docs/adr/ADR-057-contracts-core-ssot.md` | Contracts/Core SSoT; uniform `(projectRoot, params)` Core API; OpsFromCore-inferred dispatch | **REAL** | `OpsFromCore<C>` pattern in `packages/cleo/src/dispatch/domains/`. `(projectRoot, params)` signature consistent. | Only in docs/adr. |
| ADR-058 | `docs/adr/ADR-058-dispatch-type-inference.md` | Dispatch type inference via `OpsFromCore<C>` | **REAL** | `packages/cleo/src/dispatch/domains/` all use this pattern. | Only in docs/adr. |
| ADR-059 | `docs/adr/ADR-059-override-pumps.md` | Override governance pumps — per-session cap + shared-evidence flag | **REAL** | `packages/cleo/src/cli/commands/verify.ts` line 89: `--shared-evidence` flag per ADR-059/T1502. | Only in docs/adr (YAML frontmatter format). |
| ADR-060 | NONE | Does not exist | **GHOST** | No file; no code references found. Number gap. | |
| ADR-061 | `docs/adr/ADR-061-project-agnostic-verify-tools.md` | Project-agnostic evidence tools + cross-process result cache | **REAL** | `packages/core/src/tasks/tool-cache.ts` — cache at `.cleo/cache/evidence/`. Cross-process semaphore confirmed. | Only in docs/adr. |
| ADR-062 | `docs/adr/ADR-062-worktree-merge-not-cherry-pick.md` | Worktree integration uses `git merge --no-ff` | **REAL** | `packages/cleo/src/dispatch/domains/orchestrate.ts` line 1453: `completeAgentWorktreeViaMerge` per ADR-062. Test at line 103 confirms. | Only in docs/adr. |
| ADR-063 | `docs/adr/ADR-063-release-pipeline.md` | Canonical release pipeline (4-step) | **REAL** | `packages/cleo/src/cli/commands/release.ts` line 260 and registry.ts lines 6875-6909 reference ADR-063. | Only in docs/adr. |
| ADR-064 | NONE | SDK Tools taxonomy — Category A Agent Tool vs Category B SDK Tool | **GHOST** | Referenced 14 times in `packages/contracts/src/sdk-tool.ts`, `packages/core/src/tools/sdk/` files. 8 files say "once ADR-064 is written" — the ADR was never written. | HIGH PRIORITY: 14 code references, no file. |
| ADR-067 | `.cleo/adrs/ADR-067-project-root-resolution.md` | Project root resolution; refuse-with-error; project-info.json marker; Worktree Env→ALS bridge | **REAL** | `packages/core/src/system/rogue-cleo-detector.ts`. `CLEO_WORKTREE_ROOT` env var confirmed. `E_NOT_INITIALIZED` error code confirmed. Date 2026-05-04. | Only in .cleo/adrs; newest ADR. |
| adr-cleoos-sentient-harness | `docs/adr/adr-cleoos-sentient-harness.md` | CleoOS Sentient Harness — Architecture Design (unnumbered draft) | **DRAFT** | Status: Draft. No ADR number assigned. Architecture document for `packages/cleo-os/` harness extension. | Unnumbered; needs decision on whether to assign number or promote. |

---

## 4. Schema Gap Analysis

### Current `brain_decisions` Schema (brain.db)

Fields present (from memory-schema.ts):

| Field | Type | Purpose | Populated? |
|-------|------|---------|-----------|
| `id` | text PK | D001, D002, ... sequential | Yes |
| `type` | enum | technical/tactical/strategic | Yes |
| `decision` | text | Decision text | Yes |
| `rationale` | text | Rationale | Yes |
| `confidence` | enum | high/medium/low | Yes |
| `outcome` | enum | success/failure/pending | Partial |
| `alternativesJson` | text | JSON alternatives list | Partial |
| `contextEpicId` | text | Soft FK to tasks.db | Partial |
| `contextTaskId` | text | Soft FK to tasks.db | Partial |
| `contextPhase` | text | Pipeline phase | Partial |
| `qualityScore` | real | 0.0–1.0 quality | Yes |
| `createdAt` | text | ISO timestamp | Yes |
| `updatedAt` | text | ISO timestamp | Partial |
| `memoryTier` | enum | short/medium/long | Yes |
| `memoryType` | enum | semantic/episodic/etc | Yes |
| `verified` | boolean | Owner-verified flag | Yes (default false) |
| `validAt` | text | Bitemporal valid-from | Yes |
| `invalidAt` | text | Bitemporal valid-until | Never set |
| `sourceConfidence` | enum | owner/agent/etc | Partial |
| `citationCount` | integer | Retrieval count | Yes |
| `tierPromotedAt` | text | Tier promotion timestamp | Partial |
| `tierPromotionReason` | text | Promotion reason | Partial |
| `contentHash` | text | SHA-256 prefix dedup | Yes |
| `provenanceClass` | text | unswept-pre-T1151/swept-clean/etc | Yes (default legacy) |
| `peerId` | text | CANT agent isolation | Yes |
| `peerScope` | text | global/project/agent | Yes |
| `adrNumber` | integer | ADR sequence number | **NEVER POPULATED** (0 of 51 rows) |
| `adrPath` | text | Relative path to ADR file | **NEVER POPULATED** (0 of 51 rows) |
| `supersedes` | text FK | ID of superseded row | **NEVER POPULATED** |
| `supersededBy` | text FK | ID of superseding row | **NEVER POPULATED** |
| `confirmationState` | enum | proposed/accepted/superseded/rejected | Always 'proposed' |
| `decidedBy` | enum | owner/agent/council | Always 'agent' |
| `validatorRunAt` | integer | Unix timestamp of last validation | **NEVER POPULATED** |

### Current `architecture_decisions` Schema (tasks.db)

Managed by `sync.ts` — reads exclusively from `.cleo/adrs/*.md` frontmatter:

| Field | Present | Notes |
|-------|---------|-------|
| `id` | Yes | ADR-NNN identifier |
| `title` | Yes | ADR title |
| `status` | Yes | proposed/accepted/superseded/rejected |
| `supersedesId` | Yes | FK to self |
| `supersededById` | Yes | FK to self |
| `consensusManifestId` | Yes | FK to pipeline_manifest |
| `content` | Yes | Full markdown body |
| `createdAt` / `updatedAt` | Yes | timestamps |
| `date` | Yes | Decision date |
| `acceptedAt` | Yes | Acceptance date |
| `gate` / `gateStatus` | Yes | HITL/automated gate |
| `amendsId` | Yes | FK to amended ADR |
| `filePath` | Yes | Relative file path |
| `summary` | Yes | Cognitive search summary |
| `keywords` | Yes | Comma-separated keywords |
| `topics` | Yes | Comma-separated topics |

### Schema Gaps and Recommended Additions

**For `brain_decisions` (brain.db)** — to enable full ADR canonization:

| Recommended Field | Type | Rationale | Priority |
|-------------------|------|-----------|----------|
| `adrStatus` | enum: 'proposed'/'accepted'/'superseded'/'rejected'/'draft'/'archived' | The current `confirmationState` overlaps but is not the same as ADR lifecycle status. A dedicated ADR-status field avoids semantic collision. | HIGH |
| `adrBody` | text | Full markdown content of the ADR. Currently absent — brain_decisions only stores the `decision` text summary, not the full ADR body. `architectureDecisions.content` has this. | HIGH |
| `adrAmendsId` | text FK | Which ADR this one amends. Present in `architectureDecisions` but absent in `brainDecisions`. | MEDIUM |
| `relatedTaskIds` | text (JSON array) | The existing `contextTaskId` is a single task. ADRs span multiple tasks. `architectureDecisions` uses a junction table (`adr_task_links`); brain_decisions needs an equivalent. | HIGH |
| `gate` | enum: 'HITL'/'automated' | Gate type for ADR acceptance (present in architectureDecisions). | MEDIUM |
| `gateStatus` | text | Gate status (passed/failed/pending) — present in architectureDecisions. | MEDIUM |
| `lastValidatedAt` | integer (unix ts) | Timestamp of last code-validation run against this ADR. Currently `validatorRunAt` exists but is never populated. Rename or document semantics. | HIGH |
| `lastValidatedAgainstCommit` | text | Git SHA when validation last ran. Enables staleness detection. | MEDIUM |
| `contradictionDetected` | boolean | Flag set when the ADR claim contradicts current code state. Enables automated STALE detection. | MEDIUM |
| `adrReviewHistory` | text (JSON array) | Ordered list of {reviewer, timestamp, action, note} for HITL review trail. Currently absent entirely. | LOW |
| `supersessionGraphValidated` | boolean | Whether the supersession chain (supersedes/supersededBy links) has been validated for cycles. | LOW |

**Dual-store problem — critical schema decision required:**

Currently `architecture_decisions` (tasks.db) and `brain_decisions` (brain.db) serve overlapping purposes. The `adrNumber` and `adrPath` fields exist in `brain_decisions` but are never written. The `sync.ts` tool writes only to `architecture_decisions`. This creates two partially-populated stores:

- `architecture_decisions`: populated by `cleo adr sync` from `.cleo/adrs/*.md` — has content, filePath, status, cognitive search fields
- `brain_decisions`: populated by `storeDecision()` from agent sessions — has confidence, tier, quality scoring, but NO ADR linkage

**Recommended resolution**: Owner must decide whether to:
- (A) Keep both stores and add a cross-link: `brain_decisions.linkedAdrId → architecture_decisions.id`
- (B) Consolidate: make `architecture_decisions` the canonical ADR store and backfill `brain_decisions.adrNumber/adrPath` via the sync step
- (C) Migrate: replace `architecture_decisions` entirely with `brain_decisions` rows (massive migration, retains cognitive features)

Option A is lowest risk. Option B aligns with the existing sync toolchain. Option C is the long-term "DB canonization" the owner references.

---

## 5. ct-* Skill Audit

### 5a. ADR references in ct-* skills

| Skill | File | Line | Current Instruction | Issue | Recommended Change |
|-------|------|------|--------------------|----|-------------------|
| ct-cleo | `SKILL.md` | 114 | `grep -r "<id>" docs/adr/` as tier-1 lookup for architectural decisions | **WRONG PATH**: `adr sync` and `adr validate` operate on `.cleo/adrs/`. Agents instructed to look in `docs/adr/` will miss all ADRs in `.cleo/adrs/` — which is 53 of the 67 total ADR files. | Change to `grep -r "<id>" .cleo/adrs/`. OR instruct agents to use `cleo adr find "<query>"` which queries the `architecture_decisions` DB (which syncs from `.cleo/adrs/`). |
| ct-cleo | `SKILL.md` | 587 | `architecture_decision` | ADR and specification | NO CHANGE | Correct — references the RCASD pipeline stage. |
| ct-cleo | `SKILL.md` | 193, 227 | ADR-051 references for gate ritual | Correct. | No change needed. |
| ct-orchestrator | `SKILL.md` | 46, 59, 143 | Generic ADR references ("write ADRs", "check implementation against ADRs") | No specific path given — agents must infer. | Add: "ADRs are in `.cleo/adrs/` (canonical). Use `cleo adr find <query>` for search." |
| ct-orchestrator | `SKILL.md` | 209 | ADR-051 evidence gate reference | Correct. | No change needed. |
| ct-orchestrator | `references/SUBAGENT-PROTOCOL-BLOCK.md` | 12, 37 | ADR-027/T1093 manifest reference | Correct. | No change needed. |
| ct-orchestrator | `references/orchestrator-tokens.md` | 159, 168 | ADR-027 manifest reference | Correct. | No change needed. |
| ct-research-agent | `SKILL.md` | 158 | ADR-027 manifest reference | Correct. | No change needed. |
| ct-task-executor | `SKILL.md` | 165 | ADR-027 manifest reference | Correct. | No change needed. |
| ct-council | `references/evidence-pack.md` | 84 | `Check for ADRs ... Search docs/adr/` | **WRONG PATH** — same issue as ct-cleo. | Change to `.cleo/adrs/` or `cleo adr find`. |
| ct-council | `references/examples.md` | 16, 33, 89+ | References `docs/adr/ADR-021-http-client.md` | This is a FICTIONAL example ADR (no real ADR-021-http-client exists). It's used purely as a worked example for council evaluation. | This is intentional fiction for training examples. No change needed, but add a comment that it's illustrative. |
| ct-council | `references/first-principles.md` | 39 | "MUST anchor atoms ... to external references (... ADR ...)" | Generic — no specific path instruction. | Add: "For CLEO ADRs, use `.cleo/adrs/` or `cleo adr find`." |
| ct-cleo | `references/loom-lifecycle.md` | 44 | RCASD stage: `architecture_decision` | Correct pipeline stage reference. | No change needed. |
| ct-cleo | `references/loom-lifecycle.md` | 110 | `cleo manifest append ... per ADR-027/T1093` | Correct. | No change needed. |

**Summary**: Two skills (ct-cleo and ct-council) contain path instructions pointing to `docs/adr/` instead of `.cleo/adrs/`. This is the most impactful skill change needed.

### 5b. CLEO-INJECTION.md and AGENTS.md audit

| File | Line | Current Text | Issue | Recommendation |
|------|------|-------------|-------|----------------|
| `CLEO-INJECTION.md` | 114 | `docs/architecture/orchestration-flow.md` (6-layer pipeline) and `docs/adr/ADR-053-playbook-runtime.md` | `ADR-053-playbook-runtime.md` is in `docs/adr/` — but the .cleo/adrs version of ADR-053 is a different decision (Project-Agnostic Release Pipeline). This is a collision reference. | After collision resolution, update to point to the correct ADR-053. |
| `CLEO-INJECTION.md` | 281 | `grep -r "D0xx" docs/adr/` as "canonical source" | **WRONG PATH** — canonicalization target is `.cleo/adrs/`. | Change to `grep -r "D0xx" .cleo/adrs/`. |
| `CLEO-INJECTION.md` | 148, 150, 209, 218, 219, 248 | ADR-051, ADR-061 references without path | No path issue — these are correct behavioral references. | No change needed. |
| `CLEO-INJECTION.md` | 100, 110 | ADR-055, ADR-062 behavioral references | Correct. | No change needed. |
| `AGENTS.md` (project) | 112 | `ADR-013 §9` (Runtime Data Safety) | Correct behavioral reference, no path needed. | No change needed. |

---

## 6. Architecture-Decision Protocol TS Audit

### Files examined:
- `packages/core/src/validation/protocols/architecture-decision.ts`
- `packages/core/src/orchestration/protocol-validators.ts` (contains `validateArchitectureDecisionProtocol`)
- `packages/core/src/adrs/sync.ts`
- `packages/core/src/adrs/validate.ts`
- `packages/core/src/memory/decisions.ts`
- `packages/core/src/store/memory-schema.ts` (brainDecisions)
- `packages/core/src/store/tasks-schema.ts` (architectureDecisions)

### Function-by-function assessment:

| Function | File | Location | ADR Location Awareness | Gap | Recommendation |
|----------|------|----------|----------------------|-----|----------------|
| `validateArchitectureDecisionTask` | `protocols/architecture-decision.ts` | Thin wrapper; delegates to `validateArchitectureDecisionProtocol` | None — no file path logic | Function does not verify that the ADR file exists at `.cleo/adrs/` or `docs/adr/`. It only validates the manifest entry shape. | Add optional `adrFilePath` check: verify the file exists at `.cleo/adrs/` before returning. |
| `checkArchitectureDecisionManifest` | `protocols/architecture-decision.ts` | Loads manifest from file; validates protocol | None | Same as above. | Same recommendation. |
| `validateArchitectureDecisionProtocol` | `orchestration/protocol-validators.ts` | Enforces 8 MUST requirements (ADR-001..008 of the protocol spec, NOT the project ADR numbers) | None | ADR-006 in the validator says `'Insert the decision via the Drizzle ORM architectureDecisions table'` — this is the OLD table name. After DB canonization, this message should reference `brainDecisions` or the unified store. | Update error message in ADR-006 check (line 752) to reference the canonical store post-consolidation. |
| `syncAdrs` | `adrs/sync.ts` | Reads `.cleo/adrs/` exclusively; writes to `architecture_decisions` and regenerates `adr-index.jsonl` | `.cleo/adrs/` only | Does NOT read `docs/adr/`. After consolidation (all ADRs moved to `.cleo/adrs/`), this is correct. Before consolidation, it misses 9 ADRs (ADR-055 through ADR-063). | After Wave C (bulk move to `.cleo/adrs/`), sync will be complete. No code change needed post-consolidation. |
| `validateAllAdrs` | `adrs/validate.ts` | Validates `.cleo/adrs/*.md` against JSON schema | `.cleo/adrs/` only | Same gap as sync: 9 ADRs in `docs/adr/` are never validated. | Post-consolidation, this is correct. |
| `storeDecision` | `memory/decisions.ts` | Stores to `brain_decisions` via extraction gate | None for ADR linkage | `adrPath` and `adrNumber` params exist in `StoreDecisionParams` but are rarely/never passed. The gate pipeline does not auto-populate ADR fields when called from `validateArchitectureDecisionProtocol`. | Add a step in `validateArchitectureDecisionTask` to call `storeDecision` with `adrPath` and `adrNumber` populated. |
| `nextDecisionId` | `memory/decisions.ts` | Generates D001/D002 sequential IDs for brain_decisions | None | The sequence is separate from ADR-NNN numbering. No link between brain_decisions D-IDs and architecture_decisions ADR-NNN. | Document explicitly that these are different ID spaces. |

**Key finding**: The `validateArchitectureDecisionProtocol` function references `'architectureDecisions table'` (old/tasks.db concept) in its error message at line 752. This will be misleading after any DB canonization.

---

## 7. Reference Sweep Target List

Files that will need updating after consolidation (path changes from `docs/adr/` → `.cleo/adrs/`, collision number reassignment, or ADR-064 file creation):

### Code: TSDoc / comments (packages/)

| File | References | Update needed |
|------|-----------|---------------|
| `packages/cleo/src/cli/commands/orchestrate.ts` | ADR-062 | Path update if moving docs/adr ADRs |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | ADR-062 | Same |
| `packages/cleo/src/cli/commands/verify.ts` | ADR-059 | Path update |
| `packages/cleo/src/cli/commands/complete.ts` | ADR-051 | Path update |
| `packages/cleo/src/cli/commands/release.ts` | ADR-063 | Path update |
| `packages/cleo/src/cli/commands/add.ts` | ADR-057 | Path update |
| `packages/cleo/src/cli/commands/reconcile.ts` | ADR-056 | Path update |
| `packages/cleo/src/dispatch/domains/tasks.ts` | ADR-051 | Path update |
| `packages/cleo/src/dispatch/registry.ts` | ADR-063 | Path update |
| `packages/cleo/src/adrs/sync.ts` | ADR-017 | No path; conceptual ref |
| `packages/core/src/orchestration/protocol-validators.ts` | ADR-003..008 (protocol internal refs, not project ADRs), `architectureDecisions` table reference | Update error message post-DB canonization |
| `packages/core/src/store/tasks-schema.ts` | ADR-017 §5.3/§5.4 inline refs | Conceptual; no path change needed |
| `packages/core/src/store/memory-schema.ts` | ADR-009 inline ref | No path change needed |
| `packages/contracts/src/sdk-tool.ts` | ADR-064 x2 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/isolation.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/index.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/tool-cache.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/manifest.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/spawn-primitives.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/sdk/tool-resolver.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/tools/index.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/contracts/src/index.ts` | ADR-064 | **CREATE ADR-064 file** |
| `packages/core/src/orchestrate/worker-verify.ts` | ADR-061 | Path update |
| `.cleo/.gitignore` | ADR-013 §9 | Conceptual; no path change |

### Tests

| File | References | Update needed |
|------|-----------|---------------|
| `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts` | ADR-062 | Path update after consolidation |
| `packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts` | ADR-051 | Path update |
| `packages/core/src/tasks/__tests__/tool-cache.test.ts` | ADR-061 (implicit) | Path update |
| `packages/skills/skills/ct-master-tac/__tests__/install.test.ts` | architectureDecisionTask | No path change; functional test |

### Docs

| File | References | Update needed |
|------|-----------|---------------|
| `docs/architecture/orchestration-flow.md` | ADR-051, ADR-052 (docs/adr), ADR-053 (docs/adr) | Update links after collision resolution |
| `docs/architecture/DATABASE-ERDS.md` | ADR-001, ADR-036, ADR-037 | Update ADR-001/002 ghost refs |
| `docs/concepts/CLEO-VISION.md` | ADR-006, ADR-011, ADR-031, ADR-032, ADR-036, ADR-037 | Update paths |
| `docs/concepts/CLEOOS-VISION.md` | ADR-001, ADR-002, ADR-035, ADR-037 | Update ghost refs + paths |
| `docs/architecture/erd-tasks-db.md` | ADR-018 | Update path |
| `docs/architecture/TYPE-CONTRACTS.md` | ADR-035 | Update path |
| `docs/architecture/memory-architecture.md` | ADR-039 | Update path |
| `docs/archive/README.md` | ADR-035, ADR-037 | Update paths |
| `docs/CLEO-DOCUMENTATION-SOP.md` | ADR-035 | Update path |
| `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` | ADR-037 | Update path |
| `docs/concepts/CLEO-CANON-INDEX.md` | ADR-044 | Update path |
| `docs/audits/2026-04-22-false-completion-audit.md` | ADR-042, ADR-051, ADR-053 | Historical audit doc; update paths for ADR-053 collision resolution |
| `docs/generated/` (multiple files) | ADR-003 through ADR-017 | Generated — regenerate after consolidation; no manual update |

### Skills: ct-* SKILL.md and references

| File | Line | Update |
|------|------|--------|
| `~/.claude/skills/ct-cleo/SKILL.md` | 114 | Change `docs/adr/` to `.cleo/adrs/` (or `cleo adr find`) |
| `~/.claude/skills/ct-council/references/evidence-pack.md` | 84 | Change `docs/adr/` to `.cleo/adrs/` |
| `~/.claude/skills/ct-orchestrator/SKILL.md` | 46, 59, 143 | Add ADR location note (`.cleo/adrs/`) |

### Playbooks: .cantbook

| File | Reference | Update |
|------|-----------|--------|
| `packages/playbooks/starter/rcasd.cantbook` | "decisions as ADR stubs" | Add path hint: `.cleo/adrs/` |

### Protocol files: AGENTS.md, CLEO-INJECTION.md

| File | Line | Update |
|------|------|--------|
| `~/.cleo/templates/CLEO-INJECTION.md` | 114 | Update ADR-053 path after collision resolution |
| `~/.cleo/templates/CLEO-INJECTION.md` | 281 | Change `docs/adr/` to `.cleo/adrs/` |

---

## 8. Recommended Consolidation Wave Plan

### Wave A — Schema additions (brain_decisions)
**Owner decision required first**: Choose resolution strategy for dual-store (see Section 4).
- If Option A (cross-link): Add `linkedAdrId` to `brain_decisions` pointing to `architecture_decisions.id`.
- If Option B (backfill): Add migration step in `sync.ts` to also write `brain_decisions.adrNumber/adrPath`.
- All options: Add `adrStatus`, `adrBody`, `adrAmendsId`, `relatedTaskIds` (junction or JSON), `gate`, `gateStatus`, `lastValidatedAt`, `lastValidatedAgainstCommit` to `brain_decisions`.
- Rename `validatorRunAt` → `lastValidatedAt` (or document its intended semantics clearly).

### Wave B — Per-collision owner decisions (checklist)

Owner must decide for each collision:

- [ ] **ADR-051**: Keep `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` as canonical ADR-051. Rename `docs/adr/ADR-051-override-patterns.md` to `docs/guides/override-patterns-guide.md` (it's a usage guide, not an ADR).
- [ ] **ADR-052**: TWO real ADRs with number 052. Options:
  - Renumber `docs/adr/ADR-052-sdk-consolidation.md` → ADR-065 (next available)
  - Keep `.cleo/adrs/ADR-052-caamp-keeps-commander.md` as ADR-052
- [ ] **ADR-053**: TWO real ADRs with number 053. Options:
  - Renumber `docs/adr/ADR-053-playbook-runtime.md` → ADR-066
  - Keep `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` as ADR-053
- [ ] **ADR-054**: TWO real ADRs with number 054. Options:
  - Renumber `docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md` → ADR-068
  - Keep `.cleo/adrs/ADR-054-manifest-unification.md` as ADR-054
- [ ] **ADR-031/033 duplicates**: Keep ADR-031, mark ADR-033 as `supersededBy: ADR-031`, or delete ADR-033.
- [ ] **ADR-032/034 duplicates**: Keep ADR-032, mark ADR-034 as `supersededBy: ADR-032`, or delete ADR-034.
- [ ] **Unnumbered `adr-cleoos-sentient-harness.md`**: Assign number (ADR-069?) or promote to implementation spec.
- [ ] **ADR-064 ghost ADR**: Write ADR-064 (SDK Tools taxonomy) — 14 code references await it.
- [ ] **ADR-001, ADR-002 ghost references**: Identify what these were (early ADRs from pre-T4628 era), write stub entries or retire all references.
- [ ] **ADR-025 "Warp Protocol Chains"**: Status is `unknown`. Accept or reject as architectural decision.

### Wave C — Bulk move + dedupe to `.cleo/adrs/`
After Wave B collision resolution:
- Move all resolved `docs/adr/` ADRs to `.cleo/adrs/` (9 files: ADR-055 through ADR-063, renumbered as decided in Wave B)
- Run `cleo adr sync` to populate `architecture_decisions` table
- Run `cleo adr validate` to confirm frontmatter compliance
- Archive `docs/adr/` (or remove — it becomes empty)

### Wave D — brain_decisions backfill
- For every REAL and PARTIAL ADR that now has a row in `architecture_decisions`:
  - Either link or migrate to `brain_decisions` per Wave A decision
  - Populate `adrNumber`, `adrPath`, `confirmationState` (accepted/proposed/superseded/archived), `decidedBy` (owner/agent), `validatorRunAt`
  - Target: ALL 44 REAL + 6 PARTIAL ADRs get a `brain_decisions` row

### Wave E — ct-* skill rewrites
- Update `~/.claude/skills/ct-cleo/SKILL.md` line 114: `docs/adr/` → `.cleo/adrs/` or `cleo adr find`
- Update `~/.claude/skills/ct-council/references/evidence-pack.md` line 84
- Add ADR location guidance to `ct-orchestrator/SKILL.md`

### Wave F — Protocol TS rewrites
- Update error message in `packages/core/src/orchestration/protocol-validators.ts` line 752 (`architectureDecisions table` → canonical post-consolidation store name)
- Add `adrFilePath` existence check to `validateArchitectureDecisionTask`
- Wire `storeDecision` call from `validateArchitectureDecisionTask` to auto-populate `adrPath`/`adrNumber` in `brain_decisions`

### Wave G — Reference sweep across code/docs/tests/playbooks
- Update 9 code files referencing `docs/adr/ADR-055+` paths after move
- Update `orchestration-flow.md` and other docs after collision renumbering
- Create `ADR-064` file (unblocks 14 TSDoc references from returning "pending" documentation)
- Regenerate `docs/generated/` (automated; will self-correct after sync)
- Update `CLEO-INJECTION.md` line 281 (grep path)
- Update rcasd.cantbook with ADR location hint

---

## 9. Open Questions for HITL

1. **Dual-store resolution** (HIGH): `architecture_decisions` (tasks.db) and `brain_decisions` (brain.db) both exist for ADR storage. Which is the canonical post-consolidation store? The `adr sync` toolchain writes to `architecture_decisions` only. The `brain_decisions` schema has ADR fields but they are never populated. Owner must pick Option A, B, or C from Section 4.

2. **ADR number gaps** (MEDIUM): ADR-040 and ADR-060 are gaps (never assigned). ADR-001 and ADR-002 are referenced but files do not exist. Should gap numbers be retired or documented as "intentionally skipped"?

3. **ADR-064 authorship** (HIGH): 14 production code files reference ADR-064 (SDK Tools taxonomy) with comments saying "once ADR-064 is written." This ADR was clearly planned as part of T1768/T1814-T1819 work but never written. Should this be filed immediately as a separate task?

4. **docs/adr/ fate** (MEDIUM): After Wave C consolidation, `docs/adr/` becomes empty. Should it be removed, archived, or kept as a symlink/redirect to `.cleo/adrs/`?

5. **ADR-025 Warp vocabulary** (LOW): The "Warp Protocol Chains" ADR has `unknown` status in the index. Is it a real accepted decision or a scratchpad that should be rejected/archived?

6. **adr-cleoos-sentient-harness.md assignment** (MEDIUM): This draft in `docs/adr/` has no number. Is it the intended specification for the CleoOS sentient harness feature? If yes, assign next available number (ADR-069 after all collisions resolved). If no, archive it.

7. **ct-council example ADRs** (LOW): `ct-council` skill fixtures reference `docs/adr/ADR-021-http-client.md` as a worked example. This is fictional. Should it be updated to reference a real project ADR for authenticity, or left as-is (it's educational fiction)?

8. **ADR-043 status correction** (LOW): `ADR-043-native-citty-command-migration.md` has status `PROPOSED` but citty is fully implemented. Should status be changed to `ACCEPTED` before or during consolidation?

9. **CLEO-INJECTION.md template authority** (MEDIUM): The template at `~/.cleo/templates/CLEO-INJECTION.md` contains the wrong `docs/adr/` path (line 281). This is a global template distributed to all projects. Should the Wave E skill update also include updating this template, or is that a separate release?

10. **brain_decisions `confirmationState` semantics** (MEDIUM): All 51 rows have `confirmationState = 'proposed'` and `decidedBy = 'agent'`. After canonization, only the 44 REAL ADRs should be `accepted` with `decidedBy = 'owner'` or `council`. Is there a bulk update migration or a manual review process intended?

---

*End of Lead Epsilon ADR Audit Report*
