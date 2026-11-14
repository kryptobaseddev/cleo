# ADR-068: Canonical Agent System — Single Layout, Auto-Install, Symmetric Playbook Tiers, and Universal-Tier Pre-Flight

**Date**: 2026-05-05
**Status**: Accepted
**Accepted**: 2026-05-05
**Related Tasks**: T1929, T1930, T1931, T1932, T1933, T1934, T1935, T1936, T1937, T1938, T1939, T1940, T1941
**Related ADRs**: ADR-055 (D031–D035), ADR-067
**Keywords**: agent-resolver, cleo-init, classifier, seed-agents, templates, starter-bundle, playbook-resolver, universal-tier, variable-shadowing, naming-convention
**Topics**: agent-system, orchestration, canonicalization, playbook-tier, init, migration
**Supersedes**: ADR-055 D032, ADR-055 D035

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### CLEO as a Distributed Operating System for Agents

CLEO is a Distributed Operating System for Agents. The Playbook is the kernel; Agents are processes. Like an OS manages compute resources — scheduling, dispatch, identity, isolation — CLEO manages agents as managed compute resources, not chatbots. Enterprise-grade autonomous development requires that agents behave as deterministic, contract-bound, governed processes. The resolver chain is the process loader. The classifier is the scheduler. The `cleo init` command is the OS bootstrap.

This framing is not metaphorical. It is the architectural constraint from which every decision in this ADR follows.

### The 2026-05-05 Spawn Failure

On 2026-05-05, the orchestrator attempted `cleo orchestrate spawn T1820` to start Wave 3 of T1042. It failed with:

```
E_AGENT_NOT_FOUND: agent 'project-docs-worker' not found in any tier
(project, global, packaged, fallback, universal)
```

Investigation revealed five misaligned subsystems and six root-cause bugs that had been latent since the partial T1258 cleanup.

### Five Misaligned Subsystems

**Subsystem 1 — Classifier** (`packages/core/src/orchestration/classify.ts:162-187`): hardcodes `project-<role>` prefix in `CLASSIFIER_RULES` per ADR-055 D032. Emits IDs: `project-docs-worker`, `project-code-worker`, `project-dev-lead`, `project-orchestrator`, `project-security-worker`. These names are correct and MUST be preserved.

**Subsystem 2 — Resolver fallback tier** (`packages/core/src/store/agent-resolver.ts:480-482`): looks for `seed-agents/<agentId>.cant`, e.g., `seed-agents/project-docs-worker.cant`. Actual files are named `seed-agents/docs-worker.cant` — the `project-` prefix is absent from filenames. Always misses.

**Subsystem 3 — Install validator** (`packages/core/src/store/agent-install.ts:313-320`): enforces the invariant that a declared agent name MUST equal the filename basename. Templates declare `project-docs-worker` in a file named `docs-worker.cant`. This contradiction makes installation via the standard pipeline impossible.

**Subsystem 4 — `cleo init --install-seed-agents`** (`packages/core/src/init.ts:1033-1044`): only `copyFile`s `.cant` files to disk. Never calls `installAgentFromCant()`. Files appear on disk but `signaldock.db.agents` rows are never written. The resolver's tier 1 (project DB) finds nothing.

**Subsystem 5 — Plain `cleo init`** (no flag): does not seed agents at all. The invariant "standard agents install with CLEO Core" was never wired.

### Six Root-Cause Bugs

| # | Bug | Symptom |
|---|-----|---------|
| 1 | `-generic` suffix copies not removed | `@cleocode/agents/seed-agents/*-generic.cant` still ships in v2026.5.29 (T1258 cleanup incomplete) |
| 2 | Two parallel naming layouts coexist | `seed-agents/` (declares `project-X`) AND `starter-bundle/` (declares bare `X`) — name collisions in resolver |
| 3 | Standard agents do NOT auto-install on `cleo init` | Even with `--install-seed-agents`, no DB rows are written |
| 4 | Install validator vs file convention contradict | `docs-worker.cant` declares `project-docs-worker` → validator rejects on install |
| 5 | Resolver fallback path mismatch | Classifier emits `project-docs-worker`; resolver looks for `seed-agents/project-docs-worker.cant`; file is `docs-worker.cant` |
| 6 | Universal tier (ADR-055 D035) not wired into spawn validator pre-flight | `tryResolveAtTier('universal')` exists in `resolveAgent()` but the spawn validator runs BEFORE the cascade fires |

### Prior Decisions This ADR Evaluates

