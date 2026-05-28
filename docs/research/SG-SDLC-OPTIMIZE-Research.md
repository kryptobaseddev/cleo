# SG-SDLC-OPTIMIZE: Full SDLC Optimization Research

**Saga ID:** T11205  
**Related to:** T10400 (SG-CLEO-SDK-API) — establishes the quality/testing foundation the SDK API exposes  
**Status:** pending  
**Priority:** critical  
**Created:** 2026-05-28

---

## Executive Summary

This saga implements the **Full Optimized SDLC Vision for Cleo Code** — transforming the platform from a task tracker with agent dispatch into a disciplined, deterministic software engineering harness. It addresses the fundamental flaw in current LLM development tools: treating probabilistic text generators as deterministic logic engines.

The work is organized into **8 epics** spanning test architecture, Agentic TDD, IVTR pipeline hardening, context management, code quality, traceability, and performance.

---

## Epic Breakdown

### E1: TEST-CANONIZATION (T11206) — priority: critical

**Scope:** Rename 23 task-named test files to canonical names, merge split twins, delete stale duplicate.

**Current state:** 23 test files named after task IDs (e.g., `t9625-closure.test.ts`) out of 1,329 total. All in `packages/core/`.

**Merges:**
| Current Files | New File |
|---|---|
| `t9073-severity-any-role-schema.test.ts` + `t9073-severity-cross-role.test.ts` | `severity.test.ts` in `tasks/__tests__/` |
| `t944-role-scope-schema.test.ts` + `t944-role-scope-wiring.test.ts` | `role-scope.test.ts` in `tasks/__tests__/` |
| `t310-readiness.test.ts` | → fold into new `conduit-readiness.test.ts` |
| `t9625-closure.test.ts` | → fold into existing saga test suite |
| `t11021-project-registry.test.ts` | → merge into existing `project-registry.test.ts` (32 lines) |

**Renames (14 files):**
| Current | Canonical |
|---|---|
| `t310-integration.test.ts` | `conduit-signaldock-lifecycle.test.ts` |
| `t311-integration.test.ts` | `cleobundle-lifecycle.test.ts` |
| `t877-pipeline-stage-invariants.test.ts` | `pipeline-stage-invariants.test.ts` |
| `t920-migration-guard.test.ts` | `brain-duplicate-column-guard.test.ts` |
| `t10158-attachments-provenance-schema.test.ts` | `attachments-provenance-schema.test.ts` |
| `t10277-saga-tasktype.test.ts` | `saga-tasktype-schema.test.ts` |
| `t10503-evidence-ac-bindings-schema.test.ts` | `evidence-ac-bindings-schema.test.ts` |
| `t10505-ac-backfill.test.ts` | `acceptance-criteria-backfill.test.ts` |
| `t10639-child-task-projection-backfill.test.ts` | `child-task-projection-backfill.test.ts` |
| `t1830-decision-category.test.ts` | `decision-category.test.ts` |
| `t10079-primary-worktree-root.test.ts` | `worktree-root-routing.test.ts` |
| `t10287-orphan-cleo-regression.test.ts` | `orphan-cleo-detection.test.ts` |
| `t11024-move-rename.test.ts` | `nexus-move-rename.test.ts` |
| `t11031-it.test.ts` | `paths-strict-integration.test.ts` |
| `T10165-backfill-adr-index.test.ts` | `adr-index-backfill.test.ts` (move out of `manual/`) |

**Delete:** `packages/core/packages/core/src/nexus/__tests__/t11024-move-rename.test.ts` (stale duplicate artifact)

---

### E2: TEST-TAXONOMY (T11207) — priority: critical

**Scope:** 6-Gate Testing Hierarchy with layer suffixes + vitest project configs + CI wiring.

**The Cleo 6-Gate Testing System:**

| Gate | Name | What | Layer Suffix |
|---|---|---|---|
| 0 | Static & Security Validation | Linting, type-checking, cyclomatic complexity, SAST | (pre-test — no code execution) |
| 1 | Unit & Mutation Testing | Atomic function/class tests + Stryker mutation testing | `*.unit.test.ts` |
| 2 | Integration Testing | Module boundaries, databases, APIs | `*.integration.test.ts` |
| 3 | Regression Envelope | Full historical suite on current branch | (wrapper — runs Gates 1-2) |
| 4 | System & Non-Functional | Load, stress, security penetration | `*.e2e.test.ts` |
| 5 | Acceptance & Invariant | BDD/Gherkin tests against Specification | `*.acceptance.test.ts` |

