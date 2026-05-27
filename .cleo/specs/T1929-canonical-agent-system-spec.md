# Spec: Canonical Agent System (T1929)

**Date**: 2026-05-05
**Status**: Active
**ADR**: ADR-068
**Epic**: T1929 (Agent System Canonicalization v2)
**Author**: T1930 RCASD lead

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Overview

### Scope

This spec governs Phase 1 of the Agent System Canonicalization epic (T1929). It covers:

- Naming convention for agent `.cant` files
- Canonical source-of-truth layout in `@cleocode/agents`
- Auto-registration behavior of `cleo init`
- Agent resolver tier order and fallback path
- Classifier registry contract
- Symmetric playbook tier resolver
- Mustache variable resolver order (step-level shadowing semantics)
- Migration walker contract for existing installs
- Acceptance criteria for implementation tasks T1931–T1941

### Out of Scope (Phase 2 — ADR-069 / T1942)

The following topics are explicitly deferred to Phase 2 and MUST NOT be implemented under T1929:

- Agent template inheritance (`extends:` field)
- Schema-validated agent returns (typed output contracts)
- Agent-initiated HITL gates
- Allowlist enforcement at dispatch boundaries
- Variable flow tracing / provenance

---

## 2. Naming Convention

### 2.1 Filename–Declaration Invariant

Every `.cant` agent file MUST satisfy the following invariant:

> `basename(filename, '.cant') === declaredAgentName`

where `declaredAgentName` is the value of the `agent <name>:` header line inside the file.

The install validator (`packages/core/src/store/agent-install.ts`) MUST enforce this invariant and MUST throw a typed error (`E_AGENT_NAME_MISMATCH`) if violated.

### 2.2 Worker Template Names

Worker templates MUST be named using the `project-<role>` prefix. The canonical set is:

| Filename | Declared name |
|----------|---------------|
| `project-orchestrator.cant` | `project-orchestrator` |
| `project-dev-lead.cant` | `project-dev-lead` |
| `project-code-worker.cant` | `project-code-worker` |
| `project-docs-worker.cant` | `project-docs-worker` |
| `project-security-worker.cant` | `project-security-worker` |

The `project-` prefix MUST NOT be stripped when classifying tasks or resolving agent IDs. The classifier emits `project-<role>`; the resolver looks for `project-<role>`; the template declares `project-<role>`.

### 2.3 Universal Protocol Base

The universal protocol base MUST be named `cleo-subagent` (filename: `cleo-subagent.cant`, declared: `agent cleo-subagent:`). It MUST NOT carry the `project-` prefix.

### 2.4 Meta-Agent Names

Meta-agents MUST use bare names without prefix:

| Filename | Declared name |
|----------|---------------|
| `agent-architect.cant` | `agent-architect` |
| `playbook-architect.cant` | `playbook-architect` |

### 2.5 CLEO-Specific Personas (ADR-055 D031 — HONORED)

CLEO-specific persona agents (e.g., `cleo-prime`, `cleo-historian`, `cleo-rust-lead`) MUST NOT ship in `@cleocode/agents`. They MUST reside at project tier under `.cleo/cant/agents/` in the consuming project.

---

## 3. Source-of-Truth Layout

### 3.1 Canonical Directory Structure

The `@cleocode/agents` package MUST maintain the following directory structure:

```
packages/agents/
  cleo-subagent.cant            # universal protocol base
  meta/
    agent-architect.cant
    playbook-architect.cant
  templates/
    project-orchestrator.cant
    project-dev-lead.cant
    project-code-worker.cant
    project-docs-worker.cant
    project-security-worker.cant
```

### 3.2 Directories to Delete

The following directories MUST be deleted as part of T1932:

- `packages/agents/seed-agents/` — all 12 files including 5 `-generic.cant` duplicates
- `packages/agents/starter-bundle/` — all 5 files (4 agent `.cant` files + `team.cant`)

No content from these directories MAY be preserved except by explicit migration into `templates/`.

### 3.3 Published Package Contents

The `packages/agents/package.json` `files` field MUST be updated to publish only:

- `cleo-subagent.cant`
- `meta/`
- `templates/`

