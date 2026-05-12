# T1386 Explorer Map — PSYCHE LLM Layer Port

**Generated:** 2026-04-24
**Source:** `/mnt/projects/honcho/src/llm/` (14 files, 3851 LOC Python)
**Target:** `packages/core/src/llm/` (new directory)
**Existing thin resolver:** `packages/core/src/memory/llm-backend-resolver.ts` (266 LOC, Vercel AI SDK path — stays)

---

## TL;DR (8 bullets)

- 14 files, 3851 LOC: registry → backend adapters → request_builder → executor → tool_loop → api, with caching, conversation truncation, history adapters, structured output, runtime config.
- `@anthropic-ai/sdk ^0.88.0` already in `packages/core/package.json`. **4 new npm deps required**: `openai`, `@google/generative-ai`, `p-retry`, `jsonrepair`.
- Existing `llm-backend-resolver.ts` (266 LOC) is on Vercel AI SDK path for `generateObject()` — orthogonal to new raw-SDK orchestration layer. **Both coexist; do NOT delete the resolver.**
- Dependency graph splits cleanly into 7 build waves enabling parallelism: types+backend → 5 small modules → 3 backends+request-builder → registry → runtime → executor → tool-loop → api.
- `tool_loop.py` (491 LOC) uses `tenacity` exponential backoff — TS equivalent `p-retry`. Tool calls **sequential** not parallel. Empty-response retry (max 1) and `tool_choice` `required→auto` after iter 0 are critical invariants.
- `structured_output.py` uses custom `validate_and_repair_json` — port to `jsonrepair` (josdejong). `PromptRepresentation` special-case becomes generic `repairHook?` option.
- **Claude 4 class assistant-prefill rejection** is a critical correctness invariant: `claude-sonnet-4-6` (CLEO primary) does NOT support assistant-prefill. JSON schema injection MUST use non-prefill path.
- 15 worker tasks proposed (W1-W15). W5 Gemini backend = highest risk (SDK surface divergence). W11 tool-loop = largest. W14 caller migration does NOT delete resolver.

---

## Per-File Mapping (Honcho .py → CLEO .ts)

| Honcho file | LOC | CLEO target | Est TS LOC | Wave | Notes |
|-------------|-----|-------------|------------|------|-------|
| `types.py` | 138 | `llm/types.ts` | 100-120 | A | leaf module; Pydantic→Zod |
| `backend.py` | 88 | `llm/backend.ts` | 70-90 | A | pure interface |
| `credentials.py` | 25 | `llm/credentials.ts` | 60-80 | B | imports existing `anthropic-key-resolver.ts` |
| `caching.py` | 97 | `llm/caching.ts` | 90-110 | B | Gemini-only; Map+LRU; node:crypto sha256 |
| `conversation.py` | 185 | `llm/conversation.ts` | 160-200 | B | uses `js-tiktoken` (already a dep) |
| `history_adapters.py` | 137 | `llm/history-adapters.ts` | 120-150 | B | three provider adapters |
| `structured_output.py` | 132 | `llm/structured-output.ts` | 110-140 | B | needs `jsonrepair` dep; 3-tier fallback |
| `request_builder.py` | 119 | `llm/request-builder.ts` | 100-130 | C | depends on backend.ts |
| `backends/anthropic.py` | 347 | `llm/backends/anthropic.ts` | 290-340 | C | SDK already a dep; **Claude 4 prefill check critical** |
| `backends/openai.py` | 427 | `llm/backends/openai.ts` | 360-420 | C | needs `openai` v4.x dep |
| `backends/gemini.py` | 577 | `llm/backends/gemini.ts` | 480-560 | C | needs `@google/generative-ai`; **highest risk** |
| `registry.py` | 185 | `llm/registry.ts` | 150-180 | D | singleton clients via Map |
| `runtime.py` | 236 | `llm/runtime.ts` | 190-230 | E | `ContextVar`→`AsyncLocalStorage` or simpler ref |
| `executor.py` | 226 | `llm/executor.ts` | 190-230 | F | uses request-builder + runtime |
| `tool_loop.py` | 491 | `llm/tool-loop.ts` | 420-500 | G | uses `p-retry`; sequential tool exec |
| `api.py` | 366 | `llm/api.ts` | 300-360 | H | public `cleoLlmCall()` entry; Langfuse decorators removed |