**Vitest Project Configs:**
```bash
pnpm test:unit        # *.unit.test.ts (pre-commit, <30s)
pnpm test:integration # *.integration.test.ts (CI gate)
pnpm test:e2e         # *.e2e.test.ts (release gate)
pnpm test:acceptance  # *.acceptance.test.ts (spec gate)
```

**CI Wiring:**
- Pre-commit hook: `pnpm test:unit` (must complete <30s)
- PR CI gate: `pnpm test:unit + test:integration`
- Release gate: `pnpm test:unit + test:integration + test:e2e`
- Spec gate: `pnpm test:acceptance` (run by Orchestrator before Implementation spawn)

---

### E3: AGENTIC-TDD (T11208) — priority: high

**Scope:** Shift-Left Agentic TDD — adversarial Orchestrator/Implementation split.

**The 4-Step Protocol:**
1. **Specification Phase (Test Generation):** Orchestrator Agent writes Acceptance + Integration tests based on spec
2. **Red Phase (Failing State):** Tests committed to branch in FAILING state
3. **Implementation Phase:** Separate Implementation Agent spawned — sole objective: make tests green
4. **Immutable Rule:** Implementation agent CANNOT modify Orchestrator's tests

**Test Format (should-when):**
```
should throw InvalidTokenError when expired JWT is provided
should rollback database transaction when payment API returns 500
should grant dashboard access when user completes 2FA challenge
```

**LOOM Pipeline Changes:**
- Specification phase now produces test stubs as deliverable
- New gate: "Tests Exist and Fail" — validated before Implementation spawns
- Test immutability enforced at git level + LOOM gate

---

### E4: IVTR-HARDENING (T11209) — priority: critical

**Scope:** Split IVTR, add mutation testing, circuit breaker, preflight validation.

**Split Validation from Testing:**
- **V (Validation) = Static Fast-Fail:** TypeScript strict, Biome lint, cyclomatic complexity limits, SAST security scan — all in <500ms
- **T (Testing) = Dynamic:** Unit, Integration, Smoke tests in ephemeral sandboxes

**Mutation Testing Gate:**
- Integrate Stryker for TypeScript
- Intentionally break agent code
- If agent's tests still pass → flag as tautological/hallucination → reject task
- Gate integrated into LOOM lifecycle

**Three-Strike Circuit Breaker:**
| Strike | Action |
|---|---|
| Strike 1 | Feed exact stack trace + failing test back to Implementation agent |
| Strike 2 | Wipe agent's working memory, feed initial spec + all failed attempts, demand different approach |
| Strike 3 | Halt subtask, pause branch, escalate to HITL with failure summary |

**State Rollback (on Strike 3):**
- Deterministically roll back `tasks.db` state
- Revert Git branch to pre-task state
- Flag human with diagnostic summary

**Pre-Flight Dry Run:**
- Before commit: agent outputs strict JSON patch or AST transformation
- Harness applies in dry-run
- Syntax error → corrected before filesystem mutation
- Guard against hallucinated syntax errors

---

### E5: CONTEXT-FIREWALL (T11210) — priority: high

**Scope:** Context-window scoping by task tier — prevent context pollution.

| Tier | Role | Context Scope |
|---|---|---|
| Subtask (Worker) | Leaf execution | Specific file(s) being edited + immediate test file + atomic spec. NO architecture docs, NO system diagrams |
| Task (Phase Lead) | Supervise execution | Module-level interfaces + integration tests |
| Epic (Orchestrator) | Planning + release | System diagrams, ADRs, end-to-end user journeys |
| Saga | Strategic coordination | Full architectural context |

**Size Gate:**
- Before exiting Decomposition phase, Orchestrator evaluates subtasks
- If subtask predicted to touch >3 files → gate REJECTS → forces further decomposition
- Ensures execution agents always stay within safe, predictable bounds

**Context Assembly Engine:**
- Dynamically filters context injected into prompt based on task tier
- Reduces hallucinations by limiting irrelevant information
- Integrated with CANT runtime for context assembly

---

### E6: SOLID-DRY-REFACTOR (T11211) — priority: high

**Scope:** Comprehensive code quality improvement across the entire codebase.

**SOLID Principles Applied:**

| Principle | Action |
|---|---|
| **S**ingle Responsibility | Split god-modules. Each module does ONE thing |
| **O**pen/Closed | Extension points (plugins, adapters, providers) open for extension, closed for modification |
| **L**iskov Substitution | All adapter/provider implementations satisfy base contracts |
| **I**nterface Segregation | Extract TypeScript interfaces for all major subsystems |
| **D**ependency Inversion | Inject dependencies rather than direct imports where appropriate |

**DRY Violations:**
- Identify and consolidate duplicated logic across `packages/core`
- Common patterns extracted into shared utilities
- Migration test templates consolidated

