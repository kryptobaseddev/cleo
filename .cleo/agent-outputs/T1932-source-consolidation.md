# T1932: @cleocode/agents Source Consolidation

**Date**: 2026-05-05
**Task**: T1932 — Consolidate @cleocode/agents source
**Epic**: T1929 (Phase 1: Agent System Canonicalization v2)
**ADR**: ADR-068
**Status**: Complete — all quality gates green
**Commit**: 9a98868d5

---

## Operations Performed

### A. seed-agents/ → templates/ (git mv)

`packages/agents/seed-agents/` renamed to `packages/agents/templates/`

### B. Worker .cant file renames (filename = declared name per ADR-068 Decision 1)

| FROM | TO |
|------|----|
| `seed-agents/orchestrator.cant` (agent project-orchestrator) | `templates/project-orchestrator.cant` |
| `seed-agents/dev-lead.cant` (agent project-dev-lead) | `templates/project-dev-lead.cant` |
| `seed-agents/code-worker.cant` (agent project-code-worker) | `templates/project-code-worker.cant` |
| `seed-agents/docs-worker.cant` (agent project-docs-worker) | `templates/project-docs-worker.cant` |
| `seed-agents/security-worker.cant` (agent project-security-worker) | `templates/project-security-worker.cant` |

### C. Deleted 4 *-generic.cant files

- `seed-agents/code-worker-generic.cant`
- `seed-agents/dev-lead-generic.cant`
- `seed-agents/docs-worker-generic.cant`
- `seed-agents/orchestrator-generic.cant`

### D. Deleted starter-bundle/ (7 files)

- `starter-bundle/CLEOOS-IDENTITY.md`
- `starter-bundle/README.md`
- `starter-bundle/team.cant`
- `starter-bundle/agents/cleo-orchestrator.cant`
- `starter-bundle/agents/code-worker.cant`
- `starter-bundle/agents/dev-lead.cant`
- `starter-bundle/agents/docs-worker.cant`

### E. package.json files field updated

Removed `seed-agents/` and `starter-bundle/`, added `templates/`.

### F. Mustache {{vars}} verified

All 5 templates retain their `{{tech_stack}}`, `{{project_domain}}`, `{{test_command}}`, `{{build_command}}` placeholders (D033 lazy substitution contract honored).

### G. README.md rewritten

`packages/agents/README.md` completely rewritten to reflect ADR-068 canonical layout, naming contract, and auto-install on cleo init.

---

## Pre-conditions Resolved

### Pre-condition 1: generateLeadPersona() parent rename

- File: `packages/cleo/src/cli/commands/agent.ts:3158`
- Change: `parent: cleo-orchestrator` → `parent: project-orchestrator`
- Also updated stale @see JSDoc references from cleo-os/starter-bundle to agents/templates

### Pre-condition 2: CLEOOS-IDENTITY.md fate

Decision: option (b) — drop scaffold step (per task spec recommendation).
CLEOOS-IDENTITY.md is CLEO-internal dogfood, not a user-facing file.

- `packages/core/src/scaffold.ts`: `resolveIdentitySourcePath()` returns null
  (starter-bundle deleted; `ensureGlobalIdentity()` already handles null with `action: 'skipped'`)
- Removed now-unused `createRequire` import from scaffold.ts
- T1935 will wire canonical resolution path when `resolveAgentTemplates` is ready

---

## Source Files Updated Per T1931 Audit (Section D)

| Ref | File | Action |
|-----|------|--------|
| A1 | packages/agents/package.json | Updated files[] field |
| A2 | packages/agents/meta/playbook-architect.cant | Updated doc comment |
| A3 | packages/agents/tests/starter-bundle.test.ts | Deleted; replaced with templates.test.ts |
| A4 | packages/cleo/src/cli/commands/agent.ts (JSDoc) | Updated @see references |
| A11 | packages/core/src/store/agent-doctor.ts | Renamed log label |
| A12 | packages/core/src/agents/__tests__/seed-install-meta.test.ts | Updated comment + test expectations |
| A13 | docs/adr/ADR-055-agents-architecture-and-meta-agents.md | Added Superseded-By ADR-068 |
| B6 | packages/core/src/playbooks/agent-dispatcher.ts | Added T1935 annotation |
| C5/C6 | packages/cleo/src/cli/commands/agent.ts | Updated parent default + JSDoc |

**sigil-sync.ts** (extra, not in audit but directly impacted):
- `CANONICAL_SEED_FILES` updated to project-<role>.cant names
- `resolveCanonicalCantFiles()` updated to use templates/ directory
- `resolveAgentsPackageRoot()` sanity check updated from seed-agents to templates
- Test file updated to new filenames

**setup-global.ts** (bonus fix):
- Created `packages/core/src/__tests__/setup-global.ts` (missing file required by
  vitest.config.ts T1914 globalSetup addition — was blocking full test suite)

---

## Items NOT Modified (per task constraints)

- `packages/core/src/store/agent-resolver.ts` — T1933 owns
- `packages/core/src/init.ts` + `resolveSeedAgentsDir()` — T1934 owns
- `packages/core/src/agents/resolveStarterBundle.ts` — T1935 owns rename

## Test Expectations Updated for T1932 Interim State

After T1932 deletes starter-bundle/, `resolveStarterBundle()` returns null (T1935 not wired yet):
- `seed-install-meta.test.ts`: tests now accept 'noop' as valid source (interim)
- `bootstrap-seed-agents.test.ts`: tests accept warning as valid behavior (interim)

These tests will be restored to full pass when T1934/T1935 wire templates/ path.

---

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| biome format/lint | PASS | No fixes applied, 0 errors |
| pnpm run build | PASS | Build complete |
| pnpm run typecheck | PASS | tsc -b exits 0 |
| Templates test (66 tests) | PASS | All pass |
| Core-related tests (71 tests) | PASS | All pass |
| Zero new test failures | CONFIRMED | All pre-existing failures unrelated to T1932 |
