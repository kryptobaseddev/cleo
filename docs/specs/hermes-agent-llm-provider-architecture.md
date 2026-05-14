# Hermes Agent — LLM Provider Architecture Reference

**Status**: Reference document (Phase 4 inspiration source)
**Last updated**: 2026-05-14
**Related**: ADR-072, `docs/plans/T-LLM-CRED-CENTRALIZATION.md` § Phase 4
**Source repo**: `/mnt/projects/hermes-agent/`

---

## Overview

Hermes Agent is a Python-based multi-provider LLM agent framework. Its LLM
provider stack solves the same core problems that CLEO Phase 4 targets:

- Unified credential management across multiple providers and auth types
- Provider-agnostic transport with per-provider quirk encapsulation
- Multi-credential pool with failover, rotation, and cooldown semantics
- Plugin-based provider registry (user-extensible without forking)

This document maps Hermes's architecture to CLEO's Phase 4 design, identifies
where CLEO is porting directly vs. adapting, and documents key behavioral
decisions from Hermes that inform the ADR-072 implementation.

---

## Hermes architecture layers

```
┌─────────────────────────────────────────────────────────────┐
│                        AIAgent (agent/run_agent.py)         │
│  Orchestrates tool calls, context, multi-turn conversation  │
├─────────────────────────────────────────────────────────────┤
│                    AuxiliaryClient (auxiliary_client.py)    │
│  Routes side-task LLM calls (compression, vision, etc.)     │
├─────────────────────────────────────────────────────────────┤
│              CredentialPool (agent/credential_pool.py)      │
│  Multi-credential failover, rotation, 401/429 cooldowns     │
├─────────────────────────────────────────────────────────────┤
│            Provider Adapters (agent/*_adapter.py)           │
│  anthropic_adapter, bedrock_adapter, gemini_native_adapter, │
│  codex_responses_adapter, copilot_acp_client, etc.          │
├─────────────────────────────────────────────────────────────┤
│               ProviderProfile (providers/base.py)           │
│  Declarative: auth, endpoints, model catalog, quirks        │
├─────────────────────────────────────────────────────────────┤
│            Provider Registry (providers/__init__.py)        │
│  Lazy discovery: bundled plugins + $HERMES_HOME user plugins │
└─────────────────────────────────────────────────────────────┘
```

### Mapping to CLEO Phase 4

| Hermes component | CLEO Phase 4 equivalent | Notes |
|-----------------|------------------------|-------|
| `ProviderProfile` (`providers/base.py`) | `ProviderProfile` (Phase 3, already ported) | Direct port — same fields |
| Provider registry (`providers/__init__.py`) | `ProviderRegistry` (Phase 3) | Direct port |
| `PooledCredential` (`credential_pool.py`) | Phase 3 `CredentialPool` | Conceptually ported |
| `CredentialPool.pick_credential()` | `credentialPool.pickCredentialForProvider()` | Phase 3 |
| Provider adapters (`*_adapter.py`) | `LlmTransport` implementations (Phase 4 W1) | Rewritten as TypeScript interfaces |
| `AuxiliaryClient` | `LlmExecutor.execute('compression', ...)` | Mapped to a role, not a separate class |
| `AIAgent` context/turn tracking | `LlmSession` (Phase 4 W2) | Adapted — Hermes uses dicts, CLEO uses typed interfaces |
| `NormalizedResponse` (`agent/transports/types.py`) | `NormalizedResponse` (Phase 4 W0b contract) | Direct port of shape |

---

## ProviderProfile — key fields and CLEO adaptation

**Hermes source**: `/mnt/projects/hermes-agent/providers/base.py`

Hermes `ProviderProfile` is a Python dataclass. CLEO Phase 3 already ported this as a
TypeScript interface in `packages/core/src/llm/provider-registry.ts`. The key fields
that inform Phase 4 transport implementations:

