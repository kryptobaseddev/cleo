# ADR-049 — Harness Sovereignty: CLEO-Owned Memory + Per-Provider Agent Folder Abstraction

**Status**: PROPOSED
**Date**: 2026-04-15
**Task**: T639
**Parent Epic**: T636 (Canon Finalization + Orphan Triage + Harness Sovereignty — plan precious-cooking-moonbeam)
**Supersedes**: ADR-035 harness-boundary claims only (NOT the entire ADR — scope, session, model, and exclusivity decisions in ADR-035 remain in effect)
**Relates to**: ADR-031, ADR-033, ADR-036, ADR-044

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

Sarah Wooders' thesis on agent infrastructure articulates a trap that CLEO is designed to avoid:
"memory isn't a plugin, it's the harness." When memory lives inside the provider — inside Claude's
servers, inside OpenAI's thread store, inside Cursor's workspace — the user is renting memory from
a vendor. Switching providers means starting over: empty context, no continuity, no institutional
knowledge. Closed harness equals rented memory equals vendor lock-in.

CLEO inverts this. CLEO IS the harness. Providers are the conversation surface — the UI, the
keybindings, the model weights — but memory, tasks, code intelligence, and agent messaging are
always local files under CLEO control. A user can swap from Claude Code to OpenCode to Codex
tomorrow and carry their full working memory with them because that memory was never inside the
provider to begin with.

As of v2026.4.43, CLEO supports nine provider adapters: `claude-code`, `claude-sdk`, `codex`,
`cursor`, `gemini-cli`, `kimi`, `openai-sdk`, `opencode`, and `pi`. The
`CLEOProviderAdapter` interface in `packages/contracts/src/adapter.ts` is already the clean
boundary. What this ADR formalises is the sovereignty invariants that EVERY provider integration
MUST honour and the per-provider agent file paths that the CAAMP injector now manages.

---

## Decisions

### Decision 1: CLEO owns its memory — four databases, always local, always under CLEO control

The following databases are CLEO-owned resources and MUST remain local files under CLEO's
control regardless of which provider is active, which provider is installed, or which provider
is the currently active harness:

| Database | Primary store path | System |
|----------|-------------------|--------|
| `brain.db` | `<project>/.cleo/brain.db` (project-tier) | BRAIN |
| `nexus.db` | `~/.local/share/cleo/nexus.db` (global-tier) | NEXUS |
| `conduit.db` | `<project>/.cleo/conduit.db` (project-tier) | CONDUIT |
| `tasks.db` | `<project>/.cleo/tasks.db` (project-tier) | TASKS |

**Rationale**: These four stores represent the user's working memory, code intelligence, agent
messaging, and task history. If any provider owned or could relocate these files, swapping
providers would destroy continuity. Keeping them local means they are always accessible via the
`cleo` CLI, always backed up by `cleo backup`, and always portable via `cleo restore`.

Provider adapters MUST NOT:
- Write to any of the four CLEO-owned databases directly (they MUST use the `cleo` CLI or the
  `@cleocode/core` accessor layer)
- Move, rename, or create symlinks for these database files into provider-controlled directories
- Store references to these files inside provider-owned configuration (e.g., workspace settings)
  in ways that would prevent CLEO from resolving them at its standard paths

### Decision 2: `CLEOProviderAdapter` is the single harness boundary

`CLEOProviderAdapter` in `packages/contracts/src/adapter.ts` is the SINGLE interface that every
provider integration MUST implement. It is the boundary between CLEO's core engine and the
provider's conversation surface.

The nine currently adapted providers are:

