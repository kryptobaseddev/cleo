# CAAMP Integration Specification

**Version**: 1.6.1
**Status**: ACTIVE
**Last Updated**: 2026-03-06

---

## 1. Overview

This specification consolidates all CAAMP (Central AI Agent Managed Packages) integration documentation for CLEO. It documents the actual implemented integration points and marks aspirational/design-only features as [TARGET].

### CAAMP Library
- **Location**: `/mnt/projects/caamp` (peer dependency)
- **Package**: `@cleocode/caamp`
- **Version**: 1.6.1

### CLEO Integration Status

| Component | Status | Notes |
|-----------|--------|-------|
| Provider Capability API | ✅ Implemented | 11/11 functions used in production |
| Spawn Adapter | ✅ Implemented | `CLEOSpawnAdapter` wrapping CAAMP |
| Universal Hooks | ✅ Implemented | Hook registry with CAAMP event types |
| CLEO Profile Management | ✅ Implemented | MCP profile installation via CAAMP |
| Channel Management | ✅ Implemented | stable/beta/dev channels |

---

## 2. Provider Capability API (IMPLEMENTED)

All 11 CAAMP provider capability API functions are implemented and used in production:

### 2.1 Function Usage Matrix

| Function | Status | CLEO Location | Purpose |
|----------|--------|---------------|---------|
| `getProviderCapabilities` | ✅ | `src/core/skills/precedence-integration.ts` | Get full capabilities object |
| `getProvider` | ✅ | `src/core/caamp/adapter.ts` | Get provider by ID |
| `getProvidersByHookEvent` | ✅ | `src/core/hooks/provider-hooks.ts` | Filter providers by hook support |
| `getProvidersBySkillsPrecedence` | ✅ | `src/core/skills/precedence-integration.ts` | Filter by precedence mode |
| `getSpawnCapableProviders` | ✅ | `src/core/spawn/adapter-registry.ts` | Get all spawn-capable providers |
| `getProvidersBySpawnCapability` | ✅ | `src/core/spawn/adapter-registry.ts` | Filter by specific spawn capability |
| `providerSupports` | ✅ | `src/core/caamp/capability-check.ts` | Check capability on provider object |
| `providerSupportsById` | ✅ | `src/core/caamp/capability-check.ts` | Check capability by provider ID |
| `getCommonHookEvents` | ✅ | `src/core/hooks/provider-hooks.ts` | Find common hooks across providers |
| `getEffectiveSkillsPaths` | ✅ | `src/core/skills/precedence-integration.ts` | Get effective skill paths |
| `buildSkillsMap` | ✅ | `src/core/skills/precedence-integration.ts` | Build complete skills map |

### 2.2 Usage Examples

```typescript
// Spawn capability check
import { providerSupportsById } from '@cleocode/caamp';

if (providerSupportsById('claude-code', 'spawn.supportsSubagents')) {
  // Use spawn adapter
}

// Hook provider query
import { getProvidersByHookEvent } from '@cleocode/caamp';

const providers = getProvidersByHookEvent('onToolComplete');
// Returns providers supporting this hook

// Skills precedence
import { getProvidersBySkillsPrecedence } from '@cleocode/caamp';

const agentsFirst = getProvidersBySkillsPrecedence('agents-first');
```

### 2.3 MCP Operations Added

| Operation | Domain | Purpose |
|-----------|--------|---------|
| `orchestrate.spawn.execute` | orchestrate | Execute subagent spawn |
| `tools.provider.hooks` | tools | Query providers by hook support |
| `tools.provider.supports` | tools | Check provider capability |
| `tools.skill.precedence.show` | tools | Show precedence mapping |
| `tools.skill.precedence.resolve` | tools | Resolve paths for provider |
| `tools.skill.spawn.providers` | tools | List spawn-capable providers |

---

## 3. Spawn Adapter (IMPLEMENTED)

### 3.1 CLEO's SpawnAdapter Interface

```typescript
export interface CLEOSpawnAdapter {
  readonly provider: string;
  readonly description: string;
  canSpawn(): boolean;
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;
  listRunning(): Promise<CLEOSpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
  supports(capability: SpawnCapability): boolean;
}
```

### 3.2 CAAMP to CLEO Mapping

| CAAMP SpawnAdapter | CLEO CLEOSpawnAdapter | Notes |
|--------------------|-----------------------|-------|
| `canSpawn(provider)` | `canSpawn()` | Check if adapter can spawn |
| `spawn(provider, options)` | `spawn(context)` | Execute spawn with CLEO context |
| `listRunning(provider)` | `listRunning()` | List running spawns |
| `terminate(provider, instanceId)` | `terminate(instanceId)` | Terminate a spawn |

### 3.3 Adapter Implementations

**ClaudeCodeAdapter**: Wraps CAAMP provider for Claude Code with Task tool support
**SubprocessAdapter**: Fallback adapter using CLI subprocess when CAAMP providers unavailable

---

## 4. Universal Hooks (IMPLEMENTED)

