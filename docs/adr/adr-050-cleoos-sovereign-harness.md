# ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter

**Status**: PROPOSED
**Date**: 2026-04-15
**Task**: T640
**Parent Epic**: T636 (Canon Finalization + Orphan Triage + Harness Sovereignty — plan precious-cooking-moonbeam)
**Relates to**: D007 (owner decision 2026-04-13), ADR-035 (Pi harness lock), ADR-047 (autonomous GC + disk safety)

---

## Context

CleoOS today is a thin launcher: four files (`cli.ts`, `keystore.ts`, `postinstall.ts`, `xdg.ts`)
wrapping Pi's `main()` with extension path injection. There is zero differentiation from a vanilla
Pi installation beyond the extension mechanism.

Owner decision **D007** (2026-04-13) is unambiguous:

> *"CleoOS must be a flagship fully custom-built system, not vanilla Pi with a rename.
> 100% working, owner controls the code and harness."*

At the same time, ADR-035 locks Pi as the upstream coding agent harness. These two positions are
compatible: **Pi is infrastructure; CleoOS is the distribution built on top of it.**

This ADR establishes CleoOS's charter as a **distribution binding** and defines the minimum
differentiation surface that gives CleoOS a distinct identity without prematurely forking Pi or
rebuilding capabilities that Pi already ships.

---

## Decisions

### Decision 1: CleoOS Is a Distribution Binding, Not a Pi Fork

Pi (`@mariozechner/pi-coding-agent`) is an upstream dependency. CleoOS:

- CONSUMES Pi via the `main()` entry point (ADR-035 preserved)
- EXTENDS Pi via the `--extension` injection mechanism (ADR-035 preserved)
- Does NOT fork, patch, or shadow Pi internals

The correct mental model: CleoOS is to Pi what Ubuntu is to Linux — a distribution with an
opinionated configuration layer, not a competing kernel. Agents, policies, and orchestration
live in CleoOS. The coding loop lives in Pi.

### Decision 2: Minimum Differentiation Is Three Modules

The minimum differentiation surface that gives CleoOS a distinct identity consists of exactly
three modules, all new and all in `packages/cleo-os/src/`:

| Module | Path | Purpose |
|--------|------|---------|
| `agent-registry` | `registry/agent-registry.ts` | Catalogs installed agents across all 9 provider adapters |
| `memory-policy` | `policies/memory-policy.ts` | Governs what gets stored in `brain.db` (no chat logs) |
| `provider-matrix` | `registry/provider-matrix.ts` | Read-only health view of the 9 provider adapters |

These modules do not replace any existing `packages/adapters/` functionality. They read from the
adapter layer; they do not implement it.

### Decision 3: Scope Hardening

Anything beyond these three modules is a follow-up epic. This ADR fixes CleoOS's charter so
that no single task inflates scope by adding CLI commands, TUI panels, or lifecycle hooks that
belong to a separate design phase.

**Deferred explicitly** (not in scope for T640 or this ADR's merge):

- `cleo-os doctor` CLI subcommand
- CleoOS TUI integration for agent-registry or provider-matrix
- Full agent-lifecycle hooks (spawn tracking, session affinity)
- Seed agent population (directories created; files added under follow-up epic)
- Per-provider capability scoring beyond `spawnImplemented` + `hookSupport`

### Decision 4: CleoOS CONSUMES Adapters; It Does Not Implement Them

Provider adapter code stays in `packages/adapters/src/providers/`. CleoOS reads adapter
filesystem artifacts (the presence of `spawn.ts`, `hooks.ts`, agent directories) to build
its views. It does not duplicate adapter logic or depend on adapter internals beyond the
`CLEOProviderAdapter` contract from `packages/contracts/`.

### Decision 5: Relationship Between `@cleocode/cleo` and `@cleocode/cleo-os`

| Package | Role |
|---------|------|
| `@cleocode/cleo` | Canonical CLEO CLI — task management, BRAIN, NEXUS, CANT, CONDUIT |
| `@cleocode/cleo-os` | Opinionated distribution — Pi harness + agent catalog + memory policy + provider matrix |

Users MAY install one or both. `cleo-os` depends on `cleo` as a peer/bundled dependency.
`cleo` has no dependency on `cleo-os`. The dependency arrow is one-directional.

---

## Consequences

**Positive**:

- CleoOS acquires a distinct identity with three concrete modules that no other Pi launcher ships
- Memory policy makes D008 / owner learning `L-fe4ba2dc` machine-enforceable: chat logs are
  categorically excluded from `brain.db` writes at the distribution layer
- `ProviderMatrix` provides a first-class inventory of adapter health without requiring a full
  `cleo doctor` run — useful for orchestrators that need to know which providers are ready
- Scope hardening prevents creep: this ADR is the budget ceiling for T640

**Negative / trade-offs**:

- Three skeleton classes with no CLI surface are not user-visible yet; the value is realized
  when TUI integration (deferred) wires them in
- `AgentRegistry.loadUserAgents()` hard-codes the 9 provider agent folder paths; if a provider
  moves its agent directory, the registry requires a patch. Mitigation: the long-term fix is
  to call `adapter.paths?.getAgentInstallDir()` dynamically once T639's provider-folder
  exposure lands

**Rollback path**:

This ADR adds three new files and one new directory. Rolling back is `git rm` on those four
paths. No schema changes. No database writes. No impact on existing `@cleocode/cleo` or
`@cleocode/adapters` packages.

---

## Deferred Items (follow-up epic under T636)

| Item | Notes |
|------|-------|
| `cleo-os doctor` CLI command | Wraps `ProviderMatrix.getMatrix()` into human-readable output |
| CleoOS TUI integration | Agent registry panel + provider matrix panel in Pi extension |
| Full agent-lifecycle hooks | Spawn tracking, session affinity, memory-gated observation writes |
| Seed agent population | `seed-agents/` directory exists; files added when first seed agent is designed |
| Dynamic path resolution | Wire `adapter.paths?.getAgentInstallDir()` once T639 exposes it |

---

## Related Work

- D007 — Owner mandate: CleoOS must be purpose-built, not a rename
- ADR-035 — Pi locked as primary harness; CleoOS extends via `--extension`
- ADR-047 — Autonomous GC + disk safety (adjacent harness hardening)
- ADR-044 — Canon reconciliation (6 systems, 11 domains)
- T636 (parent epic) — Canon Finalization + Orphan Triage + Harness Sovereignty
- T639 — Provider folder exposure (prerequisite for dynamic path resolution — deferred)
- T640 (this task) — Three-module skeleton + this ADR

## References

- `packages/cleo-os/src/registry/agent-registry.ts` — agent catalog implementation
- `packages/cleo-os/src/policies/memory-policy.ts` — memory gate implementation
- `packages/cleo-os/src/registry/provider-matrix.ts` — adapter health view
- `packages/contracts/src/adapter.ts` — `CLEOProviderAdapter` interface (adapter class name)
- `~/.claude/projects/-mnt-projects-cleocode/memory/MEMORY.md` — D007, D008, L-fe4ba2dc
