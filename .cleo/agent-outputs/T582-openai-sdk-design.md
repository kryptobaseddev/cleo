# T582 Design: SDK-Backed OpenAI Agent Spawn Provider

**Date**: 2026-04-14
**Task**: T582 — Build SDK-backed OpenAI Agent spawn provider
**Status**: Design complete

---

## Provider Location

```
packages/adapters/src/providers/openai-sdk/
  adapter.ts          # OpenAiSdkAdapter (CLEOProviderAdapter)
  spawn.ts            # OpenAiSdkSpawnProvider (AdapterSpawnProvider)
  install.ts          # OpenAiSdkInstallProvider (AdapterInstallProvider)
  manifest.json       # Provider capability declaration
  guardrails.ts       # CLEO permission rules → SDK guardrails
  tracing.ts          # Custom trace processor → conduit.db
  index.ts            # Barrel export
```

---

## Unique Value Proposition

The `@openai/agents` SDK has **first-class handoffs** — when Agent A finishes, it passes context to Agent B by name. This maps directly to CLEO's Team Lead → Worker model without any glue code. The SDK also supports 100+ LLMs via the Vercel AI SDK adapter, making this provider the only one in CLEO that is natively multi-model without switching providers.

---

## CLEO → OpenAI SDK Mapping

| CLEO Concept | OpenAI SDK Primitive | Notes |
|---|---|---|
| Team Lead agent | `Agent` with `handoffs: [worker]` | Lead routes to workers by task type |
| Worker agent | `Agent` with `tools: [Read, Write, Bash]` | Receives context from handoff |
| Orchestrator | Top-level `Agent` that holds all team leads as handoffs | One entry point per team topology |
| CANT agent persona | `instructions` field on each `Agent` | Persona → system prompt |
| Team topology | Explicit `handoffs` array graph | Declaratively expresses who can hand off to whom |
| Task prompt | `runner.run(agent, prompt)` | `SpawnContext.prompt` maps to this argument |
| SpawnResult | `RunResult.finalOutput` + exit status | Await or fire-and-forget via detached Runner |
| CLEO permissions | Input/output guardrails per tool | File glob ACLs become tool-level `inputGuardrails` |
| Audit trail | Custom `TraceProcessor` → conduit.db | All spans written to conduit as structured events |

---

## Key Design Decisions

### Model Strategy

```typescript
// Tier-based model selection via SpawnContext.options
interface OpenAiSdkSpawnOptions {
  model?: string;        // default: 'gpt-4.1'
  tier?: 'lead' | 'worker' | 'orchestrator';
  // lead → gpt-4.1, worker → gpt-4.1-mini, orchestrator → gpt-4.1
  handoffs?: string[];   // target agent names this spawn can hand off to
  guardrailLevel?: 'strict' | 'standard' | 'none';
}
```

Workers use a smaller model (gpt-4.1-mini) by default. Team Leads and orchestrators default to gpt-4.1. Callers can override via `options.model` in `SpawnContext`.

### Guardrails: CLEO ACLs → SDK Guardrails

CLEO has file-glob path ACLs and tool allowlists. These map to tool-level `inputGuardrails` on each SDK tool:

```typescript
// guardrails.ts
export function buildPathGuardrail(allowedGlobs: string[]): InputGuardrail {
  return {
    name: 'cleo_path_acl',
    run: async ({ toolCall }) => {
      const args = JSON.parse(toolCall.arguments) as { path?: string };
      if (args.path && !isPathAllowed(args.path, allowedGlobs)) {
        return { behavior: { type: 'rejectContent', message: `Path denied: ${args.path}` } };
      }
      return { behavior: { type: 'allow' } };
    },
  };
}
```

An `outputGuardrail` logs each tool result to conduit.db for audit. These guardrails are attached when building the SDK `tool()` wrappers for `Read`, `Write`, and `Bash`.

### Tracing: SDK Spans → conduit.db

The `@openai/agents` SDK emits structured trace spans. A custom `TraceProcessor` captures them and writes to conduit.db via the existing transport layer:

