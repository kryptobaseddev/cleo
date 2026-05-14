---
id: ADR-072
title: Unified LLM Provider Architecture — Three-Interface Stack (Transport / Session / Executor)
status: Accepted (committed via Wave 0a / T9280 PR)
date: 2026-05-14
task: T9280
linkedTasks: [T9261, T9281, T9282, T9283]
supersedes: null
supersededBy: null
---

# ADR-072: Unified LLM Provider Architecture — Three-Interface Stack

**Status:** Accepted (committed via Wave 0a / T9280 PR)
**Date:** 2026-05-14
**Task:** T9280
**Linked Tasks:** T9261, T9281, T9282, T9283

## Context

Phase 1 (ADR-TBD, shipped v2026.5.x) fixed the daemon 401 by introducing
`ResolvedCredential` and patching six broken call-sites. Phase 2 added
`resolveLLMForRole`, a credential store, and the `cleo llm` CLI. Phase 3
ported the Hermes plugin registry, device-code OAuth, and credential-pool
failover from `hermes-agent`.

After Phases 1-3, CLEO has:
- A `ResolvedCredential` type and resolver in `packages/contracts/src/llm/credential.ts`
- A `LlmRole` enum and `resolveLLMForRole()` in `packages/core/src/llm/role-resolver.ts`
- A `CredentialPool` with rotation strategies in `packages/core/src/llm/credential-pool.ts`
- A `ProviderProfile` plugin registry in `packages/core/src/llm/provider-registry.ts`
- Multiple legacy entry-points that still construct raw `Anthropic({apiKey})` clients

What the system still lacks after Phase 3:

1. **No unified transport abstraction** — raw fetch paths, Anthropic SDK paths, and
   Bedrock SDK paths all diverge; adding a new provider requires touching 6-10 files.
2. **No typed session object** — multi-turn conversations have no shared state carrier
   between call-sites (context window, turn history, token counts).
3. **No executor contract** — the agent loop in `sentient/dream-cycle.ts`,
   `memory/sleep-consolidation.ts`, and future orchestrator workers all re-implement
   the same "pick role → resolve credential → build client → call → parse" pattern.
4. **Provider-hardcoded model strings still exist outside `packages/core/src/llm/`**
   — grep shows 12 remaining occurrences in non-llm files.

This ADR locks the Phase 4 architecture that eliminates all four gaps.

---

## Decision

Adopt a **three-interface architecture** that layers cleanly on top of Phase 1-3:

```
┌───────────────────────────────────────────────────────────────┐
│                        LlmExecutor                            │
│  execute(role, messages, opts) → AsyncIterable<ExecutorChunk> │
│  Uses: LlmRole → ProviderProfile → LlmSession                 │
├───────────────────────────────────────────────────────────────┤
│                        LlmSession                             │
│  send(messages, opts) → AsyncIterable<SessionChunk>           │
│  Tracks: turn history, token counts, context budget           │
├───────────────────────────────────────────────────────────────┤
│                       LlmTransport                            │
│  request(payload) → AsyncIterable<TransportChunk>             │
│  Owns: HTTP/SDK wiring, auth headers, retry logic             │
└───────────────────────────────────────────────────────────────┘
         ↑                   ↑                   ↑
  AnthropicTransport  BedrockTransport   OpenAICompatTransport
```

### Interface contracts

#### LlmTransport

```typescript
export interface LlmTransport {
  readonly provider: ModelTransport;
  readonly profile: ProviderProfile;

  /**
   * Send a raw request payload to the provider and stream raw chunks.
   * Implementations own retries, auth header injection, and error normalization.
   */
  request(
    payload: TransportRequestPayload,
    signal?: AbortSignal,
  ): AsyncIterable<TransportChunk>;

  /**
   * Non-streaming round-trip. Default impl collects request() into one response.
   */
  call(
    payload: TransportRequestPayload,
    signal?: AbortSignal,
  ): Promise<NormalizedResponse>;

  /** Whether this transport can handle the given credential. */
  supportsCredential(cred: ResolvedCredential): boolean;

  /**
   * Given an error from a request, return true if the executor should rotate
   * to the next credential in the pool for this provider.
   * Typically true for 401, 403, 429, and 402 HTTP errors.
   * Named `shouldRotateCredential` (not the bare-word `shouldRotate`) to avoid
   * collision with other `should*` predicates on the transport.
   */
  shouldRotateCredential(err: TransportError): boolean;

  /** Health check — low-cost probe (e.g. list models or small message). */
  ping(): Promise<PingResult>;
}
```

#### LlmSession