| Field | Type | Purpose | CLEO Phase 4 usage |
|-------|------|---------|-------------------|
| `name` | `str` | Canonical provider ID | Transport registry key |
| `auth_type` | `str` | `api_key\|oauth_device_code\|oauth_external\|copilot\|aws_sdk` | Maps to `AuthType` in `ResolvedCredential` |
| `base_url` | `str` | Default API endpoint | `AnthropicTransport`, `OpenAICompatTransport` base |
| `default_headers` | `dict` | Per-provider static headers | Merged into transport request headers |
| `fixed_temperature` | `Any` | `None` = use caller's, `OMIT_TEMPERATURE` = don't send | `TransportRequestPayload.temperature` handling |
| `fallback_models` | `tuple` | Models shown when live /models fetch fails | `ProviderProfile.fallbackModels` |
| `supports_health_check` | `bool` | Whether to probe /models in doctor | `LlmTransport.ping()` behavior |

**CLEO adaptation notes**:
- `auth_type` in Hermes has 5 values (`api_key`, `oauth_device_code`, `oauth_external`, `copilot`, `aws_sdk`).
  CLEO ADR-072 collapses to 3 (`api_key`, `oauth`, `aws_sdk`) to keep the `AuthType` enum stable.
  OAuth subtypes are tracked in `CredentialPool` metadata, not in the credential type.
- `OMIT_TEMPERATURE` sentinel → CLEO uses `temperature?: number` in `TransportRequestPayload`;
  `undefined` = omit from payload. No special sentinel needed in TypeScript.

---

## CredentialPool — rotation and cooldown semantics

**Hermes source**: `/mnt/projects/hermes-agent/agent/credential_pool.py:92-1095`

The credential pool is the most complex component in the Hermes stack. Key behavioral decisions
that CLEO Phase 4 inherits:

### Selection strategies

| Strategy | Hermes constant | Behavior |
|----------|----------------|----------|
| `fill_first` | `STRATEGY_FILL_FIRST` | Always try highest-priority available credential first |
| `round_robin` | `STRATEGY_ROUND_ROBIN` | Cycle through credentials in priority order |
| `least_used` | `STRATEGY_LEAST_USED` | Prefer credential with lowest `request_count` |
| `random` | `STRATEGY_RANDOM` | Pick randomly from available credentials |

CLEO Phase 3 maps these to `RotationStrategy` enum. The default strategy for most roles is
`fill_first` (highest-priority credential gets all traffic unless it fails).

### Cooldown semantics

Hermes cooldown constants (CLEO Phase 3 should mirror these exactly):

```python
EXHAUSTED_TTL_401_SECONDS = 5 * 60      # 5 minutes  — transient auth failure
EXHAUSTED_TTL_429_SECONDS = 60 * 60     # 1 hour     — rate limited
EXHAUSTED_TTL_DEFAULT_SECONDS = 60 * 60 # 1 hour     — billing/quota/unknown
```

Provider-supplied `reset_at` timestamps (from Retry-After headers) override these defaults.

The `shouldRotateCredential(err)` method on each `LlmTransport` implementation signals
the executor to pull a fresh credential from the pool. CLEO uses `shouldRotateCredential`
(full name) — the bare-word shorthand `shouldRotate` is not used (typo-prone with
other `should*` methods).

### PooledCredential fields

The `PooledCredential` dataclass tracks:

```python
@dataclass
class PooledCredential:
    provider: str
    id: str
    label: str
    auth_type: str          # 'api_key' | 'oauth'
    priority: int           # lower = higher priority
    source: str             # 'manual' | 'env' | etc.
    access_token: str
    refresh_token: Optional[str]
    last_status: Optional[str]          # 'ok' | 'exhausted'
    last_status_at: Optional[float]
    last_error_code: Optional[int]      # HTTP status code
    last_error_reason: Optional[str]
    last_error_message: Optional[str]
    last_error_reset_at: Optional[float] # when to retry after cooldown
    base_url: Optional[str]
    expires_at: Optional[str]
    expires_at_ms: Optional[int]
    request_count: int
```

CLEO Phase 3 `CredentialPool` maps `PooledCredential` fields to `StoredCredential`
in `packages/core/src/llm/credential-pool.ts`. Phase 4 W1 transport implementations
read `last_error_reset_at` to avoid hot-looping on a cooled-down credential.