**Dead Code Removal:**
- Audit entire codebase for dead code paths
- Unused exports, stale features, cruft
- Aggressive deletion — no backwards compat for dead code

**Compartmentalization:**
- Clear module boundaries
- Each package has well-defined public API
- Internal implementation details not leaked

**Speed Optimization:**
- Profile critical paths: CLI startup, task resolution, DB queries, migration runner
- Target: CLI startup <200ms, DB queries <50ms

**Major Subsystems to Refactor:**
1. Tasks (add/find/update/complete/archive)
2. Memory (observe/find/fetch/timeline/brain)
3. Nexus (index/query/impact/reconcile)
4. Conduit (project identity/signaldock)
5. Orchestration (spawn/ready/waves/IVTR)
6. Lifecycle (pipeline/verification/resume)
7. Sessions (start/end/grade/journal)
8. Store (data-accessor/migrations/backup)

---

### E7: TEST-STANDARDS (T11212) — priority: high

**Scope:** Universal test naming conventions + test-to-task traceability + lint enforcement.

**REALITY CHECK — Why cryptographic prompt hashing is useless right now:**

Cleocode stores zero conversation transcripts. The `sessions` table has metadata
(started_at, ended_at, agent_identifier, handoff notes, token counts) but NO
turn-by-turn prompt/response storage — no JSONL, no message store, no transcript
archive. Hermes has raw JSON request dumps in `~/.hermes/sessions/` but they're
unindexed API blobs. Without a conversation storage infrastructure (which has no
plan to exist), a "prompt hash" traces back to nothing.

**What IS valuable and achievable today:**

**(1) Universal Test Naming — should-when format:**
```
should throw InvalidTokenError when expired JWT is provided
should rollback database transaction when payment API returns 500
should grant dashboard access when user completes 2FA challenge
```
Enforced via Biome plugin or custom ESLint rule.

**(2) File Naming Standard — target.layer.test.ext:**
```
auth_service.test.unit.ts
database_driver.test.integration.ts
payment_flow.test.acceptance.ts
```
Enforced via lint rule.

**(3) Suite Naming — [TaskID] mapping:**
```
[T-492] - AuthenticationService
[E-12] - User Checkout Flow
```
Maps test suites → CLEO TASKS DB for traceability from failing test → owning task.

**(4) Git Trailer Attribution:**
```
Cleo-Task: T11205
```
Already partially in use. Standardize and enforce via pre-commit hook.

**(5) Test-to-Task Coverage Mapping:**
Tool that maps `test file → task ID → acceptance criteria` for coverage gap detection.
"Which ACs have no tests?" becomes answerable.

**(6) Ed25519 Integration:**
Wire existing Ed25519 severity attestation to test-signing on acceptance gate pass.

---

### E8: PERFORMANCE-BENCHMARKS (T11213) — priority: medium

**Scope:** Performance baseline + benchmarking + optimization.

**Baseline Targets:**
| Metric | Target |
|---|---|
| CLI startup | <200ms |
| `cleo list` (1000 tasks) | <500ms |
| `cleo find` (full text search) | <300ms |
| Full test suite | <5min |
| DB migration (fresh) | <2s |
| Mutation testing gate | <30s per task |

**Work:**
1. Measure current performance of all critical paths
2. Add vitest bench or custom benchmark harness
3. Analyze and optimize slow DB queries — add indexes
4. Module lazy loading for non-critical CLI commands
5. Identify slow tests (>5s) — mock heavy deps, parallelize
6. CI performance regression gate — fail if >10% regression

---

## Dependency Order

```
E1 (TEST-CANONIZATION) ──┐
                          ├── E2 (TEST-TAXONOMY) ──┐
                          │                        ├── E3 (AGENTIC-TDD) ──┐
                          │                        │                     ├── E7 (CRYPTO-TRACEABILITY)
                          │                        ├── E4 (IVTR-HARDENING)┘
                          │                        │
E6 (SOLID-DRY-REFACTOR) ─┘                        │
                                                   ├── E5 (CONTEXT-FIREWALL)
                                                   │
                                                   └── E8 (PERFORMANCE-BENCHMARKS)
```

E1+E6 can run in parallel (different concerns). E2 depends on E1 completing. E3+E4 depend on E2. E7 depends on E3. E5 depends on E2+E6. E8 depends on E6.

---

## Future Expansions (post-Saga)

- **Agentic Chaos Engineering:** Ingest brownfield codebase, inject faults, map undocumented dependencies
- **Cost-Aware Pathing:** Route low-priority tasks to cheaper models, high-complexity to frontier models
- **Devil's Advocate Agent Gate:** Adversarial agent between Architecture and Specification to harden plans
