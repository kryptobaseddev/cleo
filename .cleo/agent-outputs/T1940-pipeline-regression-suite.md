# T1940: Phase 1 Pipeline Regression Suite

**Status**: complete
**Task**: Pipeline regression test suite: end-to-end spawn → classify → resolve → install for all 5 worker roles + playbook tier resolver
**Epic**: T1929 (Phase 1: Agent System Canonicalization v2)
**Commit**: f99669844

## Deliverables

### New Test Files

1. `packages/core/src/__tests__/pipeline-e2e.test.ts` — 11 tests
2. `packages/core/src/agents/__tests__/variable-resolver-shadowing.test.ts` — 19 tests (LOAD-BEARING)

**Total: 30 new tests, 30 passing, 0 flakes across 3 sequential runs**

## Coverage

### pipeline-e2e.test.ts

**Suite 1 — All 5 worker roles (end-to-end)**
- `project-orchestrator` — labels: orchestrate, spawn
- `project-dev-lead` — title: implement, labels: dev, feature
- `project-code-worker` — labels: worker, code-worker, size: small, type: subtask
- `project-docs-worker` — title: document, labels: docs, specification
- `project-security-worker` — title: security audit, labels: security

Each test: `installTemplatesAtProjectTier` → `classifyTask` → `resolveAgent` with assertions on agentId, role, tier, cantPath, cantSha256.

**Suite 2 — Universal-tier fallback**
- All 4 prior tiers miss → universal envelope synthesised (tier='universal', aliasApplied=true, aliasTarget='cleo-subagent', resolverWarning set)
- Spawn validator pre-flight: no AgentNotFoundError when universalBasePath reachable (ADR-068 Decision 6)
- E_AGENT_NOT_FOUND only when cleo-subagent.cant unreachable (catastrophic state contract)

**Suite 3 — Classifier IDs**
- `getRegisteredAgentIds()` static fallback returns all 5 canonical IDs
- `validateClassifierRules()` passes with no DB
- `validateClassifierRules(db)` passes with live DB after installTemplatesAtProjectTier

### variable-resolver-shadowing.test.ts (LOAD-BEARING)

Canonical resolver chain: step bindings ⊳ playbook bindings ⊳ session ⊳ project-context ⊳ env ⊳ default

**Suite 1 — Tier-by-tier shadowing**
- step shadows playbook for same key
- playbook shadows session for same key
- session shadows project-context for same key
- project-context shadows env for same key
- env shadows default for same key

**Suite 2 — Full chain cumulative**
- Step beats all when set; default surfaces only when nothing else set
- Tier-by-tier exhaustion (remove higher tiers, lower tier surfaces)

**Suite 3 — Multi-variable independence**
- Each variable resolves from its own highest tier (no cross-contamination)
- Step binding for one var does not bleed into other vars

**Suite 4 — CANT_ env prefix**
- CANT_ resolves when CLEO_ absent
- CLEO_ shadows CANT_ for same key

**Suite 5 — Dot-notation**
- Project-context dot-path walk works
- Bindings shadow project-context dot-paths

**Suite 6 — Recursion prevention**
- Resolved values never re-scanned ({{a}} → '{{b}}' stays literal)

**Suite 7 — substituteCantAgentBody integration**
- Bindings shadow project-context in CANT body substitution
- env resolves when no bindings set

## Quality Gates

- biome check: PASS (new files clean, pre-existing command-manifest.ts error unrelated)
- typecheck: PASS (tsc -b exit 0)
- build: PASS (full dep graph)
- tests: 30/30 PASS, 0 flakes across 3 sequential runs

## Key Findings

1. The variable resolver chain is: bindings > sessionContext > projectContext > env. Step-level bindings shadow playbook-level bindings via `Object.assign({}, playbookBindings, stepBindings)` — step keys win because they're applied last.
2. The universal-tier fallback correctly sets aliasApplied=true and aliasTarget='cleo-subagent' so callers can trace the actual persona received.
3. The 5-tier resolver degrades gracefully: project → global → packaged → fallback → universal. AgentNotFoundError is now genuinely exceptional (catastrophic state), not a routine resolution miss.
4. All 5 canonical template IDs are available in the static fallback vocabulary, so classifier validation passes even in CI environments without a live registry.
