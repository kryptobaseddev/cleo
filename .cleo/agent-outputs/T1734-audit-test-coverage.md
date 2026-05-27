# T1734 Audit — LLM test coverage gaps

Auditor: independent parallel subagent (not T1734 worker).
Date: 2026-05-02
Scope: `packages/core/src/llm/__tests__/` + `packages/core/src/llm/backends/__tests__/` (if present).

---

## Test files surveyed

| File | Mocking strategy | Surface tested |
|---|---|---|
| `llm/__tests__/llm-layer.test.ts` | **Partial mock** — `MoonshotBackend` section uses `vi.fn().mockResolvedValue(...)` to stub `chat.completions.create`. All other describe blocks import pure helpers (no OpenAI client created at all). | `usesMaxCompletionTokens` (pure unit), `OpenAIHistoryAdapter` (pure unit), `MoonshotBackend.complete` (mocked client), `MoonshotBackend` thinkingBudgetTokens rejection (mocked client — never reaches SDK), stream thinkingBudgetTokens rejection (mocked client) |
| `llm/__tests__/credentials.test.ts` | **No mock of openai SDK** — tests the credential resolution chain only (env vars, config files, XDG paths). No backend or client is instantiated. | `resolveCredentials`, `resolveAnthropicApiKey`, `storeAnthropicApiKey` — no openai SDK surface |
| `llm/backends/__tests__/` | **Does not exist** — no backend-specific test directory. | — |

Additional test files that reference openai strings but do not exercise the openai SDK backend:

| File | What it tests |
|---|---|
| `config/__tests__/llm-daemon-config.test.ts` | Accepts `"openai"` as a valid provider name string — pure config validation, no SDK. |
| `metrics/__tests__/model-provider-registry.test.ts` | Tests `resolveProviderFromModelIndex` with `"openai"` as a string key — pure data lookup, no SDK. |

---

## Production call sites in backends/openai.ts (and backends/moonshot.ts)

| File:line | Call shape | Real-call test? | Mocked test? | No coverage? |
|---|---|---|---|---|
| `openai.ts:162` | `this._client.chat.completions.create(reqParams)` — structured-output (json_schema) non-streaming | No | No | **YES** |
| `openai.ts:193` | `this._client.chat.completions.create(reqParams)` — standard non-streaming completion | No | **Yes** (via MoonshotBackend mock — delegates to OpenAIBackend.complete) | — |
| `openai.ts:260` | `this._client.chat.completions.create(reqParams)` — streaming, returns `AsyncIterable<ChatCompletionChunk>` | No | No | **YES** |
| `openai.ts:267-289` | Chunk iteration loop: `delta.content`, `finish_reason`, `usage` chunk (stream_options) | No | No | **YES** |
| `openai.ts:317-320` | `max_completion_tokens` branch in `_buildParams` (o-series / gpt-5) | No | No (unit test for `usesMaxCompletionTokens` helper only — the actual `reqParams` mutation is untested with a real or mocked call) | **YES** |
| `openai.ts:350-367` | `_normalizeResponse` — tool_calls extraction, JSON.parse of arguments | No | **Partial** (MoonshotBackend mock returns no tool_calls so this branch is untested) | **YES** |
| `openai.ts:370-383` | `_normalizeResponse` — cache token extraction, reasoning content | No | **Partial** (mock response has no reasoning_details / prompt_tokens_details) | **YES** |
| `registry.ts:44` | `new OpenAI({ apiKey })` — default client construction | No | No | **YES** |
| `registry.ts:50` | `new OpenAI({ apiKey, baseURL: MOONSHOT_BASE_URL })` — Moonshot client construction | No | No | **YES** |
| `registry.ts:96` | `new OpenAI({ apiKey, baseURL })` — override client factory | No | No | **YES** |
| `moonshot.ts:75` | `this._delegate.complete(params)` — delegates to OpenAIBackend | No | **Yes** (one mocked test) | — |
| `moonshot.ts:86` | `yield* this._delegate.stream(params)` — delegates to OpenAIBackend.stream | No | No (stream rejection test bails before delegation) | **YES** |

---

## Coverage matrix — does the migration get full functional verification?

- **Non-streaming chat completion (standard path)**: Mocked — one test exercises `OpenAIBackend.complete` via `MoonshotBackend` with a `vi.fn()` stub. If the v6 SDK changes the `chat.completions.create` return shape, argument handling, or method signature, the test will still pass because the mock bypasses the real SDK entirely.
- **Streaming chat completion (chunk handling)**: None — no test exercises `OpenAIBackend.stream` at all. The stream thinkingBudgetTokens test throws before any SDK call is made.
- **Error class catching**: None — no test exercises SDK error types (`APIError`, `RateLimitError`, `InternalServerError`). The LLM layer relies on `p-retry` retrying on error, but no test verifies which error types trigger retry vs bubble.
- **Constructor with baseURL override (Moonshot path)**: None — `new OpenAI({ baseURL })` is called in `registry.ts:50` and `registry.ts:132` but no test instantiates the real constructor. A v6 breaking change to the constructor (e.g., renamed options field) would pass tests silently.
- **Tool-calling response handling**: None — `_normalizeResponse` tool_calls extraction path is exercised only by the mocked MoonshotBackend test which does not set `tool_calls` in the mock response, so the array-iteration branch is never reached.
- **Structured-output (json_schema) path**: None — the structured-output `complete` branch (line 162) that sets `response_format: { type: 'json_schema', ... }` has zero test coverage, mocked or real.
- **stream_options / usage chunk**: None — the `include_usage: true` stream option and the usage-chunk emission path (lines 233, 275-284) have no test coverage.