```typescript
export interface LlmSession {
  readonly transport: LlmTransport;
  readonly model: string;
  readonly contextBudget: number;
  readonly tokensUsed: number;
  readonly turnHistory: readonly NormalizedMessage[];

  /**
   * Send the next turn. Appends user message + assistant response to turnHistory.
   * Returns the normalized response for this turn.
   */
  send(
    messages: NormalizedMessage[],
    opts?: SessionSendOptions,
  ): Promise<NormalizedResponse>;

  /**
   * Streaming variant. Yields chunks; final chunk has finish_reason.
   */
  stream(
    messages: NormalizedMessage[],
    opts?: SessionSendOptions,
  ): AsyncIterable<SessionChunk>;

  /**
   * Estimate how many tokens remain before context overflow.
   * Returns contextBudget - tokensUsed - estimatedNextTurnTokens.
   */
  remainingBudget(estimatedNextTurnTokens?: number): number;

  /**
   * Summarize and compress turnHistory to free context space.
   * Uses the `compression` role for the summarization call.
   */
  compress(opts?: CompressionOptions): Promise<void>;
}
```

#### LlmExecutor

```typescript
export interface LlmExecutor {
  /**
   * Primary entry-point for role-based LLM execution.
   * Resolves credentials, picks a transport, opens a session, executes.
   */
  execute(
    role: LlmRole,
    messages: NormalizedMessage[],
    opts?: ExecutorOptions,
  ): Promise<NormalizedResponse>;

  /**
   * Streaming variant. Yields ExecutorChunk (wraps SessionChunk + role metadata).
   */
  stream(
    role: LlmRole,
    messages: NormalizedMessage[],
    opts?: ExecutorOptions,
  ): AsyncIterable<ExecutorChunk>;

  /**
   * Open a named session for multi-turn use.
   * Session is bound to the credential + model resolved for `role` at call time.
   */
  openSession(role: LlmRole, opts?: SessionOptions): Promise<LlmSession>;

  /**
   * Rotate to the next credential in the pool for the given role's provider.
   * Call when a session encounters a 401 or 429.
   */
  rotate(role: LlmRole): Promise<void>;
}
```

---

## Options evaluated

### Option A — Thin adapter shim (rejected)

Wrap existing call-sites in a single `callLlm(role, messages)` function.
- Pro: Minimal change surface.
- Con: Doesn't eliminate duplicated client-construction; adding a new provider
  still requires touching multiple files. Session tracking is impossible. Rejected.

### Option B — Monolithic LlmClient class (rejected)

One class that owns credential resolution, transport, session, and execution.
- Pro: One import.
- Con: Violates SRP; testing requires mocking the entire class. Provider-specific
  logic creeps into a God object. Same pattern that caused the Phase 1 auth bugs.
  Rejected.

### Option C — Clean rewrite integrating Phase 3 foundation (CHOSEN)

Three-interface stack (Transport / Session / Executor) that builds on top of Phase 3
types rather than replacing them.
- `LlmTransport` wraps Phase 1 `ResolvedCredential` + Phase 3 `ProviderProfile`.
- `LlmSession` wraps `LlmTransport` + adds state tracking.
- `LlmExecutor` wraps Phase 2 `resolveLLMForRole` + Phase 3 `CredentialPool` + `LlmSession`.
- Pro: Clean layering. Easy to test each interface independently. New providers
  = one new `LlmTransport` implementation. Multi-turn support built in.
- Con: Larger initial surface than Option A.
- **Chosen** because the migration is integration-first: KEEP all Phase 3 work,
  wire legacy backends INTO the transports/ directory, then migrate call-sites
  one-by-one with no flag day.

---

## Migration strategy (integration-first)

The migration has no flag day. All three interfaces are additive:

1. **W0b/W0c (Contract types)** — Add `LlmTransport`, `LlmSession`, `LlmExecutor`
   interfaces to `packages/contracts/src/llm/`. All types. Zero implementation.

2. **W1 (Transport implementations)** — Implement `AnthropicTransport`,
   `BedrockTransport`, `OpenAICompatTransport` in `packages/core/src/llm/transports/`.
   Each wraps the existing Phase 1 `resolveCredential` + Phase 3 `ProviderProfile`.
   Existing call-sites are NOT yet migrated.

3. **W2 (Session + Executor)** — Implement `DefaultLlmSession` and `DefaultLlmExecutor`
   in `packages/core/src/llm/`. Wire to the transport layer. Hook into the Phase 3
   credential pool for rotation.

4. **W3-W6 (Call-site migrations)** — Migrate legacy call-sites one domain at a time
   (memory → sentient → deriver → tasks → nexus → cleo-os). Each migration:
   a. Replace `new Anthropic({apiKey})` or raw fetch with `executor.execute(role, messages)`.
   b. Delete the replaced code.
   c. Tests must stay green after each migration.
   The legacy code coexists with the new interfaces throughout W3-W6.

