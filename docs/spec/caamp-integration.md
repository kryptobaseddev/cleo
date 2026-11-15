# CAAMP Integration Specification

**Status**: ACTIVE

---

## 1. Overview

CAAMP (Central AI Agent Managed Packages, `@cleocode/caamp`) is the provider
registry and package manager for AI coding agents. CLEO uses it to know which
providers (agent harnesses) exist and what each supports, to install skills and
MCP server entries, and to own the managed instruction blocks
(`<!-- CAAMP:START -->` … `<!-- CAAMP:END -->`) in provider instruction files.

This specification documents the integration points that exist in source.
Unimplemented designs are marked [TARGET].

### CAAMP package

- **Location**: `packages/caamp/` in this monorepo
- **Consumed by**: `@cleocode/core` and `@cleocode/cleo` as `workspace:*`
  dependencies
- **Provider registry data**: `packages/caamp/providers/registry.json`
- **CLI**: `caamp` (`packages/caamp/src/cli.ts`)

### CLI surface

`caamp` registers these command groups (`cli.ts`):

| Group | Subcommands |
|-------|-------------|
| `providers` | `list`, `detect`, `show`, `skills-map`, `hooks` (`list`, `matrix`, `translate`), `capabilities` |
| `skills` | `find`, `install`, `init`, `validate`, `list`, `remove`, `update`, `audit`, `check` |
| `instructions` | `inject`, `check`, `update` |
| `mcp` | `install`, `list`, `detect`, `remove` |
| `config` | `show`, `path` |
| `doctor` | — |
| `advanced` | `providers`, `batch`, `instructions` (LAFS wrappers) |

### Pi harness surface (retired, not part of this integration)