- **ADR-055 D031**: CLEO-specific personas MUST NOT ship in `@cleocode/agents`; they live at project tier in `.cleo/cant/agents/`. **HONORED — unchanged.**
- **ADR-055 D032**: Package ships universal protocol base + 4 generic templates + meta-agents. **SUPERSEDED** by this ADR: single `templates/` directory with 5 named worker templates.
- **ADR-055 D033**: Mustache `{{var}}` substitution lazy at spawn-time; resolver chain: bindings → session → project-context → env → default. **HONORED and EXTENDED** with explicit step-shadows-playbook semantics (see Decision 5).
- **ADR-055 D034**: Meta-agent concept (`agent-architect`). **HONORED — unchanged.**
- **ADR-055 D035**: Resolver universal tier as fail-closed safety net. **SUPERSEDED** by this ADR: universal tier is now wired into the spawn validator pre-flight, not only the resolver cascade (see Decision 6).
- **T1326**: Classifier output validated against `getRegisteredAgentIds()` — drift catches `ClassifierUnregisteredAgentError`. **HONORED and EXTENDED** to source IDs from the installed `templates/` registry.

---

## Decision

### 1. Agent Naming: Filename Basename MUST Equal Declared Name

The filename basename of every `.cant` agent file MUST equal the `agent <name>:` declaration inside it. This is the canonical contract enforced by the install validator.

- Worker templates MUST use the `project-<role>` prefix to match classifier output.
- The universal protocol base is named `cleo-subagent` (no prefix).
- Meta-agents use bare names: `agent-architect`, `playbook-architect`.

This decision resolves Bug 4 (install validator contradiction) and Bug 5 (resolver fallback path mismatch) by making the naming surface consistent at every layer.

### 2. Single Canonical Layout in `@cleocode/agents`

The two parallel layouts (`seed-agents/` and `starter-bundle/`) MUST be collapsed into one:

```
packages/agents/
  cleo-subagent.cant              # universal protocol base
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

The `seed-agents/` directory (12 files including the 5 `-generic.cant` duplicates) MUST be deleted. The `starter-bundle/` directory (5 files: 4 agents + `team.cant`) MUST be deleted. Only `templates/` remains as the canonical source of worker templates.

This decision resolves Bug 1 (`-generic` suffix copies) and Bug 2 (dual layout) and is implemented by T1932.

### 3. `cleo init` (No Flag) MUST Auto-Register All 5 Templates

Plain `cleo init` MUST walk `@cleocode/agents/templates/` and call `installAgentFromCant()` for each of the 5 worker templates. Each template MUST be registered in `signaldock.db.agents` with `tier='project'`.

The `--install-seed-agents` flag MUST be preserved as a deprecated no-op alias that logs a deprecation notice. It MUST NOT be removed until the next major version.

The old `copyFile`-only path MUST be replaced by `installAgentFromCant()`, which atomically writes both the `.cant` file to disk AND the DB row in a single operation. A fresh `cleo init` followed by `cleo orchestrate spawn` for any of the 5 worker roles MUST succeed without `E_AGENT_NOT_FOUND`.

This decision resolves Bug 3 (no auto-install) and Bug 4 (validator contradiction) and is implemented by T1934.

### 4. Symmetric Playbook Tier Resolver

A `resolvePlaybook(name, options)` function MUST be implemented in `packages/core/src/playbooks/playbook-resolver.ts`, parallel to `resolveAgent()`. The tier order MUST be:

| Tier | Location |
|------|----------|
| project | `<projectRoot>/.cleo/playbooks/<name>.cantbook` |
| global | `~/.local/share/cleo/playbooks/<name>.cantbook` |
| packaged | `@cleocode/playbooks/starter/<name>.cantbook` |

Resolution order: project ⊳ global ⊳ packaged. Project tier MUST shadow global; global MUST shadow packaged.

Empty higher tiers MUST NOT cause failure — the resolver falls through to the next tier. A `PlaybookNotFoundError` MUST enumerate all tried tier paths in its message, mirroring `AgentNotFoundError`.

This decision is implemented by T1937.

### 5. Variable Resolver Canonical Order: Step Bindings Shadow Playbook Bindings

The Mustache variable resolver MUST evaluate bindings in the following order, stopping at the first match:

1. Step bindings (from the current playbook step's `bindings:` field)
2. Playbook bindings (from the playbook's top-level `bindings:` field)
3. Session context (active session metadata)
4. Project context (`.cleo/project-context.json`)
5. Environment variables (`process.env`)
6. Default values (declared in the agent template)

A key present in step bindings MUST shadow the same key in playbook bindings. This is what makes step-level overrides feel seamless: a step that sets `{{ROLE}}=reviewer` suppresses the playbook-level `{{ROLE}}=developer` for that step only. This behavior MUST be explicit, documented, and regression-tested in T1940.

This decision extends ADR-055 D033 (lazy substitution at spawn-time) with explicit shadowing semantics. D033 is otherwise unchanged.

### 6. Universal Tier Wired into Spawn Validator Pre-Flight

The spawn validator MUST invoke `tryResolveAtTier('universal')` before emitting `E_AGENT_NOT_FOUND`. The universal tier synthesizes an envelope from `cleo-subagent.cant` when all 4 named tiers (project, global, packaged, fallback) miss.

`E_AGENT_NOT_FOUND` MUST only be thrown when `cleo-subagent.cant` itself is unreachable — a genuinely catastrophic state indicating a corrupt or incomplete CLEO installation.

This decision supersedes ADR-055 D035, which placed the universal tier only in the resolver cascade (after the spawn validator had already run). It is implemented by T1933.

---

## Consequences

### What Changes

- **Single layout**: `seed-agents/` and `starter-bundle/` deleted; `templates/` is the only source of worker templates.
- **Auto-install on init**: `cleo init` (no flag) registers all 5 worker templates in `signaldock.db.agents` at project tier.
- **Resolver fallback path**: updated from `seed-agents/<id>.cant` to `templates/<id>.cant`, matching classifier output exactly.
- **Spawn validator pre-flight**: universal tier invoked before `E_AGENT_NOT_FOUND` is thrown.
- **Playbook resolution**: symmetric `resolvePlaybook()` with project ⊳ global ⊳ packaged tier order.
- **Variable shadowing**: step bindings explicitly shadow playbook bindings; formalized in spec and regression-tested.
- **`resolveStarterBundle.ts`**: renamed to `resolveAgentTemplates.ts`; old name kept as deprecated re-export (T1935).

### What Stays the Same

- **ADR-055 D031**: CLEO-specific personas never ship in `@cleocode/agents`. Unchanged.
- **ADR-055 D033**: Mustache `{{var}}` substitution lazy at spawn-time. Unchanged; step-shadows-playbook is an additive clarification.
- **ADR-055 D034**: Meta-agents (`agent-architect`, `playbook-architect`). Unchanged.
- **T1326 classifier contract**: `getRegisteredAgentIds()` validation against classifier rules. Extended to source from the installed `templates/` registry rather than a hardcoded list, but the throw contract (`ClassifierUnregisteredAgentError`) is unchanged.
- **Install validator invariant**: filename basename MUST equal declared name. This invariant is preserved; the filenames are now corrected to satisfy it.

### Migration Impact

- **T1938 migration walker** (`cleo migrate agents-v2`): scans `.cleo/cant/agents/` and `.cleo/agents/` on existing project installs. For each `.cant` file found, calls `installAgentFromCant()` with `tier='project'`. Skips already-registered agents. Logs name conflicts to `.cleo/audit/migration-agents-v2.jsonl`. Idempotent.
- **`--install-seed-agents` flag**: preserved as a deprecated no-op alias for one major-version cycle.
- **`resolveStarterBundle` function**: preserved as a deprecated re-export with `console.warn` for one major-version cycle.

### Forward-Looking (Phase 2 — ADR-069 / T1942)

Phase 2 will address governed-execution unification: schema-validated agent returns, allowlist enforcement at dispatch boundaries, inheritance (`extends:`) for agent templates, and agent-initiated HITL gates. These are explicitly out of scope for this ADR. When agents are treated as governed processes with typed contracts at every boundary, static orchestration becomes self-healing orchestration: meta-agents wired into iteration-cap feedback loops can detect failure modes and re-plan without human intervention.

---

## Supersedes

- **ADR-055 D032**: Package layout decision (generic templates + seed-agents/ directory). Superseded by Decision 2 (single `templates/` directory, named worker templates with `project-<role>` prefix).
- **ADR-055 D035**: Universal tier as resolver-cascade-only safety net. Superseded by Decision 6 (universal tier moved into spawn validator pre-flight).

## Cross-References

- **ADR-067**: Project Root Resolution. This ADR's init auto-registration (Decision 3) relies on the `assertProjectInitialized()` guard from ADR-067 §Decision 2.
- **ADR-069** (T1942 — not yet written): Governed Execution Unification — Phase 2 extension of this canonical agent system with contract boundaries, schema validation, and inheritance.

---

## Related Tasks

| Wave | Task | Title |
|------|------|-------|
| 1 | T1930 | RCASD: ADR-068 + spec (this task) |
| 2 | T1931 | Audit all callers of starter-bundle, resolveStarterBundle, cleo-orchestrator.cant, team.cant |
| 2 | T1937 | Playbook tier resolver |
| 2 | T1939 | CAAMP injection-chain dedup |
| 3 | T1932 | Consolidate `@cleocode/agents` source (rename seed-agents/→templates/) |
| 4 | T1933 | Resolver fallback path + universal-tier pre-flight |
| 4 | T1934 | `cleo init` auto-register templates |
| 4 | T1935 | Rename `resolveStarterBundle.ts` → `resolveAgentTemplates.ts` |
| 5 | T1936 | Classifier registry sync to templates/ |
| 5 | T1938 | Migration walker for existing installs |
| 6 | T1940 | Pipeline regression test suite |
| 7 | T1941 | Release v2026.5.30 |