5. **W7 (Cleanup)** — Once all call-sites are migrated, delete the legacy transport
   helpers (`getAnthropicOverrideClient`, `initDefaultClients`, the raw fetch paths).
   Zero call-sites should remain that bypass the executor.

6. **W8 (Provider coverage + docs)** — Add missing provider transports (Gemini, Ollama,
   xAI), update `docs/specs/hermes-agent-llm-provider-architecture.md` to reflect
   final state, and update ADR-072 status.

---

## Accepted-debt ledger

The following known debts are accepted and tracked:

| ID | Debt | Resolution wave |
|----|------|-----------------|
| D-ph4-01 | `CLIENTS` mutable map in `registry.ts` stays for test-fixture override compatibility | W7 (delete when registry.ts removed) |
| D-ph4-02 | `resolveAnthropicApiKey()` string shim stays as backward-compat until W7 | W7 (remove after all call-sites migrated) |
| D-ph4-03 | 12 provider-hardcoded model strings outside `packages/core/src/llm/` | Cleaned up in respective domain migration waves (W3-W6) |
| D-ph4-04 | `cleo-os` harness constructs its own Anthropic client for Claude Code adapter | W6 (cleo-os migration) |
| D-ph4-05 | Gemini and Ollama have no Phase 3 ProviderProfile yet | W8 (provider coverage wave) |

---

## Coverage targets

| Metric | Baseline (post-Phase 3) | Target (post-Phase 4 / W8) |
|--------|-------------------------|----------------------------|
| Call-sites using executor | 0 | 100% (zero legacy bypasses) |
| Providers with LlmTransport | 0 | 5 (Anthropic, Bedrock, OpenAI-compat, Gemini, Ollama) |
| Unit test coverage — `packages/core/src/llm/` | ~40% | ≥80% |
| Integration test coverage — executor E2E | 0 | ≥3 per role (mock transport) |
| grep `new Anthropic({` outside `transports/` | ~14 | 0 |
| grep `'claude-haiku-4-5-20251001'` outside `llm/` | 12 | 0 |

---

## Consequences

### Positive

- New providers require only one `LlmTransport` implementation — no touching call-sites.
- Multi-turn sessions have typed state; context overflow is detectable before it happens.
- The executor's `rotate()` method gives the sentient daemon automatic failover when
  a credential hits a 429 or is revoked.
- Phase 3 work (ProviderProfile, CredentialPool, role resolver) is fully preserved;
  Phase 4 wraps it, not replaces it.
- Each interface is independently mockable → testable in isolation.

### Negative

- The migration spans ~28 sub-tasks across 8 waves (see the Phase 4 section of
  `docs/plans/T-LLM-CRED-CENTRALIZATION.md`).
- The three-interface surface is larger than a simple shim — juniors may reach for
  the wrong interface. Mitigated by linting rule: `no-direct-anthropic-construct`.
- `LlmSession.compress()` introduces a recursive LLM call (summarizer calling LLM
  to compress LLM history). The compression role must be budget-capped to prevent
  runaway token spend.

---

## Implementation notes for W0b/W0c

Contract types to add to `packages/contracts/src/llm/`:

```
packages/contracts/src/llm/
  transport.ts          — LlmTransport, TransportRequestPayload, TransportChunk, NormalizedResponse, PingResult
  session.ts            — LlmSession, SessionChunk, SessionSendOptions, CompressionOptions
  executor.ts           — LlmExecutor, ExecutorOptions, ExecutorChunk, SessionOptions
  normalized-message.ts — NormalizedMessage (shared across all three)
  index.ts              — re-exports all of the above
```

All of the above are pure interface + type files. Zero implementation. The
implementation lives in `packages/core/src/llm/` (W1-W3).

Re-export through `packages/contracts/src/index.ts`.

---

## References

- Hermes Agent architecture: `docs/specs/hermes-agent-llm-provider-architecture.md`
- Phase 4 plan: `docs/plans/T-LLM-CRED-CENTRALIZATION.md` § "Phase 4"
- Hermes `ProviderProfile`: `/mnt/projects/hermes-agent/providers/base.py`
- Hermes `CredentialPool`: `/mnt/projects/hermes-agent/agent/credential_pool.py:92-1095`
- Hermes `NormalizedResponse`: `/mnt/projects/hermes-agent/agent/transports/types.py:1-163`
- Hermes provider registry: `/mnt/projects/hermes-agent/providers/__init__.py:43-192`
- ADR-071 (Observability Event Bus) — agent events emitted by LlmExecutor spans
- ADR-051 (Evidence-Based Completion) — all migration tasks require commit evidence