ADR-098 (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`) retires
CAAMP's Pi harness surface: `harness/pi.ts`, `caamp pi *` and the Pi
exclusivity mode. CLEO does not depend on it. It is frozen, not yet deleted:

- `caamp pi` is still registered (`cli.ts`, `registerPiCommands`) and every
  verb prints a deprecation notice first (`commands/pi/index.ts`,
  `PI_VERBS_DEPRECATION_NOTICE`).
- `packages/caamp/src/core/harness/pi.ts` is still present.
- The default exclusivity mode is `legacy` (`core/config/caamp-config.ts`,
  `DEFAULT_EXCLUSIVITY_MODE`): CAAMP prefers no harness. `auto` and
  `force-pi` remain explicit opt-ins (`setExclusivityMode` or
  `CAAMP_EXCLUSIVITY_MODE`).
- The Pi registry entry has `priority: "medium"`
  (`providers/registry.json`).

### CLEO integration status

| Component | Status | Notes |
|-----------|--------|-------|
| Provider capability API | Implemented | Section 2 |
| Spawn adapters | Implemented | Section 3; adapters live in `packages/adapters/` |
| Hooks | Implemented | Section 4; CAAMP canonical event taxonomy |
| Skills and instruction injection | Implemented | `packages/core/src/caamp/adapter.ts` |
| MCP server entries | Implemented in CAAMP | Section 5 |

---

## 2. Provider Capability API

### 2.1 Function usage

| Function | CLEO location |
|----------|---------------|
| `getProviderCapabilities` | `packages/core/src/skills/precedence-integration.ts` |
| `getProvider` | `packages/core/src/caamp/adapter.ts`, `packages/core/src/skills/precedence-integration.ts` |
| `getProvidersByHookEvent` | `packages/core/src/hooks/provider-hooks.ts` |
| `getCommonHookEvents` | `packages/core/src/hooks/provider-hooks.ts` |
| `getProvidersBySkillsPrecedence` | `packages/core/src/skills/precedence-integration.ts` |
| `getEffectiveSkillsPaths` | `packages/core/src/skills/precedence-integration.ts` |
| `buildSkillsMap` | `packages/core/src/skills/precedence-integration.ts` |
| `getSpawnCapableProviders` | `packages/core/src/spawn/adapter-registry.ts` |
| `getProvidersBySpawnCapability` | `packages/core/src/spawn/adapter-registry.ts` |
| `providerSupports` | `packages/core/src/caamp/capability-check.ts` |
| `providerSupportsById` | `packages/core/src/caamp/capability-check.ts`, `packages/core/src/spawn/adapter-registry.ts` |

All of these are exported from `packages/caamp/src/core/registry/providers.ts`.
`packages/core/src/caamp/adapter.ts` also wraps CAAMP's provider registry
(`getAllProviders`, `getInstalledProviders`, `detectAllProviders`) and
injection APIs (`checkInjection`, `checkAllInjections`,
`generateInjectionContent`, `getInstructionFiles`) as `EngineResult`-returning
functions.

### 2.2 Usage examples

```typescript
import {
  getProvidersByHookEvent,
  getProvidersBySkillsPrecedence,
  providerSupportsById,
} from '@cleocode/caamp';

// Capability check by dotted path
if (providerSupportsById('claude-code', 'spawn.supportsSubagents')) {
  // use a spawn adapter
}

// Providers whose registry entry lists a hook event
const providers = getProvidersByHookEvent('SessionStart');

// Skills precedence
const agentsFirst = getProvidersBySkillsPrecedence('agents-first');
```

### 2.3 Dispatch operations

Defined in `packages/contracts/src/dispatch/operations-registry.ts`:

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `tools.provider.list` | query | List providers |
| `tools.provider.detect` | query | Detect installed providers |
| `tools.provider.supports` | query | Check a provider capability |
| `tools.provider.hooks` | query | List providers by hook event support |
| `tools.provider.inject.status` | query | Instruction injection status |
| `tools.provider.inject` | mutate | Inject instructions |
| `tools.skill.precedence` | query | Precedence mapping; `action: show` (default) or `resolve` with a provider id |
| `tools.skill.spawn.providers` | query | List spawn-capable providers by capability |
| `orchestrate.spawn.execute` | mutate | Execute a spawn through the adapter registry (`cleo orchestrate spawn-execute`) |

---

## 3. Spawn Adapters

### 3.1 `CLEOSpawnAdapter`

Declared in `packages/contracts/src/spawn-types.ts`:

```typescript
export interface CLEOSpawnAdapter {
  readonly id: string;
  readonly providerId: string;
  canSpawn(): Promise<boolean>;
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;
  listRunning(): Promise<CLEOSpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
}
```

### 3.2 CAAMP to CLEO mapping

CAAMP's `SpawnAdapter` (`packages/caamp/src/core/registry/spawn-adapter.ts`)
takes the provider on every call; CLEO's adapter is bound to one provider.

| CAAMP `SpawnAdapter` | `CLEOSpawnAdapter` |
|----------------------|--------------------|
| `canSpawn(provider)` | `canSpawn()` |
| `spawn(provider, options)` | `spawn(context)` |
| `listRunning(provider)` | `listRunning()` |
| `terminate(provider, instanceId)` | `terminate(instanceId)` |

### 3.3 Adapter implementations

`SpawnAdapterRegistry` (`packages/core/src/spawn/adapter-registry.ts`) loads
adapter packages from their manifests and bridges each exported
`<Name>SpawnProvider` (`AdapterSpawnProvider`) to `CLEOSpawnAdapter`. Spawn
providers exist under `packages/adapters/src/providers/<name>/spawn.ts` for
`claude-code`, `claude-sdk`, `codex`, `cursor`, `gemini-cli`, `kimi`,
`openai-sdk`, `opencode` and `pi`. ADR-098 lists `adapters/providers/pi` for
deletion.

---

## 4. Hooks

### 4.1 CAAMP canonical events

`CANONICAL_HOOK_EVENTS` (`packages/caamp/src/core/hooks/generated.ts`) has two
groups:

- **Provider events (16):** `SessionStart`, `SessionEnd`, `PromptSubmit`,
  `ResponseComplete`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PermissionRequest`, `SubagentStart`, `SubagentStop`, `PreModel`,
  `PostModel`, `PreCompact`, `PostCompact`, `Notification`, `ConfigChange`.
- **Domain events:** `ApprovalExpired`, `ApprovalGranted`,
  `ApprovalRequested`, `MemoryDecisionStored`, `MemoryLearningStored`,
  `MemoryObserved`, `MemoryPatternStored`, `PipelineManifestAppended`,
  `PipelineStageCompleted`, `SessionEnded`, `SessionStarted`, `TaskBlocked`,
  `TaskCompleted`, `TaskCreated`, `TaskStarted`.

CAAMP translates between canonical and provider-native names with `toNative`,
`toCanonical` and `supportsHook` (`core/hooks/normalizer.ts`); CLEO wraps them
in `packages/core/src/hooks/provider-hooks.ts`.

**CLEO internal events:** `onWorkAvailable`, `onAgentSpawn`,
`onAgentComplete`, `onCascadeStart`, `onPatrol`
(`INTERNAL_HOOK_EVENTS`, `packages/core/src/hooks/types.ts`). These are
CLEO-local and are not part of CAAMP's provider capability registry.

### 4.2 CLEO lifecycle event mapping

`CLEO_TO_CAAMP_HOOK_MAP` (`packages/core/src/hooks/types.ts`):

| CLEO event | CAAMP event |
|------------|-------------|
| `session.start` | `SessionStart` |
| `session.end` | `SessionEnd` |
| `task.start` | `PreToolUse` |
| `task.complete` | `PostToolUse` |
| `file.change` | `Notification` |
| `system.error` | `PostToolUseFailure` |
| `prompt.submit` | `PromptSubmit` |
| `response.complete` | `ResponseComplete` |

### 4.3 Hook registry

`HookRegistry` (`packages/core/src/hooks/registry.ts`, singleton `hooks`):

- `register(registration)` adds a handler with an id, event and priority and
  returns an unregister function.
- `dispatch(event, projectRoot, payload, …)` runs the event's handlers
  (sorted by priority, highest first) in parallel with `Promise.allSettled`;
  one handler's error does not block the others. When the caller passes a
  background lifecycle, only `awaitBeforeResponse` handlers delay the call, up
  to `RESPONSE_HOOK_BUDGET_MS` (2000 ms).
- `isEnabled`, `setConfig`, `getConfig` and `listHandlers` manage per-event
  configuration (all 16 provider events and the 5 internal events are enabled
  by default).
- Legacy `on`-prefixed names (`onSessionStart`, `onToolComplete`, …) are
  remapped to canonical names with a deprecation warning.

---

## 5. MCP Server Entries

CAAMP writes MCP server entries into provider config files:

```bash
caamp mcp install <serverName> [args...] --provider <id> [--from <file>] \
  [--scope project|global] [--force] [--project-dir <path>]
caamp mcp list
caamp mcp detect
caamp mcp remove <serverName>
```

CAAMP has no CLEO-specific MCP profile or release-channel installer.

---

## 6. [TARGET] Future Enhancements

### 6.1 [TARGET] Skill precedence mutations

Not in the operations registry:

| Operation | Purpose |
|-----------|---------|
| `tools.skill.precedence.set` | Set precedence mode |
| `tools.skill.precedence.clear` | Clear precedence override |
| `tools.skill.precedence.list` | List available precedence modes |

---

## 7. Source Files

- `packages/caamp/src/core/registry/providers.ts` — provider capability API
- `packages/caamp/src/core/hooks/` — canonical events and normalizer
- `packages/caamp/src/core/instructions/injector.ts` — managed instruction blocks
- `packages/core/src/caamp/adapter.ts` — CLEO's CAAMP adapter
- `packages/core/src/caamp/capability-check.ts` — capability checks
- `packages/core/src/skills/precedence-integration.ts` — skills precedence
- `packages/core/src/hooks/provider-hooks.ts`, `types.ts`, `registry.ts` — hooks
- `packages/core/src/spawn/adapter-registry.ts` — spawn adapter registry
- `packages/contracts/src/spawn-types.ts` — `CLEOSpawnAdapter`
- `packages/cleo/src/dispatch/domains/tools.ts` — `tools` domain handler
- `packages/contracts/src/dispatch/operations-registry.ts` — operation definitions

---

## 8. References

- CAAMP package: `packages/caamp/` (`packages/caamp/README.md`)
- ADR-098, Pi/CleoOS harness retirement: `cleo docs fetch adr-098-retire-the-pi-cleoos-harness`
