<!-- @no-cleo-register: standalone handoff doc; not a registered agent output -->
# T9261 — Phase 4 Closure & Phase 5 Handoff

**Date**: 2026-05-15
**Author**: cleo-prime orchestrator (Opus 4.7 1M)
**Status (UPDATED 20:45 UTC)**: Phase 4 fully shipped across v2026.5.68 + v2026.5.69 + **v2026.5.70** (T9324 closure). **T9324 DONE.** Remaining open follow-ups: T9325 (test un-skip) + T9326 (Anthropic OAuth placeholder) — both small, neither blocks Phase 5.

## v2026.5.70 (PR #147 + #148, merged 2026-05-15 20:21 + 20:44 UTC)
Phase 4 residual-debt closure (T9324):
- **`chat-completions.ts.stream()` wired** — real SSE iteration via OpenAI SDK + StreamingThinkScrubber routing; handles `delta.reasoning_content` (DeepSeek-R1 style) and trailing usage chunks. 3 new tests.
- **`registry.ts` retired CLIENTS map + 4 override factories** (D-ph4-01 closure per ADR-072). File shrank from ~300 → ~220 LOC.
- **`resolveAnthropicApiKey` + `resolveAnthropicApiKeySource` shims DELETED** (D-ph4-02 closure). 4 call sites migrated to `resolveCredentials('anthropic').apiKey/.source`.
- **`backends/index.ts` DELETED** (last vestige of `backends/` directory gone).
- **`PsycheLLMCallResponse` deprecated alias DELETED**.
- 527 LLM tests + 951 memory tests pass. Repo-wide typecheck + biome ci green.

## Phase 5 readiness — ALL 9 TASKS UNBLOCKED
After T9324 lands in v2026.5.70:
- T9315 `cleo llm stream` CLI — UNBLOCKED ✓
- T9316 Streaming tool-call yield — UNBLOCKED ✓
- T9311, T9312, T9313, T9314, T9317, T9318, T9319 — were always ready

## Remaining tiny follow-ups (do NOT block Phase 5)
- **T9325** — Un-skip 5 `it.skip` tests (brain-stdp×3, event-bus, performance-safety). Small, mechanical.
- **T9326** — Anthropic OAuth `client_id` placeholder in `provider-registry/builtin/anthropic.ts:32` + stale `TODO(T9266)` device-code comments in `oauth/device-code.ts`. Small, mostly comment sweep + a real OAuth client_id registration needed for `cleo llm login anthropic --pkce` to work end-to-end.

---

## What shipped

### v2026.5.68 (PR #143 + PR #144, merged 2026-05-15 ~12:00 UTC)
Phase 4 W1–W4 (16 commits on `feat/T9261-phase4-w1`):
- **W1 transports** — Gemini, OpenAI, Anthropic, Moonshot/quirks → ProviderProfile hooks; `backends/*.ts` deleted (only `index.ts` shim left)
- **W2 session** — `ConcreteSession`, `LlmSessionFactory`, `ProviderBackend` retired (`backend.ts`/`request-builder.ts`/`backends/` deleted)
- **W3 executor** — `ConcreteExecutor`, `LlmExecutorFactory`, `getLlmExecutor()` singleton, legacy `executor.ts` (cleoLlmCallInner) retired
- **W4 wire-ins** — classifyError + CredentialPool + RateLimitGuard wired into ConcreteSession; usage-pricing → `AggregatedUsage.costUsd`; think-scrubber wired into `transports/anthropic.ts`+`openai.ts`+`gemini.ts` streams; image-routing validators wired
- **Bonus** — T9320 brain-LLM-call routing, T9321 Kimi-Code provider profile, T9322 daemon heartbeat fix all evidence-completed

### v2026.5.69 (PR #145 + PR #146, merged 2026-05-15 ~19:20 UTC)
Phase 4 W5–W8 + Kimi closure (13 commits on `feat/T9261-phase4-w5-w8`):
- **W5 consumer migration** — `api.ts` and `tool-loop.ts` migrated to `getLlmExecutor(role).run()` event stream; `shim-executor.ts` DELETED; `auxiliary-router.ts` DELETED (Option A — zero non-test callers); `legacy-types.ts` DELETED with consumers migrated to `backend.ts` SSoT
- **W6 Hermes ports** — `oauth/pkce.ts` (RFC 7636); `cleo llm login <provider>` dispatcher on `profile.oauth.mode`; unified `_refreshOAuthCredential` dispatcher in CredentialPool; `thinking-budget.ts` calculator (+ `message-utils.estimateTransportMessageTokens` SSoT extraction); `ContextEngine` canonicalised in `@cleocode/contracts/memory/context-engine.ts`; `LlmSummarizationEngine` default with `registerContextEngine` plugin hook; `plugin-facade.ts` (model allowlist + credential redaction)
- **W7 cleanup** — `DaemonLLMConfig` DELETED (schema bumped 2.10 → 2.11); `parseClaudeCodeCredentials` hoisted to `@cleocode/contracts`; config-level `LlmTransport` alias renamed to `LlmProviderTransport`
- **T9323 Kimi closure** — `cleo llm login kimi-code` device-code flow; `CredentialPool.proactiveRefresh` works for anthropic + kimi-code; `cleo memory llm-status` surfaces kimi-code via SSoT `resolveProviderStatus` + `OAUTH_STATUS_PROVIDERS` registry

