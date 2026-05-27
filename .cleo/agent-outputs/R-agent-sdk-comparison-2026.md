# Agent SDK Landscape Research (April 2026)

## 1. Claude Agent SDK

Formerly the "Claude Code SDK," renamed late 2025. Python (v0.1.48 on PyPI) and TypeScript (v0.2.71 on npm). It is the same agent loop that powers Claude Code, extracted as a library. Ships with built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch). Supports sub-agents via `AgentTool` -- one agent spawns child agents with isolated context that return summarized results. Full MCP server support (stdio, SSE, HTTP, in-process SDK servers). Hooks system for intercepting tool calls. Permission modes for sandboxing. Claude-only (supports Bedrock/Vertex endpoints but not non-Claude models).

## 2. Claude Managed Agents (April 2026, public beta)

Hosted runtime on top of the Agent SDK. Four primitives: Agent (versioned config), Environment (container template), Session (persistent stateful task), Events (bidirectional SSE). Sessions persist across disconnections, maintain file system and conversation state. Supports MCP servers, built-in toolset (`agent_toolset_20260401`), mid-task steering. Pricing: standard token rates + $0.08/session-hour + $10/1K web searches. Early adopters: Notion, Asana, Sentry, Rakuten.

## 3. Claude Code Programmatic Control

Claude Code itself has a full SDK (the Agent SDK IS it). TypeScript: `import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-code"`. Python: `from claude_code_sdk import query, ClaudeAgentOptions`. Also supports CLI-based programmatic use (`claude --json`), background tasks via GitHub Actions, and Remote Control for mobile operation. No separate "Claude Code SDK" -- they are the same thing.

## 4. OpenAI Agents SDK (March 2025)

Python and TypeScript. Core primitives: Agents, Handoffs (agent-to-agent transfer with full context), Guardrails (input/output validation), Tracing (end-to-end observability). Provider-agnostic (100+ LLMs via Chat Completions API). Handoff pattern: triage agent routes to specialists, specialists can return or re-route. Sessions for state management. MCP support. No built-in OS/file tools -- you define everything.

## 5. Other Frameworks

| Framework | Version | Language | Orchestration Model | Production Status |
|-----------|---------|----------|-------------------|-------------------|
| LangGraph | v1.0.10 | Python, TS | Graph-based state machines | GA, production |
| CrewAI | v1.10.1 | Python | Role-based teams | GA, production |
| AutoGen / MS Agent Framework | v0.7+ | Python, .NET | Event-driven conversation | 1.0 GA Q1 2026 |
| Google ADK | current | Python, TS, Java, Go | Multi-agent + A2A protocol | Emerging |

## Comparison Table

| Capability | Claude Agent SDK | Managed Agents | OpenAI Agents SDK | LangGraph | CrewAI |
|---|---|---|---|---|---|
| Sub-agent spawning | Yes (AgentTool) | Via SDK | Yes (as_tool) | Yes (subgraphs) | Yes (delegation) |
| Agent-to-agent handoffs | Via sub-agents | Via sub-agents | Yes (first-class) | Yes (edges) | Yes (manager) |
| Persistent state across sessions | Resume by session ID | Yes (server-side) | Sessions API | Checkpointer | Short/long-term memory |
| MCP support | Yes (native) | Yes (native) | Yes | Via integration | Via integration |
| Built-in tools | Yes (12+ tools) | Yes (full toolset) | No (BYO) | No (BYO) | No (BYO) |
| Model-agnostic | No (Claude only) | No (Claude only) | Yes (100+ LLMs) | Yes | Yes |
| Languages | Python, TypeScript | API (any language) | Python, TypeScript | Python, TypeScript | Python |
| Hosted runtime | No (self-hosted) | Yes (Anthropic cloud) | No | LangGraph Platform | CrewAI Enterprise |
| Observability | Hooks + streaming | Console tracing | Built-in tracing | LangSmith | Logs |
| Learning curve | Low | Low | Low | High | Low |

## Recommendation for Multi-Provider Agent Adapter

**Primary integration targets (in priority order):**

1. **Claude Agent SDK** -- Already powers this project's runtime. Native sub-agents, MCP, hooks, and permission system map directly to CLEO's architecture. Non-negotiable foundation.

2. **OpenAI Agents SDK** -- Best provider-agnostic option. Handoff primitive is the cleanest agent-to-agent pattern available. TypeScript support means it can share adapter interfaces with the Claude SDK.

3. **LangGraph** -- For workflows requiring deterministic graph execution, checkpointed replay, or complex branching. Overkill for simple delegation but unmatched for stateful multi-step pipelines.

**Monitor but do not integrate yet:**

- **Managed Agents** -- Useful for long-running autonomous tasks but locked to Anthropic cloud. Evaluate when self-hosted option appears.
- **Google ADK** -- A2A protocol is interesting for cross-vendor agent communication but ecosystem is immature.
- **CrewAI** -- Good ergonomics but Python-only and less control than LangGraph.

**Adapter architecture:** Define a common `AgentProvider` interface with `spawn()`, `handoff()`, `query()`, and `onToolUse()` methods. Claude Agent SDK and OpenAI Agents SDK are the two backends that matter today. LangGraph is the escape hatch for graph-shaped workflows.