---

## NormalizedResponse — transport output shape

**Hermes source**: `/mnt/projects/hermes-agent/agent/transports/types.py:1-163`

Every Hermes provider adapter normalizes its output to `NormalizedResponse`. CLEO Phase 4
W0b contracts adopt the same shape as a TypeScript interface:

```typescript
// Derived from Hermes agent/transports/types.py
export interface NormalizedResponse {
  /** Full text content of the assistant response (all text blocks concatenated). */
  content: string;

  /** Structured tool calls requested by the model. */
  toolCalls: ToolCall[];

  /** Why the model stopped generating. */
  finishReason: 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error';

  /** Token usage for this response. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };

  /** Provider-specific metadata (protocol-aware code only). */
  providerData?: Record<string, unknown>;
}

export interface ToolCall {
  /** Protocol canonical ID (tool_call_id / tool_use_id). */
  id: string | null;

  /** Tool name. */
  name: string;

  /** JSON string of arguments. */
  arguments: string;

  /** Protocol-specific metadata (e.g. Codex call_id, Gemini thought_signature). */
  providerData?: Record<string, unknown>;
}
```

**CLEO adaptation notes**:
- Hermes `ToolCall` has a `.function` property shim for backward-compat with OpenAI's
  `tc.function.name` / `tc.function.arguments` access pattern. CLEO does not need this shim
  since there are no existing call-sites reading `.function.*` — use flat fields directly.
- Hermes `NormalizedResponse` includes `provider_data` dicts at both response and per-tool-call
  level. CLEO mirrors this as optional `providerData?: Record<string, unknown>` — callers
  that need protocol-specific data cast explicitly.
- `cacheReadTokens` / `cacheWriteTokens` are Anthropic prompt-caching fields. Other providers
  leave these undefined.

---

## Provider adapter architecture

**Hermes source**: `agent/anthropic_adapter.py`, `agent/bedrock_adapter.py`, `agent/gemini_native_adapter.py`

Each Hermes provider adapter handles:
1. Credential header injection (auth type → HTTP headers).
2. Request payload translation (NormalizedMessage → provider-specific format).
3. Streaming chunk parsing → `NormalizedResponse` increments.
4. Error classification → should retry / should rotate / terminal.
5. `ping()` / health check.

CLEO Phase 4 `LlmTransport` implementations (W1) map these responsibilities to the
`request()`, `call()`, `supportsCredential()`, and `ping()` interface methods.

### Auth header patterns (from Hermes)

```python
# anthropic_adapter.py auth header logic (simplified)
if cred.auth_type == 'oauth':
    headers['Authorization'] = f'Bearer {cred.access_token}'
    headers['anthropic-beta'] = 'oauth-2025-04-20'
    # Do NOT set x-api-key
else:
    headers['x-api-key'] = cred.access_token

# openai-compat (any provider using Bearer auth)
headers['Authorization'] = f'Bearer {cred.access_token}'
```

The TypeScript `AnthropicTransport` in W1 replicates this exactly. The Phase 1 bug
(`resolveCredentials('anthropic')` returning OAuth token sent as `x-api-key`) is
fixed at the transport layer — transports own auth header construction, not callers.

### Error classification pattern

```python
# Simplified from credential_pool.py
def should_rotate(status_code: int) -> bool:
    return status_code in (401, 403, 429, 402)

def cooldown_seconds(status_code: int) -> int:
    if status_code == 401:
        return EXHAUSTED_TTL_401_SECONDS   # 5 min
    return EXHAUSTED_TTL_429_SECONDS       # 1 hour
```

CLEO `LlmTransport.shouldRotateCredential(err)` mirrors this. The executor calls
`credentialPool.markExhausted(provider, label, { errorCode, resetAt })` when a transport
returns a rotate signal.

---

## AuxiliaryClient — side-task routing

**Hermes source**: `/mnt/projects/hermes-agent/agent/auxiliary_client.py`

Hermes uses `AuxiliaryClient` to route "side-task" LLM calls (context compression,
vision interpretation, schema extraction) to a cheap model independently of the main
conversation model.