### 3.4 Mustache Placeholders

Mustache `{{var}}` placeholders in worker templates MUST be preserved as-is. They MUST NOT be resolved at install time. Substitution occurs lazily at spawn time (ADR-055 D033 — HONORED).

---

## 4. Init Auto-Registration

### 4.1 Behavior of `cleo init` (No Flag)

When `cleo init` is invoked without `--install-seed-agents`, it MUST:

1. Walk the `@cleocode/agents/templates/` directory.
2. For each of the 5 worker template `.cant` files, call `installAgentFromCant(cantFilePath, { tier: 'project', projectRoot })`.
3. Register each template in `signaldock.db.agents` with `tier='project'`.
4. Atomically write both the `.cant` file to disk AND the DB row in a single `installAgentFromCant()` call.

After a successful `cleo init`, a call to `cleo orchestrate spawn` for any task whose classifier output matches one of the 5 worker roles MUST resolve without `E_AGENT_NOT_FOUND`.

### 4.2 Deprecated `--install-seed-agents` Flag

The `--install-seed-agents` flag MUST be preserved as a deprecated no-op alias. When passed, it MUST:

- Execute the same auto-registration logic as no-flag `cleo init` (§4.1).
- Log a deprecation notice to stderr: `"--install-seed-agents is deprecated and will be removed in the next major version. Standard agent templates are now registered automatically by cleo init."`.
- NOT be removed until the next major version.

### 4.3 Idempotency

The `installAgentFromCant()` call during init MUST be idempotent. If an agent with the same declared name is already registered at project tier, the installer MUST skip insertion and MUST NOT throw.

---

## 5. Resolver Behavior

### 5.1 Tier Order

`resolveAgent(agentId, options)` MUST attempt tiers in the following order:

1. **project** — `signaldock.db.agents WHERE tier='project'` for the current project root
2. **global** — `~/.local/share/cleo/agents/<agentId>.cant`
3. **packaged** — `@cleocode/agents/templates/<agentId>.cant` (after T1932: canonical path)
4. **fallback** — `<projectRoot>/.cleo/cant/agents/<agentId>.cant`
5. **universal** — synthesize envelope from `cleo-subagent.cant`

### 5.2 Fallback Tier Path

The packaged tier fallback MUST look for `templates/<agentId>.cant`, not `seed-agents/<agentId>.cant`. After T1932 renames the directory, the agent ID `project-docs-worker` MUST resolve to `templates/project-docs-worker.cant`.

### 5.3 Universal Tier in Spawn Validator Pre-Flight

The spawn validator MUST invoke `tryResolveAtTier('universal')` BEFORE emitting `E_AGENT_NOT_FOUND`. The universal tier MUST synthesize an agent envelope from `cleo-subagent.cant` populated with the task's `role` and `title` metadata.

`E_AGENT_NOT_FOUND` MUST only be thrown when `cleo-subagent.cant` itself is unreachable (catastrophic state). In normal operation, every spawn request resolves to at least the universal envelope.

### 5.4 Error Message Contract

When `E_AGENT_NOT_FOUND` is thrown (catastrophic only), the error MUST enumerate all 5 tried tier paths by location, mirroring the existing `AgentNotFoundError` format.

---

## 6. Classifier Contract

### 6.1 Source of Registered IDs

`getRegisteredAgentIds()` MUST source its agent ID set from `signaldock.db.agents WHERE tier='project'` for the current project, supplemented by the 5 canonical template names from `@cleocode/agents/templates/`. It MUST NOT maintain a hardcoded static list.

### 6.2 Validation Throw Contract (T1326 — HONORED)

On classifier initialization, `CLASSIFIER_RULES` MUST be validated against the set returned by `getRegisteredAgentIds()`. If any rule references an agent ID not in the registry, the classifier MUST throw `ClassifierUnregisteredAgentError` with the unregistered ID in the error payload. This contract is unchanged from T1326.

### 6.3 Classifier Output for Worker Roles

The classifier MUST continue to emit `project-<role>` IDs. After T1934 (auto-register) and T1932 (rename), these IDs will match registered template names exactly, eliminating the drift that caused the 2026-05-05 failure.

