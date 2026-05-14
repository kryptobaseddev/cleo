# Hermes Port Targets — T9261 Phase 3

**Generated**: 2026-05-13  
**Scope**: 6 sub-tasks. MVP slices only — deferred items require separate tickets.

---

## T-llm-p3-1: ProviderProfile interface + plugin loader

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `providers/base.py:24-167` | `ProviderProfile` dataclass: `name`, `api_mode`, `aliases`, `display_name`, `description`, `signup_url`, `env_vars`, `base_url`, `models_url`, `auth_type`, `supports_health_check`, `fallback_models`, `hostname`, `default_headers`, `fetch_models()` |
| `providers/__init__.py:43-191` | `_REGISTRY`, `register_provider()`, `get_provider_profile()`, `list_providers()`, `_discover_providers()` lazy-init, user plugin dir `$HERMES_HOME/plugins/model-providers/<name>/`, bundled plugin dir, last-writer-wins on `register_provider()` |

### TS landing
```
packages/contracts/src/llm/provider-profile.ts   (new — interface only)
packages/core/src/llm/provider-registry/index.ts (new — registry + lookups)
packages/core/src/llm/provider-registry/loader.ts (new — plugin discovery)
packages/core/src/llm/provider-registry/builtin/anthropic.ts (new — built-in profile)
```

