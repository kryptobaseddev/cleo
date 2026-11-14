# ADR-052: SDK Consolidation — Vercel AI SDK as the LLM Bridge

**Status**: Accepted (2026-04-18)
**Date**: 2026-04-18
**Task**: T933 (epic T910 — Orchestration Coherence v4)
**Scope**: `packages/adapters`, `packages/core`

## Context

CLEO's provider adapters previously depended on three competing SDKs:

- `@anthropic-ai/claude-agent-sdk@0.2.108` (used by `packages/adapters/src/providers/claude-sdk/spawn.ts`)
- `@openai/agents@0.8.3` (used by `packages/adapters/src/providers/openai-sdk/{spawn,handoff,guardrails,tracing}.ts`)
- `@ai-sdk/anthropic@3.0.69` via `ai` v6 (used by `packages/core/src/memory/llm-backend-resolver.ts`)

This divergence created four concrete problems:

1. **Three competing conventions** for model invocation, tool use, and structured output — every new feature had to be implemented three times.
2. **Version drift** — each SDK bumped independently, producing a growing dep-graph where `claude-agent-sdk`, `openai/agents`, and `@ai-sdk/*` all pulled in overlapping but incompatible transitive deps (Zod 3 vs 4, provider-utils versions).
3. **Coupling** between CLEO orchestration code and provider-specific SDK shapes (`Agent`, `Runner`, `InputGuardrail`, `TracingProcessor`) — extensions inevitably leaked SDK vocabulary into the CLEO surface.
4. **Ambiguity** about which SDK owns what surface — the Anthropic adapter bundled an opinionated agent scaffolding that CLEO already provides via `composeSpawnPayload`, duplicating concerns.

## Decision

Standardize on the **Vercel AI SDK** (`ai` v6 + `@ai-sdk/anthropic` + `@ai-sdk/openai`) as the single LLM-bridge layer inside provider adapters.

**CLEO retains its own orchestration primitives** — `composeSpawnPayload`, playbook runtime, agent registry, CANT DSL, session ledger. The Vercel AI SDK is strictly the LLM bridge (model invocation, streaming, tool calls, structured output). It is not the orchestrator.

## Consequences

### Positive

- **Single SDK surface** to learn, version, and maintain. `generateText`, `streamText`, `generateObject` work identically across Anthropic and OpenAI.
- **Provider-neutral tool use API**: tools defined once work with Anthropic + OpenAI + Google + compatible providers.
- **Lower dep-tree churn**: no three-SDK diamond; `ai` owns the provider-utils contract.
- **Alignment with `packages/core/src/memory`**: transcript extraction already uses `@ai-sdk/anthropic` via `resolveLlmBackend` — adapters now match.
- **CLEO-native abstractions**: `CleoAgent`, `CleoInputGuardrail`, `CleoTraceProcessor`, `CleoSpan` replace `@openai/agents` types. These remain compatible in shape so downstream consumers do not require code changes.

### Negative

- `@anthropic-ai/claude-agent-sdk` shipped an opinionated agent scaffolding (MCP wiring, multi-turn session orchestration). CLEO already owns scaffolding via `composeSpawnPayload` and session lifecycle primitives, so nothing is lost — but a one-shot `generateText` call does not include built-in MCP server launching. Consumers that relied on the SDK to manage MCP servers during a spawn must now rely on CLEO orchestration to stage MCP state before the model call.
- `@openai/agents` had built-in `handoffs` graph routing. CLEO now owns that topology inside `OpenAiSdkSpawnProvider.spawn()` — lead runs, then each worker runs sequentially with the lead's output as input. The visible behaviour is preserved; the routing lives in the adapter rather than the SDK.
- No loss from `@openai/agents` tracing. `CleoConduitTraceProcessor` was already CLEO-controlled; the rewrite swaps `TracingProcessor` from `@openai/agents` for a local `CleoTraceProcessor` interface with the same shape.

## Migration

Changes landed in T933 (commit TBD):

1. **Dependencies**
   - Removed: `@anthropic-ai/claude-agent-sdk`, `@openai/agents`
   - Added: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `ai`
2. **`packages/adapters/src/providers/claude-sdk/spawn.ts`** — rewritten to call `generateText({ model: anthropic(modelId), prompt })` instead of the legacy `query({ ... })` iterator.
3. **`packages/adapters/src/providers/openai-sdk/spawn.ts`** — rewritten to use `generateText` via `@ai-sdk/openai`. Handoff topology is now orchestrated by the provider itself (lead → workers, sequential).
4. **`packages/adapters/src/providers/openai-sdk/guardrails.ts`** — `InputGuardrail` replaced with CLEO-native `CleoInputGuardrail`. Legacy name kept as a type alias for compatibility.
5. **`packages/adapters/src/providers/openai-sdk/handoff.ts`** — `Agent` from `@openai/agents` replaced with CLEO-native `CleoAgent`. Legacy alias retained.
6. **`packages/adapters/src/providers/openai-sdk/tracing.ts`** — `TracingProcessor` replaced with CLEO-native `CleoTraceProcessor`. Span payload unified into `CleoSpan`.
7. **Tests** — rewritten to mock `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `ai` directly. 284 adapter tests pass.

## References

- T910 epic — Orchestration Coherence v4
- T933 — SDK Consolidation
- [Vercel AI SDK docs](https://ai-sdk.dev)
- `packages/core/src/memory/llm-backend-resolver.ts` — precedent for `@ai-sdk/anthropic` usage
- ADR-049 — harness sovereignty
- ADR-050 — CleoOS sovereign harness