```typescript
// tracing.ts
export class CleoConduitTraceProcessor implements TraceProcessor {
  async onTraceEnd(trace: Trace): Promise<void> {
    for (const span of trace.spans) {
      await writeSpanToConduit({ spanId: span.spanId, agentName: span.agentName,
        toolName: span.toolName, startTime: span.startTime, endTime: span.endTime,
        taskId: this.taskId });
    }
  }
}
```

Tracing is wired at `Runner` construction and is on by default. `tracingDisabled` can be set via options if conduit is unavailable.

### Handoff Flow in CLEO Terms

```
SpawnContext { taskId: 'T582', prompt: '...', options: { tier: 'lead', handoffs: ['worker-read', 'worker-write'] } }
  ↓
OpenAiSdkSpawnProvider.spawn()
  ↓
build leadAgent = new Agent({ name: 'lead', handoffs: [workerReadAgent, workerWriteAgent] })
  ↓
runner.run(leadAgent, prompt)  // SDK handles handoff routing internally
  ↓
SpawnResult { status: 'completed', output: finalOutput }
```

The provider creates agents on demand per spawn call. Agent definitions are built from the `options.handoffs` list, which references a registry of pre-configured worker archetypes (read-only, write, bash).

---

## Coordination with T581 (Claude SDK Provider)

Both T581 and T582 build `AdapterSpawnProvider` implementations. Shared utilities should live in `packages/adapters/src/providers/shared/`:

- `cant-context.ts` — already exists and should be reused by both
- A new `shared/sdk-result-mapper.ts` can normalise SDK `RunResult` → `SpawnResult` for both providers (different SDKs, same contract shape)
- The trace-to-conduit writer (`shared/conduit-trace-writer.ts`) should be extracted and shared; both providers need audit trails

---

## Worker Tasks (6 subtasks)

**T582-1** — `guardrails.ts`: Implement `buildPathGuardrail` and `buildToolAllowlistGuardrail` using `@openai/agents` tool guardrail API. Cover Read, Write, Bash tools. Unit tests.

**T582-2** — `tracing.ts`: Implement `CleoConduitTraceProcessor` implementing the SDK `TraceProcessor` interface. Write span events to conduit.db via existing transport. Integration test with mock conduit.

**T582-3** — `spawn.ts`: Implement `OpenAiSdkSpawnProvider`. Build SDK `Agent` instances from `SpawnContext.options`, wire guardrails and trace processor, call `runner.run()`, map `RunResult` to `SpawnResult`. Unit tests with mocked SDK runner.

**T582-4** — `adapter.ts` + `install.ts` + `manifest.json`: Wire `OpenAiSdkAdapter` implementing `CLEOProviderAdapter`. Install provider writes `AGENTS.md` instruction reference. Declare capabilities (supportsSpawn: true, supportsInstall: true, supportsHooks: false initially).

**T582-5** — Handoff integration test: Spawn a lead agent with two worker handoffs. Assert the SDK routes to the correct worker and the final `SpawnResult` reflects the handoff chain. Use an MSW or SDK mock for model calls.

**T582-6** — Extract `shared/conduit-trace-writer.ts` shared utility: coordinate with T581 implementer so both providers use the same conduit write path. Add TSDoc and export from shared barrel.

---

## Open Questions for Implementer

1. **API key source**: Should `OPENAI_API_KEY` be read from env only, or also from CLEO config? Recommend env-only (consistent with other adapters).
2. **Handoff registry**: Worker archetypes (read-only, write, bash) should be declared in `manifest.json` or a `registry.ts` file — not hardcoded in spawn logic.
3. **Fire-and-forget vs await**: The existing `ClaudeCodeSpawnProvider` is fire-and-forget (detached PID). The SDK runner is awaitable. The new provider should await and return `status: 'completed'` or `status: 'failed'` — this is strictly better and matches the `SpawnResult` contract.
4. **AI SDK bridge**: If a non-OpenAI model is needed (e.g. Claude via this provider), wire the Vercel AI SDK adapter. This is optional for the initial implementation but should be noted in `manifest.json` as a capability flag.