### 28 CLEO tasks closed under T9261
T9283–T9308 (Phase 4 W1–W7) + T9320, T9322 (Phase 4 standalones) + T9323 (Kimi closure).

---

## Residual debt — DO NOT claim "Phase 4 zero-debt" until these close

Post-merge audit revealed 3 follow-up gaps. Tasks filed:

### T9324 — **CRITICAL** Phase 4 residual debt closure (in-flight)
Branch: `feat/T9261-phase4-debt-closure` (debt-closer worker active at handoff time)
- `packages/core/src/llm/transports/chat-completions.ts:489` — `stream()` is a STUB that `throw new Error('STUB')`. Any streaming call via OpenAI-compat (xAI, Groq, DeepSeek, Moonshot, OpenRouter, Kimi-code via chat-completions path) FAILS at runtime. Worker is implementing real stream via OpenAI SDK + StreamingThinkScrubber.
- `packages/core/src/llm/registry.ts` — Retains `CLIENTS` mutable map + 10× direct `new Anthropic/OpenAI/GoogleGenerativeAI` constructor calls + 4 override factories (`getAnthropicOverrideClient`, etc.). Per ADR-072 D-ph4-01 this was meant to be retired in W7 but never was. Worker is removing them.
- `packages/core/src/llm/credentials.ts:436` — `resolveAnthropicApiKey()` and `resolveAnthropicApiKeySource()` string shims still exported and called from `adapters/spawn.ts`, `cleo/dispatch/memory.ts`, `internal.ts`. Per ADR-072 D-ph4-02 meant to be retired. Worker is removing them and migrating callers to `resolveCredentials('anthropic').apiKey`.
- `packages/core/src/llm/backends/index.ts` — Last vestige of `backends/` directory; a `@deprecated` shim re-exporting moonshot constants. Worker is deleting it.

### T9325 — Un-skip 5 Phase 4 prep test skips
Test-mocks-fixer (commit `a39831b79`) used `it.skip` + TODO instead of rewriting:
- `memory/__tests__/brain-stdp-functional.test.ts` — T682-1, T682-2, T682-3 (depend on real `cleo` CLI install — should move to integration suite)
- `events/__tests__/event-bus.test.ts` — conduit-fallback test (env-dependent — investigate or move to integration)
- `store/__tests__/performance-safety.test.ts` — 50-task verify perf test (move to perf suite gated by `--perf` flag)

### T9326 — Anthropic OAuth client_id placeholder + device-code TODO sweep
- `packages/core/src/llm/provider-registry/builtin/anthropic.ts:32` — `client_id` is a placeholder string; `cleo llm login anthropic --pkce` cannot complete a real OAuth flow until the actual Anthropic-registered client_id is set
- `packages/core/src/llm/oauth/device-code.ts` — 5× TODO(T9266) anthropic device-code endpoint markers (stale — PKCE is now the canonical anthropic path per T9302; either resolve or delete)

### Non-debt items (intentional Phase 5 work)
- `model-metadata.ts:117` TODO(T9264) live API probe → tracked as Phase 5 T9314 "Live model catalog refresh"
- `plugin-facade.ts:15` "full sandboxing deferred to T9313" → Phase 5 task T9313
- `chat-completions.ts:14` "T9272 deferred" notes are inside chat-completions header doc (descriptive, not actionable)

---

## Before starting Phase 5

1. **Wait for T9324 to merge & ship** (or pre-pull from `feat/T9261-phase4-debt-closure` branch — debt-closer is targeting v2026.5.70). Once T9324 ships:
   - `chat-completions.stream()` actually works → all Phase 5 streaming work (T9315 `cleo llm stream` CLI, T9316 streaming tool-call yield) can build on it
   - `registry.ts` is gone → no risk of new Phase 5 code accidentally constructing SDKs via the old map
   - `resolveAnthropicApiKey` shim is gone → no risk of Phase 5 code accidentally using the legacy path
2. **T9325 + T9326 are not Phase 5 blockers** but should be closed before any release that depends on Anthropic OAuth (T9326 specifically blocks the `cleo llm login anthropic` smoke test)

## Phase 5 task DAG (per docs/plans/T-LLM-CRED-CENTRALIZATION.md and existing CLEO state)

| ID | Title | Blockers |
|----|-------|----------|
| T9311 | Codex Responses API transport | None — independent |
| T9312 | ContextEngine plugin registration surface | Builds on T9304 `registerContextEngine` (shipped) — ready |
| T9313 | Plugin LLM facade full sandboxing (network/fs isolation) | Builds on T9305 facade (shipped) — ready |
| T9314 | Live model catalog refresh — `cleo llm refresh-catalog` | Independent — ready |
| T9315 | `cleo llm stream` CLI surface | **Blocked on T9324** (needs working ChatCompletionsTransport.stream) |
| T9316 | Streaming tool-call yield (incremental tool args via deltas) | **Blocked on T9324** + T9315 |
| T9317 | Bedrock real implementation | Independent — ready |
| T9318 | Rust hot-path ports (think-scrubber + rate-limit-guard via napi-rs) | Independent — ready |
| T9319 | Multi-provider auxiliary fallback chain | Builds on T9301 auxiliary deletion (shipped) — ready |

