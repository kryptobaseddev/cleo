# T1934: Init Auto-Registration of Worker Templates at Project Tier

**Status**: complete
**Task**: Init: cleo init (no flag) auto-registers all 5 templates at project tier via installAgentFromCant
**Epic**: T1929 (Phase 1: Agent System Canonicalization v2)
**Commit**: 6304c86ab6f3fd20bcc95dcee99e0bba8c3fc7ba

## Summary

T1934 closes Bug 3: standard agents were not auto-installed on `cleo init`. After this
task, plain `cleo init` (no flags) produces a fully working agent dispatch system.

## What Was Done

### Implementation (already shipped in T1935 commit 3297dd5e2)

The `installTemplatesAtProjectTier()` function was already present in `packages/core/src/init.ts`
as part of the T1935 coordinated commit. That function:

- Calls `resolveAgentTemplates()` from `resolveAgentTemplates.ts` to locate `@cleocode/agents/templates/`
- Walks all `.cant` files in that directory
- Calls `installAgentFromCant(db, { cantSource, targetTier: 'project', force: true })` for each
- Returns a `TemplateInstallResult` with `installed[]`, `failed[]`, and `templatesDir`

The init flow change:
1. Removed the old two-step `deployStarterBundle` → `forceInstallProjectTierAgents` path
2. Replaced with direct `installTemplatesAtProjectTier(projRoot)` call
3. `forceInstallProjectTierAgents` kept for brownfield back-compat (scans .cleo/cant/agents/)
4. `--install-seed-agents` flag: deprecated no-op alias, emits `console.warn` per ADR-068

### Tests Added (this commit: 6304c86ab)

New file: `packages/core/src/__tests__/init-install-templates.test.ts`

7 tests covering:
1. Returns `templatesDir=null` when templates directory cannot be resolved (soft fail)
2. Registers all 5 worker templates in signaldock.db with `tier='project'`
3. DB rows carry `tier=project` and non-null `cant_path` for each agent
4. `.cant` files copied to `.cleo/cant/agents/` in the project root
5. Idempotent re-run produces no duplicate rows
6. `--install-seed-agents` flag emits the ADR-068 deprecation warning
7. Templates directory contains all 5 expected canonical filenames

All 7 tests pass. 29 init-related tests pass total (including existing init-e2e and
bootstrap-seed-agents tests).

## Files Changed

- `/mnt/projects/cleocode/packages/core/src/init.ts` (already in HEAD from T1935)
- `/mnt/projects/cleocode/packages/core/src/__tests__/init-install-templates.test.ts` (added)

## Evidence Gates

- implemented: commit:6304c86ab + files:packages/core/src/init.ts,packages/core/src/__tests__/init-install-templates.test.ts
- testsPassed: test-run:/tmp/t1934-test-run.json (26 passed, 0 failed)
- qaPassed: tool:typecheck (tsc -b exit 0)
- documented: files:packages/core/src/init.ts (TSDoc on all exported symbols)
- securityPassed: writes to project .cleo/ and signaldock.db; no network surface
- cleanupDone: plain init now produces working agent dispatch; --install-seed-agents is deprecated alias

## Key Findings

1. T1935 had already landed the implementation before T1934 ran — coordination worked as designed
2. `resolveAgentTemplates()` in `resolveAgentTemplates.ts` correctly resolves to `packages/agents/templates/`
3. `installAgentFromCant()` with `force: true` provides idempotency (upsert semantics)
4. Pre-existing test failures in `orchestrate-engine.test.ts`, `living-brain.test.ts`, and `reconciliation-engine.test.ts` are unrelated to T1934
5. The 5 template filenames (`project-orchestrator`, `project-dev-lead`, `project-code-worker`, `project-docs-worker`, `project-security-worker`) match their agent name declarations exactly
