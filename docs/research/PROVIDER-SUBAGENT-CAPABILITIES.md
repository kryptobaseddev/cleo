# Provider Subagent Capabilities Matrix

**Purpose**: Structured reference for CAAMP developers to build provider-neutral spawn adapters
**Date**: 2026-03-02
**Status**: Initial research — requires validation per provider

---

## Capability Matrix

| Provider | Subagent Support | Programmatic API | Agent-Initiated Spawn | Inter-Agent Comms | Max Parallel | Recursive Depth |
|----------|-----------------|------------------|----------------------|-------------------|-------------|-----------------|
| Claude Code | Full | Yes (Task tool) | Yes | Yes (SendMessage) | Unlimited | 3+ levels |
| OpenCode | Full | Yes (config-driven) | Yes | File-based | Configurable | 2 levels |
| Codex | Full | Yes (SDK + CLI) | Yes | SDK events | Configurable | 2 levels |
| Gemini CLI | Experimental | Yes (tool calls) | Yes | Limited | Unknown | 1-2 levels |
| Cursor | Partial | No (UI only) | No | None | UI-managed | 1 level |
| Windsurf | Partial | No (UI only) | No | None | UI-managed | 1 level |
| Antigravity | UI-managed | No | No | UI-managed | UI-managed | 1 level |
| Continue.dev | Partial | Partial (async CLI) | No | File-based | 1 | 1 level |
| Cline/Roo Code | Partial | Partial (VS Code API) | No | None | 1 | 1 level |
| Aider | None | No | No | None | 0 (Architect/Editor only) | 0 |

---

## Provider Detail Blocks

### Claude Code

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | `Task` tool with `subagent_type` parameter |
| **Invocation** | `Task({ prompt, subagent_type: "cleo-subagent", mode: "bypassPermissions" })` |
| **Config** | Agent definitions in `.claude/agents/*.md` |
| **Team Support** | `TeamCreate` + `SendMessage` for multi-agent coordination |
| **Limitations** | Context window per agent (~200K tokens), no shared memory between agents |
| **CLEO Integration** | Full — `orchestrate.spawn` generates prompt, Task tool executes |

### OpenCode

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | Config-driven agent spawning via YAML definitions |
| **Invocation** | Agent configs in `.opencode/agents/`, spawned programmatically |
| **Config** | YAML agent definitions with tool access controls |
| **Team Support** | File-based communication via shared workspace |
| **Limitations** | Limited inter-agent messaging, file-based handoff required |
| **CLEO Integration** | Adapter needed — translate spawn prompt to agent config |

### Codex (OpenAI)

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | CLI agent SDK with programmatic agent creation |
| **Invocation** | `codex --agent` or SDK `Agent.create()` |
| **Config** | JSON/YAML agent definitions |
| **Team Support** | SDK event system for coordination |
| **Limitations** | API rate limits, token budgets per agent |
| **CLEO Integration** | Adapter needed — translate spawn prompt to SDK call |

### Gemini CLI

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | Tool-based agent delegation (experimental) |
| **Invocation** | Tool calls within conversation context |
| **Config** | `.gemini/agents/` configuration |
| **Team Support** | Limited — experimental multi-agent features |
| **Limitations** | Experimental status, API changes expected |
| **CLEO Integration** | Adapter needed — translate spawn prompt to tool call |

### Cursor

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | UI-based background agents |
| **Invocation** | Manual UI action or Cmd+Shift+P command |
| **Config** | `.cursor/agents/` or UI settings |
| **Team Support** | None — agents run in isolated UI contexts |
| **Limitations** | No programmatic spawn, no agent-initiated delegation |
| **CLEO Integration** | Limited — prompt can be displayed for manual execution |

### Windsurf

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | UI parallel sessions (Cascade) |
| **Invocation** | Manual UI action |
| **Config** | UI-configured |
| **Team Support** | None — sessions are isolated |
| **Limitations** | No programmatic API, no inter-session communication |
| **CLEO Integration** | Limited — prompt can be displayed for manual execution |

### Continue.dev

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | Async CLI execution with VS Code integration |
| **Invocation** | CLI commands or VS Code extension API |
| **Config** | `.continue/config.json` |
| **Team Support** | File-based via shared workspace |
| **Limitations** | Partial programmatic control, single agent at a time |
| **CLEO Integration** | Adapter needed — translate spawn prompt to CLI command |