### MVP slice
- `ProviderProfile` as a TS interface (not a class): `name`, `displayName`, `authTypes`, `baseUrl`, `defaultModel`, `aliases`, `defaultHeaders`, `fetchModels?(apiKey, signal): Promise<string[] | null>`
- Built-in: anthropic profile only (authTypes: `['api_key', 'oauth']`, baseUrl: `https://api.anthropic.com`, defaultModel: `claude-haiku-4-5-20251001`)
- Discovery via `await import('file://' + absPath)` — no sandboxing. Plugin must export `register(registry)`. Files scanned: `~/.cleo/plugins/model-providers/*.{ts,mjs,js}` (flat files, not sub-dirs — simpler than Hermes's dir-per-plugin layout)
- `registerProvider(p)`, `getProviderProfile(name)`, `listProviders()` — synchronous, module-global map. Discovery is lazy (first call to `getProviderProfile` or `listProviders` triggers one-shot `await discoverPlugins()`)
- `cleo llm list-providers` CLI hook calls `listProviders()` and prints LAFS JSON

### Deferred
- Non-anthropic built-in profiles (openai, gemini, moonshot — those providers already work via env/cred-file; Phase 3 profiles add richer metadata)
- Per-plugin sub-directory layout (Hermes `plugins/model-providers/<name>/` convention)
- Plugin sandboxing / integrity checks
- `build_extra_body`, `build_api_kwargs_extras`, `prepare_messages` hooks

### Estimated MVP LOC
~180 (contracts: 50, registry/index: 60, registry/loader: 40, builtin/anthropic: 30)

---

## T-llm-p3-2: CredentialPool with rotation + cooldown

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `agent/credential_pool.py:49-88` | Status/strategy constants: `STATUS_OK`, `STATUS_EXHAUSTED`, `STRATEGY_FILL_FIRST`, `STRATEGY_ROUND_ROBIN`, `STRATEGY_LEAST_USED`, cooldown TTLs (`EXHAUSTED_TTL_401_SECONDS=300`, `EXHAUSTED_TTL_429_SECONDS=3600`) |
| `agent/credential_pool.py:92-161` | `PooledCredential` dataclass: `last_status`, `last_error_code`, `last_error_reset_at`, `request_count` fields we add to `StoredCredential` |
| `agent/credential_pool.py:270-278` | `_exhausted_until()` cooldown expiry calculation |
| `agent/credential_pool.py:383-440` | `CredentialPool.__init__`, `_available_entries()`, `_mark_exhausted()`, strategy dispatch |

### TS landing
```
packages/core/src/llm/credential-pool.ts   (new — pool class + pick logic)
packages/core/src/llm/credentials-store.ts (edit — add 4 fields to StoredCredential)
```

### New fields on `StoredCredential` (stored in `llm-credentials.json`)
```ts
lastStatus?: 'ok' | 'exhausted';
lastErrorCode?: number;        // 401 | 429 | etc.
lastErrorResetAt?: number;     // epoch ms (provider-supplied or computed)
requestCount?: number;
```

### New pool class API
```ts
class CredentialPool {
  constructor(provider: ModelTransport, strategy?: PoolStrategy)
  async pick(): Promise<StoredCredential | null>
  async markExhausted(label: string, errorCode: number, resetAt?: number): Promise<void>
  async markOk(label: string): Promise<void>
}
type PoolStrategy = 'fill_first' | 'round_robin' | 'least_used';
```

`pick()` filters to `!disabled && !expired && !inCooldown`, then applies strategy. In-process round-robin cursor (same as Phase 2 `_rrIndex` pattern). Mutations write back via `addCredential` upsert (re-uses existing `withLock` path — do NOT open a new lock).

### Deferred
- `STRATEGY_RANDOM` (Hermes supports it; CLEO skips — not useful for typical 2–5 key setups)
- Soft concurrency leases (Hermes `_active_leases` dict + semaphore — skip, adds complexity for single-process orchestrator)
- Credential auto-refresh on token expiry (Phase 3 deferred; login flow in T-llm-p3-3 handles initial grant)
- Sync back to auth.json sidecars (Hermes `_sync_anthropic_entry_from_credentials_file` — not needed, we own the store)

### Estimated MVP LOC
~160 (credential-pool.ts: 130, credentials-store.ts edit: 30)

---

## T-llm-p3-3: Device-code OAuth — `cleo llm login <provider>`

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `hermes_cli/auth_commands.py:161-245` | anthropic OAuth branch: call into `anthropic_adapter.run_hermes_oauth_login_pure()`, persist `PooledCredential` with `auth_type=oauth`, `refresh_token`, `expires_at_ms` |
| `hermes_cli/auth_commands.py:35-36` | `_OAUTH_CAPABLE_PROVIDERS` list (anthropic only for MVP) |

Note: Hermes anthropic OAuth lives in `agent/anthropic_adapter.py` (PKCE device-code flow). We mirror the Claude Code device-code pattern — device_code, verification_uri, polling on `oauth_token` endpoint — not PKCE. Anthropic's Claude.ai OAuth app publishes `client_id`, scope, and device-code endpoint; we use those documented values.

### TS landing
```
packages/cleo/src/cli/commands/llm-login.ts          (new — CLI handler)
packages/core/src/llm/oauth/device-code.ts           (new — generic device-code poller)
packages/core/src/llm/oauth/anthropic-device-code.ts (new — anthropic-specific constants + flow)
```

### MVP flow (anthropic only)
1. POST `/oauth/device_code` with `client_id` + `scope` → `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`
2. Print `user_code` + `verification_uri` to stdout
3. Poll `POST /oauth/token` with `device_code` grant every `interval` seconds until `access_token` returned or `expires_in` elapsed (5 min cap)
4. On success: call `addCredential({ provider: 'anthropic', authType: 'oauth', label, accessToken, expiresAt })` — note: Phase 2 `StoredCredential` does NOT have `refreshToken` (security review S-07 deferred it). Phase 3 ADDS `refreshToken` back alongside the refresh implementation.
5. Emit LAFS envelope `{ success: true, data: { label, provider, expiresAt } }`

### Deferred
- OpenAI, xAI, Qwen, Nous OAuth flows (stubs return `{ success: false, error: { code: 'E_NOT_IMPLEMENTED' } }`)
- Token refresh on expiry (blocked on Phase 3 refresh-token field addition)
- Browser open (open the verification URI in user's browser if `--browser` flag set)

### Estimated MVP LOC
~200 (llm-login.ts: 70, device-code.ts: 80, anthropic-device-code.ts: 50)

---

## T-llm-p3-4: NormalizedResponse transports

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `agent/transports/types.py:18-38` | `ToolCall` dataclass: `id`, `name`, `arguments` (JSON string), `provider_data` |
| `agent/transports/types.py:79-111` | `NormalizedResponse` dataclass: `content`, `tool_calls`, `finish_reason`, `reasoning`, `usage`, `provider_data` |
| `agent/transports/types.py:81-88` | `Usage` dataclass: `prompt_tokens`, `completion_tokens`, `cached_tokens` |

### TS landing
```
packages/contracts/src/llm/normalized-response.ts               (new — types only)
packages/core/src/llm/transports/anthropic.ts                   (new — real impl)
packages/core/src/llm/transports/openai.ts                      (new — stub)
packages/core/src/llm/transports/gemini.ts                      (new — stub)
```

### NormalizedResponse shape (TS)
```ts
export interface NormalizedToolCall {
  id: string | null;
  name: string;
  arguments: string;        // JSON string (same as Hermes)
  providerData?: Record<string, unknown>;
}
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}
export interface NormalizedResponse {
  id: string;
  model: string;
  content: string | null;
  toolCalls: NormalizedToolCall[] | null;
  stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'content_filter' | string;
  usage: NormalizedUsage;
  reasoning?: string | null;
  providerData?: Record<string, unknown>;
  raw: unknown;             // raw SDK response for provider-aware code
}
```

Note: field naming is camelCase to fit TS conventions; semantically identical to Hermes.

### Transport interface
```ts
export interface LlmTransport {
  complete(req: TransportRequest): Promise<NormalizedResponse>;
}
export interface TransportRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  tools?: unknown[];
  temperature?: number;
}
```

AnthropicTransport wraps `@anthropic-ai/sdk` Messages.create. openai/gemini stubs throw `E_NOT_IMPLEMENTED`.

### Deferred
- Streaming support
- Tool-use multi-turn loops (belongs in auxiliary-router, T-llm-p3-6)
- Gemini/OpenAI real implementations

### Estimated MVP LOC
~170 (normalized-response.ts: 50, anthropic.ts: 90, stubs: 30)

---

## T-llm-p3-5: Model metadata (getModelContextLength)

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `agent/model_metadata.py:1407-1438` | Resolution chain: config override (0) → cache (1) → live API (4) → hardcoded (7) → 256K (9). MVP ports tiers 0 (skip — no config override in CLEO yet), curated table (equivalent to tier 7), and 256K default (tier 9). Live-API hook is a TODO stub. |

### TS landing
```
packages/core/src/llm/model-metadata.ts    (new — function + resolution logic)
packages/core/src/llm/curated-models.json  (new — static context-length table)
```

### Curated models table (seed entries)
```json
{
  "claude-haiku-4-5-20251001": 200000,
  "claude-haiku-4-5": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-opus-4-7": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-haiku-20240307": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-3.5-turbo": 16385,
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000
}
```

### Function signature
```ts
export async function getModelContextLength(
  model: string,
  baseUrl?: string,
  apiKey?: string
): Promise<number>
```

Resolution: curated lookup (exact + prefix strip after first `-` for version aliases) → 256000 default. Live-API hook (tier 4 in Hermes) reserved as a `// TODO: T-llm-p3-5-live` comment.

### Deferred
- Live Anthropic `/v1/models` API probe (requires credential plumbing)
- OpenRouter context-length cache (Hermes tier 6)
- Persistent cache (Hermes tier 1)
- AWS Bedrock static table (Hermes tier 1b)

### Estimated MVP LOC
~80 (model-metadata.ts: 60, curated-models.json: 20 lines)

---

## T-llm-p3-6: Auxiliary fallback router

### Hermes refs
| Ref | What we take |
|-----|--------------|
| `agent/auxiliary_client.py` | Fallback-chain pattern: resolve credential from pool → build client → call → on 401/429, mark pool entry exhausted, retry next entry; max retries; surface final error. We port the pattern (≈ 80 LOC of logic), NOT the full 4750-LOC auxiliary client. |

### TS landing
```
packages/core/src/llm/auxiliary-router.ts  (new)
```

### API
```ts
export async function routeAuxiliaryCall(
  role: RoleName,
  request: TransportRequest,
  opts?: { maxRetries?: number }
): Promise<NormalizedResponse>
```

Algorithm:
1. `resolveLLMForRole(role)` → `{ provider, model }`
2. `new CredentialPool(provider).pick()` → `entry`
3. Build `AnthropicTransport` (or provider-appropriate stub) with entry
4. `transport.complete(request)`
5. On `401`/`429`: `pool.markExhausted(entry.label, statusCode)`, retry from step 2 (skip exhausted entries). Max 3 retries.
6. All entries exhausted → throw `E_LLM_POOL_EXHAUSTED` LAFS error envelope

### Deferred
- Streaming pass-through
- Non-Anthropic providers (blocked until openai/gemini transports have real impls)
- Concurrency semaphore (Hermes `_active_leases`)
- Retry-after header parsing (Hermes `_parse_absolute_timestamp`)

### Estimated MVP LOC
~120

---

## Summary table

| Sub-task | Hermes refs | TS packages | MVP LOC |
|----------|-------------|-------------|---------|
| T-llm-p3-1 | `providers/base.py:24-167`, `providers/__init__.py:43-191` | contracts, core | ~180 |
| T-llm-p3-2 | `credential_pool.py:49-161,270-440` | core | ~160 |
| T-llm-p3-3 | `auth_commands.py:161-245` | cleo, core | ~200 |
| T-llm-p3-4 | `transports/types.py:1-163` | contracts, core | ~170 |
| T-llm-p3-5 | `model_metadata.py:1407-1438` | core | ~80 |
| T-llm-p3-6 | `auxiliary_client.py` (pattern only) | core | ~120 |
| **Total** | | | **~910** |