### 4.1 CAAMP HookEvent Type

```typescript
type HookEvent = 
  | "onSessionStart"
  | "onSessionEnd"
  | "onToolStart"
  | "onToolComplete"
  | "onFileChange"
  | "onError"
  | "onPromptSubmit"
  | "onResponseComplete";
```

**CLEO extension**: CLEO's hook registry also supports internal coordination events for autonomous runtime features:
`onWorkAvailable`, `onAgentSpawn`, `onAgentComplete`, `onCascadeStart`, and `onPatrol`.
These are CLEO-local signals and are intentionally not returned by CAAMP provider capability discovery.

### 4.2 CLEO Lifecycle Event Mapping

| CLEO Event | CAAMP HookEvent | Trigger |
|------------|-----------------|---------|
| `session.start` | `onSessionStart` | Session begins |
| `session.end` | `onSessionEnd` | Session ends |
| `task.start` | `onToolStart` | Task becomes active |
| `task.complete` | `onToolComplete` | Task marked done |
| `file.write` | `onFileChange` | File modified |
| `error.caught` | `onError` | Error handled |

### 4.3 Hook Registry

CLEO implements `CLEOHookRegistry` class:
- Handler registration (`on`, `once`)
- Handler unregistration (`off`, `offAll`)
- Event firing with priority ordering
- Provider/session filtering
- Execution counting and limits

---

## 5. CLEO Profile Management (IMPLEMENTED)

### 5.1 CAAMP CLEO Functions

```typescript
// From CAAMP core/mcp/cleo.ts
buildCleoProfile(channel: CleoChannel): CleoProfileBuildResult
normalizeCleoChannel(channel: string): CleoChannel
resolveCleoServerName(channel: CleoChannel): string
resolveChannelFromServerName(serverName: string): CleoChannel
checkCommandReachability(command: string): Promise<boolean>
```

### 5.2 MCP Profile Installation

CAAMP supports CLEO channel selection and MCP profile installation:

```bash
# Non-interactive CLI
caamp mcp install cleo --channel stable --provider <provider>
caamp mcp install cleo --channel beta --provider <provider>
caamp mcp install cleo --channel dev --provider <provider> --command <local-command>

# Update and uninstall
caamp mcp update cleo --channel <channel> --provider <provider>
caamp mcp uninstall cleo --channel <channel> --provider <provider>
```

---

## 6. [TARGET] Future Enhancements

The following are documented design targets, not yet implemented:

### 6.1 [TARGET] skill.precedence.* Operations

| Operation | Domain | Status | Notes |
|-----------|--------|--------|-------|
| `tools.skill.precedence.set` | tools | ❌ Not implemented | Set precedence mode |
| `tools.skill.precedence.clear` | tools | ❌ Not implemented | Clear precedence override |
| `tools.skill.precedence.list` | tools | ❌ Not implemented | List available precedence modes |

### 6.2 [TARGET] Advanced Hook Features

- **Async hooks with blocking**: Allow handlers to block/await
- **Hook metrics**: Track handler execution time, success rates
- **Hook debugger**: CLI command to inspect registered hooks
- **Conditional hooks**: Only fire based on task metadata

### 6.3 [TARGET] Multi-Provider Spawning

- Spawn to multiple CAAMP providers simultaneously
- Provider-specific options configuration
- Cross-provider spawn coordination

---

## 7. Files Changed

### Source Files

- `src/core/spawn/adapter-registry.ts` - Spawn adapter registration
- `src/core/spawn/adapters/claude-code-adapter.ts` - Claude Code adapter
- `src/core/hooks/provider-hooks.ts` - Hook provider queries
- `src/core/hooks/types.ts` - Hook type definitions
- `src/core/caamp/capability-check.ts` - Capability checking
- `src/core/skills/precedence-integration.ts` - Skills precedence
- `src/dispatch/engines/orchestrate-engine.ts` - Spawn execution
- `src/dispatch/engines/hooks-engine.ts` - Hook engine
- `src/dispatch/domains/tools.ts` - Tool operations
- `src/dispatch/registry.ts` - Operation registry

### Test Files

- `src/mcp/__mocks__/@cleocode/caamp.ts` - CAAMP mocks

---

## 8. Verification

All implemented functions are verified in production code:

- **Coverage**: 11/11 API functions (100%)
- **Tests**: Unit and integration tests for all adapters
- **Documentation**: This specification is the canonical reference

---

## 9. References

- CAAMP Library: `/mnt/projects/caamp`
- CLEO Integration: `src/core/caamp/`
- MCP Operations: `src/dispatch/registry.ts`

---

**Specification Status**: ACTIVE  
**Consolidated From**: 
- CAAMP-1.6.1-API-INTEGRATION.md
- T5236-CAAMP-SPAWN-ADAPTER-DESIGN.md
- T5237-UNIVERSAL-HOOKS-DESIGN.md
- CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md

**Notes**: This specification supersedes all previous CAAMP integration documents. Design-only sections are marked [TARGET] and tracked as aspirational features.