### Cline / Roo Code

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | VS Code extension with partial programmatic access |
| **Invocation** | VS Code extension API or manual |
| **Config** | Extension settings |
| **Team Support** | None |
| **Limitations** | Single agent, no multi-agent coordination |
| **CLEO Integration** | Limited — prompt can be fed via extension API |

### Aider

| Dimension | Detail |
|-----------|--------|
| **Mechanism** | Architect/Editor mode (two-model, not subagents) |
| **Invocation** | CLI with `--architect` flag |
| **Config** | `.aider.conf.yml` |
| **Team Support** | None — single conversation model |
| **Limitations** | No subagent support, no delegation, no multi-agent |
| **CLEO Integration** | Minimal — can receive prompts but cannot delegate |

---

## CLEO Integration Requirements for CAAMP

### 1. Provider Capability Registry API

CAAMP needs to expose a capability registry that CLEO can query:

```typescript
interface ProviderCapabilities {
  subagentSupport: 'full' | 'partial' | 'none';
  programmaticSpawn: boolean;
  agentInitiatedSpawn: boolean;
  interAgentComms: 'messaging' | 'file-based' | 'none';
  maxParallelAgents: number | 'unlimited';
  maxRecursiveDepth: number;
}

// CAAMP API
caamp.provider.getCapabilities(): ProviderCapabilities;
caamp.provider.supports('subagents'): boolean;
caamp.provider.supports('programmatic-spawn'): boolean;
```

### 2. Spawn Adapter Interface

Translate CLEO's `orchestrate.spawn` prompt into provider-native mechanism:

```typescript
interface SpawnAdapter {
  /**
   * Execute a CLEO spawn prompt using the provider's native mechanism.
   * @param prompt - Fully-resolved prompt from orchestrate.spawn
   * @param options - Spawn options (skill name, protocol, token budget)
   * @returns SpawnResult with agent ID and output path
   */
  spawn(prompt: string, options: SpawnOptions): Promise<SpawnResult>;

  /**
   * Check if provider supports a specific spawn capability.
   */
  supports(capability: SpawnCapability): boolean;
}

type SpawnCapability =
  | 'parallel-spawn'      // Can spawn multiple agents simultaneously
  | 'agent-initiated'     // Agents can spawn other agents
  | 'inter-agent-comms'   // Agents can message each other
  | 'recursive-spawn'     // Agents can become orchestrators
  | 'token-tracking'      // Provider reports token usage
  ;
```

### 3. Capability Detection

Programmatic check for provider capabilities at runtime:

```typescript
// Before attempting orchestration
if (!caamp.provider.supports('subagents')) {
  // Fallback: execute serially in current context
  // or display prompt for manual execution
}

// Before parallel spawning
if (caamp.provider.supports('parallel-spawn')) {
  // Spawn all wave tasks simultaneously
} else {
  // Spawn sequentially
}
```

---

## Gap Analysis

| Provider | Missing for Full CLEO Orchestration |
|----------|-------------------------------------|
| Claude Code | Nothing — full support |
| OpenCode | CAAMP adapter for config-driven spawn |
| Codex | CAAMP adapter for SDK integration |
| Gemini CLI | CAAMP adapter, stability concerns (experimental) |
| Cursor | Programmatic spawn API needed |
| Windsurf | Programmatic spawn API needed |
| Antigravity | Programmatic spawn API needed |
| Continue.dev | Better async agent support, CAAMP adapter |
| Cline/Roo | Programmatic spawn API, multi-agent support |
| Aider | Fundamental architecture change needed (no subagents) |

### Fallback Strategy for Limited Providers

For providers without programmatic spawn (Cursor, Windsurf, Aider):

1. **Prompt Display Mode**: Show the generated spawn prompt for manual execution
2. **Serial Execution**: Run all tasks in the current agent context sequentially
3. **File Handoff**: Write spawn prompt to file, user copy-pastes to new session

---

## Notes

- Provider capabilities should be validated against current versions (capabilities change rapidly)
- This document should be updated quarterly as providers evolve
- CAAMP adapters should implement the `SpawnAdapter` interface for each supported provider