| Provider ID | Adapter package |
|-------------|-----------------|
| `claude-code` | `packages/adapters/src/providers/claude-code/` |
| `claude-sdk` | `packages/adapters/src/providers/claude-sdk/` |
| `codex` | `packages/adapters/src/providers/codex/` |
| `cursor` | `packages/adapters/src/providers/cursor/` |
| `gemini-cli` | `packages/adapters/src/providers/gemini-cli/` |
| `kimi` | `packages/adapters/src/providers/kimi/` |
| `openai-sdk` | `packages/adapters/src/providers/openai-sdk/` |
| `opencode` | `packages/adapters/src/providers/opencode/` |
| `pi` | `packages/adapters/src/providers/pi/` |

**Rationale**: A single interface prevents each adapter from inventing its own contract. The
adapter declares capabilities, exposes optional sub-providers (hooks, spawn, paths, transport,
context monitor, task sync), and implements `initialize`, `dispose`, and `healthCheck`. CLEO's
core engine only depends on this interface, never on any concrete adapter class.

Any future provider integration MUST implement `CLEOProviderAdapter` before it can be registered
in CAAMP's provider registry. Partial implementations using empty stubs are acceptable at
registration time but MUST be tracked as known gaps and MUST NOT be shipped as "complete" adapters.

### Decision 3: Provider owns the conversation surface; CLEO owns memory

The sovereignty boundary is drawn at the conversation surface:

- **Provider MAY own**: the UI shell (TUI, IDE panel, web interface), keybindings, display
  rendering, model selection UI, system-prompt presentation, LLM API calls, tool execution
  within sessions, and the provider's own configuration files (`.cursor/settings.json`,
  `.claude/settings.json`, etc.)
- **Provider MUST NOT own**: `brain.db`, `nexus.db`, `conduit.db`, `tasks.db`, CLEO CLI
  dispatch, CLEO skill definitions, CLEO hook taxonomy (CANT), or the CAAMP injection chain

**Rationale**: This boundary lets providers differentiate freely on UX and model capabilities
while CLEO preserves continuity across provider switches. A provider that crosses this boundary
— for example, by reading `brain.db` directly and caching observations in its own store —
creates a split-brain scenario where switching providers silently loses memory. This is precisely
the lock-in failure mode this ADR prevents.

### Decision 4: Agent-definition files are per-provider resources managed by the CAAMP injector

Agent-definition files — `cleo-subagent.md`, seed agent profiles, and similar instruction files
that tell a provider how to behave as a CLEO subagent — are per-provider resources. Each
provider has a native path where it reads these files. The CAAMP injector MUST write to each
enabled provider's native agent folder rather than to a single hardcoded path.

The canonical mapping is:

| Provider ID | Agent folder path |
|-------------|------------------|
| `claude-code` | `~/.claude/agents/` |
| `claude-sdk` | `~/.claude/agents/` |
| `opencode` | `~/.config/opencode/agents/` |
| `codex` | `~/.config/codex/agents/` |
| `cursor` | `~/.cursor/agents/` |
| `pi` | `~/.config/pi/agents/` |
| `kimi` | `~/.config/kimi/agents/` |
| `gemini-cli` | `~/.config/gemini/agents/` |
| `openai-sdk` | `~/.config/openai/agents/` |

This mapping is now implemented as `getProviderAgentFolder(providerId)` in
`packages/caamp/src/core/instructions/injector.ts`.

**Migration story**: If `~/.claude/agents/cleo-subagent.md` already exists from a prior install
(when `claude-code` was the only supported path), the CAAMP injector MUST leave it in place.
Writing agent files is idempotent — files that already exist with the correct content MUST NOT
be clobbered. This prevents disrupting existing Claude Code installations during the transition.

**Rationale**: Hardcoding `~/.claude/agents/` as the only agent-definition path means every
other provider cannot receive CLEO subagent instruction files. Abstracting the path per provider
gives each provider its native file structure while keeping the injection logic centralised in
CAAMP — one place to update, nine providers covered.

### Decision 5: Invariant verification is deferred but scoped

A future `cleo smoke --provider <name>` command WILL verify the harness sovereignty invariants
after any provider swap or install. This command is explicitly NOT in this ADR's merge scope —
it is captured as a deferred follow-up task off T636.