CLEO maps this concept to LLM roles (`compression`, `extraction`, `hygiene`) rather
than a separate client class. `DefaultLlmExecutor.execute(role, messages)` picks a
cheap model for side-task roles via `resolveLLMForRole('compression')` — no separate
client object needed.

The `default_aux_model` field on `ProviderProfile` is the Hermes analog. CLEO reads
the role config (`llm.roles.compression.model`) to achieve the same effect.

---

## Plugin registry — extensibility model

**Hermes source**: `/mnt/projects/hermes-agent/providers/__init__.py:43-192`

Hermes supports user-installable provider plugins at `$HERMES_HOME/plugins/model-providers/<name>/`.
Each plugin calls `register_provider(profile)` at import time. User plugins override
bundled profiles (last-writer-wins).

CLEO Phase 3 ports this as `ProviderRegistry.registerProvider(profile)`. Phase 4 adds the
user plugin directory scan: `~/.cleo/plugins/model-providers/<name>/` (using existing
`getCleoHome()` path resolution).

The plugin scan is lazy — first call to `getProviderProfile(name)` triggers discovery.
This mirrors Hermes's `_discovered` flag pattern.

---

## Model metadata — context length resolution

**Hermes source**: `/mnt/projects/hermes-agent/agent/model_metadata.py:1407-1438`

Hermes resolves model context length via a priority chain:
1. Live API probe (ask provider for model capabilities).
2. Curated internal table (updated manually).
3. Static default (256K tokens for unknown models).

CLEO Phase 4 `LlmSession.contextBudget` uses this chain via a `getModelContextLength(model, transport)` helper (to be added in W2). The 256K static fallback ensures `remainingBudget()` never returns a negative value for unknown models.

---

## CLEO current state vs. Hermes (as of Wave 0a)

| Capability | Hermes | CLEO post-Phase 3 | CLEO post-Phase 4 target |
|-----------|--------|-------------------|--------------------------|
| ProviderProfile | Full dataclass | Ported (TypeScript interface) | Unchanged |
| Provider registry | Lazy + user plugins | Lazy, no user plugins yet | User plugins in W8 |
| Multi-credential pool | Full (4 strategies, cooldowns) | Partially ported | Fully wired via executor in W2 |
| Transport abstraction | Per-provider adapter classes | None (raw clients) | `LlmTransport` in W1 |
| NormalizedResponse | Full shape | None | `NormalizedResponse` interface in W0b |
| Session / turn tracking | Dict-based in AIAgent | None | `LlmSession` in W2 |
| Executor / role routing | AuxiliaryClient + AIAgent | `resolveLLMForRole` (no executor) | `LlmExecutor` in W2 |
| OAuth auth header selection | Per-adapter | Phase 1 fix in call-sites | Centralized in W1 transports |
| Gemini transport | `gemini_native_adapter.py` | None | W8 |
| Ollama transport | None | None | W8 |
| Device-code OAuth | `hermes_cli/auth_commands.py` | None | Post-Phase 4 (separate epic) |
| Model context length resolution | 3-tier chain | None | W2 `getModelContextLength` helper |

---

## Files to read when implementing Phase 4 waves

| Wave | Hermes reference file | What to learn |
|------|----------------------|---------------|
| W0b (contracts) | `agent/transports/types.py:1-163` | `NormalizedResponse` and `ToolCall` field names |
| W1 (transports) | `providers/base.py` | `ProviderProfile` fields used in auth |
| W1 (transports) | `agent/anthropic_adapter.py` | OAuth vs API key header selection |
| W1 (transports) | `agent/bedrock_adapter.py` | AWS SDK adapter pattern |
| W2 (executor) | `agent/credential_pool.py:92-400` | `pick_credential`, strategy implementations |
| W2 (executor) | `agent/model_metadata.py:1407-1438` | Context length resolution chain |
| W8 (Gemini) | `agent/gemini_native_adapter.py` | Gemini-specific streaming quirks |
| W8 (plugins) | `providers/__init__.py:43-192` | User plugin discovery pattern |