---

## 7. Playbook Tier Resolver

### 7.1 Function Contract

`resolvePlaybook(name: string, options?: { projectRoot?: string }): ResolvedPlaybook` MUST be implemented in `packages/core/src/playbooks/playbook-resolver.ts`. It MUST be symmetric to `resolveAgent()` in structure and error behavior.

### 7.2 Tier Order

| Tier | Location |
|------|----------|
| project | `<projectRoot>/.cleo/playbooks/<name>.cantbook` |
| global | `~/.local/share/cleo/playbooks/<name>.cantbook` |
| packaged | `@cleocode/playbooks/starter/<name>.cantbook` |

Resolution order MUST be project ⊳ global ⊳ packaged. Project tier MUST shadow global; global MUST shadow packaged.

### 7.3 File Extension

Playbook files MUST use the `.cantbook` extension. The resolver MUST NOT fall back to `.cant` for playbooks.

### 7.4 Empty Tier Behavior

An empty project or global tier MUST NOT cause failure. The resolver MUST fall through to the next tier silently.

### 7.5 Error Path

When no tier resolves the playbook, `resolvePlaybook()` MUST throw `PlaybookNotFoundError` listing all tried tier paths. The error MUST be a typed `CleoError` with an actionable fix hint.

---

## 8. Variable Resolver Order

### 8.1 Canonical Order (ADR-055 D033 EXTENDED)

The Mustache variable resolver MUST evaluate bindings in the following order, stopping at the first match for each key:

1. Step bindings (`bindings:` field on the current playbook step)
2. Playbook bindings (`bindings:` field at the playbook's top level)
3. Session context (active session metadata)
4. Project context (`.cleo/project-context.json`)
5. Environment variables (`process.env`)
6. Default values (declared in the agent template)

### 8.2 Step-Level Shadowing

A key present in step bindings MUST shadow the same key in playbook bindings for the duration of that step only. At the next step, playbook bindings MUST be restored as the base.

Example: if the playbook declares `{{ROLE}}=developer` and a step declares `{{ROLE}}=reviewer`, the resolved value during that step MUST be `reviewer`. The next step that does not override `{{ROLE}}` MUST resolve to `developer`.

### 8.3 Regression Test Requirement

T1940 MUST include an explicit test asserting step-level shadowing: a two-step playbook where step 1 overrides `{{ROLE}}` and step 2 does not, with assertions on the resolved value at each step.

---

## 9. Migration Contract

### 9.1 Walker Command

`cleo migrate agents-v2` MUST be implemented as a one-time, idempotent CLI command.

### 9.2 Walker Behavior

The migration walker MUST:

1. Walk `.cleo/cant/agents/` AND `.cleo/agents/` at the current project root.
2. For each `.cant` file found, parse the manifest to extract the declared agent name.
3. Attempt `installAgentFromCant(filePath, { tier: 'project', projectRoot })`.
4. If the agent name is already registered at project tier with identical content: skip and log `info`.
5. If the agent name is already registered with different content: log a warning to `.cleo/audit/migration-agents-v2.jsonl` and skip insertion (no overwrite).
6. Exit code 0 if all entries are either installed or harmlessly skipped. Non-zero only on actual errors.

### 9.3 Idempotency

Re-running `cleo migrate agents-v2` on an already-migrated project MUST produce no changes and MUST exit 0.

### 9.4 Conflict Reporting

`cleo doctor` MUST report any entries in `.cleo/audit/migration-agents-v2.jsonl` that were skipped due to name conflicts, with actionable guidance for manual resolution.

---

## 10. Acceptance Criteria

Each acceptance criterion below is expressed in RFC 2119 terms and references the implementing task. Implementation tasks MUST cause their stated criteria to pass before marking complete.

### T1931 — Starter-Bundle Caller Audit

1. The implementation MUST produce an inventory document listing every source-tree reference to `'starter-bundle'` across all packages in the monorepo.
2. The implementation MUST inventory all callers of the `resolveStarterBundle()` function by call site.
3. The implementation MUST inventory all references to `cleo-orchestrator.cant` and `team.cant` from the `starter-bundle/` directory.
4. For each caller, the implementation MUST classify it as either `'safe to migrate to templates/'` or `'requires refactor design'`.
5. The audit document MUST be attached to T1929.
6. No deletion of `starter-bundle/` or `seed-agents/` MAY proceed until this audit is complete and findings are reviewed.

### T1932 — Consolidate `@cleocode/agents` Source

1. The implementation MUST rename `packages/agents/seed-agents/` to `packages/agents/templates/`.
2. The implementation MUST rename each worker template file so that `basename(filename, '.cant')` equals the declared `agent <name>:` line for all 5 worker roles.
3. The implementation MUST delete all `*-generic.cant` files (5 files).
4. The implementation MUST delete `packages/agents/starter-bundle/` entirely.
5. All Mustache `{{vars}}` in templates MUST be preserved (D033).
6. `packages/agents/package.json` `files` field MUST be updated to publish only `cleo-subagent.cant`, `meta/`, and `templates/`.
7. All caller references identified in T1931 MUST be migrated.
8. `pnpm run build` MUST pass with no new errors.
9. `pnpm run test` MUST pass with zero new failures.

### T1933 — Resolver Fallback Path + Universal-Tier Pre-Flight

1. The implementation MUST update `packages/core/src/store/agent-resolver.ts:480-482` to look for `templates/<agentId>.cant` instead of `seed-agents/<agentId>.cant`.
2. `tryResolveAtTier('universal')` MUST be invoked by the spawn validator before `E_AGENT_NOT_FOUND` is thrown.
3. The universal tier MUST synthesize an agent envelope from `cleo-subagent.cant` when tiers 1–4 all miss.
4. `E_AGENT_NOT_FOUND` MUST only be thrown when `cleo-subagent.cant` itself is unreachable.
5. Unit tests MUST cover all 5 resolver tiers and the universal fallback path.
6. `pnpm biome check` and `pnpm run test` MUST pass.

### T1934 — `cleo init` Auto-Register Templates

1. The implementation MUST update `packages/core/src/init.ts` so plain `cleo init` (no flag) calls `installAgentFromCant()` for each of the 5 worker templates.
2. Each template MUST be registered in `signaldock.db.agents` with `tier='project'`.
3. `--install-seed-agents` MUST be preserved as a deprecated no-op alias with a deprecation log.
4. A fresh `cleo init` followed by `cleo orchestrate spawn` for a task with `role=docs` MUST succeed without `E_AGENT_NOT_FOUND`.
5. `pnpm run build` and `pnpm run test` MUST pass.

### T1935 — Rename `resolveStarterBundle.ts`

1. The implementation MUST rename `packages/core/src/agents/resolveStarterBundle.ts` to `resolveAgentTemplates.ts`.
2. The renamed function signature MUST be `resolveAgentTemplates(): { templatesDir: string; templates: Array<{ name: string; path: string }> }`.
3. All callers from the T1931 audit MUST be updated to import from the new path/name.
4. The old function name MUST be preserved as a deprecated re-export with `console.warn` for one major-version cycle.
5. `pnpm biome check` and `pnpm run test` MUST pass.

### T1936 — Classifier Registry Sync

1. The implementation MUST update `getRegisteredAgentIds()` in `packages/core/src/orchestration/classify.ts` to source its ID set from `signaldock.db.agents WHERE tier='project'` rather than a hardcoded list.
2. `CLASSIFIER_RULES` MUST be validated against the registered ID set on classifier initialization; `ClassifierUnregisteredAgentError` MUST be thrown on drift (T1326 contract preserved).
3. All 5 worker roles MUST be present in the registered set after a fresh `cleo init`.
4. A regression test MUST classify a docs task and verify the resolver returns the `project-docs-worker` template envelope.
5. `pnpm biome check` and `pnpm run test` MUST pass.

### T1937 — Playbook Tier Resolver

1. The implementation MUST create `packages/core/src/playbooks/playbook-resolver.ts` with `resolvePlaybook(name, options?)`.
2. The resolver MUST try tiers in order: project ⊳ global ⊳ packaged.
3. `cleo playbook run <name>` MUST use the resolver to find playbooks.
4. `cleo playbook list --tier all` MUST show resolved playbooks with tier provenance.
5. The three packaged starter playbooks (rcasd, ivtr, release) MUST be discoverable via the packaged tier.
6. `PlaybookNotFoundError` MUST enumerate all tried tier paths.
7. Unit tests MUST cover all tier combinations, override behavior, and the error path.
8. `pnpm biome check` and `pnpm run test` MUST pass.

### T1938 — Migration Walker

1. The implementation MUST provide `cleo migrate agents-v2` as a CLI command.
2. The walker MUST scan `.cleo/cant/agents/` and `.cleo/agents/` and call `installAgentFromCant()` for each `.cant` file found.
3. Already-registered agents MUST be skipped with an `info` log.
4. Name conflicts (same name, different content) MUST be logged to `.cleo/audit/migration-agents-v2.jsonl` and skipped.
5. Re-running the command on an already-migrated project MUST produce no changes and exit 0.
6. `cleo doctor` MUST surface unresolved conflicts from the audit log.

### T1939 — CAAMP Injection-Chain Dedup

1. The CAAMP injection writer MUST be made idempotent: scanning `AGENTS.md` for existing `<!-- CAAMP:START -->...<!-- CAAMP:END -->` blocks before appending.
2. A block with a matching `@path` MUST be replaced in-place, not appended as a duplicate.
3. A cleanup pass MUST deduplicate any existing accumulated duplicate blocks by `@path`, keeping the most recent.
4. A test fixture MUST simulate 5 sequential CAAMP injection runs and verify the final `AGENTS.md` has no duplicate `<!-- CAAMP:START -->` blocks.
5. `pnpm biome check` and `pnpm run test` MUST pass.

### T1940 — Pipeline Regression Test Suite

1. An end-to-end test MUST: run `cleo init` in a clean directory → verify all 5 templates registered → classifier emits `project-<role>` → resolver finds at project tier → spawn validator pre-flight passes → envelope returned.
2. Tests MUST cover each of the 5 worker roles individually.
3. A test MUST verify the universal-tier fallback: simulate all-tier miss → `cleo-subagent.cant` synthesized envelope returned.
4. Tests MUST cover each playbook resolver tier (project/global/packaged), tier override behavior, and `PlaybookNotFoundError` on miss.
5. A test MUST explicitly assert step-level variable shadowing: step 1 overrides `{{KEY}}`, step 2 does not; resolver returns the step-level value in step 1 and the playbook-level value in step 2.
6. A test MUST cover the migration walker with a pre-populated `.cleo/cant/agents/` directory containing mixed canonical and non-canonical names.
7. `pnpm biome check` MUST pass and `pnpm run test` MUST pass with zero new failures and zero flakes across 3 sequential CI runs.

### T1941 — Release v2026.5.30

1. All 17 packages (including `@cleocode/agents`) MUST be bumped to v2026.5.30.
2. CHANGELOG MUST include an entry documenting Phase 1 of agent + playbook canonicalization and citing the supersession of ADR-055 D032/D035 by ADR-068.
3. All 11 child tasks of T1929 (T1931–T1941) MUST be verified done with programmatic evidence (commit + tests + biome + typecheck per ADR-051) before release.
4. GitHub Actions `release.yml` MUST be green for all 17 packages.
5. `npm latest @cleocode/cleo` MUST reflect v2026.5.30.
6. `cleo --version` (global install) MUST reflect 2026.5.30.
7. `cleo orchestrate spawn T1820` (the original blocker) MUST succeed end-to-end.

---

## 11. Out of Scope

The following items are explicitly out of scope for T1929 and MUST NOT be implemented under this epic:

- **Agent template inheritance** (`extends:` field) — ADR-069 / T1942
- **Schema-validated agent returns** — ADR-069 / T1942
- **Agent-initiated HITL gates** — ADR-069 / T1942
- **Allowlist enforcement at dispatch boundaries** — ADR-069 / T1942
- **Variable flow tracing / provenance logging** — ADR-069 / T1942
- **`@cleocode/project-context` standalone library extraction** — deferred per ADR-067 consequences