**Total**: 14 source files, 3851 LOC → ~3200-3900 LOC TypeScript across 18 files (incl. `index.ts` + `backends/index.ts`).

---

## Dependency Graph (Wave Order)

```
Wave A (parallel): types.ts + backend.ts + W13 contracts
Wave B (parallel): credentials.ts + caching.ts + history-adapters.ts + conversation.ts + structured-output.ts
Wave C (parallel): backends/anthropic.ts + backends/openai.ts + backends/gemini.ts + request-builder.ts
Wave D: registry.ts (after C: needs all backends)
Wave E: runtime.ts (after D: needs registry)
Wave F: executor.ts (after E: needs request-builder + runtime + registry)
Wave G: tool-loop.ts (after F: needs executor + conversation)
Wave H: api.ts + index.ts (after G: needs tool-loop)
Wave I: W14 migrate callers + W15 tests
```

---

## External Library Mapping (4 NEW npm deps)

| Honcho (Python) | CLEO (TS) | Status |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk ^0.88.0` | Already in package.json |
| `openai` (Python) | `openai ^4.x` (npm) | **NEW DEP** |
| `google-generativeai` / `google.genai` | `@google/generative-ai` | **NEW DEP** — highest risk |
| `pydantic.BaseModel` | `zod` | Already in package.json |
| `tenacity` | `p-retry ^6.x` | **NEW DEP** |
| `cachetools` | `Map` (insertion-order) | No dep needed |
| `hashlib` | `node:crypto` | Built-in |
| `json_repair` | `jsonrepair ^3.x` (josdejong) | **NEW DEP** |
| `langfuse` | no-op | Skip |
| `sentry_sdk.ai.monitoring.ai_track` | no-op | Skip |
| `src.utils.tokens.estimate_tokens` | `js-tiktoken` | Already in package.json |
| `contextvars.ContextVar` | `AsyncLocalStorage` (node:async_hooks) | Built-in |

---

## 15 Worker Tasks (T1386 Decomposition)

| ID | Title | Size | Wave | Files | Acceptance |
|----|-------|------|------|-------|------------|
| W1 | types.ts | small | A | `packages/core/src/llm/types.ts` | Port `types.py` 138 LOC; `ModelConfig`, `ModelTransport`, `PromptCachePolicy`, `LLMCallResponse<T>`, `LLMStreamChunk`, `IterationData`, `IterationCallback` exported |
| W2 | backend.ts | small | A | `packages/core/src/llm/backend.ts` | Port `backend.py` 88 LOC; `ProviderBackend` interface + `ToolCallResult`, `CompletionResult`, `StreamChunk` |
| W3 | backends/anthropic.ts | medium | C | `packages/core/src/llm/backends/anthropic.ts` | Port `anthropic.py` 347 LOC; **Claude 4 prefill rejection MUST be exact**; cache_control: ephemeral |
| W4 | backends/openai.ts | medium | C | `packages/core/src/llm/backends/openai.ts` + add `openai ^4.x` dep | Port `openai.py` 427 LOC; max_completion_tokens vs max_tokens distinction for o-series/gpt-5 |
| W5 | backends/gemini.ts | medium-large | C | `packages/core/src/llm/backends/gemini.ts` + add `@google/generative-ai` dep | Port `gemini.py` 577 LOC; message format conversion + caching API; **highest risk** |
| W6 | registry.ts | small | D | `packages/core/src/llm/registry.ts` | Port `registry.py` 185 LOC; singleton clients via Map; override clients keyed by `${baseUrl}::${apiKey}` |
| W7 | caching.ts | small | B | `packages/core/src/llm/caching.ts` | Port `caching.py` 97 LOC; `InMemoryGeminiCacheStore` (no threading needed); sha256 cache keys |
| W8 | credentials + history-adapters + conversation + request-builder | medium combined | B+C | 4 files | Port 25+137+185+119=466 LOC; group small/medium modules |
| W9 | executor.ts | medium | F | `packages/core/src/llm/executor.ts` | Port `executor.py` 226 LOC; orchestrates registry+request-builder+runtime |
| W10 | structured-output.ts | medium | B | `packages/core/src/llm/structured-output.ts` + add `jsonrepair` dep | Port `structured_output.py` 132 LOC; 3-tier fallback (direct→repair→policy); generic `repairHook?` instead of PromptRepresentation special-case |
| W11 | tool-loop.ts | large | G | `packages/core/src/llm/tool-loop.ts` + add `p-retry` dep | Port `tool_loop.py` 491 LOC; iteration retry + empty-response retry (max 1) + tool-result accumulation; sequential tool exec |
| W12 | runtime.ts | medium | E | `packages/core/src/llm/runtime.ts` | Port `runtime.py` 236 LOC; AttemptPlan, current_attempt counter (use simple ref or AsyncLocalStorage), Langfuse stubbed |
| W13 | contracts/operations/llm.ts | small | A | `packages/contracts/src/operations/llm.ts` (new) | Export `ModelTransport`, `ModelConfig`, `LLMCallParams`, `LLMCallResult`, `ToolCallParams`, `ToolCallResult` |
| W14 | Migrate `llm-backend-resolver.ts` callers | medium | I | grep callers + update | Do NOT delete resolver. Update only NEW consumers (dialectic, dreamer, reconciler) to use `cleoLlmCall()`. Existing extraction-pipeline callers stay on Vercel AI SDK path. |
| W15 | Tests | medium-large | I | `packages/core/src/llm/__tests__/*.test.ts` | 30+ unit tests: cache key determinism, JSON repair fallback, tool-loop edge cases, empty-response retry, max-iterations synthesis, provider switching on fallback |

---

## Risk Callouts

### R1 — Anthropic SDK API drift (LOW)
SDK already a dep. Stream API: TS uses `client.messages.stream(params)` returning async iterable + `stream.finalMessage()`. Well-documented.

### R2 — Claude 4 prefill rejection (MEDIUM, correctness-critical)
`AnthropicBackend._supports_assistant_prefill(model)` returns `False` for `claude-opus-4*`, `claude-sonnet-4*`, `claude-haiku-4*`. CLEO primary `claude-sonnet-4-6` will NOT support prefill. JSON schema injection MUST use non-prefill path. **Correctness bug if omitted.**

### R3 — OpenAI npm v4 vs v3 (MEDIUM)
v4.x has different streaming interface. Pin `"openai": "^4.0.0"`.

### R4 — Gemini SDK divergence (HIGH)
`@google/generative-ai` v0.x vs v1+ differ. Honcho uses `google.genai` v1 Python. Caching API `client.caches.create()` may not exist in all versions. **Assign experienced backend porter to W5.**

### R5 — AsyncLocalStorage vs ContextVar (LOW)
Simple `{ value: 1 }` ref by reference is sufficient for `current_attempt`. AsyncLocalStorage only needed if true cross-async isolation required.

### R6 — Tool-loop hang (LOW)
Sequential tool calls; if one hangs, loop hangs. **Enhancement opportunity**: wrap `tool_executor` in `Promise.race([call, timeoutPromise(30_000)])`. Honcho doesn't do this.

### R7 — Cache key determinism (LOW)
`JSON.stringify` does NOT guarantee key order. Use recursive `sortKeys(payload)` utility before stringify. Small inline impl, no dep.

### R8 — Streaming pattern split (MEDIUM)
Vercel AI SDK `streamText()` (existing in some places) vs raw SDK streaming (new layer). MUST NOT mix. New `index.ts` barrel must NOT export types conflicting with Vercel AI SDK.

### R9 — Test fixtures (assess before W15)
Check `/mnt/projects/honcho/tests/llm/` for VCR cassettes/recorded responses. Worth porting as mock fixtures for W15.

---

## Migration for `llm-backend-resolver.ts` Callers (W14)

**W14 worker first action**:
```bash
grep -r "llm-backend-resolver\|resolveLlmBackend\|isOllamaAvailable" \
  /mnt/projects/cleocode/packages/ --include="*.ts" -l
```

**Predicted callers** (verify with grep):
- `packages/core/src/memory/auto-extract.ts` — Vercel path, **leave as-is**
- `packages/core/src/memory/transcript-extractor.ts` — Vercel path, **leave as-is**
- `packages/core/src/memory/llm-extraction.ts` — uses `@anthropic-ai/sdk` directly, **leave as-is** (optional follow-up: refactor to use new `AnthropicBackend`)
- Future dialectic-evaluator (T1087) — **wire to `cleoLlmCall()`**

**Key**: `llm-backend-resolver.ts` STAYS. It's not redundant. New layer is for dialectic/dreamer/reconciler pipelines; resolver is for Vercel AI SDK `generateObject()` callers.

---

## File Creation List

```
packages/core/src/llm/
  index.ts                    ← barrel (W6 or final wave)
  types.ts                    ← W1
  backend.ts                  ← W2
  credentials.ts              ← W8
  caching.ts                  ← W7
  conversation.ts             ← W8
  history-adapters.ts         ← W8
  request-builder.ts          ← W8
  registry.ts                 ← W6
  runtime.ts                  ← W12
  executor.ts                 ← W9
  structured-output.ts        ← W10
  tool-loop.ts                ← W11
  api.ts                      ← (final, depends on tool-loop)
  backends/
    anthropic.ts              ← W3
    openai.ts                 ← W4
    gemini.ts                 ← W5
    index.ts                  ← barrel

packages/contracts/src/operations/llm.ts  ← W13

packages/core/package.json    ← add openai + @google/generative-ai + p-retry + jsonrepair
```

**Files NOT modified**:
- `packages/core/src/memory/llm-backend-resolver.ts` — stays (Vercel AI SDK path)
- `packages/core/src/memory/anthropic-key-resolver.ts` — stays; imported by new `credentials.ts`
- `packages/core/src/memory/llm-extraction.ts` — stays (uses Anthropic SDK directly)

---

## Tool-Loop Iteration Semantics (W11 critical)

```
while iteration < maxToolIterations (1-100):
  1. Reset currentAttempt to 1
  2. Truncate conversation if max_input_tokens set
  3. LLM call with tools (with p-retry if enable_retry)
  4. Accumulate tokens
  5. If no tool calls:
     a. If empty content AND empty_response_retries < 1 AND not at max: nudge + continue
     b. If stream_final: return StreamingResponseWithMetadata
     c. Else patch + return
  6. If tool calls:
     a. Format assistant msg via HistoryAdapter
     b. Execute tools SEQUENTIALLY (not parallel)
     c. Append tool results
     d. Fire iteration_callback
     e. iter==0 + tool_choice='required'/'any' → switch to 'auto'
     f. iteration++

On max_iterations: append synthesis prompt, final tool-less call, return
```

Tool errors → `{ is_error: true, result: "Error: ..." }` tool result. Loop never aborts on tool failure.

---

## Structured Output 3-Tier Fallback (W10 critical)

```
Tier 1: validateStructuredOutput(content, schema) → if OK return
Tier 2: jsonrepair(rawContent) → JSON.parse → schema.parse → if OK return
Tier 3: policy-driven:
  'repair_then_empty' → emptyStructuredOutput(schema) (schema.parse({}))
  'raise' → throw StructuredOutputError
  'repair_then_raise' → throw at Tier 2 failure
```

`PromptRepresentation` special-case in Honcho becomes generic `repairHook?: (data: unknown) => unknown` option in TS port.