---

## Highest-value gaps

1. **Streaming chunk iteration is completely untested.** `OpenAIBackend.stream` is the primary path for interactive LLM calls. If v6 changes how `AsyncIterable<ChatCompletionChunk>` is returned (e.g., different chunk shape, different iteration protocol), the entire streaming surface would silently break. The only stream test throws before any SDK call.

2. **The `new OpenAI(...)` constructor is never called in tests.** `registry.ts` calls `new OpenAI({ apiKey, baseURL })` in four places. The v4→v6 migration may rename constructor options. Because no test touches the real constructor, a broken instantiation path (missing API key, wrong baseURL key name, dangerouslyAllowBrowser flag changes) would not be caught.

3. **`max_completion_tokens` parameter injection is tested at the helper level only.** `usesMaxCompletionTokens` correctly returns `true` for o-series models in the unit test, but the actual injection of `max_completion_tokens` into `reqParams` inside `_buildParams` (line 318) is never verified by any call-level test. If v6 renames or rejects this field, the unit test for the helper would still pass.

4. **Tool-call JSON parsing in `_normalizeResponse` is untested.** The `tool_calls` extraction branch (lines 350-367) parses `tc.function.arguments` via `JSON.parse`. No test provides a mocked response with `tool_calls` populated, so malformed-arguments handling and the entire tool-call normalization path are invisible to the test suite.

5. **Structured-output (`json_schema` response_format) path is untested.** The branch at line 147-179 that sets `response_format: { type: 'json_schema', ... }` and calls `.create()` has no test, mocked or real. This is a completely distinct code path from the standard completion.

6. **`stream_options: { include_usage: true }` chunk handling is untested.** The production code emits a final `isDone: true` chunk when a usage object appears in the stream (lines 275-284), and has a fallback for when it does not (lines 287-289). If v6 changes the chunk schema for usage reporting, neither path would be caught.

7. **Moonshot `stream` delegation is untested.** `MoonshotBackend.stream` delegates to `OpenAIBackend.stream` via `yield*`. The only stream test for Moonshot throws before reaching the delegation, so `OpenAIBackend.stream` is never exercised even via a mock for the Moonshot path.

8. **`registry.ts` `clientForModelConfig` API-key-missing guard is untested.** The `throw new Error('Missing API key...')` branch (line 158) and the `CLIENTS` module-level map initialisation are untested. If v6 changes how `OpenAI` handles a missing `apiKey`, the guard may interact differently.

---

## Recommended additions for the migration worker (or followup)

- Add a `describe('OpenAIBackend.complete — mocked client')` block that creates a `vi.fn().mockResolvedValue(...)` stub for `chat.completions.create` and asserts: (a) the correct parameter key is used (`max_tokens` vs `max_completion_tokens` for gpt-4o vs o1), (b) `result.content` matches, (c) `result.inputTokens` / `result.outputTokens` are mapped correctly from `usage.prompt_tokens` / `usage.completion_tokens`.
- Add a `describe('OpenAIBackend.stream — mocked client')` block that uses an async-generator mock for `chat.completions.create` returning synthetic `ChatCompletionChunk` objects. Assert: content chunks are yielded, a usage chunk triggers `isDone: true`, `outputTokens` is populated, the fallback `finishReason` path fires when no usage chunk arrives.
- Add a test for the tool-calling response path: mock a response with `choices[0].message.tool_calls = [{ id: 'tc1', function: { name: 'search', arguments: '{"q":"hello"}' } }]` and assert `result.toolCalls[0].name === 'search'` and `result.toolCalls[0].input.q === 'hello'`.
- Add a test for the structured-output `json_schema` branch: pass a Zod schema as `responseFormat` and verify `response_format` is set correctly in the captured request params.
- Add a smoke test for `new OpenAI({ apiKey: 'test', baseURL: 'http://localhost' })` constructibility to verify the constructor API is stable across the version being tested. This does not make a network call but will fail fast if the v6 constructor signature has breaking changes.
- Add a test for `getMoonshotOverrideClient` in `registry.ts` that verifies the `baseURL` defaults to `MOONSHOT_BASE_URL` when no override is supplied.

---

## Verdict

The existing tests are **insufficient** to catch a botched openai 4→6 migration. The entire streaming code path (`OpenAIBackend.stream`), the structured-output `json_schema` branch, the tool-call normalisation, the `stream_options` usage-chunk handling, and all `new OpenAI(...)` constructor calls in `registry.ts` have **zero test coverage** — mocked or otherwise. The only mocked test that exercises `OpenAIBackend.complete` (via `MoonshotBackend`) uses a hand-rolled `{ chat: { completions: { create: vi.fn() } } }` object that completely bypasses the real SDK, so it is immune to any v6 type-shape or API-surface changes. A migration that leaves streaming broken, silently truncates tool-call arguments, or misroutes structured-output requests would produce a fully green test run against the current suite. The current tests verify adapter logic in isolation but provide no signal about whether the openai SDK wire protocol is correctly consumed at version 6.