When shipped, `cleo smoke --provider <name>` MUST verify:
- (a) `brain.db`, `nexus.db`, `conduit.db`, and `tasks.db` paths are unchanged from their
  pre-swap positions (no relocation by the provider)
- (b) Hooks registered in the CANT taxonomy are still wired for the new provider
- (c) The new provider's adapter implements `CLEOProviderAdapter` (checked via the adapter
  registry, not duck-typing)
- (d) No provider process has an open write handle to any CLEO-owned database (checked via
  `lsof` or equivalent at smoke-test time)

---

## Consequences

### Positive

- **Sovereignty preserved**: users can swap providers without losing memory, tasks, or code
  intelligence. The four local databases are immune to provider churn.
- **Per-provider agent files**: all nine current providers can receive CLEO subagent instruction
  files via the CAAMP injector. No provider is treated as a second-class citizen in agent
  definition management.
- **Single boundary**: `CLEOProviderAdapter` as the sole harness interface eliminates ad-hoc
  provider integrations that bypass the contract. New providers have a clear onboarding path.
- **Idempotent migration**: existing `~/.claude/agents/` installs are preserved; no user action
  required on upgrade.

### Negative / trade-offs

- **Per-provider coordination cost**: maintaining nine provider-specific agent folders means that
  changes to the agent-definition template must be propagated to each provider path. The CAAMP
  injector centralises this, but it adds a non-trivial code surface to maintain.
- **Unverified at merge time**: the `cleo smoke --provider` verification command is deferred, so
  sovereignty claims in this ADR remain unverifiable by automated tooling until that follow-up
  ships. Manual review is the only gate for now.
- **Three adapter stubs unresolved**: `codex`, `gemini-cli`, and `kimi` spawn implementations
  remain stubbed. The agent folder paths for these providers are defined and the injector will
  write to them, but subagent spawning from those providers is not yet functional. This is
  explicitly deferred per the scope cut in T639's acceptance criteria.

### Rollback

Rolling back this ADR means:
1. Reverting `packages/caamp/src/core/instructions/injector.ts` to the state before `getProviderAgentFolder` and `writeAgentFileToAllProviders` were added
2. Removing this ADR file

No database migration is required. The four CLEO-owned databases are unaffected. Any agent files
written to provider-specific folders (`~/.config/opencode/agents/`, etc.) before rollback SHOULD
be manually removed if the provider-native paths are no longer desired.

---

## Residual / Deferred Work (explicit)

The following items are explicitly OUT of scope for this ADR's merge and are captured as
follow-up tasks under T636:

1. **`codex` spawn implementation** — `packages/adapters/src/providers/codex/` spawn stub
   needs a concrete implementation. Tracked as follow-up task off T636.
2. **`gemini-cli` spawn implementation** — `packages/adapters/src/providers/gemini-cli/` spawn
   stub needs a concrete implementation. Tracked as follow-up task off T636.
3. **`kimi` spawn implementation** — `packages/adapters/src/providers/kimi/` spawn stub needs a
   concrete implementation. Tracked as follow-up task off T636.
4. **`cleo smoke --provider <name>` CLI command** — invariant verification probe deferred.
   Acceptance criteria: checks (a)-(d) listed in Decision 5 above. Tracked as follow-up task
   off T636.

---

## References

- `packages/contracts/src/adapter.ts` — `CLEOProviderAdapter` interface (the harness boundary)
- `packages/caamp/src/core/instructions/injector.ts` — per-provider agent folder resolution (this ADR's implementation)
- `packages/adapters/src/providers/` — nine provider adapter implementations
- ADR-035 — Pi v2+v3 harness (this ADR supersedes ADR-035's harness-boundary claims only)
- ADR-036 — CleoOS Database Topology (defines the four CLEO-owned databases and their canonical paths)
- ADR-044 — Canon Reconciliation (6 systems, 11 domains — the identity context for CLEO's architecture)