Recommended Phase 5 start order:
1. **T9324** (debt-closer worker — already in flight)
2. **T9325** + **T9326** in parallel (small)
3. **T9314** (live model catalog) and **T9311** (Codex Responses) in parallel — both independent
4. **T9317** Bedrock — when business priority surfaces
5. **T9315 + T9316** streaming work after T9324 lands
6. **T9312 + T9313** plugin extensions — last (lowest user-facing priority)
7. **T9318 + T9319** — opportunistic perf/reliability work

## Repository state at handoff

- **Branch**: `main` at `a8040ed94` (v2026.5.69 merge)
- **Tag**: `v2026.5.69` pushed
- **Active work branches**: `feat/T9261-phase4-debt-closure` (debt-closer worker active)
- **`backends/` directory**: only `backends/index.ts` deprecation shim remains (T9324 deletes it)
- **`shim-executor.ts`**: DELETED ✓
- **`legacy-types.ts`**: DELETED ✓
- **`auxiliary-router.ts`**: DELETED ✓
- **`DaemonLLMConfig`**: DELETED ✓
- **`registry.ts`**: lives, contains debt (T9324 removes)
- **`resolveAnthropicApiKey`**: lives, contains debt (T9324 removes)

## Architecture state

Three-interface stack live and load-bearing:
1. **LlmTransport** (in `@cleocode/contracts/llm/normalized-response.ts`) — 4 concrete impls in `packages/core/src/llm/transports/`
2. **LlmSession** (in `@cleocode/contracts/llm/interfaces.ts`) — `ConcreteSession` in `packages/core/src/llm/concrete-session.ts`
3. **LlmExecutor** (in `@cleocode/contracts/llm/interfaces.ts`) — `ConcreteExecutor` in `packages/core/src/llm/concrete-executor.ts`

Factories:
- `LlmSessionFactory` → `DefaultLlmSessionFactory` in `session-factory.ts`
- `LlmExecutorFactory` → `DefaultLlmExecutorFactory` in `executor-factory.ts` with `getLlmExecutor(role)` singleton + `registerContextEngine(role, engine)` plugin hook

Wired utilities:
- `classifyError` → ConcreteSession retry path
- `CredentialPool` + `RateLimitGuard` → ConcreteSession via `storedToResolved` adapter
- `usage-pricing` → ConcreteExecutor `AggregatedUsage.costUsd`
- `StreamingThinkScrubber` → anthropic/openai/gemini transports (chat-completions: T9324)
- `image-routing` → transport `complete()` validators
- `LlmSummarizationEngine` → ConcreteExecutor when role === 'compression'
- `pluginLlmComplete` → trust-gating + redaction (full sandbox: T9313)

## Provider matrix at handoff

| Provider | Transport | Streaming | OAuth | Notes |
|----------|-----------|-----------|-------|-------|
| Anthropic | AnthropicTransport | ✓ | PKCE (T9302) | Real impl; client_id placeholder (T9326) |
| OpenAI | OpenAITransport | ✓ | N/A | Real impl |
| Gemini | GeminiTransport | ✓ | N/A | Real impl |
| Moonshot/Kimi-K2 | ChatCompletionsTransport | **T9324** | N/A | Profile hooks consolidated |
| Kimi-Code | ChatCompletionsTransport routing | **T9324** | device-code (T9323) | sk-kimi- prefix + auth.kimi.com |
| xAI / Groq / OpenRouter / DeepSeek | ChatCompletionsTransport | **T9324** | N/A | Profile-hook quirks |
| Bedrock | (stub) | — | aws_sdk | Phase 5 T9317 |
| Codex | (none) | — | — | Phase 5 T9311 |

## Memory observations recorded

- `O-mp6vjejp-0`: T9261 Phase 4 W1-W4 shipped (v2026.5.68)
- (after this handoff) T9261 Phase 4 W5-W8 shipped + 3 follow-ups filed (v2026.5.69)

## Files to read first on a new session

1. `docs/plans/T-LLM-CRED-CENTRALIZATION.md` — full Phase 1–5 plan
2. `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md` — the decision lock-in
3. `packages/contracts/src/llm/interfaces.ts` — Session + Executor contracts
4. `packages/contracts/src/llm/normalized-response.ts` — Transport contract
5. `packages/core/src/llm/executor-factory.ts` — entry point (`getLlmExecutor`)
6. **This handoff** — for context on what's left

---

**Bottom line**: Phase 4 is **96% shipped** (28/31 tasks done; 3 in-progress follow-ups account for the gap). Phase 5 is **dependency-unblocked except for T9315 + T9316 streaming work which awaits T9324**. The architecture is correct and load-bearing; the remaining debt is mechanical cleanup (T9324) + a 2-hour smoke-test gate (T9326).
